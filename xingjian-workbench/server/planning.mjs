import { createHash } from "node:crypto";
import { contentVersion } from "./review.mjs";

export class PlanningError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
    this.status = status;
  }
}
const fail = (message, code = "INVALID_PLAN", status = 400) => {
  throw new PlanningError(code, message, status);
};
const object = (value, label) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(`${label}格式无效。`);
  return value;
};
function text(value, label, max, optional = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!optional && !value.trim())
  )
    fail(`${label}${optional ? "" : "不能为空，且"}不能超过 ${max} 个字符。`);
  return value.trim();
}
function identifier(value, label) {
  if (text(value, label, 160) !== value) fail(`${label}不能有首尾空白。`);
  return value;
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(`${label}无效。`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label}必须是布尔值。`);
  return value;
}
function array(value, label, max) {
  if (!Array.isArray(value) || (max !== undefined && value.length > max))
    fail(`${label}格式或数量无效。`);
  return value;
}
function stamp(value) {
  if (typeof value !== "string") fail("记录时间无效。");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    fail("记录时间必须是有效的 UTC 时间。");
}
function date(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
    fail("日期应为有效的 YYYY-MM-DD 日期。");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    fail("日期不是有效的日历日期。");
  return value;
}
function minutes(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    fail("时间应使用 HH:mm 格式。");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
function time(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function range(startTime, endTime, limit = 1440) {
  const start = minutes(startTime),
    end = minutes(endTime);
  if (start >= end || end - start > limit)
    fail(
      `时间范围必须在同一天，结束晚于开始${limit === 720 ? "，且不超过 12 小时" : ""}。`,
    );
  return { start, end };
}
function taskById(project, taskId) {
  identifier(taskId, "任务 ID");
  const task = project.tasks.find((entry) => entry.id === taskId);
  if (!task) fail("任务不存在或不属于此项目。", "NOT_FOUND", 404);
  return task;
}
function reference(project, value) {
  object(value, "资料关联");
  const sourceId = identifier(value.sourceId, "资料 ID");
  const versionId = identifier(value.versionId, "资料版本 ID");
  if (
    !project.sources
      .find((entry) => entry.id === sourceId)
      ?.versions.some((entry) => entry.id === versionId)
  )
    fail("继续点或计划只能引用本项目保留的资料版本。");
  return { sourceId, versionId };
}
function checkpointFields(project, payload) {
  return {
    doneNote: text(payload.doneNote, "已完成内容", 2000, true),
    nextStep: text(payload.nextStep, "下次从哪里继续", 1000),
    blocker: text(payload.blocker, "当前障碍", 1000, true),
    evidence:
      payload.evidence === null ? null : reference(project, payload.evidence),
  };
}
function normalizeRequest(project, input) {
  object(input, "计划请求");
  const normalized = {
    date: date(input.date),
    startTime: input.startTime,
    endTime: input.endTime,
    items: array(input.items, "计划任务", 12).map((item) => {
      object(item, "计划任务");
      const task = taskById(project, item.taskId);
      const durationMinutes = integer(item.durationMinutes, "任务时长", 5, 240);
      if (durationMinutes % 5 !== 0) fail("任务时长须为 5 分钟的整数倍。");
      return { taskId: task.id, durationMinutes };
    }),
    allowDuringClass: boolean(input.allowDuringClass, "允许课中安排"),
  };
  range(normalized.startTime, normalized.endTime, 720);
  if (!normalized.items.length) fail("请至少选择一项任务。");
  if (
    new Set(normalized.items.map((item) => item.taskId)).size !==
    normalized.items.length
  )
    fail("同一计划不能重复选择任务。");
  return normalized;
}

function latestSourceVersions(project, task) {
  const sourceIds = new Set(
    task.claimIds.flatMap((id) =>
      project.claims
        .find((claim) => claim.id === id)
        .evidence.map((ref) => ref.sourceId),
    ),
  );
  const checkpointEvidence = task.checkpoints?.at(-1)?.evidence;
  if (checkpointEvidence) sourceIds.add(checkpointEvidence.sourceId);
  return [...sourceIds]
    .sort()
    .map((sourceId) => ({
      sourceId,
      versionId: project.sources.find((source) => source.id === sourceId)
        .currentVersionId,
    }));
}
function taskBasis(project, task) {
  return {
    id: task.id,
    title: task.title,
    taskVersion: contentVersion(task),
    status: task.status,
    reviewRequired: task.reviewRequired,
    checkpoint: task.checkpoints?.at(-1) ?? null,
    claims: task.claimIds.map((claimId) => {
      const claim = project.claims.find((entry) => entry.id === claimId);
      return {
        id: claimId,
        version: contentVersion(claim),
        text: claim.text,
        status: claim.status,
        evidence: claim.evidence,
      };
    }),
    sourceVersions: latestSourceVersions(project, task),
  };
}
function calendarFor(state, project, day) {
  const busySlots = [],
    plans = [];
  for (const other of state.projects.filter(
    (entry) => entry.ownerId === project.ownerId,
  )) {
    for (const slot of other.busySlots ?? [])
      if (slot.active && slot.date === day)
        busySlots.push({
          projectId: other.id,
          projectTitle: other.title,
          ...slot,
        });
    for (const plan of other.plans ?? [])
      if (plan.status === "confirmed" && plan.request.date === day)
        plans.push({
          projectId: other.id,
          planId: plan.id,
          blocks: plan.blocks.map((block) => ({
            taskId: block.taskId,
            startTime: block.startTime,
            endTime: block.endTime,
          })),
        });
  }
  // Sorting makes the token independent of incidental collection iteration order.
  busySlots.sort((a, b) => a.id.localeCompare(b.id));
  plans.sort((a, b) => a.planId.localeCompare(b.planId));
  return { busySlots, plans };
}
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
function firstFit(window, duration, obstacles) {
  let start = window.start;
  for (const obstacle of [...obstacles].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (obstacle.end <= start || obstacle.start >= window.end) continue;
    if (start + duration <= obstacle.start) return start;
    start = Math.max(start, obstacle.end);
    if (start + duration > window.end) return null;
  }
  return start + duration <= window.end ? start : null;
}

/** Pure local scheduling: uses only explicit same-owner dated obstacles. */
export function buildPlanPreview(state, project, input) {
  const request = normalizeRequest(project, input);
  const window = range(request.startTime, request.endTime, 720);
  const calendar = calendarFor(state, project, request.date);
  const basis = request.items.map((item) =>
    taskBasis(project, taskById(project, item.taskId)),
  );
  const obstacles = calendar.busySlots
    .filter((slot) => slot.kind === "busy" || !request.allowDuringClass)
    .map((slot) => range(slot.startTime, slot.endTime));
  for (const plan of calendar.plans)
    obstacles.push(
      ...plan.blocks.map((block) => range(block.startTime, block.endTime)),
    );
  const blocks = [],
    unplaced = [];
  for (const [index, item] of request.items.entries()) {
    const task = taskById(project, item.taskId);
    let reason;
    if (task.status === "done")
      reason = task.reviewRequired
        ? "任务已完成且关联依据待复核；如需继续，请先核对内容并明确调整任务进度。"
        : "任务已完成；如需继续，请先明确调整任务进度。";
    else if (task.reviewRequired)
      reason = "关联依据有变化，请先完成任务复核再安排时间。";
    else if (
      task.claimIds.some(
        (id) =>
          project.claims.find((claim) => claim.id === id).status ===
          "needs_review",
      )
    )
      reason = "关联结论待复核，暂不安排。";
    const start = reason
      ? null
      : firstFit(window, item.durationMinutes, obstacles);
    if (start === null) {
      unplaced.push({
        taskId: task.id,
        title: task.title,
        reason:
          reason ??
          "所选时段没有足够的连续空闲时间；可缩短时长或调整时间范围。",
      });
      continue;
    }
    const end = start + item.durationMinutes;
    blocks.push({
      taskId: task.id,
      title: task.title,
      taskVersion: basis[index].taskVersion,
      checkpointNumber: task.checkpoints?.at(-1)?.number ?? 0,
      sourceVersions: basis[index].sourceVersions,
      startTime: time(start),
      endTime: time(end),
      durationMinutes: item.durationMinutes,
      classConflicts: calendar.busySlots
        .filter(
          (slot) =>
            slot.kind === "class" &&
            overlaps({ start, end }, range(slot.startTime, slot.endTime)),
        )
        .map((slot) => ({
          projectId: slot.projectId,
          slotId: slot.id,
          title: slot.title,
          projectTitle: slot.projectTitle,
          startTime: slot.startTime,
          endTime: slot.endTime,
        })),
    });
    obstacles.push({ start, end });
  }
  const previewToken = createHash("sha256")
    .update(
      JSON.stringify({
        engine: "local-first-fit-v1",
        projectId: project.id,
        ownerId: project.ownerId,
        request,
        basis,
        calendar,
      }),
    )
    .digest("hex");
  return {
    projectId: project.id,
    request,
    timezone: "Asia/Shanghai",
    previewToken,
    blocks,
    unplaced,
  };
}

/** Historical snapshots remain valid after current task/source state changes. */
export function validatePlanningState(project, register) {
  for (const task of project.tasks) {
    const checkpoints = array(task.checkpoints ?? [], "任务继续点", 100);
    let lastTime,
      lastVersion = 0;
    for (const [index, checkpoint] of checkpoints.entries()) {
      object(checkpoint, "任务继续点");
      if (checkpoint.number !== index + 1) fail("继续点编号必须连续递增。");
      stamp(checkpoint.recordedAt);
      if (lastTime && checkpoint.recordedAt < lastTime)
        fail("继续点记录时间不能倒退。");
      lastTime = checkpoint.recordedAt;
      integer(
        checkpoint.taskVersion,
        "继续点对应任务版本",
        1,
        contentVersion(task),
      );
      if (checkpoint.taskVersion < lastVersion)
        fail("继续点对应任务版本不能倒退。");
      lastVersion = checkpoint.taskVersion;
      checkpointFields(project, checkpoint);
    }
  }
  for (const slot of array(project.busySlots ?? [], "不可用时段", 200)) {
    object(slot, "不可用时段");
    register(slot.id, "时段 ID");
    text(slot.title, "时段标题", 120);
    if (!["class", "busy"].includes(slot.kind)) fail("时段类型无效。");
    date(slot.date);
    range(slot.startTime, slot.endTime);
    boolean(slot.active, "时段有效标记");
    stamp(slot.createdAt);
  }
  for (const plan of array(project.plans ?? [], "时间计划", 100)) {
    object(plan, "时间计划");
    register(plan.id, "计划 ID");
    stamp(plan.createdAt);
    if (
      plan.projectId !== project.id ||
      plan.timezone !== "Asia/Shanghai" ||
      !["confirmed", "cancelled"].includes(plan.status)
    )
      fail("计划归属、时区或状态无效。");
    if (
      typeof plan.previewToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(plan.previewToken)
    )
      fail("计划依据快照无效。");
    const request = normalizeRequest(project, plan.request);
    const window = range(request.startTime, request.endTime, 720);
    const blocks = array(plan.blocks, "计划时间块", 12),
      unplaced = array(plan.unplaced, "未安排任务", 12);
    if (!blocks.length) fail("已保存的计划至少需要一个时间块。");
    const seen = new Set(),
      occupied = [];
    for (const block of blocks) {
      object(block, "计划时间块");
      const task = taskById(project, block.taskId);
      const item = request.items.find((entry) => entry.taskId === task.id);
      if (!item || seen.has(task.id))
        fail("计划时间块必须来自不重复的所选任务。");
      seen.add(task.id);
      text(block.title, "计划任务标题", 120);
      integer(block.taskVersion, "计划任务版本", 1, contentVersion(task));
      integer(
        block.checkpointNumber,
        "计划继续点编号",
        0,
        task.checkpoints?.length ?? 0,
      );
      if (
        block.checkpointNumber > 0 &&
        task.checkpoints[block.checkpointNumber - 1].taskVersion >
          block.taskVersion
      )
        fail("计划继续点不能来自较新的任务内容版本。");
      const refs = array(block.sourceVersions, "计划资料版本");
      const sourceIds = new Set();
      for (const ref of refs) {
        const value = reference(project, ref);
        if (sourceIds.has(value.sourceId)) fail("计划资料版本不能重复。");
        sourceIds.add(value.sourceId);
      }
      const period = range(block.startTime, block.endTime);
      if (
        period.start < window.start ||
        period.end > window.end ||
        period.end - period.start !== item.durationMinutes ||
        block.durationMinutes !== item.durationMinutes
      )
        fail("计划时间块与所选时长或范围不一致。");
      if (occupied.some((prior) => overlaps(prior, period)))
        fail("同一计划内的时间块不能重叠。");
      occupied.push(period);
      const conflicts = array(block.classConflicts, "课中安排提醒");
      if (!request.allowDuringClass && conflicts.length)
        fail("未允许课中安排的计划不能记录课程重叠。");
      for (const conflict of conflicts) {
        object(conflict, "课程重叠");
        if ("projectId" in conflict || "slotId" in conflict) {
          identifier(conflict.projectId, "课程所在项目 ID");
          identifier(conflict.slotId, "课程占用 ID");
        }
        text(conflict.title, "课程名称", 120);
        text(conflict.projectTitle, "课程所在项目", 120);
        if (!overlaps(period, range(conflict.startTime, conflict.endTime)))
          fail("课程重叠提醒必须与时间块确有重叠。");
      }
    }
    for (const item of unplaced) {
      object(item, "未安排任务");
      if (
        !request.items.some((entry) => entry.taskId === item.taskId) ||
        seen.has(item.taskId)
      )
        fail("未安排任务与计划请求不一致。");
      seen.add(item.taskId);
      text(item.title, "未安排任务标题", 120);
      text(item.reason, "未安排原因", 1000);
    }
    if (seen.size !== request.items.length)
      fail("计划必须说明每项任务的安排结果。");
  }
}

export function applyPlanningCommand(state, project, type, payload, ctx) {
  if (type === "save_checkpoint") {
    const task = taskById(project, payload.taskId);
    integer(payload.baseCheckpointNumber, "继续点基准编号");
    if (
      payload.baseCheckpointNumber !== (task.checkpoints?.at(-1)?.number ?? 0)
    )
      fail("继续点已变化，请刷新并核对后再保存。", "CHECKPOINT_CONFLICT", 409);
    if ((task.checkpoints?.length ?? 0) >= 100)
      fail("单项任务最多保留 100 个继续点。", "CHECKPOINT_LIMIT");
    const fields = checkpointFields(project, payload);
    const latest = task.checkpoints?.at(-1);
    if (
      latest &&
      latest.taskVersion === contentVersion(task) &&
      JSON.stringify(checkpointFields(project, latest)) ===
        JSON.stringify(fields)
    )
      fail("继续点内容没有变化。", "NO_CHANGES");
    (task.checkpoints ??= []).push({
      number: payload.baseCheckpointNumber + 1,
      recordedAt: ctx.now,
      taskVersion: contentVersion(task),
      ...fields,
    });
    return {
      entityId: task.id,
      message: `保存任务「${task.title}」第 ${task.checkpoints.length} 个继续点；任务进度与复核提醒保持不变。`,
    };
  }
  if (type === "add_busy_slot") {
    if ((project.busySlots?.length ?? 0) >= 200)
      fail("单个项目最多保留 200 条课程或不可用时段。", "BUSY_SLOT_LIMIT");
    const title = text(payload.title, "时段标题", 120);
    if (!["class", "busy"].includes(payload.kind)) fail("时段类型无效。");
    const day = date(payload.date);
    range(payload.startTime, payload.endTime);
    const slot = {
      id: ctx.id("slot"),
      title,
      kind: payload.kind,
      date: day,
      startTime: payload.startTime,
      endTime: payload.endTime,
      active: true,
      createdAt: ctx.now,
    };
    (project.busySlots ??= []).push(slot);
    return {
      entityId: slot.id,
      message: `记录「${title}」${day} ${slot.startTime}–${slot.endTime}，用于同一工作区的计划避让。`,
    };
  }
  if (type === "deactivate_busy_slot") {
    identifier(payload.slotId, "时段 ID");
    const slot = project.busySlots?.find(
      (entry) => entry.id === payload.slotId,
    );
    if (!slot) fail("时段不存在或不属于此项目。", "NOT_FOUND", 404);
    if (!slot.active) fail("此时段已停用。", "NO_CHANGES");
    slot.active = false;
    return {
      entityId: slot.id,
      message: `停用时段「${slot.title}」；旧记录保留，已有计划快照不会自动改写。`,
    };
  }
  if (type === "confirm_plan") {
    if ((project.plans?.length ?? 0) >= 100)
      fail("单个项目最多保留 100 份时间计划。", "PLAN_LIMIT");
    const preview = buildPlanPreview(state, project, payload.request);
    if (
      typeof payload.previewToken !== "string" ||
      payload.previewToken !== preview.previewToken
    )
      fail("计划依据或可用时间已变化，请重新预览后确认。", "PLAN_STALE", 409);
    boolean(payload.acknowledgeClassOverlap, "课中安排确认");
    if (!preview.blocks.length)
      fail("没有可安排的任务，请调整范围后重新预览。", "EMPTY_PLAN");
    if (
      preview.blocks.some((block) => block.classConflicts.length > 0) &&
      !payload.acknowledgeClassOverlap
    )
      fail(
        "计划包含上课期间的安排，请先确认已知晓课程重叠提醒。",
        "CLASS_OVERLAP_ACK_REQUIRED",
      );
    const plan = {
      id: ctx.id("plan"),
      createdAt: ctx.now,
      status: "confirmed",
      ...preview,
    };
    (project.plans ??= []).push(plan);
    return {
      entityId: plan.id,
      message: `确认 ${preview.request.date} 时间计划，共 ${preview.blocks.length} 个时间块${preview.blocks.some((block) => block.classConflicts.length) ? "；已确认课中安排提醒" : ""}。任务状态保持不变。`,
    };
  }
  if (type === "cancel_plan") {
    identifier(payload.planId, "计划 ID");
    const plan = project.plans?.find((entry) => entry.id === payload.planId);
    if (!plan) fail("计划不存在或不属于此项目。", "NOT_FOUND", 404);
    if (plan.status === "cancelled") fail("此计划已取消。", "NO_CHANGES");
    plan.status = "cancelled";
    return {
      entityId: plan.id,
      message: `取消 ${plan.request.date} 时间计划；保留原时间块和依据快照，释放对应占用时段。`,
    };
  }
  fail("不支持此计划操作。", "UNKNOWN_COMMAND");
}
