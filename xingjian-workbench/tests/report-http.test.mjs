import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WorkspaceStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { PdfJobs } from "../server/pdf-jobs.mjs";

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xingjian-report-http-"));
  const file = join(directory, "workspace.json");
  let store = new WorkspaceStore(file);
  const pdfJobs = new PdfJobs(join(directory, "exports"), {
    render: async ({ outputPath }) =>
      writeFileSync(outputPath, "%PDF-1.7\nsynthetic-test-only\n%%EOF"),
    ...options,
  });
  const server = createApp(store, { allowedPorts: [], pdfJobs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await pdfJobs.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Xingjian-Client": "workspace-v1",
    Origin: base,
  };
  const send = (path, input, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(input),
    });
  let sequence = 0;
  const envelope = (type, payload) => ({
    type,
    payload,
    operationId: `report-http-${++sequence}`,
    expectedRevision: store.state().revision,
  });
  const command = (type, payload) =>
    send("/api/commands", envelope(type, payload));
  const loaded = await (await command("load_demo", {})).json();
  const project = loaded.state.projects[0];
  const request = {
    title: "合成研究阶段报告",
    artifactIds: [project.artifacts[0].id],
    includeTasks: true,
  };
  const preview = () =>
    send("/api/reports/preview", { projectId: project.id, request });
  const save = async () => {
    const proposal = await (await preview()).json();
    const response = await command("save_report", {
      projectId: project.id,
      request,
      previewToken: proposal.previewToken,
      acknowledgeWarnings: true,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    return saved.state.projects.find((p) => p.id === project.id).reports.at(-1);
  };
  return {
    store,
    file,
    base,
    headers,
    send,
    envelope,
    command,
    project,
    request,
    preview,
    save,
    pdfJobs,
  };
}

test("report preview is read-only and all report routes retain local/owner boundaries", async (t) => {
  const f = await fixture(t);
  const before = f.store.state();
  const response = await f.preview();
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.spec.title, f.request.title);
  assert.deepEqual(f.store.state(), before);
  const bob = f.store.command("bob", f.envelope("load_demo", {}));
  const foreign = bob.state.projects.find((p) => p.ownerId === "bob");
  const forbidden = {
    projectId: foreign.id,
    reportId: "report-missing",
    ownerId: "bob",
    request: { ...f.request, artifactIds: [foreign.artifacts[0].id] },
    format: "html",
  };
  for (const route of ["preview", "download", "pdf", "pdf-status"]) {
    assert.equal(
      (await f.send("/api/reports/" + route, forbidden)).status,
      404,
    );
    for (const extra of [
      { Origin: "https://untrusted.example" },
      { "X-Xingjian-Client": "" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      assert.equal(
        (await f.send("/api/reports/" + route, {}, extra)).status,
        403,
      );
    }
    const hostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(
        f.base + "/api/reports/" + route,
        {
          method: "POST",
          headers: { ...f.headers, Host: "rebind.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    assert.equal(hostStatus, 403);
  }
  assert.equal((await f.send("/api/reports/preview", null)).status, 400);
  assert.equal(
    (
      await f.send("/api/reports/preview", {
        projectId: f.project.id,
        request: { ...f.request, artifactIds: [foreign.artifacts[0].id] },
      })
    ).status,
    404,
  );
});

test("report confirmation rejects stale previews/forgery and retries one saved snapshot across restart", async (t) => {
  const f = await fixture(t);
  const preview = await (await f.preview()).json();
  await f.command("update_source", {
    projectId: f.project.id,
    sourceId: f.project.sources[0].id,
    baseVersionId: f.project.sources[0].currentVersionId,
    content: "新版本合成资料",
  });
  const stale = await f.command("save_report", {
    projectId: f.project.id,
    request: f.request,
    previewToken: preview.previewToken,
    acknowledgeWarnings: true,
  });
  assert.equal(stale.status, 409);
  const fresh = await (await f.preview()).json();
  const unacknowledged = await f.command("save_report", {
    projectId: f.project.id,
    request: f.request,
    previewToken: fresh.previewToken,
    acknowledgeWarnings: false,
  });
  assert.equal(unacknowledged.status, 400);
  const command = f.envelope("save_report", {
    projectId: f.project.id,
    request: f.request,
    previewToken: fresh.previewToken,
    acknowledgeWarnings: true,
    spec: { title: "FORGED_CONTENT" },
  });
  const one = await (await f.send("/api/commands", command)).json();
  const two = await (await f.send("/api/commands", command)).json();
  assert.equal(two.replayed, true);
  assert.equal(two.result.entityId, one.result.entityId);
  assert.equal(two.state.projects[0].reports.length, 1);
  assert.equal(two.state.projects[0].reports[0].spec.title, f.request.title);
  const reopened = new WorkspaceStore(f.file, { lock: false });
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.state().projects[0].reports,
    two.state.projects[0].reports,
  );
  const originalTask = f.project.tasks[0];
  assert.equal(two.state.projects[0].tasks[0].status, originalTask.status);
  assert.equal(two.state.projects[0].artifacts[0].status, "needs_review");
});

test("downloaded historical JSON/HTML/XML retain saved versions after source changes and escape markup", async (t) => {
  const f = await fixture(t);
  const hostile =
    '<script>alert("x")</script><img src="https://foreign.example/x"> & 中文';
  const artifact = await (
    await f.command("add_artifact", {
      projectId: f.project.id,
      title: "特殊文本草稿",
      content: hostile,
      claimIds: [f.project.claims[0].id],
    })
  ).json();
  f.request.artifactIds = [artifact.result.entityId];
  const report = await f.save();
  const download = (format) =>
    f.send("/api/reports/download", {
      projectId: f.project.id,
      reportId: report.id,
      format,
    });
  const original = await (await download("json")).text();
  await f.command("update_source", {
    projectId: f.project.id,
    sourceId: f.project.sources[0].id,
    baseVersionId: f.project.sources[0].currentVersionId,
    content: "后来新增的资料版本",
  });
  assert.equal(await (await download("json")).text(), original);
  const html = await download("html");
  assert.match(html.headers.get("content-disposition"), /^attachment;/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  const text = await html.text();
  assert.ok(text.includes("&lt;script&gt;"));
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes('<img src="https://foreign'));
  assert.match(await (await download("jats")).text(), /<article[\s>]/);
  assert.equal((await download("__proto__")).status, 400);
  assert.equal(
    (
      await f.send("/api/reports/download", {
        projectId: f.project.id,
        reportId: "../../outside",
        format: "pdf",
      })
    ).status,
    404,
  );
});

test("PDF job retries, retained bytes and status are scoped to an immutable saved report", async (t) => {
  const f = await fixture(t);
  const report = await f.save();
  const input = { projectId: f.project.id, reportId: report.id };
  assert.equal(
    (await f.send("/api/reports/download", { ...input, format: "pdf" })).status,
    409,
  );
  const first = await f.send("/api/reports/pdf", input);
  assert.equal(first.status, 202);
  assert.equal((await first.json()).status, "running");
  for (const job of f.pdfJobs.active.values()) await job.promise;
  const state = await (await f.send("/api/reports/pdf-status", input)).json();
  assert.equal(state.status, "ready");
  assert.equal(state.attempt, 1);
  assert.equal(
    (await (await f.send("/api/reports/pdf", input)).json()).attempt,
    1,
  );
  const download = await f.send("/api/reports/download", {
    ...input,
    format: "pdf",
  });
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.ok((await download.text()).startsWith("%PDF-"));
  assert.equal(f.store.state().projects[0].reports.length, 1);
});
