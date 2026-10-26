export type TextLine = {
  number: number;
  text: string;
  start: number;
  end: number;
  endWithBreak: number;
};
export type TextMatch = { start: number; end: number };
export type DiffRow = {
  kind: "same" | "removed" | "added";
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};
export type TextComparison = {
  rows: DiffRow[];
  changes: { start: number; end: number }[];
  mode: "exact" | "coarse";
  formatChanged: boolean;
  identical: boolean;
  beforeLines: number;
  afterLines: number;
  work: number;
  maxWork: number;
};
export function splitTextLines(text: string): TextLine[];
export function findTextMatches(
  text: string,
  query: string,
  limit?: number,
): { matches: TextMatch[]; truncated: boolean };
export function lineRangeForSpan(
  lines: TextLine[],
  start: number,
  end: number,
): { startLine: number; endLine: number } | null;
export function compareText(
  before: string,
  after: string,
  options?: { maxWork?: number },
): TextComparison;
