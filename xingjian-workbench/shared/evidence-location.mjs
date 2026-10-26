import { splitTextLines, lineRangeForSpan } from "./text-inspection.mjs";

const unknown = (
  description = "这是手工定位说明，尚无可验证的字符位置。可在此资料版本中查找；不会推测原文件页码或自动搬移引用。",
) => ({
  kind: "unlocated",
  start: null,
  end: null,
  startLine: null,
  endLine: null,
  description,
});

/** Resolve only coordinates retained in a specific local analysis record.
 * The evidence text remains a locator description, never an executable query.
 */
export function resolveEvidenceLocation(project, target) {
  const source = project.sources.find((item) => item.id === target.sourceId);
  const version = source?.versions.find((item) => item.id === target.versionId);
  if (!version)
    return unknown(
      "此引用的资料或历史版本无法读取，请检查原记录；没有切换到其他资料。",
    );
  let run, candidate;
  if (target.analysisId !== undefined || target.candidateId !== undefined) {
    run = project.analyses?.find((item) => item.id === target.analysisId);
    candidate = run?.output.claims.find(
      (item) => item.id === target.candidateId,
    );
  } else if (
    target.claimId &&
    project.claims.some((item) => item.id === target.claimId)
  ) {
    run = project.analyses?.find(
      (item) =>
        item.status === "accepted" &&
        item.acceptance?.claims.some((ref) => ref.entityId === target.claimId),
    );
    const acceptance = run?.acceptance.claims.find(
      (ref) => ref.entityId === target.claimId,
    );
    candidate = run?.output.claims.find(
      (item) => item.id === acceptance?.candidateId,
    );
  }
  const recordedReference = candidate?.evidence.find(
    (ref) =>
      ref.sourceId === source.id &&
      ref.versionId === version.id &&
      (target.locator === undefined || target.locator === ref.locator),
  );
  if (
    !run ||
    !candidate ||
    !recordedReference ||
    !run.sourceRevisions.some(
      (ref) => ref.sourceId === source.id && ref.versionId === version.id,
    )
  )
    return unknown();
  const lines = splitTextLines(version.content);
  if (
    candidate.kind === "excerpt" &&
    candidate.location?.precision === "pasted_text_span"
  ) {
    const { start, end, line } = candidate.location;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > version.content.length ||
      typeof candidate.quote !== "string" ||
      version.content.slice(start, end) !== candidate.quote
    )
      return unknown(
        "留存的摘录位置与此版本原文不一致，未作高亮。可在此版本中查找后人工核对。",
      );
    const range = lineRangeForSpan(lines, start, end);
    if (!range || line !== range.startLine)
      return unknown("留存的行号与字符位置不一致，未作高亮。请核对原记录。");
    return {
      kind: "span",
      start,
      end,
      ...range,
      description:
        "已定位到本次分析留存的原文摘录。行号来自此版本的粘贴文本，不是原文件页码；高亮不代表结论已获证实。",
    };
  }
  if (
    candidate.kind === "calculation" &&
    candidate.calculation?.precision === "pasted_csv_rows"
  ) {
    const { firstLine, lastLine } = candidate.calculation;
    if (
      !Number.isSafeInteger(firstLine) ||
      !Number.isSafeInteger(lastLine) ||
      firstLine < 1 ||
      lastLine < firstLine ||
      lastLine > lines.length
    )
      return unknown(
        "留存的计算记录范围与此资料版本不一致，未作高亮。请核对原记录。",
      );
    return {
      kind: "lines",
      start: lines[firstLine - 1].start,
      end: lines[lastLine - 1].end,
      startLine: firstLine,
      endLine: lastLine,
      description: `已定位到计算时留存的 CSV 记录行范围（数值列：${candidate.calculation.column}）。范围内可能含记录间空行；未定位原文件页码，也未标注单个单元格。`,
    };
  }
  return unknown();
}
