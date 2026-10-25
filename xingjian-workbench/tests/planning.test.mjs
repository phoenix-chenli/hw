import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyCommand,
  emptyWorkspace,
  previewPlan,
  previewReview,
  validateWorkspace,
} from "../server/domain.mjs";
import { WorkspaceStore } from "../server/store.mjs";

const DATE = "2026-10-25";

function fixture() {
  let sequence = 0;
  let state = emptyWorkspace();
  const options = {
    id: (kind) => `${kind}_${++sequence}`,
    now: "2026-10-25T01:00:00.000Z",
  };
  const command = (type, payload = {}, owner = "alice") => {
    const result = applyCommand(state, owner, type, payload, options);
    state = result.state;
    return result;
  };
  command("load_demo");
  const projectId = state.projects[0].id;
  const project = (id = projectId) => state.projects.find((p) => p.id === id);
  const taskId = project().tasks[1].id;
  const request = (overrides = {}) => ({
    date: DATE,
    startTime: "09:00",
    endTime: "12:00",
    items: [{ taskId, durationMinutes: 30 }],
    allowDuringClass: false,
    ...overrides,
  });
  const preview = (input = request(), id = projectId, owner = "alice") =>
    previewPlan(state, owner, id, input);
  const confirm = (p = preview(), acknowledgement = false, owner = "alice") =>
    command(
      "confirm_plan",
      {
        projectId: p.projectId,
        request: p.request,
        previewToken: p.previewToken,
        acknowledgeClassOverlap: acknowledgement,
      },
      owner,
    );
  const busy = (overrides = {}, id = projectId, owner = "alice") =>
    command(
      "add_busy_slot",
      {
        projectId: id,
        title: "上课",
        kind: "class",
        date: DATE,
        startTime: "09:00",
        endTime: "10:00",
        ...overrides,
      },
      owner,
    ).result.entityId;
  const checkpoint = (overrides = {}) =>
    command("save_checkpoint", {
      projectId,
      taskId,
      baseCheckpointNumber:
        project().tasks.find((t) => t.id === (overrides.taskId ?? taskId))
          .checkpoints?.length ?? 0,
      doneNote: "已核对两条样本",
      nextStep: "继续补充实际采样条件",
      blocker: "",
      evidence: null,
      ...overrides,
    });
  const update = (
    content = "第二版合成资料",
    sourceId = project().sources[0].id,
  ) =>
    command("update_source", {
      projectId,
      sourceId,
      baseVersionId: project().sources.find((s) => s.id === sourceId)
        .currentVersionId,
      content,
    });
  const review = (kind, id, fields) => {
    const p = previewReview(state, "alice", projectId, kind, id);
    return command(`review_${kind}`, {
      projectId,
      entityId: id,
      baseVersion: p.baseVersion,
      reviewToken: p.reviewToken,
      reason: "已逐项核对新版资料",
      ...fields,
    });
  };
  const reviewTaskBasis = (title) => {
    const task = project().tasks.find((t) => t.id === taskId);
    for (const claimId of task.claimIds) {
      const claim = project().claims.find((c) => c.id === claimId);
      if (claim.status === "needs_review")
        review("claim", claim.id, {
          text: claim.text,
          evidence: claim.evidence.map((e) => ({
            ...e,
            versionId: project().sources.find((s) => s.id === e.sourceId)
              .currentVersionId,
          })),
        });
    }
    if (project().tasks.find((t) => t.id === taskId).reviewRequired)
      review("task", taskId, { title: title ?? task.title });
  };
  return {
    command,
    projectId,
    project,
    taskId,
    request,
    preview,
    confirm,
    busy,
    checkpoint,
    update,
    reviewTaskBasis,
    state: () => state,
  };
}

function unchangedOnError(f, action, expected = { status: 400 }) {
  const before = structuredClone(f.state());
  assert.throws(action, expected);
  assert.deepEqual(f.state(), before);
}

function extraProject(f, owner = "alice") {
  return f.command(
    "create_project",
    { title: `${owner}的其他项目`, goal: "核对同日安排", deadline: null },
    owner,
  ).result.projectId;
}

function extraTask(f, projectId, owner = "alice", title = "另一项行动") {
  return f.command("add_task", { projectId, title, claimIds: [] }, owner).result
    .entityId;
}

test("plan preview is read-only, deterministic and explicitly uses Shanghai wall-clock time", () => {
  const f = fixture();
  const before = structuredClone(f.state());
  const p = f.preview();
  assert.equal(p.timezone, "Asia/Shanghai");
  assert.match(p.previewToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    p.blocks.map((b) => [b.taskId, b.startTime, b.endTime]),
    [[f.taskId, "09:00", "09:30"]],
  );
  assert.equal(p.blocks[0].taskVersion, 1);
  assert.equal(p.blocks[0].checkpointNumber, 0);
  assert.deepEqual(p.blocks[0].sourceVersions, [
    {
      sourceId: f.project().sources[0].id,
      versionId: f.project().sources[0].currentVersionId,
    },
  ]);
  assert.deepEqual(f.preview(), p);
  p.request.items[0].durationMinutes = 100;
  p.blocks[0].sourceVersions[0].versionId = "external-change";
  assert.deepEqual(f.state(), before);
  assert.equal(f.project().plans, undefined);
});

test("date and time validation rejects impossible days, overnight windows and non-normalized inputs", () => {
  const f = fixture();
  for (const overrides of [
    { date: "2026-02-29" },
    { date: "2026-04-31" },
    { date: "0000-01-01" },
    { date: "2026-1-01" },
    { date: "2026-10-25T00:00:00Z" },
    { date: " 2026-10-25" },
    { startTime: "24:00" },
    { startTime: "9:00" },
    { endTime: "10:60" },
    { startTime: "20:00", endTime: "02:00" },
    { endTime: "09:00" },
    { startTime: "00:00", endTime: "12:01" },
    { allowDuringClass: "true" },
  ])
    unchangedOnError(f, () => f.preview(f.request(overrides)));
  for (const date of ["2024-02-29", "2000-02-29", "0001-01-01", "2020-10-25"]) {
    assert.equal(f.preview(f.request({ date })).request.date, date);
  }
  for (const overrides of [
    { date: "1900-02-29" },
    { date: "2026-11-31" },
    { startTime: "17:00", endTime: "09:00" },
    { endTime: "09:00" },
    { kind: "holiday" },
  ]) {
    unchangedOnError(f, () => f.busy(overrides));
  }
});

test("planning is independent of the execution host timezone including DST dates", () => {
  const domainUrl = new URL("../server/domain.mjs", import.meta.url).href;
  const program = `import {applyCommand,emptyWorkspace,previewPlan} from ${JSON.stringify(domainUrl)}; let n=0; const state=applyCommand(emptyWorkspace(),'alice','load_demo',{}, {now:'2026-10-25T01:00:00.000Z',id:k=>k+'_'+(++n)}).state; const p=state.projects[0]; console.log(JSON.stringify(previewPlan(state,'alice',p.id,{date:'2026-03-08',startTime:'01:30',endTime:'03:30',items:[{taskId:p.tasks[1].id,durationMinutes:120}],allowDuringClass:false})));`;
  const results = ["UTC", "America/New_York", "Asia/Shanghai"].map((TZ) => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program],
      { env: { ...process.env, TZ }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.equal(results[0].blocks[0].endTime, "03:30");
});

test("planner rejects duplicate, oversized and foreign task inputs without mutating the workspace", () => {
  const f = fixture();
  const p2 = extraProject(f),
    foreignTask = extraTask(f, p2);
  for (const durationMinutes of [0, 4, 7, 241, 30.5, "30"])
    unchangedOnError(f, () =>
      f.preview(f.request({ items: [{ taskId: f.taskId, durationMinutes }] })),
    );
  unchangedOnError(f, () =>
    f.preview(
      f.request({
        items: [
          { taskId: f.taskId, durationMinutes: 30 },
          { taskId: f.taskId, durationMinutes: 15 },
        ],
      }),
    ),
  );
  unchangedOnError(f, () => f.preview(f.request({ items: [] })));
  unchangedOnError(f, () =>
    f.preview(
      f.request({
        items: Array.from({ length: 13 }, (_, i) => ({
          taskId: `missing-${i}`,
          durationMinutes: 5,
        })),
      }),
    ),
  );
  unchangedOnError(
    f,
    () =>
      f.preview(
        f.request({ items: [{ taskId: foreignTask, durationMinutes: 30 }] }),
      ),
    { status: 404 },
  );
  unchangedOnError(f, () => f.preview(f.request(), f.projectId, "bob"), {
    status: 404,
  });
  unchangedOnError(
    f,
    () =>
      f.command("save_checkpoint", {
        projectId: f.projectId,
        taskId: foreignTask,
        baseCheckpointNumber: 0,
        nextStep: "下一步",
        doneNote: "",
        blocker: "",
        evidence: null,
      }),
    { status: 404 },
  );
  unchangedOnError(
    f,
    () =>
      f.command(
        "add_busy_slot",
        {
          projectId: f.projectId,
          title: "他人尝试",
          kind: "busy",
          date: DATE,
          startTime: "09:00",
          endTime: "10:00",
        },
        "bob",
      ),
    { status: 404 },
  );
});

test("same-owner cross-project busy slots and confirmed plans block time while other owners do not", () => {
  const f = fixture();
  const p2 = extraProject(f),
    t2 = extraTask(f, p2);
  const p3 = extraProject(f, "bob"),
    t3 = extraTask(f, p3, "bob");
  f.busy(
    {
      kind: "busy",
      title: "同用户其他项目占用",
      startTime: "09:00",
      endTime: "10:00",
    },
    p2,
  );
  f.confirm(
    f.preview(f.request({ items: [{ taskId: t2, durationMinutes: 30 }] }), p2),
  );
  const p = f.preview();
  assert.equal(p.blocks[0].startTime, "10:30");
  assert.equal(p.blocks[0].endTime, "11:00");
  f.busy(
    {
      kind: "busy",
      title: "另一用户隐私日程",
      startTime: "09:00",
      endTime: "12:00",
    },
    p3,
    "bob",
  );
  f.confirm(
    f.preview(
      f.request({
        startTime: "12:00",
        endTime: "13:00",
        items: [{ taskId: t3, durationMinutes: 30 }],
      }),
      p3,
      "bob",
    ),
    false,
    "bob",
  );
  assert.deepEqual(f.preview(), p);
  assert.doesNotMatch(JSON.stringify(p), /另一用户隐私/);
});

test("overlapping busy spans are respected and a later smaller item may fit when an earlier one cannot", () => {
  const f = fixture();
  const small = extraTask(f, f.projectId);
  f.busy({ kind: "busy", startTime: "09:20", endTime: "10:00" });
  f.busy({ kind: "busy", startTime: "09:50", endTime: "10:20" });
  const p = f.preview(
    f.request({
      endTime: "10:30",
      items: [
        { taskId: f.taskId, durationMinutes: 45 },
        { taskId: small, durationMinutes: 20 },
      ],
    }),
  );
  assert.deepEqual(
    p.blocks.map((b) => [b.taskId, b.startTime, b.endTime]),
    [[small, "09:00", "09:20"]],
  );
  assert.equal(p.unplaced.length, 1);
  assert.equal(p.unplaced[0].taskId, f.taskId);
  assert.ok(p.unplaced[0].reason.trim());
  const saved = f.confirm(p);
  assert.deepEqual(f.project().plans[0].unplaced, p.unplaced);
  assert.equal(saved.result.entityId, f.project().plans[0].id);
});

test("done and review-pending tasks remain visible as unplaced and cannot produce an empty confirmation", () => {
  const f = fixture();
  const doneTaskId = f.project().tasks[2].id;
  f.command("set_task_status", {
    projectId: f.projectId,
    taskId: doneTaskId,
    status: "done",
  });
  f.update();
  const p = f.preview(
    f.request({
      items: [
        { taskId: doneTaskId, durationMinutes: 20 },
        { taskId: f.taskId, durationMinutes: 30 },
      ],
    }),
  );
  assert.equal(p.blocks.length, 0);
  assert.equal(p.unplaced.length, 2);
  assert.ok(p.unplaced.every((item) => item.reason.trim()));
  assert.notEqual(p.unplaced[0].reason, p.unplaced[1].reason);
  unchangedOnError(f, () => f.confirm(p), { code: "EMPTY_PLAN", status: 400 });
});

test("class-time scheduling is explicit opt-in and requires acknowledgement only for actual overlap", () => {
  const f = fixture();
  const p2 = extraProject(f);
  f.busy({ title: "跨项目课程", startTime: "09:00", endTime: "10:00" }, p2);
  f.busy({
    kind: "busy",
    title: "不可移动会议",
    startTime: "09:15",
    endTime: "09:45",
  });
  assert.equal(f.preview().blocks[0].startTime, "10:00");
  const p = f.preview(f.request({ allowDuringClass: true }));
  assert.equal(p.blocks[0].startTime, "09:45");
  assert.equal(p.blocks[0].endTime, "10:15");
  assert.equal(p.blocks[0].classConflicts.length, 1);
  assert.equal(p.blocks[0].classConflicts[0].title, "跨项目课程");
  assert.equal(p.blocks[0].classConflicts[0].projectTitle, f.project(p2).title);
  unchangedOnError(f, () => f.confirm(p), {
    code: "CLASS_OVERLAP_ACK_REQUIRED",
    status: 400,
  });
  const tasksBefore = structuredClone(f.project().tasks);
  f.confirm(p, true);
  assert.deepEqual(f.project().tasks, tasksBefore);
  const next = f.preview(f.request({ allowDuringClass: true }));
  assert.equal(
    next.blocks[0].startTime,
    "10:15",
    "confirmed plans cannot be bypassed by the class switch",
  );
  assert.deepEqual(next.blocks[0].classConflicts, []);
  f.confirm(next, false);
});

test("deactivating a busy interval and cancelling a plan free time without deleting historical records", () => {
  const f = fixture();
  const slotId = f.busy();
  const earliest = f.preview();
  assert.equal(earliest.blocks[0].startTime, "10:00");
  f.command("deactivate_busy_slot", { projectId: f.projectId, slotId });
  assert.equal(f.project().busySlots[0].active, false);
  assert.equal(f.preview().blocks[0].startTime, "09:00");
  f.confirm();
  const before = structuredClone(f.project().plans[0]);
  assert.equal(f.preview().blocks[0].startTime, "09:30");
  const tasksBefore = structuredClone(f.project().tasks);
  f.command("cancel_plan", { projectId: f.projectId, planId: before.id });
  assert.deepEqual(f.project().plans[0], { ...before, status: "cancelled" });
  assert.equal(f.preview().blocks[0].startTime, "09:00");
  assert.deepEqual(f.project().tasks, tasksBefore);
  unchangedOnError(
    f,
    () =>
      f.command("cancel_plan", { projectId: f.projectId, planId: before.id }),
    { code: "NO_CHANGES", status: 400 },
  );
  const p2 = extraProject(f);
  unchangedOnError(
    f,
    () => f.command("cancel_plan", { projectId: p2, planId: before.id }),
    { status: 404 },
  );
  unchangedOnError(
    f,
    () => f.command("deactivate_busy_slot", { projectId: p2, slotId }),
    { status: 404 },
  );
});

test("preview tokens become stale after relevant progress, checkpoints, source or calendar changes", () => {
  for (const mutation of [
    (f) =>
      f.command("set_task_status", {
        projectId: f.projectId,
        taskId: f.taskId,
        status: "doing",
      }),
    (f) => f.checkpoint(),
    (f) => f.update(),
    (f) => f.busy(),
    (f) => {
      const id = extraProject(f);
      f.busy({ kind: "busy" }, id);
    },
    (f) => {
      const id = extraProject(f),
        taskId = extraTask(f, id);
      f.confirm(
        f.preview(f.request({ items: [{ taskId, durationMinutes: 15 }] }), id),
      );
    },
  ]) {
    const f = fixture(),
      p = f.preview();
    mutation(f);
    unchangedOnError(f, () => f.confirm(p), {
      code: "PLAN_STALE",
      status: 409,
    });
  }
});

test("round-trip source edits and completed review do not resurrect a stale preview token", () => {
  const f = fixture();
  const p = f.preview();
  const oldContent = f.project().sources[0].versions[0].content;
  f.update("中间版合成内容");
  f.update(oldContent);
  f.reviewTaskBasis();
  assert.equal(
    f.project().tasks.find((t) => t.id === f.taskId).reviewRequired,
    false,
  );
  unchangedOnError(f, () => f.confirm(p), { code: "PLAN_STALE", status: 409 });
  const latest = f.preview();
  assert.notEqual(latest.previewToken, p.previewToken);
  assert.equal(
    latest.blocks[0].sourceVersions[0].versionId,
    f.project().sources[0].currentVersionId,
  );
  f.confirm(latest);
});

test("past confirmed plans remain intact when task content, source basis and checkpoints change", () => {
  const f = fixture();
  f.checkpoint();
  f.confirm();
  const oldPlan = structuredClone(f.project().plans[0]);
  f.update();
  f.reviewTaskBasis("根据新版资料重新描述的行动");
  f.checkpoint({ nextStep: "核对修订后的采样条件" });
  f.command("set_task_status", {
    projectId: f.projectId,
    taskId: f.taskId,
    status: "done",
  });
  assert.deepEqual(f.project().plans[0], oldPlan);
  assert.equal(oldPlan.blocks[0].taskVersion, 1);
  assert.equal(oldPlan.blocks[0].checkpointNumber, 1);
  assert.notEqual(
    oldPlan.blocks[0].sourceVersions[0].versionId,
    f.project().sources[0].currentVersionId,
  );
  assert.equal(validateWorkspace(f.state()), f.state());
});

test("checkpoint history preserves progress, pending review and historical evidence without reopening tasks", () => {
  const f = fixture();
  const doneTask = f.project().tasks[0];
  const evidence = {
    sourceId: f.project().sources[0].id,
    versionId: f.project().sources[0].currentVersionId,
  };
  f.update();
  f.checkpoint({ taskId: doneTask.id, evidence, nextStep: "稍后核对新版内容" });
  let task = f.project().tasks.find((t) => t.id === doneTask.id);
  assert.equal(task.status, "done");
  assert.equal(task.reviewRequired, true);
  assert.deepEqual(task.checkpoints[0], {
    number: 1,
    recordedAt: "2026-10-25T01:00:00.000Z",
    taskVersion: 1,
    doneNote: "已核对两条样本",
    nextStep: "稍后核对新版内容",
    blocker: "",
    evidence,
  });
  f.checkpoint({
    taskId: doneTask.id,
    doneNote: "仅补充记录",
    nextStep: "查找剩余数据",
    blocker: "缺少采样条件",
  });
  task = f.project().tasks.find((t) => t.id === doneTask.id);
  assert.equal(task.checkpoints.length, 2);
  assert.equal(task.status, "done");
  assert.equal(task.reviewRequired, true);
  assert.deepEqual(task.checkpoints[0].evidence, evidence);
  f.reviewTaskBasis();
  f.checkpoint();
  assert.equal(
    f.project().tasks.find((t) => t.id === f.taskId).checkpoints[0].taskVersion,
    2,
  );
});

test("checkpoint writes require current base, nonblank next step and valid same-project historical references", () => {
  const f = fixture();
  f.checkpoint();
  unchangedOnError(
    f,
    () => f.checkpoint({ baseCheckpointNumber: 0, nextStep: "旧页面覆盖" }),
    { code: "CHECKPOINT_CONFLICT", status: 409 },
  );
  for (const value of [
    { nextStep: " " },
    { nextStep: "a".repeat(1001) },
    { doneNote: "a".repeat(2001) },
    { blocker: "a".repeat(1001) },
    { baseCheckpointNumber: 1.5 },
    { evidence: { sourceId: f.project().sources[0].id, versionId: "missing" } },
  ])
    unchangedOnError(f, () => f.checkpoint(value));
  const p2 = extraProject(f);
  const sourceId = f.command("add_source", {
    projectId: p2,
    title: "其他项目资料",
    kind: "note",
    content: "不可跨项目引用",
  }).result.entityId;
  unchangedOnError(f, () =>
    f.checkpoint({
      evidence: {
        sourceId,
        versionId: f.project(p2).sources[0].currentVersionId,
      },
    }),
  );
  unchangedOnError(
    f,
    () =>
      f.command(
        "save_checkpoint",
        {
          projectId: f.projectId,
          taskId: f.taskId,
          baseCheckpointNumber: 1,
          doneNote: "",
          nextStep: "其他用户尝试",
          blocker: "",
          evidence: null,
        },
        "bob",
      ),
    { status: 404 },
  );
});

test("validation retains legacy records but rejects corrupt checkpoint histories and plan snapshots", () => {
  const f = fixture();
  const legacy = structuredClone(f.state());
  validateWorkspace(legacy);
  assert.equal(legacy.projects[0].plans, undefined);
  assert.equal(legacy.projects[0].busySlots, undefined);
  assert.equal(legacy.projects[0].tasks[1].checkpoints, undefined);
  f.checkpoint();
  f.confirm();
  const clean = structuredClone(f.state());
  const mutations = [
    (p) => {
      p.tasks[1].checkpoints[0].number = 2;
    },
    (p) => {
      p.tasks[1].checkpoints[0].taskVersion = 999;
    },
    (p) => {
      p.tasks[1].checkpoints[0].nextStep = "";
    },
    (p) => {
      p.tasks[1].checkpoints[0].recordedAt = "not-a-date";
    },
    (p) => {
      p.plans[0].blocks[0].checkpointNumber = 999;
    },
    (p) => {
      p.plans[0].blocks[0].taskVersion = 999;
    },
    (p) => {
      p.plans[0].blocks[0].sourceVersions[0].versionId = "missing";
    },
    (p) => {
      p.plans[0].blocks[0].durationMinutes += 5;
    },
    (p) => {
      p.plans[0].blocks[0].endTime = "13:00";
    },
    (p) => {
      p.plans[0].previewToken = "fake";
    },
    (p) => {
      p.plans[0].timezone = "America/New_York";
    },
    (p) => {
      p.plans[0].id = p.tasks[1].id;
    },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(clean);
    mutate(broken.projects[0]);
    assert.throws(() => validateWorkspace(broken), {
      code: "INVALID_STATE",
      status: 400,
    });
  }
});

test("persisted checkpoints and plans survive restart, lost-response retries and accepted analysis history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-planning-store-"));
  const file = join(dir, "workspace.json");
  let store = new WorkspaceStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let sequence = 0;
  const envelope = (type, payload) => ({
    operationId: `planning-store-${++sequence}`,
    expectedRevision: store.state().revision,
    type,
    payload,
  });
  const commit = (type, payload) =>
    store.command("alice", envelope(type, payload));
  const projectId = commit("create_project", {
    title: "持久化研究",
    goal: "验证真实本地记录",
    deadline: null,
  }).result.projectId;
  const sourceId = commit("add_source", {
    projectId,
    title: "样本表",
    kind: "table",
    content: "值\n1\n2",
  }).result.entityId;
  const analysisId = commit("run_analysis", {
    projectId,
    request: {
      mode: "calculate",
      sourceIds: [sourceId],
      column: "值",
      operation: "sum",
    },
  }).result.entityId;
  commit("accept_analysis", {
    projectId,
    analysisId,
    claimIds: ["claim-1"],
    taskIds: ["task-review"],
  });
  const taskId = store.state().projects[0].tasks[0].id;
  const originalAnalysis = structuredClone(
    store.state().projects[0].analyses[0],
  );
  const checkpointCommand = envelope("save_checkpoint", {
    projectId,
    taskId,
    baseCheckpointNumber: 0,
    doneNote: "已查看样本",
    nextStep: "继续补充采样依据",
    blocker: "",
    evidence: {
      sourceId,
      versionId: store.state().projects[0].sources[0].currentVersionId,
    },
  });
  const savedCheckpoint = store.command("alice", checkpointCommand);
  const request = {
    date: DATE,
    startTime: "09:00",
    endTime: "12:00",
    items: [{ taskId, durationMinutes: 30 }],
    allowDuringClass: false,
  };
  const preview = previewPlan(store.state(), "alice", projectId, request);
  const planCommand = envelope("confirm_plan", {
    projectId,
    request,
    previewToken: preview.previewToken,
    acknowledgeClassOverlap: false,
    blocks: [
      { taskId, title: "客户端伪造时间", startTime: "00:00", endTime: "00:01" },
    ],
  });
  commit("set_task_status", { projectId, taskId, status: "doing" });
  assert.throws(() => store.command("alice", planCommand), {
    code: "REVISION_CONFLICT",
    status: 409,
  });
  assert.throws(
    () =>
      store.command("alice", {
        ...planCommand,
        expectedRevision: store.state().revision,
      }),
    { code: "PLAN_STALE", status: 409 },
  );
  const latest = previewPlan(store.state(), "alice", projectId, request);
  const retryable = envelope("confirm_plan", {
    ...planCommand.payload,
    previewToken: latest.previewToken,
  });
  const savedPlan = store.command("alice", retryable);
  const beforeRestart = store.state();
  store.close();
  store = new WorkspaceStore(file);
  assert.deepEqual(store.state(), beforeRestart);
  assert.equal(store.command("alice", checkpointCommand).replayed, true);
  const replayed = store.command("alice", retryable);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.result, savedPlan.result);
  assert.equal(store.state().projects[0].tasks[0].checkpoints.length, 1);
  assert.equal(store.state().projects[0].plans.length, 1);
  assert.equal(store.state().projects[0].plans[0].blocks[0].startTime, "09:00");
  assert.equal(
    store.state().projects[0].plans[0].blocks[0].title,
    beforeRestart.projects[0].tasks[0].title,
  );
  assert.equal(savedCheckpoint.result.entityId, taskId);
  assert.deepEqual(store.state().projects[0].analyses[0], originalAnalysis);
  const oldPlan = structuredClone(store.state().projects[0].plans[0]);
  commit("update_source", {
    projectId,
    sourceId,
    baseVersionId: store.state().projects[0].sources[0].currentVersionId,
    content: "值\n2\n3",
  });
  assert.equal(store.state().projects[0].tasks[0].reviewRequired, true);
  store.close();
  store = new WorkspaceStore(file);
  assert.deepEqual(store.state().projects[0].plans[0], oldPlan);
  assert.deepEqual(store.state().projects[0].analyses[0], originalAnalysis);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).operations.filter(
      (op) => op.id === retryable.operationId,
    ).length,
    1,
  );
});
