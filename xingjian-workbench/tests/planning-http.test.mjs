import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { WorkspaceStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-planning-http-"));
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
  let sequence = 0;
  const envelope = (type, payload) => ({
    type,
    payload,
    expectedRevision: store.state().revision,
    operationId: `planning-http-${++sequence}`,
  });
  const command = (type, payload) =>
    send("/api/commands", envelope(type, payload));
  const loaded = await (await command("load_demo", {})).json();
  const projectId = loaded.result.projectId;
  const taskId = loaded.state.projects[0].tasks[1].id;
  const request = {
    date: "2026-10-25",
    startTime: "09:00",
    endTime: "12:00",
    items: [{ taskId, durationMinutes: 30 }],
    allowDuringClass: false,
  };
  return {
    store,
    base,
    headers,
    send,
    envelope,
    command,
    projectId,
    taskId,
    request,
  };
}

test("planning HTTP preview preserves local access boundaries and server-owned project identity", async (t) => {
  const f = await fixture(t);
  const capability = await (
    await fetch(f.base + "/api/capabilities", { headers: f.headers })
  ).json();
  assert.equal(capability.agentArts, "not-connected");
  assert.equal(capability.taskContinuation, "versioned-checkpoints");
  assert.equal(capability.taskPlanning, "local-window-preview");
  assert.equal(capability.planningTimezone, "Asia/Shanghai");
  const input = { projectId: f.projectId, request: f.request };
  const before = f.store.state();
  const valid = await f.send("/api/plans/preview", input);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).blocks[0].startTime, "09:00");
  assert.deepEqual(f.store.state(), before);
  for (const headers of [
    { Origin: "https://foreign.example" },
    { Origin: "null" },
    { "X-Xingjian-Client": "" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal(
      (await f.send("/api/plans/preview", input, headers)).status,
      403,
    );
  }
  const hostCode = await new Promise((resolve, reject) => {
    const req = httpRequest(
      f.base + "/api/plans/preview",
      { method: "POST", headers: { ...f.headers, Host: "rebind.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
  assert.equal(hostCode, 403);
  assert.equal((await f.send("/api/plans/preview", [])).status, 400);
  assert.equal(
    (await f.send("/api/plans/preview", { ...input, projectId: "missing" }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.send("/api/plans/preview", {
        ...input,
        request: { ...f.request, date: "2026-02-29" },
      })
    ).status,
    400,
  );
  const bob = f.store.command("bob", f.envelope("load_demo", {}));
  const foreign = bob.state.projects.find((p) => p.ownerId === "bob");
  const spoofed = await f.send("/api/plans/preview", {
    projectId: foreign.id,
    ownerId: "bob",
    request: {
      ...f.request,
      items: [{ taskId: foreign.tasks[1].id, durationMinutes: 30 }],
    },
  });
  assert.equal(spoofed.status, 404);
  const beforeForbidden = f.store.state();
  const denied = await f.command("save_checkpoint", {
    projectId: foreign.id,
    taskId: foreign.tasks[1].id,
    ownerId: "bob",
    baseCheckpointNumber: 0,
    doneNote: "",
    nextStep: "越权续写",
    blocker: "",
    evidence: null,
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(f.store.state(), beforeForbidden);
});

test("planning HTTP confirmation checks a fresh snapshot and class acknowledgement, then supports retry and cancellation", async (t) => {
  const f = await fixture(t);
  const preview = async (request = f.request) => {
    const response = await f.send("/api/plans/preview", {
      projectId: f.projectId,
      request,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const old = await preview();
  assert.equal(
    (
      await f.command("save_checkpoint", {
        projectId: f.projectId,
        taskId: f.taskId,
        baseCheckpointNumber: 0,
        doneNote: "已查看样本",
        nextStep: "补充采样条件",
        blocker: "",
        evidence: null,
      })
    ).status,
    200,
  );
  const beforeStale = f.store.state();
  const stale = await f.command("confirm_plan", {
    projectId: f.projectId,
    request: f.request,
    previewToken: old.previewToken,
    acknowledgeClassOverlap: false,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "PLAN_STALE");
  assert.deepEqual(f.store.state(), beforeStale);
  const slot = await f.command("add_busy_slot", {
    projectId: f.projectId,
    title: "合成课程安排",
    kind: "class",
    date: f.request.date,
    startTime: "09:00",
    endTime: "10:00",
  });
  assert.equal(slot.status, 200);
  const classRequest = { ...f.request, allowDuringClass: true };
  const current = await preview(classRequest);
  assert.equal(current.blocks[0].classConflicts.length, 1);
  const missingAck = await f.command("confirm_plan", {
    projectId: f.projectId,
    request: classRequest,
    previewToken: current.previewToken,
    acknowledgeClassOverlap: false,
  });
  assert.equal(missingAck.status, 400);
  assert.equal(
    (await missingAck.json()).error.code,
    "CLASS_OVERLAP_ACK_REQUIRED",
  );
  const tasksBefore = structuredClone(f.store.state().projects[0].tasks);
  const command = f.envelope("confirm_plan", {
    projectId: f.projectId,
    request: classRequest,
    previewToken: current.previewToken,
    acknowledgeClassOverlap: true,
    blocks: [{ startTime: "00:00", endTime: "23:00" }],
  });
  const acceptedResponse = await f.send("/api/commands", command);
  assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json();
  assert.equal(
    accepted.state.projects[0].plans[0].blocks[0].startTime,
    "09:00",
  );
  assert.deepEqual(accepted.state.projects[0].tasks, tasksBefore);
  const repeated = await f.send("/api/commands", command);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).replayed, true);
  assert.equal(f.store.state().projects[0].plans.length, 1);
  assert.equal((await preview(classRequest)).blocks[0].startTime, "09:30");
  const cancelled = await f.command("cancel_plan", {
    projectId: f.projectId,
    planId: accepted.result.entityId,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(f.store.state().projects[0].plans[0].status, "cancelled");
  assert.equal((await preview(classRequest)).blocks[0].startTime, "09:00");
  assert.deepEqual(f.store.state().projects[0].tasks, tasksBefore);
});
