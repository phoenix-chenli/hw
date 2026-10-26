import { randomUUID } from "node:crypto";
import {
  analyze,
  isAnalysisStale,
  validateAnalysisRun,
  tableCatalog,
  AnalysisError,
} from "./analysis.mjs";
import {
  ReviewError,
  validateReviewHistory,
  buildReviewPreview,
  applyEntityReview,
} from "./review.mjs";

import {
  PlanningError,
  validatePlanningState,
  buildPlanPreview,
  applyPlanningCommand,
} from "./planning.mjs";
import {
  ReportError,
  buildReportPreview,
  saveReport,
  validateReports,
  getReport,
} from "./reports.mjs";
import {
  AgentProtocolError,
  createAgentRun,
  acceptAgentRun,
  transitionAgentRun,
  validateAgentRuns,
} from "./agent-protocol.mjs";

const LIMITS = Object.freeze({
  id: 160,
  title: 120,
  goal: 2000,
  text: 4000,
  content: 100000,
  locator: 240,
  message: 1000,
});
const COMMANDS = new Set([
  "create_project",
  "load_demo",
  "add_source",
  "add_claim",
  "add_task",
  "add_artifact",
  "update_source",
  "set_task_status",
  "run_analysis",
  "accept_analysis",
  "create_agent_run",
  "accept_agent_run",
  "review_claim",
  "review_task",
  "review_artifact",
  "save_checkpoint",
  "add_busy_slot",
  "deactivate_busy_slot",
  "confirm_plan",
  "cancel_plan",
  "save_report",
]);

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, code = "INVALID_INPUT", status = 400) {
  throw new DomainError(code, message, status);
}

function record(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(`${label}格式无效。`);
  return value;
}

function string(value, label, limit = LIMITS.id) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    fail(`${label}不能为空，且不能超过 ${limit} 个字符。`);
  return value.trim();
}

function identifier(value, label) {
  const normalized = string(value, label);
  if (normalized !== value) fail(`${label}不能包含首尾空白。`);
  return normalized;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label}必须是数组。`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label}无效。`);
  return value;
}

function deadline(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
    fail("截止日期应为有效的 YYYY-MM-DD 日期或 null。");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    fail("截止日期不是有效的日历日期。");
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") fail(`${label}无效。`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    fail(`${label}必须是有效的 UTC 时间。`);
  return value;
}

function number(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label}无效。`);
}

function bool(value, label) {
  if (typeof value !== "boolean") fail(`${label}必须是布尔值。`);
}

function ids(value, available, label) {
  const values = array(value, label).map((id) => identifier(id, label));
  if (new Set(values).size !== values.length) fail(`${label}不能重复。`);
  if (values.some((id) => !available.has(id)))
    fail(`${label}包含不存在或不属于该项目的记录。`);
  return values;
}

function evidence(value, sources) {
  const values = array(value, "依据");
  if (values.length === 0) fail("结论至少需要关联一条依据。");
  const seen = new Set();
  return values.map((entry) => {
    record(entry, "依据");
    const sourceId = identifier(entry.sourceId, "资料 ID");
    const versionId = identifier(entry.versionId, "资料版本 ID");
    const locator = string(entry.locator, "依据位置", LIMITS.locator);
    const source = sources.get(sourceId);
    if (!source || !source.versions.some((version) => version.id === versionId))
      fail("依据必须引用该项目已有资料的有效版本。");
    const key = JSON.stringify([sourceId, versionId, locator]);
    if (seen.has(key)) fail("依据条目不能重复。");
    seen.add(key);
    return { sourceId, versionId, locator };
  });
}

export function emptyWorkspace() {
  return { schemaVersion: 1, revision: 0, projects: [] };
}

/** Validate every stored relationship, including references to retained old versions. */
export function validateWorkspace(state) {
  try {
    record(state, "工作区");
    if (state.schemaVersion !== 1) fail("不支持此工作区版本。");
    number(state.revision, "工作区修订号", 0);
    const allIds = new Set();
    const register = (value, label) => {
      const id = identifier(value, label);
      if (allIds.has(id)) fail(`${label}包含重复 ID。`);
      allIds.add(id);
    };
    for (const project of array(state.projects, "项目")) {
      record(project, "项目");
      register(project.id, "项目 ID");
      identifier(project.ownerId, "所有者 ID");
      string(project.title, "项目标题", LIMITS.title);
      string(project.goal, "项目目标", LIMITS.goal);
      deadline(project.deadline);
      timestamp(project.createdAt, "创建时间");
      bool(project.isDemo, "示例标记");
      const sourceMap = new Map();
      for (const source of array(project.sources, "资料")) {
        record(source, "资料");
        register(source.id, "资料 ID");
        string(source.title, "资料标题", LIMITS.title);
        enumValue(source.kind, ["note", "table", "document"], "资料类型");
        const versions = array(source.versions, "资料版本");
        if (versions.length === 0) fail("资料必须至少保留一个版本。");
        for (const [index, version] of versions.entries()) {
          record(version, "资料版本");
          register(version.id, "版本 ID");
          if (version.number !== index + 1)
            fail("资料版本号必须按顺序连续递增。");
          string(version.content, "资料内容", LIMITS.content);
          timestamp(version.createdAt, "版本创建时间");
        }
        if (source.currentVersionId !== versions.at(-1).id)
          fail("资料当前版本必须指向最后一个保留版本。");
        sourceMap.set(source.id, source);
      }
      const claimMap = new Map();
      for (const claim of array(project.claims, "结论")) {
        record(claim, "结论");
        register(claim.id, "结论 ID");
        string(claim.text, "结论内容", LIMITS.text);
        enumValue(claim.status, ["linked", "needs_review"], "结论状态");
        evidence(claim.evidence, sourceMap);
        validateReviewHistory(project, claim, "claim");
        // Old references remain legitimate, but may not silently become current again.
        if (
          claim.status === "linked" &&
          claim.evidence.some(
            (entry) =>
              sourceMap.get(entry.sourceId).currentVersionId !==
              entry.versionId,
          )
        )
          fail("引用旧资料版本的结论必须标记为待核对。");
        claimMap.set(claim.id, claim);
      }
      for (const task of array(project.tasks, "任务")) {
        record(task, "任务");
        register(task.id, "任务 ID");
        string(task.title, "任务标题", LIMITS.title);
        const refs = ids(task.claimIds, claimMap, "任务关联结论");
        enumValue(task.status, ["todo", "doing", "done"], "任务状态");
        bool(task.reviewRequired, "任务待核对标记");
        validateReviewHistory(project, task, "task");
        if (
          !task.reviewRequired &&
          refs.some((id) => claimMap.get(id).status === "needs_review")
        )
          fail("关联待核对结论的任务必须保留提醒。");
      }
      for (const artifact of array(project.artifacts, "成果草稿")) {
        record(artifact, "成果草稿");
        register(artifact.id, "草稿 ID");
        string(artifact.title, "草稿标题", LIMITS.title);
        string(artifact.content, "草稿内容", LIMITS.content);
        const refs = ids(artifact.claimIds, claimMap, "草稿关联结论");
        enumValue(artifact.status, ["draft", "needs_review"], "草稿状态");
        validateReviewHistory(project, artifact, "artifact");
        if (
          artifact.status === "draft" &&
          refs.some((id) => claimMap.get(id).status === "needs_review")
        )
          fail("关联待核对结论的草稿必须标记为待核对。");
      }
      validatePlanningState(project, register);
      validateReports(project, register);
      validateAgentRuns(project, register);
      for (const entry of array(project.activity, "活动记录")) {
        record(entry, "活动记录");
        register(entry.id, "活动 ID");
        timestamp(entry.at, "活动时间");
        string(entry.message, "活动说明", LIMITS.message);
      }
      // Optional for backward compatibility with untouched phase-1 data files.
      const analyses = array(project.analyses ?? [], "分析记录");
      if (analyses.length > 100) fail("单个项目最多保留 100 次本地分析。");
      for (const run of analyses) {
        record(run, "分析记录");
        register(run.id, "分析 ID");
        timestamp(run.createdAt, "分析时间");
        validateAnalysisRun(project, run);
        if (run.acceptance) timestamp(run.acceptance.at, "分析确认时间");
      }
    }
    return state;
  } catch (error) {
    if (
      error instanceof DomainError ||
      error instanceof AnalysisError ||
      error instanceof ReviewError ||
      error instanceof PlanningError ||
      error instanceof ReportError ||
      error instanceof AgentProtocolError
    )
      throw new DomainError(
        "INVALID_STATE",
        `工作区数据无效：${error.message}`,
        400,
      );
    throw error;
  }
}

function ownedProject(state, ownerId, projectId) {
  identifier(ownerId, "所有者 ID");
  identifier(projectId, "项目 ID");
  const project = state.projects.find(
    (entry) => entry.id === projectId && entry.ownerId === ownerId,
  );
  if (!project) fail("项目不存在或无权访问。", "NOT_FOUND", 404);
  return project;
}

/** Called only by the trusted local run manager, never exposed as a command. */
export function applyAgentRunTransition(state, ownerId, projectId, runId, transition, options = {}) {
  validateWorkspace(state);
  const next = structuredClone(state);
  const project = ownedProject(next, ownerId, projectId);
  const run = project.agentRuns?.find(entry => entry.id === runId);
  if (!run) fail("运行不存在或不属于此项目。", "NOT_FOUND", 404);
  transitionAgentRun(project, run, transition, context(options).now);
  next.revision += 1;
  validateWorkspace(next);
  return next;
}

function findSource(project, sourceId) {
  identifier(sourceId, "资料 ID");
  const source = project.sources.find((entry) => entry.id === sourceId);
  if (!source) fail("资料不存在或不属于此项目。", "NOT_FOUND", 404);
  return source;
}

export function previewTableCatalog(state, ownerId, projectId, sourceId) {
  const project = ownedProject(state, ownerId, projectId);
  return tableCatalog(project, sourceId);
}

export function previewReview(state, ownerId, projectId, kind, entityId) {
  validateWorkspace(state);
  const project = ownedProject(state, ownerId, projectId);
  return buildReviewPreview(project, kind, entityId);
}

export function previewPlan(state, ownerId, projectId, request) {
  validateWorkspace(state);
  return buildPlanPreview(
    state,
    ownedProject(state, ownerId, projectId),
    request,
  );
}

export function previewReport(state, ownerId, projectId, request) {
  validateWorkspace(state);
  return buildReportPreview(ownedProject(state, ownerId, projectId), request);
}

export function savedReport(state, ownerId, projectId, reportId) {
  const project = ownedProject(state, ownerId, projectId);
  return getReport(project, reportId);
}

function impactFor(project, source, nextContent) {
  const currentVersion = source.versions.at(-1);
  const claims = project.claims.filter((claim) =>
    claim.evidence.some((entry) => entry.sourceId === source.id),
  );
  const claimIds = new Set(claims.map((entry) => entry.id));
  const affected = (entity) => entity.claimIds.some((id) => claimIds.has(id));
  return {
    projectId: project.id,
    sourceId: source.id,
    sourceTitle: source.title,
    baseVersionId: source.currentVersionId,
    nextVersionNumber: currentVersion.number + 1,
    previousContent: currentVersion.content,
    nextContent,
    claims: claims.map((claim) => ({
      id: claim.id,
      title: claim.text,
      reason: "引用了此资料；更新后需人工核对原结论。",
    })),
    tasks: project.tasks.filter(affected).map((task) => ({
      id: task.id,
      title: task.title,
      reason: "关联结论受到资料变更影响；保留任务进度并提醒核对。",
    })),
    artifacts: project.artifacts.filter(affected).map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      reason: "引用了受影响结论；草稿内容不会被自动改写。",
    })),
    hasChanges: currentVersion.content.trim() !== nextContent,
  };
}

export function previewSourceUpdate(
  state,
  ownerId,
  projectId,
  sourceId,
  nextContent,
) {
  validateWorkspace(state);
  const project = ownedProject(state, ownerId, projectId);
  const source = findSource(project, sourceId);
  const content = string(nextContent, "资料内容", LIMITS.content);
  const preview = impactFor(project, source, content);
  if (!preview.hasChanges)
    fail("资料内容没有变化，无需创建新版本。", "NO_CHANGES");
  return preview;
}

function context(options) {
  const rawTime =
    typeof options.now === "function"
      ? options.now()
      : (options.now ?? new Date());
  const now = rawTime instanceof Date ? rawTime.toISOString() : rawTime;
  timestamp(now, "操作时间");
  return {
    now,
    id: (kind) =>
      identifier(
        typeof options.id === "function"
          ? options.id(kind)
          : `${kind}_${randomUUID()}`,
        "新记录 ID",
      ),
  };
}

function newProject(ownerId, title, goal, due, ctx, isDemo = false) {
  return {
    id: ctx.id("project"),
    ownerId,
    title,
    goal,
    deadline: due,
    createdAt: ctx.now,
    isDemo,
    sources: [],
    claims: [],
    tasks: [],
    artifacts: [],
    activity: [],
  };
}

function newSource(title, kind, content, ctx) {
  const version = {
    id: ctx.id("version"),
    number: 1,
    content,
    createdAt: ctx.now,
  };
  return {
    id: ctx.id("source"),
    title,
    kind,
    currentVersionId: version.id,
    versions: [version],
  };
}

function addActivity(project, message, ctx) {
  project.activity.push({ id: ctx.id("activity"), at: ctx.now, message });
}

function demoProject(ownerId, ctx) {
  const project = newProject(
    ownerId,
    "校园节能研究 · 合成示例",
    "演示资料、结论、行动与成果之间的关联。所有数字及场景均为合成数据，不代表真实研究结果。",
    null,
    ctx,
    true,
  );
  const energy = newSource(
    "教室用电记录（合成样本）",
    "table",
    "仅供功能演示的合成数据，不代表实际用电。\n教室,示例日用电量(kWh)\nA教室,60\nB教室,45\n样本不足以推断真实节能效果。",
    ctx,
  );
  const hours = newSource(
    "资料室开放时间（合成样本）",
    "note",
    "仅供功能演示的合成信息：示例资料室周六 09:00–16:00 开放。该信息不是实际校园服务公告。",
    ctx,
  );
  project.sources.push(energy, hours);
  const energyClaim = {
    id: ctx.id("claim"),
    text: "合成样本中，A 教室示例用电量高于 B 教室；仍需补充实际数据才能研究原因。",
    evidence: [
      {
        sourceId: energy.id,
        versionId: energy.currentVersionId,
        locator: "表格第 2–3 行；仅合成样本",
      },
    ],
    status: "linked",
  };
  const hoursClaim = {
    id: ctx.id("claim"),
    text: "合成样例中，资料室周六开放时间为 09:00–16:00。",
    evidence: [
      {
        sourceId: hours.id,
        versionId: hours.currentVersionId,
        locator: "第 1 段；仅合成样本",
      },
    ],
    status: "linked",
  };
  project.claims.push(energyClaim, hoursClaim);
  project.tasks.push(
    {
      id: ctx.id("task"),
      title: "整理示例教室用电表",
      claimIds: [energyClaim.id],
      status: "done",
      reviewRequired: false,
    },
    {
      id: ctx.id("task"),
      title: "补充实际采样方案",
      claimIds: [energyClaim.id],
      status: "todo",
      reviewRequired: false,
    },
    {
      id: ctx.id("task"),
      title: "核对资料室周末开放时间",
      claimIds: [hoursClaim.id],
      status: "todo",
      reviewRequired: false,
    },
  );
  project.artifacts.push(
    {
      id: ctx.id("artifact"),
      title: "用电研究草稿（演示）",
      content:
        "本草稿仅展示资料关联。合成样本中 A 教室示例用电量较高；不能据此形成真实节能结论，需采集实际数据并核对条件。",
      claimIds: [energyClaim.id],
      status: "draft",
    },
    {
      id: ctx.id("artifact"),
      title: "资料查阅准备（演示）",
      content: "周末查阅时间暂参照合成开放时间记录；实际出行前需核实公告。",
      claimIds: [hoursClaim.id],
      status: "draft",
    },
  );
  addActivity(
    project,
    "载入合成示例。示例数据不代表实际研究结果，已关联依据也不代表结论正确。",
    ctx,
  );
  return project;
}

export function applyCommand(state, ownerId, type, payload, options = {}) {
  validateWorkspace(state);
  const owner = identifier(ownerId, "所有者 ID");
  if (!COMMANDS.has(type)) fail("不支持此操作。", "UNKNOWN_COMMAND");
  record(payload, "操作参数");
  const ctx = context(options);
  const next = structuredClone(state);
  let project;
  let entityId;
  if (type === "create_project") {
    project = newProject(
      owner,
      string(payload.title, "项目标题", LIMITS.title),
      string(payload.goal, "项目目标", LIMITS.goal),
      deadline(payload.deadline),
      ctx,
    );
    addActivity(project, "创建项目。", ctx);
    next.projects.push(project);
  } else if (type === "load_demo") {
    project = demoProject(owner, ctx);
    next.projects.push(project);
  } else {
    project = ownedProject(next, owner, payload.projectId);
    const claimMap = new Map(project.claims.map((entry) => [entry.id, entry]));
    if (type === "create_agent_run") {
      const provider = enumValue(payload.provider, ["agentarts", "contract-test"], "运行来源");
      if (payload.authorizeCloud !== true && payload.authorizeCloud !== false)
        fail("请明确本次是否授权发送资料。");
      const run = createAgentRun(project, payload.request, {
        id: ctx.id("agent_run"), now: ctx.now, provider,
        authorizeCloud: payload.authorizeCloud,
      });
      (project.agentRuns ??= []).push(run);
      entityId = run.id;
      addActivity(project, "保存资料快照分析请求；结论和行动尚未写入。", ctx);
    } else if (type === "accept_agent_run") {
      acceptAgentRun(project, payload, ctx);
      entityId = payload.runId;
      addActivity(project, "逐项确认分析提案，保留原始建议、依据版本与运行记录。引用校验不代表结论已获证实。", ctx);
    } else if (type === "save_report") {
      const report = saveReport(project, payload, ctx);
      entityId = report.id;
      addActivity(
        project,
        `保存第 ${report.number} 份报告快照；保留资料版本与核查提示，不改变原草稿或任务进度。`,
        ctx,
      );
    } else if (
      [
        "save_checkpoint",
        "add_busy_slot",
        "deactivate_busy_slot",
        "confirm_plan",
        "cancel_plan",
      ].includes(type)
    ) {
      const result = applyPlanningCommand(next, project, type, payload, ctx);
      entityId = result.entityId;
      addActivity(project, result.message, ctx);
    } else if (
      ["review_claim", "review_task", "review_artifact"].includes(type)
    ) {
      const kind = type.slice("review_".length);
      const entity = applyEntityReview(project, kind, payload, ctx);
      entityId = entity.id;
      const label =
        kind === "claim" ? "结论" : kind === "task" ? "任务" : "草稿";
      addActivity(
        project,
        `逐项复核${label}并保存第 ${entity.revisions.at(-1).number} 个内容版本；${kind === "claim" ? "关联任务与草稿仍需各自核对" : kind === "task" ? "任务进度保持不变" : "保留原稿与修改说明"}。人工复核不等于自动验证正确性。`,
        ctx,
      );
    } else if (type === "run_analysis") {
      if ((project.analyses?.length ?? 0) >= 100)
        fail("单个项目最多保留 100 次分析，请另建项目。", "ANALYSIS_LIMIT");
      const result = analyze(project, payload.request);
      const run = {
        id: ctx.id("analysis"),
        createdAt: ctx.now,
        ...result,
        status: "pending",
        acceptance: null,
      };
      (project.analyses ??= []).push(run);
      entityId = run.id;
      addActivity(
        project,
        `保存本地分析提案：${result.output.claims.length} 条候选、${result.output.tasks.length} 项建议；尚未写入结论或行动。`,
        ctx,
      );
    } else if (type === "accept_analysis") {
      identifier(payload.analysisId, "分析 ID");
      const run = project.analyses?.find(
        (entry) => entry.id === payload.analysisId,
      );
      if (!run) fail("分析不存在或不属于此项目。", "NOT_FOUND", 404);
      if (run.status === "accepted")
        fail("此提案已经确认，不会重复写入。", "ALREADY_ACCEPTED", 409);
      if (isAnalysisStale(project, run))
        fail(
          "分析使用的资料已更新。请基于当前版本重新分析，再确认提案。",
          "ANALYSIS_STALE",
          409,
        );
      const selectedClaims = ids(
        payload.claimIds,
        new Set(run.output.claims.map((entry) => entry.id)),
        "候选结论",
      );
      const selectedTasks = ids(
        payload.taskIds,
        new Set(run.output.tasks.map((entry) => entry.id)),
        "建议行动",
      );
      if (!selectedClaims.length && !selectedTasks.length)
        fail("请至少选择一条结论或行动。");
      const candidates = run.output.tasks.filter((entry) =>
        selectedTasks.includes(entry.id),
      );
      if (
        candidates.some((entry) =>
          entry.claimIds.some((id) => !selectedClaims.includes(id)),
        )
      )
        fail("关联行动需要同时选中它所依据的结论。", "MISSING_DEPENDENCY");
      const acceptance = { at: ctx.now, claims: [], tasks: [] };
      for (const candidate of run.output.claims.filter((entry) =>
        selectedClaims.includes(entry.id),
      )) {
        const claim = {
          id: ctx.id("claim"),
          text: candidate.text,
          evidence: structuredClone(candidate.evidence),
          status: "linked",
        };
        project.claims.push(claim);
        acceptance.claims.push({
          candidateId: candidate.id,
          entityId: claim.id,
        });
      }
      for (const candidate of candidates) {
        const task = {
          id: ctx.id("task"),
          title: candidate.title,
          claimIds: candidate.claimIds.map(
            (id) =>
              acceptance.claims.find((ref) => ref.candidateId === id).entityId,
          ),
          status: "todo",
          reviewRequired: false,
        };
        project.tasks.push(task);
        acceptance.tasks.push({ candidateId: candidate.id, entityId: task.id });
      }
      run.status = "accepted";
      run.acceptance = acceptance;
      entityId = run.id;
      addActivity(
        project,
        `确认本地分析：加入 ${acceptance.claims.length} 条结论、${acceptance.tasks.length} 项行动；关联原资料版本。`,
        ctx,
      );
    } else if (type === "add_source") {
      const source = newSource(
        string(payload.title, "资料标题", LIMITS.title),
        enumValue(payload.kind, ["note", "table", "document"], "资料类型"),
        string(payload.content, "资料内容", LIMITS.content),
        ctx,
      );
      project.sources.push(source);
      entityId = source.id;
      addActivity(project, `添加资料「${source.title}」，保存第 1 版。`, ctx);
    } else if (type === "add_claim") {
      const refs = evidence(
        payload.evidence,
        new Map(project.sources.map((entry) => [entry.id, entry])),
      );
      const needsReview = refs.some(
        (ref) =>
          project.sources.find((entry) => entry.id === ref.sourceId)
            .currentVersionId !== ref.versionId,
      );
      const claim = {
        id: ctx.id("claim"),
        text: string(payload.text, "结论内容", LIMITS.text),
        evidence: refs,
        status: needsReview ? "needs_review" : "linked",
      };
      project.claims.push(claim);
      entityId = claim.id;
      addActivity(
        project,
        needsReview
          ? "添加结论并关联历史资料版本，已标记待核对。"
          : "添加结论并关联依据；尚未验证结论正确性。",
        ctx,
      );
    } else if (type === "add_task") {
      const refs = ids(payload.claimIds, claimMap, "任务关联结论");
      const task = {
        id: ctx.id("task"),
        title: string(payload.title, "任务标题", LIMITS.title),
        claimIds: refs,
        status: "todo",
        reviewRequired: refs.some(
          (id) => claimMap.get(id).status === "needs_review",
        ),
      };
      project.tasks.push(task);
      entityId = task.id;
      addActivity(project, `添加任务「${task.title}」。`, ctx);
    } else if (type === "add_artifact") {
      const refs = ids(payload.claimIds, claimMap, "草稿关联结论");
      const artifact = {
        id: ctx.id("artifact"),
        title: string(payload.title, "草稿标题", LIMITS.title),
        content: string(payload.content, "草稿内容", LIMITS.content),
        claimIds: refs,
        status: refs.some((id) => claimMap.get(id).status === "needs_review")
          ? "needs_review"
          : "draft",
      };
      project.artifacts.push(artifact);
      entityId = artifact.id;
      addActivity(
        project,
        `保存成果草稿「${artifact.title}」；未生成正式报告。`,
        ctx,
      );
    } else if (type === "update_source") {
      const source = findSource(project, payload.sourceId);
      const baseVersion = identifier(payload.baseVersionId, "预览基准版本");
      if (source.currentVersionId !== baseVersion)
        fail(
          "资料版本已变化，请刷新并重新预览后确认。",
          "VERSION_CONFLICT",
          409,
        );
      const content = string(payload.content, "资料内容", LIMITS.content);
      const preview = impactFor(project, source, content);
      if (!preview.hasChanges)
        fail("资料内容没有变化，无需创建新版本。", "NO_CHANGES");
      const version = {
        id: ctx.id("version"),
        number: preview.nextVersionNumber,
        content,
        createdAt: ctx.now,
      };
      source.versions.push(version);
      source.currentVersionId = version.id;
      const claimIds = new Set(preview.claims.map((entry) => entry.id));
      const taskIds = new Set(preview.tasks.map((entry) => entry.id));
      const artifactIds = new Set(preview.artifacts.map((entry) => entry.id));
      project.claims.forEach((entry) => {
        if (claimIds.has(entry.id)) entry.status = "needs_review";
      });
      project.tasks.forEach((entry) => {
        if (taskIds.has(entry.id)) entry.reviewRequired = true;
      });
      project.artifacts.forEach((entry) => {
        if (artifactIds.has(entry.id)) entry.status = "needs_review";
      });
      entityId = source.id;
      addActivity(
        project,
        `确认资料「${source.title}」第 ${version.number} 版：${preview.claims.length} 条结论、${preview.tasks.length} 项任务、${preview.artifacts.length} 份草稿需核对。历史版本与原依据引用已保留。`,
        ctx,
      );
    } else if (type === "set_task_status") {
      identifier(payload.taskId, "任务 ID");
      const task = project.tasks.find((entry) => entry.id === payload.taskId);
      if (!task) fail("任务不存在或不属于此项目。", "NOT_FOUND", 404);
      const status = enumValue(
        payload.status,
        ["todo", "doing", "done"],
        "任务状态",
      );
      if (task.status === status) fail("任务状态没有变化。", "NO_CHANGES");
      task.status = status;
      entityId = task.id;
      addActivity(
        project,
        `手动更新任务「${task.title}」状态${task.reviewRequired ? "；资料变更的待核对提醒仍保留" : ""}。`,
        ctx,
      );
    }
  }
  next.revision += 1;
  validateWorkspace(next);
  return {
    state: next,
    result: { projectId: project.id, ...(entityId ? { entityId } : {}) },
  };
}
