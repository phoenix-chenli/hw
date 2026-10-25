# 第一阶段内部实现约定

阶段范围：独立工程、统一对象、资料版本与变更影响的本地可运行基础。

这是本地单用户版本，不含真实 AgentArts 调用、语义检索、自动证据验证、真实报告排版或云端账户。页面中明确区分示例项目与用户项目；状态 linked 表示“已关联依据”，不代表结论正确。

## 核心模块 server/domain.mjs

- `emptyWorkspace()` → Workspace。
- `applyCommand(state, ownerId, type, payload, options?)` → `{ state, result: { projectId, entityId? } }`；不能修改传入对象；成功变更将 revision 增加 1。options 可注入 `now` / `id` 用于测试。
- `previewSourceUpdate(state, ownerId, projectId, sourceId, nextContent)` → ImpactPreview，纯函数、不保存。
- `validateWorkspace(state)`：校验读取的持久数据，非法数据抛错，不自动覆盖损坏文件。
- `DomainError` 携带 `code`、`status`、`message`；非法输入 400、无权限或不存在 404、版本冲突 409。

字段见 `shared/contracts.ts`。所有项目级命令 payload 必须含 projectId；ownerId 由服务端本地模式注入，不能从请求接受。

命令 payload：

| type | 字段 |
| --- | --- |
| create_project | title, goal, deadline (YYYY-MM-DD 或 null) |
| load_demo | 无；创建明确标注的校园节能研究合成示例，包含资料、结论、任务与草稿关系 |
| add_source | projectId, title, kind, content |
| add_claim | projectId, text, evidence: [{sourceId, versionId, locator}] |
| add_task | projectId, title, claimIds |
| add_artifact | projectId, title, content, claimIds |
| update_source | projectId, sourceId, baseVersionId, content；必须基于预览版本，旧版本保留 |
| set_task_status | projectId, taskId, status |

每次资料变化：保留旧依据引用，相关结论标记 needs_review；关联任务保留 todo/doing/done 原状态但 reviewRequired=true；相关成果草稿标记 needs_review。不自动生成新结论、不自动完成任务、不自动重排、不声称分析全部语义影响。无实质内容变化不新增版本。

## HTTP 本地开发边界

默认只监听 127.0.0.1。浏览器经同源 /api 请求；必须带 `X-Xingjian-Client: workspace-v1`。服务端限制 Host、Origin 与请求体大小，本地模式不能当作生产认证。

- GET /api/state → Workspace。
- GET /api/capabilities → 明确实际能力及未连接的平台状态。
- POST /api/preview → {projectId, sourceId, content}，返回 ImpactPreview。
- POST /api/commands → Command；成功返回 CommandResult。
- 错误统一 `{error:{code,message}}`。

命令外层 expectedRevision 乐观锁、operationId 幂等。服务端串行提交并原子写本地文件；同一 operationId 不同内容返回冲突。前端遇到 409 重新拉取状态并保留表单输入，重新预览后确认。
