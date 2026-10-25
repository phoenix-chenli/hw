import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Search,
  Calculator,
  ArrowRight,
  CheckCircle2,
  TriangleAlert,
  LoaderCircle,
  FileText,
  History,
} from "lucide-react";
import type {
  AnalysisRequest,
  AnalysisRun,
  Command,
  Project,
  TableCatalog,
  Workspace,
} from "../shared/contracts";
import {
  ApiError,
  getTableCatalog,
  getWorkspace,
  makeCommand,
  submitCommand,
} from "./api";

const operations = {
  sum: "合计",
  mean: "平均值",
  min: "最小值",
  max: "最大值",
  count: "有效数值个数",
};
const stale = (project: Project, run: AnalysisRun) =>
  run.sourceRevisions.some(
    (ref) =>
      project.sources.find((source) => source.id === ref.sourceId)
        ?.currentVersionId !== ref.versionId,
  );

export default function AnalysisPanel({
  project,
  workspace,
  onWorkspace,
  onEvidence,
  onAddSource,
}: {
  project: Project;
  workspace: Workspace;
  onWorkspace: (state: Workspace) => void;
  onEvidence: (sourceId: string, versionId: string) => void;
  onAddSource: () => void;
}) {
  const [mode, setMode] = useState<"search" | "calculate">("search");
  const [query, setQuery] = useState("");
  const [sourceIds, setSourceIds] = useState(
    project.sources.slice(0, 10).map((source) => source.id),
  );
  const [tableId, setTableId] = useState(
    project.sources.find((source) => source.kind === "table")?.id ??
      project.sources[0]?.id ??
      "",
  );
  const [column, setColumn] = useState("");
  const [operation, setOperation] = useState<keyof typeof operations>("sum");
  const [catalog, setCatalog] = useState<TableCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [runId, setRunId] = useState(project.analyses?.at(-1)?.id ?? "");
  const [claims, setClaims] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<Command | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const runs = project.analyses ?? [];
  const run = runs.find((entry) => entry.id === runId);
  const obsolete = !!run && stale(project, run);
  const locked = busy || obsolete || run?.status === "accepted";
  const tableVersion = project.sources.find(
    (source) => source.id === tableId,
  )?.currentVersionId;

  useEffect(() => {
    if (!tableId && project.sources.length) setTableId(project.sources[0].id);
  }, [tableId, project.sources]);

  useEffect(() => {
    if (mode !== "calculate" || !tableId) return;
    let active = true;
    setCatalog(null);
    setCatalogError("");
    setCatalogBusy(true);
    setColumn("");
    getTableCatalog(project.id, tableId)
      .then((data) => {
        if (active) {
          setCatalog(data);
          setColumn(
            data.columns.find((entry) => !entry.invalidRows.length)?.name ?? "",
          );
        }
      })
      .catch((err) => {
        if (active)
          setCatalogError(
            err instanceof Error ? err.message : "无法读取列名，请重试。",
          );
      })
      .finally(() => {
        if (active) setCatalogBusy(false);
      });
    return () => {
      active = false;
    };
  }, [mode, tableId, tableVersion, project.id, catalogAttempt]);

  function selectRun(id: string) {
    setRunId(id);
    setClaims([]);
    setTasks([]);
    setError("");
    setNotice("");
    pending.current = null;
  }

  async function execute(
    type: "run_analysis" | "accept_analysis",
    payload: Record<string, unknown>,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const old = pending.current;
    const command =
      old &&
      old.type === type &&
      JSON.stringify(old.payload) === JSON.stringify(payload)
        ? old
        : makeCommand(type, payload, workspace.revision);
    pending.current = command;
    try {
      const response = await submitCommand(command);
      onWorkspace(response.state);
      pending.current = null;
      setRunId(response.result.entityId ?? "");
      setClaims([]);
      setTasks([]);
      setNotice(
        type === "run_analysis"
          ? "提案已保存。核对依据并勾选需要加入的内容。"
          : "所选内容已加入结论与行动，保留资料版本和本次分析记录。",
      );
      requestAnimationFrame(() => resultHeading.current?.focus());
    } catch (err) {
      let message = err instanceof Error ? err.message : "操作失败，请重试。";
      if (err instanceof ApiError && err.status === 409) {
        pending.current = null;
        try {
          onWorkspace(await getWorkspace());
          message = `${err.message} 输入已保留，已刷新当前资料。`;
        } catch {
          message += " 暂时无法刷新，请恢复本地服务后重试。";
        }
      } else if (!(err instanceof ApiError))
        message =
          "连接中断，输入已保留。点击相同按钮重试会复用本次操作，不会重复加入。";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const request: AnalysisRequest =
      mode === "search"
        ? { mode, sourceIds, query }
        : { mode, sourceIds: [tableId], column, operation };
    void execute("run_analysis", { projectId: project.id, request });
  }
  function toggleClaim(id: string, checked: boolean) {
    setClaims((previous) =>
      checked ? [...previous, id] : previous.filter((entry) => entry !== id),
    );
    if (!checked)
      setTasks((previous) =>
        previous.filter(
          (taskId) =>
            !run?.output.tasks
              .find((task) => task.id === taskId)
              ?.claimIds.includes(id),
        ),
      );
  }
  function toggleTask(id: string, checked: boolean) {
    setTasks((previous) =>
      checked ? [...previous, id] : previous.filter((entry) => entry !== id),
    );
    if (checked)
      setClaims((previous) => [
        ...new Set([
          ...previous,
          ...(run?.output.tasks.find((task) => task.id === id)?.claimIds ?? []),
        ]),
      ]);
  }
  function rerun() {
    if (run)
      void execute("run_analysis", {
        projectId: project.id,
        request: run.request,
      });
  }

  return (
    <div className="analysis-workbench">
      <section
        className="panel analysis-input"
        aria-labelledby="analysis-input-title"
      >
        <div className="analysis-section-head">
          <span className="eyebrow">从资料出发</span>
          <span className="badge badge-blue">本地工具</span>
        </div>
        <h2 id="analysis-input-title">先找到依据，再决定下一步</h2>
        <p className="analysis-help">
          资料留在当前电脑。此处进行字面检索和确定性计算，AgentArts 尚未接通。
        </p>
        {!project.sources.length ? (
          <div className="analysis-empty">
            <FileText size={28} />
            <h3>先准备一份资料</h3>
            <p>可以粘贴文字，或首行为列名的 CSV 表格。</p>
            <button className="button primary" onClick={onAddSource}>
              添加资料
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <fieldset disabled={busy} className="analysis-mode">
              <legend className="sr-only">分析方式</legend>
              <button
                type="button"
                aria-pressed={mode === "search"}
                onClick={() => setMode("search")}
              >
                <Search size={17} />
                查找依据
              </button>
              <button
                type="button"
                aria-pressed={mode === "calculate"}
                onClick={() => setMode("calculate")}
              >
                <Calculator size={17} />
                表格计算
              </button>
            </fieldset>
            {mode === "search" ? (
              <>
                <div className="field">
                  <label htmlFor="analysis-query">想找哪些信息</label>
                  <input
                    id="analysis-query"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="例如：用电 采样"
                    required
                    maxLength={300}
                    disabled={busy}
                    aria-describedby="query-hint"
                  />
                  <small id="query-hint">
                    用空格分隔关键词，最多 8
                    个。按字面匹配，不推断自然语言问题。
                  </small>
                </div>
                <fieldset disabled={busy} className="analysis-sources">
                  <legend>
                    资料范围 <span>已选 {sourceIds.length}/10</span>
                  </legend>
                  {project.sources.map((source) => (
                    <label key={source.id}>
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(source.id)}
                        disabled={
                          !sourceIds.includes(source.id) &&
                          sourceIds.length >= 10
                        }
                        onChange={(event) =>
                          setSourceIds((previous) =>
                            event.target.checked
                              ? [...previous, source.id]
                              : previous.filter((id) => id !== source.id),
                          )
                        }
                      />
                      <span>
                        {source.title}
                        <small>
                          v{source.versions.at(-1)!.number} · 当前版本
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="analysis-table">表格资料</label>
                  <select
                    id="analysis-table"
                    value={tableId}
                    disabled={busy}
                    onChange={(event) => setTableId(event.target.value)}
                  >
                    {project.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.title}
                      </option>
                    ))}
                  </select>
                  <small>
                    只读取标准 CSV；第一行是列名，单位写在列名中。最多 5,000
                    行、40 列。
                  </small>
                </div>
                {catalogBusy && (
                  <p role="status" className="analysis-help">
                    正在读取列名…
                  </p>
                )}
                {catalogError && (
                  <div className="analysis-warning" role="alert">
                    <TriangleAlert size={18} />
                    <div>
                      <p>{catalogError}</p>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setCatalogAttempt((value) => value + 1)}
                      >
                        重试读取列名
                      </button>
                    </div>
                  </div>
                )}
                {catalog && (
                  <>
                    <div className="field">
                      <label htmlFor="analysis-column">数值列</label>
                      <select
                        id="analysis-column"
                        value={column}
                        disabled={busy}
                        required
                        onChange={(event) => setColumn(event.target.value)}
                      >
                        <option value="">请选择完整数值列</option>
                        {catalog.columns.map((entry) => (
                          <option
                            key={entry.name}
                            value={entry.name}
                            disabled={!!entry.invalidRows.length}
                          >
                            {entry.name}
                            {entry.invalidRows.length
                              ? `（${entry.invalidRows.length} 行待修正）`
                              : ""}
                          </option>
                        ))}
                      </select>
                      <small>
                        共 {catalog.rowCount}{" "}
                        行。空值、百分号、公式、千位分隔或单位混入数值时会拒绝计算，不跳过异常值。
                      </small>
                    </div>
                    {!catalog.columns.some(
                      (entry) => !entry.invalidRows.length,
                    ) && (
                      <p className="analysis-warning">
                        没有完整数值列。请在“资料与依据”修正后再试。
                      </p>
                    )}
                  </>
                )}
                <div className="field">
                  <label htmlFor="analysis-operation">运算</label>
                  <select
                    id="analysis-operation"
                    value={operation}
                    disabled={busy}
                    onChange={(event) =>
                      setOperation(
                        event.target.value as keyof typeof operations,
                      )
                    }
                  >
                    {Object.entries(operations).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small>
                    每项最多 9 位整数、6 位小数；平均值最多保留 6
                    位小数并标注舍入。
                  </small>
                </div>
              </>
            )}
            <button
              className="button primary analysis-run"
              type="submit"
              disabled={
                busy ||
                (mode === "search"
                  ? !sourceIds.length || !query.trim()
                  : catalogBusy || !catalog || !column)
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowRight size={17} />
              )}
              {mode === "search" ? "查找并生成提案" : "计算并生成提案"}
            </button>
            <p className="analysis-help">
              生成后保留分析记录；结论与行动需要你确认才会加入。
            </p>
          </form>
        )}
      </section>

      <section
        className="panel analysis-result"
        aria-labelledby="analysis-result-title"
        aria-busy={busy}
      >
        <div className="analysis-section-head">
          <h2 id="analysis-result-title" tabIndex={-1} ref={resultHeading}>
            分析提案
          </h2>
          <span className="badge badge-neutral">{runs.length} 次记录</span>
        </div>
        {runs.length > 0 && (
          <div className="field analysis-history">
            <label htmlFor="analysis-history">
              <History size={14} />
              查看分析记录
            </label>
            <select
              id="analysis-history"
              value={runId}
              disabled={busy}
              onChange={(event) => selectRun(event.target.value)}
            >
              {[...runs].reverse().map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {runs.length - index}.{" "}
                  {entry.request.mode === "search"
                    ? `查找：${entry.request.query}`
                    : `${operations[entry.request.operation]}：${entry.request.column}`}{" "}
                  ·{" "}
                  {entry.status === "accepted"
                    ? "已确认"
                    : stale(project, entry)
                      ? "资料已更新"
                      : "待确认"}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <div className="analysis-warning" role="alert">
            <TriangleAlert size={18} />
            <p>{error}</p>
          </div>
        )}
        {notice && (
          <div className="analysis-notice" role="status">
            <CheckCircle2 size={18} />
            <p>{notice}</p>
          </div>
        )}
        {!run ? (
          <div className="analysis-empty">
            <Search size={30} />
            <h3>发现会带着出处回来</h3>
            <p>
              输入关键词或选一列数据。结果、来源版本和可追溯的计算过程会显示在这里。
            </p>
            <div className="analysis-steps">
              <span>01 查找 / 计算</span>
              <span>02 核对依据</span>
              <span>03 确认加入</span>
            </div>
          </div>
        ) : (
          <>
            {obsolete && (
              <div className="analysis-warning" role="status">
                <TriangleAlert size={18} />
                <div>
                  <strong>这份分析使用的资料已更新</strong>
                  <p>保留旧结果供对照。请重新分析，不会把过期结果直接加入。</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={rerun}
                  >
                    按当前版本重新分析 <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}
            {run.status === "accepted" && (
              <div className="analysis-notice">
                <CheckCircle2 size={18} />
                <p>
                  已加入 {run.acceptance?.claims.length} 条结论、
                  {run.acceptance?.tasks.length} 项行动。这份提案不会再次写入。
                </p>
              </div>
            )}
            {run.output.claims.length > 0 && (
              <div className="analysis-candidates">
                <h3>
                  候选结论 <span>先核对，再勾选</span>
                </h3>
                {run.output.claims.map((candidate) => (
                  <article key={candidate.id} className="analysis-candidate">
                    <label className="analysis-choice">
                      <input
                        type="checkbox"
                        aria-label={`选择候选 ${candidate.id}`}
                        checked={
                          claims.includes(candidate.id) ||
                          !!run.acceptance?.claims.some(
                            (entry) => entry.candidateId === candidate.id,
                          )
                        }
                        disabled={locked}
                        onChange={(event) =>
                          toggleClaim(candidate.id, event.target.checked)
                        }
                      />
                      <span>
                        <small>
                          {candidate.kind === "excerpt"
                            ? "原文摘录 · 尚未判断支持关系"
                            : "受控计算 · 请核对口径"}
                        </small>
                        <p>{candidate.text}</p>
                      </span>
                    </label>
                    {candidate.calculation && (
                      <div className="calculation-detail">
                        <span>计算过程</span>
                        <code>
                          {candidate.calculation.formula} ={" "}
                          {candidate.calculation.result}
                        </code>
                      </div>
                    )}
                    {candidate.evidence.map((ref) => {
                      const source = project.sources.find(
                        (source) => source.id === ref.sourceId,
                      )!;
                      return (
                        <button
                          className="analysis-evidence"
                          key={ref.sourceId + ref.locator}
                          type="button"
                          onClick={() =>
                            onEvidence(ref.sourceId, ref.versionId)
                          }
                        >
                          <FileText size={16} />
                          <span>
                            {source.title} · v
                            {
                              source.versions.find(
                                (version) => version.id === ref.versionId,
                              )?.number
                            }
                            <small>{ref.locator}</small>
                          </span>
                          <ArrowRight size={14} />
                        </button>
                      );
                    })}
                  </article>
                ))}
              </div>
            )}
            <div className="analysis-gaps">
              <h3>需要留意</h3>
              <ul>
                {run.output.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
            {run.output.tasks.length > 0 && (
              <div className="analysis-candidates">
                <h3>
                  可以接着做 <span>选择关联行动会同时选择它的依据</span>
                </h3>
                {run.output.tasks.map((task) => (
                  <label
                    key={task.id}
                    className="analysis-choice analysis-task"
                  >
                    <input
                      type="checkbox"
                      checked={
                        tasks.includes(task.id) ||
                        !!run.acceptance?.tasks.some(
                          (entry) => entry.candidateId === task.id,
                        )
                      }
                      disabled={locked}
                      onChange={(event) =>
                        toggleTask(task.id, event.target.checked)
                      }
                    />
                    <span>
                      {task.title}
                      <small>
                        {task.claimIds.length
                          ? `关联 ${task.claimIds.length} 条候选结论`
                          : "补充资料任务，尚无依据关联"}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {run.status !== "accepted" && (
              <div className="analysis-confirm">
                <p>
                  已选 {claims.length} 条结论 · {tasks.length} 项行动
                </p>
                <button
                  type="button"
                  className="button primary"
                  disabled={locked || (!claims.length && !tasks.length)}
                  onClick={() =>
                    void execute("accept_analysis", {
                      projectId: project.id,
                      analysisId: run.id,
                      claimIds: claims,
                      taskIds: tasks,
                    })
                  }
                >
                  {busy && <LoaderCircle size={16} className="spin" />}
                  确认加入所选内容
                </button>
              </div>
            )}
            <details className="analysis-trace">
              <summary>本地执行记录与资料版本</summary>
              <p>本记录来自确定性本地工具；不是 AgentArts 运行日志。</p>
              {run.output.trace.map((entry) => (
                <div key={entry.tool}>
                  <code>{entry.tool}</code>
                  <p>{entry.summary}</p>
                </div>
              ))}
              <p>
                运行编号：<code>{run.id}</code>
              </p>
              <p>
                资料快照：<code>{run.contextRevision}</code>
              </p>
              {run.sourceRevisions.map((ref) => {
                const source = project.sources.find(
                  (entry) => entry.id === ref.sourceId,
                )!;
                return (
                  <p key={ref.sourceId}>
                    {source.title} · v
                    {
                      source.versions.find(
                        (entry) => entry.id === ref.versionId,
                      )?.number
                    }
                  </p>
                );
              })}
            </details>
          </>
        )}
      </section>
    </div>
  );
}
