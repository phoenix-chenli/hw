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
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function setup(
  page,
  request,
  content = "名称,用电量(kWh)\nA,0.1\nB,0.2",
) {
  const created = await command(request, "create_project", {
    title: "本地分析验证 · 合成资料",
    goal: "保留版本与计算依据",
    deadline: null,
  });
  const projectId = created.result.projectId;
  await command(request, "add_source", {
    projectId,
    title: "教室数据（合成）",
    kind: "table",
    content,
  });
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: "资料分析", exact: true }).click();
  return (await state(request)).projects.find(
    (project) => project.id === projectId,
  );
}
async function calculate(page) {
  await page.getByRole("button", { name: "表格计算", exact: true }).click();
  await expect(page.getByLabel("数值列", { exact: true })).toHaveValue(
    "用电量(kWh)",
  );
  await page
    .getByRole("button", { name: "计算并生成提案", exact: true })
    .click();
  await expect(page.locator(".analysis-candidate")).toHaveCount(1);
}

test("calculation proposal is reviewable and confirmed once after a lost response", async ({
  page,
  request,
}) => {
  const p = await setup(page, request);
  await calculate(page);
  await expect(page.locator(".calculation-detail")).toContainText("0.3");
  expect(
    (await state(request)).projects.find((project) => project.id === p.id)
      .claims,
  ).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "确认加入所选内容", exact: true }),
  ).toBeDisabled();
  await page.locator(".analysis-task input").check();
  await expect(
    page.getByRole("checkbox", { name: "选择候选 claim-1", exact: true }),
  ).toBeChecked();
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "确认加入所选内容", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("不会重复加入");
  await page
    .getByRole("button", { name: "确认加入所选内容", exact: true })
    .click();
  await expect(page.locator(".analysis-result")).toContainText(
    "这份提案不会再次写入",
  );
  const saved = (await state(request)).projects.find(
    (project) => project.id === p.id,
  );
  expect(saved.claims).toHaveLength(1);
  expect(saved.tasks).toHaveLength(1);
  await page.reload();
  await page.locator(".project-switch").last().click();
  await page.getByRole("button", { name: "资料分析", exact: true }).click();
  await expect(page.locator(".analysis-result")).toContainText(
    "已加入 1 条结论、1 项行动",
  );
  await page.locator(".analysis-evidence").click();
  await expect(
    page.locator(".evidence-dialog .evidence-content"),
  ).toContainText("A,0.1");
});

test("source edit while viewing a proposal requires refresh and rerun before acceptance", async ({
  page,
  request,
}) => {
  const p = await setup(page, request),
    s = p.sources[0];
  await calculate(page);
  await page
    .getByRole("checkbox", { name: "选择候选 claim-1", exact: true })
    .check();
  await command(request, "update_source", {
    projectId: p.id,
    sourceId: s.id,
    baseVersionId: s.currentVersionId,
    content: "名称,用电量(kWh)\nA,1\nB,2",
  });
  await page
    .getByRole("button", { name: "确认加入所选内容", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("输入已保留");
  await expect(page.locator(".analysis-result")).toContainText(
    "这份分析使用的资料已更新",
  );
  await expect(
    page.getByRole("button", { name: "确认加入所选内容", exact: true }),
  ).toBeDisabled();
  expect(
    (await state(request)).projects.find((project) => project.id === p.id)
      .claims,
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "按当前版本重新分析", exact: false })
    .click();
  await expect(page.locator(".analysis-candidate")).toContainText("为 3");
  await page
    .getByRole("checkbox", { name: "选择候选 claim-1", exact: true })
    .check();
  await page
    .getByRole("button", { name: "确认加入所选内容", exact: true })
    .click();
  await expect(page.locator(".analysis-result")).toContainText(
    "已加入 1 条结论、0 项行动",
  );
  const saved = (await state(request)).projects.find(
    (project) => project.id === p.id,
  );
  expect(saved.analyses).toHaveLength(2);
  expect(saved.claims[0].evidence[0].versionId).toBe(
    saved.sources[0].currentVersionId,
  );
});

test("no-match search gives a gap task; invalid CSV can recover; 390px layout is usable", async ({
  page,
  request,
}) => {
  await setup(
    page,
    request,
    "访谈笔记：用电数据仍需补充。<script>不会执行</script>",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "表格计算", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("CSV");
  await expect(
    page.getByRole("button", { name: "计算并生成提案", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "查找依据", exact: true }).click();
  await page.getByLabel("想找哪些信息", { exact: true }).fill("实际采样");
  await page
    .getByRole("button", { name: "查找并生成提案", exact: true })
    .click();
  await expect(page.locator(".analysis-gaps")).toContainText(
    "不等于资料中没有答案",
  );
  await expect(page.locator(".analysis-candidate")).toHaveCount(0);
  await page.locator(".analysis-task input").check();
  await page
    .getByRole("button", { name: "确认加入所选内容", exact: true })
    .click();
  await expect(page.locator(".analysis-result")).toContainText(
    "已加入 0 条结论、1 项行动",
  );
  await page.getByLabel("想找哪些信息", { exact: true }).fill("用电");
  await page
    .getByRole("button", { name: "查找并生成提案", exact: true })
    .click();
  await expect(page.locator(".analysis-candidate")).toContainText(
    "未作语义判断",
  );
  await expect(page.locator(".analysis-candidate")).toContainText("<script>");
  await expect(
    page.getByRole("heading", { name: "分析提案", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
