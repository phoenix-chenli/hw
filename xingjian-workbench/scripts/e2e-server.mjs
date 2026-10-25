import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
const dir = mkdtempSync(join(tmpdir(), "xingjian-browser-"));
const store = new WorkspaceStore(join(dir, "workspace.json"));
const server = createApp(store, {
  staticDir: resolve("dist"),
  allowedPorts: [8798],
});
function cleanup() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
server.once("error", (err) => {
  console.error(err.message);
  cleanup();
  process.exitCode = 1;
});
server.listen(8798, "127.0.0.1");
function shutdown() {
  server.close(() => cleanup());
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", cleanup);
