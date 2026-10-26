import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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
async function openProject(page, project) {
  await page.goto("/");
  await page.getByRole("button", { name: project.title, exact: true }).click();
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
}
async function demo(page, request) {
  const response = await command(request, "load_demo", {});
  const project = response.state.projects.find(
    (item) => item.id === response.result.projectId,
  );
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  return project;
}
const panel = (page) => page.locator(".report-panel");
const ack = (page) =>
  panel(page).getByRole("checkbox", {
    name: "我已查看上述提醒，确认将这些内容作为进展草稿保存。",
    exact: true,
  });
const previewButton = (page) =>
  panel(page).getByRole("button", { name: /^(预览报告|重新预览报告)$/ });
const saveButton = (page) =>
  panel(page).getByRole("button", { name: "保存报告版本", exact: true });
async function select(page, project, title = "浏览器验证 · 研学报告") {
  await panel(page).getByLabel("报告标题", { exact: true }).fill(title);
  await panel(page)
    .getByRole("checkbox", {
      name: `加入报告：${project.artifacts[0].title}`,
      exact: true,
    })
    .check();
}
async function savePreview(page) {
  await previewButton(page).click();
  await expect(
    panel(page).getByRole("heading", { name: "核对这份报告", exact: true }),
  ).toBeFocused();
  if (await ack(page).count()) await ack(page).check();
  await saveButton(page).click();
  await expect(panel(page).locator(".report-saved")).toHaveCount(1);
}
async function downloaded(page, button) {
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  return readFile(await download.path());
}

test("report section order, warning acknowledgement and lost-response retry save exactly one immutable version", async ({
  page,
  request,
}) => {
  const project = await demo(page, request);
  const second = await command(request, "add_artifact", {
    projectId: project.id,
    title: "后续研究方向（合成）",
    content: "下一步补充真实采样。",
    claimIds: [],
  });
  await page.reload();
  const secondArtifact = second.state.projects
    .find((item) => item.id === project.id)
    .artifacts.at(-1);
  await select(page, project);
  await panel(page)
    .getByRole("checkbox", {
      name: `加入报告：${secondArtifact.title}`,
      exact: true,
    })
    .check();
  await panel(page)
    .getByRole("button", {
      name: `上移报告章节：${secondArtifact.title}`,
      exact: true,
    })
    .click();
  await panel(page)
    .getByRole("checkbox", { name: /附上关联行动/ })
    .uncheck();
  await previewButton(page).click();
  await expect(
    panel(page).locator(".report-preview .report-document-section").nth(1),
  ).toContainText(secondArtifact.title);
  await expect(saveButton(page)).toBeDisabled();
  await expect(ack(page)).not.toBeChecked();
  expect(
    (await state(request)).projects.find((item) => item.id === project.id)
      .reports,
  ).toBeUndefined();
  await ack(page).check();
  let lost = false;
  const operationIds = [];
  await page.route("**/api/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type !== "save_report") return route.continue();
    operationIds.push(body.operationId);
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await saveButton(page).click();
  await expect(panel(page).locator(".report-error")).toContainText(
    "避免重复版本",
  );
  await saveButton(page).click();
  await expect(panel(page).locator(".report-saved")).toHaveCount(1);
  expect(operationIds).toHaveLength(2);
  expect(operationIds[0]).toBe(operationIds[1]);
  const saved = (await state(request)).projects.find(
    (item) => item.id === project.id,
  );
  expect(saved.reports).toHaveLength(1);
  expect(saved.reports[0].spec.sections.map((item) => item.artifactId)).toEqual(
    [secondArtifact.id, project.artifacts[0].id],
  );
  expect(saved.reports[0].spec.tasks).toEqual([]);
  expect(saved.tasks).toEqual(project.tasks);
  expect(saved.claims).toEqual(project.claims);
  await page.reload();
  await expect(panel(page).locator(".report-saved")).toHaveCount(1);
  await panel(page)
    .getByRole("button", { name: "查看保存的内容", exact: true })
    .click();
  await expect(panel(page).locator(".report-snapshot")).toContainText(
    "下一步补充真实采样。",
  );
  await panel(page).locator(".report-technical > summary").click();
  const json = JSON.parse(
    (
      await downloaded(
        page,
        panel(page).getByRole("button", { name: "下载 JSON", exact: true }),
      )
    ).toString("utf8"),
  );
  expect(json).toEqual(saved.reports[0]);
});

test("a source change rejects stale report saving while keeping title, section order and options", async ({
  page,
  request,
}) => {
  const project = await demo(page, request);
  await select(page, project, "保留这份标题与章节");
  await panel(page)
    .getByRole("checkbox", { name: /附上关联行动/ })
    .uncheck();
  await previewButton(page).click();
  await ack(page).check();
  await command(request, "update_source", {
    projectId: project.id,
    sourceId: project.sources[0].id,
    baseVersionId: project.sources[0].currentVersionId,
    content: `${project.sources[0].versions[0].content}\n新增合成记录，需重新核对。`,
  });
  await saveButton(page).click();
  await expect(panel(page).locator(".report-error")).toContainText(
    "填写和章节顺序已保留",
  );
  await expect(panel(page).getByLabel("报告标题", { exact: true })).toHaveValue(
    "保留这份标题与章节",
  );
  await expect(
    panel(page).getByRole("checkbox", { name: /附上关联行动/ }),
  ).not.toBeChecked();
  await expect(
    panel(page).getByRole("checkbox", {
      name: `加入报告：${project.artifacts[0].title}`,
      exact: true,
    }),
  ).toBeChecked();
  await expect(saveButton(page)).toBeDisabled();
  expect(
    (await state(request)).projects.find((item) => item.id === project.id)
      .reports,
  ).toBeUndefined();
  await previewButton(page).click();
  await expect(panel(page).locator(".report-warnings")).toContainText("复核");
  await expect(ack(page)).not.toBeChecked();
  await ack(page).check();
  await saveButton(page).click();
  await expect(panel(page).locator(".report-saved")).toHaveCount(1);
});

test("saved HTML stays identical after source updates and the UI identifies historical content", async ({
  page,
  request,
}) => {
  const project = await demo(page, request);
  await select(page, project);
  await savePreview(page);
  const htmlButton = panel(page).getByRole("button", {
    name: "下载 HTML",
    exact: true,
  });
  const before = await downloaded(page, htmlButton);
  const report = (await state(request)).projects.find(
    (item) => item.id === project.id,
  ).reports[0];
  await command(request, "update_source", {
    projectId: project.id,
    sourceId: project.sources[0].id,
    baseVersionId: project.sources[0].currentVersionId,
    content: "后来的合成资料，不能改写已经保存的报告。",
  });
  await page.reload();
  await expect(panel(page).locator(".report-changed")).toContainText(
    "相关内容已有变化",
  );
  const after = await downloaded(page, htmlButton);
  expect(after.equals(before)).toBeTruthy();
  expect(
    (await state(request)).projects.find((item) => item.id === project.id)
      .reports[0],
  ).toEqual(report);
  await panel(page)
    .getByRole("button", { name: "查看保存的内容", exact: true })
    .click();
  await expect(panel(page).locator(".report-snapshot")).toContainText(
    report.spec.sections[0].content,
  );
});

test("hostile report text remains text in the downloaded offline HTML", async ({
  page,
  request,
}) => {
  const created = await command(request, "create_project", {
    title: `离线报告文本验证 ${randomUUID()}`,
    goal: "人工录入内容按纯文字保留",
    deadline: null,
  });
  const projectId = created.result.projectId;
  const attack =
    '<img src="https://invalid.example.test/leak" onerror="window.reportInjected=true"><script>window.reportInjected=true</script> 中文 & < >';
  const artifact = await command(request, "add_artifact", {
    projectId,
    title: "输入文本验证",
    content: attack,
    claimIds: [],
  });
  const project = artifact.state.projects.find((item) => item.id === projectId);
  await openProject(page, project);
  await select(page, project, "安全保留原文");
  await savePreview(page);
  const html = (
    await downloaded(
      page,
      panel(page).getByRole("button", { name: "下载 HTML", exact: true }),
    )
  ).toString("utf8");
  expect(html).toContain("Content-Security-Policy");
  const viewer = await page.context().newPage();
  const requests = [];
  await viewer.route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await viewer.setContent(html, { waitUntil: "load" });
  await expect(viewer.locator("body")).toContainText(attack);
  expect(await viewer.evaluate(() => window.reportInjected)).toBeUndefined();
  await expect(viewer.locator("script, img, iframe")).toHaveCount(0);
  expect(requests).toEqual([]);
  await viewer.close();
});

test("PDF generation is explicit, survives reopening and downloads a real printable PDF", async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const project = await demo(page, request);
  await select(page, project, "可打印的中文进展报告");
  await savePreview(page);
  let automaticDownloads = 0;
  page.on("download", () => {
    automaticDownloads += 1;
  });
  const prepare = panel(page).getByRole("button", {
    name: "准备 PDF",
    exact: true,
  });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await page.reload();
  const download = panel(page).getByRole("button", {
    name: "下载 PDF",
    exact: true,
  });
  await expect(download).toBeVisible({ timeout: 65000 });
  expect(automaticDownloads).toBe(0);
  const bytes = await downloaded(page, download);
  expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);
  expect(
    (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length,
  ).toBeGreaterThanOrEqual(1);
  const saved = (await state(request)).projects.find(
    (item) => item.id === project.id,
  );
  expect(saved.reports).toHaveLength(1);
  expect(saved.tasks).toEqual(project.tasks);
});

test("PDF status failures can recover and a failed render exposes an explicit retry", async ({
  page,
  request,
}) => {
  const project = await demo(page, request);
  await select(page, project);
  let statusUnavailable = true;
  await page.route("**/api/reports/pdf-status", (route) => {
    if (statusUnavailable) return route.abort("failed");
    return route.fulfill({
      status: 200,
      json: {
        status: "failed",
        attempt: 1,
        error: "模拟的渲染失败",
        createdAt: "2026-10-26T02:00:00.000Z",
        finishedAt: "2026-10-26T02:00:01.000Z",
        engine: "chromium-print-v1",
      },
    });
  });
  await savePreview(page);
  await expect(
    panel(page).getByRole("button", { name: "刷新 PDF 状态", exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "准备 PDF", exact: true }),
  ).toBeDisabled();
  statusUnavailable = false;
  await panel(page)
    .getByRole("button", { name: "刷新 PDF 状态", exact: true })
    .click();
  await expect(panel(page).locator(".report-pdf-status")).toContainText(
    "模拟的渲染失败",
  );
  await expect(
    panel(page).getByRole("button", { name: "重试生成 PDF", exact: true }),
  ).toBeEnabled();
  await expect(
    panel(page).getByRole("button", { name: "下载 HTML", exact: true }),
  ).toBeEnabled();
});

test("390px report flow preserves inputs after preview failure, supports keyboard acknowledgement and avoids overflow", async ({
  page,
  request,
}) => {
  const project = await demo(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await select(page, project, "窄屏研究进展");
  let failed = false;
  await page.route("**/api/reports/preview", async (route) => {
    if (!failed) {
      failed = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await previewButton(page).click();
  await expect(panel(page).locator(".report-error")).toBeFocused();
  await expect(panel(page).getByLabel("报告标题", { exact: true })).toHaveValue(
    "窄屏研究进展",
  );
  await previewButton(page).click();
  await expect(
    panel(page).getByRole("heading", { name: "核对这份报告", exact: true }),
  ).toBeFocused();
  await ack(page).focus();
  await page.keyboard.press("Space");
  await expect(ack(page)).toBeChecked();
  await panel(page)
    .getByLabel("报告标题", { exact: true })
    .fill("修改后需重新核对");
  await expect(panel(page).locator(".report-preview")).toHaveCount(0);
  await previewButton(page).click();
  await expect(ack(page)).not.toBeChecked();
  await ack(page).check();
  await saveButton(page).click();
  await expect(panel(page).locator(".report-saved")).toHaveCount(1);
  await panel(page)
    .getByRole("button", { name: "查看保存的内容", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
});
