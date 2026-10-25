import type {
  Command,
  CommandResult,
  CommandType,
  ImpactPreview,
  Workspace,
  TableCatalog,
  ReviewPreview,
  ReviewKind,
  PlanRequest,
  PlanPreview,
} from "../shared/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Xingjian-Client": "workspace-v1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      data?.error?.message ?? "暂时无法完成操作，请稍后重试。",
      response.status,
      data?.error?.code ?? "REQUEST_FAILED",
    );
  }
  if (!data)
    throw new ApiError(
      "服务返回了无法读取的数据，请检查本地服务。",
      502,
      "INVALID_RESPONSE",
    );
  return data as T;
}

export const getWorkspace = () => request<Workspace>("state");
export const previewPlan = (projectId: string, planRequest: PlanRequest) =>
  request<PlanPreview>("plans/preview", { projectId, request: planRequest });
export const previewReview = (
  projectId: string,
  kind: ReviewKind,
  entityId: string,
) => request<ReviewPreview>("review/preview", { projectId, kind, entityId });
export const getTableCatalog = (projectId: string, sourceId: string) =>
  request<TableCatalog>("analysis/catalog", { projectId, sourceId });
export const previewUpdate = (
  projectId: string,
  sourceId: string,
  content: string,
) => request<ImpactPreview>("preview", { projectId, sourceId, content });
export const submitCommand = (command: Command) =>
  request<CommandResult>("commands", command);
export function makeCommand(
  type: CommandType,
  payload: Record<string, unknown>,
  revision: number,
): Command {
  return {
    type,
    payload,
    expectedRevision: revision,
    operationId: crypto.randomUUID(),
  };
}
