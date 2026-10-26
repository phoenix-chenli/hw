import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookmarkCheck,
  History,
  LoaderCircle,
  X,
} from "lucide-react";
import type {
  Command,
  Project,
  Task,
  TaskCheckpoint,
  Workspace,
} from "../shared/contracts";
import { ApiError, getWorkspace, makeCommand, submitCommand } from "./api";
import { useSessionDraft } from "./session-drafts";

type Fields = Pick<
  TaskCheckpoint,
  "doneNote" | "nextStep" | "blocker" | "evidence"
>;
type WorkDraft = {
  fields: Fields;
  base: number;
  taskVersion: number;
};
const boundedText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
function validWorkDraft(value: unknown): value is WorkDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as WorkDraft;
  const fields = draft.fields;
  return !!fields && typeof fields === "object" &&
    boundedText(fields.doneNote, 2000) &&
    boundedText(fields.nextStep, 1000) &&
    boundedText(fields.blocker, 1000) &&
    (fields.evidence === null ||
      (typeof fields.evidence === "object" &&
        boundedText(fields.evidence.sourceId, 200) &&
        boundedText(fields.evidence.versionId, 200))) &&
    Number.isSafeInteger(draft.base) && draft.base >= 0 &&
    Number.isSafeInteger(draft.taskVersion) && draft.taskVersion >= 1;
}
const latest = (task: Task) => task.checkpoints?.at(-1);
const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export default function TaskWorkDialog({
  project,
  workspace,
  taskId,
  onClose,
  onWorkspace,
  onNotice,
  onEvidence,
}: {
  project: Project;
  workspace: Workspace;
  taskId: string;
  onClose: () => void;
  onWorkspace: (state: Workspace) => void;
  onNotice: (message: string) => void;
  onEvidence: (sourceId: string, versionId: string) => void;
}) {
  const task = project.tasks.find((item) => item.id === taskId)!;
  const saved = latest(task);
  const taskVersion = task.revisions?.at(-1)?.number ?? 1;
  const workDraft = useSessionDraft<WorkDraft>(
    `checkpoint:${project.id}:${taskId}`,
    () => ({
      fields: {
        doneNote: saved?.doneNote ?? "",
        nextStep: saved?.nextStep ?? "",
        blocker: saved?.blocker ?? "",
        evidence: saved?.evidence ?? null,
      },
      base: saved?.number ?? 0,
      taskVersion,
    }),
    validWorkDraft,
  );
  const { fields } = workDraft.value;
  const [base, setBase] = useState(workDraft.value.base);
  const [checkedTaskVersion, setCheckedTaskVersion] = useState(workDraft.value.taskVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [restoring, setRestoring] = useState(workDraft.restored);
  const [checkedLatest, setCheckedLatest] = useState(!workDraft.restored);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Command | null>(null);
  const selectedSource = project.sources.find(
    (item) => item.id === fields.evidence?.sourceId,
  );
  const sourceChanged =
    selectedSource &&
    selectedSource.currentVersionId !== fields.evidence?.versionId;
  const contentChanged =
    !!saved && saved.taskVersion !== (task.revisions?.at(-1)?.number ?? 1);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      element?.close();
      trigger?.focus();
    };
  }, []);

  useEffect(() => {
    if (!workDraft.restored) return;
    let active = true;
    // Keep the original base until the latest checkpoint has actually been read.
    // A restored input is never permission to overwrite a newer checkpoint.
    getWorkspace().then((state) => {
      if (!active) return;
      const current = state.projects.find((item) => item.id === project.id)
        ?.tasks.find((item) => item.id === taskId);
      if (!current) throw new Error("任务已不可访问，请关闭窗口后刷新项目。");
      onWorkspace(state);
      const changed = base !== (latest(current)?.number ?? 0) ||
        workDraft.value.taskVersion !== (current.revisions?.at(-1)?.number ?? 1);
      setConflict(changed);
      setCheckedLatest(!changed);
    }).catch((err) => {
      if (!active) return;
      setConflict(true);
      setCheckedLatest(false);
      setError(err instanceof Error ? err.message : "暂时无法核对最新进度，请刷新后重试。");
    }).finally(() => {
      if (active) setRestoring(false);
    });
    return () => { active = false; };
    // Each project/task mounts a fresh dialog; edits must not restart this check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function edit(change: Partial<Fields>) {
    workDraft.setValue((previous) => ({
      ...previous,
      fields: { ...previous.fields, ...change },
    }));
    pending.current = null;
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const state = await getWorkspace();
      const current = state.projects
        .find((item) => item.id === project.id)
        ?.tasks.find((item) => item.id === taskId);
      if (!current) throw new Error("任务已不可访问，请关闭窗口后刷新项目。");
      onWorkspace(state);
      setBase(latest(current)?.number ?? 0);
      setCheckedTaskVersion(current.revisions?.at(-1)?.number ?? 1);
      // Require a separate acknowledgement after displaying the actual latest checkpoint.
      setCheckedLatest(true);
      setConflict(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "读取最新进度失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || restoring || conflict || project.archivedAt) return;
    const payload = {
      projectId: project.id,
      taskId,
      baseCheckpointNumber: base,
      ...fields,
    };
    const command =
      pending.current &&
      JSON.stringify(pending.current.payload) === JSON.stringify(payload)
        ? pending.current
        : makeCommand("save_checkpoint", payload, workspace.revision);
    pending.current = command;
    setBusy(true);
    setError("");
    try {
      const response = await submitCommand(command);
      onWorkspace(response.state);
      pending.current = null;
      workDraft.clear();
      onNotice("继续点已保存。下次打开可接着做，任务进度和复核提醒保持不变。");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        pending.current = null;
        setConflict(true);
        setCheckedLatest(false);
        let message = `${err.message} 你的填写已保留。`;
        try {
          const state = await getWorkspace();
          onWorkspace(state);
        } catch {
          message += " 暂时无法读取最新进度，请恢复连接后刷新。";
        }
        setError(message);
      } else
        setError(
          err instanceof ApiError
            ? err.message
            : "连接中断，填写已保留。重试保存会复用本次操作，避免重复留存。",
        );
    } finally {
      setBusy(false);
    }
  }
  const sourceLink = (evidence: TaskCheckpoint["evidence"]) => {
    if (!evidence) return null;
    const source = project.sources.find(
      (item) => item.id === evidence.sourceId,
    );
    const version = source?.versions.find(
      (item) => item.id === evidence.versionId,
    );
    return (
      <button
        type="button"
        className="evidence-link"
        onClick={() => onEvidence(evidence.sourceId, evidence.versionId)}
      >
        {source?.title} · 资料 v{version?.number}
        <ArrowRight size={14} />
      </button>
    );
  };

  return (
    <dialog
      ref={dialog}
      className="modal task-work-dialog"
      aria-labelledby="task-work-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void save(event)}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">留下一步，下次接着做</span>
            <h2 id="task-work-title" tabIndex={-1}>
              任务继续点
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭继续点"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          {project.archivedAt && <p className="work-warning" role="alert">项目已归档，临时填写仍保留。请关闭窗口，恢复原项目后再保存。</p>}
          {workDraft.restored && (
            <p className="work-warning" role="status">
              已恢复本窗口暂存的继续点填写，尚未保存。请核对任务和资料版本后再提交。
            </p>
          )}
          <div className="work-context">
            <h3>{task.title}</h3>
            <p>
              当前进度：
              {task.status === "done"
                ? "已完成"
                : task.status === "doing"
                  ? "进行中"
                  : "待开始"}
              。记录继续点不会改变完成状态。
            </p>
          </div>
          {(task.reviewRequired || contentChanged) && (
            <p className="work-warning">
              {task.reviewRequired
                ? "资料依据已变化，请先核对任务内容。"
                : "任务内容在上次记录之后有过修订。"}
              继续点会保留，不能代替逐项复核。
            </p>
          )}
          {error && (
            <p className="work-error" role="alert">
              {error}
            </p>
          )}
          {conflict && (
            <section className="work-conflict" aria-label="最新进度核对">
              <h3>对照最新进度，再保存你的填写</h3>
              <p>
                最新留存：
                {saved
                  ? `第 ${saved.number} 次 · ${saved.nextStep}`
                  : "暂无继续点"}
              </p>
              <div className="work-recovery">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  刷新最新进度
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !checkedLatest || base !== (saved?.number ?? 0) ||
                    checkedTaskVersion !== taskVersion}
                  onClick={() => {
                    pending.current = null;
                    workDraft.setValue((previous) => ({
                      ...previous,
                      base,
                      taskVersion: checkedTaskVersion,
                    }));
                    setConflict(false);
                    setError("");
                  }}
                >
                  已核对，保留我的填写
                </button>
              </div>
            </section>
          )}
          <fieldset className="form-fields" disabled={busy || !!project.archivedAt}>
            <div className="field">
              <label htmlFor="work-done">这次做到哪里</label>
              <textarea
                id="work-done"
                maxLength={2000}
                value={fields.doneNote}
                onChange={(event) => edit({ doneNote: event.target.value })}
                placeholder="例如：已整理两间教室的读数，还没有补齐使用时长。"
              />
            </div>
            <div className="field">
              <label htmlFor="work-next">下次第一步</label>
              <textarea
                id="work-next"
                required
                maxLength={1000}
                value={fields.nextStep}
                onChange={(event) => edit({ nextStep: event.target.value })}
                placeholder="写一个打开项目就能做的小动作。"
              />
              <small>
                把“继续研究”写具体，例如“向两位同学核对周二教室使用时长”。
              </small>
            </div>
            <div className="field">
              <label htmlFor="work-blocker">目前卡在哪里（可选）</label>
              <input
                id="work-blocker"
                maxLength={1000}
                value={fields.blocker}
                onChange={(event) => edit({ blocker: event.target.value })}
                placeholder="例如：等组员补一张原始记录表。"
              />
            </div>
            <div className="work-resource-grid">
              <div className="field">
                <label htmlFor="work-source">下次要看的资料（可选）</label>
                <select
                  id="work-source"
                  value={fields.evidence?.sourceId ?? ""}
                  onChange={(event) => {
                    const source = project.sources.find(
                      (item) => item.id === event.target.value,
                    );
                    edit({
                      evidence: source
                        ? {
                            sourceId: source.id,
                            versionId: source.currentVersionId,
                          }
                        : null,
                    });
                  }}
                >
                  <option value="">不关联资料</option>
                  {project.sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.title}
                    </option>
                  ))}
                </select>
              </div>
              {selectedSource && (
                <div className="field">
                  <label htmlFor="work-source-version">资料版本</label>
                  <select
                    id="work-source-version"
                    value={fields.evidence?.versionId ?? ""}
                    onChange={(event) =>
                      edit({
                        evidence: {
                          sourceId: selectedSource.id,
                          versionId: event.target.value,
                        },
                      })
                    }
                  >
                    {selectedSource.versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        第 {version.number} 版
                        {version.id === selectedSource.currentVersionId
                          ? "（当前）"
                          : "（历史）"}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {sourceChanged && (
              <p className="work-warning">
                目前选中的是历史资料版本。它会原样保留；如需当前版本，请主动切换。
              </p>
            )}
          </fieldset>
          {!!task.checkpoints?.length && (
            <details className="work-history">
              <summary>
                <History size={16} /> 之前留存的继续点（
                {task.checkpoints.length}）
              </summary>
              {[...task.checkpoints].reverse().map((entry) => (
                <article key={entry.number}>
                  <h3>
                    第 {entry.number} 次 · {formatTime(entry.recordedAt)}
                    （北京时间）
                  </h3>
                  {entry.doneNote && (
                    <p>
                      <strong>做到哪里：</strong>
                      {entry.doneNote}
                    </p>
                  )}
                  <p>
                    <strong>下次第一步：</strong>
                    {entry.nextStep}
                  </p>
                  {entry.blocker && (
                    <p>
                      <strong>待解决：</strong>
                      {entry.blocker}
                    </p>
                  )}
                  {sourceLink(entry.evidence)}
                  <p className="muted small">
                    留存时任务内容 v{entry.taskVersion}
                  </p>
                </article>
              ))}
            </details>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            暂不保存
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || restoring || conflict || !!project.archivedAt || !fields.nextStep.trim()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <BookmarkCheck size={16} />
            )}
            保存继续点
          </button>
        </div>
      </form>
    </dialog>
  );
}
