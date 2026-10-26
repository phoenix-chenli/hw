import type { Project, ReviewKind, Task } from "./contracts";

export interface ReviewQueueItem {
  kind: ReviewKind;
  entityId: string;
  title: string;
  taskStatus?: Task["status"];
  sources: { sourceId: string; title: string }[];
  blockedBy: { claimId: string; text: string }[];
}

export interface ReviewQueueFilters {
  kind: "all" | ReviewKind;
  sourceId: string;
  query: string;
  readiness: "all" | "ready" | "blocked";
}

export function buildReviewQueue(project: Project): ReviewQueueItem[];
export function filterReviewQueue(
  items: readonly ReviewQueueItem[],
  filters: ReviewQueueFilters,
): ReviewQueueItem[];
