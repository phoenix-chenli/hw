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
  return project;
}
async function actions(page) {
  await page.getByRole("button", { name: /^行动清单/ }).click();
}
async function checkpoint(page, index) {
  await page.locator(".task-row").nth(index)
    .getByRole("button", { name: /^(记录继续点|打开继续点)$/ }).click();
}
async function openClaim(page, index = 0) {
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.locator(".claim-card").nth(index)
    .getByRole("button", { name: "逐项复核", exact: true }).click();
  await expect(page.getByLabel("复核后的结论", { exact: true })).toBeEnabled();
}

test("checkpoint edits survive close and reload, stay task-specific and require a fresh progress check", async ({
  page, request,
}) => {
  const project = await setup(page, request);
  const task = project.tasks[1];
  const source = project.sources[0];
  await actions(page);
  await checkpoint(page, 1);
  await page.getByLabel("这次做到哪里", { exact: true }).fill("暂存：已整理原始记录");
  await page.getByLabel("下次第一步", { exact: true }).fill("暂存：先核对采样时长");
  await page.getByLabel("目前卡在哪里（可选）", { exact: true }).fill("暂存：等待补充记录");
  await page.getByLabel("下次要看的资料（可选）", { exact: true }).selectOption(source.id);
  await page.getByRole("button", { name: "关闭继续点", exact: true }).click();
  await checkpoint(page, 2);
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await command(request, "save_checkpoint", {
    projectId: project.id,
    taskId: task.id,
    baseCheckpointNumber: 0,
    doneNote: "其他页面的进度",
    nextStep: "其他页面已留存的继续点",
    blocker: "",
    evidence: null,
  });
  await command(request, "update_source", {
    projectId: project.id,
    sourceId: source.id,
    baseVersionId: source.currentVersionId,
    content: "资料现已更新；原继续点仍引用旧资料版本。",
  });
  await page.reload();
  await checkpoint(page, 1);
  await expect(page.locator(".task-work-dialog [role=status]")).toContainText("已恢复");
  await expect(page.getByLabel("这次做到哪里", { exact: true })).toHaveValue("暂存：已整理原始记录");
  await expect(page.getByLabel("下次第一步", { exact: true })).toHaveValue("暂存：先核对采样时长");
  await expect(page.getByLabel("资料版本", { exact: true })).toHaveValue(source.currentVersionId);
  await expect(page.locator(".work-conflict")).toContainText("其他页面已留存的继续点");
  await expect(page.getByRole("button", { name: "保存继续点", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "已核对，保留我的填写", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新最新进度", exact: true }).click();
  // Reading a newer base alone is not acknowledgement, including after another close.
  await page.getByRole("button", { name: "关闭继续点", exact: true }).click();
  await checkpoint(page, 1);
  await expect(page.locator(".work-conflict")).toBeVisible();
  await expect(page.getByRole("button", { name: "已核对，保留我的填写", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新最新进度", exact: true }).click();
  await page.getByRole("button", { name: "已核对，保留我的填写", exact: true }).click();
  await page.getByRole("button", { name: "保存继续点", exact: true }).click();
  await expect(page.locator(".task-work-dialog")).not.toBeVisible();
  const saved = (await state(request)).projects.find((item) => item.id === project.id)
    .tasks.find((item) => item.id === task.id);
  expect(saved.checkpoints.map((entry) => entry.nextStep)).toEqual([
    "其他页面已留存的继续点", "暂存：先核对采样时长",
  ]);
  expect(saved.checkpoints.at(-1).evidence.versionId).toBe(source.currentVersionId);
  await checkpoint(page, 1);
  await expect(page.locator(".task-work-dialog [role=status]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存继续点", exact: true })).toBeEnabled();
});

test("review edits restore per entity against fresh evidence and never restore acknowledgement", async ({
  page, request,
}) => {
  const project = await setup(page, request);
  for (const source of project.sources) {
    await command(request, "update_source", {
      projectId: project.id,
      sourceId: source.id,
      baseVersionId: source.currentVersionId,
      content: `合成第二版：${source.title}；仍需实际核查。`,
    });
  }
  await page.reload();
  await openClaim(page);
  await page.getByLabel("复核后的结论", { exact: true }).fill("暂存结论：需要更多实际记录。");
  await page.getByLabel("当前依据位置", { exact: false }).fill("暂存的人工位置描述");
  await page.getByLabel("复核说明", { exact: true }).fill("暂存说明：保留研究限制。");
  await page.getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true }).check();
  await page.keyboard.press("Escape");
  await openClaim(page, 1);
  await expect(page.getByLabel("复核后的结论", { exact: true })).not.toHaveValue("暂存结论：需要更多实际记录。");
  await expect(page.getByLabel("复核说明", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "关闭复核窗口", exact: true }).click();
  const currentSource = (await state(request)).projects.find((item) => item.id === project.id).sources[0];
  const changed = await command(request, "update_source", {
    projectId: project.id,
    sourceId: currentSource.id,
    baseVersionId: currentSource.currentVersionId,
    content: "合成第三版：这次新资料必须重新核对。",
  });
  const newestVersion = changed.state.projects.find((item) => item.id === project.id).sources[0].currentVersionId;
  await page.reload();
  await openClaim(page);
  await expect(page.locator(".review-dialog .review-message[role=status]")).toContainText("已恢复");
  await expect(page.getByLabel("复核后的结论", { exact: true })).toHaveValue("暂存结论：需要更多实际记录。");
  await expect(page.getByLabel("当前依据位置", { exact: false })).toHaveValue("暂存的人工位置描述");
  await expect(page.getByLabel("复核说明", { exact: true })).toHaveValue("暂存说明：保留研究限制。");
  await expect(page.getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "确认本项复核", exact: true })).toBeDisabled();
  await expect(page.locator(".review-comparisons").first()).toContainText("合成第三版");
  await page.getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true }).check();
  await page.getByRole("button", { name: "确认本项复核", exact: true }).click();
  await expect(page.locator(".review-dialog")).not.toBeVisible();
  const saved = (await state(request)).projects.find((item) => item.id === project.id).claims[0];
  expect(saved.evidence[0].versionId).toBe(newestVersion);
  expect(saved.revisions.at(-1).reason).toBe("暂存说明：保留研究限制。");
  await page.locator(".claim-card").first().getByRole("button", { name: /^复核记录/ }).click();
  await expect(page.locator(".review-dialog .review-message[role=status]")).toHaveCount(0);
});
