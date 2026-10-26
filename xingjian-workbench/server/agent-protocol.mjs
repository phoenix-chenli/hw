import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lineRangeForSpan, splitTextLines } from "../shared/text-inspection.mjs";
import { originalContent } from "./review.mjs";

const SNAPSHOT = "xingjian.run-snapshot.v1";
const PROPOSAL = "xingjian.analysis-proposal.v1";
const INTENTS = ["research", "change_review", "planning", "draft"];
const STATUSES = ["queued", "running", "blocked", "needs_input", "proposal", "failed", "interrupted", "accepted"];
const TRANSITIONS = {
  queued: ["running", "blocked", "interrupted"],
  running: ["proposal", "needs_input", "failed", "interrupted"],
  proposal: ["accepted"],
};
const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Exact UTF-16 bytes distinguish every stored code unit, including lone surrogates.
const contentHash = (value) => createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex");
export class AgentProtocolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AgentProtocolError";
    this.code = code;
    this.status = status;
  }
}
const fail = (message, code = "INVALID_AGENT_PROTOCOL", status = 400) => {
  throw new AgentProtocolError(code, message, status);
};
function record(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(`${label}格式无效。`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    fail(`${label}字段不符合协议。`);
  return value;
}
function text(value, max, label, trim = false) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${label}不能为空，且不能超过 ${max} 个字符。`);
  return trim ? value.trim() : value;
}
function id(value, label = "记录 ID", max = 160) {
  text(value, max, label);
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}无效。`);
  return value;
}
function candidateId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail("候选 ID 无效。");
  return value;
}
function list(value, max, label, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label}数量无效。`);
  return value;
}
function uniqueIds(value, max, label, min = 0, check = id) {
  const ids = list(value, max, label, min).map((entry) => check(entry, label));
  if (new Set(ids).size !== ids.length) fail(`${label}不能重复。`);
  return ids;
}
function timestamp(value, label = "运行时间") {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label}无效。`);
  return value;
}
function enumValue(value, values, label) {
  if (!values.includes(value)) fail(`${label}无效。`);
  return value;
}
function safeMessage(value, max = 1000) {
  text(value, max, "运行说明");
  // This is a final persistence boundary, not an error-string sanitizer. Providers
  // must use fixed safe messages rather than pass through endpoint responses.
  if (/https?:\/\/|\b(?:bearer|authorization|api[_-]?key)\b|\bsk-[a-z0-9_-]{8,}/iu.test(value))
    fail("运行说明含不应保存的连接或凭据信息。");
  return value;
}
function runError(value) {
  record(value, ["code", "message"], "运行错误");
  if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)) fail("运行错误代码无效。");
  return { code: value.code, message: safeMessage(value.message) };
}

export function normalizeAgentRequest(value) {
  record(value, ["intent", "question", "sourceIds"], "分析请求");
  return {
    intent: enumValue(value.intent, INTENTS, "分析意图"),
    question: text(value.question, 2000, "研究问题", true),
    sourceIds: uniqueIds(value.sourceIds, 6, "分析资料", 1),
  };
}

function snapshotFor(project, sourceIds, retained) {
  id(project.id, "项目 ID");
  let total = 0;
  const sourceRevisions = [], evidence = [];
  for (const [index, sourceId] of sourceIds.entries()) {
    const source = project.sources.find((entry) => entry.id === sourceId);
    if (!source) fail("分析资料不存在或不属于此项目。", "NOT_FOUND", 404);
    const ref = retained?.[index];
    if (retained && ref?.sourceId !== sourceId) fail("资料快照顺序无效。");
    const version = source.versions.find((entry) => entry.id === (ref?.versionId ?? source.currentVersionId));
    if (!version) fail("运行引用的资料版本未保留。");
    if (typeof version.content !== "string" || !version.content.length) fail("分析资料正文无效。");
    total += version.content.length;
    if (total > 20000) fail("单次云端请求最多包含 20,000 个 UTF-16 字符，请缩小资料范围。", "AGENT_INPUT_LIMIT");
    const digest = contentHash(version.content);
    sourceRevisions.push({
      sourceId: source.id,
      versionId: version.id,
      title: source.title,
      kind: source.kind,
      contentHash: digest,
    });
    const lines = splitTextLines(version.content);
    for (let start = 0; start < version.content.length;) {
      let end = Math.min(start + 1200, version.content.length);
      // Never split a surrogate pair or CRLF sequence between evidence chunks.
      if (end < version.content.length && ((/[\uD800-\uDBFF]/u.test(version.content[end - 1]) && /[\uDC00-\uDFFF]/u.test(version.content[end])) || (version.content[end - 1] === "\r" && version.content[end] === "\n"))) end--;
      const range = lineRangeForSpan(lines, start, end);
      const locator = `保留文本第 ${range.startLine}–${range.endLine} 行，UTF-16 字符 ${start + 1}–${end}（非原文件页码）`;
      evidence.push({
        id: `ev-${evidence.length + 1}`, sourceId: source.id, versionId: version.id,
        contentHash: digest, start, end, ...range,
        quote: version.content.slice(start, end), locator,
      });
      start = end;
    }
  }
  const core = { schemaVersion: SNAPSHOT, projectId: project.id, sourceRevisions, evidence };
  return { ...core, contextHash: hash(core) };
}

export function buildAgentSnapshot(project, request) {
  const normalized = normalizeAgentRequest(request);
  return snapshotFor(project, normalized.sourceIds);
}

export function validateAgentSnapshot(project, snapshot) {
  record(snapshot, ["schemaVersion", "projectId", "sourceRevisions", "evidence", "contextHash"], "运行资料快照");
  if (snapshot.schemaVersion !== SNAPSHOT || snapshot.projectId !== project.id) fail("运行资料快照不属于此项目或版本无效。");
  list(snapshot.sourceRevisions, 6, "资料版本", 1);
  const ids = snapshot.sourceRevisions.map((ref) => {
    record(ref, ["sourceId", "versionId", "title", "kind", "contentHash"], "资料版本快照");
    id(ref.versionId, "资料版本 ID");
    return id(ref.sourceId, "资料 ID");
  });
  if (new Set(ids).size !== ids.length) fail("运行资料快照重复。");
  const expected = snapshotFor(project, ids, snapshot.sourceRevisions);
  if (!isDeepStrictEqual(snapshot, expected)) fail("运行快照与保留版本的正文、位置或哈希不一致。");
  return clone(expected);
}

export function validateAgentProposal(snapshot, proposal) {
  record(proposal, ["schemaVersion", "decision", "summary", "claims", "tasks", "gaps", "questions"], "分析提案");
  if (proposal.schemaVersion !== PROPOSAL) fail("分析提案协议版本无效。");
  enumValue(proposal.decision, ["proposal", "needs_input"], "分析决定");
  text(proposal.summary, 2000, "分析摘要");
  const evidenceIds = new Set(snapshot.evidence.map((entry) => entry.id));
  const claimIds = new Set(), allIds = new Set();
  for (const claim of list(proposal.claims, 12, "候选结论")) {
    record(claim, ["id", "text", "evidenceIds"], "候选结论");
    candidateId(claim.id);
    if (allIds.has(claim.id)) fail("候选 ID 不能重复。");
    claimIds.add(claim.id); allIds.add(claim.id);
    text(claim.text, 4000, "候选结论");
    const refs = uniqueIds(claim.evidenceIds, 8, "候选结论依据", 1, candidateId);
    if (refs.some((ref) => !evidenceIds.has(ref))) fail("候选结论引用了本次快照以外的依据。");
  }
  for (const task of list(proposal.tasks, 12, "候选任务")) {
    record(task, ["id", "title", "claimIds"], "候选任务");
    candidateId(task.id);
    if (allIds.has(task.id)) fail("候选 ID 不能重复。");
    allIds.add(task.id);
    text(task.title, 120, "候选任务标题");
    const refs = uniqueIds(task.claimIds, 12, "任务关联候选结论", 0, candidateId);
    if (refs.some((ref) => !claimIds.has(ref))) fail("候选任务关联不存在的结论。");
  }
  list(proposal.gaps, 8, "资料缺口").forEach((value) => text(value, 1000, "资料缺口"));
  list(proposal.questions, 4, "澄清问题").forEach((value) => text(value, 1000, "澄清问题"));
  if (proposal.decision === "needs_input" && (!proposal.questions.length || proposal.claims.length || proposal.tasks.length)) fail("需要补充信息时必须提出问题，不能同时生成结论或任务。");
  if (proposal.decision === "proposal" && !proposal.claims.length && !proposal.tasks.length && !proposal.gaps.length) fail("分析提案至少需要结论、任务或资料缺口。");
  return clone(proposal);
}

export function isAgentRunStale(project, run) {
  return run.snapshot.sourceRevisions.some((ref) => project.sources.find((source) => source.id === ref.sourceId)?.currentVersionId !== ref.versionId);
}

export function agentClaimEvidence(run, candidate) {
  const seen = new Set();
  return candidate.evidenceIds.map((evidenceId) => {
    const ref = run.snapshot.evidence.find((entry) => entry.id === evidenceId);
    if (!ref) fail("候选结论依据不属于本次运行。");
    return { sourceId: ref.sourceId, versionId: ref.versionId, locator: ref.locator };
  }).filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function invocation(value) {
  record(value, ["requestId", "sessionId", "runtimeName", "applicationVersion", "startedAt", "platformRequestId"], "平台调用记录");
  safeMessage(id(value.requestId, "请求 ID"));
  safeMessage(id(value.sessionId, "会话 ID"));
  safeMessage(id(value.runtimeName, "应用名称"));
  if (value.applicationVersion !== null) safeMessage(id(value.applicationVersion, "应用版本", 120));
  timestamp(value.startedAt, "调用开始时间");
  if (value.platformRequestId !== null) safeMessage(id(value.platformRequestId, "平台请求 ID"));
  return clone(value);
}

export function createAgentRun(project, request, { id: runId, now, provider, authorizeCloud = false }) {
  const normalized = normalizeAgentRequest(request);
  if (normalized.intent !== "research") fail("当前仅支持研究问题分析，其他分析意图尚未启用。", "AGENT_INTENT_UNSUPPORTED");
  id(runId, "运行 ID"); timestamp(now);
  enumValue(provider, ["agentarts", "contract-test"], "分析提供方");
  if (typeof authorizeCloud !== "boolean") fail("资料发送授权必须是布尔值。");
  if ((project.agentRuns?.length ?? 0) >= 40) fail("单个项目最多保留 40 次云端分析请求。", "AGENT_RUN_LIMIT");
  const snapshot = buildAgentSnapshot(project, normalized);
  return {
    id: runId, createdAt: now, updatedAt: now, request: normalized,
    snapshot, authorization: { cloudTransfer: authorizeCloud, at: authorizeCloud ? now : null, scopeHash: snapshot.contextHash },
    provider, status: "queued",
    events: [{ at: now, status: "queued", message: "已保存本次请求及资料快照，等待处理。" }],
    invocation: null, proposal: null, error: null, acceptance: null,
  };
}

export function transitionAgentRun(project, run, transition, now) {
  validateOneRun(project, run);
  timestamp(now);
  if (now < run.updatedAt) fail("运行时间不能倒退。");
  if (!transition || typeof transition !== "object" || Array.isArray(transition) || Object.keys(transition).some((key) => !["status", "message", "invocation", "proposal", "error", "platformRequestId"].includes(key))) fail("运行状态转换字段无效。");
  const { status } = transition;
  if (status === "accepted" || !TRANSITIONS[run.status]?.includes(status)) fail("此运行状态不允许转换。", "AGENT_RUN_TERMINAL", 409);
  const next = clone(run);
  const message = safeMessage(transition.message);
  if (status === "running") {
    if (!run.authorization.cloudTransfer) fail("本次资料尚未获得发送授权。", "AGENT_CLOUD_AUTH_REQUIRED");
    next.invocation = invocation(transition.invocation);
    if (next.invocation.startedAt !== now || next.invocation.platformRequestId !== null) fail("调用开始记录必须对应本次启动，平台 ID 不得预先推测。");
  } else if (transition.invocation !== undefined) fail("调用身份只能在开始运行时记录。");
  if (status === "proposal" || status === "needs_input") {
    next.proposal = validateAgentProposal(run.snapshot, transition.proposal);
    if (next.proposal.decision !== status) fail("提案决定与运行状态不一致。");
  } else if (transition.proposal !== undefined) fail("此状态不能携带分析提案。");
  if (status === "failed" || status === "blocked") next.error = runError(transition.error);
  else if (status === "interrupted" && transition.error !== undefined) next.error = transition.error === null ? null : runError(transition.error);
  else if (transition.error !== undefined) fail("此状态不能携带运行错误。");
  if (transition.platformRequestId !== undefined) {
    if (!next.invocation || status === "running") fail("平台请求 ID 必须来自本次调用响应。");
    next.invocation.platformRequestId = transition.platformRequestId === null ? null : id(transition.platformRequestId, "平台请求 ID");
  }
  next.status = status; next.updatedAt = now;
  next.events.push({ at: now, status, message });
  validateOneRun(project, next);
  Object.assign(run, next);
  return run;
}

function selection(value, available, label) {
  const selected = uniqueIds(value, 12, label, 0, candidateId);
  if (selected.some((entry) => !available.some((candidate) => candidate.id === entry))) fail(`${label}包含不存在的候选。`);
  return selected;
}

export function acceptAgentRun(project, payload, ctx) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => !["projectId", "runId", "claimIds", "taskIds", "acknowledgeEvidence"].includes(key))) fail("确认请求字段无效。");
  id(payload.runId, "运行 ID");
  if (payload.projectId !== undefined && payload.projectId !== project.id) fail("运行不属于此项目。", "NOT_FOUND", 404);
  const run = project.agentRuns?.find((entry) => entry.id === payload.runId);
  if (!run) fail("运行不存在或不属于此项目。", "NOT_FOUND", 404);
  validateOneRun(project, run);
  if (run.status === "accepted") fail("此提案已经确认，请查看原回执。", "ALREADY_ACCEPTED", 409);
  if (run.status !== "proposal") fail("此运行尚无可确认的提案。", "AGENT_PROPOSAL_UNAVAILABLE", 409);
  if (payload.acknowledgeEvidence !== true) fail("请先核对原文，并确认理解引用校验不代表结论正确。", "AGENT_EVIDENCE_ACK_REQUIRED");
  if (isAgentRunStale(project, run)) fail("所选资料已变化，请使用当前版本重新分析。", "AGENT_RUN_STALE", 409);
  timestamp(ctx.now);
  if (ctx.now < run.updatedAt) fail("确认时间不能早于提案时间。");
  const claimIds = selection(payload.claimIds, run.proposal.claims, "选择结论");
  const taskIds = selection(payload.taskIds, run.proposal.tasks, "选择任务");
  if (!claimIds.length && !taskIds.length) fail("请至少选择一条结论或一项任务。");
  const selectedClaims = run.proposal.claims.filter((entry) => claimIds.includes(entry.id));
  const selectedTasks = run.proposal.tasks.filter((entry) => taskIds.includes(entry.id));
  if (selectedTasks.some((entry) => entry.claimIds.some((ref) => !claimIds.includes(ref)))) fail("请同时选择任务依赖的全部结论。", "MISSING_DEPENDENCY");
  const receipt = { at: ctx.now, claims: [], tasks: [] };
  const claims = selectedClaims.map((candidate) => {
    const entityId = id(ctx.id("claim"), "新结论 ID");
    receipt.claims.push({ candidateId: candidate.id, entityId });
    return { id: entityId, text: candidate.text, evidence: agentClaimEvidence(run, candidate), status: "linked" };
  });
  const tasks = selectedTasks.map((candidate) => {
    const entityId = id(ctx.id("task"), "新任务 ID");
    receipt.tasks.push({ candidateId: candidate.id, entityId });
    return { id: entityId, title: candidate.title, claimIds: candidate.claimIds.map((ref) => receipt.claims.find((entry) => entry.candidateId === ref).entityId), status: "todo", reviewRequired: false };
  });
  const existingIds = new Set([project.id, ...project.sources.flatMap((source) => [source.id, ...source.versions.map((version) => version.id)]), ...project.claims.map((entry) => entry.id), ...project.tasks.map((entry) => entry.id), ...(project.artifacts ?? []).map((entry) => entry.id), ...(project.agentRuns ?? []).map((entry) => entry.id)]);
  for (const entity of [...claims, ...tasks]) {
    if (existingIds.has(entity.id)) fail("新增记录 ID 重复。");
    existingIds.add(entity.id);
  }
  project.claims.push(...claims); project.tasks.push(...tasks);
  run.acceptance = receipt; run.status = "accepted"; run.updatedAt = ctx.now;
  run.events.push({ at: ctx.now, status: "accepted", message: "用户核对原文并确认所选结论与任务；保留原提案及资料版本。" });
  return clone(receipt);
}

function validateOneRun(project, run) {
  record(run, ["id", "createdAt", "updatedAt", "request", "snapshot", "authorization", "provider", "status", "events", "invocation", "proposal", "error", "acceptance"], "智能体运行记录");
  id(run.id, "运行 ID"); timestamp(run.createdAt); timestamp(run.updatedAt);
  if (run.updatedAt < run.createdAt) fail("运行更新时间早于创建时间。");
  enumValue(run.provider, ["agentarts", "contract-test"], "分析提供方");
  enumValue(run.status, STATUSES, "运行状态");
  const request = normalizeAgentRequest(run.request);
  if (request.intent !== "research" || !isDeepStrictEqual(request, run.request)) fail("运行请求不符合当前协议。");
  validateAgentSnapshot(project, run.snapshot);
  record(run.authorization, ["cloudTransfer", "at", "scopeHash"], "资料发送授权");
  if (typeof run.authorization.cloudTransfer !== "boolean" || run.authorization.scopeHash !== run.snapshot.contextHash || run.authorization.at !== (run.authorization.cloudTransfer ? run.createdAt : null)) fail("资料发送授权与本次运行快照不一致。");
  if (!isDeepStrictEqual(request.sourceIds, run.snapshot.sourceRevisions.map((entry) => entry.sourceId))) fail("请求与资料快照不一致。");
  let previous;
  const events = list(run.events, 4, "运行事件", 1);
  for (const [index, event] of events.entries()) {
    record(event, ["at", "status", "message"], "运行事件"); timestamp(event.at); safeMessage(event.message);
    enumValue(event.status, STATUSES, "事件状态");
    if (index === 0 ? event.status !== "queued" || event.at !== run.createdAt : event.at < previous.at || !TRANSITIONS[previous.status]?.includes(event.status)) fail("运行事件顺序或状态转换无效。");
    previous = event;
  }
  if (previous.status !== run.status || previous.at !== run.updatedAt) fail("运行状态与事件历史不一致。");
  const runningEvent = events.find((event) => event.status === "running");
  if (runningEvent) {
    if (!run.authorization.cloudTransfer) fail("没有资料发送授权的运行不能包含平台调用。");
    invocation(run.invocation);
    if (run.invocation.startedAt !== runningEvent.at) fail("平台调用开始时间与事件不一致。");
    if (run.status === "running" && run.invocation.platformRequestId !== null) fail("尚未返回时不能补造平台请求 ID。");
  } else if (run.invocation !== null) fail("未调用平台的运行不能带有调用身份。");
  if (["proposal", "needs_input", "accepted"].includes(run.status)) {
    const proposal = validateAgentProposal(run.snapshot, run.proposal);
    if (proposal.decision !== (run.status === "accepted" ? "proposal" : run.status)) fail("运行提案与状态不一致。");
  } else if (run.proposal !== null) fail("尚无提案的运行不能保存提案。");
  if (["failed", "blocked"].includes(run.status)) runError(run.error);
  else if (run.status === "interrupted" && run.error !== null) runError(run.error);
  else if (run.error !== null) fail("此运行状态不能携带错误。");
  if (run.status !== "accepted") {
    if (run.acceptance !== null) fail("未确认的运行不能带有确认回执。");
    return;
  }
  const receipt = run.acceptance;
  record(receipt, ["at", "claims", "tasks"], "智能体提案确认回执"); timestamp(receipt.at);
  if (receipt.at !== run.updatedAt || (!receipt.claims?.length && !receipt.tasks?.length)) fail("提案确认回执时间或内容无效。");
  const entityIds = new Set(), claimMap = new Map();
  for (const [kind, candidates, entities] of [["claims", run.proposal.claims, project.claims], ["tasks", run.proposal.tasks, project.tasks]]) {
    const seen = new Set();
    for (const ref of list(receipt[kind], 12, "提案确认映射")) {
      record(ref, ["candidateId", "entityId"], "提案确认映射"); candidateId(ref.candidateId); id(ref.entityId);
      if (seen.has(ref.candidateId) || entityIds.has(ref.entityId)) fail("提案确认映射重复。");
      seen.add(ref.candidateId); entityIds.add(ref.entityId);
      const candidate = candidates.find((entry) => entry.id === ref.candidateId);
      const entity = entities.find((entry) => entry.id === ref.entityId);
      if (!candidate || !entity) fail("提案确认映射引用不存在的对象。");
      const original = originalContent(entity);
      if (kind === "claims") {
        if (original.text !== candidate.text || !isDeepStrictEqual(original.evidence, agentClaimEvidence(run, candidate))) fail("确认结论原始内容与提案不一致。");
        claimMap.set(candidate.id, entity.id);
      } else {
        const expectedIds = candidate.claimIds.map((entry) => claimMap.get(entry));
        if (expectedIds.includes(undefined) || original.title !== candidate.title || !isDeepStrictEqual(original.claimIds, expectedIds)) fail("确认任务原始内容或关联与提案不一致。");
      }
    }
  }
}

export function validateAgentRuns(project, register = () => {}) {
  if (project.agentRuns === undefined) return;
  const runIds = new Set(), acceptedIds = new Set();
  for (const run of list(project.agentRuns, 40, "智能体运行记录")) {
    validateOneRun(project, run);
    if (runIds.has(run.id)) fail("智能体运行 ID 重复。");
    runIds.add(run.id); register(run.id, "智能体运行 ID");
    for (const ref of [...(run.acceptance?.claims ?? []), ...(run.acceptance?.tasks ?? [])]) {
      if (acceptedIds.has(ref.entityId)) fail("同一记录不能属于两次智能体提案确认。");
      acceptedIds.add(ref.entityId);
    }
  }
}
