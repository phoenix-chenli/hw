import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  DomainError,
  emptyWorkspace,
  previewSourceUpdate,
  validateWorkspace,
} from "../server/domain.mjs";

function fixture() {
  let sequence = 0;
  const options = {
    now: () => "2026-10-23T08:00:00.000Z",
    id: (kind) => `${kind}_${++sequence}`,
  };
  const run = (state, type, payload = {}, owner = "alice") =>
    applyCommand(state, owner, type, payload, options);
  const loaded = run(emptyWorkspace(), "load_demo");
  return { run, state: loaded.state, project: loaded.state.projects[0] };
}

function rejectsDomain(fn, status = 400, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

test("an empty workspace is a valid independent value", () => {
  const first = emptyWorkspace();
  assert.deepEqual(first, { schemaVersion: 1, revision: 0, projects: [] });
  assert.equal(validateWorkspace(first), first);
  first.projects.push({});
  assert.deepEqual(emptyWorkspace().projects, []);
});

test("demo explicitly uses synthetic data and includes unrelated dependency paths", () => {
  const { state, project } = fixture();
  assert.equal(state.revision, 1);
  assert.equal(project.isDemo, true);
  assert.match(project.goal, /合成数据/);
  assert.equal(project.sources.length, 2);
  assert.ok(
    project.sources.every((source) => /合成/.test(source.versions[0].content)),
  );
  assert.notEqual(
    project.claims[0].evidence[0].sourceId,
    project.claims[1].evidence[0].sourceId,
  );
  validateWorkspace(state);
});

test("project creation trims inputs and does not accept payload owner or demo markers", () => {
  const { run } = fixture();
  const input = frozen(emptyWorkspace());
  const result = run(input, "create_project", {
    title: "  课程研究  ",
    goal: " 验证采样口径 ",
    deadline: "2028-02-29",
    ownerId: "mallory",
    isDemo: true,
  });
  assert.equal(input.projects.length, 0);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.projects[0].title, "课程研究");
  assert.equal(result.state.projects[0].ownerId, "alice");
  assert.equal(result.state.projects[0].isDemo, false);
  assert.equal(result.result.projectId, result.state.projects[0].id);
});

test("preview is pure, is limited to known dependency links, and preserves completed task progress", () => {
  const { state, project } = fixture();
  const before = JSON.stringify(state);
  frozen(state);
  const source = project.sources[0];
  const preview = previewSourceUpdate(
    state,
    "alice",
    project.id,
    source.id,
    "修改后的合成数据：A=55，B=45。",
  );
  assert.equal(preview.baseVersionId, source.currentVersionId);
  assert.equal(preview.nextVersionNumber, 2);
  assert.deepEqual(
    preview.claims.map((entry) => entry.id),
    [project.claims[0].id],
  );
  assert.deepEqual(
    preview.tasks.map((entry) => entry.id),
    project.tasks.slice(0, 2).map((entry) => entry.id),
  );
  assert.deepEqual(
    preview.artifacts.map((entry) => entry.id),
    [project.artifacts[0].id],
  );
  assert.equal(project.tasks[0].status, "done");
  preview.claims[0].title = "attempted mutation";
  assert.equal(JSON.stringify(state), before);
});

test("confirmed source changes preserve history and original evidence, flag only linked records", () => {
  const { run, state, project } = fixture();
  const snapshot = structuredClone(state);
  const source = project.sources[0];
  frozen(state);
  const result = run(state, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "更新后的合成样例内容",
  });
  const changed = result.state.projects[0];
  assert.deepEqual(state, snapshot);
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(changed.sources[0].versions.length, 2);
  assert.deepEqual(changed.sources[0].versions[0], source.versions[0]);
  assert.equal(
    changed.sources[0].currentVersionId,
    changed.sources[0].versions[1].id,
  );
  assert.deepEqual(changed.claims[0].evidence, project.claims[0].evidence);
  assert.equal(changed.claims[0].status, "needs_review");
  assert.deepEqual(changed.claims[1], project.claims[1]);
  assert.equal(changed.tasks[0].status, "done");
  assert.equal(changed.tasks[0].reviewRequired, true);
  assert.equal(changed.tasks[1].status, "todo");
  assert.equal(changed.tasks[1].reviewRequired, true);
  assert.deepEqual(changed.tasks[2], project.tasks[2]);
  assert.equal(changed.artifacts[0].status, "needs_review");
  assert.equal(changed.artifacts[0].content, project.artifacts[0].content);
  assert.deepEqual(changed.artifacts[1], project.artifacts[1]);
  assert.equal(result.result.entityId, source.id);
  assert.equal(changed.activity.length, project.activity.length + 1);
  validateWorkspace(result.state);
});

test("a second source revision still tracks claims referencing the oldest version", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  const first = run(state, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "第二版合成内容",
  }).state;
  const preview = previewSourceUpdate(
    first,
    "alice",
    project.id,
    source.id,
    "第三版合成内容",
  );
  assert.equal(preview.claims.length, 1);
  const second = run(first, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: preview.baseVersionId,
    content: preview.nextContent,
  }).state;
  assert.equal(second.projects[0].sources[0].versions.length, 3);
  assert.equal(
    second.projects[0].claims[0].evidence[0].versionId,
    source.currentVersionId,
  );
  validateWorkspace(second);
});

test("stale confirmation is rejected without changing any state", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  const payload = {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "第二版",
  };
  const next = run(state, "update_source", payload).state;
  const snapshot = structuredClone(next);
  rejectsDomain(
    () =>
      run(next, "update_source", {
        ...payload,
        content: "使用过期预览提交第三版",
      }),
    409,
    "VERSION_CONFLICT",
  );
  assert.deepEqual(next, snapshot);
});

test("manually completing or reopening a task does not remove reviewRequired", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  const changed = run(state, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "新版本",
  }).state;
  const done = run(changed, "set_task_status", {
    projectId: project.id,
    taskId: project.tasks[1].id,
    status: "done",
  }).state;
  assert.equal(done.projects[0].tasks[1].status, "done");
  assert.equal(done.projects[0].tasks[1].reviewRequired, true);
  const reopened = run(done, "set_task_status", {
    projectId: project.id,
    taskId: project.tasks[1].id,
    status: "doing",
  }).state;
  assert.equal(reopened.projects[0].tasks[1].status, "doing");
  assert.equal(reopened.projects[0].tasks[1].reviewRequired, true);
});

test("cross-owner preview and commands are denied without exposing project existence", () => {
  const { run, state, project } = fixture();
  rejectsDomain(
    () =>
      previewSourceUpdate(
        state,
        "bob",
        project.id,
        project.sources[0].id,
        "changed",
      ),
    404,
    "NOT_FOUND",
  );
  const cases = [
    ["add_source", { title: "x", kind: "note", content: "x" }],
    ["add_claim", { text: "x", evidence: project.claims[0].evidence }],
    ["add_task", { title: "x", claimIds: [] }],
    ["add_artifact", { title: "x", content: "x", claimIds: [] }],
    [
      "update_source",
      {
        sourceId: project.sources[0].id,
        baseVersionId: project.sources[0].currentVersionId,
        content: "x",
      },
    ],
    ["set_task_status", { taskId: project.tasks[0].id, status: "todo" }],
  ];
  for (const [type, payload] of cases)
    rejectsDomain(
      () =>
        run(
          state,
          type,
          { ...payload, projectId: project.id, ownerId: "alice" },
          "bob",
        ),
      404,
      "NOT_FOUND",
    );
  rejectsDomain(
    () =>
      run(state, "add_task", {
        projectId: "missing",
        title: "x",
        claimIds: [],
      }),
    404,
    "NOT_FOUND",
  );
});

test("same-owner projects cannot borrow source, version, task, or claim identities", () => {
  const { run, state, project } = fixture();
  const created = run(state, "load_demo");
  const second = created.state.projects[1];
  const shared = created.state;
  rejectsDomain(() =>
    run(shared, "add_claim", {
      projectId: project.id,
      text: "x",
      evidence: second.claims[0].evidence,
    }),
  );
  rejectsDomain(() =>
    run(shared, "add_claim", {
      projectId: project.id,
      text: "x",
      evidence: [
        {
          sourceId: project.sources[0].id,
          versionId: second.sources[0].currentVersionId,
          locator: "1",
        },
      ],
    }),
  );
  rejectsDomain(() =>
    run(shared, "add_task", {
      projectId: project.id,
      title: "x",
      claimIds: [second.claims[0].id],
    }),
  );
  rejectsDomain(() =>
    run(shared, "add_artifact", {
      projectId: project.id,
      title: "x",
      content: "x",
      claimIds: [second.claims[0].id],
    }),
  );
  rejectsDomain(
    () =>
      run(shared, "update_source", {
        projectId: project.id,
        sourceId: second.sources[0].id,
        baseVersionId: second.sources[0].currentVersionId,
        content: "x",
      }),
    404,
  );
  rejectsDomain(
    () =>
      run(shared, "set_task_status", {
        projectId: project.id,
        taskId: second.tasks[0].id,
        status: "todo",
      }),
    404,
  );
  rejectsDomain(
    () =>
      previewSourceUpdate(
        shared,
        "alice",
        project.id,
        second.sources[0].id,
        "x",
      ),
    404,
  );
});

test("adding records respects explicit historical references and propagates existing review status", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  let next = run(state, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "新数据",
  }).state;
  let result = run(next, "add_claim", {
    projectId: project.id,
    text: "依据旧版本补充说明",
    evidence: project.claims[0].evidence,
  });
  const historicalId = result.result.entityId;
  next = result.state;
  assert.equal(next.projects[0].claims.at(-1).status, "needs_review");
  result = run(next, "add_task", {
    projectId: project.id,
    title: "核对旧版说明",
    claimIds: [historicalId],
  });
  next = result.state;
  assert.equal(next.projects[0].tasks.at(-1).reviewRequired, true);
  result = run(next, "add_artifact", {
    projectId: project.id,
    title: "旧版说明草稿",
    content: "待核对，不作为正式结论。",
    claimIds: [historicalId],
  });
  next = result.state;
  assert.equal(next.projects[0].artifacts.at(-1).status, "needs_review");
  const current = next.projects[0].sources[0];
  result = run(next, "add_claim", {
    projectId: project.id,
    text: "当前版本说明",
    evidence: [
      {
        sourceId: current.id,
        versionId: current.currentVersionId,
        locator: "第 1 段",
      },
    ],
  });
  assert.equal(result.state.projects[0].claims.at(-1).status, "linked");
});

test("new source and standalone task/artifact can be added with immutable payloads", () => {
  const { run, state, project } = fixture();
  let result = run(
    state,
    "add_source",
    frozen({
      projectId: project.id,
      title: "  手动记录  ",
      kind: "note",
      content: " 手动输入资料 ",
    }),
  );
  assert.equal(result.state.projects[0].sources.at(-1).title, "手动记录");
  assert.equal(
    result.state.projects[0].sources.at(-1).versions[0].content,
    "手动输入资料",
  );
  result = run(result.state, "add_task", {
    projectId: project.id,
    title: "尚未关联结论的准备工作",
    claimIds: [],
  });
  assert.equal(result.state.projects[0].tasks.at(-1).reviewRequired, false);
  result = run(result.state, "add_artifact", {
    projectId: project.id,
    title: "初始大纲",
    content: "研究目标与采样计划",
    claimIds: [],
  });
  assert.equal(result.state.projects[0].artifacts.at(-1).status, "draft");
});

test("empty, unchanged, or whitespace-only source edits are rejected", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  for (const content of [
    "",
    " \n ",
    null,
    12,
    {},
    source.versions[0].content,
    `  ${source.versions[0].content}\n`,
  ]) {
    rejectsDomain(() =>
      previewSourceUpdate(state, "alice", project.id, source.id, content),
    );
    rejectsDomain(() =>
      run(state, "update_source", {
        projectId: project.id,
        sourceId: source.id,
        baseVersionId: source.currentVersionId,
        content,
      }),
    );
  }
  assert.equal(state.revision, 1);
  assert.equal(project.sources[0].versions.length, 1);
});

test("deadline validation rejects normalized or ambiguous dates but accepts real leap days", () => {
  const { run } = fixture();
  for (const due of [
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-1-01",
    "2026/01/01",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
    "0000-01-01",
    "",
    undefined,
    20260101,
  ]) {
    rejectsDomain(() =>
      run(emptyWorkspace(), "create_project", {
        title: "研究",
        goal: "目标",
        deadline: due,
      }),
    );
  }
  for (const due of [null, "2024-02-29", "2028-02-29", "2026-04-30"]) {
    const result = run(emptyWorkspace(), "create_project", {
      title: "研究",
      goal: "目标",
      deadline: due,
    });
    assert.equal(result.state.projects[0].deadline, due);
  }
});

test("invalid input types, values, missing references and excessive field sizes are rejected", () => {
  const { run, state, project } = fixture();
  const cases = [
    ["create_project", { title: "", goal: "x", deadline: null }],
    ["create_project", { title: "x".repeat(121), goal: "x", deadline: null }],
    ["create_project", { title: "x", goal: "x".repeat(2001), deadline: null }],
    ["add_source", { title: "x", kind: "executable", content: "x" }],
    ["add_source", { title: "x", kind: "note", content: "x".repeat(100001) }],
    ["add_claim", { text: "x", evidence: [] }],
    [
      "add_claim",
      { text: "x".repeat(4001), evidence: project.claims[0].evidence },
    ],
    [
      "add_claim",
      {
        text: "x",
        evidence: [{ ...project.claims[0].evidence[0], locator: "" }],
      },
    ],
    [
      "add_claim",
      {
        text: "x",
        evidence: [{ ...project.claims[0].evidence[0], versionId: "missing" }],
      },
    ],
    [
      "add_claim",
      {
        text: "x",
        evidence: [
          ...project.claims[0].evidence,
          ...project.claims[0].evidence,
        ],
      },
    ],
    ["add_task", { title: "x", claimIds: ["missing"] }],
    [
      "add_task",
      { title: "x", claimIds: [project.claims[0].id, project.claims[0].id] },
    ],
    ["add_artifact", { title: "x", content: " ", claimIds: [] }],
    ["set_task_status", { taskId: project.tasks[0].id, status: "verified" }],
    ["set_task_status", { taskId: project.tasks[0].id, status: "done" }],
  ];
  for (const [type, payload] of cases)
    rejectsDomain(() =>
      run(state, type, { projectId: project.id, ...payload }),
    );
  rejectsDomain(() => run(state, "unknown", {}), 400, "UNKNOWN_COMMAND");
  rejectsDomain(() => run(state, "load_demo", []));
  rejectsDomain(() => run(state, "load_demo", {}, ""));
});

test("persisted workspace validation rejects malformed structures and dangling relationships", () => {
  const { state } = fixture();
  const corruptions = [
    (s) => {
      s.schemaVersion = 2;
    },
    (s) => {
      s.revision = -1;
    },
    (s) => {
      s.revision = 0.5;
    },
    (s) => {
      s.projects = {};
    },
    (s) => {
      s.projects[0].ownerId = "";
    },
    (s) => {
      s.projects[0].ownerId = " alice ";
    },
    (s) => {
      s.projects[0].deadline = "2026-02-30";
    },
    (s) => {
      s.projects[0].isDemo = "true";
    },
    (s) => {
      s.projects[0].createdAt = "2026-02-30T08:00:00.000Z";
    },
    (s) => {
      s.projects[0].sources[0].versions = [];
    },
    (s) => {
      s.projects[0].sources[0].versions[0].number = 2;
    },
    (s) => {
      s.projects[0].sources[0].currentVersionId = "missing";
    },
    (s) => {
      s.projects[0].sources[0].versions[0].content = "";
    },
    (s) => {
      s.projects[0].sources[1].id = s.projects[0].sources[0].id;
    },
    (s) => {
      s.projects[0].claims[0].evidence[0].sourceId = "missing";
    },
    (s) => {
      s.projects[0].claims[0].evidence[0].sourceId += " ";
    },
    (s) => {
      s.projects[0].claims[0].evidence[0].versionId =
        s.projects[0].sources[1].currentVersionId;
    },
    (s) => {
      s.projects[0].claims[0].evidence = [];
    },
    (s) => {
      s.projects[0].claims[0].status = "verified";
    },
    (s) => {
      s.projects[0].tasks[0].claimIds = ["missing"];
    },
    (s) => {
      s.projects[0].tasks[0].claimIds[0] += " ";
    },
    (s) => {
      s.projects[0].tasks[0].status = "complete";
    },
    (s) => {
      s.projects[0].tasks[0].reviewRequired = "false";
    },
    (s) => {
      s.projects[0].artifacts[0].claimIds = ["missing"];
    },
    (s) => {
      s.projects[0].artifacts[0].content = null;
    },
    (s) => {
      s.projects[0].activity[0].at = "not a date";
    },
    (s) => {
      s.projects[0].activity[0].message = "";
    },
  ];
  for (const corrupt of corruptions) {
    const broken = structuredClone(state);
    corrupt(broken);
    const before = structuredClone(broken);
    rejectsDomain(() => validateWorkspace(broken), 400, "INVALID_STATE");
    assert.deepEqual(
      broken,
      before,
      "validation must never repair or overwrite corrupt state",
    );
  }
  for (const value of [null, [], {}, { schemaVersion: 1, revision: 0 }])
    rejectsDomain(() => validateWorkspace(value), 400, "INVALID_STATE");
});

test("persisted workspace cannot silently clear review flags while retaining stale dependencies", () => {
  const { run, state, project } = fixture();
  const source = project.sources[0];
  const next = run(state, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "第二版",
  }).state;
  const mutations = [
    (s) => {
      s.projects[0].claims[0].status = "linked";
    },
    (s) => {
      s.projects[0].tasks[0].reviewRequired = false;
    },
    (s) => {
      s.projects[0].artifacts[0].status = "draft";
    },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(next);
    mutate(broken);
    rejectsDomain(() => validateWorkspace(broken), 400, "INVALID_STATE");
  }
  validateWorkspace(next);
});

test("corrupt state prevents both commands and previews rather than silently resetting data", () => {
  const { run, state, project } = fixture();
  state.projects[0].tasks[0].claimIds = ["dangling"];
  rejectsDomain(
    () =>
      run(state, "create_project", { title: "x", goal: "x", deadline: null }),
    400,
    "INVALID_STATE",
  );
  rejectsDomain(
    () =>
      previewSourceUpdate(
        state,
        "alice",
        project.id,
        project.sources[0].id,
        "x",
      ),
    400,
    "INVALID_STATE",
  );
});
