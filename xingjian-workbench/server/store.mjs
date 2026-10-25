import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyCommand, emptyWorkspace, validateWorkspace } from "./domain.mjs";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const error = (code, message, status) =>
  Object.assign(new Error(message), { code, status });

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** One local writer; synchronous commits cannot interleave within this process. */
export class WorkspaceStore {
  constructor(file, { lock = true } = {}) {
    this.file = file;
    this.lockFile = file + ".lock";
    this.hasLock = false;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (lock) this.acquireLock();
    try {
      if (existsSync(file)) {
        if (statSync(file).size > MAX_FILE_BYTES)
          throw new Error("本地数据文件超出基础版容量限制。");
        this.document = JSON.parse(readFileSync(file, "utf8"));
        if (
          this.document.format !== 1 ||
          !Array.isArray(this.document.operations)
        )
          throw new Error("不支持的本地存储格式。");
        validateWorkspace(this.document.workspace);
        const seen = new Set();
        for (const op of this.document.operations) {
          if (
            !op ||
            typeof op.id !== "string" ||
            typeof op.fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(op.fingerprint) ||
            typeof op.ownerId !== "string" ||
            !op.result ||
            typeof op.result.projectId !== "string" ||
            seen.has(op.id)
          )
            throw new Error("提交回执损坏。");
          seen.add(op.id);
        }
      } else {
        this.document = {
          format: 1,
          workspace: emptyWorkspace(),
          operations: [],
        };
      }
    } catch (err) {
      this.close();
      throw new Error(
        "本地数据无法读取；原文件未被覆盖。请先备份后检查。原因：" +
          err.message,
      );
    }
  }

  acquireLock() {
    // Never auto-delete a stale lock: concurrent recovery can unlink a new writer's lock.
    try {
      const fd = openSync(this.lockFile, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      this.hasLock = true;
    } catch (err) {
      if (err.code === "EEXIST")
        throw new Error(
          "此数据目录已有服务运行或上次异常退出留下锁。请先确认所有旧服务已关闭，再按 README 移除 .lock 文件；也可改用独立数据文件。",
        );
      throw err;
    }
  }

  state() {
    return structuredClone(this.document.workspace);
  }

  command(ownerId, command) {
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw error("INVALID_COMMAND", "请求格式错误。", 400);
    const { operationId, expectedRevision, type, payload } = command;
    if (
      typeof operationId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)
    )
      throw error("INVALID_OPERATION_ID", "缺少有效操作标识。", 400);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof type !== "string" ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      throw error("INVALID_COMMAND", "缺少有效版本或操作内容。", 400);
    const fingerprint = createHash("sha256")
      .update(stableJson({ ownerId, type, payload }))
      .digest("hex");
    const previous = this.document.operations.find(
      (item) => item.id === operationId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.ownerId !== ownerId)
        throw error(
          "OPERATION_CONFLICT",
          "同一操作标识不能用于不同内容。",
          409,
        );
      return {
        state: this.state(),
        result: structuredClone(previous.result),
        replayed: true,
      };
    }
    if (expectedRevision !== this.document.workspace.revision)
      throw error(
        "REVISION_CONFLICT",
        "项目已更新，请刷新后重新预览并确认。",
        409,
      );
    if (this.document.operations.length >= 10000)
      throw error(
        "WORKSPACE_LIMIT",
        "基础版已达到操作容量，请备份本地数据后建立新的工作区。",
        409,
      );
    const next = applyCommand(this.document.workspace, ownerId, type, payload);
    validateWorkspace(next.state);
    const document = {
      format: 1,
      workspace: next.state,
      operations: [
        ...this.document.operations,
        { id: operationId, fingerprint, ownerId, result: next.result },
      ],
    };
    this.persist(document);
    this.document = document;
    return {
      state: this.state(),
      result: structuredClone(next.result),
      replayed: false,
    };
  }

  persist(document) {
    const serialized = JSON.stringify(document, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES)
      throw error(
        "WORKSPACE_LIMIT",
        "本地工作区超出基础版容量限制，未保存本次更改。",
        409,
      );
    const temp = this.file + "." + randomUUID() + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      throw error(
        "PERSIST_FAILED",
        "保存失败，本次更改未生效；请检查磁盘空间和目录权限。",
        503,
      );
    }
  }

  close() {
    if (this.hasLock) {
      try {
        unlinkSync(this.lockFile);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      this.hasLock = false;
    }
  }
}
