import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, emptyWorkspace, validateWorkspace } from "../server/domain.mjs";
import { createAgentRun, transitionAgentRun, acceptAgentRun } from "../server/agent-protocol.mjs";
import { buildReviewPreview } from "../server/review.mjs";
import { resolveEvidenceLocation } from "../shared/evidence-location.mjs";

const at = (minute) => `2026-10-26T02:0${minute}:00.000Z`;
function fixture() {
  let sequence = 0;
  const ctx = { id: (kind) => `${kind}-evidence-${++sequence}`, now: at(0) };
  let state = applyCommand(emptyWorkspace(), "local-user", "create_project", {
    title: "合成智能体证据定位测试", goal: "核对真实留存的资料版本与位置", deadline: null,
  }, ctx).state;
  const projectId = state.projects[0].id;
  const command = (type, payload, minute = 5) => {
    state = applyCommand(state, "local-user", type, { projectId, ...payload }, { ...ctx, now: at(minute) }).state;
    return state.projects[0];
  };
  command("add_source", {
    title: "合成保留文本", kind: "note",
    content: Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 行🧪 合成采样资料，需要人工核对上下文。`).join("\r\n"),
  }, 0);
  const p = state.projects[0], source = p.sources[0];
  const run = createAgentRun(p, {
    intent: "research", question: "这些合成资料包含什么？", sourceIds: [source.id],
  }, { id: ctx.id("run"), now: at(1), provider: "contract-test", authorizeCloud: true });
  p.agentRuns = [run];
  transitionAgentRun(p, run, {
    status: "running", message: "执行隔离契约测试，不代表真实云端结果。",
    invocation: { requestId: "fixture-request", sessionId: "fixture-session", runtimeName: "contract-test", applicationVersion: null, startedAt: at(2), platformRequestId: null },
  }, at(2));
  const evidence = run.snapshot.evidence[1];
  transitionAgentRun(p, run, {
    status: "proposal", message: "契约测试提案，位置仍需人工核对。",
    proposal: {
      schemaVersion: "xingjian.analysis-proposal.v1", decision: "proposal", summary: "合成测试提案。",
      claims: [{ id: "candidate-1", text: "候选内容需要阅读上下文核对。", evidenceIds: [evidence.id] }],
      tasks: [], gaps: ["原文存在不代表结论获得支持。"], questions: [],
    },
  }, at(3));
  validateWorkspace(state);
  const explicit = {
    sourceId: evidence.sourceId, versionId: evidence.versionId, locator: evidence.locator,
    agentRunId: run.id, agentCandidateId: "candidate-1", evidenceId: evidence.id,
  };
  const accept = () => {
    const receipt = acceptAgentRun(state.projects[0], {
      runId: run.id, claimIds: ["candidate-1"], taskIds: [], acknowledgeEvidence: true,
    }, { ...ctx, now: at(4) });
    validateWorkspace(state);
    return { ...state.projects[0].claims.find((claim) => claim.id === receipt.claims[0].entityId).evidence[0], claimId: receipt.claims[0].entityId };
  };
  return { project: () => state.projects[0], state: () => state, command, explicit, evidence, run, sourceId: source.id, accept };
}

function assertSpan(project, target, evidence) {
  const location = resolveEvidenceLocation(project, target);
  assert.equal(location.kind, "span");
  assert.equal(location.start, evidence.start);
  assert.equal(location.end, evidence.end);
  assert.equal(location.startLine, evidence.startLine);
  assert.equal(location.endLine, evidence.endLine);
  const source = project.sources.find((item) => item.id === target.sourceId);
  const version = source.versions.find((item) => item.id === target.versionId);
  assert.equal(version.content.slice(location.start, location.end), evidence.quote);
  assert.match(location.description, /原文存在不代表它支持该结论/);
  return location;
}

test("agent candidate evidence highlights the exact retained UTF-16 chunk and CRLF lines without writes", () => {
  const f = fixture(), before = structuredClone(f.project());
  assert.ok(f.evidence.start > 0);
  assert.ok(f.evidence.startLine > 1);
  assertSpan(f.project(), f.explicit, f.evidence);
  assert.deepEqual(f.project(), before);
  for (const overrides of [
    { agentRunId: "unknown-run" }, { agentCandidateId: "unknown-candidate" },
    { evidenceId: "unknown-evidence" }, { evidenceId: "ev-1" }, { locator: "手工另写的位置" },
    { versionId: "unretained-version" }, { sourceId: "foreign-source" },
  ]) assert.equal(resolveEvidenceLocation(f.project(), { ...f.explicit, ...overrides }).kind, "unlocated");
});

test("accepted agent claim IDs resolve their original candidate positions, not coincidentally identical manual locators", () => {
  const f = fixture(), claimTarget = f.accept();
  const before = structuredClone(f.project());
  assertSpan(f.project(), claimTarget, f.evidence);
  assert.equal(resolveEvidenceLocation(f.project(), { sourceId: claimTarget.sourceId, versionId: claimTarget.versionId, locator: claimTarget.locator }).kind, "unlocated");
  assert.equal(resolveEvidenceLocation(f.project(), { ...claimTarget, claimId: "manual-or-foreign-claim" }).kind, "unlocated");
  assert.deepEqual(f.project(), before);
});

test("invalid explicit local analysis identities never borrow positions from an accepted agent claim", () => {
  const f = fixture(), claimTarget = f.accept();
  f.command("run_analysis", { request: { mode: "search", sourceIds: [f.sourceId], query: "合成" } });
  const local = f.project().analyses[0];
  for (const localIdentity of [
    { analysisId: "missing-local-run", candidateId: "missing-local-candidate" },
    { analysisId: local.id, candidateId: "missing-local-candidate" },
    { analysisId: "missing-local-run" }, { candidateId: local.output.claims[0].id },
    // This valid local candidate points elsewhere and uses a different locator.
    { analysisId: local.id, candidateId: local.output.claims[0].id },
  ]) assert.equal(resolveEvidenceLocation(f.project(), { ...claimTarget, ...localIdentity }).kind, "unlocated");
  assertSpan(f.project(), claimTarget, f.evidence);
});

test("mixed explicit local and agent identifiers are rejected even when both records exist", () => {
  const f = fixture();
  f.command("run_analysis", { request: { mode: "search", sourceIds: [f.sourceId], query: "合成" } });
  const local = f.project().analyses[0];
  for (const localIdentity of [
    { analysisId: local.id }, { candidateId: local.output.claims[0].id },
    { analysisId: local.id, candidateId: local.output.claims[0].id },
  ]) assert.equal(resolveEvidenceLocation(f.project(), { ...f.explicit, ...localIdentity }).kind, "unlocated");
});

test("agent quote, physical lines, offsets and snapshot/evidence hash mismatches never produce highlights", () => {
  const f = fixture();
  for (const mutation of [
    (p) => p.agentRuns[0].snapshot.evidence[1].quote += "伪造原文",
    (p) => p.agentRuns[0].snapshot.evidence[1].start = -1,
    (p) => p.agentRuns[0].snapshot.evidence[1].start += 1,
    (p) => p.agentRuns[0].snapshot.evidence[1].end = 999999,
    (p) => p.agentRuns[0].snapshot.evidence[1].startLine += 1,
    (p) => p.agentRuns[0].snapshot.evidence[1].endLine -= 1,
    (p) => p.agentRuns[0].snapshot.evidence[1].contentHash = "0".repeat(64),
    (p) => p.agentRuns[0].snapshot.sourceRevisions[0].contentHash = "0".repeat(64),
    (p) => p.agentRuns[0].snapshot.sourceRevisions[0].versionId = "foreign-version",
    (p) => p.sources[0].versions[0].content = "偷偷改写保留原文",
  ]) {
    const broken = structuredClone(f.project()); mutation(broken);
    assert.equal(resolveEvidenceLocation(broken, f.explicit).kind, "unlocated");
  }
  // Browser position checks consume server-validated state. Altering both hash
  // fields cannot bypass the whole retained-content hash check on the server.
  const corruptedState = structuredClone(f.state());
  const snapshot = corruptedState.projects[0].agentRuns[0].snapshot;
  snapshot.sourceRevisions[0].contentHash = "0".repeat(64);
  snapshot.evidence.forEach((entry) => { entry.contentHash = "0".repeat(64); });
  assert.throws(() => validateWorkspace(corruptedState), { code: "INVALID_STATE" });
});

test("source updates preserve historical agent references and never re-anchor them to a new version", () => {
  const f = fixture(), claimTarget = f.accept();
  const before = assertSpan(f.project(), claimTarget, f.evidence);
  f.command("update_source", {
    sourceId: f.sourceId, baseVersionId: claimTarget.versionId,
    content: "新版前言\r\n" + f.project().sources[0].versions[0].content,
  });
  assert.equal(f.project().claims[0].status, "needs_review");
  assert.deepEqual(resolveEvidenceLocation(f.project(), claimTarget), before);
  assertSpan(f.project(), f.explicit, f.evidence);
  const currentVersionId = f.project().sources[0].currentVersionId;
  assert.equal(resolveEvidenceLocation(f.project(), { ...claimTarget, versionId: currentVersionId }).kind, "unlocated");
  assert.equal(resolveEvidenceLocation(f.project(), { ...f.explicit, versionId: currentVersionId }).kind, "unlocated");
  validateWorkspace(f.state());
});

test("human-reviewed manual locators remain unlocated while original accepted references stay readable", () => {
  const f = fixture(), originalTarget = f.accept();
  f.command("update_source", {
    sourceId: f.sourceId, baseVersionId: originalTarget.versionId,
    content: "人工复核的新资料版本，含原先未采集的条件。",
  });
  // Use the existing real preview/review command instead of fabricating history.
  const project = f.project(), claim = project.claims[0];
  const currentEvidence = [{ sourceId: f.sourceId, versionId: project.sources[0].currentVersionId, locator: "第 1 行，人工重新核对的位置说明" }];
  const preview = buildReviewPreview(project, "claim", claim.id);
  f.command("review_claim", {
    entityId: claim.id, baseVersion: preview.baseVersion, reviewToken: preview.reviewToken,
    text: "经人工核对后的修订结论。", evidence: currentEvidence, reason: "按修订资料重新核对。",
  });
  const updated = f.project().claims[0];
  assert.equal(updated.status, "linked");
  assert.equal(resolveEvidenceLocation(f.project(), { ...updated.evidence[0], claimId: updated.id }).kind, "unlocated");
  assertSpan(f.project(), originalTarget, f.evidence);
  const oldVersionChangedLocator = { ...originalTarget, locator: currentEvidence[0].locator };
  assert.equal(resolveEvidenceLocation(f.project(), oldVersionChangedLocator).kind, "unlocated");
  validateWorkspace(f.state());
});
