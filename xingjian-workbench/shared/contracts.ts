export type EntityStatus = "linked" | "needs_review";
export interface SourceVersion {
  id: string;
  number: number;
  content: string;
  createdAt: string;
}
export interface Source {
  id: string;
  title: string;
  kind: "note" | "table" | "document";
  currentVersionId: string;
  versions: SourceVersion[];
}
export interface Evidence {
  sourceId: string;
  versionId: string;
  locator: string;
}
export interface Claim {
  id: string;
  text: string;
  evidence: Evidence[];
  status: EntityStatus;
  revisions?: ClaimRevision[];
}
export interface Task {
  id: string;
  title: string;
  claimIds: string[];
  status: "todo" | "doing" | "done";
  reviewRequired: boolean;
  revisions?: TaskRevision[];
  checkpoints?: TaskCheckpoint[];
}
export interface Artifact {
  id: string;
  title: string;
  content: string;
  claimIds: string[];
  status: "draft" | "needs_review";
  revisions?: ArtifactRevision[];
}
export interface ContentRevision {
  number: number;
  recordedAt: string;
  reason: string;
}
export interface ClaimRevision extends ContentRevision {
  text: string;
  evidence: Evidence[];
}
export interface TaskRevision extends ContentRevision {
  title: string;
  claimIds: string[];
  /** null means the legacy dependency versions were not recorded. */
  claimVersions: { claimId: string; version: number }[] | null;
}
export interface ArtifactRevision extends TaskRevision {
  content: string;
}
interface ReviewPreviewBase {
  entityId: string;
  baseVersion: number;
  reviewToken: string;
  blockedBy: { claimId: string; text: string }[];
  sourceComparisons: {
    sourceId: string;
    title: string;
    previousVersionId: string;
    currentVersionId: string;
    previousContent: string;
    currentContent: string;
  }[];
  claimComparisons: {
    claimId: string;
    previousVersion: number | null;
    currentVersion: number;
    previousText: string | null;
    currentText: string;
  }[];
}
export type ReviewKind = "claim" | "task" | "artifact";
export type ReviewPreview = ReviewPreviewBase &
  (
    | { kind: "claim"; baseline: { text: string; evidence: Evidence[] } }
    | { kind: "task"; baseline: { title: string; claimIds: string[] } }
    | {
        kind: "artifact";
        baseline: { title: string; content: string; claimIds: string[] };
      }
  );
export interface Activity {
  id: string;
  at: string;
  message: string;
}
export interface Project {
  id: string;
  ownerId: string;
  title: string;
  goal: string;
  deadline: string | null;
  createdAt: string;
  isDemo: boolean;
  sources: Source[];
  claims: Claim[];
  tasks: Task[];
  artifacts: Artifact[];
  activity: Activity[];
  analyses?: AnalysisRun[];
  busySlots?: BusySlot[];
  plans?: WorkPlan[];
}
export interface Workspace {
  schemaVersion: 1;
  revision: number;
  projects: Project[];
}
export interface ImpactItem {
  id: string;
  title: string;
  reason: string;
}
export interface ImpactPreview {
  projectId: string;
  sourceId: string;
  sourceTitle: string;
  baseVersionId: string;
  nextVersionNumber: number;
  previousContent: string;
  nextContent: string;
  claims: ImpactItem[];
  tasks: ImpactItem[];
  artifacts: ImpactItem[];
  hasChanges: boolean;
}
export type CommandType =
  | "create_project"
  | "load_demo"
  | "add_source"
  | "add_claim"
  | "add_task"
  | "add_artifact"
  | "update_source"
  | "set_task_status"
  | "run_analysis"
  | "accept_analysis"
  | "review_claim"
  | "review_task"
  | "review_artifact"
  | "save_checkpoint"
  | "add_busy_slot"
  | "deactivate_busy_slot"
  | "confirm_plan"
  | "cancel_plan";
export interface Command {
  operationId: string;
  expectedRevision: number;
  type: CommandType;
  payload: Record<string, unknown>;
}
export interface CommandResult {
  state: Workspace;
  result: { projectId: string; entityId?: string };
  replayed: boolean;
}

export type AnalysisRequest =
  | { mode: "search"; sourceIds: string[]; query: string }
  | {
      mode: "calculate";
      sourceIds: string[];
      column: string;
      operation: "sum" | "mean" | "min" | "max" | "count";
    };
export interface AnalysisCandidate {
  id: string;
  kind: "excerpt" | "calculation";
  text: string;
  evidence: Evidence[];
  quote?: string;
  location?: {
    precision: "pasted_text_span";
    start: number;
    end: number;
    line: number;
  };
  calculation?: {
    operation: string;
    column: string;
    result: string;
    formula: string;
    rowCount: number;
    rounded: boolean;
    precision: "pasted_csv_rows";
    firstLine: number;
    lastLine: number;
  };
}
export interface AnalysisRun {
  id: string;
  createdAt: string;
  request: AnalysisRequest;
  sourceRevisions: { sourceId: string; versionId: string }[];
  contextRevision: string;
  output: {
    engine: "local-tools-v1";
    platform: "not-connected";
    claims: AnalysisCandidate[];
    tasks: { id: string; title: string; claimIds: string[] }[];
    gaps: string[];
    trace: { tool: string; status: string; summary: string }[];
  };
  status: "pending" | "accepted";
  acceptance: {
    at: string;
    claims: { candidateId: string; entityId: string }[];
    tasks: { candidateId: string; entityId: string }[];
  } | null;
}
export interface TableCatalog {
  sourceId: string;
  versionId: string;
  rowCount: number;
  columns: { name: string; invalidRows: number[] }[];
}

export interface TaskCheckpoint {
  number: number;
  recordedAt: string;
  taskVersion: number;
  doneNote: string;
  nextStep: string;
  blocker: string;
  evidence: { sourceId: string; versionId: string } | null;
}
export interface BusySlot {
  id: string;
  title: string;
  kind: "class" | "busy";
  date: string;
  startTime: string;
  endTime: string;
  active: boolean;
  createdAt: string;
}
export interface PlanRequest {
  date: string;
  startTime: string;
  endTime: string;
  items: { taskId: string; durationMinutes: number }[];
  allowDuringClass: boolean;
}
export interface PlanBlock {
  taskId: string;
  title: string;
  taskVersion: number;
  checkpointNumber: number;
  sourceVersions: { sourceId: string; versionId: string }[];
  startTime: string;
  endTime: string;
  durationMinutes: number;
  classConflicts: {
    title: string;
    projectTitle: string;
    startTime: string;
    endTime: string;
  }[];
}
export interface PlanUnplaced {
  taskId: string;
  title: string;
  reason: string;
}
export interface PlanPreview {
  projectId: string;
  request: PlanRequest;
  timezone: "Asia/Shanghai";
  previewToken: string;
  blocks: PlanBlock[];
  unplaced: PlanUnplaced[];
}
export interface WorkPlan extends PlanPreview {
  id: string;
  createdAt: string;
  status: "confirmed" | "cancelled";
}
