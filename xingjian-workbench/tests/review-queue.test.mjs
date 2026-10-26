import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  emptyWorkspace,
  previewReview,
  validateWorkspace,
} from "../server/domain.mjs";
import {
  buildReviewQueue,
  filterReviewQueue,
} from "../shared/review-queue.mjs";

function fixture() {
  let state = emptyWorkspace();
  let sequence = 0;
  const options = {
    now: "2026-10-26T08:00:00.000Z",
    id: (kind) => `${kind}_${++sequence}`,
  };
  const command = (type, payload = {}, owner = "alice") => {
    const response = applyCommand(state, owner, type, payload, options);
    state = response.state;
    return response.result;
  };
  const projectId = command("load_demo").projectId;
  const project = () => state.projects.find((p) => p.id === projectId);
  const update = (source = project().sources[0]) =>
    command("update_source", {
      projectId,
      sourceId: source.id,
      baseVersionId: source.currentVersionId,
      content: `${source.versions.at(-1).content}\n人工补充的新版合成资料。`,
    });
  const reviewClaim = (claim = project().claims[0]) => {
    const preview = previewReview(state, "alice", projectId, "claim", claim.id);
    command("review_claim", {
      projectId,
      entityId: claim.id,
      baseVersion: preview.baseVersion,
      reviewToken: preview.reviewToken,
      reason: "人工对照新版，保留原结论适用范围。",
      text: claim.text,
      evidence: claim.evidence.map((ref) => ({
        ...ref,
        versionId: project().sources.find((source) => source.id === ref.sourceId)
          .currentVersionId,
      })),
    });
  };
  return { command, project, projectId, state: () => state, update, reviewClaim };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const all = { kind: "all", sourceId: "", query: "", readiness: "all" };

test("empty and unchanged projects have no review queue", () => {
  const f = fixture();
  assert.deepEqual(buildReviewQueue(f.project()), []);
  const emptyId = f.command("create_project", {
    title: "尚无资料的项目",
    goal: "先整理研究问题。",
    deadline: null,
  }).projectId;
  const empty = f.state().projects.find((project) => project.id === emptyId);
  assert.deepEqual(buildReviewQueue(empty), []);
  assert.deepEqual(filterReviewQueue([], all), []);
});

test("pending flags select entries and blockedBy agrees with actual server previews", () => {
  const f = fixture();
  const claimIds = f.project().claims.map((claim) => claim.id);
  const taskId = f.command("add_task", {
    projectId: f.projectId,
    title: "核对两条结论的联合行动",
    claimIds,
  }).entityId;
  const artifactId = f.command("add_artifact", {
    projectId: f.projectId,
    title: "两条结论的综合草稿",
    content: "分别核对两份资料后再修订。",
    claimIds,
  }).entityId;
  f.update();
  f.update(f.project().sources[1]);
  const queue = buildReviewQueue(f.project());
  assert.equal(queue.length, 9);
  for (const item of queue) {
    const preview = previewReview(
      f.state(), "alice", f.projectId, item.kind, item.entityId,
    );
    assert.deepEqual(item.blockedBy, preview.blockedBy);
  }
  for (const id of [taskId, artifactId])
    assert.deepEqual(
      queue.find((item) => item.entityId === id).blockedBy.map((ref) => ref.claimId),
      claimIds,
    );
});

test("ready entries precede blocked entries with stable kind and collection order", () => {
  const f = fixture();
  f.update();
  f.update(f.project().sources[1]);
  f.reviewClaim();
  const p = f.project();
  assert.deepEqual(
    buildReviewQueue(p).map((item) => `${item.kind}:${item.entityId}`),
    [
      `claim:${p.claims[1].id}`,
      `task:${p.tasks[0].id}`,
      `task:${p.tasks[1].id}`,
      `artifact:${p.artifacts[0].id}`,
      `task:${p.tasks[2].id}`,
      `artifact:${p.artifacts[1].id}`,
    ],
  );
});

test("reviewed conclusions leave their downstream items pending and task progress unchanged", () => {
  const f = fixture();
  f.update();
  const oldTaskStatuses = f.project().tasks.map((task) => task.status);
  f.reviewClaim();
  const queue = buildReviewQueue(f.project());
  assert.deepEqual(queue.map((item) => item.kind), ["task", "task", "artifact"]);
  assert.ok(queue.every((item) => item.blockedBy.length === 0));
  assert.equal(queue[0].taskStatus, "done");
  assert.equal(queue[1].taskStatus, "todo");
  assert.deepEqual(f.project().tasks.map((task) => task.status), oldTaskStatuses);
  assert.equal(f.project().tasks[0].reviewRequired, true);
  validateWorkspace(f.state());
});

test("sources are de-duplicated from live evidence and never inferred from old snapshots", () => {
  const f = fixture();
  const p = f.project();
  const evidence = [
    { ...p.claims[0].evidence[0], locator: "同一资料另一段" },
    ...p.claims[1].evidence,
    ...p.claims[0].evidence,
  ];
  const claimId = f.command("add_claim", {
    projectId: f.projectId,
    text: "有多段依据的联合结论",
    evidence,
  }).entityId;
  const taskId = f.command("add_task", {
    projectId: f.projectId,
    title: "多结论重复引用同一资料",
    claimIds: [claimId, p.claims[1].id, p.claims[0].id],
  }).entityId;
  f.update();
  const expected = p.sources.map((source) => ({ sourceId: source.id, title: source.title }));
  const queue = buildReviewQueue(f.project());
  assert.deepEqual(queue.find((item) => item.entityId === claimId).sources, expected);
  assert.deepEqual(queue.find((item) => item.entityId === taskId).sources, expected);
  const clone = structuredClone(f.project());
  clone.claims.find((claim) => claim.id === claimId).revisions = [
    { evidence: [p.claims[1].evidence[0]] },
  ];
  assert.deepEqual(
    buildReviewQueue(clone).find((item) => item.entityId === claimId).sources,
    expected,
  );
});

test("unrelated projects and their changed sources never enter the supplied project's queue", () => {
  const f = fixture();
  const otherId = f.command("load_demo", {}, "bob").projectId;
  const other = f.state().projects.find((p) => p.id === otherId);
  f.command("update_source", {
    projectId: otherId,
    sourceId: other.sources[0].id,
    baseVersionId: other.sources[0].currentVersionId,
    content: "另一个用户的新版合成资料。",
  }, "bob");
  assert.deepEqual(buildReviewQueue(f.project()), []);
  f.update();
  const queue = buildReviewQueue(f.project());
  const otherIds = new Set([...other.claims, ...other.tasks, ...other.artifacts].map((item) => item.id));
  assert.ok(queue.every((item) => !otherIds.has(item.entityId)));
  assert.deepEqual(filterReviewQueue(queue, { ...all, sourceId: other.sources[0].id }), []);
});

test("combined literal filters match title or source names without changing queue order", () => {
  const f = fixture();
  f.update();
  f.update(f.project().sources[1]);
  f.reviewClaim();
  const p = f.project();
  const queue = buildReviewQueue(p);
  assert.deepEqual(filterReviewQueue(queue, all), queue);
  assert.deepEqual(
    filterReviewQueue(queue, { ...all, kind: "task", sourceId: p.sources[0].id, query: "  教室  ", readiness: "ready" }).map((item) => item.entityId),
    p.tasks.slice(0, 2).map((task) => task.id),
  );
  assert.deepEqual(
    filterReviewQueue(queue, { ...all, kind: "artifact", sourceId: p.sources[1].id, readiness: "blocked" }).map((item) => item.entityId),
    [p.artifacts[1].id],
  );
  assert.deepEqual(filterReviewQueue(queue, { ...all, kind: "claim", readiness: "blocked" }), []);
  const literals = [{ kind: "claim", entityId: "literal", title: "报告 [A-Z]+ (X)? <script>", sources: [{ sourceId: "s", title: "CSV DATA" }], blockedBy: [] }];
  assert.deepEqual(filterReviewQueue(literals, { ...all, query: "  [a-z]+ (x)?  " }), literals);
  assert.deepEqual(filterReviewQueue(literals, { ...all, query: "<SCRIPT>" }), literals);
  assert.deepEqual(filterReviewQueue(literals, { ...all, query: "data" }), literals);
  assert.deepEqual(filterReviewQueue(literals, { ...all, query: "[" }), literals);
  for (const query of [".*", "(a+)+$", "\\", "<img onerror=alert(1)>"])
    assert.deepEqual(filterReviewQueue(literals, { ...all, query }), []);
});

test("derivation and filtering do not mutate even frozen inputs or expose project object aliases", () => {
  const f = fixture();
  f.update();
  const before = structuredClone(f.state());
  freeze(f.state());
  const queue = buildReviewQueue(f.project());
  queue[0].sources[0].title = "只修改派生结果";
  queue.find((item) => item.kind === "task").blockedBy[0].text = "仅修改派生文字";
  assert.deepEqual(f.state(), before);
  const freshQueue = freeze(buildReviewQueue(f.project()));
  const filters = freeze({ ...all, readiness: "blocked" });
  const original = structuredClone(freshQueue);
  filterReviewQueue(freshQueue, filters);
  assert.deepEqual(freshQueue, original);
  assert.deepEqual(filters, { ...all, readiness: "blocked" });
  assert.deepEqual(f.state(), before);
});
