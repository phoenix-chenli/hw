import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  Command,
  PdfJob,
  Project,
  ReportPreview,
  ReportRequest,
  ReportSpec,
  SavedReport,
  Workspace,
} from "../shared/contracts";
import { ApiError, getWorkspace, makeCommand, submitCommand } from "./api";
import { useSessionDraft } from "./session-drafts";
import {
  downloadReport,
  getReportPdfStatus,
  previewReport,
  startReportPdf,
  type ReportFormat,
} from "./report-api";

function validReportDraft(value: unknown): value is ReportRequest {
  if (!value || typeof value !== "object") return false;
  const draft = value as ReportRequest;
  return (
    typeof draft.title === "string" && draft.title.length <= 120 &&
    typeof draft.includeTasks === "boolean" &&
    Array.isArray(draft.artifactIds) && draft.artifactIds.length <= 8 &&
    new Set(draft.artifactIds).size === draft.artifactIds.length &&
    draft.artifactIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
    )
  );
}

type EvidenceOpener = (
  sourceId: string,
  versionId: string,
  details?: { locator?: string; claimId?: string },
) => void;

const statusText = { todo: "待开始", doing: "进行中", done: "已完成" };
const contentVersion = (item: { revisions?: { number: number }[] }) =>
  item.revisions?.at(-1)?.number ?? 1;
const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

function changedSinceCapture(project: Project, report: SavedReport) {
  if (
    project.title !== report.spec.project.title ||
    project.goal !== report.spec.project.goal
  )
    return true;
  if (
    report.spec.sources.some(
      (ref) =>
        project.sources.find((source) => source.id === ref.sourceId)
          ?.currentVersionId !== ref.currentVersionIdAtCapture,
    )
  )
    return true;
  if (
    report.spec.sections.some((section) => {
      const artifact = project.artifacts.find(
        (item) => item.id === section.artifactId,
      );
      return (
        !artifact ||
        contentVersion(artifact) !== section.version ||
        artifact.title !== section.title ||
        artifact.content !== section.content ||
        (artifact.status === "needs_review") !== section.needsReview
      );
    })
  )
    return true;
  if (
    report.spec.claims.some((claim) => {
      const current = project.claims.find((item) => item.id === claim.claimId);
      return (
        !current ||
        contentVersion(current) !== claim.version ||
        current.text !== claim.text ||
        (current.status === "needs_review") !== claim.needsReview
      );
    })
  )
    return true;
  return (
    report.request.includeTasks &&
    (report.spec.tasks.some((task) => {
      const current = project.tasks.find((item) => item.id === task.taskId);
      return (
        !current ||
        contentVersion(current) !== task.version ||
        current.title !== task.title ||
        current.status !== task.status ||
        current.reviewRequired !== task.reviewRequired ||
        (current.checkpoints?.at(-1)?.number ?? 0) !== task.checkpointNumber
      );
    }) ||
      project.tasks.some(
        (task) =>
          task.claimIds.some((id) =>
            report.spec.claims.some((claim) => claim.claimId === id),
          ) && !report.spec.tasks.some((prior) => prior.taskId === task.id),
      ))
  );
}

function ReportContents({
  spec,
  onEvidence,
}: {
  spec: ReportSpec;
  onEvidence: EvidenceOpener;
}) {
  const sourceLabel = (sourceId: string, versionId: string) => {
    const ref = spec.sources.find(
      (source) =>
        source.sourceId === sourceId && source.versionId === versionId,
    );
    return ref
      ? `${ref.title} · 资料第 ${ref.versionNumber} 版`
      : "资料引用待核对";
  };
  return (
    <div className="report-contents">
      <div className="report-document-heading">
        <span>研学进展草稿</span>
        <h3>{spec.title}</h3>
        <p>{spec.project.title}</p>
      </div>
      <div className="report-document-section">
        <h4>项目目标</h4>
        <p className="report-plain">{spec.project.goal}</p>
      </div>
      {spec.sections.map((section, index) => (
        <div className="report-document-section" key={section.artifactId}>
          <header>
            <h4>
              {index + 1}. {section.title}
            </h4>
            <span>
              草稿第 {section.version} 版
              {section.needsReview ? " · 待复核" : ""}
            </span>
          </header>
          <p className="report-plain">{section.content}</p>
        </div>
      ))}
      <details className="report-document-details">
        <summary>
          结论与资料依据{" "}
          <span>
            {spec.claims.length} 条结论 · {spec.sources.length} 个资料版本
          </span>
        </summary>
        {spec.claims.length ? (
          spec.claims.map((claim, index) => (
            <div className="report-reference" key={claim.claimId}>
              <strong>
                {index + 1}. {claim.text}
              </strong>
              <small>
                结论第 {claim.version} 版{claim.needsReview ? " · 待复核" : ""}
              </small>
              <ul>
                {claim.evidence.map((evidence, evidenceIndex) => (
                  <li
                    key={`${evidence.sourceId}-${evidence.versionId}-${evidenceIndex}`}
                  >
                    <button
                      type="button"
                      className="evidence-link"
                      onClick={() =>
                        onEvidence(evidence.sourceId, evidence.versionId, {
                          locator: evidence.locator,
                          claimId: claim.claimId,
                        })
                      }
                    >
                      <span>
                        {sourceLabel(evidence.sourceId, evidence.versionId)}
                        {evidence.locator && (
                          <span>定位：{evidence.locator}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="report-help">所选草稿还没有关联结论。</p>
        )}
      </details>
      {!!spec.tasks.length && (
        <details className="report-document-details">
          <summary>
            关联行动 <span>{spec.tasks.length} 项</span>
          </summary>
          <ul className="report-task-list">
            {spec.tasks.map((task) => (
              <li key={task.taskId}>
                <strong>{task.title}</strong>
                <span>
                  {statusText[task.status]} · 行动第 {task.version} 版
                  {task.reviewRequired ? " · 待复核" : ""}
                </span>
                {task.nextStep && <p>下次第一步：{task.nextStep}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="report-document-note">
        这是所选内容在保存时的进展记录。请人工核对结论、引用与适用范围后再使用。
      </p>
    </div>
  );
}

function Warnings({ spec }: { spec: ReportSpec }) {
  return spec.warnings.length ? (
    <div className="report-warnings">
      <strong>
        <TriangleAlert size={16} aria-hidden="true" /> 使用前请留意
      </strong>
      <ul>
        {spec.warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>{warning.message}</li>
        ))}
      </ul>
    </div>
  ) : null;
}

function SavedReportCard({
  project,
  report,
  onNotice,
  onEvidence,
}: {
  project: Project;
  report: SavedReport;
  onNotice: (message: string) => void;
  onEvidence: EvidenceOpener;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pdf, setPdf] = useState<PdfJob | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const refreshKey = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    async function refresh() {
      const key = refreshKey.current;
      try {
        const result = await getReportPdfStatus(project.id, report.id);
        if (cancelled || key !== refreshKey.current) return;
        setPdf(result);
        setStatusError("");
      } catch (err) {
        if (!cancelled && key === refreshKey.current)
          setStatusError(
            err instanceof Error ? err.message : "暂时无法读取 PDF 状态。",
          );
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      live.current = false;
    };
  }, [project.id, report.id]);
  // A generation started after the initial status lookup also needs polling.
  useEffect(() => {
    if (pdf?.status !== "running") return;
    let cancelled = false;
    const key = refreshKey.current;
    const timer = setTimeout(async () => {
      try {
        const result = await getReportPdfStatus(project.id, report.id);
        if (!cancelled && key === refreshKey.current) {
          setPdf(result);
          setStatusError("");
        }
      } catch (err) {
        if (!cancelled && key === refreshKey.current)
          setStatusError(
            err instanceof Error ? err.message : "暂时无法读取 PDF 状态。",
          );
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project.id, report.id, pdf]);

  async function refreshPdf() {
    if (busy) return;
    setBusy("status");
    setError("");
    refreshKey.current += 1;
    try {
      setPdf(await getReportPdfStatus(project.id, report.id));
      setStatusError("");
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : "暂时无法读取 PDF 状态。",
      );
    } finally {
      if (live.current) setBusy("");
    }
  }
  async function generatePdf() {
    if (busy) return;
    setBusy("pdf");
    setError("");
    refreshKey.current += 1;
    try {
      const result = await startReportPdf(project.id, report.id);
      if (live.current) {
        setPdf(result);
        setStatusError("");
      }
    } catch (err) {
      if (live.current) {
        setError(
          err instanceof Error
            ? err.message
            : "连接中断，请刷新 PDF 状态后重试。",
        );
        setStatusError(
          "请刷新 PDF 状态后再决定是否重试，已在准备的任务会继续运行。",
        );
      }
    } finally {
      if (live.current) setBusy("");
    }
  }
  async function download(format: ReportFormat) {
    if (busy) return;
    setBusy(format);
    setError("");
    try {
      await downloadReport(project.id, report.id, format);
      if (live.current)
        onNotice(
          `已准备第 ${report.number} 版报告的 ${format === "jats" ? "JATS XML" : format.toUpperCase()} 文件。`,
        );
    } catch (err) {
      if (live.current)
        setError(
          err instanceof Error
            ? err.message
            : "下载中断，请重试。已保存版本仍保留。",
        );
    } finally {
      if (live.current) setBusy("");
    }
  }
  const stale = changedSinceCapture(project, report);
  return (
    <article className="report-saved" aria-label={`报告第 ${report.number} 版`}>
      <header>
        <div>
          <span className="report-version">第 {report.number} 版</span>
          <h3>{report.spec.title}</h3>
          <p>
            {formatTime(report.createdAt)} · 上海时间 ·{" "}
            {report.spec.sections.length} 个章节
          </p>
        </div>
        <span className="report-saved-badge">
          <Check size={13} aria-hidden="true" /> 已保存
        </span>
      </header>
      {stale && (
        <p className="report-changed">
          <TriangleAlert size={15} aria-hidden="true" />{" "}
          相关内容已有变化。这份报告保留保存时的内容；需要最新内容时，请重新预览并保存新版本。
        </p>
      )}
      <div className="report-downloads">
        <button
          type="button"
          className="button secondary"
          disabled={!!busy}
          onClick={() => void download("html")}
        >
          {busy === "html" ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}{" "}
          下载 HTML
        </button>
        {pdf?.status === "ready" ? (
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void download("pdf")}
          >
            <Download size={16} aria-hidden="true" /> 下载 PDF
          </button>
        ) : (
          <button
            type="button"
            className="button secondary"
            disabled={
              !!busy || pdf?.status === "running" || !pdf || !!statusError
            }
            onClick={() => void generatePdf()}
          >
            {pdf?.status === "running" || busy === "pdf" ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <FileText size={16} aria-hidden="true" />
            )}
            {pdf?.status === "running"
              ? "PDF 准备中…"
              : pdf?.status === "failed"
                ? "重试生成 PDF"
                : "准备 PDF"}
          </button>
        )}
        <button
          type="button"
          className="text-button report-snapshot-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起报告内容" : "查看保存的内容"}
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="report-pdf-status" role="status" aria-live="polite">
        {pdf?.status === "running" && (
          <p>正在准备这份已保存的报告。可先继续其他工作，回来后下载。</p>
        )}
        {pdf?.status === "ready" && <p>PDF 已就绪，点击下载。</p>}
        {pdf?.status === "failed" && (
          <p className="report-failure">
            PDF 准备失败：{pdf.error ?? "请稍后重试。"} 已保存的报告和 HTML
            仍可使用。
          </p>
        )}
      </div>
      {statusError && (
        <div className="report-status-recovery">
          <p>{statusError}</p>
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() => void refreshPdf()}
          >
            <RefreshCw size={14} aria-hidden="true" /> 刷新 PDF 状态
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="report-error">
          {error}
        </p>
      )}
      {expanded && (
        <div className="report-snapshot">
          <Warnings spec={report.spec} />
          <ReportContents spec={report.spec} onEvidence={onEvidence} />
        </div>
      )}
      <details className="report-technical">
        <summary>技术格式与版本信息</summary>
        <p>
          JATS XML 是本项目的受限交换格式。JSON 包含本次保存的完整报告记录。
        </p>
        <div className="report-inline">
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() => void download("jats")}
          >
            下载 JATS XML
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() => void download("json")}
          >
            下载 JSON
          </button>
        </div>
        <p className="report-hash">内容指纹：{report.contentHash}</p>
      </details>
    </article>
  );
}

export default function ReportPanel({
  project,
  workspace,
  onWorkspace,
  onNotice,
  onEvidence,
}: {
  project: Project;
  workspace: Workspace;
  onWorkspace: (state: Workspace) => void;
  onNotice: (message: string) => void;
  onEvidence: EvidenceOpener;
}) {
  const prefix = useId();
  const draft = useSessionDraft<ReportRequest>(
    `report:${project.id}`,
    () => ({
      title: `${project.title} · 研学进展报告`.slice(0, 120),
      artifactIds: [],
      includeTasks: true,
    }),
    validReportDraft,
  );
  const { title, artifactIds, includeTasks } = draft.value;
  function setField<K extends keyof ReportRequest>(
    key: K,
    value: SetStateAction<ReportRequest[K]>,
  ) {
    draft.setValue((previous) => ({
      ...previous,
      [key]: typeof value === "function" ? value(previous[key]) : value,
    }));
  }
  const setTitle = (value: string) => setField("title", value);
  const setArtifactIds = (value: SetStateAction<string[]>) =>
    setField("artifactIds", value);
  const setIncludeTasks = (value: boolean) => setField("includeTasks", value);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<Command | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const request: ReportRequest = { title, artifactIds, includeTasks };
  const reports = [...(project.reports ?? [])].reverse();
  const disabled = !!working;
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  function invalidate() {
    setPreview(null);
    setAcknowledged(false);
    setStale(false);
    setError("");
    pending.current = null;
  }
  function showError(message: string) {
    setError(message);
  }
  function move(index: number, direction: -1 | 1) {
    invalidate();
    setArtifactIds((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  }
  async function showPreview(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!artifactIds.length) {
      showError("请先选择至少一份成果草稿。");
      return;
    }
    setWorking("preview");
    setError("");
    setPreview(null);
    setAcknowledged(false);
    pending.current = null;
    try {
      if (stale) onWorkspace(await getWorkspace());
      const result = await previewReport(project.id, request);
      setPreview(result);
      setStale(false);
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "暂时无法预览报告，请重试。",
      );
    } finally {
      setWorking("");
    }
  }
  async function save() {
    if (
      disabled ||
      !preview ||
      stale ||
      (preview.spec.warnings.length && !acknowledged)
    )
      return;
    const payload = {
      projectId: project.id,
      request: preview.request,
      previewToken: preview.previewToken,
      acknowledgeWarnings: acknowledged,
    };
    const previous = pending.current;
    const command =
      previous && JSON.stringify(previous.payload) === JSON.stringify(payload)
        ? previous
        : makeCommand("save_report", payload, workspace.revision);
    pending.current = command;
    setWorking("save");
    setError("");
    try {
      const response = await submitCommand(command);
      pending.current = null;
      draft.clear();
      onWorkspace(response.state);
      setPreview(null);
      setAcknowledged(false);
      setStale(false);
      onNotice("报告已保存为独立版本，现在可以下载；后续修改会保留这份内容。");
    } catch (err) {
      let message =
        err instanceof Error ? err.message : "暂时无法保存，请重试。";
      if (err instanceof ApiError && err.status === 409) {
        pending.current = null;
        setStale(true);
        setAcknowledged(false);
        try {
          onWorkspace(await getWorkspace());
          message += " 填写和章节顺序已保留，请重新预览后再保存。";
        } catch {
          message += " 填写已保留，恢复本地服务后请重新预览。";
        }
      } else if (!(err instanceof ApiError)) {
        message =
          "连接中断，填写已保留。请重试保存，将沿用同一个保存编号，避免重复版本。";
      }
      showError(message);
    } finally {
      setWorking("");
    }
  }
  return (
    <section
      className="panel report-panel"
      aria-labelledby={`${prefix}-heading`}
    >
      <header className="report-header">
        <div>
          <span className="eyebrow">整理成果</span>
          <h2 id={`${prefix}-heading`}>把已完成的工作整理成报告</h2>
          <p>选择草稿，核对依据，再保存一份可下载的进展记录。</p>
        </div>
        <div className="report-icon">
          <FileText size={23} aria-hidden="true" />
        </div>
      </header>
      <div className="report-body">
        {draft.restored && (
          <p className="report-help session-draft-notice" role="status">
            已恢复本项目尚未保存的报告填写和章节顺序，请重新预览并核对后再保存。
          </p>
        )}
        <ol className="report-steps" aria-label="报告整理步骤">
          <li>
            <span>1</span> 选择章节
          </li>
          <li>
            <span>2</span> 核对预览
          </li>
          <li>
            <span>3</span> 保存与下载
          </li>
        </ol>
        {project.artifacts.length ? (
          <form onSubmit={(event) => void showPreview(event)}>
            <fieldset disabled={disabled} className="report-fields">
              <div className="field">
                <label htmlFor={`${prefix}-title`}>报告标题</label>
                <input
                  id={`${prefix}-title`}
                  value={title}
                  maxLength={120}
                  required
                  onChange={(event) => {
                    invalidate();
                    setTitle(event.target.value);
                  }}
                />
              </div>
              <fieldset className="report-choices">
                <legend>
                  选择成果章节 <span>已选 {artifactIds.length} / 8</span>
                </legend>
                <p className="report-help">
                  按选择顺序编排，也可以调整顺序。每份报告最多 8 个章节。
                </p>
                {project.artifacts.map((artifact) => {
                  const index = artifactIds.indexOf(artifact.id);
                  return (
                    <label
                      key={artifact.id}
                      className={`report-choice${index >= 0 ? " is-selected" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={index >= 0}
                        disabled={
                          disabled || (index < 0 && artifactIds.length >= 8)
                        }
                        aria-label={`加入报告：${artifact.title}`}
                        onChange={(event) => {
                          invalidate();
                          setArtifactIds((current) =>
                            event.target.checked
                              ? [...current, artifact.id]
                              : current.filter((id) => id !== artifact.id),
                          );
                        }}
                      />
                      <span>
                        <strong>{artifact.title}</strong>
                        <small>
                          草稿第 {contentVersion(artifact)} 版 ·{" "}
                          {artifact.claimIds.length} 条关联结论
                          {artifact.status === "needs_review"
                            ? " · 待复核"
                            : ""}
                        </small>
                      </span>
                      {index >= 0 && (
                        <span className="report-order">{index + 1}</span>
                      )}
                    </label>
                  );
                })}
              </fieldset>
              {!!artifactIds.length && (
                <ol className="report-section-order" aria-label="报告章节顺序">
                  {artifactIds.map((id, index) => {
                    const artifact = project.artifacts.find(
                      (item) => item.id === id,
                    );
                    return (
                      <li key={id}>
                        <span>
                          {index + 1}. {artifact?.title ?? "草稿已无法读取"}
                        </span>
                        <div>
                          <button
                            type="button"
                            className="report-move"
                            aria-label={`上移报告章节：${artifact?.title ?? id}`}
                            disabled={disabled || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="report-move"
                            aria-label={`下移报告章节：${artifact?.title ?? id}`}
                            disabled={
                              disabled || index === artifactIds.length - 1
                            }
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              <label className="report-check">
                <input
                  type="checkbox"
                  checked={includeTasks}
                  onChange={(event) => {
                    invalidate();
                    setIncludeTasks(event.target.checked);
                  }}
                />
                <span>
                  <strong>附上关联行动</strong>
                  <small>只收录与所选草稿结论有关的行动和最新继续点。</small>
                </span>
              </label>
              <div className="report-preview-action">
                <button
                  type="submit"
                  className="button primary"
                  disabled={disabled || !artifactIds.length}
                >
                  {working === "preview" ? (
                    <LoaderCircle
                      size={16}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileText size={16} aria-hidden="true" />
                  )}
                  {stale ? "重新预览报告" : "预览报告"}
                </button>
                <small>预览不会创建报告，也不会改变工作进度。</small>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="report-empty">
            <FileText size={24} aria-hidden="true" />
            <h3>先写下第一份成果草稿</h3>
            <p>有了草稿后，就能在这里选择章节、整理依据并导出报告。</p>
          </div>
        )}
        {error && (
          <div
            className="report-error"
            role="alert"
            tabIndex={-1}
            ref={errorBox}
          >
            {error}
          </div>
        )}
        {preview && (
          <section
            className={`report-preview${stale ? " is-stale" : ""}`}
            aria-label="报告预览"
          >
            <header>
              <h3 tabIndex={-1} ref={previewHeading}>
                核对这份报告
              </h3>
              <span>
                {preview.spec.sections.length} 个章节 ·{" "}
                {preview.spec.claims.length} 条结论
              </span>
            </header>
            <Warnings spec={preview.spec} />
            <ReportContents spec={preview.spec} onEvidence={onEvidence} />
            {!!preview.spec.warnings.length && (
              <label className="report-check report-ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={disabled || stale}
                  onChange={(event) => {
                    pending.current = null;
                    setAcknowledged(event.target.checked);
                  }}
                />
                <span>我已查看上述提醒，确认将这些内容作为进展草稿保存。</span>
              </label>
            )}
            <div className="report-preview-action">
              <button
                type="button"
                className="button primary"
                disabled={
                  disabled ||
                  stale ||
                  reports.length >= 30 ||
                  (!!preview.spec.warnings.length && !acknowledged)
                }
                onClick={() => void save()}
              >
                {working === "save" ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                保存报告版本
              </button>
              <small>
                {stale
                  ? "内容已变化，请保留填写并重新预览。"
                  : reports.length >= 30
                    ? "本项目已达到 30 个报告版本上限。"
                    : "保存后内容固定，后续更新请另存新版本。"}
              </small>
            </div>
          </section>
        )}
        <section
          className="report-history"
          aria-labelledby={`${prefix}-history`}
        >
          <header>
            <h3 id={`${prefix}-history`}>已保存的报告</h3>
            <span>{reports.length} / 30 份</span>
          </header>
          {reports.length ? (
            reports.map((report) => (
              <SavedReportCard
                key={report.id}
                project={project}
                report={report}
                onNotice={onNotice}
                onEvidence={onEvidence}
              />
            ))
          ) : (
            <p className="report-help">
              还没有保存的报告。完成预览并确认后，就能下载 HTML 或准备 PDF。
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
