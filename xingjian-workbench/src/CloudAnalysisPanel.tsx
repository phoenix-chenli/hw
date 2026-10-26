import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  FileText,
  History,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AgentRequest, AgentRun } from "../shared/agent-contracts";
import type { Command, Project, Workspace } from "../shared/contracts";
import { ApiError, getWorkspace, makeCommand, submitCommand } from "./api";
import {
  getAgentConfiguration,
  interruptAgentRun,
  startAgentRun,
  type AgentConfiguration,
  type StartAgentRequest,
} from "./agent-api";
import "./cloud-analysis.css";

const statusNames: Record<AgentRun["status"], string> = {
  queued: "已排队",
  running: "运行中",
  blocked: "尚未发送",
  needs_input: "需要补充信息",
  proposal: "待核对",
  failed: "运行失败",
  interrupted: "已中断",
  accepted: "已确认",
};
const isActive = (run: AgentRun) =>
  run.status === "queued" || run.status === "running";
const isStale = (project: Project, run: AgentRun) =>
  run.snapshot.sourceRevisions.some(
    (ref) =>
      project.sources.find((source) => source.id === ref.sourceId)
        ?.currentVersionId !== ref.versionId,
  );
function dateLabel(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
interface PendingOperation {
  signature: string;
  start?: StartAgentRequest;
  command?: Command;
}

export default function CloudAnalysisPanel({
  project,
  workspace,
  onWorkspace,
  onEvidence,
}: {
  project: Project;
  workspace: Workspace;
  onWorkspace: (state: Workspace) => void;
  onEvidence: (
    sourceId: string,
    versionId: string,
    details?: {
      agentRunId?: string;
      agentCandidateId?: string;
      evidenceId?: string;
      locator?: string;
    },
  ) => void;
}) {
  const [config, setConfig] = useState<AgentConfiguration | null>(null);
  const [configError, setConfigError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  const [question, setQuestion] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>(
    project.sources.slice(0, 1).map((source) => source.id),
  );
  const [authorized, setAuthorized] = useState(false);
  const [runId, setRunId] = useState(project.agentRuns?.at(-1)?.id ?? "");
  const [selectedClaims, setSelectedClaims] = useState<string[]>([]);
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<PendingOperation | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const currentProject = useRef(project.id);
  const latestWorkspace = useRef(workspace);
  const workspaceCallback = useRef(onWorkspace);
  latestWorkspace.current = workspace;
  workspaceCallback.current = onWorkspace;
  const runs = project.agentRuns ?? [];
  const run = runs.find((entry) => entry.id === runId);
  const obsolete = !!run && isStale(project, run);
  const active = workspace.projects.some((entry) =>
    entry.agentRuns?.some(isActive),
  );
  const selectionLocked = busy || obsolete || run?.status !== "proposal";
  const selectedSources = project.sources.filter((source) =>
    sourceIds.includes(source.id),
  );
  const sourceLength = selectedSources.reduce(
    (total, source) =>
      total +
      (source.versions.find((entry) => entry.id === source.currentVersionId)
        ?.content.length ?? 0),
    0,
  );
  const sourceVersionKey = project.sources
    .filter((source) => sourceIds.includes(source.id))
    .map((source) => `${source.id}:${source.currentVersionId}`)
    .join("|");
  const configurationScope = config
    ? [config.provider, config.configured, config.runtimeName, config.applicationVersion].join("|")
    : "loading";
  const configured = !!config?.configured;
  const fixture = config?.provider === "contract-test";
  const intakeInvalid =
    !question.trim() ||
    !sourceIds.length ||
    sourceIds.length > 6 ||
    sourceLength > 20000 ||
    sourceIds.length !== selectedSources.length;

  useEffect(() => {
    if (currentProject.current === project.id) return;
    currentProject.current = project.id;
    setQuestion("");
    setSourceIds(project.sources.slice(0, 1).map((source) => source.id));
    setRunId(project.agentRuns?.at(-1)?.id ?? "");
    setSelectedClaims([]);
    setSelectedTasks([]);
    setAcknowledged(false);
    setAuthorized(false);
    setNotice("");
    setError("");
    pending.current = null;
  }, [project.id, project.sources, project.agentRuns]);

  useEffect(() => {
    setAuthorized(false);
  }, [sourceVersionKey, configurationScope]);

  useEffect(() => {
    let mounted = true;
    setConfigError("");
    getAgentConfiguration()
      .then((value) => {
        if (mounted) setConfig(value);
      })
      .catch((err: unknown) => {
        if (mounted)
          setConfigError(
            err instanceof Error ? err.message : "无法读取服务配置状态。",
          );
      });
    return () => {
      mounted = false;
    };
  }, [configAttempt]);

  // Keep the parent revision monotonic: an older poll cannot undo a confirmed write.
  function receive(state: Workspace) {
    if (state.revision >= latestWorkspace.current.revision) {
      latestWorkspace.current = state;
      workspaceCallback.current(state);
    }
  }

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const state = await getWorkspace();
        if (!mounted) return;
        receive(state);
        setPollError("");
      } catch {
        if (mounted)
          setPollError("暂时无法刷新运行状态；不会自动重试模型调用。");
      }
      if (mounted) timer = setTimeout(() => void poll(), 800);
    }
    timer = setTimeout(() => void poll(), 800);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [active]);

  useEffect(() => {
    if (!active) setConfigAttempt((value) => value + 1);
  }, [active]);

  function resetSelection() {
    setSelectedClaims([]);
    setSelectedTasks([]);
    setAcknowledged(false);
  }
  function chooseRun(id: string) {
    setRunId(id);
    resetSelection();
    setError("");
    setNotice("");
  }
  async function handleError(err: unknown) {
    let message = err instanceof Error ? err.message : "操作失败，请重试。";
    if (err instanceof ApiError && err.status === 409) {
      pending.current = null;
      try {
        receive(await getWorkspace());
        message += " 输入与勾选已保留，已刷新当前资料；资料变更后须重新分析。";
      } catch {
        message += " 输入已保留；暂时无法刷新，请恢复服务后重试。";
      }
    } else if (
      !(err instanceof ApiError) ||
      err.status >= 500 ||
      err.code === "INVALID_RESPONSE"
    ) {
      // A missing, damaged, or server-error receipt cannot prove whether a write
      // already committed. Keep the operation ID when the user retries it.
      message =
        "暂时无法确认操作回执，输入与勾选已保留。重试相同操作会复用操作标识，不会重复创建记录或加入内容。";
    } else {
      // Only a definite client rejection releases the pending operation.
      pending.current = null;
    }
    setError(message);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || active || !config || intakeInvalid || (configured && !authorized))
      return;
    const request: AgentRequest = {
      intent: "research",
      question: question.trim(),
      sourceIds,
    };
    const payload = {
      projectId: project.id,
      request,
      authorizeCloud: configured && authorized,
    };
    const signature = "start:" + JSON.stringify(payload);
    const start =
      pending.current?.signature === signature && pending.current.start
        ? pending.current.start
        : {
            ...payload,
            operationId: crypto.randomUUID(),
            expectedRevision: latestWorkspace.current.revision,
          };
    pending.current = { signature, start };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await startAgentRun(start);
      receive(result.state);
      pending.current = null;
      setRunId(result.result.entityId ?? "");
      resetSelection();
      setAuthorized(false);
      setConfigAttempt((value) => value + 1);
      setNotice(
        configured
          ? fixture
            ? "已启动本地协议测试；这不是 AgentArts 真实调用。"
            : "请求已保存，实际状态以运行记录为准。"
          : "已保存尚未发送的分析请求与资料快照；没有向云端传输资料。",
      );
      requestAnimationFrame(() => resultHeading.current?.focus());
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  }
  function toggleClaim(id: string, checked: boolean) {
    setSelectedClaims((previous) =>
      checked ? [...new Set([...previous, id])] : previous.filter((v) => v !== id),
    );
    if (!checked)
      setSelectedTasks((previous) =>
        previous.filter(
          (taskId) =>
            !run?.proposal?.tasks
              .find((entry) => entry.id === taskId)
              ?.claimIds.includes(id),
        ),
      );
    setAcknowledged(false);
  }
  function toggleTask(id: string, checked: boolean) {
    setSelectedTasks((previous) =>
      checked ? [...new Set([...previous, id])] : previous.filter((v) => v !== id),
    );
    if (checked)
      setSelectedClaims((previous) => [
        ...new Set([
          ...previous,
          ...(run?.proposal?.tasks.find((entry) => entry.id === id)?.claimIds ??
            []),
        ]),
      ]);
    setAcknowledged(false);
  }
  async function accept() {
    if (
      busy ||
      selectionLocked ||
      !run ||
      !acknowledged ||
      (!selectedClaims.length && !selectedTasks.length)
    )
      return;
    const payload = {
      projectId: project.id,
      runId: run.id,
      claimIds: selectedClaims,
      taskIds: selectedTasks,
      acknowledgeEvidence: true,
    };
    const signature = "accept:" + JSON.stringify(payload);
    const command =
      pending.current?.signature === signature && pending.current.command
        ? pending.current.command
        : makeCommand("accept_agent_run", payload, latestWorkspace.current.revision);
    pending.current = { signature, command };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await submitCommand(command);
      receive(result.state);
      pending.current = null;
      setNotice("所选内容已保存，保留本次运行与引用版本；不会再次写入这份提案。");
      resetSelection();
      requestAnimationFrame(() => resultHeading.current?.focus());
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  }
  async function refreshRecords() {
    if (busy) return;
    setBusy(true);
    try {
      const state = await getWorkspace();
      receive(state);
      const freshRuns = state.projects.find((entry) => entry.id === project.id)?.agentRuns ?? [];
      if (!runId && freshRuns.length) setRunId(freshRuns.at(-1)!.id);
      setPollError("");
      setError("");
      setNotice("已刷新保存的运行记录，没有重新调用模型。输入与勾选继续保留。");
      setConfigAttempt((value) => value + 1);
    } catch {
      setError("暂时无法刷新运行记录；输入与勾选已保留，恢复服务后可再次读取。不会重新调用模型。");
    } finally {
      setBusy(false);
    }
  }
  async function interrupt() {
    if (!run || busy || !isActive(run)) return;
    setBusy(true);
    setError("");
    try {
      const result = await interruptAgentRun(project.id, run.id);
      receive(result.state);
      setNotice("已停止本地等待；不能保证云端执行或计费立即停止。不会自动重新调用。");
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  }
  function prepareAgain() {
    if (!run) return;
    setQuestion(run.request.question);
    setSourceIds(run.request.sourceIds);
    setAuthorized(false);
    setError("");
    setNotice("已把原问题带回输入区。再次提交会使用资料当前版本，并创建新的运行记录。");
    requestAnimationFrame(() => {
      questionRef.current?.focus();
      questionRef.current?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }

  return (
    <section className="panel cloud-analysis" aria-labelledby="cloud-analysis-title">
      <div className="cloud-heading">
        <div>
          <span className="eyebrow">研究问题 · 云端分析</span>
          <h2 id="cloud-analysis-title">把问题与依据一起交给分析</h2>
        </div>
        <span className="badge badge-blue"><Cloud size={14} />{fixture ? "本地协议测试" : "AgentArts"}</span>
      </div>
      <p className="cloud-help">本阶段提供研究分析提案。规划、变化建议与草稿编排尚未开放；下方本地检索和计算继续可用。</p>
      <div className="cloud-config" aria-live="polite">
        <ShieldCheck size={19} />
        <div>
          <strong>{!config ? "正在读取服务状态" : fixture ? "合成结果 · 仅用于本地协议测试" : configured ? "服务端配置已准备，平台连通性尚未验证" : "云端尚未启用，当前不会发送资料"}</strong>
          {config && <p>{config.reason}</p>}
          {config && configured && <p>工作区剩余额度 {config.remainingCalls}/{config.maxCalls} 次。失败或中断的调用也可能消耗额度，不自动重试。</p>}
          {config && !configured && <p>需要在服务端配置已发布的应用、凭据和调用上限。请勿把密钥粘贴到问题或资料中。</p>}
          {configError && <p role="alert">{configError} <button type="button" className="text-button" onClick={() => setConfigAttempt((v) => v + 1)}>重新读取状态</button></p>}
          {fixture && <p>未连接华为云，也未运行真实模型；不要将以下结果作为平台验收证据。</p>}
        </div>
      </div>
      <div className="cloud-columns">
        <form className="cloud-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="cloud-question">本次研究问题</label>
            <textarea id="cloud-question" ref={questionRef} value={question} maxLength={2000} required disabled={busy} rows={4} onChange={(event) => { setQuestion(event.target.value); setAuthorized(false); }} placeholder="例如：这些资料支持哪些发现？还有哪些信息需要补充？" aria-describedby="cloud-question-hint" />
            <small id="cloud-question-hint">具体说明想判断的事情和口径，最多 2,000 字符。</small>
          </div>
          <fieldset className="cloud-sources" disabled={busy}>
            <legend>发送范围 <span>已选 {sourceIds.length}/6</span></legend>
            {!project.sources.length && <p className="cloud-help">先在“资料与依据”添加一份资料。</p>}
            {project.sources.map((source) => {
              const version = source.versions.find((entry) => entry.id === source.currentVersionId);
              return <label key={source.id}>
                <input type="checkbox" aria-label={`云端资料：${source.title}`} checked={sourceIds.includes(source.id)} disabled={!sourceIds.includes(source.id) && sourceIds.length >= 6} onChange={(event) => {
                  setSourceIds((previous) => event.target.checked ? [...previous, source.id] : previous.filter((id) => id !== source.id));
                  setAuthorized(false);
                }} />
                <span>{source.title}<small>当前 v{version?.number} · {version?.content.length ?? 0} 字符</small></span>
              </label>;
            })}
          </fieldset>
          <p className={sourceLength > 20000 ? "cloud-warning" : "cloud-help"}>所选正文共 {sourceLength.toLocaleString("zh-CN")} / 20,000 字符（按 UTF-16 计数），不静默截断。仅发送本次所选资料与问题。</p>
          {configured && <label className="cloud-consent">
            <input type="checkbox" checked={authorized} disabled={busy} onChange={(event) => setAuthorized(event.target.checked)} />
            <span>{fixture ? "同意运行本地合成协议测试（不发送至云端）" : "同意将本次所选资料发送到已配置的 AgentArts 应用"}</span>
          </label>}
          <button className="button primary" type="submit" disabled={busy || active || !config || intakeInvalid || (configured && (!authorized || config.remainingCalls < 1))}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}
            {configured ? fixture ? "运行本地协议测试" : "提交云端分析" : "保存分析请求"}
          </button>
          {active && <p className="cloud-help">工作区已有分析正在运行。请等待结果或在对应记录中停止本地等待。</p>}
          {configured && config.remainingCalls < 1 && <p className="cloud-warning">工作区调用上限已用完，不能继续发送。请先核对实际用量与预算。</p>}
          <p className="cloud-help">每次提交固定当前资料版本；候选内容需要你核对并确认后才会加入项目。</p>
        </form>
        <div className="cloud-results" aria-busy={busy}>
          <div className="cloud-result-heading"><h3 tabIndex={-1} ref={resultHeading}>云端分析记录</h3><div className="cloud-record-tools"><span className="badge badge-neutral">{runs.length} 次记录</span><button type="button" className="text-button" disabled={busy} onClick={() => void refreshRecords()}>刷新云端记录</button></div></div>
          {runs.length > 0 && <div className="field">
            <label htmlFor="cloud-history"><History size={14} /> 查看云端分析记录</label>
            <select id="cloud-history" value={runId} disabled={busy} onChange={(event) => chooseRun(event.target.value)}>
              {[...runs].reverse().map((entry) => <option key={entry.id} value={entry.id}>{dateLabel(entry.createdAt)} · {statusNames[entry.status]} · {entry.provider === "contract-test" ? "本地协议测试" : "AgentArts"} · {entry.request.question.slice(0, 50)}</option>)}
            </select>
          </div>}
          {error && <div className="cloud-warning" role="alert"><TriangleAlert size={17} /><p>{error}</p></div>}
          {notice && <div className="cloud-notice" role="status"><CheckCircle2 size={17} /><p>{notice}</p></div>}
          {pollError && <p className="cloud-warning" role="status">{pollError}</p>}
          {!run ? <div className="cloud-empty"><FileText size={26} /><strong>运行与依据会留在同一份记录中</strong><p>尚未配置时可以先保存请求，不产生模型调用。记录固定资料版本，便于之后核对。</p></div> : <>
            <div className="cloud-run-status"><span className="badge badge-blue">{statusNames[run.status]}</span><span>{run.provider === "contract-test" ? "本地协议测试 · 合成结果" : "AgentArts 运行记录"}</span></div>
            <p className="cloud-run-question">{run.request.question}</p>
            {run.provider === "contract-test" && <p className="cloud-warning">此记录来自本地合成协议测试，不能证明 AgentArts 已接通或分析结论正确。</p>}
            {obsolete && <div className="cloud-warning"><TriangleAlert size={17} /><p>资料已更新。这份记录保留原版依据，请使用当前资料重新分析后再确认。</p></div>}
            {run.error && <p className="cloud-warning">{run.error.message}<small>错误标识：{run.error.code}</small></p>}
            {isActive(run) && <div className="cloud-running" role="status"><LoaderCircle size={18} className="spin" /><p>{run.status === "queued" ? "请求已保存，等待服务执行。" : "正在等待分析服务返回，不代表结果已通过核对。"}</p><button type="button" className="text-button" disabled={busy} onClick={() => void interrupt()}>停止本地等待</button><small>不能保证云端执行或计费立即停止。</small></div>}
            {run.proposal && <div className="cloud-proposal">
              <p className="cloud-summary">{run.proposal.summary}</p>
              {run.status === "needs_input" && <div className="cloud-questions"><h4>请先补充这些信息</h4><ul>{run.proposal.questions.map((entry, index) => <li key={index}>{entry}</li>)}</ul><p>补充问题后创建新的分析记录，不会自动继续调用。</p></div>}
              {run.proposal.claims.length > 0 && <div className="cloud-candidates"><h4>候选结论 <small>先核对原文，再选择</small></h4>{run.proposal.claims.map((candidate) => <article className="cloud-candidate" key={candidate.id}>
                <label className="cloud-choice"><input type="checkbox" aria-label={`选择云端结论 ${candidate.id}`} checked={selectedClaims.includes(candidate.id) || !!run.acceptance?.claims.some((entry) => entry.candidateId === candidate.id)} disabled={selectionLocked} onChange={(event) => toggleClaim(candidate.id, event.target.checked)} /><span>{candidate.text}</span></label>
                {candidate.evidenceIds.map((id) => {
                  const evidence = run.snapshot.evidence.find((entry) => entry.id === id)!;
                  const ref = run.snapshot.sourceRevisions.find((entry) => entry.sourceId === evidence.sourceId)!;
                  return <div className="cloud-evidence" key={id}><blockquote>{evidence.quote}</blockquote><button type="button" className="text-button" onClick={() => onEvidence(evidence.sourceId, evidence.versionId, { agentRunId: run.id, agentCandidateId: candidate.id, evidenceId: id, locator: evidence.locator })}><FileText size={14} /><span>{ref.title} · {evidence.locator}</span><ArrowRight size={13} /></button></div>;
                })}
              </article>)}</div>}
              {run.proposal.gaps.length > 0 && <div className="cloud-gaps"><h4>资料缺口与限制</h4><ul>{run.proposal.gaps.map((entry, index) => <li key={index}>{entry}</li>)}</ul></div>}
              {run.proposal.tasks.length > 0 && <div className="cloud-candidates"><h4>建议行动 <small>选择行动会同时选中它依赖的结论</small></h4>{run.proposal.tasks.map((candidate) => <label className="cloud-choice cloud-task" key={candidate.id}><input type="checkbox" aria-label={`选择云端行动 ${candidate.id}`} checked={selectedTasks.includes(candidate.id) || !!run.acceptance?.tasks.some((entry) => entry.candidateId === candidate.id)} disabled={selectionLocked} onChange={(event) => toggleTask(candidate.id, event.target.checked)} /><span>{candidate.title}<small>{candidate.claimIds.length ? `关联 ${candidate.claimIds.length} 条候选结论` : "补充资料行动，尚无关联结论"}</small></span></label>)}</div>}
              {run.status === "proposal" && <div className="cloud-accept"><label className="cloud-consent"><input type="checkbox" checked={acknowledged} disabled={selectionLocked || (!selectedClaims.length && !selectedTasks.length)} onChange={(event) => setAcknowledged(event.target.checked)} /><span>我已核对原文，理解引用校验不代表结论正确</span></label><p className="cloud-help">已选 {selectedClaims.length} 条结论 · {selectedTasks.length} 项行动</p><button className="button primary" type="button" disabled={selectionLocked || !acknowledged || (!selectedClaims.length && !selectedTasks.length)} onClick={() => void accept()}>确认保存云端所选内容</button></div>}
            </div>}
            {run.status === "accepted" && <div className="cloud-notice"><CheckCircle2 size={17} /><p>已保存 {run.acceptance?.claims.length ?? 0} 条结论、{run.acceptance?.tasks.length ?? 0} 项行动；本次提案已锁定，不会重复写入。</p></div>}
            {!isActive(run) && run.status !== "accepted" && <button type="button" className="text-button" disabled={busy} onClick={prepareAgain}>{run.status === "needs_input" ? "带回问题，补充后重新提交" : "用当前资料准备重新分析"}<ArrowRight size={14} /></button>}
            <details className="cloud-trace"><summary>运行记录与固定资料版本</summary><dl><dt>提供方</dt><dd>{run.provider === "contract-test" ? "本地协议测试 · 合成结果" : "AgentArts（结果仍须人工核对）"}</dd><dt>运行编号</dt><dd><code>{run.id}</code></dd><dt>资料快照</dt><dd><code>{run.snapshot.contextHash}</code></dd>{run.invocation && <><dt>应用运行名称</dt><dd>{run.invocation.runtimeName}</dd><dt>应用版本标签</dt><dd>{run.invocation.applicationVersion ?? "未声明；不能据此判断实际平台版本"}</dd><dt>请求编号</dt><dd><code>{run.invocation.requestId}</code></dd><dt>会话编号</dt><dd><code>{run.invocation.sessionId}</code></dd><dt>平台请求编号</dt><dd><code>{run.invocation.platformRequestId ?? "平台未返回"}</code></dd></>}</dl><h4>本次资料</h4>{run.snapshot.sourceRevisions.map((entry) => <p key={entry.sourceId}>{entry.title} · 固定版本 <code>{entry.versionId}</code></p>)}<h4>状态记录（北京时间）</h4><ol>{run.events.map((entry, index) => <li key={index}><time dateTime={entry.at}>{dateLabel(entry.at)}</time><span>{statusNames[entry.status]} · {entry.message}</span></li>)}</ol></details>
          </>}
        </div>
      </div>
    </section>
  );
}
