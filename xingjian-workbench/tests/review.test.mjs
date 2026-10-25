import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommand,
  emptyWorkspace,
  previewReview,
  validateWorkspace,
} from "../server/domain.mjs";
import { WorkspaceStore } from "../server/store.mjs";

function fixture() {
  let sequence = 0;
  let state = emptyWorkspace();
  const options = {
    id: (kind) => `${kind}_${++sequence}`,
    now: "2026-10-24T08:00:00.000Z",
  };
  const command = (type, payload = {}, owner = "alice") => {
    const result = applyCommand(state, owner, type, payload, options);
    state = result.state;
    return result;
  };
  command("load_demo");
  const projectId = state.projects[0].id;
  const project = () => state.projects.find((p) => p.id === projectId);
  const update = (
    sourceId = project().sources[0].id,
    content = "新版合成资料：A=55，B=45。",
  ) =>
    command("update_source", {
      projectId,
      sourceId,
      baseVersionId: project().sources.find((s) => s.id === sourceId)
        .currentVersionId,
      content,
    });
  const preview = (kind, entityId, owner = "alice") =>
    previewReview(state, owner, projectId, kind, entityId);
  const payload = (kind, entityId, fields = {}) => {
    const p = preview(kind, entityId);
    return {
      projectId,
      entityId,
      baseVersion: p.baseVersion,
      reviewToken: p.reviewToken,
      reason: "已逐项核对新版资料，记录本次判断。",
      ...fields,
    };
  };
  const evidence = (claim) =>
    claim.evidence.map((e) => ({
      ...e,
      versionId: project().sources.find((s) => s.id === e.sourceId)
        .currentVersionId,
      locator: "人工复核新版粘贴内容第 1 行",
    }));
  const reviewClaim = (
    claim = project().claims[0],
    text = "核对新版后修订的结论",
  ) =>
    command(
      "review_claim",
      payload("claim", claim.id, { text, evidence: evidence(claim) }),
    );
  return {
    command,
    projectId,
    project,
    state: () => state,
    update,
    preview,
    payload,
    evidence,
    reviewClaim,
  };
}

function changedFixture() {
  const f = fixture();
  f.update();
  return f;
}

function rejectWithoutChange(
  f,
  type,
  payload,
  code,
  status = 409,
  owner = "alice",
) {
  const before = structuredClone(f.state());
  assert.throws(() => f.command(type, payload, owner), { code, status });
  assert.deepEqual(f.state(), before);
}

test("review preview is read-only and exposes original/current source content without resolving anything", () => {
  const f = changedFixture();
  const before = structuredClone(f.state());
  const claim = f.project().claims[0];
  const p = f.preview("claim", claim.id);
  assert.equal(p.kind, "claim");
  assert.equal(p.entityId, claim.id);
  assert.equal(p.baseVersion, 1);
  assert.match(p.reviewToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(p.blockedBy, []);
  assert.equal(
    p.sourceComparisons[0].previousVersionId,
    claim.evidence[0].versionId,
  );
  assert.equal(
    p.sourceComparisons[0].currentVersionId,
    f.project().sources[0].currentVersionId,
  );
  assert.notEqual(
    p.sourceComparisons[0].previousContent,
    p.sourceComparisons[0].currentContent,
  );
  p.sourceComparisons[0].currentContent = "外部修改预览";
  assert.deepEqual(f.state(), before);
  // Closing a preview has no command, receipt, revision or activity side effect.
  assert.equal(f.project().claims[0].revisions, undefined);
});

test("reviewing one claim preserves its original revision and clears only that conclusion", () => {
  const f = changedFixture();
  const before = structuredClone(f.project());
  const claim = before.claims[0];
  f.reviewClaim(claim);
  const p = f.project();
  const changed = p.claims[0];
  assert.equal(changed.status, "linked");
  assert.equal(changed.text, "核对新版后修订的结论");
  assert.deepEqual(
    changed.revisions.map((r) => r.number),
    [1, 2],
  );
  assert.equal(changed.revisions[0].text, claim.text);
  assert.deepEqual(changed.revisions[0].evidence, claim.evidence);
  assert.equal(changed.revisions[1].text, changed.text);
  assert.deepEqual(changed.revisions[1].evidence, changed.evidence);
  assert.match(changed.revisions[1].reason, /逐项核对/);
  assert.deepEqual(p.claims[1], before.claims[1]);
  assert.deepEqual(p.tasks, before.tasks);
  assert.deepEqual(p.artifacts, before.artifacts);
  validateWorkspace(f.state());
});

test("tasks and drafts stay blocked until every linked conclusion has been reviewed", () => {
  const f = fixture();
  const claims = f.project().claims;
  const taskId = f.command("add_task", {
    projectId: f.projectId,
    title: "同时依赖两份资料的行动",
    claimIds: claims.map((c) => c.id),
  }).result.entityId;
  const artifactId = f.command("add_artifact", {
    projectId: f.projectId,
    title: "联合结论草稿",
    content: "核对两条结论后再发布。",
    claimIds: claims.map((c) => c.id),
  }).result.entityId;
  f.update();
  f.update(f.project().sources[1].id, "资料室新版合成信息");
  assert.equal(f.preview("task", taskId).blockedBy.length, 2);
  f.reviewClaim(f.project().claims[0]);
  for (const [kind, id, fields] of [
    ["task", taskId, { title: "复核后的联合行动" }],
    ["artifact", artifactId, { title: "联合草稿", content: "复核后的内容" }],
  ]) {
    assert.deepEqual(
      f.preview(kind, id).blockedBy.map((b) => b.claimId),
      [claims[1].id],
    );
    rejectWithoutChange(
      f,
      `review_${kind}`,
      f.payload(kind, id, fields),
      "REVIEW_BLOCKED",
    );
  }
  f.reviewClaim(f.project().claims[1], "第二条结论已核对");
  assert.deepEqual(f.preview("task", taskId).blockedBy, []);
  f.command(
    "review_task",
    f.payload("task", taskId, { title: "复核后的联合行动" }),
  );
  assert.equal(
    f.project().tasks.find((t) => t.id === taskId).reviewRequired,
    false,
  );
  assert.equal(
    f.project().artifacts.find((a) => a.id === artifactId).status,
    "needs_review",
  );
  f.command(
    "review_artifact",
    f.payload("artifact", artifactId, {
      title: "联合草稿",
      content: "复核后的内容",
    }),
  );
  assert.equal(
    f.project().artifacts.find((a) => a.id === artifactId).status,
    "draft",
  );
});

test("reviewing a completed task preserves progress and records which claim version was checked", () => {
  const f = changedFixture();
  const originalTask = structuredClone(f.project().tasks[0]);
  assert.equal(originalTask.status, "done");
  f.reviewClaim();
  const p = f.preview("task", originalTask.id);
  assert.equal(p.claimComparisons[0].previousVersion, null);
  assert.equal(p.claimComparisons[0].currentVersion, 2);
  f.command(
    "review_task",
    f.payload("task", originalTask.id, {
      title: "新版资料已核对，保留完成状态",
    }),
  );
  const task = f.project().tasks[0];
  assert.equal(task.status, "done");
  assert.equal(task.reviewRequired, false);
  assert.equal(task.revisions[0].title, originalTask.title);
  assert.equal(task.revisions[0].claimVersions, null);
  assert.deepEqual(task.revisions[1].claimVersions, [
    { claimId: f.project().claims[0].id, version: 2 },
  ]);
  assert.equal(f.project().tasks[1].reviewRequired, true);
});

test("draft review keeps the previous text and dependency list as a historical revision", () => {
  const f = changedFixture();
  const old = structuredClone(f.project().artifacts[0]);
  f.reviewClaim();
  f.command(
    "review_artifact",
    f.payload("artifact", old.id, {
      title: "修订后的章节",
      content: "新版数据支持下的修订草稿。",
    }),
  );
  const artifact = f.project().artifacts[0];
  assert.equal(artifact.status, "draft");
  assert.equal(artifact.revisions[0].content, old.content);
  assert.deepEqual(artifact.revisions[0].claimIds, old.claimIds);
  assert.equal(artifact.revisions[1].content, artifact.content);
  assert.equal(artifact.revisions[1].title, artifact.title);
  assert.deepEqual(artifact.claimIds, old.claimIds);
  assert.equal(f.project().tasks[0].reviewRequired, true);
});

test("a multi-source conclusion cannot be cleared using only one source or a stale version", () => {
  const f = fixture();
  const evidence = f
    .project()
    .sources.map((s) => ({
      sourceId: s.id,
      versionId: s.currentVersionId,
      locator: "合成材料第 1 行",
    }));
  const claimId = f.command("add_claim", {
    projectId: f.projectId,
    text: "联合资料结论",
    evidence,
  }).result.entityId;
  f.update();
  const claim = f.project().claims.find((c) => c.id === claimId);
  const current = f.evidence(claim);
  rejectWithoutChange(
    f,
    "review_claim",
    f.payload("claim", claimId, {
      text: "联合复核",
      evidence: current.slice(0, 1),
    }),
    "INVALID_REVIEW",
    400,
  );
  rejectWithoutChange(
    f,
    "review_claim",
    f.payload("claim", claimId, { text: "联合复核", evidence }),
    "REVIEW_STALE",
    409,
  );
  f.reviewClaim(claim, "已核对全部关联资料");
  assert.equal(
    f.project().claims.find((c) => c.id === claimId).evidence.length,
    2,
  );
});

test("review requires a reason and valid preview token; invalid writes leave all history intact", () => {
  const f = changedFixture();
  const c = f.project().claims[0];
  const valid = f.payload("claim", c.id, {
    text: "新版结论",
    evidence: f.evidence(c),
  });
  rejectWithoutChange(
    f,
    "review_claim",
    { ...valid, reason: "   " },
    "INVALID_REVIEW",
    400,
  );
  rejectWithoutChange(
    f,
    "review_claim",
    { ...valid, reviewToken: "0".repeat(64) },
    "REVIEW_STALE",
  );
  rejectWithoutChange(
    f,
    "review_claim",
    { ...valid, baseVersion: 99 },
    "REVIEW_STALE",
  );
});

test("reviewing an already current item does not create an unnecessary revision", () => {
  const f = changedFixture();
  const c = f.project().claims[0];
  const payload = f.payload("claim", c.id, {
    text: "新版结论",
    evidence: f.evidence(c),
  });
  f.command("review_claim", payload);
  rejectWithoutChange(f, "review_claim", payload, "REVIEW_NOT_REQUIRED");
});

test("source change after preview invalidates confirmation even when caller uses the latest global state", () => {
  const f = changedFixture();
  const c = f.project().claims[0];
  const payload = f.payload("claim", c.id, {
    text: "上一版预览结论",
    evidence: f.evidence(c),
  });
  f.update(undefined, "第三版：刚收到新的合成样本");
  rejectWithoutChange(f, "review_claim", payload, "REVIEW_STALE");
  assert.equal(f.project().claims[0].revisions, undefined);
});

test("downstream preview cannot survive another source change and another conclusion review", () => {
  const f = changedFixture();
  f.reviewClaim();
  const task = f.project().tasks[0];
  const payload = f.payload("task", task.id, { title: "旧结论版本下的行动" });
  f.update(undefined, "第三版的合成数据");
  f.reviewClaim(f.project().claims[0], "依据第三版再次核对");
  rejectWithoutChange(f, "review_task", payload, "REVIEW_STALE");
  assert.equal(f.project().tasks[0].status, "done");
  assert.equal(f.project().tasks[0].reviewRequired, true);
});

test("a later source change reflags reviewed entities and appends to preserved history on the next review", () => {
  const f = changedFixture();
  f.reviewClaim();
  const c = structuredClone(f.project().claims[0]);
  const task = f.project().tasks[0];
  const artifact = f.project().artifacts[0];
  f.command(
    "review_task",
    f.payload("task", task.id, { title: "复核完成行动" }),
  );
  f.command(
    "review_artifact",
    f.payload("artifact", artifact.id, {
      title: "复核完成草稿",
      content: "第二版草稿。",
    }),
  );
  f.update(undefined, "第三版合成内容");
  assert.equal(f.project().claims[0].status, "needs_review");
  assert.equal(f.project().tasks[0].reviewRequired, true);
  assert.equal(f.project().tasks[0].status, "done");
  assert.equal(f.project().artifacts[0].status, "needs_review");
  f.reviewClaim(f.project().claims[0], "第三版复核结论");
  assert.deepEqual(f.project().claims[0].revisions.slice(0, 2), c.revisions);
  assert.equal(f.project().claims[0].revisions[2].number, 3);
  validateWorkspace(f.state());
});

test("foreign owners and foreign project entities cannot preview or complete a review", () => {
  const f = changedFixture();
  const c = f.project().claims[0];
  assert.throws(() => f.preview("claim", c.id, "bob"), {
    code: "NOT_FOUND",
    status: 404,
  });
  const payload = f.payload("claim", c.id, {
    text: "新版结论",
    evidence: f.evidence(c),
  });
  rejectWithoutChange(f, "review_claim", payload, "NOT_FOUND", 404, "bob");
  const foreignId = f.command("create_project", {
    title: "另一项目",
    goal: "隔离对象",
    deadline: null,
  }).result.projectId;
  assert.throws(
    () => previewReview(f.state(), "alice", foreignId, "claim", c.id),
    { code: "NOT_FOUND", status: 404 },
  );
  rejectWithoutChange(
    f,
    "review_claim",
    { ...payload, projectId: foreignId },
    "NOT_FOUND",
    404,
  );
});

test("legacy workspaces without review history remain readable without silent migration", () => {
  const f = fixture();
  const before = structuredClone(f.state());
  assert.ok(f.project().claims.every((c) => c.revisions === undefined));
  assert.ok(f.project().tasks.every((c) => c.revisions === undefined));
  assert.ok(f.project().artifacts.every((c) => c.revisions === undefined));
  assert.equal(validateWorkspace(f.state()), f.state());
  assert.deepEqual(f.state(), before);
});

test("accepted analysis results remain immutable when their generated conclusion and action are revised", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-review-"));
  const file = join(dir, "workspace.json");
  let store = new WorkspaceStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let sequence = 0;
  const send = (type, payload) =>
    store.command("alice", {
      operationId: `review-test-${++sequence}`,
      expectedRevision: store.state().revision,
      type,
      payload,
    });
  const projectId = send("create_project", {
    title: "分析结果复核",
    goal: "保留真实历史",
    deadline: null,
  }).result.projectId;
  const project = () => store.state().projects[0];
  const sourceId = send("add_source", {
    projectId,
    title: "合成表",
    kind: "table",
    content: "值\n1\n2",
  }).result.entityId;
  const analysisId = send("run_analysis", {
    projectId,
    request: {
      mode: "calculate",
      sourceIds: [sourceId],
      column: "值",
      operation: "sum",
    },
  }).result.entityId;
  send("accept_analysis", {
    projectId,
    analysisId,
    claimIds: ["claim-1"],
    taskIds: ["task-review"],
  });
  const analysis = structuredClone(project().analyses[0]);
  const originalClaim = structuredClone(project().claims[0]);
  const originalTask = structuredClone(project().tasks[0]);
  send("set_task_status", {
    projectId,
    taskId: originalTask.id,
    status: "done",
  });
  send("update_source", {
    projectId,
    sourceId,
    baseVersionId: project().sources[0].currentVersionId,
    content: "值\n2\n3",
  });
  const beforePreview = readFileSync(file, "utf8");
  const preview = previewReview(
    store.state(),
    "alice",
    projectId,
    "claim",
    originalClaim.id,
  );
  assert.equal(readFileSync(file, "utf8"), beforePreview);
  const command = {
    operationId: "review-confirm-durable",
    expectedRevision: store.state().revision,
    type: "review_claim",
    payload: {
      projectId,
      entityId: originalClaim.id,
      baseVersion: preview.baseVersion,
      reviewToken: preview.reviewToken,
      reason: "人工重新核算：2 + 3 = 5。",
      text: "新版数据总计为 5。",
      evidence: [
        {
          sourceId,
          versionId: project().sources[0].currentVersionId,
          locator: "粘贴 CSV 第 2—3 行，人工复核",
        },
      ],
    },
  };
  const receipt = store.command("alice", command);
  const taskPreview = previewReview(
    store.state(),
    "alice",
    projectId,
    "task",
    originalTask.id,
  );
  send("review_task", {
    projectId,
    entityId: originalTask.id,
    baseVersion: taskPreview.baseVersion,
    reviewToken: taskPreview.reviewToken,
    reason: "已核对当前结论，完成进度保持。",
    title: "复核新版合成数据",
  });
  assert.deepEqual(project().analyses[0], analysis);
  assert.equal(project().claims[0].revisions[0].text, originalClaim.text);
  assert.equal(project().tasks[0].revisions[0].title, originalTask.title);
  assert.equal(project().tasks[0].status, "done");
  validateWorkspace(store.state());
  store.close();
  store = new WorkspaceStore(file);
  const beforeReplay = store.state();
  const replay = store.command("alice", command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, receipt.result);
  assert.deepEqual(store.state(), beforeReplay);
  assert.equal(project().claims[0].revisions.length, 2);
  assert.deepEqual(project().analyses[0], analysis);
  for (const mutate of [
    (p) => {
      p.analyses[0].output.claims[0].text = "篡改旧提案";
    },
    (p) => {
      p.claims[0].revisions[0].text = "篡改原始接受内容";
    },
    (p) => {
      p.tasks[0].revisions[0].title = "篡改原始行动";
    },
  ]) {
    const corrupt = store.state();
    mutate(corrupt.projects[0]);
    assert.throws(() => validateWorkspace(corrupt), { code: "INVALID_STATE" });
  }
});

test("unchanged content still records a deliberate review and only clears that item", () => {
  const f = changedFixture();
  const original = structuredClone(f.project().claims[0]);
  f.reviewClaim(original, original.text);
  const c = f.project().claims[0];
  assert.equal(c.text, original.text);
  assert.notEqual(c.evidence[0].versionId, original.evidence[0].versionId);
  const task = f.project().tasks[0];
  f.command("review_task", f.payload("task", task.id, { title: task.title }));
  assert.equal(f.project().tasks[0].revisions.length, 2);
  assert.equal(f.project().artifacts[0].status, "needs_review");
});

test("task progress can change during review without invalidating content snapshot or being overwritten", () => {
  const f = changedFixture();
  f.reviewClaim();
  const task = f.project().tasks[1];
  const payload = f.payload("task", task.id, { title: "核查完成后的行动描述" });
  f.command("set_task_status", {
    projectId: f.projectId,
    taskId: task.id,
    status: "done",
  });
  f.command("review_task", payload);
  assert.equal(f.project().tasks[1].status, "done");
  assert.equal(f.project().tasks[1].reviewRequired, false);
});

test("subsequent task review compares the actually confirmed prior claim revision", () => {
  const f = changedFixture();
  f.reviewClaim();
  const task = f.project().tasks[0];
  f.command("review_task", f.payload("task", task.id, { title: task.title }));
  const oldText = f.project().claims[0].text;
  f.update(undefined, "第三版资料");
  f.reviewClaim(f.project().claims[0], "第三版修订结论");
  const preview = f.preview("task", task.id);
  assert.equal(preview.claimComparisons[0].previousVersion, 2);
  assert.equal(preview.claimComparisons[0].previousText, oldText);
  assert.equal(preview.claimComparisons[0].currentVersion, 3);
  assert.equal(preview.claimComparisons[0].currentText, "第三版修订结论");
});

test("stored history corruption and clearing downstream flags without matching revisions fail validation", () => {
  const f = changedFixture();
  f.reviewClaim();
  f.command(
    "review_task",
    f.payload("task", f.project().tasks[0].id, { title: "新版任务" }),
  );
  f.command(
    "review_artifact",
    f.payload("artifact", f.project().artifacts[0].id, {
      title: "新版草稿",
      content: "新的草稿内容",
    }),
  );
  for (const corrupt of [
    (p) => (p.claims[0].revisions[1].number = 9),
    (p) => (p.claims[0].revisions[1].evidence[0].versionId = "missing"),
    (p) => (p.claims[0].revisions[1].text = "与当前不一致"),
    (p) => (p.claims[0].revisions[1].reason = ""),
    (p) => (p.claims[0].revisions[1].recordedAt = "not-a-time"),
    (p) => (p.tasks[0].revisions[1].claimVersions[0].version = 99),
    (p) => (p.tasks[0].revisions[0].claimVersions = []),
    (p) => (p.artifacts[0].revisions[1].content = "与当前草稿不一致"),
    (p) => (p.artifacts[0].revisions[1].claimIds = []),
  ]) {
    const state = structuredClone(f.state());
    corrupt(state.projects[0]);
    assert.throws(() => validateWorkspace(state), { code: "INVALID_STATE" });
  }
  f.update(undefined, "第三版资料");
  f.reviewClaim(f.project().claims[0], "新版结论内容");
  for (const corrupt of [
    (p) => (p.tasks[0].reviewRequired = false),
    (p) => (p.artifacts[0].status = "draft"),
  ]) {
    const state = structuredClone(f.state());
    corrupt(state.projects[0]);
    assert.throws(() => validateWorkspace(state), { code: "INVALID_STATE" });
  }
});
