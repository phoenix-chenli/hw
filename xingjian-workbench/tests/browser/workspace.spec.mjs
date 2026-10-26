import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request) {
  const r = await request.get("/api/state", { headers });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function command(request, type, payload) {
  const current = await state(request);
  const r = await request.post("/api/commands", {
    headers,
    data: {
      type,
      payload,
      operationId: randomUUID(),
      expectedRevision: current.revision,
    },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function demo(page, request) {
  const response = await command(request, "load_demo", {});
  const p = response.state.projects.find(
    (p) => p.id === response.result.projectId,
  );
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
  return p;
}
async function edit(page, content) {
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  await page.getByLabel("更新后的资料内容").fill(content);
  await page.getByRole("button", { name: "预览变更影响", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "确认这次资料变更" }),
  ).toBeVisible();
}

test("create project and hand-enter linked source, claim, task, and draft", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("课程研究浏览器验证");
  await page
    .getByLabel("研究目标", { exact: true })
    .fill("从真实操作建立对象关系");
  await page.getByRole("button", { name: "建立项目", exact: true }).click();
  await page
    .getByRole("button", { name: "添加第一份资料", exact: true })
    .click();
  await page.getByLabel("资料标题", { exact: true }).fill("合成测试资料");
  await page
    .getByLabel("资料文字", { exact: true })
    .fill('<script>alert("不得执行")</script>\nA=60；B=45。合成数据。');
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await expect(page.locator(".source-content")).toContainText("<script>");
  await page.getByRole("button", { name: "记录结论", exact: true }).click();
  await page
    .getByLabel("结论或待核查的发现", { exact: true })
    .fill("A 的合成值大于 B，需核对实际资料。");
  await page.getByLabel("原文位置", { exact: true }).fill("第 2 行");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".claim-card")).toHaveCount(1);
  await page.getByRole("button", { name: "转成行动", exact: true }).click();
  await page.getByLabel("具体要做什么", { exact: true }).fill("核查采样口径");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  await page.getByRole("button", { name: "建立草稿", exact: true }).click();
  await page.getByLabel("草稿标题", { exact: true }).fill("阶段草稿");
  await page
    .getByLabel("草稿内容", { exact: true })
    .fill("待补实际数据，不形成正式结论。");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  await expect(page.locator(".artifact-card")).toContainText("阶段草稿");
});

test("preview is cancellable; confirmation preserves old versions and flags only linked objects", async ({
  page,
  request,
}) => {
  const p = await demo(page, request),
    source = p.sources[0];
  const next = source.versions[0].content.replace("A教室,60", "A教室,72");
  await edit(page, next);
  await expect(page.locator(".impact-groups")).toContainText("用电研究草稿");
  expect(
    (await state(request)).projects.find((x) => x.id === p.id).sources[0]
      .versions.length,
  ).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await state(request)).projects.find((x) => x.id === p.id).sources[0]
      .versions.length,
  ).toBe(1);
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  await page.getByLabel("更新后的资料内容").fill(next);
  await page.getByRole("button", { name: "预览变更影响", exact: true }).click();
  await page
    .getByRole("button", { name: "确认保存新版本", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const saved = (await state(request)).projects.find((x) => x.id === p.id);
  expect(saved.sources[0].versions).toHaveLength(2);
  expect(saved.claims[0].status).toBe("needs_review");
  expect(saved.claims[1].status).toBe("linked");
  expect(saved.tasks[0].status).toBe("done");
  expect(saved.tasks[0].reviewRequired).toBe(true);
  expect(saved.tasks[2].reviewRequired).toBe(false);
  expect(saved.artifacts[0].content).toBe(p.artifacts[0].content);
  await page.getByLabel("查看资料版本").selectOption(source.currentVersionId);
  await expect(page.locator(".source-content")).toContainText("A教室,60");
});

test("concurrent source change keeps draft and requires a fresh preview", async ({
  page,
  request,
}) => {
  const p = await demo(page, request),
    s = p.sources[0];
  const myDraft = s.versions[0].content + "\n我的补充草稿。";
  await edit(page, myDraft);
  await command(request, "update_source", {
    projectId: p.id,
    sourceId: s.id,
    baseVersionId: s.currentVersionId,
    content: s.versions[0].content + "\n另一页面已保存。",
  });
  await page
    .getByRole("button", { name: "确认保存新版本", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("输入已保留");
  await expect(page.getByLabel("更新后的资料内容")).toHaveValue(myDraft);
  await page.getByRole("button", { name: "预览变更影响", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "保存前资料差异", exact: true }),
  ).toContainText("另一页面已保存");
  await page
    .getByRole("button", { name: "确认保存新版本", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await state(request)).projects.find((x) => x.id === p.id).sources[0]
      .versions,
  ).toHaveLength(3);
});

test("lost response can be retried using the same operation without duplicate records", async ({
  page,
  request,
}) => {
  const p = await demo(page, request);
  await page
    .getByRole("button", { name: "行动清单", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "添加行动", exact: true }).click();
  await page
    .getByLabel("具体要做什么", { exact: true })
    .fill("重试也只保存一次");
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const saved = (await state(request)).projects.find((x) => x.id === p.id);
  expect(
    saved.tasks.filter((x) => x.title === "重试也只保存一次"),
  ).toHaveLength(1);
});

test("390px layout, keyboard dialog and reduced motion remain usable", async ({
  page,
  request,
}) => {
  await demo(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "更新资料", exact: true }).click();
  await expect(page.getByLabel("更新后的资料内容")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "更新资料", exact: true }),
  ).toBeFocused();
});
