import test from "node:test";
import assert from "node:assert/strict";
import { createAgentArtsProvider } from "../server/agentarts-client.mjs";

// All credentials, documents, endpoints and results in this file are synthetic.
// fetchImpl is always injected: no test can call a model or external endpoint.
const secret = "sk-test-fixture-only-not-a-real-key";
const runtime = "agent-arts-fixture";
const endpoint = `https://agentarts.example.invalid/runtimes/${runtime}/invocations`;
const env = () => ({
  XINGJIAN_AGENTARTS_ENABLED: "true",
  XINGJIAN_AGENTARTS_INVOKE_URL: endpoint,
  XINGJIAN_AGENTARTS_API_KEY: secret,
  XINGJIAN_AGENTARTS_RUNTIME_NAME: runtime,
  XINGJIAN_AGENTARTS_APPLICATION_VERSION: "fixture-v1",
  XINGJIAN_AGENTARTS_MAX_CALLS: "2",
});
const run = () => ({
  provider: "agentarts",
  request: { intent: "research", question: "核对合成资料", sourceIds: ["s1"] },
  snapshot: { schemaVersion: "xingjian.run-snapshot.v1", evidence: [{ id: "ev-1", quote: "合成内容" }] },
  invocation: { requestId: "request_1", sessionId: "session_1", runtimeName: runtime },
});
const proposal = { schemaVersion: "xingjian.analysis-proposal.v1", decision: "proposal", summary: "合成结果", claims: [], tasks: [], gaps: ["缺少资料"], questions: [] };
const event = () => ({ event: "message", data: { node_type: "End", node_id: "end", text: JSON.stringify({ proposal }) } });
const jsonResponse = (value = event(), headers = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json", ...headers },
});
const provider = (fetchImpl, patch = {}) => createAgentArtsProvider({ env: { ...env(), ...patch }, fetchImpl });
const safeError = async (client, code, input = { run: run() }) => {
  await assert.rejects(client.invoke(input), (error) => {
    assert.equal(error.code, code);
    const visible = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    assert.ok(!visible.includes(secret));
    assert.ok(!visible.includes(endpoint));
    assert.ok(!visible.includes("private-source-text"));
    return true;
  });
};

test("AgentArts defaults and every missing gate prevent dispatch without exposing configuration", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return jsonResponse(); };
  const disabled = createAgentArtsProvider({ env: {}, fetchImpl: transport });
  assert.equal(disabled.status().configured, false);
  await safeError(disabled, "AGENTARTS_DISABLED");
  for (const name of ["INVOKE_URL", "API_KEY", "RUNTIME_NAME"]) {
    await safeError(provider(transport, { [`XINGJIAN_AGENTARTS_${name}`]: "" }), "AGENTARTS_CONFIG_REQUIRED");
  }
  for (const budget of ["", "0", "-1", "1.5", "Infinity", "9999999"]) {
    await safeError(provider(transport, { XINGJIAN_AGENTARTS_MAX_CALLS: budget }), "AGENTARTS_BUDGET_REQUIRED");
  }
  const ready = provider(transport);
  assert.deepEqual(ready.status(), {
    configured: true, code: "AGENTARTS_PREPARED_UNVERIFIED",
    reason: "调用配置已准备，尚未验证真实平台链路。", runtimeName: runtime,
    applicationVersion: "fixture-v1", maxCalls: 2,
  });
  assert.ok(!JSON.stringify(ready.status()).includes(secret));
  assert.ok(!JSON.stringify(ready.status()).includes(endpoint));
  assert.equal(calls, 0);
});

test("HTTPS exact-runtime URL, header-safe keys and bounded timeout are required", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return jsonResponse(); };
  for (const url of [
    endpoint.replace("https:", "http:"), `${endpoint}?key=x`, `${endpoint}#x`,
    endpoint.replace("https://", "https://name:password@"), `${endpoint}/`,
    endpoint.replace(runtime, "different"), endpoint.replace("/runtimes/", "/agent/"), "not a url",
  ]) await safeError(provider(transport, { XINGJIAN_AGENTARTS_INVOKE_URL: url }), "AGENTARTS_CONFIG_INVALID");
  for (const value of ["key\nvalue", "Bearer key", " key", "x".repeat(4097)]) {
    await safeError(provider(transport, { XINGJIAN_AGENTARTS_API_KEY: value }), "AGENTARTS_CONFIG_INVALID");
  }
  for (const value of ["0", "60001", "3.2", "not a number"]) {
    await safeError(provider(transport, { XINGJIAN_AGENTARTS_TIMEOUT_MS: value }), "AGENTARTS_CONFIG_INVALID");
  }
  assert.equal(calls, 0);
});

test("official InvokeRuntime headers and named workflow inputs are sent once; ids are not fabricated", async () => {
  const input = run();
  let calls = 0;
  const client = provider(async (url, options) => {
    calls += 1;
    assert.equal(url, endpoint);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.headers["x-hw-agentarts-session-id"], input.invocation.sessionId);
    assert.equal(options.headers["X-Request-Id"], input.invocation.requestId);
    assert.equal(options.headers["X-Invoke-Mode"], "published");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ["inputs"]);
    assert.deepEqual(body.inputs, {
      question: input.request.question, snapshot_json: JSON.stringify(input.snapshot),
      contract_version: "xingjian.analysis-proposal.v1",
    });
    return jsonResponse(event(), { "x-request-id": "platform-request_123" });
  });
  assert.deepEqual(await client.invoke({ run: input }), { proposal, platformRequestId: "platform-request_123" });
  assert.equal(calls, 1);
  const noId = await provider(async () => jsonResponse()).invoke({ run: run() });
  assert.equal(noId.platformRequestId, null);
  const invalidId = await provider(async () => jsonResponse(event(), { "x-request-id": secret })).invoke({ run: run() });
  assert.equal(invalidId.platformRequestId, null);
});

test("research-only invocation metadata and bounded input are checked before transport", async () => {
  let calls = 0;
  const client = provider(async () => { calls += 1; return jsonResponse(); });
  for (const change of [
    (r) => { r.provider = "contract-test"; }, (r) => { r.request.intent = "planning"; },
    (r) => { r.invocation.sessionId = "unsafe\n"; }, (r) => { r.invocation.runtimeName = "other"; },
    (r) => { r.request.question = "x".repeat(2001); }, (r) => { delete r.invocation; },
  ]) { const input = run(); change(input); await safeError(client, "AGENTARTS_REQUEST_INVALID", { run: input }); }
  const large = run(); large.snapshot.extra = "x".repeat(300000);
  await safeError(client, "AGENTARTS_REQUEST_TOO_LARGE", { run: large });
  assert.equal(calls, 0);
});

test("bounded SSE accepts only one complete final End event with the configured JSON envelope", async () => {
  const begin = { event: "message", data: { node_type: "Start", text: null } };
  const text = `: keepalive\r\n\r\ndata: ${JSON.stringify(begin)}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(event())}\r\n\r\n`;
  const result = await provider(async () => new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } })).invoke({ run: run() });
  assert.deepEqual(result.proposal, proposal);
  for (const invalid of [
    text.trimEnd(), // Truncated SSE frames are never accepted.
    `data: ${JSON.stringify(event())}\n\ndata: ${JSON.stringify(event())}\n\n`,
    `data: ${JSON.stringify(event())}\n\ndata: ${JSON.stringify(begin)}\n\n`,
    `data: [DONE]\n\n`, `data: ${JSON.stringify(begin)}\n\n`,
    `event: error\ndata: ${JSON.stringify(event())}\n\n`,
  ]) await safeError(provider(async () => new Response(invalid, { headers: { "content-type": "text/event-stream" } })), "AGENTARTS_RESPONSE_UNSUPPORTED");
});

test("unknown structures, null output, natural language and remote errors fail closed", async () => {
  for (const value of [
    { outputs: { proposal } }, { proposal }, { ...event(), extra: "private-source-text" },
    { event: "message", data: { node_type: "End", text: null } },
    { event: "message", data: { node_type: "End", text: JSON.stringify(proposal) } },
    { event: "message", data: { node_type: "End", text: `result: ${JSON.stringify({ proposal })}` } },
    { event: "message", data: { node_type: "End", text: JSON.stringify({ proposal, other: "x" }) } },
    { event: "message", data: { node_type: "End", text: JSON.stringify({ proposal: [] }) } },
  ]) await safeError(provider(async () => jsonResponse(value)), "AGENTARTS_RESPONSE_UNSUPPORTED");
  await safeError(provider(async () => jsonResponse({ event: "error", data: { message: `private-source-text ${secret} ${endpoint}` } })), "AGENTARTS_REMOTE_ERROR");
  await safeError(provider(async () => new Response("private-source-text", { headers: { "content-type": "text/html" } })), "AGENTARTS_RESPONSE_UNSUPPORTED");
});

test("transport and HTTP errors are redacted, redirects refused and failures consume the cap without retry", async () => {
  let calls = 0;
  const client = provider(async () => { calls += 1; throw new Error(`${secret} ${endpoint} private-source-text`); }, { XINGJIAN_AGENTARTS_MAX_CALLS: "1" });
  await safeError(client, "AGENTARTS_NETWORK");
  await safeError(client, "AGENTARTS_BUDGET_EXHAUSTED");
  assert.equal(calls, 1);
  for (const status of [302, 401, 429, 500]) {
    await safeError(provider(async () => new Response(`${secret} private-source-text`, { status })), "AGENTARTS_HTTP");
  }
  await safeError(provider(async () => ({ status: 200, redirected: true })), "AGENTARTS_HTTP");
});

test("response size limits count streamed bytes and reject oversized advertised bodies", async () => {
  await safeError(provider(async () => jsonResponse(event(), { "content-length": "262145" })), "AGENTARTS_RESPONSE_TOO_LARGE");
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(262145)); },
    cancel() { canceled = true; },
  });
  await safeError(provider(async () => new Response(stream, { headers: { "content-type": "application/json" } })), "AGENTARTS_RESPONSE_TOO_LARGE");
  assert.equal(canceled, true);
});

test("external abort and total timeout cover stalled fetch and body reads with best-effort cleanup", async () => {
  const canceled = new AbortController(); canceled.abort();
  let calls = 0;
  await safeError(provider(async () => { calls += 1; return jsonResponse(); }), "AGENTARTS_ABORTED", { run: run(), signal: canceled.signal });
  assert.equal(calls, 0);
  await safeError(provider(() => new Promise(() => {}), { XINGJIAN_AGENTARTS_TIMEOUT_MS: "20" }), "AGENTARTS_TIMEOUT");
  let bodyCanceled = false;
  const body = new ReadableStream({ start() {}, cancel() { bodyCanceled = true; } });
  const waiting = provider(async () => new Response(body, { headers: { "content-type": "application/json" } }), { XINGJIAN_AGENTARTS_TIMEOUT_MS: "20" });
  await safeError(waiting, "AGENTARTS_TIMEOUT");
  assert.equal(bodyCanceled, true);
  const controller = new AbortController();
  const inflight = safeError(provider(() => new Promise(() => {})), "AGENTARTS_ABORTED", { run: run(), signal: controller.signal });
  controller.abort(); await inflight;
});
