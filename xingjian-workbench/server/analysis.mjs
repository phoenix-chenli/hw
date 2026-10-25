import { createHash } from "node:crypto";
import { originalContent } from "./review.mjs";

// Local, deterministic tools. No model, network, arbitrary SQL or code execution.
// Source-version and locator precision follow the boundaries documented in ADAPTERS.md.
export class AnalysisError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
    this.status = status;
  }
}
const fail = (message, code = "INVALID_ANALYSIS", status = 400) => {
  throw new AnalysisError(code, message, status);
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) =>
  typeof value === "string" && value.trim() && value.length <= limit;
const operations = {
  sum: "合计",
  mean: "平均值",
  min: "最小值",
  max: "最大值",
  count: "有效数值个数",
};

export function normalizeRequest(request) {
  if (!object(request) || !["search", "calculate"].includes(request.mode))
    fail("请选择查找依据或表格计算。");
  if (
    !Array.isArray(request.sourceIds) ||
    !request.sourceIds.length ||
    request.sourceIds.length > 10 ||
    request.sourceIds.some((id) => !text(id, 160) || id !== id.trim()) ||
    new Set(request.sourceIds).size !== request.sourceIds.length
  )
    fail("请选择 1–10 份资料，且不能重复。");
  if (request.mode === "search") {
    if (!text(request.query, 300)) fail("请输入不超过 300 字的检索词。");
    const terms = [...new Set(request.query.trim().split(/[\s,，;；]+/u))];
    if (terms.length > 8 || terms.some((term) => term.length > 64))
      fail("最多输入 8 个检索词，每个不超过 64 字；用空格分隔。");
    return {
      mode: "search",
      sourceIds: [...request.sourceIds],
      query: terms.join(" "),
    };
  }
  if (
    request.sourceIds.length !== 1 ||
    !text(request.column, 120) ||
    !Object.hasOwn(operations, request.operation)
  )
    fail("计算需要选择一份 CSV 资料、有效列名与支持的运算。");
  return {
    mode: "calculate",
    sourceIds: [...request.sourceIds],
    column: request.column.trim(),
    operation: request.operation,
  };
}

function scopedSources(project, request, snapshots) {
  if (
    snapshots &&
    (!Array.isArray(snapshots) || snapshots.length !== request.sourceIds.length)
  )
    fail("分析资料快照损坏。");
  let size = 0;
  return request.sourceIds.map((id, index) => {
    const source = project.sources.find((entry) => entry.id === id);
    if (!source) fail("分析资料不存在或不属于此项目。", "NOT_FOUND", 404);
    const snapshot = snapshots?.[index];
    if (snapshots && (!object(snapshot) || snapshot.sourceId !== id))
      fail("分析资料快照损坏。");
    const version = source.versions.find(
      (entry) => entry.id === (snapshot?.versionId ?? source.currentVersionId),
    );
    if (!version) fail("分析资料版本不存在。");
    size += version.content.length;
    if (size > 300000)
      fail("单次分析最多处理 30 万字符，请缩小资料范围。", "ANALYSIS_LIMIT");
    return { source, version };
  });
}

// Deliberately restricted CSV: header first; quoted cells/CRLF supported; no guessed delimiter or skipped bad records.
export function parseCsv(content) {
  const input = content.replace(/^\uFEFF/, "");
  const records = [];
  let cells = [],
    cell = "",
    quoted = false,
    closed = false,
    rowSyntax = false,
    line = 1,
    startLine = 1;
  const pushCell = () => {
    cells.push(cell.trim());
    cell = "";
    closed = false;
  };
  const pushRow = () => {
    pushCell();
    if (cells.some(Boolean) || rowSyntax)
      records.push({ cells, startLine, endLine: line });
    if (records.length > 5001 || cells.length > 40)
      fail("CSV 最多 5,000 行数据、40 列。", "TABLE_LIMIT");
    cells = [];
    rowSyntax = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += ch;
        if (ch === "\n" || (ch === "\r" && input[i + 1] !== "\n")) line++;
      }
    } else if (ch === ",") {
      rowSyntax = true;
      pushCell();
    } else if (ch === "\n" || ch === "\r") {
      pushRow();
      if (ch === "\r" && input[i + 1] === "\n") i++;
      line++;
      startLine = line;
    } else if (ch === '"' && cell === "" && !closed) {
      quoted = true;
      rowSyntax = true;
    } else {
      if (closed || ch === '"')
        fail(`第 ${line} 行引号格式有误，请使用标准 CSV。`, "INVALID_CSV");
      cell += ch;
    }
  }
  if (quoted) fail("CSV 引号未闭合，请核对资料。", "INVALID_CSV");
  if (cell || cells.length || closed) pushRow();
  const header = records.shift();
  if (!header || !records.length)
    fail(
      "需要首行为列名、至少一行数据的 CSV。说明文字请另存为笔记。",
      "INVALID_CSV",
    );
  if (
    header.cells.some((name) => !text(name, 120)) ||
    new Set(header.cells).size !== header.cells.length
  )
    fail("CSV 列名不能为空、重复或超过 120 字。", "INVALID_CSV");
  for (const row of records)
    if (row.cells.length !== header.cells.length)
      fail(
        `第 ${row.startLine} 行列数与表头不一致；不会跳过此行进行计算。`,
        "INVALID_CSV",
      );
  return { columns: header.cells, rows: records };
}

// Fixed decimal arithmetic: up to 9 integer + 6 fractional digits per input, no binary float accumulation.
const SCALE = 1000000n;
const numeric = (value) => /^[+-]?\d{1,9}(?:\.\d{1,6})?$/.test(value);
function decimal(value) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
  return negative ? -result : result;
}
function formatted(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / SCALE}${fraction ? "." + fraction : ""}`;
}

export function tableCatalog(project, sourceId) {
  const source = project.sources.find((entry) => entry.id === sourceId);
  if (!source) fail("资料不存在或不属于此项目。", "NOT_FOUND", 404);
  const version = source.versions.at(-1);
  const table = parseCsv(version.content);
  return {
    sourceId,
    versionId: version.id,
    rowCount: table.rows.length,
    columns: table.columns.map((name, index) => ({
      name,
      invalidRows: table.rows
        .filter((row) => !numeric(row.cells[index]))
        .map((row) => row.startLine),
    })),
  };
}

const evidence = (source, version, locator) => ({
  sourceId: source.id,
  versionId: version.id,
  locator,
});
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function analyze(project, rawRequest, snapshots) {
  const request = normalizeRequest(rawRequest);
  const sources = scopedSources(project, request, snapshots);
  const sourceRevisions = sources.map(({ source, version }) => ({
    sourceId: source.id,
    versionId: version.id,
  }));
  const contextRevision = createHash("sha256")
    .update(JSON.stringify([project.id, sourceRevisions]))
    .digest("hex");
  const claims = [],
    tasks = [],
    gaps = [],
    trace = [];
  if (request.mode === "search") {
    const terms = request.query.split(" ");
    const patterns = terms.map((term) => new RegExp(escapeRegex(term), "iu"));
    const found = new Set();
    const hits = [];
    for (const { source, version } of sources) {
      let offset = 0,
        lineNumber = 0;
      for (const line of version.content.split(/\r\n|\n|\r/)) {
        lineNumber++;
        const matches = patterns.map((pattern) => pattern.exec(line));
        const score = matches.filter(Boolean).length;
        matches.forEach((match, index) => {
          if (match) found.add(terms[index]);
        });
        if (score) {
          const firstMatch = Math.min(
            ...matches.filter(Boolean).map((match) => match.index),
          );
          const start = Math.max(0, firstMatch - 60),
            end = Math.min(line.length, start + 300);
          const quote = line.slice(start, end);
          hits.push({
            score,
            quote,
            source,
            version,
            location: {
              precision: "pasted_text_span",
              start: offset + start,
              end: offset + end,
              line: lineNumber,
            },
            locator: `粘贴文本第 ${lineNumber} 行，字符 ${start + 1}–${end}（非原文件页码）`,
          });
        }
        // Preserve exact UTF-16 offsets even for CRLF; never infer original PDF pages.
        offset += line.length;
        if (version.content.slice(offset, offset + 2) === "\r\n") offset += 2;
        else if (/[\r\n]/.test(version.content[offset] ?? "")) offset++;
      }
    }
    hits.sort((a, b) => b.score - a.score);
    for (const [index, hit] of hits.slice(0, 6).entries()) {
      claims.push({
        id: `claim-${index + 1}`,
        kind: "excerpt",
        text: `资料摘录（未作语义判断）：${hit.quote}`,
        evidence: [evidence(hit.source, hit.version, hit.locator)],
        quote: hit.quote,
        location: hit.location,
      });
    }
    const missing = terms.filter((term) => !found.has(term));
    if (!hits.length)
      gaps.push(
        "未找到字面匹配。请换关键词或补充资料；这不等于资料中没有答案。",
      );
    else
      gaps.push(
        "摘录仅说明关键词出现的位置，不代表它支持研究假设；请阅读上下文后判断。",
      );
    if (missing.length) {
      gaps.push(`当前资料未匹配：${missing.join("、")}。`);
      tasks.push({
        id: "task-gap",
        title: `补充或核查检索词：${missing.join("、")}`.slice(0, 120),
        claimIds: [],
      });
    }
    if (claims.length)
      tasks.push({
        id: "task-review",
        title: "阅读摘录上下文，核对是否支持研究目标",
        claimIds: claims.map((claim) => claim.id),
      });
    trace.push({
      tool: "local.keyword-search.v1",
      status: hits.length ? "completed" : "no_match",
      summary: `检索 ${sources.length} 份资料；匹配 ${hits.length} 行，展示前 ${claims.length} 行。排序只按命中词数，不是可信度评分。`,
    });
  } else {
    const { source, version } = sources[0];
    const table = parseCsv(version.content);
    const columnIndex = table.columns.indexOf(request.column);
    if (columnIndex < 0)
      fail("所选列不存在，请重新读取列名。", "COLUMN_NOT_FOUND");
    const invalidRows = table.rows.filter(
      (row) => !numeric(row.cells[columnIndex]),
    );
    if (invalidRows.length)
      fail(
        `「${request.column}」在文本第 ${invalidRows
          .slice(0, 5)
          .map((row) => row.startLine)
          .join("、")} 行含空值或非受支持数值。请先修正；不会静默忽略。`,
        "NON_NUMERIC_COLUMN",
      );
    const values = table.rows.map((row) => decimal(row.cells[columnIndex]));
    const sum = values.reduce((a, b) => a + b, 0n);
    let value,
      rounded = false;
    if (request.operation === "sum") value = sum;
    if (request.operation === "min")
      value = values.reduce((a, b) => (a < b ? a : b));
    if (request.operation === "max")
      value = values.reduce((a, b) => (a > b ? a : b));
    if (request.operation === "count") value = BigInt(values.length) * SCALE;
    if (request.operation === "mean") {
      const count = BigInt(values.length);
      rounded = sum % count !== 0n;
      const abs = sum < 0n ? -sum : sum;
      value =
        (abs / count + ((abs % count) * 2n >= count ? 1n : 0n)) *
        (sum < 0n ? -1n : 1n);
    }
    const result = formatted(value);
    const formula =
      request.operation === "mean"
        ? `合计 ${formatted(sum)} ÷ ${values.length}`
        : `${operations[request.operation]}(${request.column})`;
    const locator = `粘贴 CSV 第 ${table.rows[0].startLine}–${table.rows.at(-1).endLine} 行，列「${request.column}」（含全部 ${values.length} 行数据）`;
    claims.push({
      id: "claim-1",
      kind: "calculation",
      text: `「${source.title}」v${version.number} 的「${request.column}」${operations[request.operation]}为 ${result}${rounded ? "（四舍五入至 6 位小数）" : ""}，基于全部 ${values.length} 行数据。`,
      evidence: [evidence(source, version, locator)],
      calculation: {
        operation: request.operation,
        column: request.column,
        result,
        formula,
        rowCount: values.length,
        rounded,
        precision: "pasted_csv_rows",
        firstLine: table.rows[0].startLine,
        lastLine: table.rows.at(-1).endLine,
      },
    });
    gaps.push(
      "计算仅适用于所选列；单位按列名原样保留，未推断单位、采样口径、因果或统计显著性。",
    );
    tasks.push({
      id: "task-review",
      title: "核对计算列的单位、样本范围与采样口径",
      claimIds: ["claim-1"],
    });
    trace.push({
      tool: "local.csv-aggregate.v1",
      status: "completed",
      summary: `${formula} = ${result}；${values.length} 行，未跳过空值或异常值。`,
    });
  }
  return {
    request,
    sourceRevisions,
    contextRevision,
    output: {
      claims,
      tasks,
      gaps,
      trace,
      engine: "local-tools-v1",
      platform: "not-connected",
    },
  };
}

export function isAnalysisStale(project, run) {
  return run.sourceRevisions.some(
    (ref) =>
      project.sources.find((source) => source.id === ref.sourceId)
        ?.currentVersionId !== ref.versionId,
  );
}

// Reproduce stored results against retained source versions. Never trust client-authored candidate text.
export function validateAnalysisRun(project, run) {
  if (!object(run) || !["pending", "accepted"].includes(run.status))
    fail("分析记录状态无效。");
  const expected = analyze(project, run.request, run.sourceRevisions);
  for (const key of ["request", "sourceRevisions", "contextRevision", "output"])
    if (JSON.stringify(run[key]) !== JSON.stringify(expected[key]))
      fail("分析记录与资料版本不一致。");
  if (run.status === "pending" && run.acceptance !== null)
    fail("未确认分析不能带有确认回执。");
  if (run.status === "accepted") {
    const receipt = run.acceptance;
    if (
      !object(receipt) ||
      !Array.isArray(receipt.claims) ||
      !Array.isArray(receipt.tasks) ||
      (!receipt.claims.length && !receipt.tasks.length)
    )
      fail("分析确认回执无效。");
    for (const [kind, collection] of [
      ["claims", project.claims],
      ["tasks", project.tasks],
    ]) {
      const seen = new Set();
      for (const ref of receipt[kind]) {
        if (!object(ref) || seen.has(ref.candidateId))
          fail("分析确认回执重复或格式无效。");
        seen.add(ref.candidateId);
        const candidate = run.output[kind].find(
          (entry) => entry.id === ref.candidateId,
        );
        const entity = collection.find((entry) => entry.id === ref.entityId);
        if (!candidate || !entity) fail("分析确认回执引用不存在的对象。");
        // Later human reviews append content versions; the accepted proposal
        // remains bound to the original content, never rewritten to match edits.
        const acceptedContent = originalContent(entity);
        if (
          kind === "claims" &&
          (candidate.text !== acceptedContent.text ||
            JSON.stringify(candidate.evidence) !==
              JSON.stringify(acceptedContent.evidence))
        )
          fail("分析结论与确认提案不一致。");
        if (kind === "tasks") {
          const ids = candidate.claimIds.map(
            (id) =>
              receipt.claims.find((item) => item.candidateId === id)?.entityId,
          );
          if (
            ids.includes(undefined) ||
            candidate.title !== acceptedContent.title ||
            JSON.stringify(ids) !== JSON.stringify(acceptedContent.claimIds)
          )
            fail("分析任务关联不一致。");
        }
      }
    }
  }
}
