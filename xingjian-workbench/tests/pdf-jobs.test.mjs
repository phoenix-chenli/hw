import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfJobs } from "../server/pdf-jobs.mjs";
import {
  applyCommand,
  emptyWorkspace,
  previewReport,
} from "../server/domain.mjs";

function saved() {
  let state = applyCommand(emptyWorkspace(), "owner", "load_demo", {}).state;
  const project = state.projects[0];
  const request = {
    title: "合成 PDF 测试",
    artifactIds: [project.artifacts[0].id],
    includeTasks: true,
  };
  const preview = previewReport(state, "owner", project.id, request);
  state = applyCommand(state, "owner", "save_report", {
    projectId: project.id,
    request,
    previewToken: preview.previewToken,
    acknowledgeWarnings: true,
  }).state;
  return state.projects[0].reports[0];
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xingjian-pdf-jobs-"));
  const jobs = new PdfJobs(directory, options);
  t.after(async () => {
    await jobs.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return jobs;
}
const fakePdf = ({ outputPath }) => {
  writeFileSync(outputPath, "%PDF-1.7\nsynthetic-worker-test\n%%EOF");
};
async function finish(jobs) {
  await Promise.all([...jobs.active.values()].map((job) => job.promise));
}

test("PDF workers deduplicate running/ready jobs, retain checked bytes and survive restart", async (t) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  const jobs = fixture(t, {
    render: async (input) => {
      count++;
      await waiting;
      fakePdf(input);
    },
  });
  const report = saved();
  assert.equal(jobs.status("owner", "project", report).status, "idle");
  assert.equal(jobs.start("owner", "project", report).attempt, 1);
  assert.equal(jobs.start("owner", "project", report).attempt, 1);
  assert.throws(
    () => jobs.start("owner", "other", { ...report, id: "different" }),
    (err) => err.code === "PDF_BUSY",
  );
  release();
  await finish(jobs);
  assert.equal(count, 1);
  const original = jobs.download("owner", "project", report);
  const reopened = new PdfJobs(jobs.root);
  t.after(() => reopened.close());
  assert.equal(reopened.status("owner", "project", report).status, "ready");
  assert.deepEqual(reopened.download("owner", "project", report), original);
  assert.equal(
    reopened.status("other-owner", "project", report).status,
    "idle",
  );
  assert.equal(jobs.start("owner", "project", report).attempt, 1);
});

test("renderer failure preserves the report and offers an explicit retry", async (t) => {
  let calls = 0;
  const jobs = fixture(t, {
    render: async (input) => {
      if (++calls === 1) throw new Error("private internal path");
      fakePdf(input);
    },
  });
  const report = saved(),
    snapshot = structuredClone(report);
  jobs.start("owner", "project", report);
  await finish(jobs);
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  assert.ok(
    !jobs.status("owner", "project", report).error.includes("private internal"),
  );
  assert.equal(jobs.start("owner", "project", report).attempt, 2);
  await finish(jobs);
  assert.equal(jobs.status("owner", "project", report).status, "ready");
  assert.deepEqual(report, snapshot);
});

test("timeout/close abort a worker, free the slot and retain actionable failure", async (t) => {
  let signal;
  const jobs = fixture(t, {
    timeoutMs: 10,
    render: async (input) => {
      signal = input.signal;
      await new Promise((resolve) =>
        input.signal.addEventListener("abort", resolve, { once: true }),
      );
    },
  });
  const report = saved();
  jobs.start("owner", "project", report);
  await finish(jobs);
  assert.equal(signal.aborted, true);
  assert.equal(jobs.active.size, 0);
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  jobs.start("owner", "project", report);
  await jobs.close();
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  assert.throws(
    () => jobs.start("owner", "project", report),
    (err) => err.code === "PDF_UNAVAILABLE",
  );
});

test("a timed-out renderer finishes cleanup before retry or close releases its concurrency slot", async (t) => {
  let running = 0,
    peak = 0,
    stopped = 0;
  const jobs = fixture(t, {
    timeoutMs: 10,
    render: async ({ signal, outputPath }) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      // A late write is cleaned only after this renderer has actually stopped.
      fakePdf({ outputPath });
      running--;
      stopped++;
    },
  });
  const report = saved();
  jobs.start("owner", "project", report);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobs.status("owner", "project", report).status, "running");
  assert.equal(jobs.start("owner", "project", report).attempt, 1);
  assert.throws(
    () => jobs.start("owner", "other", report),
    (err) => err.code === "PDF_BUSY",
  );
  await finish(jobs);
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  jobs.start("owner", "project", report);
  await jobs.close();
  assert.equal(peak, 1);
  assert.equal(running, 0);
  assert.equal(stopped, 2);
});

test("interrupted manifests and altered PDF bytes become retryable failures", async (t) => {
  const report = saved();
  const jobs = fixture(t, { render: fakePdf });
  jobs.start("owner", "project", report);
  await finish(jobs);
  const paths = jobs.paths("owner", "project", report);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  writeFileSync(paths.pdf, "%PDF-1.7\nchanged\n%%EOF");
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  jobs.start("owner", "project", report);
  await finish(jobs);
  assert.equal(jobs.status("owner", "project", report).attempt, 2);
  writeFileSync(
    paths.manifest,
    JSON.stringify({ ...manifest, status: "running" }),
  );
  const reopened = new PdfJobs(jobs.root);
  t.after(() => reopened.close());
  assert.equal(reopened.status("owner", "project", report).status, "failed");
  assert.match(reopened.status("owner", "project", report).error, /中断/);
});

test("invalid output or cache metadata never becomes a downloadable PDF", async (t) => {
  const report = saved();
  const jobs = fixture(t, {
    render: ({ outputPath }) => writeFileSync(outputPath, "not-a-pdf"),
  });
  jobs.start("owner", "project", report);
  await finish(jobs);
  assert.equal(jobs.status("owner", "project", report).status, "failed");
  assert.throws(
    () => jobs.download("owner", "project", report),
    (err) => err.code === "PDF_NOT_READY",
  );
  const paths = jobs.paths("owner", "project", report);
  writeFileSync(paths.manifest, "{broken");
  assert.throws(
    () => jobs.status("owner", "project", report),
    (err) => err.code === "PDF_CACHE_INVALID",
  );
  assert.ok(
    !jobs
      .paths("../outside", "../../out", report)
      .directory.includes("outside"),
  );
});
