import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyCommand, applyAgentRunTransition, emptyWorkspace,
  previewReport, previewPlan, validateWorkspace,
} from "../server/domain.mjs";
import { WorkspaceStore } from "../server/store.mjs";

const NOW = "2026-10-26T01:00:00.000Z";
function fixture() {
  let sequence = 0;
  let state = emptyWorkspace();
  const options = { now: NOW, id: (kind) => `${kind}_${++sequence}` };
  const command = (type, payload = {}, owner = "alice") => {
    const result = applyCommand(state, owner, type, payload, options);
    state = result.state;
    return result;
  };
  command("load_demo");
  const projectId = state.projects[0].id;
  return {
    command, projectId, options,
    get state() { return state; },
    get project() { return state.projects.find((p) => p.id === projectId); },
  };
}
const metadata = (project, changes = {}) => ({
  projectId: project.id, title: project.title, goal: project.goal,
  deadline: project.deadline, ...changes,
});
const retained = (project) => {
  const { title, goal, deadline, archivedAt, activity, ...rest } = project;
  return rest;
};

test("editing project metadata validates inputs and preserves reports, sources and work history", () => {
  const f = fixture();
  const preview = previewReport(f.state, "alice", f.projectId, {
    title: "合成进展报告", artifactIds: [f.project.artifacts[0].id], includeTasks: true,
  });
  f.command("save_report", {
    projectId: f.projectId, request: preview.request,
    previewToken: preview.previewToken, acknowledgeWarnings: true,
  });
  const original = structuredClone(f.project);
  f.command("update_project", metadata(f.project, {
    title: "  修改后的合成项目  ", goal: "  新目标仍需实际核对  ", deadline: "2028-02-29",
    ownerId: "mallory", isDemo: false, createdAt: "2000-01-01T00:00:00.000Z",
    sources: [], reports: [], archivedAt: NOW,
  }));
  assert.equal(f.project.title, "修改后的合成项目");
  assert.equal(f.project.goal, "新目标仍需实际核对");
  assert.equal(f.project.deadline, "2028-02-29");
  assert.deepEqual(retained(f.project), retained(original));
  assert.equal(f.project.activity.length, original.activity.length + 1);
  assert.equal(f.project.reports[0].spec.project.title, original.title);
  assert.equal(f.project.reports[0].contentHash, original.reports[0].contentHash);
  f.command("update_project", metadata(f.project, { deadline: null }));
  assert.equal(f.project.deadline, null);
  validateWorkspace(f.state);
});

test("project edits reject blank, oversized or invalid calendar input without changes", () => {
  const f = fixture();
  for (const changes of [
    { title: " " }, { title: "x".repeat(121) },
    { goal: "" }, { goal: "x".repeat(2001) },
    { deadline: "2026-02-29" }, { deadline: "2026-11-31" },
    { deadline: "0000-01-01" }, { deadline: "" },
  ]) {
    const before = structuredClone(f.state);
    assert.throws(() => f.command("update_project", metadata(f.project, changes)), { code: "INVALID_INPUT" });
    assert.deepEqual(f.state, before);
  }
  assert.throws(() => f.command("update_project", metadata(f.project)), { code: "NO_CHANGES" });
});

test("all project management operations enforce ownership without leaking archived state", () => {
  const f = fixture();
  for (const type of ["update_project", "archive_project", "restore_project"]) {
    assert.throws(() => f.command(type, metadata(f.project), "mallory"), { code: "NOT_FOUND", status: 404 });
  }
  f.command("archive_project", { projectId: f.projectId });
  for (const type of ["update_project", "archive_project", "restore_project"]) {
    assert.throws(() => f.command(type, metadata(f.project), "mallory"), { code: "NOT_FOUND", status: 404 });
  }
});

test("archive and restore preserve all business records and reject new writes while archived", () => {
  const f = fixture();
  f.command("add_busy_slot", {
    projectId: f.projectId, title: "合成时间占用", kind: "busy",
    date: "2026-11-01", startTime: "09:00", endTime: "10:00",
  });
  const original = structuredClone(f.project);
  f.command("archive_project", { projectId: f.projectId });
  assert.equal(f.project.archivedAt, NOW);
  assert.deepEqual(retained(f.project), retained(original));
  for (const [type, payload] of [
    ["update_project", metadata(f.project, { title: "拒绝修改" })],
    ["add_source", { title: "拒绝写入", kind: "note", content: "未保存资料" }],
    ["set_task_status", { taskId: f.project.tasks[1].id, status: "done" }],
    ["save_checkpoint", { taskId: f.project.tasks[1].id }],
    ["run_analysis", { request: { mode: "search", sourceIds: [f.project.sources[0].id], query: "样本" } }],
    ["create_agent_run", { provider: "contract-test", authorizeCloud: true }],
  ]) {
    assert.throws(() => f.command(type, { projectId: f.projectId, ...payload }), { code: "PROJECT_ARCHIVED", status: 409 });
  }
  assert.throws(() => f.command("archive_project", { projectId: f.projectId }), { code: "NO_CHANGES" });
  f.command("restore_project", { projectId: f.projectId });
  assert.equal(f.project.archivedAt, null);
  assert.deepEqual(retained(f.project), retained(original));
  assert.throws(() => f.command("restore_project", { projectId: f.projectId }), { code: "NO_CHANGES" });
  f.command("update_project", metadata(f.project, { title: "恢复后可修改" }));
  assert.equal(f.project.title, "恢复后可修改");
});

test("archived projects keep their busy slots in cross-project planning constraints", () => {
  const f = fixture();
  f.command("add_busy_slot", {
    projectId: f.projectId, title: "已确认的合成占用", kind: "busy",
    date: "2026-11-01", startTime: "09:00", endTime: "10:00",
  });
  f.command("archive_project", { projectId: f.projectId });
  const second = f.command("load_demo");
  const other = f.state.projects.find((p) => p.id === second.result.projectId);
  const preview = previewPlan(f.state, "alice", other.id, {
    date: "2026-11-01", startTime: "09:00", endTime: "11:00",
    items: [{ taskId: other.tasks[1].id, durationMinutes: 30 }], allowDuringClass: false,
  });
  assert.equal(preview.blocks[0].startTime, "10:00");
});

test("queued and running analysis prevent archive; interruption permits it", () => {
  for (const status of ["queued", "running"]) {
    const f = fixture();
    const created = f.command("create_agent_run", {
      projectId: f.projectId, provider: "contract-test", authorizeCloud: true,
      request: { intent: "research", question: "合成记录有哪些限制？", sourceIds: [f.project.sources[0].id] },
    });
    let state = f.state;
    if (status === "running") state = applyAgentRunTransition(state, "alice", f.projectId, created.result.entityId, {
      status: "running", message: "合成运行，不调用真实平台。",
      invocation: { requestId: "synthetic-request", sessionId: "synthetic-session", runtimeName: "contract-test", applicationVersion: null, startedAt: NOW, platformRequestId: null },
    }, f.options);
    assert.throws(() => applyCommand(state, "alice", "archive_project", { projectId: f.projectId }, f.options), { code: "PROJECT_BUSY", status: 409 });
    state = applyAgentRunTransition(state, "alice", f.projectId, created.result.entityId, {
      status: "interrupted", message: "已停止合成运行等待。",
    }, f.options);
    const archived = applyCommand(state, "alice", "archive_project", { projectId: f.projectId }, f.options);
    assert.equal(archived.state.projects[0].archivedAt, NOW);
    assert.equal(archived.state.projects[0].agentRuns[0].status, "interrupted");
  }
});

test("legacy archive metadata remains optional and malformed retained timestamps are rejected", () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.project, "archivedAt"), false);
  validateWorkspace(f.state);
  for (const archivedAt of [false, "", "not-a-date", "2026-02-30T00:00:00.000Z"]) {
    const invalid = structuredClone(f.state);
    invalid.projects[0].archivedAt = archivedAt;
    assert.throws(() => validateWorkspace(invalid), { code: "INVALID_STATE" });
  }
  const valid = structuredClone(f.state);
  valid.projects[0].archivedAt = null;
  validateWorkspace(valid);
});

test("editing metadata invalidates an old report preview while saved reports remain immutable", () => {
  const f = fixture();
  const preview = previewReport(f.state, "alice", f.projectId, {
    title: "合成报告", artifactIds: [f.project.artifacts[0].id], includeTasks: false,
  });
  f.command("update_project", metadata(f.project, { goal: "新的合成研究目标" }));
  assert.throws(() => f.command("save_report", {
    projectId: f.projectId, request: preview.request,
    previewToken: preview.previewToken, acknowledgeWarnings: true,
  }), { code: "REPORT_STALE", status: 409 });
  assert.equal(f.project.reports, undefined);
});

test("project lifecycle writes survive restart, replay once and reject stale revisions", (t) => {
  const base = join(tmpdir(), "xingjian-project-lifecycle-");
  const dir = mkdtempSync(base);
  const file = join(dir, "workspace.json");
  let store = new WorkspaceStore(file);
  t.after(() => {
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(base)));
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (type, payload, operationId = randomUUID()) => ({
    operationId, type, payload, expectedRevision: store.state().revision,
  });
  const loaded = store.command("alice", send("load_demo", {}));
  const project = loaded.state.projects[0];
  const edit = send("update_project", metadata(project, { title: "持久化后的项目" }));
  store.command("alice", edit);
  const archive = send("archive_project", { projectId: project.id });
  const archived = store.command("alice", archive);
  store.close();
  store = new WorkspaceStore(file);
  assert.equal(store.state().projects[0].title, "持久化后的项目");
  assert.equal(store.state().projects[0].archivedAt, archived.state.projects[0].archivedAt);
  const replay = store.command("alice", archive);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.revision, archived.state.revision);
  const restore = send("restore_project", { projectId: project.id });
  store.command("alice", restore);
  assert.equal(store.command("alice", restore).replayed, true);
  assert.throws(() => store.command("alice", {
    ...edit, operationId: randomUUID(),
  }), { code: "REVISION_CONFLICT", status: 409 });
  assert.equal(store.command("alice", edit).replayed, true);
  assert.equal(store.state().projects[0].archivedAt, null);
});
