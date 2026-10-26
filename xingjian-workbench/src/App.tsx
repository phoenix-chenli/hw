import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  FileCheck2,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  Menu,
  Plus,
  RefreshCw,
  SearchCheck,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  Artifact,
  Command,
  CommandType,
  ImpactPreview,
  Project,
  Source,
  Task,
  Workspace,
} from "../shared/contracts";
import {
  ApiError,
  getWorkspace,
  makeCommand,
  previewUpdate,
  submitCommand,
} from "./api";
import AnalysisPanel from "./AnalysisPanel";
import ReviewDialog, { type ReviewTarget } from "./ReviewDialog";
import TaskWorkDialog from "./TaskWorkDialog";
import PlanningPanel from "./PlanningPanel";
import ReportPanel from "./ReportPanel";
import EvidenceDialog from "./EvidenceDialog";
import SourceVersionCompare from "./SourceVersionCompare";
import TextDiff from "./TextDiff";
import type { EvidenceTarget } from "./evidence-types";

type Page = "overview" | "materials" | "analysis" | "actions" | "artifacts";
const navigationKey = "xingjian.navigation.v1";
function savedNavigation(): { projectId: string; page: Page } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(navigationKey) ?? "null");
    if (
      saved &&
      typeof saved.projectId === "string" &&
      ["overview", "materials", "analysis", "actions", "artifacts"].includes(
        saved.page,
      )
    )
      return saved;
  } catch {
    /* Browser storage may be unavailable; business data stays on the server. */
  }
  return { projectId: "", page: "overview" };
}
type Modal = "project" | "source" | "claim" | "task" | "artifact" | "update";
interface Fields {
  title: string;
  content: string;
  goal: string;
  deadline: string;
  kind: Source["kind"];
  sourceId: string;
  locator: string;
  claimIds: string[];
}
const emptyFields = (): Fields => ({
  title: "",
  content: "",
  goal: "",
  deadline: "",
  kind: "note",
  sourceId: "",
  locator: "",
  claimIds: [],
});
const nav = [
  { id: "overview" as const, label: "项目首页", icon: LayoutDashboard },
  { id: "materials" as const, label: "资料与依据", icon: BookOpen },
  { id: "analysis" as const, label: "资料分析", icon: SearchCheck },
  { id: "actions" as const, label: "行动清单", icon: CheckCircle2 },
  { id: "artifacts" as const, label: "成果草稿", icon: FileCheck2 },
];
const sourceKind = {
  note: "文字笔记",
  table: "表格摘录",
  document: "文档摘录",
};
const taskStatus = { todo: "待开始", doing: "进行中", done: "已完成" };
const currentVersion = (source: Source) =>
  source.versions.find((version) => version.id === source.currentVersionId)!;
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
  }).format(new Date(value.length === 10 ? `${value}T12:00:00` : value));
}
function humanError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "amber" | "green";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projectId, setProjectId] = useState(() => savedNavigation().projectId);
  const [page, setPage] = useState<Page>(() => savedNavigation().page);
  const [initialError, setInitialError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [workTaskId, setWorkTaskId] = useState<string | null>(null);
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(
    null,
  );
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [formError, setFormError] = useState("");
  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingCommand = useRef<Command | null>(null);
  const project =
    workspace?.projects.find((item) => item.id === projectId) ??
    workspace?.projects[0];
  const source =
    project?.sources.find((item) => item.id === selectedSourceId) ??
    project?.sources[0];
  const visibleVersion =
    source?.versions.find((item) => item.id === selectedVersionId) ??
    (source ? currentVersion(source) : undefined);

  useEffect(() => {
    if (!project) return;
    try {
      sessionStorage.setItem(
        navigationKey,
        JSON.stringify({ projectId: project.id, page }),
      );
    } catch {
      /* Do not block saves when session storage is disabled. */
    }
  }, [project?.id, page]);

  async function load() {
    setInitialError("");
    try {
      const state = await getWorkspace();
      setWorkspace((previous) =>
        previous && previous.revision > state.revision ? previous : state,
      );
    } catch (error) {
      setInitialError(humanError(error));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!modal) return;
    dialogRef.current?.showModal();
    dialogRef.current
      ?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
      )
      ?.focus();
    return () => {
      dialogRef.current?.close();
      previousFocus.current?.focus();
    };
  }, [modal]);

  function openModal(next: Modal, preset: Partial<Fields> = {}) {
    previousFocus.current = document.activeElement as HTMLElement;
    pendingCommand.current = null;
    setFields({
      ...emptyFields(),
      sourceId: project?.sources[0]?.id ?? "",
      ...preset,
    });
    setPreview(null);
    setPreviewRevision(null);
    setFormError("");
    setModal(next);
  }
  function closeModal() {
    if (!busy) {
      setModal(null);
      pendingCommand.current = null;
    }
  }
  function updateField<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((previous) => ({ ...previous, [key]: value }));
    setPreview(null);
    setPreviewRevision(null);
    setFormError("");
    pendingCommand.current = null;
  }
  function navigate(next: Page) {
    setPage(next);
    setSidebarOpen(false);
  }
  function selectProject(id: string) {
    setEvidenceTarget(null);
    setProjectId(id);
    setSelectedSourceId("");
    setSelectedVersionId("");
    setPage("overview");
    setSidebarOpen(false);
    setNotice("");
  }
  function viewEvidence(
    sourceId: string,
    versionId: string,
    details: Omit<EvidenceTarget, "sourceId" | "versionId"> = {},
  ) {
    setEvidenceTarget({ sourceId, versionId, ...details });
  }

  async function mutate(
    type: CommandType,
    payload: Record<string, unknown>,
    success: string,
    dismiss = true,
  ) {
    if (!workspace || busy) return;
    setBusy(true);
    setFormError("");
    setNotice("");
    const existing = pendingCommand.current;
    const command =
      existing &&
      existing.type === type &&
      JSON.stringify(existing.payload) === JSON.stringify(payload)
        ? existing
        : makeCommand(type, payload, workspace.revision);
    pendingCommand.current = command;
    try {
      const response = await submitCommand(command);
      setWorkspace(response.state);
      setProjectId(response.result.projectId);
      pendingCommand.current = null;
      if (dismiss) setModal(null);
      setNotice(success);
      if (type === "create_project" || type === "load_demo") {
        setPage("overview");
        setSelectedSourceId("");
        setSelectedVersionId("");
      }
      if (type === "add_source") {
        setSelectedSourceId(response.result.entityId ?? "");
        setSelectedVersionId("");
      }
      if (type === "update_source") setSelectedVersionId("");
    } catch (error) {
      let message = humanError(error);
      if (error instanceof ApiError && error.status === 409) {
        pendingCommand.current = null;
        setPreview(null);
        setPreviewRevision(null);
        try {
          setWorkspace(await getWorkspace());
          message =
            "资料状态已更新。你的输入已保留，请核对最新内容后重新提交；资料变更需要重新预览。";
        } catch {
          message =
            "状态发生冲突，且暂时无法刷新。输入已保留，请恢复本地服务后重试。";
        }
      }
      if (modal) setFormError(message);
      else setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!workspace || busy) return;
    if (modal === "project")
      return mutate(
        "create_project",
        {
          title: fields.title.trim(),
          goal: fields.goal.trim(),
          deadline: fields.deadline || null,
        },
        "项目已建立，从添加第一份资料开始。",
      );
    if (!project) return;
    const projectPayload = { projectId: project.id };
    if (modal === "source")
      return mutate(
        "add_source",
        {
          ...projectPayload,
          title: fields.title.trim(),
          content: fields.content,
          kind: fields.kind,
        },
        "资料已保存，来源版本为 v1。",
      );
    if (modal === "claim") {
      const selected = project.sources.find(
        (item) => item.id === fields.sourceId,
      );
      if (!selected) {
        setFormError("请先添加并选择一份资料。");
        return;
      }
      return mutate(
        "add_claim",
        {
          ...projectPayload,
          text: fields.content.trim(),
          evidence: [
            {
              sourceId: selected.id,
              versionId: selected.currentVersionId,
              locator: fields.locator.trim(),
            },
          ],
        },
        "结论已关联当前资料版本，内容仍需人工核对。",
      );
    }
    if (modal === "task")
      return mutate(
        "add_task",
        {
          ...projectPayload,
          title: fields.title.trim(),
          claimIds: fields.claimIds,
        },
        "行动已添加，可以开始推进。",
      );
    if (modal === "artifact")
      return mutate(
        "add_artifact",
        {
          ...projectPayload,
          title: fields.title.trim(),
          content: fields.content,
          claimIds: fields.claimIds,
        },
        "草稿已保存，并保留结论关联。",
      );
    if (modal === "update") {
      if (preview) {
        if (previewRevision !== workspace.revision) {
          setPreview(null);
          setFormError("工作区已变化，请重新预览影响后确认。");
          return;
        }
        return mutate(
          "update_source",
          {
            ...projectPayload,
            sourceId: fields.sourceId,
            baseVersionId: preview.baseVersionId,
            content: preview.nextContent,
          },
          "新版本已保存。相关结论、行动和草稿已标记待复核，原内容与任务进度已保留。",
        );
      }
      setBusy(true);
      setFormError("");
      try {
        const result = await previewUpdate(
          project.id,
          fields.sourceId,
          fields.content,
        );
        setPreview(result);
        setPreviewRevision(workspace.revision);
      } catch (error) {
        setFormError(humanError(error));
      } finally {
        setBusy(false);
      }
    }
  }

  const changeCount =
    (project?.claims.filter((claim) => claim.status === "needs_review")
      .length ?? 0) +
    (project?.tasks.filter((task) => task.reviewRequired).length ?? 0) +
    (project?.artifacts.filter((artifact) => artifact.status === "needs_review")
      .length ?? 0);
  const activeTasks =
    project?.tasks.filter((task) => task.status !== "done") ?? [];
  const completion = project?.tasks.length
    ? Math.round(
        (project.tasks.filter((task) => task.status === "done").length /
          project.tasks.length) *
          100,
      )
    : 0;
  const title = nav.find((item) => item.id === page)?.label ?? "项目首页";

  function nextReview() {
    if (!project) return;
    const claim = project.claims.find((item) => item.status === "needs_review");
    const task = project.tasks.find((item) => item.reviewRequired);
    const artifact = project.artifacts.find(
      (item) => item.status === "needs_review",
    );
    if (claim) setReviewTarget({ kind: "claim", entityId: claim.id });
    else if (task) setReviewTarget({ kind: "task", entityId: task.id });
    else if (artifact)
      setReviewTarget({ kind: "artifact", entityId: artifact.id });
  }

  function reviewButton(
    kind: ReviewTarget["kind"],
    entity: { id: string; revisions?: unknown[] },
    pending: boolean,
  ) {
    if (!pending && !entity.revisions?.length) return null;
    return (
      <button
        type="button"
        className="text-button review-entry"
        disabled={busy}
        onClick={() => setReviewTarget({ kind, entityId: entity.id })}
      >
        {pending ? "逐项复核" : `复核记录 · v${entity.revisions!.length}`}
        {pending ? <ArrowRight size={14} /> : <History size={14} />}
      </button>
    );
  }

  function claimLinks(claimIds: string[]) {
    return (
      <div className="relationship-list">
        {claimIds.map((id) => {
          const claim = project?.claims.find((item) => item.id === id);
          return claim ? (
            <button
              type="button"
              className="relation"
              key={id}
              onClick={() => {
                if (claim.evidence[0])
                  viewEvidence(
                    claim.evidence[0].sourceId,
                    claim.evidence[0].versionId,
                    { locator: claim.evidence[0].locator, claimId: claim.id },
                  );
              }}
            >
              <Link2 size={13} />
              <span>{claim.text}</span>
            </button>
          ) : null;
        })}
        {claimIds.length === 0 && (
          <span className="muted small">独立工作项，未关联结论</span>
        )}
      </div>
    );
  }
  function claimPicker() {
    return (
      <fieldset className="claim-picker">
        <legend>关联结论</legend>
        <p className="field-hint">资料更新时，可沿着这些关联提醒你复核。</p>
        {project?.claims.length ? (
          project.claims.map((claim) => (
            <label className="check-option" key={claim.id}>
              <input
                type="checkbox"
                checked={fields.claimIds.includes(claim.id)}
                onChange={(event) =>
                  updateField(
                    "claimIds",
                    event.target.checked
                      ? [...fields.claimIds, claim.id]
                      : fields.claimIds.filter((id) => id !== claim.id),
                  )
                }
              />
              <span>
                {claim.text}
                {claim.status === "needs_review" && (
                  <small>这项结论待复核</small>
                )}
              </span>
            </label>
          ))
        ) : (
          <p className="muted small">
            目前还没有结论，可以先在「资料与依据」中添加。
          </p>
        )}
      </fieldset>
    );
  }
  function taskCard(task: Task, compact = false) {
    return (
      <article
        key={task.id}
        className={`task-row ${task.status === "done" ? "task-done" : ""}`}
      >
        <div className={`task-symbol ${task.status}`} aria-hidden="true">
          {task.status === "done" ? (
            <Check size={16} />
          ) : task.status === "doing" ? (
            <Clock3 size={16} />
          ) : (
            <Circle size={16} />
          )}
        </div>
        <div className="task-text">
          <h3>{task.title}</h3>
          {task.reviewRequired && (
            <p className="warning-text">
              <TriangleAlert size={13} /> 依据已变化，完成状态保留，内容需要复核
            </p>
          )}
          {!compact && claimLinks(task.claimIds)}
          {reviewButton("task", task, task.reviewRequired)}
          {task.checkpoints?.length ? (
            <p className="task-continue-snippet">
              下次第一步：{task.checkpoints.at(-1)!.nextStep}
            </p>
          ) : null}
          <button
            type="button"
            className="text-button task-continue-button"
            disabled={busy}
            onClick={() => setWorkTaskId(task.id)}
          >
            {task.checkpoints?.length ? "打开继续点" : "记录继续点"}
            <ArrowRight size={14} />
          </button>
        </div>
        <label className="sr-only" htmlFor={`status-${task.id}-${compact}`}>
          「{task.title}」的状态
        </label>
        <select
          className="status-select"
          id={`status-${task.id}-${compact}`}
          value={task.status}
          disabled={busy}
          onChange={(event) =>
            void mutate(
              "set_task_status",
              {
                projectId: project!.id,
                taskId: task.id,
                status: event.target.value,
              },
              "行动进度已更新。",
              false,
            )
          }
        >
          {Object.entries(taskStatus).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </article>
    );
  }
  function sourceButton(item: Source) {
    return (
      <button
        type="button"
        className={`source-item ${source?.id === item.id ? "selected" : ""}`}
        key={item.id}
        onClick={() => {
          setSelectedSourceId(item.id);
          setSelectedVersionId("");
        }}
      >
        <span className="file-icon">
          <FileText size={20} />
        </span>
        <span className="source-name">
          <strong>{item.title}</strong>
          <small>
            {sourceKind[item.kind]} · v{currentVersion(item).number}
          </small>
        </span>
        <ChevronRight size={16} />
      </button>
    );
  }
  function artifactCard(artifact: Artifact) {
    return (
      <article className="panel artifact-card" key={artifact.id}>
        <div className="panel-heading">
          <div className="inline">
            <span className="file-icon">
              <FileText size={21} />
            </span>
            <h3>{artifact.title}</h3>
          </div>
          <Badge
            tone={artifact.status === "needs_review" ? "amber" : "neutral"}
          >
            {artifact.status === "needs_review"
              ? "待复核"
              : artifact.revisions?.length
                ? "已人工复核"
                : "手工草稿"}
          </Badge>
        </div>
        <div className="plain-content artifact-content">{artifact.content}</div>
        <div className="artifact-footer">
          <span className="eyebrow">关联依据</span>
          {claimLinks(artifact.claimIds)}
          {reviewButton(
            "artifact",
            artifact,
            artifact.status === "needs_review",
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="收起导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <GitBranch size={24} />
          </span>
          <div>
            <strong>行简</strong>
            <span>研学工作台</span>
          </div>
          <button
            type="button"
            className="icon-button mobile-only close-sidebar"
            onClick={() => setSidebarOpen(false)}
            aria-label="收起导航"
          >
            <X size={20} />
          </button>
        </div>
        <div className="sidebar-section-heading">
          <span>我的项目</span>
          <button
            type="button"
            className="icon-button"
            title="新建项目"
            aria-label="新建项目"
            onClick={() => openModal("project")}
            disabled={!workspace || busy}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="project-list">
          {workspace?.projects.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`project-switch ${item.id === project?.id ? "active" : ""}`}
              onClick={() => selectProject(item.id)}
            >
              <FolderOpen size={17} />
              <span>{item.title}</span>
              {item.isDemo && (
                <span className="demo-dot" title="合成演示项目">
                  示例
                </span>
              )}
            </button>
          ))}
          {workspace?.projects.length === 0 && (
            <p className="empty-projects">
              还没有项目
              <br />
              从一个清楚的目标开始
            </p>
          )}
        </div>
        <div className="sidebar-divider" />
        <nav aria-label="项目导航">
          {nav.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              disabled={!project}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "actions" && activeTasks.length > 0 && (
                <span className="nav-count">{activeTasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            本地工作区
          </div>
          <p>
            资料保存在当前电脑
            <br />
            AgentArts 尚未连接
          </p>
          <details className="capability-details">
            <summary>
              <Settings2 size={14} />
              当前版本能力
            </summary>
            <p>
              已支持资料版本、关键词检索、CSV
              受控计算、提案确认、逐项复核、任务继续点和本地计划预览。AgentArts
              尚未连接。已支持原文依据查看、资料版本差异、固定模板报告及使用现有浏览器生成
              PDF。
            </p>
          </details>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button mobile-only"
              onClick={() => setSidebarOpen(true)}
              aria-label="展开导航"
              aria-expanded={sidebarOpen}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb-project">
              {project?.title ?? "我的工作区"}
            </span>
            <ChevronRight size={14} />
            <span>{title}</span>
          </div>
          <div className="topbar-right">
            {project?.isDemo && <Badge tone="blue">合成演示</Badge>}
            <span className="desktop-only local-label">
              <ShieldCheck size={14} />
              本地单用户
            </span>
            <span className="avatar" aria-label="本地用户">
              我
            </span>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {notice && (
            <div role="status" className="toast">
              <CheckCircle2 size={18} />
              <span>{notice}</span>
              <button
                type="button"
                aria-label="关闭提示"
                className="icon-button"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!workspace ? (
            <Empty
              icon={
                initialError ? (
                  <TriangleAlert size={30} />
                ) : (
                  <LoaderCircle size={30} className="spin" />
                )
              }
              title={initialError ? "暂时无法打开工作区" : "正在打开工作区"}
              action={
                initialError && (
                  <button
                    className="button primary"
                    onClick={() => void load()}
                  >
                    <RefreshCw size={16} />
                    重新连接
                  </button>
                )
              }
            >
              {initialError || "正在读取这台电脑保存的项目。"}
            </Empty>
          ) : !project ? (
            <section className="welcome">
              <span className="eyebrow">让每一步，都有所依据</span>
              <h1>
                从一个问题，
                <br />
                走向一份扎实的成果。
              </h1>
              <p>
                把研究资料、结论与行动放在一起。
                <br />
                资料更新后，知道哪些工作需要重新核对。
              </p>
              <div className="welcome-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => openModal("project")}
                >
                  <Plus size={18} />
                  建立我的第一个项目
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      "load_demo",
                      {},
                      "已加载合成演示项目，所有数据仅用于体验。",
                    )
                  }
                >
                  {busy ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <BookOpen size={17} />
                  )}
                  体验一个示例
                </button>
              </div>
              <div className="welcome-flow">
                {[
                  ["01", "整理资料", "保存来源与版本"],
                  ["02", "连接依据", "让结论可以回查"],
                  ["03", "推进工作", "追踪行动和草稿"],
                ].map(([number, label, hint]) => (
                  <div key={number}>
                    <span>{number}</span>
                    <h3>{label}</h3>
                    <p>{hint}</p>
                  </div>
                ))}
              </div>
              <p className="welcome-note">
                示例不会自动加载 · 本地资料检索与计算无需云端密钥
              </p>
            </section>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {page === "overview"
                      ? "把重要的事，向前推进一步"
                      : page === "materials"
                        ? "每一项结论，都能回到出处"
                        : page === "analysis"
                          ? "有据可查，再向前一步"
                          : page === "actions"
                            ? "让发现变成具体的下一步"
                            : "保留思路，也保留它的依据"}
                  </span>
                  <h1>{page === "overview" ? project.title : title}</h1>
                  <p>
                    {page === "overview"
                      ? project.goal
                      : page === "materials"
                        ? "粘贴资料、记录结论，并保留每次修改的来源版本。"
                        : page === "analysis"
                          ? "查找原文、核对数字，把值得继续的发现变成行动。"
                          : page === "actions"
                            ? "按实际进展更新状态；资料变化时，关联工作会提醒复核。"
                            : "先记录真实发现，再逐步完善。当前保存的是手工草稿。"}
                  </p>
                </div>
                {page === "overview" ? (
                  <div className="deadline">
                    <Clock3 size={16} />
                    {project.deadline
                      ? `${formatDate(project.deadline)} 截止`
                      : "暂未设置截止日期"}
                  </div>
                ) : page === "analysis" ? (
                  <span className="badge badge-blue">
                    本地分析 · 云端未连接
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() =>
                      openModal(
                        page === "materials"
                          ? "source"
                          : page === "actions"
                            ? "task"
                            : "artifact",
                      )
                    }
                  >
                    <Plus size={17} />
                    {page === "materials"
                      ? "添加资料"
                      : page === "actions"
                        ? "添加行动"
                        : "建立草稿"}
                  </button>
                )}
              </div>
              {project.isDemo && (
                <div className="demo-banner">
                  <BookOpen size={15} />
                  <span>
                    这是合成的校园节能研究示例，用于体验资料变更流程，不代表真实研究结果。
                  </span>
                </div>
              )}
              {page === "overview" && (
                <>
                  <section className="overview-hero">
                    <div>
                      <span className="section-kicker">下一步</span>
                      <h2>
                        {changeCount > 0
                          ? "先核对变化，再继续推进"
                          : project.sources.length === 0
                            ? "为你的研究，放进第一份资料"
                            : activeTasks.length > 0
                              ? activeTasks[0].title
                              : project.claims.length === 0
                                ? "写下一个发现，关联它的依据"
                                : "把已有发现，整理成下一步"}
                      </h2>
                      <p>
                        {changeCount > 0
                          ? `资料有过更新，${changeCount} 项关联内容需要你复核。原有内容和任务进度已经保留。`
                          : project.sources.length === 0
                            ? "可以粘贴任务书、阅读摘录或表格文字。先保留来源，再记录想法。"
                            : activeTasks.length > 0
                              ? "工作不用一次完成。记录实际进展，下次从这里继续。"
                              : "让资料不止停在收藏里，把结论连接到行动与成果。"}
                      </p>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => {
                          if (changeCount > 0) nextReview();
                          else if (!project.sources.length) openModal("source");
                          else if (activeTasks.length) navigate("actions");
                          else if (!project.claims.length) openModal("claim");
                          else openModal("task");
                        }}
                      >
                        {changeCount > 0
                          ? "查看待复核内容"
                          : !project.sources.length
                            ? "添加第一份资料"
                            : activeTasks.length
                              ? "继续这项工作"
                              : !project.claims.length
                                ? "记录一项结论"
                                : "添加下一步"}
                        <ArrowRight size={17} />
                      </button>
                    </div>
                    <div className="hero-visual" aria-hidden="true">
                      <div className="visual-paper back">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="visual-paper front">
                        <span className="visual-doc-icon">
                          <FileText size={26} />
                        </span>
                        <strong>从资料到成果</strong>
                        <span />
                        <span />
                      </div>
                      <span className="visual-link">
                        <Link2 size={23} />
                      </span>
                      <span className="visual-check">
                        <Check size={22} />
                      </span>
                    </div>
                  </section>
                  <section className="stats-grid" aria-label="项目概览">
                    {[
                      [project.sources.length, "份研究资料", BookOpen],
                      [project.claims.length, "项关联结论", Link2],
                      [activeTasks.length, "项待办行动", CheckCircle2],
                      [project.artifacts.length, "份成果草稿", FileCheck2],
                    ].map(([number, label, Icon], index) => {
                      const StatIcon = Icon as typeof BookOpen;
                      return (
                        <div className="stat" key={index}>
                          <StatIcon size={18} />
                          <div>
                            <strong>{number as number}</strong>
                            <span>{label as string}</span>
                          </div>
                        </div>
                      );
                    })}
                  </section>
                  {changeCount > 0 && (
                    <section className="change-banner">
                      <span className="warning-icon">
                        <GitBranch size={23} />
                      </span>
                      <div>
                        <h3>来源发生变化，相关内容需要复核</h3>
                        <p>
                          {
                            project.claims.filter(
                              (item) => item.status === "needs_review",
                            ).length
                          }{" "}
                          项结论 ·{" "}
                          {
                            project.tasks.filter((item) => item.reviewRequired)
                              .length
                          }{" "}
                          项行动 ·{" "}
                          {
                            project.artifacts.filter(
                              (item) => item.status === "needs_review",
                            ).length
                          }{" "}
                          份草稿。仅追踪已建立的关联。
                        </p>
                      </div>
                      <button
                        type="button"
                        className="button subtle"
                        onClick={nextReview}
                      >
                        开始逐项复核
                        <ArrowRight size={16} />
                      </button>
                    </section>
                  )}
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>正在推进</h2>
                        <button
                          className="text-button"
                          onClick={() => navigate("actions")}
                        >
                          全部行动
                          <ChevronRight size={15} />
                        </button>
                      </div>
                      {project.tasks.length ? (
                        <>
                          <div className="progress-heading">
                            <span>
                              已完成{" "}
                              {
                                project.tasks.filter(
                                  (item) => item.status === "done",
                                ).length
                              }{" "}
                              / {project.tasks.length}
                            </span>
                            <strong>{completion}%</strong>
                          </div>
                          <div className="progress-track">
                            <span style={{ width: `${completion}%` }} />
                          </div>
                          <div className="task-list">
                            {(activeTasks.length ? activeTasks : project.tasks)
                              .slice(0, 3)
                              .map((task) => taskCard(task, true))}
                          </div>
                        </>
                      ) : (
                        <Empty
                          icon={<CheckCircle2 size={25} />}
                          title="给下一步一个落点"
                          action={
                            <button
                              className="button secondary"
                              onClick={() => openModal("task")}
                            >
                              <Plus size={16} />
                              添加行动
                            </button>
                          }
                        >
                          阅读、核查或补充实验，都可以从一件小事开始。
                        </Empty>
                      )}
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>研究资料</h2>
                        <button
                          className="text-button"
                          onClick={() => navigate("materials")}
                        >
                          查看全部
                          <ChevronRight size={15} />
                        </button>
                      </div>
                      {project.sources.length ? (
                        <div className="compact-sources">
                          {project.sources.slice(0, 4).map((item) => (
                            <button
                              className="source-item"
                              key={item.id}
                              onClick={() => {
                                setSelectedSourceId(item.id);
                                setSelectedVersionId("");
                                navigate("materials");
                              }}
                            >
                              <span className="file-icon">
                                <FileText size={19} />
                              </span>
                              <span className="source-name">
                                <strong>{item.title}</strong>
                                <small>
                                  {sourceKind[item.kind]} · v
                                  {currentVersion(item).number}
                                </small>
                              </span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          icon={<BookOpen size={25} />}
                          title="资料会从这里汇聚"
                        >
                          添加后可以查看原文、版本，以及依赖它的结论。
                        </Empty>
                      )}
                      <div className="panel-footnote">
                        <ShieldCheck size={14} />
                        保留来源版本，方便之后核对
                      </div>
                    </section>
                  </div>
                  <section className="panel activity-panel">
                    <details>
                      <summary>
                        <span>
                          <History size={18} />
                          最近记录
                        </span>
                        <ChevronDown size={17} />
                      </summary>
                      <ol className="activity-list">
                        {project.activity
                          .slice(-8)
                          .reverse()
                          .map((item) => (
                            <li key={item.id}>
                              <span className="activity-dot" />
                              <p>{item.message}</p>
                              <time dateTime={item.at}>
                                {formatDate(item.at)}{" "}
                                {new Date(item.at).toLocaleTimeString("zh-CN", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </time>
                            </li>
                          ))}
                        {project.activity.length === 0 && (
                          <li className="muted">还没有操作记录。</li>
                        )}
                      </ol>
                    </details>
                  </section>
                </>
              )}
              {page === "analysis" && workspace && (
                <AnalysisPanel
                  key={project.id}
                  project={project}
                  workspace={workspace}
                  onWorkspace={(state) =>
                    setWorkspace((previous) =>
                      previous && previous.revision > state.revision
                        ? previous
                        : state,
                    )
                  }
                  onEvidence={viewEvidence}
                  onAddSource={() => openModal("source")}
                />
              )}
              {page === "materials" && (
                <div className="materials-grid">
                  <section className="panel source-browser">
                    <div className="panel-heading">
                      <h2>
                        资料库{" "}
                        <span className="count">{project.sources.length}</span>
                      </h2>
                    </div>
                    {project.sources.map(sourceButton)}
                    {!project.sources.length && (
                      <Empty
                        icon={<FileText size={25} />}
                        title="先保存一份资料"
                      >
                        支持粘贴文字，不会上传或解析原始文件。
                      </Empty>
                    )}
                  </section>
                  <div className="materials-main">
                    {source && visibleVersion && (
                      <section className="panel source-reader">
                        <div className="panel-heading wrap">
                          <div>
                            <div className="inline">
                              <h2>{source.title}</h2>
                              <Badge
                                tone={
                                  visibleVersion.id === source.currentVersionId
                                    ? "blue"
                                    : "amber"
                                }
                              >
                                {visibleVersion.id === source.currentVersionId
                                  ? "当前版本"
                                  : "历史版本"}
                              </Badge>
                            </div>
                            <p className="muted small">
                              {sourceKind[source.kind]} · 保存于{" "}
                              {formatDate(visibleVersion.createdAt)}
                            </p>
                          </div>
                          <div className="inline">
                            <label className="sr-only" htmlFor="source-version">
                              查看资料版本
                            </label>
                            <select
                              id="source-version"
                              className="version-select"
                              value={visibleVersion.id}
                              onChange={(event) =>
                                setSelectedVersionId(event.target.value)
                              }
                            >
                              {[...source.versions].reverse().map((version) => (
                                <option key={version.id} value={version.id}>
                                  v{version.number}
                                  {version.id === source.currentVersionId
                                    ? " · 最新"
                                    : " · 历史"}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="button secondary small-button"
                              onClick={() =>
                                openModal("update", {
                                  sourceId: source.id,
                                  content: currentVersion(source).content,
                                })
                              }
                            >
                              <GitBranch size={15} />
                              更新资料
                            </button>
                          </div>
                        </div>
                        <div className="plain-content source-content">
                          {visibleVersion.content}
                        </div>
                        <SourceVersionCompare
                          key={`${source.id}-${visibleVersion.id}`}
                          source={source}
                          visibleVersionId={visibleVersion.id}
                        />
                      </section>
                    )}
                    <section className="panel claims-panel">
                      <div className="panel-heading wrap">
                        <div>
                          <h2>
                            结论与依据{" "}
                            <span className="count">
                              {project.claims.length}
                            </span>
                          </h2>
                          <p className="muted small">
                            手工记录并关联来源，不等于系统已验证结论。
                          </p>
                        </div>
                        <button
                          className="button secondary small-button"
                          onClick={() =>
                            openModal("claim", { sourceId: source?.id ?? "" })
                          }
                          disabled={!project.sources.length}
                        >
                          <Plus size={15} />
                          记录结论
                        </button>
                      </div>
                      {project.claims.length ? (
                        project.claims.map((claim, index) => (
                          <article className="claim-card" key={claim.id}>
                            <div className="claim-number">
                              {String(index + 1).padStart(2, "0")}
                            </div>
                            <div className="claim-body">
                              <div className="claim-heading">
                                <h3>{claim.text}</h3>
                                <Badge
                                  tone={
                                    claim.status === "needs_review"
                                      ? "amber"
                                      : "blue"
                                  }
                                >
                                  {claim.status === "needs_review"
                                    ? "待复核"
                                    : claim.revisions?.length
                                      ? "已人工复核"
                                      : "已关联依据"}
                                </Badge>
                              </div>
                              {claim.evidence.map((evidence, evidenceIndex) => {
                                const linkedSource = project.sources.find(
                                  (item) => item.id === evidence.sourceId,
                                );
                                const version = linkedSource?.versions.find(
                                  (item) => item.id === evidence.versionId,
                                );
                                return (
                                  <button
                                    key={`${evidence.sourceId}-${evidenceIndex}`}
                                    className="evidence-link"
                                    onClick={() =>
                                      viewEvidence(
                                        evidence.sourceId,
                                        evidence.versionId,
                                        {
                                          locator: evidence.locator,
                                          claimId: claim.id,
                                        },
                                      )
                                    }
                                  >
                                    <Link2 size={13} />
                                    <span>
                                      {linkedSource?.title ?? "来源"} · v
                                      {version?.number ?? "?"} ·{" "}
                                      {evidence.locator}
                                      {linkedSource?.currentVersionId !==
                                        evidence.versionId && "（旧版依据）"}
                                    </span>
                                    <ArrowRight size={13} />
                                  </button>
                                );
                              })}
                              {claim.status === "needs_review" && (
                                <p className="warning-text">
                                  来源已更新，原引用保留。请对照新旧版本核对后，再决定下一步。
                                </p>
                              )}
                              {reviewButton(
                                "claim",
                                claim,
                                claim.status === "needs_review",
                              )}
                              <button
                                type="button"
                                className="text-button"
                                onClick={() =>
                                  openModal("task", {
                                    claimIds: [claim.id],
                                    title:
                                      claim.status === "needs_review"
                                        ? `复核：${claim.text.slice(0, 60)}`
                                        : "",
                                  })
                                }
                              >
                                转成行动
                                <ArrowRight size={13} />
                              </button>
                            </div>
                          </article>
                        ))
                      ) : (
                        <Empty
                          icon={<SearchCheck size={26} />}
                          title="让一个发现有据可查"
                        >
                          添加资料后，写下结论并标明出处。资料更新时，关联会帮助你找出需要复核的内容。
                        </Empty>
                      )}
                    </section>
                  </div>
                </div>
              )}
              {page === "actions" && (
                <>
                  <div className="action-summary">
                    <span>
                      <strong>{project.tasks.length}</strong> 全部行动
                    </span>
                    <span>
                      <strong>{activeTasks.length}</strong> 待推进
                    </span>
                    <span>
                      <strong>
                        {
                          project.tasks.filter((task) => task.reviewRequired)
                            .length
                        }
                      </strong>{" "}
                      待复核
                    </span>
                  </div>
                  <section className="panel action-panel">
                    {project.tasks.length ? (
                      project.tasks.map((task) => taskCard(task))
                    ) : (
                      <Empty
                        icon={<CheckCircle2 size={30} />}
                        title="从一件具体的事开始"
                        action={
                          <button
                            className="button primary"
                            onClick={() => openModal("task")}
                          >
                            <Plus size={16} />
                            添加行动
                          </button>
                        }
                      >
                        把“还需要知道什么”写成行动，并关联到对应的研究结论。
                      </Empty>
                    )}
                  </section>
                  <p className="page-note">
                    <ShieldCheck size={15} />
                    任务进度由你决定。来源变化会提醒复核，不会自动完成或重排工作。
                  </p>
                  <PlanningPanel
                    key={project.id}
                    project={project}
                    workspace={workspace!}
                    onWorkspace={(state) =>
                      setWorkspace((previous) =>
                        previous && previous.revision > state.revision
                          ? previous
                          : state,
                      )
                    }
                    onNotice={setNotice}
                  />
                </>
              )}
              {page === "artifacts" && (
                <>
                  <div className="info-strip">
                    <FileText size={17} />
                    <span>
                      先完善草稿与依据，再预览并保存报告版本。核查提示会随文件保留，PDF
                      使用电脑已有浏览器生成。
                    </span>
                  </div>
                  {project.artifacts.length ? (
                    <div className="artifact-grid">
                      {project.artifacts.map(artifactCard)}
                    </div>
                  ) : (
                    <section className="panel">
                      <Empty
                        icon={<FileCheck2 size={30} />}
                        title="将零散发现，整理成一份成果"
                        action={
                          <button
                            className="button primary"
                            onClick={() => openModal("artifact")}
                          >
                            <Plus size={16} />
                            建立第一份草稿
                          </button>
                        }
                      >
                        从一段真实的分析开始，关联它所使用的结论与资料。
                      </Empty>
                    </section>
                  )}
                  <ReportPanel
                    key={project.id}
                    project={project}
                    workspace={workspace!}
                    onWorkspace={(state) =>
                      setWorkspace((current) =>
                        !current || state.revision >= current.revision
                          ? state
                          : current,
                      )
                    }
                    onNotice={setNotice}
                    onEvidence={viewEvidence}
                  />
                </>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>行简 · 让研究有据，行动有序</span>
            <span>第五阶段 · 依据核对版</span>
          </footer>
        </main>
      </div>
      {reviewTarget && project && workspace && (
        <ReviewDialog
          key={`${reviewTarget.kind}-${reviewTarget.entityId}`}
          project={project}
          workspace={workspace}
          target={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onSwitch={setReviewTarget}
          onWorkspace={(state) =>
            setWorkspace((previous) =>
              previous && previous.revision > state.revision ? previous : state,
            )
          }
          onComplete={setNotice}
          onEvidence={viewEvidence}
        />
      )}
      {workTaskId && project && workspace && (
        <TaskWorkDialog
          key={workTaskId}
          project={project}
          workspace={workspace}
          taskId={workTaskId}
          onClose={() => setWorkTaskId(null)}
          onWorkspace={(state) =>
            setWorkspace((previous) =>
              previous && previous.revision > state.revision ? previous : state,
            )
          }
          onNotice={setNotice}
          onEvidence={viewEvidence}
        />
      )}
      {modal && (
        <dialog
          ref={dialogRef}
          className={`modal ${preview ? "modal-wide" : ""}`}
          aria-labelledby="modal-title"
          onCancel={(event) => {
            event.preventDefault();
            closeModal();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const bounds = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
              )
                closeModal();
            }
          }}
        >
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  {modal === "update"
                    ? "先看影响，再确认保存"
                    : "把研究向前推进一步"}
                </span>
                <h2 id="modal-title">
                  {
                    {
                      project: "建立一个研究项目",
                      source: "添加研究资料",
                      claim: "记录结论与依据",
                      task: "添加一项行动",
                      artifact: "建立成果草稿",
                      update: preview ? "确认这次资料变更" : "更新资料内容",
                    }[modal]
                  }
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                onClick={closeModal}
                type="button"
                disabled={busy}
              >
                <X size={21} />
              </button>
            </div>
            <div className="modal-body">
              <fieldset className="form-fields" disabled={busy}>
                {modal === "project" && (
                  <>
                    <Field label="项目名称">
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={fields.title}
                        onChange={(event) =>
                          updateField("title", event.target.value)
                        }
                        placeholder="例如：校园公共空间节能研究"
                      />
                    </Field>
                    <Field
                      label="研究目标"
                      hint="写清楚想解决什么问题，之后可以围绕它整理资料与行动。"
                    >
                      <textarea
                        required
                        maxLength={2000}
                        rows={3}
                        value={fields.goal}
                        onChange={(event) =>
                          updateField("goal", event.target.value)
                        }
                        placeholder="这项研究希望回答什么问题？"
                      />
                    </Field>
                    <Field label="截止日期（选填）">
                      <input
                        type="date"
                        value={fields.deadline}
                        onChange={(event) =>
                          updateField("deadline", event.target.value)
                        }
                      />
                    </Field>
                  </>
                )}
                {modal === "source" && (
                  <>
                    <Field label="资料标题">
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={fields.title}
                        onChange={(event) =>
                          updateField("title", event.target.value)
                        }
                        placeholder="例如：第一周教室用电记录"
                      />
                    </Field>
                    <Field label="资料类型">
                      <select
                        value={fields.kind}
                        onChange={(event) =>
                          updateField(
                            "kind",
                            event.target.value as Source["kind"],
                          )
                        }
                      >
                        {Object.entries(sourceKind).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="资料文字"
                      hint="粘贴你有权使用的内容。当前仅保存纯文本，不解析文件，也不会执行其中代码。"
                    >
                      <textarea
                        required
                        rows={8}
                        maxLength={100000}
                        value={fields.content}
                        onChange={(event) =>
                          updateField("content", event.target.value)
                        }
                        placeholder="粘贴资料，并保留页码、表头、单位等便于核对的信息…"
                      />
                    </Field>
                  </>
                )}
                {modal === "claim" && (
                  <>
                    <Field label="结论或待核查的发现">
                      <textarea
                        autoFocus
                        required
                        rows={3}
                        maxLength={4000}
                        value={fields.content}
                        onChange={(event) =>
                          updateField("content", event.target.value)
                        }
                        placeholder="写下你的发现，不确定的部分也可以明确记录。"
                      />
                    </Field>
                    <Field
                      label="关联资料"
                      hint="保存时关联所选资料的当前版本。"
                    >
                      <select
                        required
                        value={fields.sourceId}
                        onChange={(event) =>
                          updateField("sourceId", event.target.value)
                        }
                      >
                        <option value="" disabled>
                          请选择资料
                        </option>
                        {project?.sources.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.title} · v{currentVersion(item).number}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="原文位置"
                      hint="例如：第 2 段，或表 1 第 3–5 行。此位置由你填写，系统不会自动校验。"
                    >
                      <input
                        required
                        maxLength={240}
                        value={fields.locator}
                        onChange={(event) =>
                          updateField("locator", event.target.value)
                        }
                        placeholder="写清楚在资料的什么位置"
                      />
                    </Field>
                    <div className="info-strip">
                      <Link2 size={16} />
                      <span>关联表示记录了出处，不代表结论已验证正确。</span>
                    </div>
                  </>
                )}
                {modal === "task" && (
                  <>
                    <Field label="具体要做什么">
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={fields.title}
                        onChange={(event) =>
                          updateField("title", event.target.value)
                        }
                        placeholder="例如：核对第二周用电量的统计范围"
                      />
                    </Field>
                    {claimPicker()}
                  </>
                )}
                {modal === "artifact" && (
                  <>
                    <Field label="草稿标题">
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={fields.title}
                        onChange={(event) =>
                          updateField("title", event.target.value)
                        }
                        placeholder="例如：校园节能研究 · 阶段发现"
                      />
                    </Field>
                    <Field
                      label="草稿内容"
                      hint="写下已经确认的内容；没有实验或资料支持的部分，保留缺口说明。"
                    >
                      <textarea
                        required
                        rows={8}
                        maxLength={100000}
                        value={fields.content}
                        onChange={(event) =>
                          updateField("content", event.target.value)
                        }
                        placeholder="记录你的研究内容…"
                      />
                    </Field>
                    {claimPicker()}
                  </>
                )}
                {modal === "update" && !preview && (
                  <>
                    <p className="modal-intro">
                      修改后先预览影响。确认保存才会建立新版本；旧资料和原有引用会保留。
                    </p>
                    <Field label="更新后的资料内容">
                      <textarea
                        autoFocus
                        required
                        rows={12}
                        maxLength={100000}
                        value={fields.content}
                        onChange={(event) =>
                          updateField("content", event.target.value)
                        }
                      />
                    </Field>
                  </>
                )}
                {modal === "update" && preview && (
                  <>
                    <div
                      className={`preview-summary ${preview.hasChanges ? "" : "unchanged"}`}
                    >
                      <GitBranch size={23} />
                      <div>
                        <h3>
                          {preview.hasChanges
                            ? `${preview.sourceTitle} → v${preview.nextVersionNumber}`
                            : "内容没有变化"}
                        </h3>
                        <p>
                          {preview.hasChanges
                            ? "以下内容会标记为待复核，任务进度与原文不会被覆盖。"
                            : "本次不会新增版本。可以返回继续编辑，或关闭对话框。"}
                        </p>
                      </div>
                    </div>
                    <TextDiff
                      label="保存前资料差异"
                      before={preview.previousContent}
                      after={preview.nextContent}
                      beforeLabel="当前内容"
                      afterLabel="修改后内容"
                    />
                    <div className="impact-groups">
                      {[
                        { title: "关联结论", items: preview.claims },
                        { title: "关联行动", items: preview.tasks },
                        { title: "关联草稿", items: preview.artifacts },
                      ].map((group) => (
                        <section key={group.title}>
                          <h3>
                            {group.title}
                            <Badge
                              tone={group.items.length ? "amber" : "neutral"}
                            >
                              {group.items.length} 项
                            </Badge>
                          </h3>
                          {group.items.length ? (
                            group.items.map((item) => (
                              <article key={item.id}>
                                <strong>{item.title}</strong>
                                <p>{item.reason}</p>
                              </article>
                            ))
                          ) : (
                            <p className="muted small">
                              没有已建立关联的内容。
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                    <p className="page-note">
                      <TriangleAlert size={16} />
                      此预览只追踪已建立的来源关系，不会发现所有语义影响，也不会替你核对新结论。
                    </p>
                  </>
                )}
              </fieldset>
              {formError && (
                <div className="form-error" role="alert">
                  <TriangleAlert size={17} />
                  <span>{formError}</span>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  if (preview) {
                    setPreview(null);
                    setPreviewRevision(null);
                    setFormError("");
                  } else closeModal();
                }}
              >
                {preview ? "返回编辑" : "取消"}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={
                  busy ||
                  (modal === "update" && !!preview && !preview.hasChanges) ||
                  (modal === "claim" && !project?.sources.length)
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : modal === "update" ? (
                  <GitBranch size={16} />
                ) : (
                  <Check size={16} />
                )}
                {busy
                  ? "正在处理…"
                  : modal === "update"
                    ? preview
                      ? "确认保存新版本"
                      : "预览变更影响"
                    : modal === "project"
                      ? "建立项目"
                      : "保存"}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {evidenceTarget && project && (
        <EvidenceDialog
          key={`${project.id}-${JSON.stringify(evidenceTarget)}`}
          project={project}
          target={evidenceTarget}
          onClose={() => setEvidenceTarget(null)}
        />
      )}
    </div>
  );
}
