# 固定模板报告与 PDF 契约

旧工作区仍使用 schema 1，新增可选 `Project.reports`。没有该字段的旧记录仍可读取，不强制补造历史。报告写入继续使用工作区版本检查、原子保存和持久幂等回执。

## 预览与保存

`POST /api/reports/preview`：请求 `{projectId,request}`；只读，返回 `ReportPreview`。

`ReportRequest` 为 `{title,artifactIds,includeTasks}`。标题必填、最多 120 字符；草稿 ID 为本项目内 1–8 项唯一 ID，选中顺序就是章节顺序；`includeTasks` 必须为布尔值。总文本上限 60,000 字符，最多 80 条结论、80 项相关任务和 100 个资料版本对。超限拒绝，不截断内容。

预览同时限制段落、空行与引用节点的结构复杂度。超限返回 `REPORT_CONTENT_LIMIT`，不会先保存一份下游无法导出的报告，也不静默删去段落。

`ReportPreview` 为 `{projectId,request,spec,previewToken}`。`spec` 使用 `schemaVersion:'report-spec-v1'`、`template:'research-progress-v1'`，包含：

- `project`：项目 ID、标题、目标和 `isDemo`；`title` 为本次报告标题。
- `sections`：按选择顺序保存草稿 ID、标题、正文、内容版本、待复核标记、人工复核时间和关联结论 ID。
- `claims`：所选章节关联的唯一结论，保留文本、内容版本、待复核标记、人工复核时间和完整 `Evidence`。
- `sources`：结论实际引用的唯一资料版本对，含标题、类型、版本 ID/编号、正文 SHA-256、捕获时是否为当前版和捕获时当前版本 ID。不包含资料全文。
- `tasks`：仅在选择任务附录时收录与这些结论相交的任务，保存标题、进度、复核标记、内容版本、所选结论范围内的关联、最新继续点编号与下一步。不夹带其他关联结论的正文。
- `warnings`：提醒代码与中文说明。合成示例、待复核、缺人工复核历史、原关联版本未知、空结论关联和历史资料引用均明确披露。

`reviewedAt` 仅来自至少第 2 个内容版本的人工确认时间。第 1 个快照的首次留存时间不当作原创建时间或完成复核时间。未知的原关联结论版本保持未知，不倒推补写。文本包含 XML 1.0 不支持的控制字符或孤立代理项时明确拒绝，不静默删除。

`save_report` 通过现有 `POST /api/commands` 写入，payload 为 `{projectId,request,previewToken,acknowledgeWarnings}`。服务重新构建当前预览，不接受客户端伪造的 `spec`。`previewToken` 是规范化请求和完整规格的 SHA-256，绑定相关内容、复核状态、任务状态/继续点与引用资料的当前版本；它不是身份令牌。相关内容变化返回 409 `REPORT_STALE`，即使整体工作区版本刷新过也必须重新预览。存在提醒而未主动确认时返回 `REPORT_WARNINGS_ACK_REQUIRED`。

保存追加 `SavedReport`：在预览外增加 `id,number,createdAt,contentHash`。编号连续、时间为 UTC；`contentHash` 是除该字段外完整快照的 canonical JSON SHA-256，对象键排序但数组顺序保留。每项目最多保留 30 份，不能通过新保存覆盖旧版本。本阶段无报告删除/回写命令。保存不完成任务，不清除复核状态，也不改写原分析提案。

## 历史与恢复

保存后的内容、资料版本和任务状态固定。当前项目变化只触发“相关内容已有变化”提示；下载旧版仍使用原快照，不根据当前内容重新拼接。历史校验对照保留的草稿/结论/任务修订、资料版本和继续点，允许当前内容与旧报告不同，并核对资料正文哈希和报告完整性哈希。

输入变化立即清除预览与提醒确认。409 后保留标题、选择和排序，刷新当前状态并要求重新预览。响应丢失时复用原 operationId，避免重复保存；用户修改请求后才开启新操作。

## 文件下载与受限 XML 适配

`POST /api/reports/download`：`{projectId,reportId,format}`，format 为 `html|jats|json|pdf`。所有格式均必须先有已保存的报告。返回附件、UTF-8 文件名与 `Cache-Control:no-store`；PDF 未就绪返回 409 `PDF_NOT_READY`。

- HTML：独立 UTF-8 文件，离线 CSS、A4 打印布局、内部参考资料跳转。首部显示保存版本和北京时间，工程 ID/模板/规格/哈希放到末尾“版本追溯”。CSP 禁止脚本、网络、外部字体、对象和表单提交；文本统一转义。
- JATS：`reportToJats` 将已保存规格转换为固定模板 XML，使用受限 JATS 1.3 标签，保留报告 ID、版本、模板、保存时间、内容哈希及明确的草稿/合成数据说明。参考资料只写实际题名、引用版本与位置，不编造作者、日期、DOI 或期刊。
- JSON：完整 `SavedReport`，包括选择请求、规格和完整性哈希。
- PDF：由独立 worker 对这份已保存快照打印，版式与 HTML 同源。

`reportToHtml` 必须调用 `jatsToHtml(reportToJats(report))`。`jatsToHtml` 使用 `@xmldom/xmldom@0.9.12` 实际解析 XML，随后只转换白名单标签、属性和层级。拒绝 DTD、自定义实体/外部实体声明、处理指令、注释、CDATA、外部链接、命名空间扩展、未知标签/属性、重复 ID、悬空引用、非法字符和畸形 XML。XML 内置文本转义可正常解析，不执行用户原文中的 HTML。XML 上限 2 MiB，限制节点数与嵌套深度。

这是本工程新增的受限适配，不是上游完整 JATSCraft 引擎，不包含 DTD 验证、完整 JATS 支持或期刊发表规范认证。

## PDF 任务与缓存

`POST /api/reports/pdf`：`{projectId,reportId}`，返回 202 `PdfJob`；同一报告 running/ready 时重复请求不另开 worker。failed 时由用户明确点击重试启动下一次尝试。

`POST /api/reports/pdf-status`：相同身份/项目/报告参数，返回当前 `PdfJob`，不启动生成。

`PdfJob` 为 `{status,attempt,error,createdAt,finishedAt,engine:'chromium-print-v1'}`，status 为 `idle|running|ready|failed`。页面轮询 running 状态，不自动打印或下载；状态读取失败提供刷新入口，生成失败保留报告和 HTML 下载。

使用 `playwright-core@1.61.1` 启动独立 Node 子进程，默认调用电脑已有 Chrome。`XINGJIAN_PDF_BROWSER=chromium` 只适用于已配置浏览器的 worker/CI，不会下载浏览器。子进程只接收服务生成的 XML 与服务拥有的输出路径，不访问用户 URL；禁用页面 JavaScript、离线运行并拦截网络请求，不继承模型凭据或任意 Node loader 选项。

同一服务一次只运行一个 PDF worker，60 秒生成时限，12 MiB 产物上限。超时/关闭会取消；并发槽和临时路径保留到 worker 退出清理，再开放重试。PDF 与 manifest 原子落盘，状态绑定报告 `contentHash`；下载前校验 PDF 签名、长度和文件 SHA-256。重启后遗留 running 记录变为 failed；已完成文件保留，缺失或校验失败时要求重试，不自动改写报告。

缓存根目录为 `store.file + '.exports'`，默认 `.runtime/workspace.json.exports/`；子目录由本机身份、项目 ID、报告 ID 的哈希确定，包含 `job.json` 和 `report.pdf`。运行数据与导出缓存均不提交 Git。数据文件自定义到其他位置时，缓存也随数据路径移动。

## 范围与能力声明

所有接口继续限制本机 Host/Origin、`x-xingjian-client` 和服务端固定身份；报告 ID 不能绕过项目归属。未增加公网访问、生产登录、团队共享或云端部署。

能力标记为 stage 4、`reportExport:'fixed-template-local'`、`pdfEngine:'existing-browser-worker'`；`agentArts` 仍为 `not-connected`。没有 AgentArts/模型调用，没有原生环境安装或实机验收。
