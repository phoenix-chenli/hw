import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const headers = { "X-Xingjian-Client": "workspace-v1" };
async function command(request, type, payload = {}) {
  const current = await (await request.get("/api/state", { headers })).json();
  const response = await request.post("/api/commands", {
    headers,
    data: { type, payload, operationId: randomUUID(), expectedRevision: current.revision },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function demo(page, request) {
  const response = await command(request, "load_demo");
  const project = response.state.projects.find((p) => p.id === response.result.projectId);
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  return project;
}

test("material drafts survive closing and refresh, stay in their project, and clear after saving", async ({ page, request }) => {
  const first = await demo(page, request);
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await page.getByLabel("资料标题", { exact: true }).fill("尚未保存的合成访谈摘录");
  await page.getByLabel("资料文字", { exact: true }).fill("这里只是草稿，尚未确认为研究资料。");
  await page.keyboard.press("Escape");
  const second = await command(request, "create_project", {
    title: "草稿隔离项目", goal: "验证本窗口填写不会串到其他项目", deadline: null,
  });
  await page.reload();
  await page.getByRole("button", { name: "草稿隔离项目", exact: true }).click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".project-switch").filter({ hasText: first.title }).last().click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("尚未保存的合成访谈摘录");
  await expect(page.getByRole("status")).toContainText("已恢复本窗口的临时填写");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "已核对当前内容，保留填写", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("");
  const state = await (await request.get("/api/state", { headers })).json();
  expect(state.projects.find((p) => p.id === first.id).sources).toHaveLength(first.sources.length + 1);
  expect(state.projects.find((p) => p.id === second.result.projectId).sources).toHaveLength(0);
});

test("closed source update restores only text and demands a fresh impact preview", async ({ page, request }) => {
  const project = await demo(page, request);
  const source = project.sources[0];
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  await page.getByLabel("更新后的资料内容", { exact: true }).fill("临时修改：合成数据仍需核对。");
  await page.getByRole("button", { name: "预览变更影响", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认保存新版本", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await command(request, "update_source", {
    projectId: project.id, sourceId: source.id,
    baseVersionId: source.currentVersionId, content: "另一次已确认的合成资料修订。",
  });
  await page.reload();
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  await expect(page.getByLabel("更新后的资料内容", { exact: true })).toHaveValue("临时修改：合成数据仍需核对。");
  await expect(page.getByRole("button", { name: "确认保存新版本", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "预览变更影响", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "已核对当前内容，保留填写", exact: true }).click();
  await page.getByRole("button", { name: "预览变更影响", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("v3");
  await page.getByRole("button", { name: "确认保存新版本", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("disabled session storage still preserves an accidentally closed form in this window", async ({ page, request }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("storage disabled", "SecurityError"); };
  });
  await demo(page, request);
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await page.getByLabel("资料标题", { exact: true }).fill("内存保留的临时标题");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect(page.getByLabel("资料标题", { exact: true })).toHaveValue("内存保留的临时标题");
});
