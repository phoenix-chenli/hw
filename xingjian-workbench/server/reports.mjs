import { createHash } from "node:crypto";
import { contentVersion } from "./review.mjs";

export class ReportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ReportError";
    this.code = code;
    this.status = status;
  }
}
const fail = (message, code = "INVALID_REPORT", status = 400) => {
  throw new ReportError(code, message, status);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/;
// XML 1.0 permits tab, LF and CR, but not other controls or lone surrogates.
export function assertXmlText(value) {
  if (typeof value !== "string") fail("报告文本格式无效。");
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      !(
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )
    )
      fail(
        "报告含有 XML 不支持的控制字符，请先修改对应内容。",
        "REPORT_XML_CHARACTER",
      );
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Stable hashes do not depend on JSON object property insertion order. */
export const reportHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const reportTextHash = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
function text(value, label, max, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    fail(`${label}${empty ? "" : "不能为空，且"}不能超过 ${max} 个字符。`);
  return assertXmlText(value);
}
function identifier(value, label) {
  if (text(value, label, 160).trim() !== value)
    fail(`${label}不能包含首尾空白。`);
  return value;
}
function list(value, label, max) {
  if (!Array.isArray(value) || value.length > max)
    fail(`${label}格式无效或超过数量上限 ${max}。`);
  return value;
}
function uniqueIds(values, label, max) {
  const ids = list(values, label, max).map((value) => identifier(value, label));
  if (new Set(ids).size !== ids.length) fail(`${label}不能重复。`);
  return ids;
}
function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(`${label}无效。`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label}必须是布尔值。`);
  return value;
}
function stamp(value) {
  if (typeof value !== "string") fail("报告记录时间无效。");
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== value)
    fail("报告记录时间须为有效 UTC 时间。");
  return value;
}
function revisionAt(entity, version) {
  return entity.revisions
    ? entity.revisions.find((entry) => entry.number === version)
    : version === 1
      ? entity
      : undefined;
}
function reviewedAt(entity) {
  const last = entity.revisions?.at(-1);
  return last?.number >= 2 ? last.recordedAt : null;
}
function normalizeRequest(project, input) {
  if (!object(input)) fail("报告请求格式无效。");
  const request = {
    title: text(input.title, "报告标题", 120).trim(),
    artifactIds: uniqueIds(input.artifactIds, "草稿 ID", 8),
    includeTasks: boolean(input.includeTasks, "包含关联任务"),
  };
  if (!request.artifactIds.length) fail("请至少选择一份草稿。");
  for (const id of request.artifactIds)
    if (!project.artifacts.some((entry) => entry.id === id))
      fail("所选草稿不存在或不属于此项目。", "NOT_FOUND", 404);
  return request;
}
function humanTextCount(spec) {
  return [
    spec.title,
    spec.project.title,
    spec.project.goal,
    ...spec.sections.flatMap((s) => [s.title, s.content]),
    ...spec.claims.flatMap((c) => [
      c.text,
      ...c.evidence.map((e) => e.locator),
    ]),
    ...spec.sources.map((s) => s.title),
    ...spec.tasks.flatMap((t) => [t.title, t.nextStep ?? ""]),
    ...spec.warnings.map((w) => w.message),
  ].reduce((total, value) => total + value.length, 0);
}
function validateTextBounds(spec) {
  if (humanTextCount(spec) > 60000)
    fail(
      "报告内容总计超过 60,000 个字符，请减少所选草稿后重试。",
      "REPORT_CONTENT_LIMIT",
    );
  const paragraphs = [
    spec.project.goal,
    ...spec.sections.map((section) => section.content),
    ...spec.claims.map((claim) => claim.text),
  ].reduce((count, value) => count + value.split(/\r\n|\r|\n/).length, 0);
  const evidenceLinks = spec.claims.reduce(
    (count, claim) => count + claim.evidence.length,
    0,
  );
  // Conservatively reserve nodes for the fixed metadata, lists and references.
  // This is checked before saving, below the XML adapter's 40,000-node ceiling.
  const nodeBudget =
    400 +
    paragraphs * 3 +
    evidenceLinks * 8 +
    spec.sections.length * 25 +
    spec.claims.length * 25 +
    spec.tasks.length * 25 +
    spec.sources.length * 20;
  if (nodeBudget > 30000)
    fail(
      "报告段落、空行或依据链接过多，请分批整理后再导出。",
      "REPORT_CONTENT_LIMIT",
    );
}
function tokenFor(projectId, request, spec) {
  return reportHash({
    engine: "fixed-template-report-v1",
    projectId,
    request,
    spec,
  });
}

/** Pure capture: never changes review flags, task progress or source content. */
export function buildReportPreview(project, input) {
  const request = normalizeRequest(project, input);
  const artifacts = request.artifactIds.map((id) =>
    project.artifacts.find((entry) => entry.id === id),
  );
  const claimIds = [...new Set(artifacts.flatMap((entry) => entry.claimIds))];
  if (claimIds.length > 80)
    fail("所选草稿关联结论超过 80 条，请分批导出。", "REPORT_CONTENT_LIMIT");
  const claims = claimIds.map((id) => {
    const claim = project.claims.find((entry) => entry.id === id);
    if (!claim) fail("草稿引用了本项目不存在的结论。");
    return {
      claimId: claim.id,
      text: text(claim.text, "结论", 4000),
      version: contentVersion(claim),
      needsReview: claim.status === "needs_review",
      reviewedAt: reviewedAt(claim),
      evidence: structuredClone(claim.evidence),
    };
  });
  const sources = [];
  const seen = new Set();
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      const key = canonical([evidence.sourceId, evidence.versionId]);
      text(evidence.locator, "依据位置", 240);
      if (seen.has(key)) continue;
      seen.add(key);
      const source = project.sources.find(
        (entry) => entry.id === evidence.sourceId,
      );
      const version = source?.versions.find(
        (entry) => entry.id === evidence.versionId,
      );
      if (!version) fail("报告只能引用本项目保留的资料版本。");
      sources.push({
        sourceId: source.id,
        title: text(source.title, "资料标题", 120),
        kind: source.kind,
        versionId: version.id,
        versionNumber: version.number,
        contentHash: reportTextHash(version.content),
        currentAtCapture: source.currentVersionId === version.id,
        currentVersionIdAtCapture: source.currentVersionId,
      });
    }
  }
  if (sources.length > 100)
    fail("报告引用超过 100 个资料版本，请分批导出。", "REPORT_CONTENT_LIMIT");
  const selectedClaimSet = new Set(claimIds);
  const tasks = request.includeTasks
    ? project.tasks
        .filter((entry) =>
          entry.claimIds.some((id) => selectedClaimSet.has(id)),
        )
        .map((task) => ({
          taskId: task.id,
          title: text(task.title, "任务标题", 120),
          status: task.status,
          reviewRequired: task.reviewRequired,
          version: contentVersion(task),
          // A related task can also link claims outside this report. Expose only selected links.
          claimIds: task.claimIds.filter((id) => selectedClaimSet.has(id)),
          nextStep: task.checkpoints?.at(-1)?.nextStep ?? null,
          checkpointNumber: task.checkpoints?.at(-1)?.number ?? 0,
        }))
    : [];
  if (tasks.length > 80)
    fail(
      "关联任务超过 80 条，请关闭任务附录或分批导出。",
      "REPORT_CONTENT_LIMIT",
    );
  const sections = artifacts.map((artifact) => ({
    artifactId: artifact.id,
    title: text(artifact.title, "草稿标题", 120),
    content: text(artifact.content, "草稿内容", 100000),
    version: contentVersion(artifact),
    needsReview: artifact.status === "needs_review",
    reviewedAt: reviewedAt(artifact),
    claimIds: [...artifact.claimIds],
  }));
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  if (project.isDemo)
    warn(
      "SYNTHETIC_DATA",
      "本项目含合成示例数据，导出仅供功能演示，不能作为真实研究结果。",
    );
  if (
    sections.some((s) => s.needsReview) ||
    claims.some((c) => c.needsReview) ||
    tasks.some((t) => t.reviewRequired)
  )
    warn(
      "PENDING_REVIEW",
      "报告包含待复核的草稿、结论或任务。请保留提醒，并在实际使用前逐项核对。",
    );
  if (
    sections.some((s) => s.reviewedAt === null) ||
    claims.some((c) => c.reviewedAt === null) ||
    tasks.some((t) => t.version < 2)
  )
    warn(
      "MANUAL_REVIEW_MISSING",
      "部分内容没有人工逐项复核历史；首次留存时间不代表完成复核，也不能当作原创建时间。",
    );
  if (
    artifacts.some(
      (a) => a.claimIds.length && !a.revisions?.at(-1)?.claimVersions,
    ) ||
    (request.includeTasks &&
      project.tasks.some(
        (t) =>
          tasks.some((v) => v.taskId === t.id) &&
          !t.revisions?.at(-1)?.claimVersions,
      ))
  )
    warn(
      "UNKNOWN_CLAIM_DEPENDENCIES",
      "部分草稿或任务的原关联结论版本未留存。报告并列记录当前快照，不补猜原始依赖版本。",
    );
  if (sections.some((s) => !s.claimIds.length))
    warn(
      "EMPTY_CLAIM_LINKS",
      "部分草稿没有关联结论，报告无法为这些段落提供结论到资料的溯源链。",
    );
  if (sources.some((s) => !s.currentAtCapture))
    warn(
      "HISTORICAL_SOURCE_VERSIONS",
      "部分结论仍引用历史资料版本；参考资料列出实际引用版本及捕获时的当前版本，请核对差异。",
    );
  const spec = {
    schemaVersion: "report-spec-v1",
    template: "research-progress-v1",
    project: {
      id: project.id,
      title: text(project.title, "项目标题", 120),
      goal: text(project.goal, "项目目标", 2000),
      isDemo: project.isDemo,
    },
    title: request.title,
    sections,
    claims,
    sources,
    tasks,
    warnings,
  };
  for (const task of tasks)
    if (task.nextStep !== null) text(task.nextStep, "任务下一步", 1000);
  validateTextBounds(spec);
  return {
    projectId: project.id,
    request,
    spec,
    previewToken: tokenFor(project.id, request, spec),
  };
}

export function saveReport(project, payload, ctx) {
  if ((project.reports?.length ?? 0) >= 30)
    fail("单个项目最多保留 30 份报告快照。", "REPORT_LIMIT");
  const preview = buildReportPreview(project, payload.request);
  if (
    typeof payload.previewToken !== "string" ||
    payload.previewToken !== preview.previewToken
  )
    fail(
      "报告内容、资料或任务已变化，请重新预览后保存。输入已保留。",
      "REPORT_STALE",
      409,
    );
  boolean(payload.acknowledgeWarnings, "报告提醒确认");
  if (preview.spec.warnings.length && !payload.acknowledgeWarnings)
    fail(
      "请先阅读并确认报告中的提醒，再保存此版本。",
      "REPORT_WARNINGS_ACK_REQUIRED",
    );
  const report = {
    id: identifier(ctx.id("report"), "报告 ID"),
    number: (project.reports?.length ?? 0) + 1,
    createdAt: stamp(ctx.now),
    ...preview,
  };
  report.contentHash = reportHash(report);
  (project.reports ??= []).push(report);
  return report;
}

export function getReport(project, reportId) {
  identifier(reportId, "报告 ID");
  const report = project.reports?.find((entry) => entry.id === reportId);
  if (!report) fail("报告不存在或不属于此项目。", "NOT_FOUND", 404);
  return report;
}
export function reportIsStale(project, report) {
  try {
    return (
      buildReportPreview(project, report.request).previewToken !==
      report.previewToken
    );
  } catch {
    return true;
  }
}

/** Verify immutable history against retained revisions, never against live review flags. */
export function validateReports(project, register) {
  let previousTime;
  for (const [index, report] of list(
    project.reports ?? [],
    "报告历史",
    30,
  ).entries()) {
    if (!object(report)) fail("报告快照格式无效。");
    register(identifier(report.id, "报告 ID"), "报告 ID");
    if (report.number !== index + 1 || report.projectId !== project.id)
      fail("报告编号或归属无效。");
    stamp(report.createdAt);
    if (previousTime && report.createdAt < previousTime)
      fail("报告记录时间不能倒退。");
    previousTime = report.createdAt;
    const request = normalizeRequest(project, report.request);
    if (!same(request, report.request)) fail("报告请求未规范化。");
    const spec = report.spec;
    if (
      !object(spec) ||
      spec.schemaVersion !== "report-spec-v1" ||
      spec.template !== "research-progress-v1" ||
      !object(spec.project) ||
      spec.project.id !== project.id ||
      spec.title !== request.title
    )
      fail("报告规格、模板或项目归属无效。");
    text(spec.project.title, "报告项目标题", 120);
    text(spec.project.goal, "报告项目目标", 2000);
    boolean(spec.project.isDemo, "报告示例标记");
    if (spec.project.isDemo !== project.isDemo)
      fail("报告示例标记与所属项目不一致。");
    if (spec.project.isDemo !== project.isDemo) fail("报告示例来源标记无效。");
    const sections = list(spec.sections, "报告章节", 8);
    if (
      !same(
        sections.map((s) => s.artifactId),
        request.artifactIds,
      )
    )
      fail("报告章节顺序与所选草稿不一致。");
    const selectedClaimIds = [];
    const validateReviewedAt = (entry, entity) => {
      if (entry.reviewedAt !== null) stamp(entry.reviewedAt);
      const revision = revisionAt(entity, entry.version);
      const expected = entry.version >= 2 ? revision?.recordedAt : null;
      if (!revision || entry.reviewedAt !== expected)
        fail("报告人工复核时间与内容版本不一致。");
      return revision;
    };
    for (const section of sections) {
      if (!object(section)) fail("报告章节格式无效。");
      const artifact = project.artifacts.find(
        (a) => a.id === section.artifactId,
      );
      if (!artifact) fail("报告引用了不存在的草稿。");
      integer(section.version, "报告草稿版本", 1, contentVersion(artifact));
      const revision = validateReviewedAt(section, artifact);
      text(section.title, "报告章节标题", 120);
      text(section.content, "报告章节内容", 100000);
      boolean(section.needsReview, "草稿复核标记");
      uniqueIds(section.claimIds, "章节关联结论", 80);
      if (
        !same(
          [section.title, section.content, section.claimIds],
          [revision.title, revision.content, revision.claimIds],
        )
      )
        fail("报告章节与对应历史草稿版本不一致。");
      selectedClaimIds.push(...section.claimIds);
    }
    const claimIds = [...new Set(selectedClaimIds)];
    const claims = list(spec.claims, "报告结论", 80);
    if (
      !same(
        claims.map((c) => c.claimId),
        claimIds,
      )
    )
      fail("报告结论必须且只能来自所选章节。");
    const usedSourcePairs = new Set();
    for (const claim of claims) {
      if (!object(claim)) fail("报告结论格式无效。");
      const entity = project.claims.find((c) => c.id === claim.claimId);
      if (!entity) fail("报告引用了不存在的结论。");
      integer(claim.version, "报告结论版本", 1, contentVersion(entity));
      const revision = validateReviewedAt(claim, entity);
      text(claim.text, "报告结论", 4000);
      boolean(claim.needsReview, "结论复核标记");
      if (
        !same([claim.text, claim.evidence], [revision.text, revision.evidence])
      )
        fail("报告结论与对应历史内容版本不一致。");
      for (const evidence of list(claim.evidence, "报告依据", 60000)) {
        text(evidence.locator, "依据位置", 240);
        usedSourcePairs.add(canonical([evidence.sourceId, evidence.versionId]));
      }
    }
    const sources = list(spec.sources, "报告引用版本", 100),
      pairs = new Set();
    const capturedCurrent = new Map();
    for (const source of sources) {
      if (!object(source)) fail("报告资料版本格式无效。");
      const original = project.sources.find((s) => s.id === source.sourceId);
      const version = original?.versions.find((v) => v.id === source.versionId);
      const captured = original?.versions.find(
        (v) => v.id === source.currentVersionIdAtCapture,
      );
      if (!version || !captured || captured.number < version.number)
        fail("报告资料版本或捕获时版本无效。");
      const key = canonical([source.sourceId, source.versionId]);
      if (pairs.has(key) || !usedSourcePairs.has(key))
        fail("报告资料版本重复或未被结论引用。");
      pairs.add(key);
      if (
        capturedCurrent.has(source.sourceId) &&
        capturedCurrent.get(source.sourceId) !== captured.id
      )
        fail("同一报告的资料当前版本快照不一致。");
      capturedCurrent.set(source.sourceId, captured.id);
      text(source.title, "报告资料标题", 120);
      if (
        !["note", "table", "document"].includes(source.kind) ||
        source.kind !== original.kind ||
        source.versionNumber !== version.number ||
        source.contentHash !== reportTextHash(version.content) ||
        source.currentAtCapture !== (source.versionId === captured.id)
      )
        fail("报告资料类型、哈希或版本标记无效。");
    }
    if (pairs.size !== usedSourcePairs.size) fail("报告资料版本索引不完整。");
    const tasks = list(spec.tasks, "报告任务", 80),
      seenTasks = new Set();
    if (!request.includeTasks && tasks.length)
      fail("未选择任务附录的报告不能包含任务。");
    for (const task of tasks) {
      if (!object(task) || seenTasks.has(task.taskId))
        fail("报告任务格式无效或重复。");
      seenTasks.add(task.taskId);
      const entity = project.tasks.find((t) => t.id === task.taskId);
      if (!entity) fail("报告任务不存在。");
      integer(task.version, "报告任务版本", 1, contentVersion(entity));
      const revision = revisionAt(entity, task.version);
      text(task.title, "报告任务标题", 120);
      boolean(task.reviewRequired, "任务复核标记");
      if (!["todo", "doing", "done"].includes(task.status))
        fail("报告任务进度无效。");
      const expectedLinks = revision.claimIds.filter((id) =>
        claimIds.includes(id),
      );
      if (
        !expectedLinks.length ||
        !same(task.claimIds, expectedLinks) ||
        task.title !== revision.title
      )
        fail("报告任务关联或历史内容无效。");
      integer(
        task.checkpointNumber,
        "报告继续点编号",
        0,
        entity.checkpoints?.length ?? 0,
      );
      if (
        task.checkpointNumber === 0
          ? task.nextStep !== null
          : task.nextStep !==
            entity.checkpoints[task.checkpointNumber - 1].nextStep
      )
        fail("报告下一步与历史继续点不一致。");
      if (task.nextStep !== null) text(task.nextStep, "报告下一步", 1000);
    }
    const warnings = list(spec.warnings, "报告提醒", 6),
      warningCodes = new Set();
    const knownCodes = new Set([
      "SYNTHETIC_DATA",
      "PENDING_REVIEW",
      "MANUAL_REVIEW_MISSING",
      "UNKNOWN_CLAIM_DEPENDENCIES",
      "EMPTY_CLAIM_LINKS",
      "HISTORICAL_SOURCE_VERSIONS",
    ]);
    for (const warning of warnings) {
      if (
        !object(warning) ||
        !knownCodes.has(warning.code) ||
        warningCodes.has(warning.code)
      )
        fail("报告提醒代码无效或重复。");
      warningCodes.add(warning.code);
      text(warning.message, "报告提醒", 2000);
    }
    if (spec.project.isDemo !== warningCodes.has("SYNTHETIC_DATA"))
      fail("报告必须明确标记合成示例数据。");
    for (const [condition, code] of [
      [
        sections.some((s) => s.needsReview) ||
          claims.some((c) => c.needsReview) ||
          tasks.some((t) => t.reviewRequired),
        "PENDING_REVIEW",
      ],
      [
        sections.some((s) => s.reviewedAt === null) ||
          claims.some((c) => c.reviewedAt === null) ||
          tasks.some((t) => t.version < 2),
        "MANUAL_REVIEW_MISSING",
      ],
      [sections.some((s) => s.claimIds.length === 0), "EMPTY_CLAIM_LINKS"],
      [sources.some((s) => !s.currentAtCapture), "HISTORICAL_SOURCE_VERSIONS"],
      [
        sections.some(
          (s) =>
            s.claimIds.length &&
            !revisionAt(
              project.artifacts.find((a) => a.id === s.artifactId),
              s.version,
            )?.claimVersions,
        ) ||
          tasks.some(
            (t) =>
              !revisionAt(
                project.tasks.find((a) => a.id === t.taskId),
                t.version,
              )?.claimVersions,
          ),
        "UNKNOWN_CLAIM_DEPENDENCIES",
      ],
    ])
      if (Boolean(condition) !== warningCodes.has(code))
        fail("报告提醒与保存内容不一致。");
    validateTextBounds(spec);
    if (
      !hashPattern.test(report.previewToken) ||
      report.previewToken !== tokenFor(project.id, request, spec)
    )
      fail("报告预览依据哈希不一致。");
    const { contentHash, ...snapshot } = report;
    if (!hashPattern.test(contentHash) || contentHash !== reportHash(snapshot))
      fail("报告快照完整性校验失败。");
  }
}
