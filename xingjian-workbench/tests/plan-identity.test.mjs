import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand, emptyWorkspace, previewPlan, validateWorkspace,
} from "../server/domain.mjs";

function fixture() {
  let sequence = 0;
  let state = emptyWorkspace();
  const options = {
    id: (kind) => `${kind}_${++sequence}`,
    now: "2026-10-26T01:00:00.000Z",
  };
  const command = (type, payload) => {
    const result = applyCommand(state, "alice", type, payload, options);
    state = result.state;
    return result.result;
  };
  const projectId = command("create_project", {
    title: "研究行动", goal: "核对合成资料", deadline: null,
  }).projectId;
  const taskId = command("add_task", {
    projectId, title: "核对记录", claimIds: [],
  }).entityId;
  const courseProjectId = command("create_project", {
    title: "原课程项目名称", goal: "记录课程占用", deadline: null,
  }).projectId;
  const slotId = command("add_busy_slot", {
    projectId: courseProjectId, title: "合成课程", kind: "class",
    date: "2031-03-18", startTime: "09:00", endTime: "10:00",
  }).entityId;
  const preview = previewPlan(state, "alice", projectId, {
    date: "2031-03-18", startTime: "09:00", endTime: "10:00",
    items: [{ taskId, durationMinutes: 30 }], allowDuringClass: true,
  });
  command("confirm_plan", {
    projectId, request: preview.request, previewToken: preview.previewToken,
    acknowledgeClassOverlap: true,
  });
  return {
    command, projectId, courseProjectId, slotId,
    state: () => state,
    plan: () => state.projects.find((project) => project.id === projectId).plans[0],
  };
}

test("course overlap captures stable identities while project renaming preserves its historical snapshot", () => {
  const f = fixture();
  const saved = structuredClone(f.plan());
  assert.deepEqual(saved.blocks[0].classConflicts, [{
    projectId: f.courseProjectId, slotId: f.slotId,
    title: "合成课程", projectTitle: "原课程项目名称",
    startTime: "09:00", endTime: "10:00",
  }]);
  f.command("update_project", {
    projectId: f.courseProjectId, title: "修改后的课程项目名称",
    goal: "记录课程占用", deadline: null,
  });
  assert.deepEqual(f.plan(), saved);
  assert.doesNotThrow(() => validateWorkspace(f.state()));
});

test("legacy course overlaps validate without gaining invented identities", () => {
  const f = fixture();
  const legacy = structuredClone(f.state());
  const conflict = legacy.projects.find((project) => project.id === f.projectId)
    .plans[0].blocks[0].classConflicts[0];
  delete conflict.projectId;
  delete conflict.slotId;
  const before = structuredClone(legacy);
  assert.doesNotThrow(() => validateWorkspace(legacy));
  assert.deepEqual(legacy, before);
  const renamed = applyCommand(legacy, "alice", "update_project", {
    projectId: f.courseProjectId, title: "旧计划之后修改的项目名",
    goal: "记录课程占用", deadline: null,
  }, { now: "2026-10-26T02:00:00.000Z", id: () => "activity_renamed" }).state;
  assert.deepEqual(
    renamed.projects.find((project) => project.id === f.projectId).plans,
    legacy.projects.find((project) => project.id === f.projectId).plans,
  );
});

test("saved course identities must be a complete pair of valid identifiers", () => {
  const f = fixture();
  for (const change of [
    (ref) => { delete ref.projectId; },
    (ref) => { delete ref.slotId; },
    (ref) => { ref.projectId = null; },
    (ref) => { ref.slotId = ""; },
    (ref) => { ref.projectId = " padded "; },
    (ref) => { ref.slotId = "x".repeat(161); },
  ]) {
    const invalid = structuredClone(f.state());
    change(invalid.projects.find((project) => project.id === f.projectId)
      .plans[0].blocks[0].classConflicts[0]);
    assert.throws(() => validateWorkspace(invalid));
  }
});
