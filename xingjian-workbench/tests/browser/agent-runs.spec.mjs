import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceStore } from "../../server/store.mjs";
import { createApp } from "../../server/http.mjs";
import { createAgentArtsProvider } from "../../server/agentarts-client.mjs";
import { createContractTestProvider } from "../fixtures/agent-provider.mjs";

const headers = { "X-Xingjian-Client": "workspace-v1" };
async function state(request, base) {
  return (await request.get(`${base}/api/state`, { headers })).json();
}
async function command(request, base, type, payload) {
  const workspace = await state(request, base);
  const response = await request.post(`${base}/api/commands`, {
    headers,
    data: { type, payload, expectedRevision: workspace.revision, operationId: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function withWorkbench(callback, { disabled = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xingjian-agent-browser-"));
  const store = new WorkspaceStore(join(dir, "workspace.json"));
  const provider = disabled ? createAgentArtsProvider({ env: {} }) : createContractTestProvider();
  const server = createApp(store, { staticDir: resolve("dist"), agentProvider: provider });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await callback({ base: `http://127.0.0.1:${server.address().port}`, store, provider });
  } finally {
    await server.agentRuns?.close?.();
    await server.reportJobs.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function setup(page, request, base) {
  const created = await command(request, base, "create_project", {
    title: "云端协议浏览器验证 · 合成资料",
    goal: "区分真实平台与合成测试，保留引用和确认记录",
    deadline: null,
  });
  const projectId = created.result.projectId;
  await command(request, base, "add_source", {
    projectId,
    title: "访谈原文（合成）",
    kind: "note",
    content: "访谈原文：需要补充采样资料。\r\n这是一份合成验证材料，不是真实研究结果。",
  });
  await page.goto(base);
  await page.getByRole("button", { name: "资料分析", exact: true }).click();
  await expect(page.locator(".cloud-analysis")).toBeVisible();
  return (await state(request, base)).projects.find((entry) => entry.id === projectId);
}
async function fixtureRun(page, question = "请说明资料缺口") {
  const panel = page.locator(".cloud-analysis");
  await expect(panel.locator(".cloud-config")).toContainText("本地合成协议测试");
  await page.getByLabel("本次研究问题", { exact: true }).fill(question);
  await page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true }).check();
  await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
  await expect(panel.locator(".cloud-candidate")).toHaveCount(1);
}

test("unconfigured production mode records a blocked request without invoking any provider", async ({ page, request }) => {
  await withWorkbench(async ({ base }) => {
    const project = await setup(page, request, base);
    const panel = page.locator(".cloud-analysis");
    await expect(panel.locator(".cloud-config")).toContainText("当前不会发送资料");
    await page.getByLabel("本次研究问题", { exact: true }).fill("先保存这个研究问题，不发送资料");
    await panel.getByRole("button", { name: "保存分析请求", exact: true }).click();
    await expect(panel.locator(".cloud-run-status")).toContainText("尚未发送");
    await expect(page.getByLabel("本次研究问题", { exact: true })).toHaveValue("先保存这个研究问题，不发送资料");
    const saved = (await state(request, base)).projects.find((entry) => entry.id === project.id);
    expect(saved.agentRuns).toHaveLength(1);
    expect(saved.agentRuns[0].status).toBe("blocked");
    expect(saved.agentRuns[0].invocation).toBeNull();
    expect(saved.agentRuns[0].snapshot.evidence[0].quote).toContain("合成验证材料");
    expect(saved.claims).toHaveLength(0);
    expect(saved.tasks).toHaveLength(0);
    await page.reload();
    await expect(page.locator(".cloud-run-status")).toContainText("尚未发送");
    await expect(page.locator(".cloud-run-question")).toContainText("先保存这个研究问题");
    await panel.getByRole("button", { name: "用当前资料准备重新分析", exact: false }).click();
    await expect(page.getByLabel("本次研究问题", { exact: true })).toBeFocused();
    expect((await state(request, base)).projects[0].agentRuns).toHaveLength(1);
  }, { disabled: true });
});

test("synthetic proposal requires consent, evidence acknowledgement and dependency selection; lost confirmation is safe", async ({ page, request }) => {
  await withWorkbench(async ({ base, provider }) => {
    const project = await setup(page, request, base);
    const panel = page.locator(".cloud-analysis");
    await page.getByLabel("本次研究问题", { exact: true }).fill("请说明资料缺口");
    await expect(panel.getByRole("button", { name: "运行本地协议测试", exact: true })).toBeDisabled();
    await fixtureRun(page);
    await expect(panel).toContainText("此记录来自本地合成协议测试");
    await panel.locator(".cloud-evidence button").click();
    await expect(page.locator(".evidence-dialog .evidence-content mark")).toHaveText(["访谈原文：需要补充采样资料。", "这是一份合成验证材料，不是真实研究结果。"]);
    await page.getByRole("button", { name: "返回继续核对", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择云端行动 t1", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "选择云端结论 c1", exact: true })).toBeChecked();
    await expect(panel.getByRole("button", { name: "确认保存云端所选内容", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "我已核对原文，理解引用校验不代表结论正确", exact: true }).check();
    let operationId;
    let lost = false;
    await page.route("**/api/commands", async (route) => {
      const command = route.request().postDataJSON();
      if (command.type !== "accept_agent_run") return route.continue();
      if (!lost) {
        lost = true;
        operationId = command.operationId;
        await route.fetch();
        await route.abort("failed");
      } else {
        expect(command.operationId).toBe(operationId);
        await route.continue();
      }
    });
    await panel.getByRole("button", { name: "确认保存云端所选内容", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("不会重复创建记录");
    await panel.getByRole("button", { name: "确认保存云端所选内容", exact: true }).click();
    await expect(panel).toContainText("本次提案已锁定");
    const saved = (await state(request, base)).projects.find((entry) => entry.id === project.id);
    expect(saved.claims).toHaveLength(1);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].claimIds).toEqual([saved.claims[0].id]);
    expect(saved.claims[0].evidence[0].versionId).toBe(project.sources[0].currentVersionId);
    expect(saved.agentRuns[0].provider).toBe("contract-test");
    expect(provider.calls).toBe(1);
    await page.reload();
    await expect(page.locator(".cloud-analysis")).toContainText("已保存 1 条结论、1 项行动");
  });
});

test("damaged success receipt reuses run operation; stale proposal refresh keeps selections but prevents acceptance", async ({ page, request }) => {
  await withWorkbench(async ({ base, provider }) => {
    const project = await setup(page, request, base);
    const panel = page.locator(".cloud-analysis");
    let startId;
    let lost = false;
    await page.route("**/api/agent-runs", async (route) => {
      const input = route.request().postDataJSON();
      if (!lost) {
        lost = true;
        startId = input.operationId;
        await route.fetch();
        // The server committed successfully, but the transport returned a damaged
        // success receipt. Retrying must not dispatch a second model invocation.
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: "{damaged-success-receipt",
        });
      } else {
        expect(input.operationId).toBe(startId);
        await route.continue();
      }
    });
    await page.getByLabel("本次研究问题", { exact: true }).fill("重试同一条分析请求");
    await page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true }).check();
    await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("复用操作标识");
    await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
    await expect(panel.locator(".cloud-candidate")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "选择云端结论 c1", exact: true }).check();
    await page.getByRole("checkbox", { name: "我已核对原文，理解引用校验不代表结论正确", exact: true }).check();
    const source = project.sources[0];
    await command(request, base, "update_source", { projectId: project.id, sourceId: source.id, baseVersionId: source.currentVersionId, content: "修订后的合成资料：需要重新核对范围。" });
    await panel.getByRole("button", { name: "确认保存云端所选内容", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("输入与勾选已保留");
    await expect(panel).toContainText("资料已更新。这份记录保留原版依据");
    await expect(page.getByRole("checkbox", { name: "选择云端结论 c1", exact: true })).toBeChecked();
    await expect(panel.getByRole("button", { name: "确认保存云端所选内容", exact: true })).toBeDisabled();
    const saved = (await state(request, base)).projects.find((entry) => entry.id === project.id);
    expect(saved.agentRuns).toHaveLength(1);
    expect(saved.claims).toHaveLength(0);
    expect(provider.calls).toBe(1);
    await panel.getByRole("button", { name: "用当前资料准备重新分析", exact: false }).click();
    await expect(page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true })).not.toBeChecked();
    await expect(page.getByLabel("本次研究问题", { exact: true })).toHaveValue("重试同一条分析请求");
  });
});

test("clarification, invalid evidence and interruption stay distinct; narrow layout and original input remain usable", async ({ page, request }) => {
  await withWorkbench(async ({ base, provider }) => {
    await setup(page, request, base);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const panel = page.locator(".cloud-analysis");
    await page.getByLabel("本次研究问题", { exact: true }).fill("[needs_input] 请先询问范围");
    await page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true }).check();
    await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
    await expect(panel.locator(".cloud-questions")).toContainText("哪个时间范围");
    await expect(panel.locator(".cloud-candidate")).toHaveCount(0);
    expect(provider.calls).toBe(1);
    await panel.getByRole("button", { name: "带回问题，补充后重新提交", exact: false }).click();
    await expect(page.getByLabel("本次研究问题", { exact: true })).toBeFocused();
    await page.getByLabel("本次研究问题", { exact: true }).fill("[invalid_evidence] 拒绝未知引用");
    await page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true }).check();
    await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
    await expect(panel.locator(".cloud-run-status")).toContainText("运行失败");
    await expect(panel.locator(".cloud-candidate")).toHaveCount(0);
    await page.getByLabel("本次研究问题", { exact: true }).fill("[wait] 停止本地等待");
    await page.getByRole("checkbox", { name: "同意运行本地合成协议测试（不发送至云端）", exact: true }).check();
    await panel.getByRole("button", { name: "运行本地协议测试", exact: true }).click();
    await expect(panel.locator(".cloud-running")).toBeVisible();
    await panel.getByRole("button", { name: "停止本地等待", exact: true }).click();
    await expect(panel.locator(".cloud-run-status")).toContainText("已中断");
    await expect(panel).toContainText("不能保证云端执行或计费立即停止");
    await expect(page.getByLabel("本次研究问题", { exact: true })).toHaveValue("[wait] 停止本地等待");
    const saved = await state(request, base);
    expect(saved.projects[0].agentRuns.map((run) => run.status)).toEqual(["needs_input", "failed", "interrupted"]);
    expect(saved.projects[0].claims).toHaveLength(0);
    expect(provider.calls).toBe(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
