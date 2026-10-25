# 继续点与本地时间计划契约

旧工作区仍为 schema 1。`Task.checkpoints`、`Project.busySlots`、`Project.plans` 是可选字段，旧记录无此字段不被静默改写。写入复用现有版本锁、持久幂等回执和原子文件保存；资料正文仍仅作数据。

## 继续点

`save_checkpoint` payload：`projectId`、`taskId`、`baseCheckpointNumber`、`doneNote`、`nextStep`、`blocker`、`evidence`。

`nextStep` 必填，最多 1000 字符；`doneNote` 最多 2000，`blocker` 最多 1000，可空。`evidence` 为 null 或本项目 `{sourceId,versionId}`，允许明确引用历史资料。保存时追加连续编号、UTC 时间和当前 `taskVersion`，不修改任务状态、正文版本或待复核标记。最多 100 条/任务。

基准编号与当前不同返回 409 `CHECKPOINT_CONFLICT`；工作区整体过期仍返回 `REVISION_CONFLICT`。UI 保留输入、显示最新留存，显式刷新/核对后再保存，不覆盖他处记录。取消关闭不保存表单。

## 时间占用

`add_busy_slot`：`projectId,title,kind,date,startTime,endTime`；`kind` 为 class/busy。日期必须真实，时间严格为 HH:mm，同一天开始早于结束。最多保留 200 条/项目。

`deactivate_busy_slot`：`projectId,slotId`。只设 `active:false`，保留历史；之后不再占用，不自动改写既有计划。课程可被明确允许重叠，其他忙碌时间不能绕过。

## 预览与确认

`POST /api/plans/preview` 请求 `{projectId,request}`。request 包含 `date,startTime,endTime,items:[{taskId,durationMinutes}],allowDuringClass`。同日窗口最长 12 小时；任务 1–12 项、不重复，时长 5–240 分钟且为 5 的倍数。

返回 `PlanPreview`：`projectId,request,timezone,previewToken,blocks,unplaced`。时区固定 Asia/Shanghai，与服务宿主时区无关。只查询同一用户项目内当前有效占用、同日已确认计划；拒绝跨项目借用任务或资料。每个任务按选中顺序找最早完整连续空闲，不能放下时跳过继续尝试后续任务，明确未安排原因。预览不保存。

时间块保存任务 ID/标题/内容版本、继续点编号、当前相关资料版本、时长与起止、实际课程重叠信息。`previewToken` 是请求、任务与当前依赖、同用户同日时间占用的 SHA-256，不是登录令牌。资料/继续点/任务/时间占用变化，确认时重新计算得到不同 token，返回 409 `PLAN_STALE`，即使客户端刷新过整体版本也不能绕过。

`confirm_plan` payload：`projectId,request,previewToken,acknowledgeClassOverlap`。服务重新构建结果，不信任客户端传来的时间块。无可安排任务返回 `EMPTY_PLAN`；实际课程重叠时必须确认，否则 `CLASS_OVERLAP_ACK_REQUIRED`。保存状态 confirmed，生成 ID 与创建时间，不修改任务、继续点或复核标记。

`cancel_plan`：`projectId,planId`。改为 cancelled，原快照保留，停止占用。原操作 ID 重放回执不会重复确认或取消；其他请求重复取消提示已取消。每项目最多 100 份计划（包括取消记录）。

## 历史与交互约束

- 旧计划的任务标题、资料/继续点版本始终是确认时快照；当前内容变化不使旧快照无法读取，也不将旧计划更新成新内容。
- 有效计划显示当前任务待复核、资料/内容/继续点变化、任务已完成及新增时间占用冲突提醒；用户自行取消并重新预览。
- 计划输入变化立即清除旧预览，课程重叠确认重置。409 后保留填写、刷新状态并要求重新预览。
- 保存响应丢失时复用原操作 ID，避免重复写入；改变输入视为新操作。
- 页面所用“已确认”指用户保存时间安排，不代表任务已完成、内容正确或真实云平台执行。

旧分析提案与复核历史继续原有完整性校验。服务保持本机 Host/Origin 与用户范围限制，没有生产登录、公网部署或模型调用。
