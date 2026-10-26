export interface EvidenceTarget {
  sourceId: string;
  versionId: string;
  locator?: string;
  claimId?: string;
  analysisId?: string;
  candidateId?: string;
}
export interface EvidenceLocation {
  kind: "span" | "lines" | "unlocated";
  start: number | null;
  end: number | null;
  startLine: number | null;
  endLine: number | null;
  description: string;
}
