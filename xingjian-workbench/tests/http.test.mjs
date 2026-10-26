import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WorkspaceStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-http-"));
  const store = new WorkspaceStore(join(dir, "workspace.json"));
  const server = createApp(store, { allowedPorts: [] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "X-Xingjian-Client": "workspace-v1",
    "Content-Type": "application/json",
    Origin: base,
  };
  const send = (path, value, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(value),
    });
  return { store, base, headers, send };
}

test("local API honestly reports capabilities and serves durable state", async (t) => {
  const { base, headers, send } = await fixture(t);
  const capability = await (
    await fetch(base + "/api/capabilities", { headers })
  ).json();
  assert.equal(capability.agentArts, "not-connected");
  assert.equal(capability.mode, "local-single-user");
  assert.equal(capability.stage, 5);
  assert.equal(capability.evidenceInspection, "recorded-text-positions");
  assert.equal(capability.sourceComparison, "bounded-line-diff");
  assert.equal(capability.reportExport, "fixed-template-local");
  assert.equal(capability.sourceReview, "individual-versioned-review");
  assert.equal(capability.sourceAnalysis, "local-keyword-and-csv");
  const saved = await send("/api/commands", {
    operationId: "http-command-01",
    expectedRevision: 0,
    type: "load_demo",
    payload: {},
  });
  assert.equal(saved.status, 200);
  const state = await (await fetch(base + "/api/state", { headers })).json();
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].isDemo, true);
  assert.equal(state.projects[0].ownerId, "local-user");
});

test("preview has no side effects; update preserves versions and stale write is rejected", async (t) => {
  const { store, send } = await fixture(t);
  const initial = await (
    await send("/api/commands", {
      operationId: "http-command-01",
      expectedRevision: 0,
      type: "load_demo",
      payload: {},
    })
  ).json();
  const p = initial.state.projects[0],
    s = p.sources[0];
  const content =
    s.versions.find((v) => v.id === s.currentVersionId).content +
    "\n新批次数据待核对。";
  const previewResponse = await send("/api/preview", {
    projectId: p.id,
    sourceId: s.id,
    content,
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(store.state(), initial.state);
  const command = {
    operationId: "http-command-02",
    expectedRevision: initial.state.revision,
    type: "update_source",
    payload: {
      projectId: p.id,
      sourceId: s.id,
      baseVersionId: preview.baseVersionId,
      content,
    },
  };
  const updated = await send("/api/commands", command);
  assert.equal(updated.status, 200);
  assert.equal(
    store.state().projects[0].sources[0].versions.length,
    s.versions.length + 1,
  );
  const stale = await send("/api/commands", {
    ...command,
    operationId: "http-command-03",
  });
  assert.equal(stale.status, 409);
  const replay = await send("/api/commands", command);
  assert.equal((await replay.json()).replayed, true);
});

test("foreign origins, missing client header and rebinding host cannot access local data", async (t) => {
  const { base, headers } = await fixture(t);
  for (const h of [
    {},
    { ...headers, Origin: "https://malicious.example" },
    { ...headers, Origin: "null" },
    { ...headers, "Sec-Fetch-Site": "cross-site" },
  ]) {
    const response = await fetch(base + "/api/state", { headers: h });
    assert.equal(response.status, 403, JSON.stringify(h));
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  // fetch normalizes Host; use the HTTP client to exercise actual DNS-rebinding headers.
  const code = await new Promise((resolve, reject) => {
    const request = httpRequest(
      base + "/api/state",
      { headers: { ...headers, Host: "malicious.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(code, 403);
});

test("bad JSON and wrong content type return structured errors without writes", async (t) => {
  const { base, headers, store } = await fixture(t);
  const malformed = await fetch(base + "/api/commands", {
    method: "POST",
    headers,
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");
  const wrongType = await fetch(base + "/api/commands", {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal(store.state().revision, 0);
});

test("HTTP callers cannot spoof ownership or operate on missing objects", async (t) => {
  const { send, store } = await fixture(t);
  const saved = await send("/api/commands", {
    operationId: "http-command-01",
    expectedRevision: 0,
    type: "create_project",
    payload: {
      title: "自己的研究",
      goal: "整理资料",
      ownerId: "another-user",
      deadline: null,
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(store.state().projects[0].ownerId, "local-user");
  const response = await send("/api/preview", {
    projectId: "does-not-exist",
    sourceId: "missing",
    content: "new",
  });
  assert.equal(response.status, 404);
});

test("oversized request is rejected before any data is written", async (t) => {
  const { send, store } = await fixture(t);
  const response = await send("/api/commands", { content: "x".repeat(270000) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "BODY_TOO_LARGE");
  assert.equal(store.state().revision, 0);
});

test("analysis API respects local/project boundaries, exposes errors and confirms server-held candidates", async (t) => {
  const { store, send, base } = await fixture(t);
  let sequence = 0;
  const command = async (type, payload) =>
    send("/api/commands", {
      operationId: `http-analysis-${++sequence}`,
      expectedRevision: store.state().revision,
      type,
      payload,
    });
  const p = (
    await (
      await command("create_project", {
        title: "分析接口",
        goal: "合成验证",
        deadline: null,
      })
    ).json()
  ).result.projectId;
  const s = (
    await (
      await command("add_source", {
        projectId: p,
        title: "合成表",
        kind: "table",
        content: "值\n1\n2",
      })
    ).json()
  ).result.entityId;
  const before = store.state();
  const catalog = await send("/api/analysis/catalog", {
    projectId: p,
    sourceId: s,
  });
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).rowCount, 2);
  assert.deepEqual(store.state(), before);
  assert.equal(
    (await send("/api/analysis/catalog", { projectId: "foreign", sourceId: s }))
      .status,
    404,
  );
  assert.equal(
    (
      await fetch(base + "/api/analysis/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: p, sourceId: s }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send(
        "/api/analysis/catalog",
        { projectId: p, sourceId: s },
        { Origin: "https://foreign.example" },
      )
    ).status,
    403,
  );
  const invalid = await command("run_analysis", {
    projectId: p,
    request: {
      mode: "calculate",
      sourceIds: [s],
      column: "missing",
      operation: "sum",
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "COLUMN_NOT_FOUND");
  assert.deepEqual(store.state(), before);
  const run = await (
    await command("run_analysis", {
      projectId: p,
      request: {
        mode: "calculate",
        sourceIds: [s],
        column: "值",
        operation: "sum",
      },
    })
  ).json();
  assert.equal(store.state().projects[0].claims.length, 0);
  assert.equal(
    (
      await command("accept_analysis", {
        projectId: p,
        analysisId: run.result.entityId,
        claimIds: ["claim-1"],
        taskIds: ["task-review"],
      })
    ).status,
    200,
  );
  assert.equal(store.state().projects[0].claims.length, 1);
});
