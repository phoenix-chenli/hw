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
async function projectState(request, id) {
  return (await state(request)).projects.find((entry) => entry.id === id);
}
async function fixture(request, content, { linked = false } = {}) {
  const created = await command(request, "create_project", {
    title: `证据定位验证 · ${randomUUID().slice(0, 8)}`,
    goal: "所有文字均为合成资料；保留版本与核对过程。",
    deadline: null,
  });
  const projectId = created.result.projectId;
  const added = await command(request, "add_source", {
    projectId,
    title: "合成调研记录",
    kind: "note",
    content,
  });
  const source = added.state.projects.find((entry) => entry.id === projectId)
    .sources[0];
  if (linked) {
    const claim = await command(request, "add_claim", {
      projectId,
      text: "这条手工结论仍待核查。",
      evidence: [
        {
          sourceId: source.id,
          versionId: source.currentVersionId,
          locator: "原文件第 7 页，第 2–3 行；这是人工备注",
        },
      ],
    });
    await command(request, "add_task", {
      projectId,
      title: "人工核查采样条件",
      claimIds: [claim.result.entityId],
    });
    await command(request, "add_artifact", {
      projectId,
      title: "合成阶段草稿",
      content: "目前仅保留人工资料关联，尚未形成研究结论。",
      claimIds: [claim.result.entityId],
    });
  }
  return projectState(request, projectId);
}
async function openProject(page, project, section = "资料与依据") {
  await page.goto("/");
  const menu = page.getByRole("button", { name: "展开导航", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: project.title, exact: true }).click();
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: section, exact: true }).click();
}
async function updateSource(request, projectId, content) {
  const current = await projectState(request, projectId);
  return command(request, "update_source", {
    projectId,
    sourceId: current.sources[0].id,
    baseVersionId: current.sources[0].currentVersionId,
    content,
  });
}
async function saveReport(request, project) {
  const reportRequest = {
    title: "已保存的合成报告",
    artifactIds: [project.artifacts[0].id],
    includeTasks: true,
  };
  const response = await request.post("/api/reports/preview", {
    headers,
    data: { projectId: project.id, request: reportRequest },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const preview = await response.json();
  await command(request, "save_report", {
    projectId: project.id,
    request: reportRequest,
    previewToken: preview.previewToken,
    acknowledgeWarnings: true,
  });
}
const evidence = (page) => page.locator(".evidence-dialog");
const closeEvidence = async (page) => {
  await evidence(page)
    .getByRole("button", { name: "返回继续核对", exact: true })
    .click();
  await expect(evidence(page)).not.toBeVisible();
};

test("long documents jump to a retained excerpt page, cap literal search and render bounded coarse differences", async ({
  page,
  request,
}) => {
  const content = Array.from({ length: 600 }, (_, index) =>
    index === 520
      ? "需定位的采样记录，只是合成文字。"
      : `合成资料第 ${index + 1} 行，尚需人工核对。`,
  ).join("\n");
  const project = await fixture(request, content);
  await command(request, "run_analysis", {
    projectId: project.id,
    request: {
      mode: "search",
      sourceIds: [project.sources[0].id],
      query: "需定位的采样记录",
    },
  });
  await updateSource(
    request,
    project.id,
    Array.from(
      { length: 600 },
      (_, index) => `新版记录 ${index + 1}，须重新核对。`,
    ).join("\n"),
  );
  const prior = await projectState(request, project.id);
  await openProject(page, project, "资料分析");
  await page.locator(".analysis-evidence").first().click();
  const reader = evidence(page);
  await expect(reader.locator('[data-evidence-line="521"] mark')).toHaveText(
    "需定位的采样记录，只是合成文字。",
  );
  expect(await reader.locator(".evidence-line").count()).toBeLessThanOrEqual(
    200,
  );
  await reader.getByRole("button", { name: "资料上一页", exact: true }).click();
  await expect(reader.locator('[data-evidence-line="201"]')).toBeVisible();
  await reader.getByLabel("在此版本查找", { exact: true }).fill("合成资料");
  await expect(reader.locator(".evidence-search-feedback")).toContainText(
    "找到超过 200 处",
  );
  await expect(reader.locator('[data-evidence-line="1"] mark')).toHaveText(
    "合成资料",
  );
  await reader.getByRole("button", { name: "清除查找", exact: true }).click();
  await expect(reader.locator('[data-evidence-line="521"] mark')).toBeVisible();
  await reader
    .getByRole("button", { name: "对比引用版与当前版", exact: true })
    .click();
  await expect(reader.locator(".text-diff-warning")).toContainText(
    "未逐行精细匹配",
  );
  expect(await reader.locator(".text-diff-row").count()).toBeLessThanOrEqual(
    200,
  );
  await reader
    .locator(".text-diff")
    .getByRole("button", { name: "完整原文", exact: true })
    .click();
  expect(
    await reader.locator(".text-diff-original-line").count(),
  ).toBeLessThanOrEqual(400);
  await closeEvidence(page);
  expect(await projectState(request, project.id)).toEqual(prior);
});

test("verified excerpt opens at the exact quote and returns to unsaved analysis choices", async ({
  page,
  request,
}) => {
  const project = await fixture(
    request,
    "合成访谈记录\n资料室周末开放，需补充实际公告。\n课程时间仍需核实。",
  );
  await openProject(page, project, "资料分析");
  await page.getByLabel("想找哪些信息", { exact: true }).fill("资料室");
  await page
    .getByRole("button", { name: "查找并生成提案", exact: true })
    .click();
  await expect(page.locator(".analysis-candidate")).toHaveCount(1);
  const checkbox = page.getByRole("checkbox", {
    name: "选择候选 claim-1",
    exact: true,
  });
  await checkbox.check();
  // Editing the next question must not be discarded by a read-only source visit.
  await page
    .getByLabel("想找哪些信息", { exact: true })
    .fill("下一个问题暂不提交");
  const prior = await projectState(request, project.id);
  const candidate = prior.analyses.at(-1).output.claims[0];
  const trigger = page.locator(".analysis-evidence").first();
  await trigger.click();
  await expect(evidence(page)).toBeVisible();
  await expect(evidence(page).locator(".evidence-content mark")).toHaveText(
    candidate.quote,
  );
  await expect(
    evidence(page)
      .locator(".evidence-line")
      .filter({
        has: page.locator("mark"),
      }),
  ).toHaveCount(1);
  await closeEvidence(page);
  await expect(trigger).toBeFocused();
  await expect(checkbox).toBeChecked();
  await expect(page.getByLabel("想找哪些信息", { exact: true })).toHaveValue(
    "下一个问题暂不提交",
  );
  await expect(page.locator(".analysis-candidate")).toContainText(
    candidate.text,
  );
  const after = await projectState(request, project.id);
  expect(after).toEqual(prior);
});

test("manual locators remain unlocated; literal search and explicit version switching are read-only and safe at 390px", async ({
  page,
  request,
}) => {
  const hostile = '<img src=x onerror="window.__evidenceExecuted=1">';
  const project = await fixture(
    request,
    `旧版合成原文\n[a.*] 这里只能按字面查找。\n${hostile}${"长".repeat(900)}\n[a.*] 第二处字面命中。`,
    { linked: true },
  );
  const referencedId = project.sources[0].currentVersionId;
  await updateSource(
    request,
    project.id,
    "当前新版合成原文\n现在的数值待核对。",
  );
  const prior = await projectState(request, project.id);
  await page.addInitScript(() => {
    window.__evidenceExecuted = 0;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openProject(page, project);
  const trigger = page.locator(".claim-card .evidence-link").first();
  await trigger.click();
  await expect(evidence(page)).toContainText(
    "原文件第 7 页，第 2–3 行；这是人工备注",
  );
  await expect(evidence(page).locator(".evidence-content")).toContainText(
    "旧版合成原文",
  );
  await expect(evidence(page).locator(".evidence-content mark")).toHaveCount(0);
  await expect(
    evidence(page).getByLabel("查看依据版本", { exact: true }),
  ).toHaveValue(referencedId);
  const search = evidence(page).getByLabel("在此版本查找", { exact: true });
  await search.fill("[a.*]");
  await expect(evidence(page).locator(".evidence-content mark")).toHaveCount(1);
  await expect(
    evidence(page).locator('[data-evidence-line="2"] mark'),
  ).toHaveText("[a.*]");
  await expect(
    evidence(page).locator(".evidence-search-feedback"),
  ).toContainText("找到 2 处，当前第 1 处。");
  await search.press("Enter");
  await expect(
    evidence(page).locator('[data-evidence-line="4"] mark'),
  ).toHaveText("[a.*]");
  await evidence(page)
    .getByRole("button", { name: "上一个结果", exact: true })
    .click();
  await expect(
    evidence(page).locator('[data-evidence-line="2"] mark'),
  ).toHaveText("[a.*]");
  await search.fill("根本没有的字面词");
  await expect(evidence(page).locator(".evidence-content mark")).toHaveCount(0);
  await search.fill("");
  await evidence(page)
    .getByRole("button", { name: "查看当前版本", exact: true })
    .click();
  await expect(evidence(page).locator(".evidence-content")).toContainText(
    "当前新版合成原文",
  );
  await expect(evidence(page).locator(".evidence-content mark")).toHaveCount(0);
  await evidence(page)
    .getByRole("button", { name: "返回引用版本", exact: true })
    .click();
  await expect(evidence(page).locator(".evidence-content")).toContainText(
    hostile,
  );
  await expect(
    evidence(page).locator(".evidence-content img, .evidence-content script"),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__evidenceExecuted)).toBe(0);
  expect(
    await evidence(page).evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(evidence(page)).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const after = await projectState(request, project.id);
  expect(after).toEqual(prior);
  expect(after.claims[0].evidence[0].versionId).toBe(referencedId);
});

test("an evidence dialog over claim review preserves writing and Escape closes only the upper dialog", async ({
  page,
  request,
}) => {
  const project = await fixture(request, "原版合成资料\n需核对的数值为 10。", {
    linked: true,
  });
  await updateSource(request, project.id, "新版合成资料\n需核对的数值为 12。");
  const prior = await projectState(request, project.id);
  await openProject(page, project);
  await page
    .locator(".claim-card")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true })
    .click();
  const review = page.locator(".review-dialog");
  await expect(
    review.getByLabel("复核后的结论", { exact: true }),
  ).toBeEnabled();
  await review
    .getByLabel("复核后的结论", { exact: true })
    .fill("还没提交的人工结论");
  await review
    .getByLabel("复核说明", { exact: true })
    .fill("还没提交的核对理由");
  const trigger = review
    .getByRole("button", { name: "查看原版依据", exact: true })
    .first();
  await trigger.click();
  await expect(evidence(page)).toBeVisible();
  await expect(evidence(page).locator(".evidence-content")).toContainText(
    "数值为 10",
  );
  await page.keyboard.press("Escape");
  await expect(evidence(page)).not.toBeVisible();
  await expect(review).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(review.getByLabel("复核后的结论", { exact: true })).toHaveValue(
    "还没提交的人工结论",
  );
  await expect(review.getByLabel("复核说明", { exact: true })).toHaveValue(
    "还没提交的核对理由",
  );
  await expect(
    review.getByRole("checkbox", {
      name: "我已核对当前依据和填写内容",
      exact: true,
    }),
  ).not.toBeChecked();
  expect(await projectState(request, project.id)).toEqual(prior);
  await page.keyboard.press("Escape");
  await expect(review).not.toBeVisible();
});

test("source update previews line additions and removals; cancellation and historical comparisons do not save changes", async ({
  page,
  request,
}) => {
  const project = await fixture(request, "共同标题\n合成样本 A=10\n共同结尾", {
    linked: true,
  });
  await updateSource(request, project.id, "共同标题\n合成样本 A=12\n共同结尾");
  const prior = await projectState(request, project.id);
  await openProject(page, project);
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  const modal = page.locator(".modal");
  await modal
    .getByLabel("更新后的资料内容", { exact: true })
    .fill("共同标题\n合成样本 A=15\n新增待核对条件\n共同结尾");
  await modal
    .getByRole("button", { name: "预览变更影响", exact: true })
    .click();
  const diff = modal.locator(".text-diff");
  await expect(diff.locator('[data-kind="removed"]')).toContainText(
    "合成样本 A=12",
  );
  await expect(diff.locator('[data-kind="added"]')).toContainText([
    "合成样本 A=15",
    "新增待核对条件",
  ]);
  await diff.getByRole("button", { name: "完整原文", exact: true }).click();
  await expect(diff.locator(".text-diff-originals")).toContainText(
    "合成样本 A=12",
  );
  await expect(diff.locator(".text-diff-originals")).toContainText(
    "新增待核对条件",
  );
  await modal.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(
    modal.getByLabel("更新后的资料内容", { exact: true }),
  ).toHaveValue("共同标题\n合成样本 A=15\n新增待核对条件\n共同结尾");
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  expect(await projectState(request, project.id)).toEqual(prior);
  await page
    .getByLabel("查看资料版本", { exact: true })
    .selectOption(project.sources[0].currentVersionId);
  const comparison = page.locator(".source-version-comparison");
  await comparison.locator(":scope > summary").click();
  await expect(comparison.locator(".text-diff")).toContainText("合成样本 A=10");
  await expect(comparison.locator(".text-diff")).toContainText("合成样本 A=12");
  await comparison
    .getByLabel("对比目标版本", { exact: true })
    .selectOption(project.sources[0].currentVersionId);
  await expect(comparison.locator(".text-diff")).toContainText(
    "两个版本内容完全一致。",
  );
  expect(await projectState(request, project.id)).toEqual(prior);
});

test("saved report evidence opens its pinned source version and comparison never rewrites the saved report or task status", async ({
  page,
  request,
}) => {
  const project = await fixture(
    request,
    "报告引用的旧版原文\n合成条件尚未核实。",
    { linked: true },
  );
  await saveReport(request, project);
  await updateSource(request, project.id, "当前新版原文\n补充新的合成条件。");
  const prior = await projectState(request, project.id);
  await openProject(page, project, "成果草稿");
  const saved = page.locator(".report-saved").first();
  await saved
    .getByRole("button", { name: "查看保存的内容", exact: true })
    .click();
  await saved
    .locator(".report-snapshot .report-document-details > summary")
    .first()
    .click();
  await saved.locator(".report-snapshot .evidence-link").first().click();
  await expect(evidence(page).locator(".evidence-content")).toContainText(
    "报告引用的旧版原文",
  );
  await evidence(page)
    .getByRole("button", { name: "对比引用版与当前版", exact: true })
    .click();
  await expect(evidence(page).locator(".text-diff")).toContainText(
    "报告引用的旧版原文",
  );
  await expect(evidence(page).locator(".text-diff")).toContainText(
    "当前新版原文",
  );
  await closeEvidence(page);
  await expect(saved.locator(".report-snapshot")).toBeVisible();
  const after = await projectState(request, project.id);
  expect(after.reports).toEqual(prior.reports);
  expect(after.tasks).toEqual(prior.tasks);
  expect(after.claims).toEqual(prior.claims);
  expect(after.artifacts).toEqual(prior.artifacts);
});
