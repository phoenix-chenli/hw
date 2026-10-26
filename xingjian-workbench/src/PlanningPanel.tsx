import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  Clock3,
  LoaderCircle,
  Plus,
  TriangleAlert,
} from "lucide-react";
import type {
  Command,
  CommandType,
  PlanBlock,
  PlanPreview,
  PlanRequest,
  Project,
  WorkPlan,
  Workspace,
} from "../shared/contracts";
import {
  ApiError,
  getWorkspace,
  makeCommand,
  previewPlan,
  submitCommand,
} from "./api";
import { useSessionDraft } from "./session-drafts";

type PlanDraft = Omit<PlanRequest, "allowDuringClass">;
interface SlotDraft {
  title: string;
  kind: "class" | "busy";
  date: string;
  startTime: string;
  endTime: string;
}
const draftDate = (value: unknown) =>
  typeof value === "string" &&
  (value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value));
const draftTime = (value: unknown) =>
  typeof value === "string" &&
  (value === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));
function validPlanDraft(value: unknown): value is PlanDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as PlanDraft;
  return (
    draftDate(draft.date) && draftTime(draft.startTime) && draftTime(draft.endTime) &&
    Array.isArray(draft.items) && draft.items.length <= 12 &&
    draft.items.every((item) =>
      item && typeof item.taskId === "string" &&
      item.taskId.length > 0 && item.taskId.length <= 200 &&
      Number.isFinite(item.durationMinutes) && Math.abs(item.durationMinutes) <= 10000,
    ) &&
    new Set(draft.items.map((item) => item.taskId)).size === draft.items.length
  );
}
function validSlotDraft(value: unknown): value is SlotDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as SlotDraft;
  return (
    typeof draft.title === "string" && draft.title.length <= 120 &&
    (draft.kind === "class" || draft.kind === "busy") && draftDate(draft.date) &&
    draftTime(draft.startTime) && draftTime(draft.endTime)
  );
}

const shanghaiDate = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
};
const versionOf = (task: Project["tasks"][number]) =>
  task.revisions?.at(-1)?.number ?? 1;
function planWarning(
  project: Project,
  block: PlanBlock,
  plan: WorkPlan,
  workspace: Workspace,
) {
  const task = project.tasks.find((item) => item.id === block.taskId);
  if (!task) return "关联行动已无法读取，请重新安排。";
  if (task.reviewRequired) return "关联行动待复核，原计划仍保留。";
  if (
    block.sourceVersions.some(
      (ref) =>
        project.sources.find((source) => source.id === ref.sourceId)
          ?.currentVersionId !== ref.versionId,
    )
  )
    return "资料已有新版本，请核对这段安排。";
  if (versionOf(task) !== block.taskVersion)
    return "行动内容已更新，请核对这段安排。";
  if ((task.checkpoints?.at(-1)?.number ?? 0) !== block.checkpointNumber)
    return "继续点已更新，请核对是否仍需这段时间。";
  if (task.status === "done") return "行动已完成，可取消不再需要的安排。";
  let legacyOverlapUnverified = false;
  const conflictingSlots = workspace.projects
    .filter((item) => item.ownerId === project.ownerId)
    .flatMap((item) =>
      (item.busySlots ?? []).map((slot) => ({
        ...slot, projectId: item.id, projectTitle: item.title,
      })),
    )
    .filter(
      (slot) =>
        slot.active &&
        slot.date === plan.request.date &&
        slot.startTime < block.endTime &&
        block.startTime < slot.endTime,
    )
    .filter((slot) => {
      if (slot.kind === "busy" || !plan.request.allowDuringClass) return true;
      const sameCourse = (prior: PlanBlock["classConflicts"][number]) =>
        prior.title === slot.title && prior.startTime === slot.startTime &&
        prior.endTime === slot.endTime;
      const identified = block.classConflicts.find((prior) =>
        prior.projectId === slot.projectId && prior.slotId === slot.id);
      if (identified) return !sameCourse(identified);
      const legacy = block.classConflicts.filter((prior) =>
        prior.projectId === undefined && prior.slotId === undefined);
      if (legacy.some((prior) =>
        sameCourse(prior) && prior.projectTitle === slot.projectTitle)) return false;
      if (legacy.length) {
        // Old snapshots cannot prove which current slot the user acknowledged.
        legacyOverlapUnverified = true;
        return false;
      }
      return true;
    });
  if (conflictingSlots.length)
    return `当前已录入时段与原安排冲突（${conflictingSlots.map((slot) => slot.title).join("、")}），请取消后重新预览。`;
  if (legacyOverlapUnverified)
    return "旧计划未记录完整课程标识，当前重叠需重新核对。原安排与历史提醒仍保留。";
  return "";
}

export default function PlanningPanel({
  project,
  workspace,
  onWorkspace,
  onNotice,
}: {
  project: Project;
  workspace: Workspace;
  onWorkspace: (state: Workspace) => void;
  onNotice: (message: string) => void;
}) {
  const prefix = useId();
  const draft = useSessionDraft<PlanDraft>(
    `planning:${project.id}`,
    () => ({
      date: shanghaiDate(), startTime: "19:00", endTime: "21:00", items: [],
    }),
    validPlanDraft,
  );
  const { date, startTime, endTime, items } = draft.value;
  function setPlanField<K extends keyof PlanDraft>(
    key: K,
    value: SetStateAction<PlanDraft[K]>,
  ) {
    draft.setValue((previous) => ({
      ...previous,
      [key]: typeof value === "function" ? value(previous[key]) : value,
    }));
  }
  const setDate = (value: string) => setPlanField("date", value);
  const setStartTime = (value: string) => setPlanField("startTime", value);
  const setEndTime = (value: string) => setPlanField("endTime", value);
  const setItems = (value: SetStateAction<PlanRequest["items"]>) =>
    setPlanField("items", value);
  const [allowDuringClass, setAllowDuringClass] = useState(false);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const slotDraft = useSessionDraft<SlotDraft>(
    `planning-slot:${project.id}`,
    () => ({
      title: "", kind: "class", date: shanghaiDate(),
      startTime: "18:30", endTime: "20:00",
    }),
    validSlotDraft,
  );
  const {
    title: slotTitle, kind: slotKind, date: slotDate,
    startTime: slotStart, endTime: slotEnd,
  } = slotDraft.value;
  function setSlotField<K extends keyof SlotDraft>(key: K, value: SlotDraft[K]) {
    slotDraft.setValue((previous) => ({ ...previous, [key]: value }));
  }
  const setSlotTitle = (value: string) => setSlotField("title", value);
  const setSlotKind = (value: SlotDraft["kind"]) => setSlotField("kind", value);
  const setSlotDate = (value: string) => setSlotField("date", value);
  const setSlotStart = (value: string) => setSlotField("startTime", value);
  const setSlotEnd = (value: string) => setSlotField("endTime", value);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const pending = useRef<Command | null>(null);
  const previewHead = useRef<HTMLHeadingElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const request: PlanRequest = {
    date,
    startTime,
    endTime,
    items,
    allowDuringClass,
  };
  const disabled = !!working;
  const hasOverlap = !!preview?.blocks.some(
    (block) => block.classConflicts.length,
  );
  const plans = [...(project.plans ?? [])].reverse();
  const activePlans = plans.filter((plan) => plan.status === "confirmed");
  const cancelledPlans = plans.filter((plan) => plan.status === "cancelled");
  const slots = [...(project.busySlots ?? [])]
    .filter((slot) => slot.active)
    .sort((a, b) =>
      `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`),
    );

  function invalidate() {
    setPreview(null);
    setAcknowledged(false);
    setStale(false);
    setError("");
    pending.current = null;
  }
  function changeSlot() {
    setError("");
    if (pending.current?.type === "add_busy_slot") pending.current = null;
  }
  function showError(message: string) {
    setError(message);
    requestAnimationFrame(() => errorBox.current?.focus());
  }
  async function refreshAfterConflict(err: unknown) {
    let message = err instanceof Error ? err.message : "暂时无法保存，请重试。";
    if (err instanceof ApiError && err.status === 409) {
      pending.current = null;
      setStale(true);
      setAcknowledged(false);
      try {
        onWorkspace(await getWorkspace());
        message +=
          " 填写已保留。计划需重新预览；时间占用操作可检查最新列表后重试。";
      } catch {
        message += " 暂时无法读取最新状态。请恢复本地服务后重新预览。";
      }
    } else if (!(err instanceof ApiError)) {
      message =
        "连接中断，填写已保留。请重试原操作，将使用同一个保存编号，避免重复写入。";
    }
    showError(message);
  }
  async function mutate(
    type: CommandType,
    payload: Record<string, unknown>,
    action: string,
    success: string,
    after?: () => void,
  ) {
    if (disabled) return;
    setWorking(action);
    setError("");
    const previous = pending.current;
    const command =
      previous &&
      previous.type === type &&
      JSON.stringify(previous.payload) === JSON.stringify(payload)
        ? previous
        : makeCommand(type, payload, workspace.revision);
    pending.current = command;
    try {
      const response = await submitCommand(command);
      pending.current = null;
      if (type === "confirm_plan") draft.clear();
      onWorkspace(response.state);
      setPreview(null);
      setAcknowledged(false);
      setStale(false);
      onNotice(success);
      after?.();
    } catch (err) {
      await refreshAfterConflict(err);
    } finally {
      setWorking("");
    }
  }
  async function showPreview(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!items.length) {
      showError("请先选至少一项行动，再查看安排。 ");
      return;
    }
    setWorking("preview");
    setError("");
    setPreview(null);
    setAcknowledged(false);
    pending.current = null;
    try {
      if (stale) onWorkspace(await getWorkspace());
      const result = await previewPlan(project.id, request);
      setPreview(result);
      setStale(false);
      requestAnimationFrame(() => previewHead.current?.focus());
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "暂时无法生成预览，请稍后重试。",
      );
    } finally {
      setWorking("");
    }
  }
  function selectTask(taskId: string, selected: boolean) {
    invalidate();
    setItems((current) =>
      selected
        ? [...current, { taskId, durationMinutes: 30 }]
        : current.filter((item) => item.taskId !== taskId),
    );
  }
  function reorder(index: number, direction: -1 | 1) {
    invalidate();
    setItems((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  }
  function savedPlan(plan: WorkPlan) {
    const isCancelled = plan.status === "cancelled";
    return (
      <article
        className={`planning-saved${isCancelled ? " planning-cancelled" : ""}`}
        key={plan.id}
      >
        <header>
          <div>
            <strong>{plan.request.date}</strong>
            <span>
              {plan.request.startTime}–{plan.request.endTime} · 上海时间
            </span>
          </div>
          <span className="planning-state">
            {isCancelled ? "已取消" : "已确认"}
          </span>
        </header>
        <ol className="planning-timeline">
          {plan.blocks.map((block) => {
            const warning =
              !isCancelled && planWarning(project, block, plan, workspace);
            return (
              <li key={block.taskId}>
                <span className="planning-clock">
                  {block.startTime}
                  <small>{block.endTime}</small>
                </span>
                <div>
                  <h3>{block.title}</h3>
                  <p>
                    {block.durationMinutes} 分钟 · 内容 v{block.taskVersion} ·{" "}
                    {block.checkpointNumber
                      ? `继续点 #${block.checkpointNumber}`
                      : "尚无继续点"}
                  </p>
                  {!!block.classConflicts.length && (
                    <p className="planning-overlap">
                      与课程重叠：
                      {block.classConflicts
                        .map(
                          (slot) =>
                            `${slot.title}（${slot.startTime}–${slot.endTime}）`,
                        )
                        .join("、")}
                    </p>
                  )}
                  {warning && (
                    <p className="planning-warning">
                      <TriangleAlert size={15} aria-hidden="true" />
                      {warning}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {!isCancelled &&
          (cancelId === plan.id ? (
            <div className="planning-cancel-confirm">
              <p>取消后会释放这段时间，保留计划历史和任务进度。</p>
              <div className="planning-inline">
                <button
                  type="button"
                  className="button secondary"
                  disabled={disabled}
                  onClick={() =>
                    void mutate(
                      "cancel_plan",
                      { projectId: project.id, planId: plan.id },
                      `cancel-${plan.id}`,
                      "安排已取消，历史与任务进度已保留。",
                      () => setCancelId(null),
                    )
                  }
                >
                  {working === `cancel-${plan.id}`
                    ? "正在取消…"
                    : "确认取消安排"}
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => setCancelId(null)}
                >
                  保留安排
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={disabled}
              onClick={() => setCancelId(plan.id)}
            >
              取消这份安排
            </button>
          ))}
      </article>
    );
  }

  return (
    <section
      className="planning-panel panel"
      aria-labelledby={`${prefix}-title`}
    >
      <header className="planning-header">
        <div>
          <span className="section-kicker">给下一步留一点时间</span>
          <h2 id={`${prefix}-title`}>安排专注时间</h2>
          <p>按已录入的时间和行动生成本地预览，先看安排，再决定是否保存。</p>
        </div>
        <span className="planning-icon">
          <CalendarDays size={24} aria-hidden="true" />
        </span>
      </header>
      <div className="planning-body">
        {(draft.restored || slotDraft.restored) && (
          <p className="planning-help session-draft-notice" role="status">
            已恢复本项目尚未保存的时间填写；请重新预览安排。课内安排许可和重叠确认需重新选择。
          </p>
        )}
        {error && (
          <div
            className="planning-error"
            role="alert"
            tabIndex={-1}
            ref={errorBox}
          >
            {error}
          </div>
        )}
        <details className="planning-busy">
          <summary>
            上课与忙碌时间{" "}
            <span>
              {slots.length ? `${slots.length} 段已录入` : "还未录入"}
            </span>
          </summary>
          <p className="planning-help">
            填写具体日期的时间占用。安排时也会避开工作区其他项目已确认的计划和忙碌时间。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                "add_busy_slot",
                {
                  projectId: project.id,
                  title: slotTitle,
                  kind: slotKind,
                  date: slotDate,
                  startTime: slotStart,
                  endTime: slotEnd,
                },
                "add-slot",
                "时间占用已保存，下次预览会按最新时间避让。",
                () => {
                  slotDraft.clear({ ...slotDraft.value, title: "" });
                },
              );
            }}
          >
            <fieldset className="planning-fields" disabled={disabled}>
              <div className="planning-slot-name field">
                <label htmlFor={`${prefix}-slot-title`}>课程或事项名称</label>
                <input
                  id={`${prefix}-slot-title`}
                  value={slotTitle}
                  maxLength={120}
                  required
                  placeholder="例如：软件工程课"
                  onChange={(event) => {
                    changeSlot();
                    setSlotTitle(event.target.value);
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor={`${prefix}-slot-kind`}>占用类型</label>
                <select
                  id={`${prefix}-slot-kind`}
                  value={slotKind}
                  onChange={(event) => {
                    changeSlot();
                    setSlotKind(event.target.value as "class" | "busy");
                  }}
                >
                  <option value="class">上课</option>
                  <option value="busy">其他忙碌时间</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${prefix}-slot-date`}>占用日期</label>
                <input
                  type="date"
                  id={`${prefix}-slot-date`}
                  required
                  value={slotDate}
                  onChange={(event) => {
                    changeSlot();
                    setSlotDate(event.target.value);
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor={`${prefix}-slot-start`}>占用开始</label>
                <input
                  type="time"
                  id={`${prefix}-slot-start`}
                  required
                  value={slotStart}
                  onChange={(event) => {
                    changeSlot();
                    setSlotStart(event.target.value);
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor={`${prefix}-slot-end`}>占用结束</label>
                <input
                  type="time"
                  id={`${prefix}-slot-end`}
                  required
                  value={slotEnd}
                  onChange={(event) => {
                    changeSlot();
                    setSlotEnd(event.target.value);
                  }}
                />
              </div>
              <button type="submit" className="button secondary planning-add">
                <Plus size={16} aria-hidden="true" />
                {working === "add-slot" ? "正在保存…" : "保存时间占用"}
              </button>
            </fieldset>
          </form>
          <ul className="planning-slot-list">
            {slots.map((slot) => (
              <li key={slot.id}>
                <div>
                  <strong>{slot.title}</strong>
                  <span>
                    {slot.kind === "class" ? "课程" : "忙碌"} · {slot.date}{" "}
                    {slot.startTime}–{slot.endTime}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  aria-label={`停用时间占用：${slot.title}`}
                  onClick={() =>
                    void mutate(
                      "deactivate_busy_slot",
                      { projectId: project.id, slotId: slot.id },
                      `slot-${slot.id}`,
                      "这段时间已停用，旧安排仍保留，请重新预览需要调整的计划。",
                    )
                  }
                >
                  {working === `slot-${slot.id}` ? "停用中…" : "停用"}
                </button>
              </li>
            ))}
          </ul>
          <p className="planning-help">
            均为上海时间。停用仅影响之后的预览，不会改写已经保存的安排。
          </p>
        </details>
        <form onSubmit={showPreview}>
          <fieldset className="planning-window" disabled={disabled}>
            <legend>准备在哪段时间推进？</legend>
            <div className="field">
              <label htmlFor={`${prefix}-date`}>计划日期</label>
              <input
                type="date"
                id={`${prefix}-date`}
                required
                value={date}
                onChange={(event) => {
                  invalidate();
                  setDate(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${prefix}-start`}>开始时间</label>
              <input
                type="time"
                id={`${prefix}-start`}
                required
                value={startTime}
                onChange={(event) => {
                  invalidate();
                  setStartTime(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${prefix}-end`}>结束时间</label>
              <input
                type="time"
                id={`${prefix}-end`}
                required
                value={endTime}
                onChange={(event) => {
                  invalidate();
                  setEndTime(event.target.value);
                }}
              />
            </div>
          </fieldset>
          <p className="planning-help">
            上海时间（UTC+8），同一天内，时间窗最长 12 小时。
          </p>
          <fieldset className="planning-choices" disabled={disabled}>
            <legend>
              想推进哪些行动？<span>{items.length}/12 项</span>
            </legend>
            {!project.tasks.length && (
              <p className="planning-help">
                先添加一项行动，就可以为它安排时间。
              </p>
            )}
            {project.tasks.map((task) => {
              const index = items.findIndex((item) => item.taskId === task.id);
              const selected = index >= 0;
              return (
                <label
                  key={task.id}
                  className={`planning-choice${selected ? " is-selected" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled || (!selected && items.length >= 12)}
                    onChange={(event) =>
                      selectTask(task.id, event.target.checked)
                    }
                  />
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {task.reviewRequired
                        ? "需先复核，暂不安排"
                        : task.status === "done"
                          ? "已完成，暂不安排"
                          : task.checkpoints?.at(-1)?.nextStep ||
                            "从这项行动开始"}
                    </small>
                  </span>
                  {selected && (
                    <span className="planning-order">{index + 1}</span>
                  )}
                </label>
              );
            })}
          </fieldset>
          {!!items.length && (
            <div className="planning-duration-list">
              <p className="planning-help">
                按下面的顺序寻找可用时间；每项 5–240 分钟，以 5 分钟递增。
              </p>
              {items.map((item, index) => (
                <div className="planning-duration" key={item.taskId}>
                  <span>
                    {index + 1}.{" "}
                    {project.tasks.find((task) => task.id === item.taskId)
                      ?.title ?? "行动已不可用"}
                  </span>
                  <div className="planning-inline">
                    <label
                      htmlFor={`${prefix}-duration-${item.taskId}`}
                      className="planning-sr"
                    >
                      行动 {index + 1} 的预计分钟数
                    </label>
                    <input
                      id={`${prefix}-duration-${item.taskId}`}
                      aria-label={`预计分钟数：${project.tasks.find((task) => task.id === item.taskId)?.title ?? item.taskId}`}
                      type="number"
                      inputMode="numeric"
                      min={5}
                      max={240}
                      step={5}
                      required
                      disabled={disabled}
                      value={item.durationMinutes || ""}
                      onChange={(event) => {
                        invalidate();
                        setItems((current) =>
                          current.map((candidate) =>
                            candidate.taskId === item.taskId
                              ? {
                                  ...candidate,
                                  durationMinutes: Number(event.target.value),
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                    <span>分钟</span>
                    <button
                      type="button"
                      className="planning-move"
                      aria-label={`上移行动 ${index + 1}`}
                      disabled={disabled || index === 0}
                      onClick={() => reorder(index, -1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="planning-move"
                      aria-label={`下移行动 ${index + 1}`}
                      disabled={disabled || index === items.length - 1}
                      onClick={() => reorder(index, 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <label className="planning-check">
            <input
              type="checkbox"
              checked={allowDuringClass}
              disabled={disabled}
              onChange={(event) => {
                invalidate();
                setAllowDuringClass(event.target.checked);
              }}
            />
            <span>
              <strong>允许安排在上课期间</strong>
              <small>
                仅适合你认为可同时完成的行动；会单独提醒重叠课程，其他忙碌时间仍会避开。
              </small>
            </span>
          </label>
          <div className="planning-preview-action">
            <button
              className="button primary"
              type="submit"
              disabled={disabled || !items.length}
            >
              {working === "preview" ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : (
                <Clock3 size={17} aria-hidden="true" />
              )}
              {working === "preview"
                ? "正在查看空闲…"
                : stale
                  ? "重新预览安排"
                  : "预览时间安排"}
            </button>
            <small>预览不会修改行动进度。</small>
          </div>
        </form>
        {preview && (
          <section
            className="planning-preview"
            aria-labelledby={`${prefix}-preview`}
          >
            <h3 id={`${prefix}-preview`} ref={previewHead} tabIndex={-1}>
              {preview.blocks.length
                ? `找到 ${preview.blocks.length} 段可用时间`
                : "这次还没有合适的时间"}
            </h3>
            <p className="planning-help">
              {preview.request.date} · 上海时间 · 确认后才会保存
            </p>
            {stale && (
              <p className="planning-warning">
                <TriangleAlert size={16} aria-hidden="true" />
                依据已变化，请保留填写并重新预览。
              </p>
            )}
            <ol className="planning-timeline">
              {preview.blocks.map((block) => (
                <li key={block.taskId}>
                  <span className="planning-clock">
                    {block.startTime}
                    <small>{block.endTime}</small>
                  </span>
                  <div>
                    <h3>{block.title}</h3>
                    <p>{block.durationMinutes} 分钟</p>
                    {block.classConflicts.map((slot, index) => (
                      <p
                        key={`${slot.title}-${index}`}
                        className="planning-warning"
                      >
                        <TriangleAlert size={15} aria-hidden="true" />
                        <span>
                          与「{slot.title}」{slot.startTime}–{slot.endTime} 重叠
                          {slot.projectTitle !== project.title
                            ? `（${slot.projectTitle}）`
                            : ""}
                        </span>
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
            {!!preview.unplaced.length && (
              <div className="planning-unplaced">
                <strong>暂未安排</strong>
                <ul>
                  {preview.unplaced.map((item) => (
                    <li key={item.taskId}>
                      <span>{item.title}</span>
                      <small>{item.reason}</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasOverlap && (
              <label className="planning-check planning-ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={disabled || stale}
                  onChange={(event) => {
                    pending.current = null;
                    setAcknowledged(event.target.checked);
                  }}
                />
                <span>我已查看重叠课程，确认这些行动可以在上课期间完成。</span>
              </label>
            )}
            {!!preview.blocks.length && (
              <button
                type="button"
                className="button primary"
                disabled={disabled || stale || (hasOverlap && !acknowledged)}
                onClick={() =>
                  void mutate(
                    "confirm_plan",
                    {
                      projectId: project.id,
                      request: preview.request,
                      previewToken: preview.previewToken,
                      acknowledgeClassOverlap: acknowledged,
                    },
                    "confirm",
                    "时间安排已保存。行动进度和继续点保持不变。",
                  )
                }
              >
                {working === "confirm" ? (
                  <LoaderCircle className="spin" size={16} aria-hidden="true" />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                {working === "confirm" ? "正在保存…" : "确认保存安排"}
              </button>
            )}
          </section>
        )}
        <section
          className="planning-history"
          aria-labelledby={`${prefix}-saved`}
        >
          <header>
            <h3 id={`${prefix}-saved`}>已保存的安排</h3>
            <span>{activePlans.length} 份生效</span>
          </header>
          {!activePlans.length && (
            <p className="planning-help">
              确认后的安排会出现在这里，下次打开仍能继续查看。
            </p>
          )}
          {activePlans.map(savedPlan)}
          {!!cancelledPlans.length && (
            <details className="planning-cancelled-history">
              <summary>查看已取消的安排（{cancelledPlans.length}）</summary>
              {cancelledPlans.map(savedPlan)}
            </details>
          )}
        </section>
      </div>
    </section>
  );
}
