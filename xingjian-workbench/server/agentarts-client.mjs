/** Prepared AgentArts InvokeRuntime transport. No dispatch is possible by default. */
const RESPONSE_LIMIT = 256 * 1024;
const REQUEST_LIMIT = 256 * 1024;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_KEYS = new Set(["event", "data", "createdTime"]);
const DATA_KEYS = new Set([
  "text", "index", "node_id", "node_type", "node_name", "workflow_id",
  "workflow_name", "createdTime",
]);
const MESSAGES = {
  AGENTARTS_DISABLED: "AgentArts 尚未启用；没有发送资料。",
  AGENTARTS_CONFIG_REQUIRED: "AgentArts 配置不完整；没有发送资料。",
  AGENTARTS_CONFIG_INVALID: "AgentArts 配置不符合调用约束；没有发送资料。",
  AGENTARTS_BUDGET_REQUIRED: "需要显式设置 AgentArts 调用次数上限；没有发送资料。",
  AGENTARTS_PREPARED_UNVERIFIED: "调用配置已准备，尚未验证真实平台链路。",
  AGENTARTS_BUDGET_EXHAUSTED: "本服务实例的调用上限已用完；没有自动重试。",
  AGENTARTS_REQUEST_INVALID: "调用请求不符合固定的研究分析协议；没有发送资料。",
  AGENTARTS_REQUEST_TOO_LARGE: "本次调用输入超出大小限制；没有发送资料。",
  AGENTARTS_ABORTED: "已停止本地等待；不能据此保证云端运行或计费已经停止。",
  AGENTARTS_TIMEOUT: "云端调用超过等待时限；没有自动重试。",
  AGENTARTS_NETWORK: "云端连接失败；没有自动重试。",
  AGENTARTS_HTTP: "云端返回非成功状态；请在平台核对调用记录。",
  AGENTARTS_RESPONSE_TOO_LARGE: "云端响应超出大小限制；结果未保存为提案。",
  AGENTARTS_RESPONSE_UNSUPPORTED: "云端响应不符合约定的结束节点格式；结果未保存为提案。",
  AGENTARTS_REMOTE_ERROR: "云端工作流报告执行失败；请在平台核对调用记录。",
};

export class AgentArtsClientError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.AGENTARTS_NETWORK);
    this.name = "AgentArtsClientError";
    this.code = code;
    this.status = code === "AGENTARTS_ABORTED" ? 409 : 502;
  }
}
const fail = (code) => { throw new AgentArtsClientError(code); };
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.has(key));

function configuration(env, fetchImpl) {
  const enabled = env.XINGJIAN_AGENTARTS_ENABLED === "true";
  const runtimeName = env.XINGJIAN_AGENTARTS_RUNTIME_NAME ?? "";
  const applicationVersion = env.XINGJIAN_AGENTARTS_APPLICATION_VERSION || null;
  const apiKey = env.XINGJIAN_AGENTARTS_API_KEY ?? "";
  const rawBudget = env.XINGJIAN_AGENTARTS_MAX_CALLS ?? "";
  const maxCalls = /^[1-9]\d{0,5}$/.test(rawBudget) ? Number(rawBudget) : 0;
  const rawTimeout = env.XINGJIAN_AGENTARTS_TIMEOUT_MS ?? "30000";
  const timeout = /^[1-9]\d{0,4}$/.test(rawTimeout) ? Number(rawTimeout) : 0;
  let code = enabled ? "AGENTARTS_CONFIG_REQUIRED" : "AGENTARTS_DISABLED";
  let url = null;
  const validRuntime = NAME.test(runtimeName) && runtimeName !== apiKey;
  const validVersion = applicationVersion === null ||
    (/^[A-Za-z0-9_.-]{1,80}$/.test(applicationVersion) && applicationVersion !== apiKey);
  if (enabled && runtimeName && apiKey && env.XINGJIAN_AGENTARTS_INVOKE_URL) {
    try {
      url = new URL(env.XINGJIAN_AGENTARTS_INVOKE_URL);
      if (!validRuntime || !validVersion || typeof fetchImpl !== "function" ||
          !/^[\x21-\x7e]{1,4096}$/.test(apiKey) ||
          url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          url.pathname !== `/runtimes/${runtimeName}/invocations` ||
          timeout < 1 || timeout > 60000) {
        code = "AGENTARTS_CONFIG_INVALID";
      } else {
        code = maxCalls > 0 ? "AGENTARTS_PREPARED_UNVERIFIED" : "AGENTARTS_BUDGET_REQUIRED";
      }
    } catch {
      code = "AGENTARTS_CONFIG_INVALID";
    }
  }
  return {
    url: url?.href ?? null, apiKey, timeout,
    status: {
      configured: code === "AGENTARTS_PREPARED_UNVERIFIED", code,
      reason: MESSAGES[code], runtimeName: validRuntime ? runtimeName : null,
      applicationVersion: validVersion ? applicationVersion : null, maxCalls,
    },
  };
}

function requestBody(run, runtimeName) {
  if (!plain(run) || run.provider !== "agentarts" ||
      !plain(run.request) || run.request.intent !== "research" ||
      typeof run.request.question !== "string" || !run.request.question.trim() ||
      run.request.question.length > 2000 || !plain(run.snapshot) ||
      run.snapshot.schemaVersion !== "xingjian.run-snapshot.v1" ||
      !plain(run.invocation) || !TRACE_ID.test(run.invocation.requestId) ||
      !NAME.test(run.invocation.sessionId) || run.invocation.runtimeName !== runtimeName) {
    fail("AGENTARTS_REQUEST_INVALID");
  }
  let body;
  try {
    body = JSON.stringify({
      inputs: {
        question: run.request.question,
        snapshot_json: JSON.stringify(run.snapshot),
        contract_version: "xingjian.analysis-proposal.v1",
      },
    });
  } catch {
    fail("AGENTARTS_REQUEST_INVALID");
  }
  if (Buffer.byteLength(body, "utf8") > REQUEST_LIMIT) fail("AGENTARTS_REQUEST_TOO_LARGE");
  return body;
}

function parseEvent(event) {
  if (!plain(event) || !onlyKeys(event, EVENT_KEYS) || !plain(event.data)) {
    fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  }
  if (event.event === "error") fail("AGENTARTS_REMOTE_ERROR");
  if (event.event !== "message" || !onlyKeys(event.data, DATA_KEYS) ||
      typeof event.data.node_type !== "string") fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  if (event.data.node_type !== "End") return null;
  if (typeof event.data.text !== "string" || !event.data.text.trim()) {
    fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  }
  let result;
  try { result = JSON.parse(event.data.text); } catch { fail("AGENTARTS_RESPONSE_UNSUPPORTED"); }
  if (!plain(result) || Object.keys(result).length !== 1 || !plain(result.proposal)) {
    fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  }
  return result.proposal;
}

function parseResponse(text, contentType) {
  let events;
  if (contentType === "application/json") {
    try { events = [JSON.parse(text)]; } catch { fail("AGENTARTS_RESPONSE_UNSUPPORTED"); }
  } else if (contentType === "text/event-stream") {
    events = [];
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (!normalized.endsWith("\n\n")) fail("AGENTARTS_RESPONSE_UNSUPPORTED");
    const blocks = normalized.split("\n\n");
    for (const block of blocks) {
      const lines = block.split("\n").filter((line) => line && !line.startsWith(":"));
      if (!lines.length) continue;
      const values = [];
      for (const line of lines) {
        if (line.startsWith("data:")) values.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) {
          if (line.slice(6).trim() !== "message") fail("AGENTARTS_RESPONSE_UNSUPPORTED");
        } else fail("AGENTARTS_RESPONSE_UNSUPPORTED");
      }
      if (!values.length || events.length >= 256) fail("AGENTARTS_RESPONSE_UNSUPPORTED");
      try { events.push(JSON.parse(values.join("\n"))); } catch { fail("AGENTARTS_RESPONSE_UNSUPPORTED"); }
    }
  } else fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  let proposal = null;
  for (const event of events) {
    const candidate = parseEvent(event);
    if (proposal !== null) fail("AGENTARTS_RESPONSE_UNSUPPORTED");
    if (candidate !== null) proposal = candidate;
  }
  if (proposal === null) fail("AGENTARTS_RESPONSE_UNSUPPORTED");
  return proposal;
}

/** Uses a private snapshot of server configuration; status never exposes URL or key. */
export function createAgentArtsProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = configuration(env, fetchImpl);
  let dispatchedCalls = 0; // Additional in-process guard; the manager enforces the persisted workspace cap.
  return {
    kind: "agentarts",
    status: () => ({ ...config.status }),
    async invoke({ run, signal } = {}) {
      if (!config.status.configured) fail(config.status.code);
      const body = requestBody(run, config.status.runtimeName);
      if (signal?.aborted) fail("AGENTARTS_ABORTED");
      if (dispatchedCalls >= config.status.maxCalls) fail("AGENTARTS_BUDGET_EXHAUSTED");
      const controller = new AbortController();
      let abortCode = "AGENTARTS_ABORTED", reader, responseBody, rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const onAbort = () => {
        // Do not wait for a remote stream's cancel implementation to resolve.
        try { reader?.cancel().catch(() => {}); } catch { /* Cancellation is best effort. */ }
        rejectAbort(new AgentArtsClientError(abortCode));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const externalAbort = () => controller.abort();
      signal?.addEventListener("abort", externalAbort, { once: true });
      const timer = setTimeout(() => { abortCode = "AGENTARTS_TIMEOUT"; controller.abort(); }, config.timeout);
      dispatchedCalls += 1;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(config.url, {
              method: "POST", redirect: "error", signal: controller.signal,
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                "x-hw-agentarts-session-id": run.invocation.sessionId,
                "X-Request-Id": run.invocation.requestId,
                "X-Invoke-Mode": "published",
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
              },
              body,
            });
            responseBody = response?.body;
            if (controller.signal.aborted) fail(abortCode);
            if (!response || response.status !== 200 || response.redirected) fail("AGENTARTS_HTTP");
            const contentLength = response.headers.get("content-length");
            if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > RESPONSE_LIMIT) {
              fail("AGENTARTS_RESPONSE_TOO_LARGE");
            }
            const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
            if (contentType !== "application/json" && contentType !== "text/event-stream") {
              fail("AGENTARTS_RESPONSE_UNSUPPORTED");
            }
            if (!response.body?.getReader) fail("AGENTARTS_RESPONSE_UNSUPPORTED");
            reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let size = 0, text = "";
            while (true) {
              const { done, value } = await reader.read();
              if (controller.signal.aborted) fail(abortCode);
              if (done) break;
              size += value.byteLength;
              if (size > RESPONSE_LIMIT) fail("AGENTARTS_RESPONSE_TOO_LARGE");
              try { text += decoder.decode(value, { stream: true }); } catch { fail("AGENTARTS_RESPONSE_UNSUPPORTED"); }
            }
            try { text += decoder.decode(); } catch { fail("AGENTARTS_RESPONSE_UNSUPPORTED"); }
            const proposal = parseResponse(text, contentType);
            const platformId = response.headers.get("x-request-id");
            return {
              proposal,
              platformRequestId: platformId && TRACE_ID.test(platformId) && platformId !== config.apiKey ? platformId : null,
            };
          })(),
          aborted,
        ]);
      } catch (error) {
        if (error instanceof AgentArtsClientError) throw error;
        if (controller.signal.aborted) fail(abortCode);
        fail("AGENTARTS_NETWORK");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", externalAbort);
        controller.signal.removeEventListener("abort", onAbort);
        try {
          const cleanup = reader ? reader.cancel() : responseBody?.cancel();
          cleanup?.catch(() => {});
        } catch { /* Cleanup must never expose a transport error. */ }
      }
    },
  };
}
