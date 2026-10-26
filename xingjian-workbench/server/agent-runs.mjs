import { randomUUID } from "node:crypto";
import { createAgentArtsProvider } from "./agentarts-client.mjs";

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const failures = {
  AGENTARTS_DISABLED: "云端调用尚未启用；请求已保留，没有发送资料。",
  AGENTARTS_CONFIG_REQUIRED: "云端配置尚未齐备；请求已保留，没有发送资料。",
  AGENTARTS_CONFIG_INVALID: "云端配置无效，请在服务端核对后重新提交。",
  AGENTARTS_BUDGET_REQUIRED: "尚未设置允许的调用次数，没有发送资料。",
  AGENTARTS_BUDGET_EXHAUSTED: "本工作区已达到允许的调用次数，没有再次发送资料。",
  AGENTARTS_REQUEST_INVALID: "本次云端请求不符合已配置工作流的约定。",
  AGENTARTS_REQUEST_TOO_LARGE: "本次发送内容过大，请缩小资料范围。",
  AGENTARTS_TIMEOUT: "等待云端响应超时；没有自动重试。请核对记录后决定是否重新提交。",
  AGENTARTS_ABORTED: "本地已停止等待；是否停止云端执行以平台为准。",
  AGENTARTS_NETWORK: "暂时无法连接云端；请求记录保留，没有自动重试。",
  AGENTARTS_HTTP: "云端服务拒绝或未能完成请求，请核对服务端配置及平台状态。",
  AGENTARTS_RESPONSE_TOO_LARGE: "云端返回内容超出允许范围，未生成可确认提案。",
  AGENTARTS_RESPONSE_UNSUPPORTED: "云端返回内容不符合结束节点约定，未生成可确认提案。",
  AGENTARTS_REMOTE_ERROR: "平台报告本次执行失败，未生成可确认提案。",
  INVALID_AGENT_PROPOSAL: "返回提案未通过结构或证据校验，未加入结论和行动。",
  INVALID_AGENT_PROTOCOL: "返回内容未通过结构、版本或证据校验，未加入结论和行动。",
  AGENT_RUN_INTERRUPTED: "服务停止或本地等待已结束；本次不会自动重新调用云端。",
  AGENT_RUN_FAILED: "本次分析未能完成，记录已保留，没有自动重试。",
};
const safeError = (err) => {
  const code = Object.hasOwn(failures, err?.code) ? err.code : "AGENT_RUN_FAILED";
  return { code, message: failures[code] };
};
const activeStates = new Set(["queued", "running"]);

/** One local runner; the durable invocation marker consumes a call even on failure. */
export class AgentRuns {
  constructor(store, { provider = createAgentArtsProvider(), now = () => new Date().toISOString() } = {}) {
    if (!["agentarts", "contract-test"].includes(provider.kind)) throw new Error("不支持的分析来源。");
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.closed = false;
    this.active = null;
    this.scheduled = false;
    this.suspended = false;
    this.recover();
  }

  recover() {
    for (const project of this.store.state().projects)
      for (const run of project.agentRuns ?? [])
        if (activeStates.has(run.status))
          this.store.transitionAgentRun(project.ownerId, project.id, run.id, {
            status: "interrupted", message: failures.AGENT_RUN_INTERRUPTED,
            error: { code: "AGENT_RUN_INTERRUPTED", message: failures.AGENT_RUN_INTERRUPTED },
          });
  }

  configuration() {
    const status = this.provider.status();
    const attempted = this.store.state().projects.flatMap(p => p.agentRuns ?? [])
      .filter(run => run.provider === this.provider.kind && run.invocation !== null).length;
    return {
      provider: this.provider.kind,
      configured: status.configured && !this.suspended,
      reason: this.suspended ? "本地运行记录无法更新；已停止派发，请检查存储后重启服务。" : status.reason,
      code: this.suspended ? "AGENT_RUN_STORAGE_ERROR" : status.code,
      runtimeName: status.runtimeName,
      applicationVersion: status.applicationVersion,
      maxCalls: status.maxCalls,
      remainingCalls: Math.max(0, status.maxCalls - attempted),
    };
  }

  find(ownerId, projectId, runId) {
    const project = this.store.state().projects.find(p => p.id === projectId && p.ownerId === ownerId);
    const run = project?.agentRuns?.find(r => r.id === runId);
    if (!run) throw fail("NOT_FOUND", "运行不存在或无权访问。", 404);
    return run;
  }

  start(ownerId, input) {
    if (this.closed) throw fail("SERVICE_CLOSING", "服务正在退出，请稍后重新提交。", 503);
    if (this.suspended) throw fail("AGENT_RUN_STORAGE_ERROR", "本地记录无法更新，请检查存储后重启服务。", 503);
    const config = this.configuration();
    const command = {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      type: "create_agent_run",
      payload: { projectId: input.projectId, request: input.request, provider: this.provider.kind, authorizeCloud: input.authorizeCloud === true },
    };
    const replay = this.store.replayCommand(ownerId, command);
    if (replay) return replay;
    if (config.configured && input.authorizeCloud !== true)
      throw fail("CLOUD_AUTHORIZATION_REQUIRED", "请先明确同意发送本次所选资料。", 400);
    const result = this.store.command(ownerId, command);
    if (result.replayed) return result;
    const runId = result.result.entityId;
    if (!config.configured || config.remainingCalls <= 0) {
      const code = config.configured ? "AGENTARTS_BUDGET_EXHAUSTED" : config.code;
      const error = safeError({ code });
      try {
        this.store.transitionAgentRun(ownerId, input.projectId, runId, { status: "blocked", error, message: error.message });
      } catch {
        this.suspended = true;
        throw fail("AGENT_RUN_STORAGE_ERROR", "本地运行记录无法更新，请检查存储后重启服务。", 503);
      }
      return { ...result, state: this.store.state() };
    }
    this.kick();
    return result;
  }

  kick() {
    if (this.closed || this.suspended || this.active || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.closed && !this.suspended && !this.active)
        void this.pump().catch(() => { this.suspended = true; });
    });
  }

  async pump() {
    if (this.closed || this.suspended || this.active) return;
    const project = this.store.state().projects.find(p => p.agentRuns?.some(run => run.status === "queued"));
    const queued = project?.agentRuns?.find(run => run.status === "queued");
    if (!queued || this.closed || this.active) return;
    const { ownerId } = project;
    const config = this.configuration();
    const controller = new AbortController();
    const current = { ownerId, projectId: project.id, runId: queued.id, controller };
    this.active = current;
    try {
      if (!config.configured || config.remainingCalls <= 0) {
        const error = safeError({ code: config.configured ? "AGENTARTS_BUDGET_EXHAUSTED" : config.code });
        this.store.transitionAgentRun(ownerId, project.id, queued.id, { status: "blocked", message: error.message, error });
        return;
      }
      const sourceChanged = queued.snapshot.sourceRevisions.some(ref => project.sources.find(source => source.id === ref.sourceId)?.currentVersionId !== ref.versionId);
      if (sourceChanged) {
        this.store.transitionAgentRun(ownerId, project.id, queued.id, {
          status: "interrupted", message: "等待期间资料已更新，没有发送旧资料；请按当前版本重新提交。",
          error: { code: "AGENT_RUN_INTERRUPTED", message: "等待期间资料已更新，请按当前版本重新提交。" },
        });
        return;
      }
      const startedAt = this.now();
      this.store.transitionAgentRun(ownerId, project.id, queued.id, {
        status: "running", message: queued.provider === "contract-test" ? "正在运行隔离契约测试，不代表真实云端调用。" : "开始向已配置的云端应用提交固定资料快照。",
        invocation: { requestId: randomUUID(), sessionId: randomUUID(), runtimeName: config.runtimeName, applicationVersion: config.applicationVersion, startedAt, platformRequestId: null },
      }, { now: startedAt });
      const run = this.find(ownerId, project.id, queued.id);
      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(fail("AGENTARTS_ABORTED", failures.AGENTARTS_ABORTED));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      let result;
      try {
        result = await Promise.race([this.provider.invoke({ run, signal: controller.signal }), aborted]);
      } finally {
        controller.signal.removeEventListener("abort", abortListener);
      }
      if (this.closed || controller.signal.aborted || this.find(ownerId, project.id, queued.id).status !== "running") return;
      this.store.transitionAgentRun(ownerId, project.id, queued.id, {
        status: result.proposal?.decision === "needs_input" ? "needs_input" : "proposal",
        message: "已收到返回内容并校验引用对应关系；仍需人工核对含义与确认。",
        proposal: result.proposal,
        platformRequestId: result.platformRequestId,
      });
    } catch (err) {
      // Never persist arbitrary provider error text: it can contain URLs or keys.
      if (this.find(ownerId, project.id, queued.id).status === "running") {
        const error = safeError(err);
        this.store.transitionAgentRun(ownerId, project.id, queued.id, { status: "failed", message: error.message, error });
      } else if (this.find(ownerId, project.id, queued.id).status === "queued") {
        const error = safeError(err);
        this.store.transitionAgentRun(ownerId, project.id, queued.id, { status: "blocked", message: error.message, error });
      }
    } finally {
      this.active = null;
      this.kick();
    }
  }

  interrupt(ownerId, projectId, runId) {
    const run = this.find(ownerId, projectId, runId);
    if (!activeStates.has(run.status)) return { state: this.store.state() };
    this.store.transitionAgentRun(ownerId, projectId, runId, { status: "interrupted", message: failures.AGENTARTS_ABORTED, error: { code: "AGENTARTS_ABORTED", message: failures.AGENTARTS_ABORTED } });
    if (this.active?.runId === runId && this.active.projectId === projectId) this.active.controller.abort();
    return { state: this.store.state() };
  }

  async close() {
    this.closed = true;
    try { this.recover(); }
    finally { this.active?.controller.abort(); }
  }
}
