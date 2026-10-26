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
    data: { type, payload, expectedRevision: current.revision, operationId: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function reportProject(request) {
  const created = await command(request, "create_project", {
    title: `临时报告验证 ${randomUUID()}`,
    goal: "合成内容用于检查未保存填写保护",
    deadline: null,
  });
  const projectId = created.result.projectId;
  await command(request, "add_source", {
    projectId, title: "合成资料", kind: "note", content: "合成样本 A=60。",
  });
  const source = (await state(request)).projects.find((p) => p.id === projectId).sources[0];
  await command(request, "add_claim", {
    projectId, text: "合成样本数值为 60，需另行收集真实资料。",
    evidence: [{ sourceId: source.id, versionId: source.currentVersionId, locator: "第 1 行" }],
  });
  const claim = (await state(request)).projects.find((p) => p.id === projectId).claims[0];
  for (const title of ["合成章节一", "合成章节二"]) {
    await command(request, "add_artifact", {
      projectId, title, content: "本章仅为合成填写，不代表真实研究。", claimIds: [claim.id],
    });
  }
  return (await state(request)).projects.find((p) => p.id === projectId);
}
const report = (page) => page.locator(".report-panel");
async function go(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}
async function openReport(page, project) {
  await page.goto("/");
  await page.getByRole("button", { name: project.title, exact: true }).click();
  await go(page, "成果草稿");
}
async function chooseReport(page, project, title) {
  await report(page).getByLabel("报告标题", { exact: true }).fill(title);
  for (const artifact of project.artifacts) {
    await report(page).getByRole("checkbox", { name: `加入报告：${artifact.title}`, exact: true }).check();
  }
  await report(page).getByRole("button", { name: `上移报告章节：${project.artifacts[1].title}`, exact: true }).click();
  await report(page).getByRole("checkbox", { name: /附上关联行动/ }).uncheck();
}
async function previewReport(page) {
  await report(page).getByRole("button", { name: "预览报告", exact: true }).click();
  await expect(report(page).getByRole("heading", { name: "核对这份报告", exact: true })).toBeVisible();
}
const reportAck = (page) => report(page).getByRole("checkbox", {
  name: "我已查看上述提醒，确认将这些内容作为进展草稿保存。", exact: true,
});

test("report fields survive navigation, reload and project switches without restoring a preview or confirmation", async ({ page, request }) => {
  const first = await reportProject(request);
  const second = await reportProject(request);
  await openReport(page, first);
  await chooseReport(page, first, "尚未保存的研究报告");
  await previewReport(page);
  await reportAck(page).check();
  await go(page, "资料与依据");
  await go(page, "成果草稿");
  await expect(report(page).getByLabel("报告标题", { exact: true })).toHaveValue("尚未保存的研究报告");
  await expect(report(page).locator(".report-section-order li").first()).toContainText("合成章节二");
  await expect(report(page).getByRole("checkbox", { name: /附上关联行动/ })).not.toBeChecked();
  await expect(report(page).locator(".session-draft-notice")).toContainText("请重新预览");
  await expect(report(page).getByRole("button", { name: "保存报告版本", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(report(page).getByLabel("报告标题", { exact: true })).toHaveValue("尚未保存的研究报告");
  await page.getByRole("button", { name: second.title, exact: true }).click();
  await go(page, "成果草稿");
  await expect(report(page).getByLabel("报告标题", { exact: true })).toHaveValue(`${second.title} · 研学进展报告`);
  await expect(report(page).locator(".session-draft-notice")).toHaveCount(0);
  await page.getByRole("button", { name: first.title, exact: true }).click();
  await go(page, "成果草稿");
  await command(request, "update_source", {
    projectId: first.id, sourceId: first.sources[0].id,
    baseVersionId: first.sources[0].currentVersionId, content: "新版合成资料 A=72，不能沿用旧结论。",
  });
  await page.reload();
  await previewReport(page);
  await expect(report(page).locator(".report-warnings")).toContainText("复核");
  await expect(reportAck(page)).not.toBeChecked();
  await expect(report(page).getByRole("button", { name: "保存报告版本", exact: true })).toBeDisabled();
  expect((await state(request)).projects.find((p) => p.id === first.id).reports).toBeUndefined();
});

test("saving a restored report clears its temporary draft without changing the saved version", async ({ page, request }) => {
  const project = await reportProject(request);
  await openReport(page, project);
  await chooseReport(page, project, "完成后应清理临时填写");
  await page.reload();
  await previewReport(page);
  await reportAck(page).check();
  await report(page).getByRole("button", { name: "保存报告版本", exact: true }).click();
  await expect(report(page).locator(".report-saved")).toHaveCount(1);
  await expect(report(page).locator(".session-draft-notice")).toHaveCount(0);
  await page.reload();
  await expect(report(page).getByLabel("报告标题", { exact: true })).toHaveValue(`${project.title} · 研学进展报告`);
  await expect(report(page).locator(".report-section-order")).toHaveCount(0);
  const saved = (await state(request)).projects.find((p) => p.id === project.id).reports[0];
  expect(saved.spec.title).toBe("完成后应清理临时填写");
  expect(saved.spec.sections[0].title).toBe("合成章节二");
});

test("a late report save response cannot erase edits made after reopening the form", async ({ page, request }) => {
  const project = await reportProject(request);
  await openReport(page, project);
  await chooseReport(page, project, "已经提交的旧报告填写");
  await previewReport(page);
  await reportAck(page).check();
  let releaseResponse;
  let markSaved;
  const release = new Promise((resolve) => { releaseResponse = resolve; });
  const savedOnServer = new Promise((resolve) => { markSaved = resolve; });
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON()?.type !== "save_report") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    markSaved();
    await release;
    await route.fulfill({ response });
  });
  await report(page).getByRole("button", { name: "保存报告版本", exact: true }).click();
  await savedOnServer;
  await go(page, "资料与依据");
  await go(page, "成果草稿");
  await report(page).getByLabel("报告标题", { exact: true }).fill("等待回执期间的新报告填写");
  releaseResponse();
  await expect(report(page).locator(".report-saved")).toHaveCount(1);
  await page.reload();
  await expect(report(page).getByLabel("报告标题", { exact: true })).toHaveValue("等待回执期间的新报告填写");
  await expect(report(page).locator(".session-draft-notice")).toContainText("请重新预览");
  const current = (await state(request)).projects.find((p) => p.id === project.id);
  expect(current.reports).toHaveLength(1);
  expect(current.reports[0].spec.title).toBe("已经提交的旧报告填写");
});

test("a late busy-slot save response cannot erase a new entry typed after reopening", async ({ page, request }) => {
  const loaded = await command(request, "load_demo", {});
  const project = loaded.state.projects.find((p) => p.id === loaded.result.projectId);
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: /^行动清单/ }).click();
  const planning = page.locator(".planning-panel");
  await planning.locator(".planning-busy > summary").click();
  await planning.getByLabel("课程或事项名称", { exact: true }).fill("已提交的旧合成课程");
  await planning.getByLabel("占用日期", { exact: true }).fill("2026-11-18");
  await planning.getByLabel("占用开始", { exact: true }).fill("09:00");
  await planning.getByLabel("占用结束", { exact: true }).fill("10:00");
  let releaseResponse;
  let markSaved;
  const release = new Promise((resolve) => { releaseResponse = resolve; });
  const savedOnServer = new Promise((resolve) => { markSaved = resolve; });
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON()?.type !== "add_busy_slot") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    markSaved();
    await release;
    await route.fulfill({ response });
  });
  await planning.getByRole("button", { name: "保存时间占用", exact: true }).click();
  await savedOnServer;
  await go(page, "资料与依据");
  await page.getByRole("button", { name: /^行动清单/ }).click();
  await planning.locator(".planning-busy > summary").click();
  await planning.getByLabel("课程或事项名称", { exact: true }).fill("等待回执期间的新合成课程");
  await planning.getByLabel("占用日期", { exact: true }).fill("2026-11-19");
  releaseResponse();
  await expect(planning.locator(".planning-slot-list")).toContainText("已提交的旧合成课程");
  await page.reload();
  await planning.locator(".planning-busy > summary").click();
  await expect(planning.getByLabel("课程或事项名称", { exact: true })).toHaveValue("等待回执期间的新合成课程");
  await expect(planning.getByLabel("占用日期", { exact: true })).toHaveValue("2026-11-19");
  const current = (await state(request)).projects.find((p) => p.id === project.id);
  expect(current.busySlots).toHaveLength(1);
  expect(current.busySlots[0].title).toBe("已提交的旧合成课程");
});

test("planning and busy-slot drafts restore fields but require fresh preview and class permission", async ({ page, request }) => {
  const demo = await command(request, "load_demo", {});
  const project = demo.state.projects.find((p) => p.id === demo.result.projectId);
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: /^行动清单/ }).click();
  const planning = page.locator(".planning-panel");
  await planning.getByLabel("计划日期", { exact: true }).fill("2026-11-16");
  await planning.getByLabel("开始时间", { exact: true }).fill("09:00");
  await planning.getByLabel("结束时间", { exact: true }).fill("12:00");
  await planning.locator(".planning-choice").filter({ hasText: project.tasks[1].title }).getByRole("checkbox").check();
  await planning.getByLabel(`预计分钟数：${project.tasks[1].title}`, { exact: true }).fill("45");
  await planning.getByRole("checkbox", { name: /允许安排在上课期间/ }).check();
  await planning.getByRole("button", { name: "预览时间安排", exact: true }).click();
  await expect(planning.getByRole("button", { name: "确认保存安排", exact: true })).toBeEnabled();
  await planning.locator(".planning-busy > summary").click();
  await planning.getByLabel("课程或事项名称", { exact: true }).fill("尚未保存的合成课程");
  await planning.getByLabel("占用日期", { exact: true }).fill("2026-11-17");
  await planning.getByLabel("占用开始", { exact: true }).fill("10:00");
  await planning.getByLabel("占用结束", { exact: true }).fill("11:00");
  await go(page, "资料与依据");
  await page.getByRole("button", { name: /^行动清单/ }).click();
  await expect(planning.getByLabel("计划日期", { exact: true })).toHaveValue("2026-11-16");
  await expect(planning.getByLabel(`预计分钟数：${project.tasks[1].title}`, { exact: true })).toHaveValue("45");
  await expect(planning.getByRole("checkbox", { name: /允许安排在上课期间/ })).not.toBeChecked();
  await expect(planning.getByRole("button", { name: "确认保存安排", exact: true })).toHaveCount(0);
  await page.reload();
  await planning.locator(".planning-busy > summary").click();
  await expect(planning.getByLabel("课程或事项名称", { exact: true })).toHaveValue("尚未保存的合成课程");
  await expect(planning.getByLabel("占用日期", { exact: true })).toHaveValue("2026-11-17");
  await planning.getByRole("button", { name: "保存时间占用", exact: true }).click();
  await planning.getByRole("button", { name: "预览时间安排", exact: true }).click();
  await planning.getByRole("button", { name: "确认保存安排", exact: true }).click();
  await expect(planning.locator(".planning-saved")).toHaveCount(1);
  await expect(planning.locator(".session-draft-notice")).toHaveCount(0);
  await page.reload();
  await expect(planning.locator(".planning-duration-list")).toHaveCount(0);
  await planning.locator(".planning-busy > summary").click();
  await expect(planning.getByLabel("课程或事项名称", { exact: true })).toHaveValue("");
  const current = (await state(request)).projects.find((p) => p.id === project.id);
  expect(current.plans).toHaveLength(1);
  expect(current.plans[0].request.allowDuringClass).toBe(false);
  expect(current.busySlots).toHaveLength(1);
});
