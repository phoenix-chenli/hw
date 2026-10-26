import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeAgentRequest, buildAgentSnapshot, validateAgentSnapshot,
  validateAgentProposal, createAgentRun, transitionAgentRun,
  acceptAgentRun, validateAgentRuns, isAgentRunStale, agentClaimEvidence,
} from "../server/agent-protocol.mjs";
import { applyEntityReview, buildReviewPreview } from "../server/review.mjs";

const times = [0, 1, 2, 3, 4].map((minute) => `2026-10-26T01:0${minute}:00.000Z`);
const request = { intent: "research", question: "这些资料可以支持什么结论？", sourceIds: ["source-1"] };
function project(content = "标题\r\n😀这是合成测试资料。\r资料不足需要核对。\n") {
  return {
    id: "project-1", ownerId: "alice", title: "合成测试", goal: "验证明确证据边界", deadline: null,
    createdAt: times[0], isDemo: true,
    sources: [{ id: "source-1", title: "合成资料", kind: "note", currentVersionId: "version-1", versions: [{ id: "version-1", number: 1, content, createdAt: times[0] }] }],
    claims: [], tasks: [], artifacts: [], activity: [],
  };
}
function proposal(snapshot) {
  return {
    schemaVersion: "xingjian.analysis-proposal.v1", decision: "proposal", summary: "合成测试提案，不代表真实云端结果。",
    claims: [{ id: "claim-one", text: "需要人工阅读上下文，判断资料是否支持这一候选发现。", evidenceIds: [snapshot.evidence[0].id] }],
    tasks: [{ id: "task-one", title: "核对候选发现", claimIds: ["claim-one"] }],
    gaps: ["引用校验不代表语义正确。"], questions: [],
  };
}
function runFixture(p = project(), authorizeCloud = true) {
  const run = createAgentRun(p, request, { id: "run-1", now: times[0], provider: "contract-test", authorizeCloud });
  p.agentRuns = [run];
  return { p, run };
}
function start(p, run) {
  return transitionAgentRun(p, run, {
    status: "running", message: "开始合约测试调用。",
    invocation: { requestId: "request-1", sessionId: "session-1", runtimeName: "contract-test", applicationVersion: null, startedAt: times[1], platformRequestId: null },
  }, times[1]);
}
function proposed(p = project()) {
  const f = runFixture(p);
  start(f.p, f.run);
  transitionAgentRun(f.p, f.run, { status: "proposal", message: "合约测试已返回候选内容，尚未确认。", proposal: proposal(f.run.snapshot), platformRequestId: "fixture-response-1" }, times[2]);
  return f;
}
function accept(p, run, overrides = {}) {
  let seq = 0;
  return acceptAgentRun(p, { runId: run.id, claimIds: ["claim-one"], taskIds: ["task-one"], acknowledgeEvidence: true, ...overrides }, { now: times[3], id: (kind) => `${kind}-new-${++seq}` });
}

test("agent requests enforce intent names, explicit scope and bounded questions without silently executable intents", () => {
  assert.deepEqual(normalizeAgentRequest({ ...request, question: "  一个问题  " }), { ...request, question: "一个问题" });
  for (const intent of ["change_review", "planning", "draft"]) {
    assert.equal(normalizeAgentRequest({ ...request, intent }).intent, intent);
    assert.throws(() => createAgentRun(project(), { ...request, intent }, { id: "run-1", now: times[0], provider: "agentarts" }), { code: "AGENT_INTENT_UNSUPPORTED" });
  }
  for (const value of [null, [], {}, { ...request, intent: "exec" }, { ...request, question: " " }, { ...request, question: "字".repeat(2001) }, { ...request, sourceIds: [] }, { ...request, sourceIds: ["source-1", "source-1"] }, { ...request, sourceIds: [" source-1"] }, { ...request, sourceIds: Array.from({ length: 7 }, (_, i) => `s${i}`) }, { ...request, ownerId: "bob" }]) assert.throws(() => normalizeAgentRequest(value));
});

test("snapshot captures all raw UTF-16 content contiguously, CRLF and physical lines with deterministic hashes", () => {
  const content = "a".repeat(1199) + "😀\r\n" + "b".repeat(1197) + "\r\n结尾\n";
  const p = project(content);
  const snapshot = buildAgentSnapshot(p, request);
  assert.equal(snapshot.evidence.map((entry) => entry.quote).join(""), content);
  let cursor = 0;
  for (const [index, entry] of snapshot.evidence.entries()) {
    assert.equal(entry.id, `ev-${index + 1}`);
    assert.equal(entry.start, cursor);
    assert.equal(entry.quote, content.slice(entry.start, entry.end));
    assert.ok(entry.end - entry.start <= 1200);
    assert.ok(!(/[\uD800-\uDBFF]/u.test(content[entry.end - 1]) && /[\uDC00-\uDFFF]/u.test(content[entry.end] ?? "")));
    assert.ok(!(content[entry.end - 1] === "\r" && content[entry.end] === "\n"));
    assert.match(entry.locator, /非原文件页码/);
    cursor = entry.end;
  }
  assert.equal(snapshot.evidence[0].end, 1199);
  assert.equal(snapshot.evidence[1].startLine, 1);
  assert.equal(cursor, content.length);
  assert.equal(snapshot.sourceRevisions[0].contentHash, createHash("sha256").update(Buffer.from(content, "utf16le")).digest("hex"));
  assert.deepEqual(buildAgentSnapshot(p, request), snapshot);
  assert.deepEqual(validateAgentSnapshot(p, JSON.parse(JSON.stringify(snapshot))), snapshot);
  const reversedKeys = Object.fromEntries(Object.entries(snapshot).reverse());
  assert.deepEqual(validateAgentSnapshot(p, reversedKeys), snapshot);
});

test("snapshot refuses truncation, cross-project references and corrupt retained inputs", () => {
  assert.throws(() => buildAgentSnapshot(project("字".repeat(20001)), request), { code: "AGENT_INPUT_LIMIT" });
  assert.equal(buildAgentSnapshot(project("字".repeat(20000)), request).evidence.map((entry) => entry.quote).join("").length, 20000);
  assert.throws(() => buildAgentSnapshot(project(), { ...request, sourceIds: ["foreign"] }), { code: "NOT_FOUND" });
  const p = project();
  const snapshot = buildAgentSnapshot(p, request);
  for (const mutate of [
    (s) => s.evidence[0].start++, (s) => s.evidence[0].end--,
    (s) => s.evidence[0].startLine++, (s) => s.evidence[0].quote = "替换原文",
    (s) => s.evidence[0].locator = "原 PDF 第 1 页", (s) => s.evidence[0].contentHash = "0".repeat(64),
    (s) => s.evidence.push(s.evidence[0]), (s) => s.evidence[0].ownerId = "bob",
    (s) => s.sourceRevisions[0].versionId = "foreign-version", (s) => s.projectId = "other-project",
    (s) => s.contextHash = "0".repeat(64), (s) => s.sourceRevisions[0].title = "替换标题",
  ]) {
    const corrupt = structuredClone(snapshot); mutate(corrupt);
    assert.throws(() => validateAgentSnapshot(p, corrupt));
  }
  p.sources[0].versions[0].content += "偷偷修改旧版";
  assert.throws(() => validateAgentSnapshot(p, snapshot));
});

test("snapshot reads retained versions after updates, and exact code-unit hashes do not collapse lone surrogates", () => {
  const p = project();
  const snapshot = buildAgentSnapshot(p, request);
  p.sources[0].versions.push({ id: "version-2", number: 2, content: "修订资料", createdAt: times[1] });
  p.sources[0].currentVersionId = "version-2";
  assert.deepEqual(validateAgentSnapshot(p, snapshot), snapshot);
  assert.equal(isAgentRunStale(p, { snapshot }), true);
  const lone = buildAgentSnapshot(project("\uD800"), request);
  const replacement = buildAgentSnapshot(project("\uFFFD"), request);
  assert.notEqual(lone.sourceRevisions[0].contentHash, replacement.sourceRevisions[0].contentHash);
});

test("proposals strictly allow evidence IDs and reject model-supplied identities, coordinates and repaired output", () => {
  const snapshot = buildAgentSnapshot(project(), request), good = proposal(snapshot);
  assert.deepEqual(validateAgentProposal(snapshot, good), good);
  const validated = validateAgentProposal(snapshot, good);
  validated.claims[0].text = "修改返回值";
  assert.notEqual(validated.claims[0].text, good.claims[0].text);
  for (const mutate of [
    (r) => r.ownerId = "bob", (r) => r.claims[0].sourceId = "source-1", (r) => r.claims[0].start = 0,
    (r) => r.claims[0].evidenceIds = ["unknown"], (r) => r.claims[0].evidenceIds = [],
    (r) => r.claims[0].evidenceIds = ["ev-1", "ev-1"], (r) => r.claims[0].id = "<script>",
    (r) => r.claims.push(structuredClone(r.claims[0])), (r) => r.tasks[0].claimIds = ["missing"],
    (r) => r.tasks[0].id = r.claims[0].id, (r) => r.tasks[0].title = "字".repeat(121),
    (r) => r.claims[0].text = "字".repeat(4001), (r) => r.summary = "字".repeat(2001),
    (r) => r.questions = Array(5).fill("补充什么"), (r) => r.gaps = ["字".repeat(1001)],
  ]) {
    const corrupt = structuredClone(good); mutate(corrupt);
    assert.throws(() => validateAgentProposal(snapshot, corrupt));
  }
});

test("needs-input has explicit questions without fabricated claims; honest gap-only proposals remain valid", () => {
  const snapshot = buildAgentSnapshot(project(), request);
  const input = { ...proposal(snapshot), decision: "needs_input", claims: [], tasks: [], questions: ["研究范围是哪个校区？"] };
  assert.equal(validateAgentProposal(snapshot, input).decision, "needs_input");
  assert.throws(() => validateAgentProposal(snapshot, { ...input, questions: [] }));
  assert.throws(() => validateAgentProposal(snapshot, { ...input, claims: proposal(snapshot).claims }));
  assert.equal(validateAgentProposal(snapshot, { ...proposal(snapshot), claims: [], tasks: [] }).claims.length, 0);
  assert.throws(() => validateAgentProposal(snapshot, { ...proposal(snapshot), claims: [], tasks: [], gaps: [] }));
});

test("legacy projects remain unchanged; queued runs bind explicit authorization to exact snapshot", () => {
  const p = project(), before = structuredClone(p);
  validateAgentRuns(p);
  assert.deepEqual(p, before);
  const run = createAgentRun(p, request, { id: "run-1", now: times[0], provider: "agentarts" });
  assert.equal(run.authorization.cloudTransfer, false);
  assert.equal(run.authorization.at, null);
  assert.equal(run.authorization.scopeHash, run.snapshot.contextHash);
  p.agentRuns = [run];
  validateAgentRuns(p);
  assert.throws(() => start(p, run), { code: "AGENT_CLOUD_AUTH_REQUIRED" });
  assert.equal(run.status, "queued");
  transitionAgentRun(p, run, { status: "blocked", message: "尚未配置云端应用，本次资料未发送。", error: { code: "AGENT_NOT_CONFIGURED", message: "请先完成服务端配置。" } }, times[1]);
  assert.equal(run.invocation, null);
  validateAgentRuns(p);
  assert.throws(() => start(p, run), { code: "AGENT_RUN_TERMINAL" });
});

test("lifecycle transitions are append-only, atomic, bounded and keep actual invocation identity", () => {
  const { p, run } = runFixture();
  const before = structuredClone(run);
  assert.throws(() => transitionAgentRun(p, run, { status: "proposal", message: "跳过调用", proposal: proposal(run.snapshot) }, times[1]));
  assert.deepEqual(run, before);
  start(p, run);
  assert.equal(run.invocation.platformRequestId, null);
  assert.equal(run.events.length, 2);
  assert.throws(() => transitionAgentRun(p, run, { status: "running", message: "重复调用" }, times[2]));
  assert.throws(() => transitionAgentRun(p, run, { status: "proposal", message: "输出", proposal: { ...proposal(run.snapshot), decision: "needs_input" } }, times[2]));
  assert.equal(run.status, "running");
  transitionAgentRun(p, run, { status: "proposal", message: "已有候选，尚待人工核对。", proposal: proposal(run.snapshot), platformRequestId: "actual-response-1" }, times[2]);
  assert.equal(run.invocation.requestId, "request-1");
  assert.equal(run.invocation.platformRequestId, "actual-response-1");
  assert.equal(run.events.at(-1).at, run.updatedAt);
  const final = structuredClone(run);
  assert.throws(() => transitionAgentRun(p, run, { status: "accepted", message: "绕过核对" }, times[3]));
  assert.throws(() => transitionAgentRun(p, run, { status: "failed", message: "迟到失败", error: { code: "LATE", message: "迟到响应" } }, times[3]));
  assert.deepEqual(run, final);
  validateAgentRuns(p);
});

test("safe failed and interrupted states retain invocation while preventing raw secret or endpoint persistence", () => {
  for (const value of ["https://example.test/private", "Bearer hidden-token", "Authorization: hidden", "api_key=hidden"]) {
    const { p, run } = runFixture(); start(p, run);
    const before = structuredClone(run);
    assert.throws(() => transitionAgentRun(p, run, { status: "failed", message: "调用失败。", error: { code: "NETWORK_ERROR", message: value } }, times[2]));
    assert.deepEqual(run, before);
  }
  const { p, run } = runFixture(); start(p, run);
  transitionAgentRun(p, run, { status: "failed", message: "调用未成功。", error: { code: "AGENT_NETWORK_ERROR", message: "云端请求失败，请检查服务端配置。" } }, times[2]);
  validateAgentRuns(p);
  assert.equal(run.invocation.requestId, "request-1");
  const interrupted = runFixture();
  transitionAgentRun(interrupted.p, interrupted.run, { status: "interrupted", message: "本地等待已停止，云端计费不保证停止。", error: null }, times[1]);
  validateAgentRuns(interrupted.p);
  assert.equal(interrupted.run.invocation, null);
  const activeInterrupted = runFixture(); start(activeInterrupted.p, activeInterrupted.run);
  transitionAgentRun(activeInterrupted.p, activeInterrupted.run, { status: "interrupted", message: "进程重启，本次运行未自动恢复。" }, times[2]);
  validateAgentRuns(activeInterrupted.p);
  assert.notEqual(activeInterrupted.run.invocation, null);
});

test("acceptance requires acknowledgement, all selected dependencies and current source versions", () => {
  const { p, run } = proposed();
  for (const [overrides, code] of [
    [{ acknowledgeEvidence: false }, "AGENT_EVIDENCE_ACK_REQUIRED"],
    [{ claimIds: [], taskIds: ["task-one"] }, "MISSING_DEPENDENCY"],
    [{ projectId: "other" }, "NOT_FOUND"],
    [{ claimIds: ["missing"] }, "INVALID_AGENT_PROTOCOL"],
    [{ claimIds: [], taskIds: [] }, "INVALID_AGENT_PROTOCOL"],
    [{ text: "客户端篡改" }, "INVALID_AGENT_PROTOCOL"],
  ]) {
    const before = structuredClone(p);
    assert.throws(() => accept(p, run, overrides), { code });
    assert.deepEqual(p, before);
  }
  p.sources[0].versions.push({ id: "version-2", number: 2, content: "新资料", createdAt: times[3] });
  p.sources[0].currentVersionId = "version-2";
  assert.throws(() => accept(p, run), { code: "AGENT_RUN_STALE", status: 409 });
  assert.equal(p.claims.length, 0);
  validateAgentRuns(p);
});

test("selective acceptance writes exact candidate content and references once, leaving completed tasks untouched", () => {
  const { p, run } = proposed();
  p.tasks.push({ id: "done-task", title: "既有已完成任务", claimIds: [], status: "done", reviewRequired: false });
  const receipt = accept(p, run);
  assert.equal(run.status, "accepted");
  assert.equal(run.events.length, 4);
  assert.deepEqual(receipt, run.acceptance);
  assert.equal(p.claims[0].text, run.proposal.claims[0].text);
  assert.deepEqual(p.claims[0].evidence, agentClaimEvidence(run, run.proposal.claims[0]));
  assert.deepEqual(p.tasks[1].claimIds, [p.claims[0].id]);
  assert.equal(p.tasks[0].status, "done");
  assert.equal(p.tasks[1].status, "todo");
  validateAgentRuns(p);
  assert.throws(() => accept(p, run), { code: "ALREADY_ACCEPTED" });
  assert.equal(p.claims.length, 1);
});

test("gap-only follow-up actions do not gain fabricated evidence or require unrelated claims", () => {
  const { p, run } = runFixture(); start(p, run);
  const output = { ...proposal(run.snapshot), claims: [], tasks: [{ id: "task-gap", title: "补充缺失的访谈资料", claimIds: [] }] };
  transitionAgentRun(p, run, { status: "proposal", message: "资料缺口待补充。", proposal: output }, times[2]);
  accept(p, run, { claimIds: [], taskIds: ["task-gap"] });
  assert.equal(p.claims.length, 0);
  assert.deepEqual(p.tasks[0].claimIds, []);
  validateAgentRuns(p);
});

test("accepted original contents remain bound after human source/claim/task reviews without rewriting proposals", () => {
  const { p, run } = proposed(); accept(p, run);
  const originalProposal = structuredClone(run.proposal);
  p.sources[0].versions.push({ id: "version-2", number: 2, content: "修订后的资料文本", createdAt: times[3] });
  p.sources[0].currentVersionId = "version-2";
  p.claims[0].status = "needs_review";
  p.tasks[0].reviewRequired = true;
  p.tasks[0].status = "done";
  const claimPreview = buildReviewPreview(p, "claim", p.claims[0].id);
  applyEntityReview(p, "claim", { entityId: p.claims[0].id, baseVersion: claimPreview.baseVersion, reviewToken: claimPreview.reviewToken, reason: "核对修订后的原文", text: "人工修订后的结论", evidence: [{ sourceId: "source-1", versionId: "version-2", locator: "人工核对后的描述" }] }, { now: times[4] });
  const taskPreview = buildReviewPreview(p, "task", p.tasks[0].id);
  applyEntityReview(p, "task", { entityId: p.tasks[0].id, baseVersion: taskPreview.baseVersion, reviewToken: taskPreview.reviewToken, reason: "按已核对结论修订", title: "人工修订后的任务" }, { now: times[4] });
  validateAgentRuns(p);
  assert.deepEqual(run.proposal, originalProposal);
  assert.equal(p.tasks[0].status, "done");
  assert.equal(p.claims[0].revisions[0].text, originalProposal.claims[0].text);
  const corrupt = structuredClone(p);
  corrupt.claims[0].revisions[0].text = "偷偷改写原始确认快照";
  assert.throws(() => validateAgentRuns(corrupt));
});

test("read validation rejects corrupt lifecycle, authorization, acceptance mappings and identities", () => {
  const { p, run } = proposed(); accept(p, run);
  for (const mutate of [
    (r) => r.createdAt = "无效", (r) => r.updatedAt = times[0], (r) => r.provider = "cloud-connected",
    (r) => r.request.question = "  变更问题  ", (r) => r.request.sourceIds = ["foreign"],
    (r) => r.authorization.scopeHash = "0".repeat(64), (r) => r.authorization.cloudTransfer = false,
    (r) => r.authorization.at = times[1], (r) => r.events.pop(), (r) => r.events[1].status = "blocked",
    (r) => r.invocation = null, (r) => r.invocation.startedAt = times[0],
    (r) => r.acceptance.at = times[2], (r) => r.acceptance.claims[0].entityId = "missing",
    (r) => r.acceptance.tasks[0].candidateId = "missing", (r) => r.acceptance.claims.push(r.acceptance.claims[0]),
    (r) => r.proposal.claims[0].text = "改写已接受提案", (r) => r.error = { code: "FAILED", message: "伪造失败" },
  ]) {
    const corrupt = structuredClone(p); mutate(corrupt.agentRuns[0]);
    assert.throws(() => validateAgentRuns(corrupt));
  }
  const duplicate = structuredClone(p); duplicate.agentRuns.push(structuredClone(duplicate.agentRuns[0]));
  assert.throws(() => validateAgentRuns(duplicate));
  const ids = [];
  validateAgentRuns(p, (value) => ids.push(value));
  assert.deepEqual(ids, [run.id]);
  assert.deepEqual(JSON.parse(JSON.stringify(p)).agentRuns, p.agentRuns);
  validateAgentRuns(JSON.parse(JSON.stringify(p)));
});

test("failed acceptance ID generation leaves all entities and original proposal untouched", () => {
  const { p, run } = proposed(), before = structuredClone(p);
  assert.throws(() => acceptAgentRun(p, { runId: run.id, claimIds: ["claim-one"], taskIds: ["task-one"], acknowledgeEvidence: true }, { now: times[3], id: () => "duplicate" }));
  assert.deepEqual(p, before);
  const limited = project(); limited.agentRuns = Array(40).fill({});
  assert.throws(() => createAgentRun(limited, request, { id: "run-limit", now: times[0], provider: "contract-test" }), { code: "AGENT_RUN_LIMIT" });
});
