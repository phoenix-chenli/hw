import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request) {
  const response = await request.get("/api/state", { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function command(request, type, payload = {}) {
  const current = await state(request);
  const response = await request.post("/api/commands", {
    headers,
    data: { type, payload, operationId: randomUUID(), expectedRevision: current.revision },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function project(request, rich = false) {
  const created = await command(request, "create_project", {
    title: `项目管理验证 ${randomUUID()}`,
    goal: "合成资料用于核对项目编辑和可恢复归档。", deadline: "2028-03-01",
  });
  const id = created.result.projectId;
  if (rich) {
    const added = await command(request, "add_source", {
      projectId: id, title: "合成资料", kind: "note", content: "合成样本 A=60，不能推断实际研究结果。",
    });
    const source = added.state.projects.find((p) => p.id === id).sources[0];
    const claimed = await command(request, "add_claim", {
      projectId: id, text: "合成样本 A 的数值为 60。",
      evidence: [{ sourceId: source.id, versionId: source.currentVersionId, locator: "第 1 行" }],
    });
    const claim = claimed.state.projects.find((p) => p.id === id).claims[0];
    await command(request, "add_task", { projectId: id, title: "核对采样口径", claimIds: [claim.id] });
    const drafted = await command(request, "add_artifact", {
      projectId: id, title: "合成成果草稿", content: "仅展示来源关联，仍需实际研究。", claimIds: [claim.id],
    });
    const artifact = drafted.state.projects.find((p) => p.id === id).artifacts[0];
    const reportRequest = { title: "编辑前的合成报告", artifactIds: [artifact.id], includeTasks: true };
    const previewResponse = await request.post("/api/reports/preview", {
      headers, data: { projectId: id, request: reportRequest },
    });
    expect(previewResponse.ok()).toBeTruthy();
    const preview = await previewResponse.json();
    await command(request, "save_report", {
      projectId: id, request: reportRequest, previewToken: preview.previewToken, acknowledgeWarnings: true,
    });
  }
  return (await state(request)).projects.find((p) => p.id === id);
}
async function open(page, p) {
  await page.goto("/");
  await page.getByRole("button", { name: p.title, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
}
async function edit(page) {
  await page.getByRole("button", { name: "编辑项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑项目信息", exact: true })).toBeVisible();
}
async function restore(page, title) {
  const button = page.getByRole("button", { name: `恢复项目：${title}`, exact: true });
  if (!(await button.isVisible())) await page.locator("summary").filter({ hasText: /^已归档项目/ }).click();
  await button.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

test("editing project information persists and leaves the saved report and research data unchanged", async ({ page, request }) => {
  const before = await project(request, true);
  await open(page, before);
  await edit(page);
  const title = `修改后的研究项目 ${randomUUID()}`;
  await page.getByLabel("项目名称", { exact: true }).fill(title);
  await page.getByLabel("研究目标", { exact: true }).fill("调整研究范围，保留全部历史依据和成果。");
  await page.getByLabel("截止日期（选填）", { exact: true }).fill("");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.locator(".deadline")).toContainText("暂未设置截止日期");
  const after = (await state(request)).projects.find((p) => p.id === before.id);
  expect(after.deadline).toBeNull();
  expect(after.goal).toBe("调整研究范围，保留全部历史依据和成果。");
  for (const key of ["sources", "claims", "tasks", "artifacts", "reports"])
    expect(after[key]).toEqual(before[key]);
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  await expect(page.locator(".report-changed")).toContainText("相关内容已有变化");
  await page.getByRole("button", { name: "查看保存的内容", exact: true }).click();
  await expect(page.locator(".report-snapshot")).toContainText(before.goal);
});

test("closed project edits restore separately from a new-project form and clear after saving", async ({ page, request }) => {
  const p = await project(request);
  await open(page, p);
  await edit(page);
  await page.getByLabel("研究目标", { exact: true }).fill("尚未保存的项目目标");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("研究目标", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.reload();
  await edit(page);
  await expect(page.getByLabel("研究目标", { exact: true })).toHaveValue("尚未保存的项目目标");
  await expect(page.getByRole("dialog")).toContainText("已恢复");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await edit(page);
  await expect(page.getByRole("dialog").getByText(/已恢复本窗口的临时填写/)).toHaveCount(0);
  await expect(page.getByLabel("研究目标", { exact: true })).toHaveValue("尚未保存的项目目标");
});

test("archiving is cancellable, survives refresh and restores all project data including reports and plans", async ({ page, request }) => {
  const p = await project(request, true);
  await command(request, "add_busy_slot", {
    projectId: p.id, title: "合成课程占用", kind: "class", date: "2031-04-15", startTime: "18:00", endTime: "19:00",
  });
  const planRequest = { date: "2031-04-15", startTime: "19:00", endTime: "20:00", items: [{ taskId: p.tasks[0].id, durationMinutes: 30 }], allowDuringClass: false };
  const previewResponse = await request.post("/api/plans/preview", { headers, data: { projectId: p.id, request: planRequest } });
  expect(previewResponse.ok()).toBeTruthy();
  const preview = await previewResponse.json();
  await command(request, "confirm_plan", { projectId: p.id, request: planRequest, previewToken: preview.previewToken, acknowledgeClassOverlap: false });
  const before = (await state(request)).projects.find((entry) => entry.id === p.id);
  await open(page, before);
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "归档这个项目？", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("归档不会取消已确认的计划");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await state(request)).projects.find((entry) => entry.id === p.id).archivedAt).toBeFalsy();
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await page.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".project-switch").filter({ hasText: p.title })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".project-switch").filter({ hasText: p.title })).toHaveCount(0);
  const archived = (await state(request)).projects.find((entry) => entry.id === p.id);
  expect(archived.archivedAt).toBeTruthy();
  for (const key of ["sources", "claims", "tasks", "artifacts", "reports", "plans", "busySlots"])
    expect(archived[key]).toEqual(before[key]);
  await restore(page, p.title);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
  const restored = (await state(request)).projects.find((entry) => entry.id === p.id);
  expect(restored.archivedAt).toBeFalsy();
  expect(restored.plans).toEqual(before.plans);
  expect(restored.reports).toEqual(before.reports);
});

test("concurrent project edits keep the user's fields and require a new check before overwriting", async ({ page, request }) => {
  const p = await project(request);
  await open(page, p);
  await edit(page);
  await page.getByLabel("研究目标", { exact: true }).fill("本窗口尚未提交的研究目标");
  await command(request, "update_project", { projectId: p.id, title: p.title, goal: "其他页面已经保存的新目标", deadline: p.deadline });
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("填写已保留");
  await expect(page.getByLabel("研究目标", { exact: true })).toHaveValue("本窗口尚未提交的研究目标");
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  expect((await state(request)).projects.find((entry) => entry.id === p.id).goal).toBe("其他页面已经保存的新目标");
  await expect(page.getByRole("dialog")).toContainText("其他页面已经保存的新目标");
  await page.getByRole("button", { name: "已核对当前内容，保留填写", exact: true }).click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await state(request)).projects.find((entry) => entry.id === p.id).goal).toBe("本窗口尚未提交的研究目标");
});

test("a material form stays bound to its original project when that project is archived elsewhere", async ({ page, request }) => {
  const first = await project(request);
  const second = await project(request);
  await open(page, first);
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await page.getByLabel("资料标题", { exact: true }).fill("只能保留在原项目的临时资料");
  await page.getByLabel("资料文字", { exact: true }).fill("临时内容，尚未保存。");
  await command(request, "archive_project", { projectId: first.id });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("已归档");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("只能保留在原项目的临时资料");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await state(request)).projects.find((p) => p.id === second.id).sources).toEqual([]);
  await restore(page, first.title);
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("只能保留在原项目的临时资料");
});

test("an open checkpoint keeps its project and recoverable input when the project is archived elsewhere", async ({ page, request }) => {
  const first = await project(request);
  const taskResult = await command(request, "add_task", { projectId: first.id, title: "继续点隔离行动", claimIds: [] });
  const task = taskResult.state.projects.find((p) => p.id === first.id).tasks[0];
  const second = await project(request);
  await open(page, first);
  await page.getByRole("button", { name: /^行动清单/ }).click();
  await page.locator(".task-row").filter({ hasText: task.title }).getByRole("button", { name: "记录继续点", exact: true }).click();
  await page.getByLabel("下次第一步", { exact: true }).fill("只属于原项目的继续点草稿");
  await command(request, "archive_project", { projectId: first.id });
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.locator(".task-work-dialog")).toContainText("已归档");
  await expect(page.getByRole("button", { name: "保存继续点", exact: true })).toBeDisabled();
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue("只属于原项目的继续点草稿");
  await page.getByRole("button", { name: "关闭继续点", exact: true }).click();
  expect((await state(request)).projects.find((p) => p.id === second.id).tasks).toEqual([]);
  await restore(page, first.title);
  await page.getByRole("button", { name: /^行动清单/ }).click();
  await page.locator(".task-row").filter({ hasText: task.title }).getByRole("button", { name: "记录继续点", exact: true }).click();
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue("只属于原项目的继续点草稿");
});

test("all archived projects remain recoverable from the narrow-screen empty state", async ({ page, request }) => {
  const target = await project(request);
  // The shared browser-test server contains only disposable synthetic fixtures.
  // Archive the other fixtures so this test exercises the true zero-active state.
  for (const entry of (await state(request)).projects) {
    if (entry.id !== target.id && !entry.archivedAt)
      await command(request, "archive_project", { projectId: entry.id });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.title);
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await page.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("当前没有进行中的项目");
  await page.reload();
  await page.getByRole("button", { name: "查看已归档项目", exact: true }).click();
  await page.getByRole("button", { name: `恢复项目：${target.title}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.title);
  await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
