import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportToJats } from "./report-render.mjs";

const MAX_PDF = 12 * 1024 * 1024;
const fail = (code, message, status = 409) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const idle = () => ({
  status: "idle",
  attempt: 0,
  error: null,
  createdAt: null,
  finishedAt: null,
  engine: "chromium-print-v1",
});

export function renderPdfInWorker({ xml, outputPath, browserKind, signal }) {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url)),
      [],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
        // Do not inherit provider credentials or arbitrary Node loader options.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|HOME|USERPROFILE|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|PLAYWRIGHT_BROWSERS_PATH)$/i.test(
              key,
            ),
          ),
        ),
      },
    );
    let succeeded = false;
    let killTimer;
    const abort = () => {
      if (child.connected) child.disconnect();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2500);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("message", (message) => {
      succeeded = message?.ok === true;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (code === 0 && succeeded && !signal.aborted) resolve();
      else
        reject(
          fail(
            "PDF_RENDER_FAILED",
            "PDF 生成失败。请确认电脑已有 Chrome，关闭占用后重试；也可先下载 HTML。",
          ),
        );
    });
    if (signal.aborted) abort();
    else child.send({ xml, outputPath, browserKind });
  });
}

/** One worker at a time. Manifests and completed PDFs survive application restart. */
export class PdfJobs {
  constructor(
    root,
    {
      render = renderPdfInWorker,
      timeoutMs = 60000,
      browserKind = process.env.XINGJIAN_PDF_BROWSER ?? "chrome",
    } = {},
  ) {
    this.root = root;
    this.render = render;
    this.timeoutMs = timeoutMs;
    this.browserKind = browserKind;
    this.active = new Map();
    this.closed = false;
  }
  paths(ownerId, projectId, report) {
    const directory = join(
      this.root,
      hash(JSON.stringify([ownerId, projectId, report.id])),
    );
    return {
      directory,
      manifest: join(directory, "job.json"),
      pdf: join(directory, "report.pdf"),
    };
  }
  write(paths, manifest) {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const temp = paths.manifest + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(manifest) + "\n", { mode: 0o600 });
      renameSync(temp, paths.manifest);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  read(paths, report) {
    if (!existsSync(paths.manifest)) return null;
    try {
      if (statSync(paths.manifest).size > 4096) throw new Error();
      const data = JSON.parse(readFileSync(paths.manifest, "utf8"));
      if (
        data.contentHash !== report.contentHash ||
        !["running", "ready", "failed"].includes(data.status) ||
        !Number.isSafeInteger(data.attempt) ||
        data.attempt < 1 ||
        typeof data.createdAt !== "string" ||
        !Number.isFinite(Date.parse(data.createdAt))
      )
        throw new Error();
      return data;
    } catch {
      throw fail(
        "PDF_CACHE_INVALID",
        "PDF 记录无法读取；报告内容仍保留。请先备份并移走本报告的导出缓存，再重新生成。",
        409,
      );
    }
  }
  public(data) {
    return data
      ? {
          status: data.status,
          attempt: data.attempt,
          error: data.error,
          createdAt: data.createdAt,
          finishedAt: data.finishedAt,
          engine: "chromium-print-v1",
        }
      : idle();
  }
  validPdf(paths, data) {
    if (!existsSync(paths.pdf)) return false;
    const size = statSync(paths.pdf).size;
    if (size < 8 || size > MAX_PDF || size !== data.bytes) return false;
    const bytes = readFileSync(paths.pdf);
    return (
      bytes.subarray(0, 5).toString() === "%PDF-" &&
      hash(bytes) === data.pdfHash
    );
  }
  status(ownerId, projectId, report) {
    const paths = this.paths(ownerId, projectId, report);
    const data = this.read(paths, report);
    if (!data) return idle();
    let reason;
    if (data.status === "running" && !this.active.has(paths.directory))
      reason = "上次生成因服务退出而中断，点击重新生成即可；报告版本仍保留。";
    if (data.status === "ready" && !this.validPdf(paths, data))
      reason = "已生成 PDF 缺失或校验失败，请重新生成；报告版本仍保留。";
    if (reason) {
      Object.assign(data, {
        status: "failed",
        error: reason,
        finishedAt: new Date().toISOString(),
      });
      this.write(paths, data);
    }
    return this.public(data);
  }
  start(ownerId, projectId, report) {
    if (this.closed)
      throw fail("PDF_UNAVAILABLE", "服务正在关闭，请重启后重试。");
    const current = this.status(ownerId, projectId, report);
    if (["running", "ready"].includes(current.status)) return current;
    if (!["chrome", "chromium"].includes(this.browserKind))
      throw fail(
        "PDF_BROWSER_CONFIG",
        "PDF 浏览器配置应为 chrome 或 chromium；可先下载 HTML。",
        503,
      );
    if (this.active.size)
      throw fail("PDF_BUSY", "另一份 PDF 正在生成，请稍后重试。");
    const xml = reportToJats(report);
    const paths = this.paths(ownerId, projectId, report);
    const data = {
      ...idle(),
      status: "running",
      attempt: current.attempt + 1,
      createdAt: new Date().toISOString(),
      contentHash: report.contentHash,
    };
    this.write(paths, data);
    const outputPath = join(paths.directory, randomUUID() + ".pdf.tmp");
    const controller = new AbortController();
    const job = { controller, promise: null };
    this.active.set(paths.directory, job);
    job.promise = this.run(paths, data, xml, outputPath, controller);
    return this.public(data);
  }
  async run(paths, data, xml, outputPath, controller) {
    let timeout;
    try {
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      // The renderer's promise includes process teardown. Keep the concurrency
      // slot and temporary path until it settles, including after cancellation.
      await this.render({
        xml,
        outputPath,
        browserKind: this.browserKind,
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.closed)
        throw fail(
          "PDF_INTERRUPTED",
          "生成中断或超时，请重新生成；报告版本仍保留。",
        );
      const stat = statSync(outputPath);
      if (stat.size < 8 || stat.size > MAX_PDF)
        throw new Error("Invalid PDF size");
      const bytes = readFileSync(outputPath);
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        throw new Error("Invalid PDF");
      renameSync(outputPath, paths.pdf);
      Object.assign(data, {
        status: "ready",
        error: null,
        finishedAt: new Date().toISOString(),
        bytes: bytes.length,
        pdfHash: hash(bytes),
      });
      this.write(paths, data);
    } catch (error) {
      Object.assign(data, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: controller.signal.aborted
          ? "生成中断或超时，请重新生成；报告版本仍保留。"
          : error.code === "PDF_INTERRUPTED"
            ? error.message
            : "PDF 生成失败。请确认电脑已有 Chrome 后重试；也可先下载 HTML。",
      });
      try {
        this.write(paths, data);
      } catch {
        /* Keep the prior manifest; restart recovery marks it failed. */
      }
    } finally {
      clearTimeout(timeout);
      rmSync(outputPath, { force: true });
      this.active.delete(paths.directory);
    }
  }
  download(ownerId, projectId, report) {
    const state = this.status(ownerId, projectId, report);
    if (state.status !== "ready")
      throw fail("PDF_NOT_READY", "PDF 尚未生成完成，请先生成或重试。");
    return readFileSync(this.paths(ownerId, projectId, report).pdf);
  }
  async close() {
    this.closed = true;
    const jobs = [...this.active.values()];
    for (const { controller } of jobs) controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
  }
}
