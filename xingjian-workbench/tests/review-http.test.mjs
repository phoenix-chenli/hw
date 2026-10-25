import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WorkspaceStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

test("review HTTP preview, conflict and confirmation preserve project/local boundaries", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-review-http-"));
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
    "Content-Type": "application/json",
    "X-Xingjian-Client": "workspace-v1",
    Origin: base,
  };
  const send = (path, data, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(data),
    });
  let seq = 0;
  const command = (type, payload) =>
    send("/api/commands", {
      type,
      payload,
      expectedRevision: store.state().revision,
      operationId: `http-review-${++seq}`,
    });
  const loaded = await (await command("load_demo", {})).json();
  const p = loaded.state.projects[0],
    s = p.sources[0],
    c = p.claims[0];
  await command("update_source", {
    projectId: p.id,
    sourceId: s.id,
    baseVersionId: s.currentVersionId,
    content: "第二版合成数据",
  });
  const input = { projectId: p.id, kind: "claim", entityId: c.id };
  const before = store.state();
  const result = await send("/api/review/preview", input);
  assert.equal(result.status, 200);
  const preview = await result.json();
  assert.deepEqual(preview.baseline, { text: c.text, evidence: c.evidence });
  assert.deepEqual(store.state(), before);
  assert.equal(
    (
      await send("/api/review/preview", input, {
        Origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await send("/api/review/preview", input, { "X-Xingjian-Client": "" }))
      .status,
    403,
  );
  assert.equal(
    (await send("/api/review/preview", { ...input, projectId: "missing" }))
      .status,
    404,
  );
  assert.equal((await send("/api/review/preview", [])).status, 400);
  const payload = {
    projectId: p.id,
    entityId: c.id,
    baseVersion: preview.baseVersion,
    reviewToken: preview.reviewToken,
    reason: "已核对新版资料",
    text: "新版结论",
    evidence: [
      {
        sourceId: s.id,
        versionId: store.state().projects[0].sources[0].currentVersionId,
        locator: "第1行",
      },
    ],
  };
  await command("update_source", {
    projectId: p.id,
    sourceId: s.id,
    baseVersionId: payload.evidence[0].versionId,
    content: "第三版合成数据",
  });
  const stale = await command("review_claim", payload);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "REVIEW_STALE");
  const latest = await (await send("/api/review/preview", input)).json();
  const confirmed = await command("review_claim", {
    ...payload,
    reviewToken: latest.reviewToken,
    evidence: [
      {
        ...payload.evidence[0],
        versionId: latest.sourceComparisons[0].currentVersionId,
      },
    ],
  });
  assert.equal(confirmed.status, 200);
  assert.equal(store.state().projects[0].claims[0].status, "linked");
  assert.equal(store.state().projects[0].tasks[0].reviewRequired, true);
});
