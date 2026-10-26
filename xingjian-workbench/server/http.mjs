import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import {
  previewSourceUpdate,
  previewTableCatalog,
  previewReview,
  previewPlan,
  previewReport,
  savedReport,
} from "./domain.mjs";
import { reportToJats, reportToHtml } from "./report-render.mjs";
import { PdfJobs } from "./pdf-jobs.mjs";
import { AgentRuns } from "./agent-runs.mjs";

const LOCAL_OWNER = "local-user";
const MAX_BODY = 256 * 1024;
const fail = (code, message, status) =>
  Object.assign(new Error(message), { code, status });
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw fail("CONTENT_TYPE", "请求需要使用 JSON。", 415);
  if (Number(request.headers["content-length"]) > MAX_BODY) {
    request.resume();
    throw fail("BODY_TOO_LARGE", "单次内容过大，请缩短资料后重试。", 413);
  }
  return new Promise((resolve, reject) => {
    let chunks = [],
      length = 0,
      rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      length += chunk.length;
      if (length > MAX_BODY) {
        rejected = true;
        chunks = [];
        reject(fail("BODY_TOO_LARGE", "单次内容过大，请缩短资料后重试。", 413));
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(fail("INVALID_JSON", "请求内容不是有效的 JSON。", 400));
      }
    });
    request.on("aborted", () =>
      reject(fail("REQUEST_ABORTED", "请求已中断。", 400)),
    );
    request.on("error", () =>
      reject(fail("REQUEST_ABORTED", "请求传输失败。", 400)),
    );
  });
}

export function createApp(
  store,
  { staticDir, allowedPorts = [8787, 5173, 4173], pdfJobs, agentProvider } = {},
) {
  const exports = pdfJobs ?? new PdfJobs(store.file + ".exports");
  const agentRuns = new AgentRuns(store, { provider: agentProvider });
  const allowedAuthorities = new Set(
    allowedPorts.flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]),
  );
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const authorities = new Set(allowedAuthorities);
      const port = server.address()?.port;
      if (port) {
        authorities.add(`127.0.0.1:${port}`);
        authorities.add(`localhost:${port}`);
      }
      if (!authorities.has(request.headers.host))
        throw fail("HOST_REJECTED", "此基础版仅允许本机访问。", 403);
      const origin = request.headers.origin;
      if (origin) {
        let url;
        try {
          url = new URL(origin);
        } catch {
          throw fail("ORIGIN_REJECTED", "请求来源不允许。", 403);
        }
        if (
          url.protocol !== "http:" ||
          !authorities.has(url.host) ||
          url.origin !== origin
        )
          throw fail("ORIGIN_REJECTED", "请求来源不允许。", 403);
      }
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw fail("ORIGIN_REJECTED", "请求来源不允许。", 403);
      const url = new URL(request.url, "http://" + request.headers.host);
      if (url.pathname.startsWith("/api/")) {
        if (request.headers["x-xingjian-client"] !== "workspace-v1")
          throw fail("CLIENT_REQUIRED", "请从行简本地工作台访问接口。", 403);
        if (request.method === "GET" && url.pathname === "/api/state")
          return json(response, 200, store.state());
        if (request.method === "GET" && url.pathname === "/api/capabilities")
          return json(response, 200, {
            mode: "local-single-user",
            stage: 5,
            evidenceInspection: "recorded-text-positions",
            sourceComparison: "bounded-line-diff",
            agentArts: agentRuns.configuration().configured ? "configured-unverified" : "not-connected",
            agentRunProtocol: "versioned-snapshot-proposal-v1",
            reportExport: "fixed-template-local",
            pdfEngine: "existing-browser-worker",
            sourceAnalysis: "local-keyword-and-csv",
            analysisProvider: "local-tools-v1",
            sourceReview: "individual-versioned-review",
            taskContinuation: "versioned-checkpoints",
            taskPlanning: "local-window-preview",
            planningTimezone: "Asia/Shanghai",
            storage: "local-file",
            account: "local-development-only",
          });
        if (request.method === "GET" && url.pathname === "/api/agent-runs/config")
          return json(response, 200, agentRuns.configuration());
        if (request.method === "POST" && url.pathname === "/api/agent-runs") {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.authorizeCloud !== "boolean")
            throw fail("INVALID_AGENT_REQUEST", "请提供有效请求并明确本次资料发送授权。", 400);
          return json(response, 200, agentRuns.start(LOCAL_OWNER, input));
        }
        if (request.method === "POST" && url.pathname === "/api/agent-runs/interrupt") {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_AGENT_REQUEST", "运行请求无效。", 400);
          return json(response, 200, agentRuns.interrupt(LOCAL_OWNER, input.projectId, input.runId));
        }
        if (
          request.method === "POST" &&
          url.pathname.startsWith("/api/reports/")
        ) {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_REPORT", "报告参数错误。", 400);
          if (url.pathname === "/api/reports/preview")
            return json(
              response,
              200,
              previewReport(
                store.state(),
                LOCAL_OWNER,
                input.projectId,
                input.request,
              ),
            );
          const report = savedReport(
            store.state(),
            LOCAL_OWNER,
            input.projectId,
            input.reportId,
          );
          if (url.pathname === "/api/reports/pdf")
            return json(
              response,
              202,
              exports.start(LOCAL_OWNER, input.projectId, report),
            );
          if (url.pathname === "/api/reports/pdf-status")
            return json(
              response,
              200,
              exports.status(LOCAL_OWNER, input.projectId, report),
            );
          if (url.pathname === "/api/reports/download") {
            const formats = {
              html: [
                "text/html; charset=utf-8",
                "html",
                () => reportToHtml(report),
              ],
              jats: [
                "application/xml; charset=utf-8",
                "xml",
                () => reportToJats(report),
              ],
              json: [
                "application/json; charset=utf-8",
                "json",
                () => JSON.stringify(report, null, 2) + "\n",
              ],
              pdf: [
                "application/pdf",
                "pdf",
                () => exports.download(LOCAL_OWNER, input.projectId, report),
              ],
            };
            if (
              typeof input.format !== "string" ||
              !Object.hasOwn(formats, input.format)
            )
              throw fail(
                "INVALID_FORMAT",
                "请选择 HTML、PDF、JSON 或 JATS 格式。",
                400,
              );
            const [contentType, extension, generate] = formats[input.format];
            const bytes = generate();
            const filename = `行简_报告${report.number}_${report.spec.title}.${extension}`;
            response.writeHead(200, {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="xingjian-report-${report.number}.${extension}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
              "Cache-Control": "no-store",
            });
            return response.end(bytes);
          }
          throw fail("NOT_FOUND", "报告接口不存在。", 404);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/analysis/catalog"
        ) {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_ANALYSIS", "表格参数错误。", 400);
          return json(
            response,
            200,
            previewTableCatalog(
              store.state(),
              LOCAL_OWNER,
              input.projectId,
              input.sourceId,
            ),
          );
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/review/preview"
        ) {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_PREVIEW", "复核预览参数错误。", 400);
          return json(
            response,
            200,
            previewReview(
              store.state(),
              LOCAL_OWNER,
              input.projectId,
              input.kind,
              input.entityId,
            ),
          );
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/plans/preview"
        ) {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_PREVIEW", "计划预览参数错误。", 400);
          return json(
            response,
            200,
            previewPlan(
              store.state(),
              LOCAL_OWNER,
              input.projectId,
              input.request,
            ),
          );
        }
        if (request.method === "POST" && url.pathname === "/api/preview") {
          const input = await body(request);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw fail("INVALID_PREVIEW", "预览参数错误。", 400);
          const preview = previewSourceUpdate(
            store.state(),
            LOCAL_OWNER,
            input.projectId,
            input.sourceId,
            input.content,
          );
          return json(response, 200, preview);
        }
        if (request.method === "POST" && url.pathname === "/api/commands") {
          const command = await body(request);
          if (command?.type === "create_agent_run")
            throw fail("INTERNAL_COMMAND", "运行请求请使用分析入口，不能自行注入运行状态。", 400);
          return json(
            response,
            200,
            store.command(LOCAL_OWNER, command),
          );
        }
        throw fail("NOT_FOUND", "接口不存在。", 404);
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw fail("METHOD_NOT_ALLOWED", "请求方法不支持。", 405);
      if (!staticDir || !existsSync(resolve(staticDir, "index.html"))) {
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return response.end(
          "行简接口已启动。开发时访问 http://127.0.0.1:5173；或先 npm run build 再 npm start。",
        );
      }
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw fail("INVALID_PATH", "无效路径。", 400);
      }
      const root = resolve(staticDir);
      let file = resolve(root, "." + pathname);
      if (file !== root && !file.startsWith(root + sep))
        throw fail("NOT_FOUND", "文件不存在。", 404);
      if (pathname === "/") file = resolve(root, "index.html");
      if (!existsSync(file) || !statSync(file).isFile())
        throw fail("NOT_FOUND", "文件不存在。", 404);
      response.writeHead(200, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "Cache-Control":
          extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
      });
      response.end(request.method === "HEAD" ? undefined : readFileSync(file));
    } catch (err) {
      const status =
        Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
          ? err.status
          : 500;
      if (status === 500) console.error("Request failed:", err.name);
      if (!response.headersSent)
        json(response, status, {
          error: {
            code: err.code ?? "INTERNAL_ERROR",
            message:
              status === 500
                ? "处理失败，未确认的操作不会自动执行。请重试。"
                : err.message,
          },
        });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.reportJobs = exports;
  server.agentRuns = agentRuns;
  server.once("close", () => {
    void agentRuns.close().catch(() => { /* Persisted active runs recover on restart. */ });
    void exports.close();
  });
  return server;
}
