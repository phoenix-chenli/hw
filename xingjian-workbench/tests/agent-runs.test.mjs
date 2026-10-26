import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WorkspaceStore } from "../server/store.mjs";
import { AgentRuns } from "../server/agent-runs.mjs";
import { createApp } from "../server/http.mjs";
import { createAgentArtsProvider } from "../server/agentarts-client.mjs";

const headers = { "X-Xingjian-Client": "workspace-v1", "Content-Type": "application/json" };
const proposalFor = (run) => ({
  schemaVersion: "xingjian.analysis-proposal.v1", decision: "proposal",
  summary: "合成协议验证，尚未连接真实模型。",
  claims: [{ id: "c1", text: "合成候选需要人工核查。", evidenceIds: [run.snapshot.evidence[0].id] }],
  tasks: [{ id: "t1", title: "合成行动：人工核对资料", claimIds: ["c1"] }],
  gaps: ["原文对应不代表候选含义正确。"], questions: [],
});
function provider({ maxCalls = 10, invoke } = {}) {
  let calls = 0;
  return {
    kind: "contract-test", get calls() { return calls; },
    status: () => ({ configured: true, reason: "隔离合成契约测试，未连接真实云端。", code: "CONTRACT_TEST_ONLY", runtimeName: "synthetic-runtime", applicationVersion: "fixture-v1", maxCalls }),
    async invoke(context) { calls++; return invoke ? invoke(context) : { proposal: proposalFor(context.run), platformRequestId: null }; },
  };
}
function seed(store, ownerId = "local-user") {
  const saved = store.command(ownerId, { operationId: randomUUID(), expectedRevision: store.state().revision, type: "load_demo", payload: {} });
  const project = saved.state.projects.find(p => p.id === saved.result.projectId);
  return { project, request: { intent: "research", question: "合成测试：资料提供了哪些记录？", sourceIds: [project.sources[0].id] } };
}
async function until(read, check = value => value, label = "condition") {
  for (let i = 0; i < 400; i++) {
    const value = read(); if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for " + label);
}
async function fixture(t, selectedProvider = provider()) {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-agent-run-"));
  const store = new WorkspaceStore(join(dir, "workspace.json"));
  const server = createApp(store, { agentProvider: selectedProvider, allowedPorts: [] });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.allSettled([server.agentRuns.close(), server.reportJobs.close()]);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const send = async (path, data) => {
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const start = (project, request, authorizeCloud = true, operationId = randomUUID()) => ({ operationId, expectedRevision: store.state().revision, projectId: project.id, request, authorizeCloud });
  const getRun = (id) => store.state().projects.flatMap(p => p.agentRuns ?? []).find(run => run.id === id);
  const complete = (id) => until(() => getRun(id), run => run && !["queued", "running"].includes(run.status), "terminal run");
  return { store, server, base, send, start, getRun, complete, selectedProvider };
}

test("unconfigured requests persist as blocked without consent, transport or business changes", async t => {
  let calls = 0;
  const disabled = createAgentArtsProvider({ env: {}, fetchImpl: () => { calls++; throw new Error("must not call"); } });
  const f = await fixture(t, disabled); const { project, request } = seed(f.store);
  const input = f.start(project, request, false);
  const response = await f.send("/api/agent-runs", input);
  assert.equal(response.status, 200);
  const run = f.getRun(response.body.result.entityId);
  assert.equal(run.status, "blocked"); assert.equal(run.invocation, null); assert.equal(calls, 0);
  assert.equal(run.authorization.cloudTransfer, false);
  assert.deepEqual(response.body.state.projects[0].claims, project.claims);
  assert.equal((await f.send("/api/agent-runs", input)).body.replayed, true);
  const config = await (await fetch(f.base + "/api/agent-runs/config", { headers })).json();
  assert.equal(config.configured, false); assert.equal(config.remainingCalls, 0);
  assert.equal(JSON.stringify(config).includes("API_KEY"), false);
});

test("configured transport requires explicit consent and public commands cannot inject runs or outcomes", async t => {
  const f = await fixture(t); const { project, request } = seed(f.store);
  const before = f.store.state();
  const denied = await f.send("/api/agent-runs", f.start(project, request, false));
  assert.equal(denied.status, 400); assert.equal(denied.body.error.code, "CLOUD_AUTHORIZATION_REQUIRED");
  assert.deepEqual(f.store.state(), before);
  const forged = await f.send("/api/commands", { operationId: randomUUID(), expectedRevision: before.revision, type: "create_agent_run", payload: { projectId: project.id, request, provider: "agentarts", authorizeCloud: true } });
  assert.equal(forged.status, 400); assert.equal(forged.body.error.code, "INTERNAL_COMMAND");
  const outsider = seed(f.store, "another-owner");
  assert.equal((await f.send("/api/agent-runs", f.start(outsider.project, outsider.request))).status, 404);
  assert.equal(f.selectedProvider.calls, 0);
});

test("proposal dispatch and acceptance are durable and idempotent, with explicit evidence acknowledgement", async t => {
  const f = await fixture(t); const { project, request } = seed(f.store);
  const input = f.start(project, request);
  const response = await f.send("/api/agent-runs", input);
  const runId = response.body.result.entityId;
  const run = await f.complete(runId); assert.equal(run.status, "proposal");
  assert.equal(run.provider, "contract-test"); assert.equal(run.invocation.platformRequestId, null);
  assert.equal(run.invocation.startedAt, run.events.find(e => e.status === "running").at);
  assert.equal(f.selectedProvider.calls, 1);
  const replay = await f.send("/api/agent-runs", input);
  assert.equal(replay.body.replayed, true); assert.equal(f.selectedProvider.calls, 1);
  const payload = { projectId: project.id, runId, claimIds: ["c1"], taskIds: ["t1"], acknowledgeEvidence: true };
  const command = { operationId: randomUUID(), expectedRevision: f.store.state().revision, type: "accept_agent_run", payload };
  assert.equal((await f.send("/api/commands", { ...command, payload: { ...payload, acknowledgeEvidence: false } })).status, 400);
  const accepted = await f.send("/api/commands", command); assert.equal(accepted.status, 200);
  const p = accepted.body.state.projects[0];
  assert.equal(p.claims.length, project.claims.length + 1); assert.equal(p.tasks.length, project.tasks.length + 1);
  assert.deepEqual(p.tasks.slice(0, project.tasks.length), project.tasks);
  assert.equal(f.getRun(runId).status, "accepted");
  assert.equal((await f.send("/api/commands", command)).body.replayed, true);
  const record = JSON.parse(readFileSync(f.store.file, "utf8")).workspace.projects[0].agentRuns[0];
  assert.equal(record.status, "accepted"); assert.deepEqual(record.proposal, run.proposal);
  assert.equal((await f.send("/api/commands", { ...command, operationId: randomUUID(), expectedRevision: f.store.state().revision })).status, 409);
});

test("source changes during cloud work preserve the old result but reject confirmation", async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const remote = provider({ invoke: async ({ run }) => { await gate; return { proposal: proposalFor(run), platformRequestId: null }; } });
  const f = await fixture(t, remote); const { project, request } = seed(f.store);
  const started = await f.send("/api/agent-runs", f.start(project, request));
  const id = started.body.result.entityId;
  await until(() => f.getRun(id)?.status, s => s === "running");
  f.store.command("local-user", { operationId: randomUUID(), expectedRevision: f.store.state().revision, type: "update_source", payload: { projectId: project.id, sourceId: project.sources[0].id, baseVersionId: project.sources[0].currentVersionId, content: "新版合成资料不应覆盖旧快照。" } });
  finish(); const run = await f.complete(id); assert.equal(run.status, "proposal");
  assert.equal(run.snapshot.sourceRevisions[0].versionId, project.sources[0].currentVersionId);
  const rejected = await f.send("/api/commands", { operationId: randomUUID(), expectedRevision: f.store.state().revision, type: "accept_agent_run", payload: { projectId: project.id, runId: id, claimIds: ["c1"], taskIds: [], acknowledgeEvidence: true } });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, "AGENT_RUN_STALE");
  assert.deepEqual(f.getRun(id).proposal, run.proposal);
});

test("unknown evidence and provider exceptions become safe failure records without candidate writes", async t => {
  const invalid = provider({ invoke: async ({ run }) => { const proposal = proposalFor(run); proposal.claims[0].evidenceIds = ["ev-unknown"]; return { proposal, platformRequestId: null }; } });
  const f = await fixture(t, invalid); const { project, request } = seed(f.store);
  const first = await f.send("/api/agent-runs", f.start(project, request));
  const run = await f.complete(first.body.result.entityId); assert.equal(run.status, "failed"); assert.equal(run.proposal, null);
  assert.equal(run.error.code, "INVALID_AGENT_PROTOCOL");
  f.server.agentRuns.provider = provider({ invoke: async () => { throw new Error("Bearer secret-value https://secret.invalid/private"); } });
  const second = await f.send("/api/agent-runs", f.start(project, request));
  const failed = await f.complete(second.body.result.entityId); assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify(failed).includes("secret-value"), false); assert.equal(JSON.stringify(failed).includes("secret.invalid"), false);
  assert.deepEqual(f.store.state().projects[0].claims, project.claims);
});

test("needs_input has questions and cannot be confirmed as a proposal", async t => {
  const f = await fixture(t, provider({ invoke: async () => ({ proposal: { schemaVersion: "xingjian.analysis-proposal.v1", decision: "needs_input", summary: "请补充研究范围。", claims: [], tasks: [], gaps: [], questions: ["本次研究针对哪一学期？"] }, platformRequestId: null }) }));
  const { project, request } = seed(f.store);
  const started = await f.send("/api/agent-runs", f.start(project, request));
  const run = await f.complete(started.body.result.entityId); assert.equal(run.status, "needs_input");
  const result = await f.send("/api/commands", { operationId: randomUUID(), expectedRevision: f.store.state().revision, type: "accept_agent_run", payload: { projectId: project.id, runId: run.id, claimIds: [], taskIds: [], acknowledgeEvidence: true } });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, "AGENT_PROPOSAL_UNAVAILABLE");
});

test("interruption stops local waiting and late provider results cannot overwrite terminal history", async t => {
  let release;
  const f = await fixture(t, provider({ invoke: ({ run }) => new Promise(resolve => { release = () => resolve({ proposal: proposalFor(run), platformRequestId: null }); }) }));
  const { project, request } = seed(f.store);
  const started = await f.send("/api/agent-runs", f.start(project, request)); const id = started.body.result.entityId;
  await until(() => release);
  const stopped = await f.send("/api/agent-runs/interrupt", { projectId: project.id, runId: id });
  assert.equal(stopped.status, 200); assert.equal(f.getRun(id).status, "interrupted");
  const previous = f.getRun(id); release(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(f.getRun(id), previous);
  assert.equal((await f.send("/api/agent-runs/interrupt", { projectId: project.id, runId: id })).status, 200);
  assert.equal(f.server.agentRuns.configuration().remainingCalls, 9);
});

test("a changed queued snapshot is not transmitted after another run finishes", async t => {
  let release;
  const remote = provider({ invoke: async ({ run }) => { if (!release) await new Promise(resolve => { release = resolve; }); return { proposal: proposalFor(run), platformRequestId: null }; } });
  const f = await fixture(t, remote); const { project, request } = seed(f.store);
  const first = await f.send("/api/agent-runs", f.start(project, request));
  await until(() => release);
  const second = await f.send("/api/agent-runs", f.start(project, request));
  f.store.command("local-user", { operationId: randomUUID(), expectedRevision: f.store.state().revision, type: "update_source", payload: { projectId: project.id, sourceId: project.sources[0].id, baseVersionId: project.sources[0].currentVersionId, content: "队列等待时已更新。" } });
  release(); await f.complete(first.body.result.entityId);
  const queued = await f.complete(second.body.result.entityId); assert.equal(queued.status, "interrupted"); assert.equal(queued.invocation, null); assert.equal(remote.calls, 1);
});

test("persisted attempts survive restart and active records recover without automatic re-dispatch", async t => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-agent-restart-")); const file = join(dir, "state.json");
  let store = new WorkspaceStore(file); let manager;
  t.after(async () => { await manager?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { project, request } = seed(store);
  const saved = store.command("local-user", { operationId: randomUUID(), expectedRevision: store.state().revision, type: "create_agent_run", payload: { projectId: project.id, request, provider: "contract-test", authorizeCloud: true } });
  const now = new Date().toISOString();
  store.transitionAgentRun("local-user", project.id, saved.result.entityId, { status: "running", message: "合成调用开始。", invocation: { requestId: randomUUID(), sessionId: randomUUID(), runtimeName: "synthetic-runtime", applicationVersion: null, startedAt: now, platformRequestId: null } }, { now });
  store.close(); store = new WorkspaceStore(file);
  const remote = provider({ maxCalls: 1 }); manager = new AgentRuns(store, { provider: remote });
  assert.equal(store.state().projects[0].agentRuns[0].status, "interrupted"); assert.equal(remote.calls, 0);
  assert.equal(manager.configuration().remainingCalls, 0);
  const next = manager.start("local-user", { operationId: randomUUID(), expectedRevision: store.state().revision, projectId: project.id, request, authorizeCloud: true });
  assert.equal(next.state.projects[0].agentRuns.at(-1).status, "blocked"); assert.equal(remote.calls, 0);
});

test("replaying a blocked request after configuration changes never upgrades its old authorization", async t => {
  const remote = provider(); let configured = false;
  const original = remote.status; remote.status = () => ({ ...original(), configured, code: configured ? "CONTRACT_TEST_ONLY" : "AGENTARTS_DISABLED" });
  const f = await fixture(t, remote); const { project, request } = seed(f.store);
  const input = f.start(project, request, false);
  const first = await f.send("/api/agent-runs", input); assert.equal(f.getRun(first.body.result.entityId).status, "blocked");
  configured = true;
  const replay = await f.send("/api/agent-runs", input);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(remote.calls, 0);
  assert.equal(f.getRun(first.body.result.entityId).authorization.cloudTransfer, false);
});

test("failed blocked persistence suspends dispatch, preserves the queued request and permits restart recovery", async t => {
  const disabled = createAgentArtsProvider({ env: {} }); const f = await fixture(t, disabled); const { project, request } = seed(f.store);
  const persist = f.store.persist.bind(f.store); let writes = 0;
  f.store.persist = doc => { writes++; if (writes > 1) throw new Error("synthetic disk failure"); return persist(doc); };
  const result = await f.send("/api/agent-runs", f.start(project, request, false));
  assert.equal(result.status, 503); assert.equal(f.server.agentRuns.configuration().configured, false);
  assert.equal(f.server.agentRuns.configuration().code, "AGENT_RUN_STORAGE_ERROR");
  assert.equal(f.store.state().projects[0].agentRuns[0].status, "queued");
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(writes, 2);
  f.store.persist = persist;
  await f.server.agentRuns.close(); assert.equal(f.store.state().projects[0].agentRuns[0].status, "interrupted");
});
