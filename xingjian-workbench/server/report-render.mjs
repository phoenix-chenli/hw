import { DOMParser } from "@xmldom/xmldom";
import { ReportError, assertXmlText } from "./reports.mjs";

const fail = (message) => {
  throw new ReportError("INVALID_REPORT_XML", message);
};
const escape = (value) =>
  assertXmlText(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const paragraphs = (value) =>
  String(value)
    .split(/\r\n|\r|\n/)
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
const sourceKey = (value) => JSON.stringify([value.sourceId, value.versionId]);
const statusName = { todo: "待开始", doing: "进行中", done: "已完成" };
const manual = (value) =>
  value === null ? "无人工逐项复核历史" : `人工复核留存于 ${value}`;

/** A deliberately restricted, standalone JATS 1.3-tagged progress draft. No DTD declaration. */
export function reportToJats(report) {
  if (
    !report?.spec ||
    typeof report.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.contentHash)
  )
    fail("只能导出已经保存的报告快照。");
  const spec = report.spec;
  const refs = new Map(
    spec.sources.map((source, index) => [
      sourceKey(source),
      `ref-${index + 1}`,
    ]),
  );
  const meta = [
    ["报告编号", report.id],
    ["保存版本", String(report.number)],
    ["保存时间（UTC）", report.createdAt],
    ["模板", spec.template],
    ["报告规格", spec.schemaVersion],
    ["快照 SHA-256", report.contentHash],
  ];
  const sections = spec.sections
    .map(
      (section, index) =>
        `<sec id="draft-${index + 1}"><title>${escape(section.title)}</title><p>${escape(`草稿内容版本 ${section.version}；${section.needsReview ? "待复核" : "当前无复核提醒"}；${manual(section.reviewedAt)}。`)}</p>${paragraphs(section.content)}<p>${escape(section.claimIds.length ? `关联结论：${section.claimIds.map((id) => `C${spec.claims.findIndex((claim) => claim.claimId === id) + 1}`).join("、")}。` : "未关联结论；本段没有可追溯的资料依据。")}</p></sec>`,
    )
    .join("");
  const claims = spec.claims
    .map(
      (claim, index) =>
        `<sec id="claim-${index + 1}"><title>${escape(`C${index + 1} · 结论版本 ${claim.version}`)}</title>${paragraphs(claim.text)}<p>${escape(`${claim.needsReview ? "待复核" : "当前无复核提醒"}；${manual(claim.reviewedAt)}。`)}</p><list list-type="bullet">${claim.evidence
          .map((ref) => {
            const rid = refs.get(sourceKey(ref));
            if (!rid) fail("报告引用资料的索引不完整。");
            const number =
              spec.sources.findIndex(
                (source) => sourceKey(source) === sourceKey(ref),
              ) + 1;
            return `<list-item><p><xref ref-type="bibr" rid="${rid}">[${number}]</xref>${escape(` ${ref.locator}`)}</p></list-item>`;
          })
          .join("")}</list></sec>`,
    )
    .join("");
  const tasks = spec.tasks
    .map(
      (task, index) =>
        `<list-item><p>${escape(`${index + 1}. ${task.title}（${statusName[task.status] ?? task.status}；内容版本 ${task.version}${task.reviewRequired ? "；待复核" : ""}）`)}</p><p>${escape(`关联结论：${task.claimIds.map((id) => `C${spec.claims.findIndex((claim) => claim.claimId === id) + 1}`).join("、")}。`)}</p>${task.nextStep === null ? "<p>尚未记录继续点。</p>" : `<p>${escape(`继续点 ${task.checkpointNumber} · 下次第一步：${task.nextStep}`)}</p>`}</list-item>`,
    )
    .join("");
  return `<article article-type="other" dtd-version="1.3" xml:lang="zh"><front><article-meta><article-id pub-id-type="publisher-id">${escape(report.id)}</article-id><title-group><article-title>${escape(spec.title)}</article-title></title-group><custom-meta-group>${meta.map(([name, value]) => `<custom-meta><meta-name>${escape(name)}</meta-name><meta-value>${escape(value)}</meta-value></custom-meta>`).join("")}</custom-meta-group><abstract><p>研究进度草稿 · 本报告是用户选定内容的版本快照，不构成发表就绪、正确性认证或真实研究结果的自动证明。</p><p>${escape(spec.project.isDemo ? "合成示例数据：本项目仅供功能演示，不能作为真实研究结果。" : "请核对报告中的结论、资料依据和提醒后再使用。")}</p></abstract></article-meta></front><body><sec id="project"><title>项目与目标</title><p>${escape(spec.project.title)}</p>${paragraphs(spec.project.goal)}</sec><sec id="drafts"><title>选定草稿</title>${sections}</sec><sec id="claims"><title>关联结论与资料依据</title>${claims || "<p>本报告没有关联结论。</p>"}</sec><sec id="actions"><title>关联行动与继续点</title>${tasks ? `<list list-type="bullet">${tasks}</list>` : `<p>${report.request.includeTasks ? "所选草稿没有关联任务。" : "本次未选择任务附录。"}</p>`}</sec><sec id="warnings"><title>使用前需注意</title>${spec.warnings.length ? `<list list-type="bullet">${spec.warnings.map((warning) => `<list-item><p>${escape(warning.message)}</p></list-item>`).join("")}</list>` : "<p>本快照无额外状态提醒；仍需使用者核对研究内容与结论。</p>"}</sec></body><back><ref-list><title>参考资料 · 实际引用版本</title>${spec.sources.map((source, index) => `<ref id="ref-${index + 1}"><label>[${index + 1}]</label><mixed-citation publication-type="other">${escape(`${source.title} · ${source.kind === "table" ? "表格" : source.kind === "document" ? "文档" : "笔记"} · 版本 ${source.versionNumber}（${source.versionId}）${source.currentAtCapture ? "；捕获时为当前版本" : `；历史引用，捕获时当前版本为 ${source.currentVersionIdAtCapture}`}。`)}<named-content content-type="source-hash">${escape(`内容 SHA-256：${source.contentHash}`)}</named-content></mixed-citation></ref>`).join("")}${spec.sources.length ? "" : "<p>没有资料引用。未补写作者、发表日期、DOI 或期刊信息。</p>"}</ref-list></back></article>`;
}

const allowed = {
  article: {
    attrs: {
      "article-type": ["other"],
      "dtd-version": ["1.3"],
      "xml:lang": ["zh"],
    },
    children: ["front", "body", "back"],
  },
  front: { children: ["article-meta"] },
  "article-meta": {
    children: ["article-id", "title-group", "custom-meta-group", "abstract"],
  },
  "article-id": { attrs: { "pub-id-type": ["publisher-id"] }, text: true },
  "title-group": { children: ["article-title"] },
  "article-title": { text: true },
  "custom-meta-group": { children: ["custom-meta"] },
  "custom-meta": { children: ["meta-name", "meta-value"] },
  "meta-name": { text: true },
  "meta-value": { text: true },
  abstract: { children: ["p"] },
  body: { children: ["sec"] },
  sec: { attrs: { id: "id" }, children: ["title", "p", "sec", "list"] },
  title: { text: true },
  p: { text: true, children: ["xref"] },
  list: {
    attrs: { "list-type": ["bullet", "order"] },
    children: ["list-item"],
  },
  "list-item": { children: ["p"] },
  xref: { attrs: { "ref-type": ["bibr"], rid: "id" }, text: true },
  back: { children: ["ref-list"] },
  "ref-list": { children: ["title", "ref", "p"] },
  ref: { attrs: { id: "id" }, children: ["label", "mixed-citation"] },
  label: { text: true },
  "mixed-citation": {
    attrs: { "publication-type": ["other"] },
    text: true,
    children: ["named-content"],
  },
  "named-content": { attrs: { "content-type": ["source-hash"] }, text: true },
};
const css = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#243247;background:#edf2f8;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;padding:36px 20px}article.report{max-width:820px;margin:auto;padding:58px 62px;background:#fff;box-shadow:0 8px 40px #2432470d;border-top:5px solid #3978c6}
h1{font-size:29px;line-height:1.45;color:#162d48;margin:12px 0 24px;font-weight:650}h2{font-size:19px;border-bottom:1px solid #dce6f2;padding-bottom:10px;margin:30px 0 15px;color:#264c78}h3{font-size:16px;margin:22px 0 10px;color:#264c78}p,li{font-size:14px;line-height:1.9;overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap}p{margin:8px 0;min-height:.9em}ul,ol{padding-left:24px}li{padding-left:3px;margin:10px 0}a{color:#2464aa;text-decoration:underline;text-underline-offset:3px}.source-hash{display:block;font-size:9px;color:#7f8c9d;line-height:1.7;margin-top:5px;overflow-wrap:anywhere}.trace{margin-top:28px}.trace .report-meta{font-size:9px}.reader-meta{font-size:12px;color:#526c8a}header .article-id{font-size:11px;color:#6e7f95;overflow-wrap:anywhere}.report-meta{display:grid;grid-template-columns:130px minmax(0,1fr);gap:5px 12px;font-size:11px;line-height:1.65;color:#6e7f95;margin:20px 0}.report-meta dt,.report-meta dd{margin:0;overflow-wrap:anywhere}.notice{background:#f0f6fd;border-left:3px solid #8ab3e1;padding:10px 17px;margin:22px 0}.notice p{font-size:12px;color:#405e80}footer{border-top:1px solid #dce6f2;margin-top:30px;padding-top:4px}footer .reference{margin:15px 0;scroll-margin-top:20px}.ref-label{color:#3978c6;font-weight:600}footer p{font-size:11px;line-height:1.8;color:#556982}section{min-width:0}h1,h2,h3{break-after:avoid-page}p,li{orphans:3;widows:3}.reference{break-inside:avoid-page}a:focus-visible{outline:2px solid #2464aa;outline-offset:3px}
@page{size:A4;margin:18mm 17mm 20mm}@media print{:root{background:white}body{padding:0}article.report{padding:0;max-width:none;box-shadow:none;border-top:3px solid #3978c6}.notice{print-color-adjust:exact;-webkit-print-color-adjust:exact}.report-meta{font-size:9px}p,li{font-size:10.5pt}li{break-inside:avoid-page}.notice,.report-meta{break-inside:avoid-page}footer p{font-size:9pt}h1{font-size:23pt}h2{font-size:15pt}h3{font-size:12pt}a{color:inherit}section{overflow:visible}.reference{break-inside:auto}}
@media(max-width:600px){body{padding:12px 8px}article.report{padding:26px 20px}.report-meta{grid-template-columns:90px minmax(0,1fr)}h1{font-size:24px}}
`;
const htmlEscape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
function childElements(node) {
  return Array.from(node.childNodes).filter((child) => child.nodeType === 1);
}

/** Parses the actual XML before mapping allowlisted elements to offline HTML. */
export function jatsToHtml(xml) {
  if (
    typeof xml !== "string" ||
    Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024
  )
    fail("XML 格式无效或超过 2 MiB 上限。");
  assertXmlText(xml);
  // Entity declarations / DTDs / PIs cannot enter the parser. Predefined XML
  // escapes (&amp; etc.) are plain text escapes, not custom entity declarations.
  if (
    /<!|<\?/u.test(xml) ||
    /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/u.test(xml)
  )
    fail("仅支持无 DTD、实体声明、处理指令和注释的受限报告 XML。");
  let document;
  try {
    document = new DOMParser({
      onError: () => {
        throw new Error("Malformed XML");
      },
    }).parseFromString(xml, "application/xml");
  } catch {
    fail("XML 无法完整解析，请检查结构与字符转义。");
  }
  const root = document.documentElement;
  if (!root || root.nodeName !== "article")
    fail("报告 XML 的根节点必须为 article。");
  for (const node of Array.from(document.childNodes))
    if (node !== root && !(node.nodeType === 3 && !node.data.trim()))
      fail("XML 只能包含一个报告根节点。");
  const ids = new Set(),
    refIds = new Set(),
    links = [];
  let nodes = 0;
  function validate(node, depth = 0) {
    if (++nodes > 40000 || depth > 32) fail("XML 节点数量或嵌套超过上限。");
    const rules = allowed[node.nodeName];
    if (
      !rules ||
      node.prefix ||
      (node.namespaceURI && node.nodeName !== "article")
    )
      fail("XML 包含未支持的标签或命名空间。");
    for (const attribute of Array.from(node.attributes)) {
      const rule = rules.attrs?.[attribute.name];
      if (
        !rule ||
        (Array.isArray(rule) && !rule.includes(attribute.value)) ||
        (rule === "id" && !/^[A-Za-z][A-Za-z\d_-]{0,79}$/.test(attribute.value))
      )
        fail("XML 包含未支持的属性或属性值。");
    }
    for (const name of Object.keys(rules.attrs ?? {}))
      if (!node.hasAttribute(name)) fail("XML 缺少受限格式所需属性。");
    if (node.hasAttribute("id")) {
      const id = node.getAttribute("id");
      if (ids.has(id)) fail("XML 节点 ID 不能重复。");
      ids.add(id);
      if (node.nodeName === "ref") refIds.add(id);
    }
    if (node.nodeName === "xref") links.push(node.getAttribute("rid"));
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        assertXmlText(child.data);
        if (!rules.text && child.data.trim()) fail("XML 标签不接受直接文本。");
      } else if (child.nodeType === 1) {
        if (!rules.children?.includes(child.nodeName))
          fail("XML 包含不支持的标签层级。");
        validate(child, depth + 1);
      } else fail("XML 包含不支持的节点类型。");
    }
    const children = childElements(node).map((child) => child.nodeName);
    if (node.nodeName === "article" && children.join(",") !== "front,body,back")
      fail("XML 缺少完整的报告首部、正文或参考资料。");
    if (node.nodeName === "front" && children.join(",") !== "article-meta")
      fail("XML 首部格式不完整。");
    if (
      node.nodeName === "article-meta" &&
      children.join(",") !== "article-id,title-group,custom-meta-group,abstract"
    )
      fail("XML 报告元数据格式不完整。");
    if (
      node.nodeName === "title-group" &&
      children.join(",") !== "article-title"
    )
      fail("XML 标题格式不完整。");
    if (
      node.nodeName === "custom-meta" &&
      children.join(",") !== "meta-name,meta-value"
    )
      fail("XML 自定义元数据格式不完整。");
    if (
      node.nodeName === "ref" &&
      children.join(",") !== "label,mixed-citation"
    )
      fail("XML 参考资料格式不完整。");
  }
  validate(root);
  if (links.some((rid) => !refIds.has(rid)))
    fail("XML 参考资料跳转目标不存在。");
  const metadata = Array.from(root.getElementsByTagName("custom-meta")).map(
    (node) => ({
      name: node.getElementsByTagName("meta-name")[0].textContent,
      value: node.getElementsByTagName("meta-value")[0].textContent,
    }),
  );
  const readerNames = new Set(["保存版本", "保存时间（UTC）"]);
  const metadataHtml = (entries) =>
    entries
      .map(
        ({ name, value }) =>
          `<dt>${htmlEscape(name)}</dt><dd>${htmlEscape(value)}</dd>`,
      )
      .join("");
  const readerMetadata = metadata
    .filter((entry) => readerNames.has(entry.name))
    .map((entry) => {
      if (entry.name !== "保存时间（UTC）") return entry;
      const date = new Date(entry.value);
      if (!Number.isFinite(date.getTime())) fail("XML 保存时间无效。");
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const part = (type) => parts.find((item) => item.type === type).value;
      return {
        name: "保存时间（北京时间）",
        value: `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`,
      };
    });
  const trace = `<section class="trace"><h2>版本追溯</h2><dl class="report-meta">${metadataHtml(metadata.filter((entry) => !readerNames.has(entry.name)))}</dl></section>`;
  function render(node, sectionDepth = 0) {
    if (node.nodeType === 3) return htmlEscape(node.data);
    const name = node.nodeName;
    const inner = () =>
      Array.from(node.childNodes)
        .map((child) => render(child, sectionDepth + (name === "sec" ? 1 : 0)))
        .join("");
    const id = node.hasAttribute("id")
      ? ` id="${htmlEscape(node.getAttribute("id"))}"`
      : "";
    switch (name) {
      case "article":
        return `<article class="report">${inner()}</article>`;
      case "front":
        return `<header>${inner()}</header>`;
      case "article-meta":
      case "title-group":
      case "custom-meta":
        return inner();
      case "article-id":
        return `<div class="article-id">行简研学 · 研究进度草稿</div>`;
      case "article-title":
        return `<h1>${inner()}</h1>`;
      case "custom-meta-group":
        return `<dl class="report-meta reader-meta">${metadataHtml(readerMetadata)}</dl>`;
      case "meta-name":
        return `<dt>${inner()}</dt>`;
      case "meta-value":
        return `<dd>${inner()}</dd>`;
      case "abstract":
        return `<div class="notice" role="note">${inner()}</div>`;
      case "body":
        return `<main>${inner()}</main>`;
      case "back":
        return `<footer>${inner()}${trace}</footer>`;
      case "sec":
        return `<section${id}>${inner()}</section>`;
      case "title":
        return sectionDepth > 1 ? `<h3>${inner()}</h3>` : `<h2>${inner()}</h2>`;
      case "p":
        return `<p>${inner()}</p>`;
      case "list": {
        const tag = node.getAttribute("list-type") === "order" ? "ol" : "ul";
        return `<${tag}>${inner()}</${tag}>`;
      }
      case "list-item":
        return `<li>${inner()}</li>`;
      case "xref":
        return `<a href="#${htmlEscape(node.getAttribute("rid"))}">${inner()}</a>`;
      case "ref-list":
        return `<div class="references">${inner()}</div>`;
      case "ref":
        return `<div class="reference"${id}>${inner()}</div>`;
      case "label":
        return `<span class="ref-label">${inner()}</span>`;
      case "mixed-citation":
        return `<p>${inner()}</p>`;
      case "named-content":
        return `<small class="source-hash">${inner()}</small>`;
      default:
        fail("XML 标签未映射。");
    }
  }
  const title =
    root.getElementsByTagName("article-title")[0]?.textContent ??
    "研究进度草稿";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${htmlEscape(title)}</title><style>${css}</style></head><body>${render(root)}</body></html>`;
}

export const reportToHtml = (report) => jatsToHtml(reportToJats(report));
