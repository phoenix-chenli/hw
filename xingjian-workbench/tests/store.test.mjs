import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../server/store.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-含空格 store-"));
  const file = join(dir, "workspace.json");
  const store = new WorkspaceStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, store };
}
const project = (revision = 0, operationId = "operation-0001") => ({
  operationId,
  expectedRevision: revision,
  type: "create_project",
  payload: {
    title: "校园节能研究",
    goal: "核对数据与变化",
    deadline: "2026-11-15",
  },
});

test("durable state and idempotency survive restart", (t) => {
  const { store, file } = fixture(t);
  const first = store.command("local-user", project());
  assert.equal(first.state.projects.length, 1);
  store.close();
  const reopened = new WorkspaceStore(file);
  t.after(() => reopened.close());
  const replay = reopened.command("local-user", project());
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.state.projects.length, 1);
  assert.equal(replay.state.revision, first.state.revision);
});

test("same id with altered content or owner is rejected", (t) => {
  const { store } = fixture(t);
  store.command("local-user", project());
  const changed = project();
  changed.payload.title = "不同的项目";
  assert.throws(() => store.command("local-user", changed), {
    code: "OPERATION_CONFLICT",
    status: 409,
  });
  assert.throws(() => store.command("another-user", project()), {
    code: "OPERATION_CONFLICT",
    status: 409,
  });
  assert.equal(store.state().projects.length, 1);
});

test("stale revision cannot overwrite state; caller mutation cannot alter store", (t) => {
  const { store } = fixture(t);
  const saved = store.command("local-user", project());
  saved.state.projects[0].title = "外部篡改";
  assert.equal(store.state().projects[0].title, "校园节能研究");
  assert.throws(
    () => store.command("local-user", project(0, "operation-0002")),
    { code: "REVISION_CONFLICT", status: 409 },
  );
  assert.equal(store.state().projects.length, 1);
});

test("disk failure does not commit in memory or record the operation", (t) => {
  const { store, dir } = fixture(t);
  const blocker = join(dir, "directory-not-a-file");
  mkdirSync(blocker);
  store.file = blocker;
  assert.throws(() => store.command("local-user", project()), {
    code: "PERSIST_FAILED",
    status: 503,
  });
  assert.equal(store.state().projects.length, 0);
  store.file = join(dir, "recovered.json");
  assert.equal(store.command("local-user", project()).replayed, false);
});

test("corrupt saved data stays unchanged instead of resetting user work", (t) => {
  const { store, file } = fixture(t);
  store.close();
  const corrupt =
    '{"format":1,"workspace":{"schemaVersion":99},"operations":[]}';
  writeFileSync(file, corrupt);
  assert.throws(() => new WorkspaceStore(file), /原文件未被覆盖/);
  assert.equal(readFileSync(file, "utf8"), corrupt);
});

test("a second process writer is blocked and closing releases the lock", (t) => {
  const { store, file } = fixture(t);
  assert.throws(() => new WorkspaceStore(file), /已有服务运行/);
  store.close();
  const next = new WorkspaceStore(file);
  next.close();
});

test("stale lock is retained rather than automatically racing another recovering writer", (t) => {
  const { store, file } = fixture(t);
  store.close();
  writeFileSync(file + ".lock", "2147483647");
  assert.throws(() => new WorkspaceStore(file), /上次异常退出留下锁/);
  assert.equal(readFileSync(file + ".lock", "utf8"), "2147483647");
});

test("replay fingerprint does not depend on object key ordering", (t) => {
  const { store } = fixture(t);
  store.command("local-user", project());
  const same = project();
  same.payload = {
    deadline: "2026-11-15",
    goal: "核对数据与变化",
    title: "校园节能研究",
  };
  assert.equal(store.command("local-user", same).replayed, true);
});

test("invalid JSON command values fail without writing state", (t) => {
  const { store } = fixture(t);
  for (const bad of [
    null,
    [],
    {},
    { ...project(), expectedRevision: -1 },
    { ...project(), payload: [] },
  ]) {
    assert.throws(() => store.command("local-user", bad));
  }
  assert.equal(store.state().revision, 0);
});
