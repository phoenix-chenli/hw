import test from "node:test";
import assert from "node:assert/strict";
import {
  splitTextLines,
  findTextMatches,
  lineRangeForSpan,
  compareText,
} from "../shared/text-inspection.mjs";

test("physical lines preserve CRLF, CR, empty/trailing lines and UTF-16 coordinates", () => {
  const text = "甲😀\r\n乙\r丙\n";
  assert.deepEqual(splitTextLines(text), [
    { number: 1, text: "甲😀", start: 0, end: 3, endWithBreak: 5 },
    { number: 2, text: "乙", start: 5, end: 6, endWithBreak: 7 },
    { number: 3, text: "丙", start: 7, end: 8, endWithBreak: 9 },
    { number: 4, text: "", start: 9, end: 9, endWithBreak: 9 },
  ]);
  assert.deepEqual(splitTextLines(""), [
    { number: 1, text: "", start: 0, end: 0, endWithBreak: 0 },
  ]);
  for (const value of ["", "a", "a\r\nb", "\r\n\r\n", text, "e\u0301\n😀"]) {
    const lines = splitTextLines(value);
    assert.equal(
      lines.map((line) => value.slice(line.start, line.endWithBreak)).join(""),
      value,
    );
    for (const line of lines)
      assert.equal(value.slice(line.start, line.end), line.text);
  }
});

test("literal search is case sensitive, nonoverlapping, bounded, and uses original UTF-16 offsets", () => {
  assert.deepEqual(findTextMatches("😀xx😀", "😀"), {
    matches: [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("AaA", "A"), {
    matches: [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("aaaaa", "aa"), {
    matches: [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("[a].*+", ".*"), {
    matches: [{ start: 3, end: 5 }],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("甲\r\n乙", "\r\n"), {
    matches: [{ start: 1, end: 3 }],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("abc", ""), {
    matches: [],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("abc", "ABC"), {
    matches: [],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("aaa", "a", 3), {
    matches: [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ],
    truncated: false,
  });
  assert.deepEqual(findTextMatches("aaaa", "a", 3), {
    matches: [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ],
    truncated: true,
  });
  assert.equal(findTextMatches("a".repeat(10000), "a").matches.length, 200);
  assert.equal(findTextMatches("a".repeat(10000), "a").truncated, true);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 10001])
    assert.throws(() => findTextMatches("abc", "a", invalid), RangeError);
});

test("span-to-lines rejects invalid bounds and handles newline-only and cross-line spans", () => {
  const lines = splitTextLines("甲😀\r\n乙\n");
  assert.deepEqual(lineRangeForSpan(lines, 1, 3), { startLine: 1, endLine: 1 });
  assert.deepEqual(lineRangeForSpan(lines, 3, 5), { startLine: 1, endLine: 1 });
  assert.deepEqual(lineRangeForSpan(lines, 3, 6), { startLine: 1, endLine: 2 });
  assert.deepEqual(lineRangeForSpan(lines, 5, 7), { startLine: 2, endLine: 2 });
  assert.deepEqual(lineRangeForSpan(lines, 0, 7), { startLine: 1, endLine: 2 });
  for (const [start, end] of [
    [-1, 1],
    [1, 1],
    [2, 1],
    [0, 8],
    [7, 8],
    [0.5, 1],
    [0, NaN],
    [0, Infinity],
  ])
    assert.equal(lineRangeForSpan(lines, start, end), null);
  assert.equal(lineRangeForSpan([], 0, 1), null);
  assert.equal(lineRangeForSpan(splitTextLines(""), 0, 1), null);
});

const normalized = (text) => splitTextLines(text).map((line) => line.text);
function reconstruct(result, side) {
  return result.rows
    .filter((row) => row.kind !== (side === "before" ? "added" : "removed"))
    .map((row) => row.text);
}
function verifyReconstruction(before, after, options) {
  const result = compareText(before, after, options);
  assert.deepEqual(reconstruct(result, "before"), normalized(before));
  assert.deepEqual(reconstruct(result, "after"), normalized(after));
  assert.ok(result.work <= result.maxWork);
  let oldNumber = 0;
  let newNumber = 0;
  for (const row of result.rows) {
    if (row.beforeLine !== null) assert.equal(row.beforeLine, ++oldNumber);
    if (row.afterLine !== null) assert.equal(row.afterLine, ++newNumber);
  }
  for (const change of result.changes) {
    assert.ok(
      result.rows
        .slice(change.start, change.end)
        .every((row) => row.kind !== "same"),
    );
    if (change.start > 0)
      assert.equal(result.rows[change.start - 1].kind, "same");
    if (change.end < result.rows.length)
      assert.equal(result.rows[change.end].kind, "same");
  }
  return result;
}

test("line diff identity, insertions, deletions and replacements preserve full contents and numbering", () => {
  for (const text of ["", "a", "甲\r\n😀\n", "a\na\na"]) {
    const result = verifyReconstruction(text, text);
    assert.equal(result.identical, true);
    assert.equal(result.formatChanged, false);
    assert.deepEqual(result.changes, []);
  }
  const insertion = verifyReconstruction("a\nc", "a\nb\nc");
  assert.deepEqual(
    insertion.rows.map((row) => row.kind),
    ["same", "added", "same"],
  );
  const deletion = verifyReconstruction("a\nb\nc", "a\nc");
  assert.deepEqual(
    deletion.rows.map((row) => row.kind),
    ["same", "removed", "same"],
  );
  const replacement = verifyReconstruction("a\nb\nc\nd\ne", "a\nx\nc\ny\ne");
  assert.equal(replacement.mode, "exact");
  assert.deepEqual(replacement.changes, [
    { start: 1, end: 3 },
    { start: 4, end: 6 },
  ]);
  for (const [before, after] of [
    ["", "a"],
    ["a", ""],
    ["甲\r\n😀", "甲\n乙\n😀"],
    ["a\nb\na", "b\na\nb"],
  ])
    verifyReconstruction(before, after);
});

test("format-only changes disclose CRLF and mixed newline changes including terminal newline", () => {
  const crlf = verifyReconstruction("a\r\nb", "a\nb");
  assert.equal(crlf.identical, false);
  assert.equal(crlf.formatChanged, true);
  assert.deepEqual(crlf.changes, []);
  const mixed = verifyReconstruction("a\r\nb\nc", "a\nb\r\nc");
  assert.equal(mixed.formatChanged, true);
  assert.deepEqual(mixed.changes, []);
  const terminal = verifyReconstruction("a\n", "a");
  assert.equal(terminal.formatChanged, true);
  assert.equal(terminal.changes.length, 1);
  assert.equal(verifyReconstruction("a\r\nb", "x\nb").formatChanged, true);
});

test("deterministic repeated-line matching reconstructs a range of changed inputs", () => {
  let seed = 217;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const tokens = ["a", "b", "a", "", "甲😀", "<script>"];
  for (let trial = 0; trial < 80; trial += 1) {
    const before = Array.from(
      { length: 1 + (random() % 20) },
      () => tokens[random() % tokens.length],
    ).join("\n");
    const after = Array.from(
      { length: 1 + (random() % 20) },
      () => tokens[random() % tokens.length],
    ).join("\n");
    const result = verifyReconstruction(before, after);
    assert.deepEqual(compareText(before, after), result);
  }
});

test("large documents fall back explicitly within fixed work, preserving common prefix/suffix and every line", () => {
  const before = `开头\n${Array.from({ length: 20000 }, (_, index) => `旧${index}`).join("\n")}\n末尾`;
  const after = `开头\n${Array.from({ length: 20000 }, (_, index) => `新${index}`).join("\n")}\n末尾`;
  const result = verifyReconstruction(before, after);
  assert.equal(result.mode, "coarse");
  assert.equal(result.work, 0);
  assert.equal(result.rows[0].kind, "same");
  assert.equal(result.rows.at(-1).kind, "same");
  assert.equal(result.changes.length, 1);
  const localized = Array.from(
    { length: 20000 },
    (_, index) => `行${index}`,
  ).join("\n");
  const localizedResult = verifyReconstruction(
    localized,
    localized.replace("行10000\n", "改10000\n"),
  );
  assert.equal(localizedResult.mode, "exact");
  assert.equal(localizedResult.work, 1);
  const tiny = verifyReconstruction("a\nb\nc", "x\ny\nz", { maxWork: 1 });
  assert.equal(tiny.mode, "coarse");
  for (const invalid of [0, -1, 1.2, Infinity, NaN, 1000001])
    assert.throws(
      () => compareText("a", "b", { maxWork: invalid }),
      RangeError,
    );
});
