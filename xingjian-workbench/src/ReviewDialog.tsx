import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  History,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  Artifact,
  Claim,
  Command,
  Evidence,
  Project,
  ReviewPreview,
  Task,
  Workspace,
} from "../shared/contracts";
import {
  ApiError,
  getWorkspace,
  makeCommand,
  previewReview,
  submitCommand,
} from "./api";

export type ReviewTarget = {
  kind: "claim" | "task" | "artifact";
  entityId: string;
};
type Snapshot = {
  text?: string;
  evidence?: Evidence[];
  title?: string;
  content?: string;
  claimIds?: string[];
};
type Revision = Snapshot & {
  number: number;
  recordedAt: string;
  reason: string;
  claimVersions?: { claimId: string; version: number }[] | null;
};
type Entity = (Claim | Task | Artifact) & { revisions?: Revision[] };
const kindLabel = { claim: "结论", task: "行动", artifact: "草稿" };

function getEntity(project: Project, target: ReviewTarget): Entity {
  return (
    target.kind === "claim"
      ? project.claims
      : target.kind === "task"
        ? project.tasks
        : project.artifacts
  ).find((item) => item.id === target.entityId)!;
}
const needsReview = (entity: Entity) =>
  "reviewRequired" in entity
    ? entity.reviewRequired
    : entity.status === "needs_review";
const datetime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export default function ReviewDialog({
  project,
  workspace,
  target,
  onClose,
  onWorkspace,
  onSwitch,
  onEvidence,
  onComplete,
}: {
  project: Project;
  workspace: Workspace;
  target: ReviewTarget;
  onClose: () => void;
  onWorkspace: (state: Workspace) => void;
  onSwitch: (target: ReviewTarget) => void;
  onEvidence: (sourceId: string, versionId: string) => void;
  onComplete: (message: string) => void;
}) {
  const entity = getEntity(project, target);
  const reviewable = needsReview(entity);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [draft, setDraft] = useState<Snapshot>({});
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(reviewable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mustRefresh, setMustRefresh] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Command | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const initialReviewable = useRef(reviewable);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      dialog.current?.close();
      returnFocus.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (!initialReviewable.current) return;
    let active = true;
    setLoading(true);
    setError("");
    setAcknowledged(false);
    previewReview(project.id, target.kind, target.entityId)
      .then((result) => {
        if (!active) return;
        setPreview(result);
        setMustRefresh(false);
        setDraft((previous) => {
          const base: Snapshot = hasDraft ? previous : result.baseline;
          if (!base.evidence) return base;
          const refs = new Map<string, Evidence>();
          for (const ref of base.evidence)
            refs.set(`${ref.sourceId}|${ref.locator}`, {
              ...ref,
              versionId: result.sourceComparisons.find(
                (source) => source.sourceId === ref.sourceId,
              )!.currentVersionId,
            });
          return { ...base, evidence: [...refs.values()] };
        });
        setHasDraft(true);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "无法读取复核依据。");
          setMustRefresh(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // Refresh deliberately preserves user edits; a new object mounts a fresh dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, project.id, target.kind, target.entityId]);

  function edit(values: Partial<Snapshot>) {
    setDraft((previous) => ({ ...previous, ...values }));
    setAcknowledged(false);
    pending.current = null;
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy || loading || mustRefresh || !acknowledged) return;
    setBusy(true);
    setError("");
    const payload = {
      projectId: project.id,
      entityId: target.entityId,
      baseVersion: preview.baseVersion,
      reviewToken: preview.reviewToken,
      reason,
      ...(target.kind === "claim"
        ? { text: draft.text, evidence: draft.evidence }
        : target.kind === "task"
          ? { title: draft.title }
          : { title: draft.title, content: draft.content }),
    };
    const type = `review_${target.kind}` as
      | "review_claim"
      | "review_task"
      | "review_artifact";
    const old = pending.current;
    const command =
      old &&
      old.type === type &&
      JSON.stringify(old.payload) === JSON.stringify(payload)
        ? old
        : makeCommand(type, payload, workspace.revision);
    pending.current = command;
    try {
      const response = await submitCommand(command);
      onWorkspace(response.state);
      pending.current = null;
      onComplete(
        `${kindLabel[target.kind]}已人工复核，旧内容与依据已保留。${target.kind === "claim" ? "关联行动和草稿仍需分别确认。" : target.kind === "task" ? "任务进度保持不变。" : "已保存新的草稿内容版本。"}`,
      );
      onClose();
    } catch (err) {
      let message = err instanceof Error ? err.message : "保存失败，请重试。";
      if (err instanceof ApiError && err.status === 409) {
        pending.current = null;
        setMustRefresh(true);
        setAcknowledged(false);
        try {
          onWorkspace(await getWorkspace());
          message += " 你的填写已保留，请重新对照最新依据后确认。";
        } catch {
          message += " 当前无法刷新。填写已保留，请恢复本地服务后重试。";
        }
      } else if (!(err instanceof ApiError))
        message =
          "连接中断，填写已保留。再次确认会复用本次操作，不会重复增加内容版本。";
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  const blocked = !!preview?.blockedBy.length;
  const disabled = busy || loading || mustRefresh || blocked || !reviewable;
  const baseline: Snapshot | undefined = preview?.baseline;

  return (
    <dialog
      ref={dialog}
      className="modal review-dialog"
      aria-labelledby="review-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void confirm(event)}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">逐项核对，保留来路</span>
            <h2 tabIndex={-1} id="review-title">
              {initialReviewable.current
                ? `复核${kindLabel[target.kind]}`
                : `${kindLabel[target.kind]}复核记录`}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭复核窗口"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        <div className="modal-body review-body">
          {loading && (
            <p className="review-loading" role="status">
              <LoaderCircle className="spin" size={18} />
              正在读取内容版本和当前依据…
            </p>
          )}
          {error && (
            <div className="review-message warning" role="alert">
              <TriangleAlert size={18} />
              <p>{error}</p>
            </div>
          )}
          {mustRefresh && (
            <button
              type="button"
              className="button secondary"
              disabled={loading || busy}
              onClick={() => {
                pending.current = null;
                setAttempt((value) => value + 1);
              }}
            >
              重新对照最新依据
            </button>
          )}
          {initialReviewable.current && !reviewable && (
            <p className="review-message">
              这项内容已在其他页面完成复核。可以关闭窗口查看新版本，当前填写不会再次覆盖它。
            </p>
          )}
          {preview && (
            <>
              <div className="review-intro">
                <span className="badge badge-amber">
                  内容 v{preview.baseVersion} · 待人工复核
                </span>
                <p>确认只处理当前这一项。资料、旧内容和复核说明会一起保留。</p>
              </div>
              {blocked && (
                <div className="review-blocked">
                  <h3>先处理这些结论</h3>
                  <p>关联结论尚未复核，暂时不能清除本项提醒。</p>
                  {preview.blockedBy.map((claim) => (
                    <button
                      type="button"
                      className="review-blocked-link"
                      key={claim.claimId}
                      onClick={() =>
                        onSwitch({ kind: "claim", entityId: claim.claimId })
                      }
                    >
                      <span>{claim.text}</span>
                      <span>
                        前往复核 <ArrowRight size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {preview.sourceComparisons.length > 0 && (
                <section
                  className="review-comparisons"
                  aria-label="资料新旧对照"
                >
                  <h3>资料新旧对照</h3>
                  {preview.sourceComparisons.map((source) => (
                    <details
                      key={`${source.sourceId}-${source.previousVersionId}`}
                      open={
                        source.previousVersionId !== source.currentVersionId
                      }
                    >
                      <summary>
                        {source.title}
                        <span>
                          {source.previousVersionId === source.currentVersionId
                            ? "版本未变化"
                            : "资料已有新版本"}
                        </span>
                      </summary>
                      <div className="review-compare-grid">
                        <div>
                          <h4>
                            原先使用的资料 · v
                            {
                              project.sources
                                .find((item) => item.id === source.sourceId)
                                ?.versions.find(
                                  (item) =>
                                    item.id === source.previousVersionId,
                                )?.number
                            }
                          </h4>
                          <pre
                            tabIndex={0}
                            aria-label={`原资料：${source.title}`}
                          >
                            {source.previousContent}
                          </pre>
                        </div>
                        <div>
                          <h4>
                            当前资料 · v
                            {project.sources
                              .find((item) => item.id === source.sourceId)
                              ?.versions.find(
                                (item) => item.id === source.currentVersionId,
                              )?.number ?? "最新"}
                          </h4>
                          <pre
                            tabIndex={0}
                            aria-label={`当前资料：${source.title}`}
                          >
                            {source.currentContent}
                          </pre>
                        </div>
                      </div>
                    </details>
                  ))}
                </section>
              )}
              {preview.claimComparisons.length > 0 && (
                <section
                  className="review-comparisons"
                  aria-label="关联结论对照"
                >
                  <h3>关联结论对照</h3>
                  {preview.claimComparisons.map((claim) => (
                    <div
                      key={claim.claimId}
                      className="review-compare-grid claim-compare"
                    >
                      <div>
                        <h4>
                          {claim.previousVersion === null
                            ? "原关联版本未记录"
                            : `原关联结论 · v${claim.previousVersion}`}
                        </h4>
                        <p>
                          {claim.previousText ??
                            "旧记录没有保存当时使用的结论版本，不能反推。请结合原内容核对。"}
                        </p>
                      </div>
                      <div>
                        <h4>当前结论 · v{claim.currentVersion}</h4>
                        <p>{claim.currentText}</p>
                      </div>
                    </div>
                  ))}
                </section>
              )}
              <section className="review-original">
                <h3>本项原内容 · v{preview.baseVersion}</h3>
                <p>{baseline?.text ?? baseline?.title}</p>
                {baseline?.content && (
                  <pre tabIndex={0}>{baseline.content}</pre>
                )}
              </section>
              <fieldset
                disabled={disabled}
                className="form-fields review-fields"
              >
                {target.kind === "claim" ? (
                  <>
                    <div className="field">
                      <label htmlFor="review-claim-text">复核后的结论</label>
                      <textarea
                        id="review-claim-text"
                        value={draft.text ?? ""}
                        required
                        maxLength={4000}
                        onChange={(event) => edit({ text: event.target.value })}
                      />
                      <small>
                        可修改结论，也可保留原文并说明仍适用的原因。资料不足时请如实写明，不把“已复核”当作正确性保证。
                      </small>
                    </div>
                    {draft.evidence?.map((ref, index) => (
                      <div className="field" key={`${ref.sourceId}-${index}`}>
                        <label htmlFor={`review-locator-${index}`}>
                          当前依据位置 ·{" "}
                          {
                            project.sources.find(
                              (source) => source.id === ref.sourceId,
                            )?.title
                          }
                        </label>
                        <input
                          id={`review-locator-${index}`}
                          required
                          maxLength={240}
                          value={ref.locator}
                          onChange={(event) =>
                            edit({
                              evidence: draft.evidence!.map((entry, i) =>
                                i === index
                                  ? { ...entry, locator: event.target.value }
                                  : entry,
                              ),
                            })
                          }
                        />
                        <small>
                          这次引用当前资料版本；请核对位置。原位置与旧资料版本会保留在历史中。
                        </small>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="field">
                      <label htmlFor="review-title-input">
                        {target.kind === "task"
                          ? "复核后的行动"
                          : "复核后的草稿标题"}
                      </label>
                      <input
                        id="review-title-input"
                        value={draft.title ?? ""}
                        required
                        maxLength={120}
                        onChange={(event) =>
                          edit({ title: event.target.value })
                        }
                      />
                    </div>
                    {target.kind === "artifact" && (
                      <div className="field">
                        <label htmlFor="review-content">复核后的草稿内容</label>
                        <textarea
                          id="review-content"
                          required
                          maxLength={100000}
                          value={draft.content ?? ""}
                          onChange={(event) =>
                            edit({ content: event.target.value })
                          }
                        />
                      </div>
                    )}
                    {target.kind === "task" && (
                      <p className="review-help">
                        本操作只复核行动内容和依据，保留当前完成进度。
                      </p>
                    )}
                  </>
                )}
                <div className="field">
                  <label htmlFor="review-reason">复核说明</label>
                  <textarea
                    id="review-reason"
                    required
                    maxLength={1000}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setAcknowledged(false);
                      pending.current = null;
                    }}
                    placeholder="例如：用电值已调整，研究方向仍成立，但需要补充使用时长后再比较。"
                  />
                  <small>
                    说明改了什么，或为什么原内容仍适用；这条记录会与新版本一起保存。
                  </small>
                </div>
                <label className="review-ack">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span>我已核对当前依据和填写内容</span>
                </label>
              </fieldset>
            </>
          )}
          {!!entity.revisions?.length && (
            <details className="review-history" open={!reviewable}>
              <summary>
                <History size={16} />
                保留的内容版本（{entity.revisions.length}）
              </summary>
              {[...entity.revisions].reverse().map((revision) => (
                <article key={revision.number}>
                  <h3>
                    内容 v{revision.number} ·{" "}
                    {revision.number === 1 ? "原始内容留存" : "人工复核"}
                  </h3>
                  <p className="review-history-date">
                    记录于 {datetime(revision.recordedAt)}
                  </p>
                  <p className="review-history-reason">{revision.reason}</p>
                  <p>{revision.text ?? revision.title}</p>
                  {revision.content && (
                    <pre tabIndex={0}>{revision.content}</pre>
                  )}
                  {revision.evidence?.map((ref, index) => (
                    <button
                      type="button"
                      className="evidence-link"
                      key={index}
                      onClick={() => onEvidence(ref.sourceId, ref.versionId)}
                    >
                      {
                        project.sources.find(
                          (source) => source.id === ref.sourceId,
                        )?.title
                      }{" "}
                      · 资料 v
                      {
                        project.sources
                          .find((source) => source.id === ref.sourceId)
                          ?.versions.find(
                            (version) => version.id === ref.versionId,
                          )?.number
                      }{" "}
                      · {ref.locator}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                  {revision.claimVersions?.map((ref) => {
                    const claim = project.claims.find(
                      (item) => item.id === ref.claimId,
                    );
                    const saved = claim?.revisions
                      ? claim.revisions.find(
                          (item) => item.number === ref.version,
                        )
                      : ref.version === 1
                        ? claim
                        : undefined;
                    return (
                      <section
                        className="review-history-claim"
                        key={ref.claimId}
                      >
                        <h4>所用结论 · v{ref.version}</h4>
                        <p>
                          {saved?.text ??
                            "无法读取这条历史结论，请检查本地数据记录。"}
                        </p>
                        {saved?.evidence.map((evidence, index) => (
                          <button
                            type="button"
                            className="evidence-link"
                            key={index}
                            onClick={() =>
                              onEvidence(evidence.sourceId, evidence.versionId)
                            }
                          >
                            {
                              project.sources.find(
                                (source) => source.id === evidence.sourceId,
                              )?.title
                            }{" "}
                            · 资料 v
                            {
                              project.sources
                                .find(
                                  (source) => source.id === evidence.sourceId,
                                )
                                ?.versions.find(
                                  (version) =>
                                    version.id === evidence.versionId,
                                )?.number
                            }{" "}
                            · {evidence.locator}
                            <ArrowRight size={14} />
                          </button>
                        ))}
                      </section>
                    );
                  })}
                  {revision.claimVersions === null && (
                    <p className="review-help">
                      历史关联结论版本未记录，保留未知。
                    </p>
                  )}
                </article>
              ))}
            </details>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            {initialReviewable.current ? "暂不处理" : "关闭"}
          </button>
          {initialReviewable.current && (
            <button
              type="submit"
              className="button primary"
              disabled={disabled || !preview || !acknowledged || !reason.trim()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              确认本项复核
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
