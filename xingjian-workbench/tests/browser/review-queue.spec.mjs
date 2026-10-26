import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request) {
  const response = await request.get("/api/state", { headers });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
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
async function projectState(request, projectId) {
  return (await state(request)).projects.find((item) => item.id === projectId);
}
async function createProject(request, title = "复核队列浏览器验证") {
  const result = await command(request, "create_project", {
    title: `${title} · ${randomUUID().slice(0, 8)}`,
    goal: "仅使用合成资料，验证人工逐项复核与真实完成进度相互独立。",
    deadline: null,
  });
  return projectState(request, result.result.projectId);
}
async function source(request, projectId, title) {
  const result = await command(request, "add_source", {
    projectId,
    title,
    kind: "note",
    content: `${title}第一版：合成记录，需人工核查。`,
  });
  return result.state.projects
    .find((item) => item.id === projectId)
    .sources.find((item) => item.id === result.result.entityId);
}
async function claim(request, projectId, sourceItem, text) {
  const result = await command(request, "add_claim", {
    projectId,
    text,
    evidence: [
      {
        sourceId: sourceItem.id,
        versionId: sourceItem.currentVersionId,
        locator: "人工记录的第 1 行，须复核实际含义",
      },
    ],
  });
  return result.result.entityId;
}
async function updateSource(request, projectId, sourceItem) {
  await command(request, "update_source", {
    projectId,
    sourceId: sourceItem.id,
    baseVersionId: sourceItem.currentVersionId,
    content: `${sourceItem.title}第二版：合成记录已调整，不代表研究结论已验证。`,
  });
}
async function fixture(request) {
  const project = await createProject(request);
  const first = await source(request, project.id, "合成访谈记录");
  const second = await source(request, project.id, "合成课堂观察");
  const unchanged = await source(request, project.id, "未变更的资料");
  const firstClaim = await claim(
    request,
    project.id,
    first,
    "访谈发现仍需核对样本限制",
  );
  const secondClaim = await claim(
    request,
    project.id,
    second,
    "课堂观察尚不足以形成因果判断",
  );
  const healthyClaim = await claim(
    request,
    project.id,
    unchanged,
    "未变更资料的结论应保持原状态",
  );
  const completed = await command(request, "add_task", {
    projectId: project.id,
    title: "已经完成的访谈整理",
    claimIds: [firstClaim],
  });
  await command(request, "set_task_status", {
    projectId: project.id,
    taskId: completed.result.entityId,
    status: "done",
  });
  const ongoing = await command(request, "add_task", {
    projectId: project.id,
    title: "正在推进的观察核对",
    claimIds: [secondClaim],
  });
  await command(request, "set_task_status", {
    projectId: project.id,
    taskId: ongoing.result.entityId,
    status: "doing",
  });
  const draft = await command(request, "add_artifact", {
    projectId: project.id,
    title: "两份合成资料的阶段草稿",
    content: "记录访谈与观察的限制，尚未形成实际研究结论。",
    claimIds: [firstClaim, secondClaim],
  });
  await command(request, "add_task", {
    projectId: project.id,
    title: "不应进入待复核的行动",
    claimIds: [healthyClaim],
  });
  await command(request, "add_artifact", {
    projectId: project.id,
    title: "不应进入待复核的草稿",
    content: "引用未发生变化的合成资料。",
    claimIds: [healthyClaim],
  });
  await updateSource(request, project.id, first);
  await updateSource(request, project.id, second);
  return {
    project: await projectState(request, project.id),
    first,
    second,
    unchanged,
    firstClaim,
    secondClaim,
    completedTask: completed.result.entityId,
    ongoingTask: ongoing.result.entityId,
    draft: draft.result.entityId,
  };
}
async function openProject(page, project) {
  await page.goto("/");
  await switchProject(page, project);
}
async function switchProject(page, project) {
  const menu = page.getByRole("button", { name: "展开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: project.title, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(project.title);
}
const queue = (page) => page.getByRole("region", { name: "待复核清单", exact: true });
const rows = (page) => queue(page).locator(".review-queue-row");
const row = (page, id) => queue(page).locator(`[data-review-id="${id}"]`);
const dialog = (page) => page.locator(".review-dialog");
async function confirmCurrent(page, reason = "已对照合成资料，原内容仍适用，保留现有研究限制。") {
  await expect(dialog(page).getByLabel("复核说明", { exact: true })).toBeEnabled();
  await dialog(page).getByLabel("复核说明", { exact: true }).fill(reason);
  await dialog(page)
    .getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true })
    .check();
  await dialog(page)
    .getByRole("button", { name: "确认本项复核", exact: true })
    .click();
  await expect(dialog(page)).not.toBeVisible();
}

test("queue filters expose only pending linked content and never write to the workspace", async ({ page, request }) => {
  const f = await fixture(request);
  await openProject(page, f.project);
  const before = await state(request);
  await expect(rows(page)).toHaveCount(5);
  await expect(queue(page).getByRole("status")).toContainText("显示 5 项，共 5 项待复核");
  await expect(queue(page)).not.toContainText("未变更资料的结论应保持原状态");
  await expect(queue(page)).not.toContainText("不应进入待复核");
  await expect(row(page, f.completedTask)).toContainText("已完成");
  await expect(row(page, f.ongoingTask)).toContainText("进行中");

  await queue(page).getByRole("button", { name: "行动", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await rows(page).evaluateAll((items) => items.map((item) => item.dataset.reviewKind))).toEqual(["task", "task"]);
  await queue(page).getByLabel("按关联资料筛选", { exact: true }).selectOption(f.first.id);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("已经完成的访谈整理");
  await queue(page).getByRole("button", { name: "全部", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, f.draft)).toContainText(f.first.title);
  await expect(row(page, f.draft)).toContainText(f.second.title);
  await queue(page).getByLabel("按处理顺序筛选", { exact: true }).selectOption("ready");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toHaveAttribute("data-review-kind", "claim");
  await queue(page).getByLabel("按处理顺序筛选", { exact: true }).selectOption("blocked");
  await expect(rows(page)).toHaveCount(2);
  await queue(page).getByLabel("查找待复核内容", { exact: true }).fill("不存在的待复核内容");
  await expect(rows(page)).toHaveCount(0);
  await expect(queue(page)).toContainText("没有符合筛选的待复核内容");
  await queue(page).getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(queue(page).getByRole("button", { name: "全部", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(queue(page).getByLabel("按关联资料筛选", { exact: true })).toHaveValue("");
  await expect(queue(page).getByLabel("按处理顺序筛选", { exact: true })).toHaveValue("all");
  expect(await state(request)).toEqual(before);
});

test("review dependencies unlock individually and a completed task keeps its real progress", async ({ page, request }) => {
  const f = await fixture(request);
  await openProject(page, f.project);
  const taskRow = row(page, f.completedTask);
  await expect(taskRow).toContainText("先核对 1 项关联结论");
  await taskRow.getByRole("button", { name: "查看依赖与原文", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "复核行动", exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "确认本项复核", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toBeVisible();
  await expect(taskRow.getByRole("button", { name: "查看依赖与原文", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await taskRow.getByText("查看需要先核对的结论", { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await queue(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await taskRow.getByRole("button", { name: `先核对结论：${f.project.claims[0].text}`, exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "复核结论", exact: true })).toBeVisible();
  await confirmCurrent(page);
  await expect(row(page, f.firstClaim)).toHaveCount(0);
  await expect(queue(page).getByRole("heading", { name: "待复核清单", exact: true })).toBeFocused();
  await expect(taskRow.getByRole("button", { name: "核对本项", exact: true })).toBeEnabled();
  await expect(row(page, f.draft)).toContainText("先核对 1 项关联结论");
  await expect(row(page, f.ongoingTask)).toContainText("先核对 1 项关联结论");
  let current = await projectState(request, f.project.id);
  expect(current.tasks.find((item) => item.id === f.completedTask)).toMatchObject({ status: "done", reviewRequired: true });
  await taskRow.getByRole("button", { name: "核对本项", exact: true }).click();
  await confirmCurrent(page, "整理工作已完成，本次仅确认内容和新版资料仍一致。");
  await expect(row(page, f.completedTask)).toHaveCount(0);
  await expect(queue(page).getByRole("heading", { name: "待复核清单", exact: true })).toBeFocused();
  current = await projectState(request, f.project.id);
  expect(current.tasks.find((item) => item.id === f.completedTask)).toMatchObject({ status: "done", reviewRequired: false });
  expect(current.tasks.find((item) => item.id === f.ongoingTask)).toMatchObject({ status: "doing", reviewRequired: true });
  expect(current.artifacts.find((item) => item.id === f.draft).status).toBe("needs_review");
  expect(current.claims[0].revisions).toHaveLength(2);
  expect(current.tasks[0].revisions).toHaveLength(2);
});

test("start reviews the full dependency order despite filters and the completed queue remains empty after reload", async ({ page, request }) => {
  const f = await fixture(request);
  await openProject(page, f.project);
  await queue(page).getByRole("button", { name: "草稿", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("先核对 2 项关联结论");
  await page.getByRole("button", { name: "开始逐项复核", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "复核结论", exact: true })).toBeVisible();
  await confirmCurrent(page);
  await queue(page).getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  for (const remaining of [4, 3, 2, 1]) {
    await page.getByRole("button", { name: "开始逐项复核", exact: true }).click();
    await confirmCurrent(page);
    await expect(rows(page)).toHaveCount(remaining - 1);
  }
  await expect(queue(page)).toContainText("当前没有待复核内容");
  await expect(queue(page)).not.toContainText("没有符合筛选的待复核内容");
  await expect(queue(page).getByRole("heading", { name: "待复核清单", exact: true })).toBeFocused();
  await page.reload();
  await expect(queue(page)).toContainText("当前没有待复核内容");
  await expect(rows(page)).toHaveCount(0);
  const saved = await projectState(request, f.project.id);
  expect(saved.claims.every((item) => item.status !== "needs_review")).toBe(true);
  expect(saved.tasks.every((item) => !item.reviewRequired)).toBe(true);
  expect(saved.artifacts.every((item) => item.status !== "needs_review")).toBe(true);
  expect(saved.tasks.find((item) => item.id === f.completedTask).status).toBe("done");
  expect(saved.tasks.find((item) => item.id === f.ongoingTask).status).toBe("doing");
  expect(saved.sources.map((item) => item.versions.length)).toEqual([2, 2, 1]);
});

test("queue pagination, narrow long titles, keyboard return and project filters stay usable and isolated", async ({ page, request }) => {
  const project = await createProject(request, "分页与窄屏复核");
  const material = await source(request, project.id, "分页用合成资料");
  for (let index = 0; index < 10; index += 1) {
    await claim(request, project.id, material, `分页结论${index + 1}：${"合成记录需要人工对照且保留原始依据。".repeat(20)}`);
  }
  await updateSource(request, project.id, material);
  const other = await createProject(request, "另一独立复核项目");
  const otherMaterial = await source(request, other.id, "另一项目资料");
  await claim(request, other.id, otherMaterial, "另一项目唯一的待核对结论");
  await updateSource(request, other.id, otherMaterial);
  const before = await state(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openProject(page, project);
  await expect(rows(page)).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await queue(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const trigger = rows(page).first().getByRole("button", { name: "核对本项", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("heading", { name: "复核结论", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await queue(page).getByRole("button", { name: "下一页待复核内容", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(queue(page).getByRole("button", { name: "下一页待复核内容", exact: true })).toBeDisabled();
  await expect(queue(page).getByRole("button", { name: "上一页待复核内容", exact: true })).toBeEnabled();
  await queue(page).getByLabel("查找待复核内容", { exact: true }).fill("分页结论10");
  await expect(rows(page)).toHaveCount(1);
  await switchProject(page, other);
  await expect(queue(page).getByLabel("查找待复核内容", { exact: true })).toHaveValue("");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("另一项目唯一的待核对结论");
  await switchProject(page, project);
  await expect(queue(page).getByLabel("查找待复核内容", { exact: true })).toHaveValue("");
  await expect(rows(page)).toHaveCount(8);
  expect(await state(request)).toEqual(before);
});
