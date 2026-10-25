import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request) {
  return (await request.get("/api/state", { headers })).json();
}
async function command(request, type, payload) {
  const current = await state(request);
  const response = await request.post("/api/commands", {
    headers,
    data: {
      type,
      payload,
      expectedRevision: current.revision,
      operationId: randomUUID(),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function setup(page, request) {
  const response = await command(request, "load_demo", {});
  const project = response.state.projects.find(
    (item) => item.id === response.result.projectId,
  );
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page
    .getByRole("button", { name: "行动清单", exact: false })
    .first()
    .click();
  return project;
}
const row = (page, index = 0) => page.locator(".task-row").nth(index);
async function planFields(page, project, date, start = "09:00", end = "11:00") {
  await page.getByLabel("计划日期", { exact: true }).fill(date);
  await page.getByLabel("开始时间", { exact: true }).fill(start);
  await page.getByLabel("结束时间", { exact: true }).fill(end);
  await page
    .locator(".planning-choice")
    .filter({ hasText: project.tasks[1].title })
    .getByRole("checkbox")
    .check();
}
const previewButton = (page) =>
  page.getByRole("button", { name: /^(预览时间安排|重新预览安排)$/ });
const confirmPlanButton = (page) =>
  page.getByRole("button", { name: "确认保存安排", exact: true });

test("class overlap requires opt-in and separate acknowledgement; confirmed plan retries and cancellation preserve work", async ({
  page,
  request,
}) => {
  const project = await setup(page, request);
  await page.locator(".planning-busy > summary").click();
  await page
    .getByLabel("课程或事项名称", { exact: true })
    .fill("示例课程：软件工程");
  await page.getByLabel("占用日期", { exact: true }).fill("2026-11-01");
  await page.getByLabel("占用开始", { exact: true }).fill("09:00");
  await page.getByLabel("占用结束", { exact: true }).fill("10:00");
  await page.getByRole("button", { name: "保存时间占用", exact: true }).click();
  await expect(page.locator(".planning-slot-list")).toContainText("软件工程");
  await planFields(page, project, "2026-11-01");
  await previewButton(page).click();
  await expect(page.locator(".planning-preview .planning-clock")).toContainText(
    "10:00",
  );
  expect(
    (await state(request)).projects.find((p) => p.id === project.id).plans,
  ).toBeUndefined();
  await page.getByRole("checkbox", { name: /允许安排在上课期间/ }).check();
  await expect(page.locator(".planning-preview")).toHaveCount(0);
  await previewButton(page).click();
  await expect(page.locator(".planning-preview .planning-clock")).toContainText(
    "09:00",
  );
  await expect(page.locator(".planning-preview")).toContainText("软件工程");
  await expect(confirmPlanButton(page)).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我已查看重叠课程，确认这些行动可以在上课期间完成。",
      exact: true,
    })
    .check();
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await confirmPlanButton(page).click();
  await expect(page.locator(".planning-error")).toContainText("避免重复写入");
  await confirmPlanButton(page).click();
  await expect(page.locator(".planning-saved")).toHaveCount(1);
  const saved = (await state(request)).projects.find(
    (p) => p.id === project.id,
  );
  expect(saved.plans).toHaveLength(1);
  expect(saved.tasks[1].status).toBe("todo");
  expect(saved.plans[0].blocks[0].classConflicts).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".planning-saved")).toHaveCount(1);
  await expect(page.locator(".planning-saved")).not.toContainText(
    "当前已录入时段与原安排冲突",
  );
  const other = await command(request, "create_project", {
    title: "另一项目的同名课程",
    goal: "新课程也需要重新核对",
    deadline: null,
  });
  await command(request, "add_busy_slot", {
    projectId: other.result.projectId,
    title: "示例课程：软件工程",
    kind: "class",
    date: "2026-11-01",
    startTime: "09:00",
    endTime: "10:00",
  });
  await page.reload();
  await expect(page.locator(".planning-saved")).toContainText(
    "当前已录入时段与原安排冲突",
  );
  expect(
    (await state(request)).projects.find((p) => p.id === project.id).plans[0],
  ).toEqual(saved.plans[0]);
  await page.getByRole("button", { name: "取消这份安排", exact: true }).click();
  await page.getByRole("button", { name: "保留安排", exact: true }).click();
  expect(
    (await state(request)).projects.find((p) => p.id === project.id).plans[0]
      .status,
  ).toBe("confirmed");
  await page.getByRole("button", { name: "取消这份安排", exact: true }).click();
  await page.getByRole("button", { name: "确认取消安排", exact: true }).click();
  await page.locator(".planning-cancelled-history > summary").click();
  await expect(page.locator(".planning-cancelled")).toContainText("已取消");
  await expect(row(page, 1).locator(".status-select")).toHaveValue("todo");
});

test("source changes invalidate a preview, preserve choices and leave reviewed tasks unplaced", async ({
  page,
  request,
}) => {
  const project = await setup(page, request);
  await planFields(page, project, "2026-11-02");
  await previewButton(page).click();
  await expect(confirmPlanButton(page)).toBeEnabled();
  const source = project.sources[0];
  await command(request, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "更新的合成资料，需要重新复核。",
  });
  await confirmPlanButton(page).click();
  await expect(page.locator(".planning-error")).toContainText("填写已保留");
  await expect(confirmPlanButton(page)).toBeDisabled();
  await expect(page.getByLabel("计划日期", { exact: true })).toHaveValue(
    "2026-11-02",
  );
  await previewButton(page).click();
  await expect(page.locator(".planning-preview")).toContainText(
    "请先完成任务复核",
  );
  await expect(confirmPlanButton(page)).toHaveCount(0);
  expect(
    (await state(request)).projects.find((p) => p.id === project.id).plans,
  ).toBeUndefined();
});

test("new calendar conflicts across projects flag a saved plan instead of silently rewriting it", async ({
  page,
  request,
}) => {
  const project = await setup(page, request);
  await planFields(page, project, "2026-11-03");
  await previewButton(page).click();
  await confirmPlanButton(page).click();
  await expect(page.locator(".planning-saved")).toHaveCount(1);
  const prior = structuredClone(
    (await state(request)).projects.find((p) => p.id === project.id).plans[0],
  );
  const other = await command(request, "create_project", {
    title: "独立项目的示例会议",
    goal: "交叉检查时间冲突",
    deadline: null,
  });
  await command(request, "add_busy_slot", {
    projectId: other.result.projectId,
    title: "临时研究讨论",
    kind: "busy",
    date: "2026-11-03",
    startTime: "09:10",
    endTime: "09:40",
  });
  await page.reload();
  await expect(page.locator(".planning-saved")).toContainText(
    "当前已录入时段与原安排冲突",
  );
  await expect(page.locator(".planning-saved")).toContainText("临时研究讨论");
  expect(
    (await state(request)).projects.find((p) => p.id === project.id).plans[0],
  ).toEqual(prior);
});

test("narrow planner recovers preview failure and explains why a task does not fit", async ({
  page,
  request,
}) => {
  const project = await setup(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await planFields(page, project, "2026-11-04", "09:00", "09:30");
  await page
    .getByRole("spinbutton", {
      name: `预计分钟数：${project.tasks[1].title}`,
      exact: true,
    })
    .fill("60");
  let intercepted = false;
  await page.route("**/api/plans/preview", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await previewButton(page).click();
  await expect(page.locator(".planning-error")).toBeVisible();
  await previewButton(page).click();
  await expect(page.locator(".planning-preview")).toContainText(
    "没有足够的连续空闲时间",
  );
  await expect(confirmPlanButton(page)).toHaveCount(0);
  await page
    .getByRole("spinbutton", {
      name: `预计分钟数：${project.tasks[1].title}`,
      exact: true,
    })
    .fill("30");
  await previewButton(page).click();
  await expect(confirmPlanButton(page)).toBeEnabled();
  expect(
    await page
      .locator(".planning-panel")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".planning-preview > h3")).toBeFocused();
});

test("checkpoint restores next step and original source without changing completed/review status", async ({
  page,
  request,
}) => {
  const project = await setup(page, request),
    task = project.tasks[0],
    source = project.sources[0];
  await command(request, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "第二版合成样本；数字待核查。",
  });
  await page.reload();
  await row(page)
    .getByRole("button", { name: "记录继续点", exact: true })
    .click();
  await expect(page.locator(".task-work-dialog")).toContainText(
    "资料依据已变化",
  );
  await page.getByLabel("这次做到哪里", { exact: true }).fill("已整理示例记录");
  await page
    .getByLabel("下次第一步", { exact: true })
    .fill("核对 A 教室使用时长");
  await page
    .getByLabel("目前卡在哪里（可选）", { exact: true })
    .fill("等待组员补充记录");
  await page
    .getByLabel("下次要看的资料（可选）", { exact: true })
    .selectOption(source.id);
  await page
    .getByLabel("资料版本", { exact: true })
    .selectOption(source.currentVersionId);
  await expect(page.locator(".task-work-dialog")).toContainText(
    "选中的是历史资料版本",
  );
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row(page).locator(".status-select")).toHaveValue("done");
  await expect(row(page)).toContainText("内容需要复核");
  await page.reload();
  await row(page)
    .getByRole("button", { name: "打开继续点", exact: true })
    .click();
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue(
    "核对 A 教室使用时长",
  );
  await page.locator(".work-history > summary").click();
  await page.locator(".work-history .evidence-link").click();
  await expect(page.locator(".source-content")).toContainText("A教室,60");
  const saved = (await state(request)).projects
    .find((item) => item.id === project.id)
    .tasks.find((item) => item.id === task.id);
  expect(saved.checkpoints).toHaveLength(1);
  expect(saved.status).toBe("done");
  expect(saved.reviewRequired).toBe(true);
});

test("checkpoint conflict preserves writing and requires explicitly reading latest progress", async ({
  page,
  request,
}) => {
  const project = await setup(page, request),
    task = project.tasks[1];
  await row(page, 1)
    .getByRole("button", { name: "记录继续点", exact: true })
    .click();
  await page
    .getByLabel("下次第一步", { exact: true })
    .fill("我的下一步仍要保留");
  await command(request, "save_checkpoint", {
    projectId: project.id,
    taskId: task.id,
    baseCheckpointNumber: 0,
    doneNote: "另一页面已经核对",
    nextStep: "另一页面保存的继续点",
    blocker: "",
    evidence: null,
  });
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.locator(".work-conflict")).toContainText(
    "另一页面保存的继续点",
  );
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue(
    "我的下一步仍要保留",
  );
  await expect(
    page.getByRole("button", { name: "保存继续点", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "刷新最新进度", exact: true }).click();
  await page
    .getByRole("button", { name: "已核对，保留我的填写", exact: true })
    .click();
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const saved = (await state(request)).projects.find(
    (item) => item.id === project.id,
  ).tasks[1];
  expect(saved.checkpoints.map((item) => item.nextStep)).toEqual([
    "另一页面保存的继续点",
    "我的下一步仍要保留",
  ]);
});

test("checkpoint lost response is retriable once and narrow dialog returns keyboard focus", async ({
  page,
  request,
}) => {
  const project = await setup(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const trigger = row(page, 1).getByRole("button", {
    name: "记录继续点",
    exact: true,
  });
  await trigger.click();
  await page.getByLabel("下次第一步", { exact: true }).fill("先核对采样日期");
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByLabel("下次第一步", { exact: true })
    .fill("保存后断网也只记录一次");
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("避免重复留存");
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await state(request)).projects.find((item) => item.id === project.id)
      .tasks[1].checkpoints,
  ).toHaveLength(1);
});
