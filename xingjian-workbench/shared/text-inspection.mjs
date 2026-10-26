/** Physical lines with exact UTF-16 coordinates in the original pasted string. */
export function splitTextLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    const end = index;
    if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
    lines.push({
      number: lines.length + 1,
      text: text.slice(start, end),
      start,
      end,
      endWithBreak: index + 1,
    });
    start = index + 1;
  }
  lines.push({
    number: lines.length + 1,
    text: text.slice(start),
    start,
    end: text.length,
    endWithBreak: text.length,
  });
  return lines;
}

/** Literal, case-sensitive, nonoverlapping search; never interpret the query as regex. */
export function findTextMatches(text, query, limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
    throw new RangeError("Search limit must be an integer from 1 to 10000");
  if (!query) return { matches: [], truncated: false };
  const matches = [];
  let cursor = 0;
  while (cursor <= text.length - query.length) {
    const start = text.indexOf(query, cursor);
    if (start < 0) break;
    if (matches.length === limit) return { matches, truncated: true };
    matches.push({ start, end: start + query.length });
    cursor = start + query.length;
  }
  return { matches, truncated: false };
}

/** Return physical lines containing a valid half-open nonempty UTF-16 span. */
export function lineRangeForSpan(lines, start, end) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    !lines.length ||
    end > lines.at(-1).endWithBreak
  )
    return null;
  const containing = (offset) => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle].endWithBreak <= offset) low = middle + 1;
      else high = middle;
    }
    return lines[low].number;
  };
  return { startLine: containing(start), endLine: containing(end - 1) };
}

const DEFAULT_MAX_WORK = 60000;

/**
 * Deterministic line LCS only within a fixed cell budget. Large differing blocks
 * become one explicitly coarse removal/addition block; no source text is lost.
 * Newline sequences are kept separately because a rendered line hides CR/LF.
 */
export function compareText(
  before,
  after,
  { maxWork = DEFAULT_MAX_WORK } = {},
) {
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 1000000)
    throw new RangeError(
      "Diff work budget must be an integer from 1 to 1000000",
    );
  const oldLines = splitTextLines(before);
  const newLines = splitTextLines(after);
  const rows = [];
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix].text === newLines[prefix].text
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix].text ===
      newLines[newLines.length - 1 - suffix].text
  )
    suffix += 1;
  const newlineKinds = (text, lines) =>
    [
      ...new Set(
        lines
          .filter((line) => line.endWithBreak > line.end)
          .map((line) => text.slice(line.end, line.endWithBreak)),
      ),
    ]
      .sort()
      .join("|");
  let formatChanged =
    /(?:\r\n|\r|\n)$/.test(before) !== /(?:\r\n|\r|\n)$/.test(after) ||
    newlineKinds(before, oldLines) !== newlineKinds(after, newLines);
  const push = (kind, oldIndex, newIndex) => {
    const oldLine = oldIndex === null ? null : oldLines[oldIndex];
    const newLine = newIndex === null ? null : newLines[newIndex];
    if (
      oldLine &&
      newLine &&
      before.slice(oldLine.end, oldLine.endWithBreak) !==
        after.slice(newLine.end, newLine.endWithBreak)
    )
      formatChanged = true;
    rows.push({
      kind,
      text: (oldLine ?? newLine).text,
      beforeLine: oldLine?.number ?? null,
      afterLine: newLine?.number ?? null,
    });
  };
  for (let index = 0; index < prefix; index += 1) push("same", index, index);
  const oldCount = oldLines.length - prefix - suffix;
  const newCount = newLines.length - prefix - suffix;
  const work = oldCount * newCount;
  const mode = work > maxWork ? "coarse" : "exact";
  if (!oldCount || !newCount || mode === "coarse") {
    for (let index = prefix; index < prefix + oldCount; index += 1)
      push("removed", index, null);
    for (let index = prefix; index < prefix + newCount; index += 1)
      push("added", null, index);
  } else {
    const width = newCount + 1;
    const matrix = new Uint32Array((oldCount + 1) * width);
    for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
        const cell = oldIndex * width + newIndex;
        matrix[cell] =
          oldLines[prefix + oldIndex].text === newLines[prefix + newIndex].text
            ? matrix[cell + width + 1] + 1
            : Math.max(matrix[cell + width], matrix[cell + 1]);
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldCount || newIndex < newCount) {
      if (
        oldIndex < oldCount &&
        newIndex < newCount &&
        oldLines[prefix + oldIndex].text === newLines[prefix + newIndex].text
      ) {
        push("same", prefix + oldIndex++, prefix + newIndex++);
      } else if (
        oldIndex < oldCount &&
        (newIndex === newCount ||
          matrix[(oldIndex + 1) * width + newIndex] >=
            matrix[oldIndex * width + newIndex + 1])
      ) {
        push("removed", prefix + oldIndex++, null);
      } else push("added", null, prefix + newIndex++);
    }
  }
  for (let index = suffix; index > 0; index -= 1)
    push("same", oldLines.length - index, newLines.length - index);
  const changes = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind === "same") continue;
    const start = index;
    while (index + 1 < rows.length && rows[index + 1].kind !== "same")
      index += 1;
    changes.push({ start, end: index + 1 });
  }
  return {
    rows,
    changes,
    mode,
    formatChanged,
    identical: before === after,
    beforeLines: oldLines.length,
    afterLines: newLines.length,
    work: mode === "coarse" ? 0 : work,
    maxWork,
  };
}
