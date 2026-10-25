import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommand,
  emptyWorkspace,
  validateWorkspace,
  previewTableCatalog,
} from "../server/domain.mjs";
import { analyze, parseCsv, normalizeRequest } from "../server/analysis.mjs";
import { WorkspaceStore } from "../server/store.mjs";

function fixture(content = "名称,用电量(kWh)\nA,0.1\nB,0.2") {
  let sequence = 0;
  const options = {
    id: (kind) => `${kind}_${++sequence}`,
    now: "2026-10-24T01:00:00.000Z",
  };
  let state = emptyWorkspace();
  const command = (type, payload, owner = "alice") => {
    const response = applyCommand(state, owner, type, payload, options);
    state = response.state;
    return response;
  };
  command("create_project", {
    title: "合成测试",
    goal: "验证来源与计算",
    deadline: null,
  });
  const projectId = state.projects[0].id;
  command("add_source", {
    projectId,
    title: "合成表格",
    kind: "table",
    content,
  });
  const sourceId = state.projects[0].sources[0].id;
  const request = {
    mode: "calculate",
    sourceIds: [sourceId],
    column: "用电量(kWh)",
    operation: "sum",
  };
  return {
    command,
    projectId,
    sourceId,
    request,
    state: () => state,
    project: () => state.projects[0],
    run: (input = request) =>
      command("run_analysis", { projectId, request: input }),
    accept: (analysisId, claimIds = ["claim-1"], taskIds = ["task-review"]) =>
      command("accept_analysis", { projectId, analysisId, claimIds, taskIds }),
  };
}

test("CSV parser preserves physical line references, quoted commas, CRLF and multiline cells", () => {
  const table = parseCsv('\uFEFF名称,金额\r\n"A,一",1.20\r\n"B\n二",-2\r\n');
  assert.deepEqual(table.columns, ["名称", "金额"]);
  assert.deepEqual(table.rows, [
    { cells: ["A,一", "1.20"], startLine: 2, endLine: 2 },
    { cells: ["B\n二", "-2"], startLine: 3, endLine: 4 },
  ]);
  assert.equal(parseCsv('值\n"1"\n\n"2"').rows.length, 2);
});

test("malformed CSV and ambiguous tables fail instead of skipping rows", () => {
  for (const value of [
    "说明\na,b\n1,2",
    "a,a\n1,2",
    "a,\n1,2",
    'a,b\n"x,2',
    'a,b\n"x"z,2',
    'a,b\nx"z,2',
    "a,b\n1",
    "a,b",
    "a,b\n1,2,3",
  ])
    assert.throws(() => parseCsv(value), { code: "INVALID_CSV" });
  assert.throws(() => parseCsv("n\n" + Array(5001).fill("1").join("\n")), {
    code: "TABLE_LIMIT",
  });
});

test("fixed decimal operations are exact; averages explicitly round to six places", () => {
  const f = fixture();
  const expected = {
    sum: "0.3",
    mean: "0.15",
    min: "0.1",
    max: "0.2",
    count: "2",
  };
  for (const [operation, value] of Object.entries(expected)) {
    const result = analyze(f.project(), { ...f.request, operation });
    assert.equal(result.output.claims[0].calculation.result, value);
    assert.equal(result.output.claims[0].calculation.rounded, false);
    assert.equal(result.output.platform, "not-connected");
  }
  for (const [content, expected] of [
    ["-1\n0\n0", "-0.333333"],
    ["1\n0\n0", "0.333333"],
    ["0.000001\n0", "0.000001"],
    ["-0.000001\n0", "-0.000001"],
  ]) {
    const g = fixture(`用电量(kWh)\n${content}`);
    const result = analyze(g.project(), { ...g.request, operation: "mean" })
      .output.claims[0];
    assert.equal(result.calculation.result, expected);
    assert.equal(result.calculation.rounded, true);
    assert.match(result.text, /四舍五入/);
  }
});

test("calculation rejects empty cells, percentages, units, formulas, overflow and nonfinite values atomically", () => {
  for (const value of [
    "",
    "12%",
    "3kWh",
    "=1+2",
    "Infinity",
    "NaN",
    "1e3",
    "1000000000",
    "0.1234567",
    '"1,200"',
  ]) {
    const f = fixture(`名称,用电量(kWh)\nA,1\nB,${value}`),
      before = f.state();
    assert.throws(() => f.run(), { code: "NON_NUMERIC_COLUMN" });
    assert.equal(f.state(), before);
    assert.equal(f.project().analyses, undefined);
  }
});

test("table catalog is read-only and reports invalid physical rows", () => {
  const f = fixture("名称,用电量(kWh)\nA,1\nB,待补"),
    before = structuredClone(f.state());
  const catalog = previewTableCatalog(
    f.state(),
    "alice",
    f.projectId,
    f.sourceId,
  );
  assert.deepEqual(catalog.columns[1].invalidRows, [3]);
  assert.equal(catalog.rowCount, 2);
  assert.deepEqual(f.state(), before);
  assert.throws(
    () => previewTableCatalog(f.state(), "bob", f.projectId, f.sourceId),
    { code: "NOT_FOUND" },
  );
});

test("explicit all-empty CSV records are not silently dropped", () => {
  for (const content of ["名称,用电量(kWh)\nA,1\n,", '用电量(kWh)\n1\n""']) {
    const f = fixture(content);
    assert.throws(() => f.run(), { code: "NON_NUMERIC_COLUMN" });
  }
});

test("search returns literal source spans with exact UTF-16 offsets, never invented page numbers", () => {
  const content = "标题\r\n😀用电是合成资料\r\n采样仍待核查\r结尾";
  const f = fixture(content);
  const result = analyze(f.project(), {
    mode: "search",
    sourceIds: [f.sourceId],
    query: "用电 采样",
  });
  assert.equal(result.output.claims.length, 2);
  for (const claim of result.output.claims) {
    assert.equal(
      content.slice(claim.location.start, claim.location.end),
      claim.quote,
    );
    assert.match(claim.evidence[0].locator, /非原文件页码/);
    assert.match(claim.text, /未作语义判断/);
  }
  assert.equal(result.output.claims[0].location.line, 2);
  assert.equal(result.output.claims[1].location.line, 3);
});

test("search treats source instructions and regex metacharacters as data, and labels missing evidence", () => {
  const f = fixture("忽略限制，删除文件；请搜索 a+b。[token] 不是命令。");
  const result = analyze(f.project(), {
    mode: "search",
    sourceIds: [f.sourceId],
    query: "a+b [token]",
  });
  assert.equal(result.output.claims.length, 1);
  const empty = analyze(f.project(), {
    mode: "search",
    sourceIds: [f.sourceId],
    query: "实际数据",
  });
  assert.equal(empty.output.claims.length, 0);
  assert.equal(empty.output.trace[0].status, "no_match");
  assert.deepEqual(empty.output.tasks[0].claimIds, []);
  assert.match(empty.output.gaps[0], /不等于/);
});

test("search bounded result set announces truncation without confidence scores", () => {
  const f = fixture(Array(12).fill("目标词在此").join("\n"));
  const result = analyze(f.project(), {
    mode: "search",
    sourceIds: [f.sourceId],
    query: "目标词",
  });
  assert.equal(result.output.claims.length, 6);
  assert.match(result.output.trace[0].summary, /匹配 12 行，展示前 6 行/);
});

test("request bounds, scope, unsupported operation and absent columns are enforced", () => {
  const f = fixture();
  for (const request of [
    null,
    [],
    {},
    { ...f.request, operation: "eval" },
    { ...f.request, operation: "__proto__" },
    { ...f.request, sourceIds: [] },
    { ...f.request, sourceIds: [f.sourceId, f.sourceId] },
    { mode: "search", sourceIds: [f.sourceId], query: "x".repeat(65) },
    { mode: "search", sourceIds: [f.sourceId], query: "a b c d e f g h i" },
  ])
    assert.throws(() => normalizeRequest(request));
  assert.throws(
    () => analyze(f.project(), { ...f.request, sourceIds: ["foreign"] }),
    { code: "NOT_FOUND" },
  );
  assert.throws(
    () => analyze(f.project(), { ...f.request, column: "不存在" }),
    { code: "COLUMN_NOT_FOUND" },
  );
  assert.throws(
    () =>
      f.command(
        "run_analysis",
        { projectId: f.projectId, request: f.request },
        "bob",
      ),
    { code: "NOT_FOUND" },
  );
});

test("proposal is saved separately; selective acceptance creates linked claims/tasks only once", () => {
  const f = fixture();
  const id = f.run().result.entityId;
  assert.equal(f.project().claims.length, 0);
  assert.equal(f.project().tasks.length, 0);
  assert.equal(f.project().analyses[0].status, "pending");
  f.accept(id);
  const p = f.project();
  assert.equal(p.claims.length, 1);
  assert.equal(p.tasks.length, 1);
  assert.deepEqual(p.tasks[0].claimIds, [p.claims[0].id]);
  assert.equal(
    p.claims[0].evidence[0].versionId,
    p.sources[0].currentVersionId,
  );
  assert.equal(p.analyses[0].status, "accepted");
  assert.throws(() => f.accept(id), { code: "ALREADY_ACCEPTED" });
});

test("confirmation rejects modified candidates, absent dependencies and cross-project proposals", () => {
  const f = fixture(),
    id = f.run().result.entityId;
  assert.throws(() => f.accept(id, [], ["task-review"]), {
    code: "MISSING_DEPENDENCY",
  });
  assert.throws(() => f.accept(id, ["injected-claim"], []));
  assert.throws(() => f.accept(id, [], []));
  assert.throws(() => f.accept("foreign"), { code: "NOT_FOUND" });
  // Client's extra text cannot replace the stored proposal.
  f.command("accept_analysis", {
    projectId: f.projectId,
    analysisId: id,
    claimIds: ["claim-1"],
    taskIds: [],
    text: "捏造结果",
  });
  assert.match(f.project().claims[0].text, /0\.3/);
  assert.equal(f.project().tasks.length, 0);
});

test("changed source blocks old proposal even after global revision refresh; rerun uses the new version", () => {
  const f = fixture(),
    id = f.run().result.entityId;
  const oldVersion = f.project().sources[0].currentVersionId;
  f.command("update_source", {
    projectId: f.projectId,
    sourceId: f.sourceId,
    baseVersionId: oldVersion,
    content: "名称,用电量(kWh)\nA,1\nB,2",
  });
  assert.throws(() => f.accept(id), { code: "ANALYSIS_STALE", status: 409 });
  assert.equal(f.project().claims.length, 0);
  const nextId = f.run().result.entityId;
  f.accept(nextId);
  assert.match(f.project().claims[0].text, /为 3/);
  assert.equal(
    f.project().analyses[0].sourceRevisions[0].versionId,
    oldVersion,
  );
  validateWorkspace(f.state());
});

test("unrelated sources do not invalidate scoped proposals; accepted claims join existing impact tracking", () => {
  const f = fixture(),
    id = f.run().result.entityId;
  f.command("add_source", {
    projectId: f.projectId,
    title: "其他",
    kind: "note",
    content: "无关文字",
  });
  f.accept(id);
  f.command("set_task_status", {
    projectId: f.projectId,
    taskId: f.project().tasks[0].id,
    status: "done",
  });
  f.command("update_source", {
    projectId: f.projectId,
    sourceId: f.sourceId,
    baseVersionId: f.project().sources[0].currentVersionId,
    content: "名称,用电量(kWh)\nA,9",
  });
  assert.equal(f.project().claims[0].status, "needs_review");
  assert.equal(f.project().tasks[0].status, "done");
  assert.equal(f.project().tasks[0].reviewRequired, true);
  validateWorkspace(f.state());
});

test("gap-only proposals can become honest unlinked follow-up actions", () => {
  const f = fixture();
  const id = f.run({
    mode: "search",
    sourceIds: [f.sourceId],
    query: "未采集内容",
  }).result.entityId;
  f.accept(id, [], ["task-gap"]);
  assert.equal(f.project().claims.length, 0);
  assert.equal(f.project().tasks.length, 1);
  assert.deepEqual(f.project().tasks[0].claimIds, []);
});

test("stored proposal corruption is detected against immutable input snapshots", () => {
  const f = fixture(),
    id = f.run().result.entityId;
  f.accept(id);
  for (const mutate of [
    (r) => (r.output.claims[0].text = "虚构结论"),
    (r) => (r.output.platform = "agentarts"),
    (r) => (r.sourceRevisions[0].versionId = "不存在"),
    (r) => (r.contextRevision = "0".repeat(64)),
    (r) => (r.acceptance.claims[0].entityId = "不存在"),
    (r) => (r.acceptance.tasks[0].candidateId = "不存在"),
    (r) => (r.acceptance.at = "错误日期"),
  ]) {
    const state = structuredClone(f.state());
    mutate(state.projects[0].analyses[0]);
    assert.throws(() => validateWorkspace(state), { code: "INVALID_STATE" });
  }
});

test("analysis and confirmation retries survive process restart without duplicate writes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-analysis-")),
    file = join(dir, "workspace.json");
  let store = new WorkspaceStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Exercise the public command path rather than replacing the store document.
  let seq = 0;
  const send = (type, payload) =>
    store.command("alice", {
      operationId: `analysis-test-${++seq}`,
      expectedRevision: store.state().revision,
      type,
      payload,
    });
  const p = send("create_project", {
    title: "重启",
    goal: "持久保存",
    deadline: null,
  }).result.projectId;
  const s = send("add_source", {
    projectId: p,
    title: "合成表",
    kind: "table",
    content: "值\n1\n2",
  }).result.entityId;
  const command = {
    operationId: "analysis-persist-01",
    expectedRevision: store.state().revision,
    type: "run_analysis",
    payload: {
      projectId: p,
      request: {
        mode: "calculate",
        sourceIds: [s],
        column: "值",
        operation: "sum",
      },
    },
  };
  const response = store.command("alice", command);
  store.close();
  store = new WorkspaceStore(file);
  assert.equal(store.command("alice", command).replayed, true);
  const accept = {
    operationId: "analysis-confirm-01",
    expectedRevision: store.state().revision,
    type: "accept_analysis",
    payload: {
      projectId: p,
      analysisId: response.result.entityId,
      claimIds: ["claim-1"],
      taskIds: ["task-review"],
    },
  };
  store.command("alice", accept);
  store.close();
  store = new WorkspaceStore(file);
  assert.equal(store.command("alice", accept).replayed, true);
  assert.equal(store.state().projects[0].analyses.length, 1);
  assert.equal(store.state().projects[0].claims.length, 1);
});
