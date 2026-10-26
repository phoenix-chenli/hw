# 行简 · 研学工作台

面向华为 ICT 创新赛赛题 2「基于华为云 AgentArts 智能体开发平台的 Agent 设计和应用」。

把研究资料、结论依据、后续行动与成果草稿连接起来：资料更新后逐项复核，任务中断后留下继续点，安排时间前预览冲突并确认。

## 从哪里开始

- [项目说明书与修改计划（原 Word）](行简研学_项目说明书与修改计划_20261023.docx)：保留原文件，包含整体构想与计划。
- [可运行工程与使用指南](xingjian-workbench/README.md)：当前实现及操作入口。
- [本阶段功能与实际截图](xingjian-workbench/docs/MILESTONE-A.md)：研究问题、固定资料快照、运行记录和严格证据校验；默认不发起云端调用。
- [AgentArts 工作流与首次真实验收](xingjian-workbench/docs/AGENTARTS-WORKFLOW.md)：服务端配置、工作流提示词和仍待执行的真实连通性检查。
- [待复核清单](xingjian-workbench/docs/PHASE-05B.md)：筛选关联资料、先核对依赖结论，再分别确认行动和草稿。
- [原文核对与资料差异](xingjian-workbench/docs/PHASE-05A.md)：原地查看引用原文、保留未保存填写、对比新旧资料和版本内查找。
- [报告导出与样例](xingjian-workbench/docs/PHASE-04.md)：选择章节、核对依据、保存报告版本、下载 HTML 与 PDF。
- [上一阶段任务推进](xingjian-workbench/docs/PHASE-03B.md)：任务继续点、时间安排预览、课内提醒与失败恢复。
- [后续开发路线](xingjian-workbench/docs/ROADMAP.md)：交互深化、AgentArts 接入等待办。
- [本次同步说明](同步说明_里程碑A_20261026.md)：代码来源、验证与保留范围。

## 本地启动

需要 Node.js 22.14 或更新版本，在仓库目录执行：

```sh
cd xingjian-workbench
npm ci
npm run build
npm start
```

打开 http://127.0.0.1:8787，选择「体验一个示例」即可操作。示例为合成资料；你创建的内容保存在本机 `.runtime/workspace.json`，不提交到 GitHub。

无需 DevEco 或手机原生 SDK。当前是单用户本地 Web 工作台；已准备 AgentArts 受限调用适配与工作流约定，默认关闭，真实平台链路、生产授权与在线部署仍未完成。不能将配置齐备或合成测试视为平台验收。已支持受限 JATS 标签与固定模板 HTML/PDF 报告，完整 JATSCraft 未接入；PDF 调用电脑已有的 Chrome，缺少浏览器时可先使用 HTML，不自动安装环境。原 Word 中的规划能力，以工程当前说明的已完成/待办状态为准。

## 自动检查

[GitHub Actions](https://github.com/phoenix-chenli/hw/actions) 对 main 的每次提交运行 Linux/Windows 核心测试和生产构建，并在 Linux 运行浏览器流程。实际结果以对应提交为准。

```sh
cd xingjian-workbench
npm test
npm run build
npm run test:browser
```

本地浏览器测试使用已有 Chrome，不自动安装原生环境。根目录工作流已配置子目录路径。
