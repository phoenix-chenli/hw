import type { AgentRequest } from "../shared/agent-contracts";
import type { CommandResult, Workspace } from "../shared/contracts";
import { ApiError } from "./api";

export interface AgentConfiguration {
  provider: "agentarts" | "contract-test";
  configured: boolean;
  reason: string;
  code: string;
  runtimeName: string | null;
  applicationVersion: string | null;
  maxCalls: number;
  remainingCalls: number;
}
export interface StartAgentRequest {
  operationId: string;
  expectedRevision: number;
  projectId: string;
  request: AgentRequest;
  authorizeCloud: boolean;
}

async function agentRequest<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/agent-runs${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "X-Xingjian-Client": "workspace-v1",
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      result?.error?.message ?? "分析服务暂时不可用，请稍后重试。",
      response.status,
      result?.error?.code ?? "AGENT_REQUEST_FAILED",
    );
  if (!result)
    throw new ApiError("无法读取分析服务返回的数据。", 502, "INVALID_RESPONSE");
  return result as T;
}

export const getAgentConfiguration = () =>
  agentRequest<AgentConfiguration>("/config");
export const startAgentRun = (request: StartAgentRequest) =>
  agentRequest<CommandResult>("", request);
export const interruptAgentRun = (projectId: string, runId: string) =>
  agentRequest<{ state: Workspace }>("/interrupt", { projectId, runId });
