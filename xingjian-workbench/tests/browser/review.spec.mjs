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
      operationId: randomUUID(),
      expectedRevision: current.revision,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function setup(page, request) {
  const loaded = await command(request, "load_demo", {});
  const p = loaded.state.projects.find(
    (item) => item.id === loaded.result.projectId,
  );
  await command(request, "update_source", {
    projectId: p.id,
    sourceId: p.sources[0].id,
    baseVersionId: p.sources[0].currentVersionId,
    content: "第二版合成用电资料：A=55，B=45。须补采样口径。",
  });
  await page.goto("/");
  await page.locator(".project-switch").last().click();
  return p;
}
async function openClaim(page) {
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page
    .locator(".claim-card")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "复核结论", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("复核后的结论", { exact: true })).toBeEnabled();
}
async function fillClaim(
  page,
  text = "新版合成数据中 A 为 55、B 为 45，仍不能推断节能原因。",
) {
  await page.getByLabel("复核后的结论", { exact: true }).fill(text);
  await page
    .getByLabel("当前依据位置", { exact: false })
    .fill("第二版粘贴文本第 1 行");
  await page
    .getByLabel("复核说明", { exact: true })
    .fill("已逐项核对新值；调整数字并保留样本不足的限制。");
  await page
    .getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true })
    .check();
}
async function confirm(page) {
  await page.getByRole("button", { name: "确认本项复核", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

test("review claim, completed task and draft separately; preserve histories, original evidence and sibling warning", async ({
  page,
  request,
}) => {
  const p = await setup(page, request);
  await page
    .getByRole("button", { name: "行动清单", exact: false })
    .first()
    .click();
  await page
    .locator(".task-row")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true })
    .click();
  await expect(page.locator(".review-blocked")).toContainText("先处理这些结论");
  await expect(
    page.getByRole("button", { name: "确认本项复核", exact: true }),
  ).toBeDisabled();
  await page.locator(".review-blocked-link").click();
  await expect(
    page.getByRole("heading", { name: "复核结论", exact: true }),
  ).toBeVisible();
  await fillClaim(page);
  await confirm(page);
  let saved = (await state(request)).projects.find((item) => item.id === p.id);
  expect(saved.claims[0].status).toBe("linked");
  expect(saved.tasks[0].reviewRequired).toBe(true);
  expect(saved.artifacts[0].status).toBe("needs_review");
  const row = page.locator(".task-row").first();
  await row.getByRole("button", { name: "逐项复核", exact: true }).click();
  await expect(page.locator(".claim-compare")).toContainText(
    "原关联版本未记录",
  );
  await page
    .getByLabel("复核后的行动", { exact: true })
    .fill("已整理合成用电表，并核对新数值");
  await page
    .getByLabel("复核说明", { exact: true })
    .fill("已完成的整理工作仍有效，保留完成进度。");
  await page
    .getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true })
    .check();
  await confirm(page);
  await expect(row.locator("select")).toHaveValue("done");
  await expect(
    row.getByRole("button", { name: "复核记录 · v2", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-row").nth(1)).toContainText("需要复核");
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  await page
    .locator(".artifact-card")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true })
    .click();
  await page
    .getByLabel("复核后的草稿标题", { exact: true })
    .fill("修订的合成用电研究草稿");
  await page
    .getByLabel("复核后的草稿内容", { exact: true })
    .fill("新版合成样本 A=55、B=45，尚不足以形成因果结论。");
  await page
    .getByLabel("复核说明", { exact: true })
    .fill("同步已人工复核的结论，保留采样限制。");
  await page
    .getByRole("checkbox", { name: "我已核对当前依据和填写内容", exact: true })
    .check();
  await confirm(page);
  await page.reload();
  await page
    .locator(".artifact-card")
    .first()
    .getByRole("button", { name: "复核记录 · v2", exact: true })
    .click();
  await expect(page.locator(".review-history")).toContainText(
    p.artifacts[0].content,
  );
  await expect(page.locator(".review-history")).toContainText(
    "新版合成样本 A=55",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  await page
    .locator(".claim-card")
    .first()
    .getByRole("button", { name: "复核记录 · v2", exact: true })
    .click();
  await expect(page.locator(".review-history")).toContainText(p.claims[0].text);
  await page.locator(".review-history .evidence-link").last().click();
  await expect(page.locator(".source-content")).toContainText("A教室,60");
  saved = (await state(request)).projects.find((item) => item.id === p.id);
  expect(saved.claims[0].revisions[0].evidence).toEqual(p.claims[0].evidence);
  expect(saved.tasks[0].status).toBe("done");
  expect(saved.tasks[0].reviewRequired).toBe(false);
  expect(saved.tasks[1].reviewRequired).toBe(true);
  expect(saved.artifacts[0].revisions).toHaveLength(2);
  // Draft history must resolve its pinned claim, even after that claim changes again.
  await command(request, "update_source", {
    projectId: p.id,
    sourceId: saved.sources[0].id,
    baseVersionId: saved.sources[0].currentVersionId,
    content: "第三版合成资料：A=50、B=45。",
  });
  const preview = await (
    await request.post("/api/review/preview", {
      headers,
      data: { projectId: p.id, kind: "claim", entityId: saved.claims[0].id },
    })
  ).json();
  const current = (await state(request)).projects.find(
    (item) => item.id === p.id,
  );
  await command(request, "review_claim", {
    projectId: p.id,
    entityId: saved.claims[0].id,
    baseVersion: preview.baseVersion,
    reviewToken: preview.reviewToken,
    reason: "再次更新合成数值。",
    text: "第三版合成数据 A=50、B=45。",
    evidence: saved.claims[0].evidence.map((ref) => ({
      ...ref,
      versionId: current.sources[0].currentVersionId,
    })),
  });
  await page.getByRole("button", { name: "成果草稿", exact: true }).click();
  await page.reload();
  await page
    .locator(".artifact-card")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true })
    .click();
  await page.locator(".review-history > summary").click();
  const pinned = page.locator(".review-history-claim").first();
  await expect(pinned).toContainText("新版合成数据中 A 为 55、B 为 45");
  await expect(pinned).not.toContainText("第三版合成数据 A=50");
  await pinned.getByRole("button").first().click();
  await expect(page.locator(".source-content")).toContainText(
    "第二版合成用电资料：A=55",
  );
});

test("source changes during review preserve input and require explicit refreshed comparison", async ({
  page,
  request,
}) => {
  const p = await setup(page, request);
  await openClaim(page);
  await fillClaim(page, "保留我的人工结论草稿");
  const s = (await state(request)).projects.find((item) => item.id === p.id)
    .sources[0];
  await command(request, "update_source", {
    projectId: p.id,
    sourceId: s.id,
    baseVersionId: s.currentVersionId,
    content: "第三版合成资料：A=50、B=45，刚更新。",
  });
  await page.getByRole("button", { name: "确认本项复核", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("填写已保留");
  await expect(page.getByLabel("复核后的结论", { exact: true })).toHaveValue(
    "保留我的人工结论草稿",
  );
  await expect(
    page.getByRole("button", { name: "确认本项复核", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重新对照最新依据", exact: true })
    .click();
  await expect(page.locator(".review-compare-grid")).toContainText(
    "第三版合成资料",
  );
  await expect(page.getByLabel("复核后的结论", { exact: true })).toHaveValue(
    "保留我的人工结论草稿",
  );
  await expect(
    page.getByRole("checkbox", {
      name: "我已核对当前依据和填写内容",
      exact: true,
    }),
  ).not.toBeChecked();
  await fillClaim(page, "第三版合成数据 A=50、B=45，仍需更多依据。");
  await confirm(page);
  const saved = (await state(request)).projects.find(
    (item) => item.id === p.id,
  );
  expect(saved.claims[0].evidence[0].versionId).toBe(
    saved.sources[0].currentVersionId,
  );
  expect(saved.claims[0].revisions).toHaveLength(2);
});

test("review lost response retries with the same operation and creates only one revision", async ({
  page,
  request,
}) => {
  const p = await setup(page, request);
  await openClaim(page);
  await fillClaim(page);
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "确认本项复核", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不会重复增加内容版本");
  await confirm(page);
  expect(
    (await state(request)).projects.find((item) => item.id === p.id).claims[0]
      .revisions,
  ).toHaveLength(2);
});

test("narrow review comparison, cancel, keyboard focus and retrying preview are usable", async ({
  page,
  request,
}) => {
  const p = await setup(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  let intercepted = false;
  await page.route("**/api/review/preview", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "资料与依据", exact: true }).click();
  const trigger = page
    .locator(".claim-card")
    .first()
    .getByRole("button", { name: "逐项复核", exact: true });
  await trigger.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "重新对照最新依据", exact: true })
    .click();
  await expect(page.getByLabel("复核后的结论", { exact: true })).toBeEnabled();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await fillClaim(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const saved = (await state(request)).projects.find(
    (item) => item.id === p.id,
  );
  expect(saved.claims[0].status).toBe("needs_review");
  expect(saved.claims[0].revisions).toBeUndefined();
});
