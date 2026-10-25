import { createHash } from "node:crypto";

// Content revisions are separate from live review flags and task progress.
// The first snapshot is captured at the first review, not backdated to creation.
const INITIAL_REASON = "首次复核时保留的原始内容；原创建时间未记录。";
export class ReviewError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.status = status;
  }
}
const fail = (message, code = "INVALID_REVIEW", status = 400) => {
  throw new ReviewError(code, message, status);
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}
function identifier(value, label) {
  if (text(value, label, 160) !== value) fail(`${label}不能有首尾空白。`);
  return value;
}
function stamp(value) {
  if (typeof value !== "string") fail("复核记录时间无效。");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    fail("复核记录时间无效。");
}
function stringIds(values, label) {
  if (!Array.isArray(values)) fail(`${label}必须是数组。`);
  const normalized = values.map((value) => identifier(value, label));
  if (new Set(normalized).size !== normalized.length)
    fail(`${label}不能重复。`);
  return normalized;
}
function sourceIds(evidence) {
  return [...new Set(evidence.map((ref) => ref.sourceId))].sort();
}
function validEvidence(project, values) {
  if (!Array.isArray(values) || values.length === 0)
    fail("结论至少需要一条资料依据。");
  const seen = new Set();
  return values.map((value) => {
    if (!object(value)) fail("复核依据格式无效。");
    const sourceId = identifier(value.sourceId, "资料 ID");
    const versionId = identifier(value.versionId, "资料版本 ID");
    const locator = text(value.locator, "依据位置", 240);
    const source = project.sources.find((item) => item.id === sourceId);
    if (!source?.versions.some((version) => version.id === versionId))
      fail("复核依据必须引用本项目保留的资料版本。");
    const key = JSON.stringify([sourceId, versionId, locator]);
    if (seen.has(key)) fail("复核依据不能重复。");
    seen.add(key);
    return { sourceId, versionId, locator };
  });
}

export const contentVersion = (entity) => entity.revisions?.at(-1).number ?? 1;
export const originalContent = (entity) => entity.revisions?.[0] ?? entity;
function contentAt(entity, version) {
  return entity.revisions
    ? entity.revisions.find((entry) => entry.number === version)
    : version === 1
      ? entity
      : undefined;
}
function fields(entity, kind) {
  if (kind === "claim") return { text: entity.text, evidence: entity.evidence };
  return {
    title: entity.title,
    ...(kind === "artifact" ? { content: entity.content } : {}),
    claimIds: entity.claimIds,
  };
}
function isPending(entity, kind) {
  return kind === "task"
    ? entity.reviewRequired
    : entity.status === "needs_review";
}
function findEntity(project, kind, entityId) {
  if (!["claim", "task", "artifact"].includes(kind)) fail("复核类型无效。");
  identifier(entityId, "复核对象 ID");
  const collection =
    kind === "claim"
      ? project.claims
      : kind === "task"
        ? project.tasks
        : project.artifacts;
  const entity = collection.find((entry) => entry.id === entityId);
  if (!entity) fail("复核对象不存在或不属于此项目。", "NOT_FOUND", 404);
  return entity;
}

/** Validate append-only content history without treating progress as content. */
export function validateReviewHistory(project, entity, kind) {
  if (entity.revisions === undefined) return;
  if (!Array.isArray(entity.revisions) || entity.revisions.length < 2)
    fail("复核历史必须包含原始快照与至少一次确认。");
  let previousTime;
  for (const [index, revision] of entity.revisions.entries()) {
    if (!object(revision) || revision.number !== index + 1)
      fail("复核内容版本必须连续递增。");
    stamp(revision.recordedAt);
    if (previousTime && revision.recordedAt < previousTime)
      fail("复核记录时间不能倒退。");
    previousTime = revision.recordedAt;
    text(revision.reason, "复核说明", 1000);
    if (index === 0 && revision.reason !== INITIAL_REASON)
      fail("原始内容快照必须明确记录捕获时机。");
    if (kind === "claim") {
      text(revision.text, "历史结论", 4000);
      validEvidence(project, revision.evidence);
      if (!same(sourceIds(revision.evidence), sourceIds(entity.evidence)))
        fail("复核历史不能增删原结论关联的资料。");
    } else {
      text(revision.title, "历史标题", 120);
      if (kind === "artifact") text(revision.content, "历史草稿", 100000);
      const references = stringIds(revision.claimIds, "历史关联结论");
      if (!same(references, entity.claimIds))
        fail("本阶段复核不能修改结论关联。");
      if (index === 0) {
        if (revision.claimVersions !== null)
          fail("旧记录原始依赖版本未知，不能推测补写。");
      } else {
        if (!Array.isArray(revision.claimVersions))
          fail("复核缺少结论版本快照。");
        if (revision.claimVersions.length !== references.length)
          fail("复核结论版本快照不完整。");
        for (const [refIndex, ref] of revision.claimVersions.entries()) {
          if (
            !object(ref) ||
            ref.claimId !== references[refIndex] ||
            !Number.isSafeInteger(ref.version) ||
            ref.version < 1
          )
            fail("复核结论版本快照无效。");
          const claim = project.claims.find(
            (entry) => entry.id === ref.claimId,
          );
          if (!claim || !contentAt(claim, ref.version))
            fail("复核引用了不存在的结论版本。");
        }
      }
    }
  }
  const latest = entity.revisions.at(-1);
  if (!same(fields(latest, kind), fields(entity, kind)))
    fail("当前内容与最后一次复核版本不一致。");
  if (kind !== "claim" && !isPending(entity, kind)) {
    if (
      latest.claimVersions.some((ref) => {
        const claim = project.claims.find((entry) => entry.id === ref.claimId);
        return (
          contentVersion(claim) !== ref.version ||
          claim.status === "needs_review"
        );
      })
    )
      fail("关联结论已变化，必须保留逐项复核提醒。");
  }
}

/** Pure preview; its token binds the visible baseline and current dependencies. */
export function buildReviewPreview(project, kind, entityId) {
  const entity = findEntity(project, kind, entityId);
  if (!isPending(entity, kind))
    fail("此对象没有待处理的复核提醒。", "REVIEW_NOT_REQUIRED", 409);
  const sources = new Map(project.sources.map((entry) => [entry.id, entry]));
  const blockedBy =
    kind === "claim"
      ? []
      : entity.claimIds
          .map((id) => project.claims.find((entry) => entry.id === id))
          .filter((claim) => claim.status === "needs_review")
          .map((claim) => ({ claimId: claim.id, text: claim.text }));
  const sourceComparisons = [];
  if (kind === "claim") {
    const seen = new Set();
    for (const ref of entity.evidence) {
      const key = JSON.stringify([ref.sourceId, ref.versionId]);
      if (seen.has(key)) continue;
      seen.add(key);
      const source = sources.get(ref.sourceId);
      sourceComparisons.push({
        sourceId: source.id,
        title: source.title,
        previousVersionId: ref.versionId,
        currentVersionId: source.currentVersionId,
        previousContent: source.versions.find(
          (version) => version.id === ref.versionId,
        ).content,
        currentContent: source.versions.at(-1).content,
      });
    }
  }
  const previousRefs = entity.revisions?.at(-1).claimVersions ?? null;
  const claimComparisons =
    kind === "claim"
      ? []
      : entity.claimIds.map((id) => {
          const claim = project.claims.find((entry) => entry.id === id);
          const previousVersion =
            previousRefs?.find((ref) => ref.claimId === id)?.version ?? null;
          return {
            claimId: id,
            previousVersion,
            currentVersion: contentVersion(claim),
            previousText:
              previousVersion === null
                ? null
                : contentAt(claim, previousVersion).text,
            currentText: claim.text,
          };
        });
  const baseline = {
    kind,
    entityId,
    baseVersion: contentVersion(entity),
    baseline: structuredClone(fields(entity, kind)),
    blockedBy,
    sourceComparisons,
    claimComparisons,
  };
  // Include exact content and transitive source versions, even if version numbers
  // did not change because a source update only set a review flag.
  const linkedClaims =
    kind === "claim"
      ? [entity]
      : entity.claimIds.map((id) =>
          project.claims.find((entry) => entry.id === id),
        );
  const dependencies = linkedClaims.map((claim) => ({
    id: claim.id,
    version: contentVersion(claim),
    status: claim.status,
    evidence: claim.evidence.map((ref) => ({
      ...ref,
      currentVersionId: sources.get(ref.sourceId).currentVersionId,
    })),
  }));
  const reviewToken = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: project.id,
        baseline,
        content: fields(entity, kind),
        dependencies,
      }),
    )
    .digest("hex");
  return { ...baseline, reviewToken };
}

/** Applies only to the caller's cloned project after ownership validation. */
export function applyEntityReview(project, kind, payload, ctx) {
  const entity = findEntity(project, kind, payload.entityId);
  const preview = buildReviewPreview(project, kind, entity.id);
  if (
    !Number.isSafeInteger(payload.baseVersion) ||
    payload.baseVersion < 1 ||
    typeof payload.reviewToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.reviewToken)
  )
    fail("请先查看当前内容与依据，再确认复核。");
  if (
    payload.baseVersion !== preview.baseVersion ||
    payload.reviewToken !== preview.reviewToken
  )
    fail(
      "资料或关联结论已经变化，请重新查看对照后确认。输入内容已保留。",
      "REVIEW_STALE",
      409,
    );
  if (preview.blockedBy.length)
    fail("请先逐项复核关联结论，再核对这项任务或草稿。", "REVIEW_BLOCKED", 409);
  const reason = text(payload.reason, "复核说明", 1000);
  let nextFields;
  if (kind === "claim") {
    const nextEvidence = validEvidence(project, payload.evidence);
    if (!same(sourceIds(nextEvidence), sourceIds(entity.evidence)))
      fail("本阶段复核需保留原结论关联的全部资料，不能增删资料。");
    if (
      nextEvidence.some((ref) => sourcesCurrent(project, ref) !== ref.versionId)
    )
      fail(
        "复核依据必须明确引用资料当前版本，请重新查看对照。",
        "REVIEW_STALE",
        409,
      );
    nextFields = {
      text: text(payload.text, "结论内容", 4000),
      evidence: nextEvidence,
    };
  } else {
    nextFields = {
      title: text(payload.title, "标题", 120),
      ...(kind === "artifact"
        ? { content: text(payload.content, "草稿内容", 100000) }
        : {}),
      claimIds: [...entity.claimIds],
    };
  }
  if (!entity.revisions) {
    entity.revisions = [
      {
        number: 1,
        recordedAt: ctx.now,
        reason: INITIAL_REASON,
        ...structuredClone(fields(entity, kind)),
        ...(kind === "claim" ? {} : { claimVersions: null }),
      },
    ];
  }
  const revision = {
    number: preview.baseVersion + 1,
    recordedAt: ctx.now,
    reason,
    ...structuredClone(nextFields),
    ...(kind === "claim"
      ? {}
      : {
          claimVersions: entity.claimIds.map((id) => ({
            claimId: id,
            version: contentVersion(
              project.claims.find((claim) => claim.id === id),
            ),
          })),
        }),
  };
  entity.revisions.push(revision);
  Object.assign(entity, nextFields);
  if (kind === "task") entity.reviewRequired = false;
  else entity.status = kind === "claim" ? "linked" : "draft";
  if (kind === "claim") {
    for (const task of project.tasks)
      if (task.claimIds.includes(entity.id)) task.reviewRequired = true;
    for (const artifact of project.artifacts)
      if (artifact.claimIds.includes(entity.id))
        artifact.status = "needs_review";
  }
  return entity;
}
function sourcesCurrent(project, ref) {
  return project.sources.find((source) => source.id === ref.sourceId)
    .currentVersionId;
}
