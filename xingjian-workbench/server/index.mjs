import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceStore } from "./store.mjs";
import { createApp } from "./http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.XINGJIAN_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("XINGJIAN_PORT 必须是 1024–65535 的整数。");
const store = new WorkspaceStore(
  process.env.XINGJIAN_DATA_FILE
    ? resolve(process.env.XINGJIAN_DATA_FILE)
    : resolve(root, ".runtime/workspace.json"),
);
const server = createApp(store, {
  staticDir: resolve(root, "dist"),
  allowedPorts: [port, 5173, 4173],
});
server.once("error", (err) => {
  console.error(
    err.code === "EADDRINUSE"
      ? "端口已占用，请关闭旧服务或设置 XINGJIAN_PORT。"
      : err.message,
  );
  store.close();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(`行简本地工作台：http://127.0.0.1:${port}（云端状态请查看资料分析页；配置齐备不代表已验证）`),
);
function shutdown() {
  server.close(() => {
    void Promise.allSettled([server.reportJobs.close(), server.agentRuns.close()]).then(() => store.close());
  });
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => store.close());
