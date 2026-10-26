import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, emptyWorkspace } from "../server/domain.mjs";
import { resolveEvidenceLocation } from "../shared/evidence-location.mjs";

function fixture(
  content = "合成研究记录\r\n🧪 采样条件需核对\r\n对照组结果仍未知",
) {
  let state = applyCommand(emptyWorkspace(), "local-user", "create_project", {
    title: "合成定位测试",
    goal: "核对上下文",
    deadline: null,
  }).state;
  const projectId = state.projects[0].id;
  state = applyCommand(state, "local-user", "add_source", {
    projectId,
    title: "合成资料",
    kind: "note",
    content,
  }).state;
  const sourceId = state.projects[0].sources[0].id;
  const command = (type, payload) => {
    state = applyCommand(state, "local-user", type, {
      projectId,
      ...payload,
    }).state;
    return state.projects[0];
  };
  return { project: () => state.projects[0], sourceId, command };
}

test("recorded excerpts resolve exact UTF-16/CRLF spans without inferring a file page", () => {
  const f = fixture();
  const project = f.command("run_analysis", {
    request: { mode: "search", sourceIds: [f.sourceId], query: "采样" },
  });
  const run = project.analyses[0],
    candidate = run.output.claims[0],
    ref = candidate.evidence[0];
  const location = resolveEvidenceLocation(project, {
    ...ref,
    analysisId: run.id,
    candidateId: candidate.id,
  });
  assert.equal(location.kind, "span");
  assert.equal(location.startLine, 2);
  assert.equal(location.endLine, 2);
  assert.equal(
    project.sources[0].versions[0].content.slice(location.start, location.end),
    candidate.quote,
  );
  assert.match(location.description, /不是原文件页码/);
  assert.equal(
    resolveEvidenceLocation(project, {
      ...ref,
      analysisId: run.id,
      candidateId: "unknown",
    }).kind,
    "unlocated",
  );
});

test("accepted claim mapping retains its exact historical location after source changes", () => {
  const f = fixture();
  let project = f.command("run_analysis", {
    request: { mode: "search", sourceIds: [f.sourceId], query: "采样" },
  });
  const run = project.analyses[0],
    candidate = run.output.claims[0],
    ref = candidate.evidence[0];
  project = f.command("accept_analysis", {
    analysisId: run.id,
    claimIds: [candidate.id],
    taskIds: [],
  });
  const claimId = project.claims[0].id;
  const target = { ...ref, claimId },
    original = resolveEvidenceLocation(project, target);
  const before = structuredClone(project);
  assert.equal(original.kind, "span");
  assert.deepEqual(project, before);
  project = f.command("update_source", {
    sourceId: f.sourceId,
    baseVersionId: ref.versionId,
    content: "新版没有该摘录，不能自动搬移。",
  });
  assert.deepEqual(resolveEvidenceLocation(project, target), original);
  assert.equal(
    resolveEvidenceLocation(project, {
      ...target,
      versionId: project.sources[0].currentVersionId,
    }).kind,
    "unlocated",
  );
  assert.equal(project.claims[0].status, "needs_review");
});

test("manual or altered locators stay unknown and never borrow unrelated analysis coordinates", () => {
  const f = fixture();
  let project = f.command("run_analysis", {
    request: { mode: "search", sourceIds: [f.sourceId], query: "采样" },
  });
  const run = project.analyses[0],
    candidate = run.output.claims[0],
    ref = candidate.evidence[0];
  for (const locator of [
    "第 2 行",
    "PDF第2页",
    ref.locator,
    "<script>alert(1)</script>",
  ])
    assert.equal(
      resolveEvidenceLocation(project, {
        sourceId: ref.sourceId,
        versionId: ref.versionId,
        locator,
      }).kind,
      "unlocated",
    );
  assert.equal(
    resolveEvidenceLocation(project, {
      ...ref,
      locator: "人工重新写过的位置",
      analysisId: run.id,
      candidateId: candidate.id,
    }).kind,
    "unlocated",
  );
  assert.equal(
    resolveEvidenceLocation(project, { ...ref, claimId: "foreign-claim" }).kind,
    "unlocated",
  );
  project = f.command("add_source", {
    title: "另一份资料",
    kind: "note",
    content: candidate.quote,
  });
  const foreign = project.sources[1];
  assert.equal(
    resolveEvidenceLocation(project, {
      ...ref,
      sourceId: foreign.id,
      versionId: foreign.currentVersionId,
      analysisId: run.id,
      candidateId: candidate.id,
    }).kind,
    "unlocated",
  );
});

test("invalid/stale coordinate metadata is not highlighted, including quote mismatch", () => {
  const f = fixture();
  const project = f.command("run_analysis", {
    request: { mode: "search", sourceIds: [f.sourceId], query: "采样" },
  });
  const run = project.analyses[0],
    candidate = run.output.claims[0],
    ref = candidate.evidence[0];
  const target = { ...ref, analysisId: run.id, candidateId: candidate.id };
  for (const mutation of [
    (c) => {
      c.location.start = -1;
    },
    (c) => {
      c.location.end = 999999;
    },
    (c) => {
      c.location.line = 1;
    },
    (c) => {
      c.quote += "伪造";
    },
  ]) {
    const broken = structuredClone(project);
    mutation(broken.analyses[0].output.claims[0]);
    assert.equal(resolveEvidenceLocation(broken, target).kind, "unlocated");
  }
  assert.equal(
    resolveEvidenceLocation(project, { ...target, versionId: "missing" }).kind,
    "unlocated",
  );
});

test("CSV calculation ranges use physical record lines including quoted multiline cells", () => {
  const f = fixture('项目,数值\r\n"合成\r\n样本",2\r\n另一条,3');
  const project = f.command("run_analysis", {
    request: {
      mode: "calculate",
      sourceIds: [f.sourceId],
      column: "数值",
      operation: "sum",
    },
  });
  const run = project.analyses[0],
    candidate = run.output.claims[0];
  const location = resolveEvidenceLocation(project, {
    ...candidate.evidence[0],
    analysisId: run.id,
    candidateId: candidate.id,
  });
  assert.equal(location.kind, "lines");
  assert.equal(location.startLine, 2);
  assert.equal(location.endLine, 4);
  assert.match(location.description, /数值列：数值/);
});
