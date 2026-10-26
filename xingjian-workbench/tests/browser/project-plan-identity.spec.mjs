import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request) {
  const response = await request.get("/api/state", { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function command(request, type, payload) {
  const current = await state(request);
  const response = await request.post("/api/commands", {
    headers,
    data: { type, payload, expectedRevision: current.revision, operationId: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function fixture(request, date) {
  const suffix = randomUUID();
  const projectTitle = `课内计划核对 ${suffix}`;
  const created = await command(request, "create_project", {
    title: projectTitle, goal: "用合成安排核对稳定课程标识", deadline: null,
  });
  const projectId = created.result.projectId;
  const task = await command(request, "add_task", {
    projectId, title: "核对合成记录", claimIds: [],
  });
  const courseTitle = `原课程项目 ${suffix}`;
  const course = await command(request, "create_project", {
    title: courseTitle, goal: "记录合成课程占用", deadline: null,
  });
  const courseProjectId = course.result.projectId;
  const slotPayload = {
    projectId: courseProjectId, title: "同名合成课程", kind: "class",
    date, startTime: "09:00", endTime: "10:00",
  };
  const slot = await command(request, "add_busy_slot", slotPayload);
  return {
    projectId, projectTitle, taskId: task.result.entityId,
    courseProjectId, courseTitle, slotPayload, slotId: slot.result.entityId, date,
  };
}
const planFrom = (current, f) => current.projects.find((project) => project.id === f.projectId).plans[0];
async function confirmInBrowser(page, f) {
  await page.goto("/");
  await page.getByRole("button", { name: f.projectTitle, exact: true }).click();
  await page.getByRole("button", { name: /^行动清单/ }).click();
  const planning = page.locator(".planning-panel");
  await planning.getByLabel("计划日期", { exact: true }).fill(f.date);
  await planning.getByLabel("开始时间", { exact: true }).fill("09:00");
  await planning.getByLabel("结束时间", { exact: true }).fill("10:00");
  await planning.locator(".planning-choice").filter({ hasText: "核对合成记录" })
    .getByRole("checkbox").check();
  await planning.getByRole("checkbox", { name: /允许安排在上课期间/ }).check();
  await planning.getByRole("button", { name: "预览时间安排", exact: true }).click();
  await expect(planning.locator(".planning-preview")).toContainText(f.courseTitle);
  await planning.getByRole("checkbox", {
    name: "我已查看重叠课程，确认这些行动可以在上课期间完成。", exact: true,
  }).check();
  await planning.getByRole("button", { name: "确认保存安排", exact: true }).click();
  await expect(planning.locator(".planning-saved")).toHaveCount(1);
}

test("renaming a course project preserves acknowledged overlap, while a distinct identical slot is a new conflict", async ({ page, request }) => {
  const f = await fixture(request, "2031-03-18");
  await confirmInBrowser(page, f);
  const saved = planFrom(await state(request), f);
  expect(saved.blocks[0].classConflicts).toEqual([{
    projectId: f.courseProjectId, slotId: f.slotId,
    title: f.slotPayload.title, projectTitle: f.courseTitle,
    startTime: "09:00", endTime: "10:00",
  }]);
  await command(request, "update_project", {
    projectId: f.courseProjectId, title: `改名后的课程项目 ${randomUUID()}`,
    goal: "记录合成课程占用", deadline: null,
  });
  await page.reload();
  await expect(page.locator(".planning-saved")).toHaveCount(1);
  await expect(page.locator(".planning-saved .planning-warning")).toHaveCount(0);
  expect(planFrom(await state(request), f)).toEqual(saved);
  // Same display text and times must not stand in for the newly created slot's identity.
  const added = await command(request, "add_busy_slot", f.slotPayload);
  expect(added.result.entityId).not.toBe(f.slotId);
  await page.reload();
  await expect(page.locator(".planning-saved .planning-warning")).toContainText("当前已录入时段与原安排冲突");
  expect(planFrom(await state(request), f)).toEqual(saved);
});

test("an unidentified legacy overlap after project renaming asks for review without asserting a new conflict", async ({ page, request }) => {
  const f = await fixture(request, "2031-03-19");
  await confirmInBrowser(page, f);
  const saved = planFrom(await state(request), f);
  // Present the historical wire shape without IDs; leave persisted records untouched.
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const current = await response.json();
    for (const block of planFrom(current, f).blocks) {
      for (const conflict of block.classConflicts) {
        delete conflict.projectId;
        delete conflict.slotId;
      }
    }
    await route.fulfill({ response, json: current });
  });
  await page.reload();
  await expect(page.locator(".planning-saved .planning-warning")).toHaveCount(0);
  await command(request, "update_project", {
    projectId: f.courseProjectId, title: `旧计划之后改名 ${randomUUID()}`,
    goal: "记录合成课程占用", deadline: null,
  });
  await page.reload();
  await expect(page.locator(".planning-saved .planning-warning")).toContainText("旧计划未记录完整课程标识，当前重叠需重新核对");
  await expect(page.locator(".planning-saved")).not.toContainText("当前已录入时段与原安排冲突");
  expect(planFrom(await state(request), f)).toEqual(saved);
});
