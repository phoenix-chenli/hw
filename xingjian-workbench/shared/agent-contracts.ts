import type { Evidence } from "./contracts";

export type AgentIntent = "research" | "change_review" | "planning" | "draft";
export interface AgentRequest {
  intent: AgentIntent;
  question: string;
  sourceIds: string[];
}
export interface AgentSourceRevision {
  sourceId: string;
  versionId: string;
  title: string;
  kind: "note" | "table" | "document";
  contentHash: string;
}
export interface AgentEvidence extends Evidence {
  id: string;
  contentHash: string;
  /** Half-open offsets in the retained raw string, measured in UTF-16 units. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  quote: string;
}
export interface AgentSnapshot {
  schemaVersion: "xingjian.run-snapshot.v1";
  projectId: string;
  sourceRevisions: AgentSourceRevision[];
  evidence: AgentEvidence[];
  contextHash: string;
}
export interface AgentClaimCandidate {
  id: string;
  text: string;
  evidenceIds: string[];
}
export interface AgentTaskCandidate {
  id: string;
  title: string;
  claimIds: string[];
}
export interface AgentProposal {
  schemaVersion: "xingjian.analysis-proposal.v1";
  decision: "proposal" | "needs_input";
  summary: string;
  claims: AgentClaimCandidate[];
  tasks: AgentTaskCandidate[];
  gaps: string[];
  questions: string[];
}
export type AgentRunStatus =
  | "queued" | "running" | "blocked" | "needs_input" | "proposal"
  | "failed" | "interrupted" | "accepted";
export interface AgentInvocation {
  requestId: string;
  sessionId: string;
  runtimeName: string;
  /** Declared application label; null when not configured, not inferred. */
  applicationVersion: string | null;
  startedAt: string;
  platformRequestId: string | null;
}
export interface AgentRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  request: AgentRequest;
  snapshot: AgentSnapshot;
  authorization: { cloudTransfer: boolean; at: string | null; scopeHash: string };
  provider: "agentarts" | "contract-test";
  status: AgentRunStatus;
  events: { at: string; status: AgentRunStatus; message: string }[];
  invocation: AgentInvocation | null;
  proposal: AgentProposal | null;
  error: { code: string; message: string } | null;
  acceptance: {
    at: string;
    claims: { candidateId: string; entityId: string }[];
    tasks: { candidateId: string; entityId: string }[];
  } | null;
}
export interface AgentProviderConfig {
  provider: "agentarts" | "contract-test";
  configured: boolean;
  reason: string;
  code: string;
  runtimeName: string | null;
  applicationVersion: string | null;
  maxCalls: number;
  remainingCalls: number;
}
