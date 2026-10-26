import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import {
  buildReportPreview,
  getReport,
  reportHash,
  reportTextHash,
  reportIsStale,
  saveReport,
  validateReports,
} from "../server/reports.mjs";
import {
  jatsToHtml,
  reportToHtml,
  reportToJats,
} from "../server/report-render.mjs";

const NOW = "2026-10-26T01:00:00.000Z";
const LATER = "2026-10-26T02:00:00.000Z";
function fixture() {
  return {
    id: "p1",
    ownerId: "alice",
    title: "合成研究",
    goal: "比较两个合成样本；不代表真实研究。",
    isDemo: true,
    sources: [
      {
        id: "s1",
        title: "合成表格",
        kind: "table",
        currentVersionId: "v1",
        versions: [
          { id: "v1", number: 1, content: "样本,值\nA,2\nB,3", createdAt: NOW },
        ],
      },
      {
        id: "s2",
        title: "未选中的私有资料",
        kind: "note",
        currentVersionId: "v2",
        versions: [
          {
            id: "v2",
            number: 1,
            content: "不应泄漏的完整资料正文",
            createdAt: NOW,
          },
        ],
      },
    ],
    claims: [
      {
        id: "c1",
        text: "合成样本值之和为 5。",
        status: "linked",
        evidence: [
          { sourceId: "s1", versionId: "v1", locator: "CSV 第 2–3 行" },
        ],
      },
      {
        id: "c2",
        text: "另一个已选结论。",
        status: "linked",
        evidence: [{ sourceId: "s1", versionId: "v1", locator: "CSV 第 2 行" }],
      },
      {
        id: "c-private",
        text: "未选中的私人结论",
        status: "linked",
        evidence: [{ sourceId: "s2", versionId: "v2", locator: "第 1 行" }],
      },
    ],
    tasks: [
      {
        id: "t1",
        title: "核对合成采样条件",
        claimIds: ["c1", "c-private"],
        status: "doing",
        reviewRequired: false,
        checkpoints: [
          {
            number: 1,
            recordedAt: NOW,
            taskVersion: 1,
            nextStep: "确认 A 的采样条件",
            doneNote: "",
            blocker: "",
            evidence: null,
          },
        ],
      },
      {
        id: "t-private",
        title: "未选中的私人任务",
        claimIds: ["c-private"],
        status: "todo",
        reviewRequired: false,
      },
    ],
    artifacts: [
      {
        id: "a1",
        title: "合成分析段落",
        content: "第一段：合成值为 5。\n\n第二段：仍待核对条件。",
        status: "draft",
        claimIds: ["c1"],
      },
      {
        id: "a2",
        title: "合成补充段落",
        content: "补充内容",
        status: "draft",
        claimIds: ["c2", "c1"],
      },
      {
        id: "a-private",
        title: "未选中的草稿",
        content: "完整私人草稿",
        status: "draft",
        claimIds: ["c-private"],
      },
    ],
  };
}
const request = (overrides = {}) => ({
  title: "阶段进展",
  artifactIds: ["a1"],
  includeTasks: true,
  ...overrides,
});
function save(project, req = request(), ctx = {}) {
  const p = buildReportPreview(project, req);
  return saveReport(
    project,
    {
      request: p.request,
      previewToken: p.previewToken,
      acknowledgeWarnings: true,
    },
    { now: NOW, id: () => `r${(project.reports?.length ?? 0) + 1}`, ...ctx },
  );
}
function validate(project) {
  const ids = new Set();
  validateReports(project, (id) => {
    assert.equal(ids.has(id), false, "unique report IDs");
    ids.add(id);
  });
}
function rehash(report) {
  report.previewToken = reportHash({
    engine: "fixed-template-report-v1",
    projectId: report.projectId,
    request: report.request,
    spec: report.spec,
  });
  const { contentHash: _hash, ...snapshot } = report;
  report.contentHash = reportHash(snapshot);
}

test("report preview is pure, ordered, deterministic and excludes unrelated records/full source bodies", () => {
  const p = fixture(),
    before = structuredClone(p);
  const preview = buildReportPreview(
    p,
    request({ title: "  阶段进展  ", artifactIds: ["a2", "a1"] }),
  );
  assert.deepEqual(p, before);
  assert.equal(preview.request.title, "阶段进展");
  assert.deepEqual(
    preview.spec.sections.map((s) => s.artifactId),
    ["a2", "a1"],
  );
  assert.deepEqual(
    preview.spec.claims.map((c) => c.claimId),
    ["c2", "c1"],
  );
  assert.equal(preview.spec.sources.length, 1);
  assert.deepEqual(preview.spec.tasks[0].claimIds, ["c1"]);
  assert.equal(preview.spec.tasks[0].nextStep, "确认 A 的采样条件");
  assert.doesNotMatch(
    JSON.stringify(preview),
    /私人|私有|完整资料正文|样本,值/,
  );
  assert.equal(
    preview.spec.sources[0].contentHash,
    reportTextHash(p.sources[0].versions[0].content),
  );
  assert.deepEqual(buildReportPreview(p, preview.request), preview);
  assert.deepEqual(
    buildReportPreview(p, request({ includeTasks: false })).spec.tasks,
    [],
  );
});

test("report requests reject duplicates, foreign selections, wrong booleans and oversize/empty inputs", () => {
  for (const input of [
    null,
    {},
    request({ title: " " }),
    request({ title: "x".repeat(121) }),
    request({ artifactIds: [] }),
    request({ artifactIds: ["a1", "a1"] }),
    request({ artifactIds: ["foreign"] }),
    request({ artifactIds: Array(9).fill("a1") }),
    request({ includeTasks: 1 }),
  ])
    assert.throws(() => buildReportPreview(fixture(), input), {
      status: input?.artifactIds?.[0] === "foreign" ? 404 : 400,
    });
});

test("warnings disclose synthetic data, absent review history, unknown dependencies and pending/historical content", () => {
  const p = fixture();
  p.sources[0].versions.push({
    id: "v3",
    number: 2,
    content: "新合成资料",
    createdAt: LATER,
  });
  p.sources[0].currentVersionId = "v3";
  p.claims[0].status = "needs_review";
  p.artifacts[0].status = "needs_review";
  p.tasks[0].reviewRequired = true;
  p.artifacts[1].claimIds = [];
  const preview = buildReportPreview(p, request({ artifactIds: ["a1", "a2"] }));
  assert.deepEqual(
    preview.spec.warnings.map((w) => w.code),
    [
      "SYNTHETIC_DATA",
      "PENDING_REVIEW",
      "MANUAL_REVIEW_MISSING",
      "UNKNOWN_CLAIM_DEPENDENCIES",
      "EMPTY_CLAIM_LINKS",
      "HISTORICAL_SOURCE_VERSIONS",
    ],
  );
  assert.equal(preview.spec.sections[0].reviewedAt, null);
  assert.equal(preview.spec.sources[0].currentAtCapture, false);
  const saved = save(p, preview.request);
  validate(p);
  assert.match(reportToHtml(saved), /合成示例数据|历史引用|人工逐项复核历史/);
});

test("manual review timestamps require a confirmed revision, never an original capture timestamp", () => {
  const p = fixture(),
    a = p.artifacts[0],
    c = p.claims[0];
  a.revisions = [
    {
      number: 1,
      recordedAt: NOW,
      title: a.title,
      content: a.content,
      claimIds: [...a.claimIds],
      claimVersions: null,
    },
    {
      number: 2,
      recordedAt: LATER,
      title: a.title,
      content: a.content,
      claimIds: [...a.claimIds],
      claimVersions: [{ claimId: "c1", version: 2 }],
    },
  ];
  c.revisions = [
    {
      number: 1,
      recordedAt: NOW,
      text: c.text,
      evidence: structuredClone(c.evidence),
    },
    {
      number: 2,
      recordedAt: LATER,
      text: c.text,
      evidence: structuredClone(c.evidence),
    },
  ];
  const report = save(p, request({ includeTasks: false }), { now: LATER });
  assert.equal(report.spec.sections[0].reviewedAt, LATER);
  assert.equal(report.spec.claims[0].reviewedAt, LATER);
  assert.equal(
    report.spec.warnings.some(
      (w) =>
        w.code === "MANUAL_REVIEW_MISSING" ||
        w.code === "UNKNOWN_CLAIM_DEPENDENCIES",
    ),
    false,
  );
  validate(p);
  const broken = structuredClone(p);
  broken.reports[0].spec.sections[0].reviewedAt = NOW;
  rehash(broken.reports[0]);
  assert.throws(() => validate(broken), /复核时间/);
});

test("saving requires the current preview, explicit warning acknowledgement and ignores forged client content", () => {
  const p = fixture(),
    preview = buildReportPreview(p, request());
  const ctx = { now: NOW, id: () => "report-1" };
  assert.throws(
    () => saveReport(p, { ...preview, acknowledgeWarnings: false }, ctx),
    { code: "REPORT_WARNINGS_ACK_REQUIRED" },
  );
  assert.equal(p.reports, undefined);
  const saved = saveReport(
    p,
    {
      request: preview.request,
      previewToken: preview.previewToken,
      acknowledgeWarnings: true,
      spec: { title: "客户端伪造" },
    },
    ctx,
  );
  assert.deepEqual(saved.spec, preview.spec);
  assert.equal(saved.contentHash.length, 64);
  validate(p);
  assert.equal(getReport(p, saved.id), saved);
  assert.throws(() => getReport(p, "foreign"), {
    code: "NOT_FOUND",
    status: 404,
  });
});

test("relevant source changes including round trips, task progress and checkpoints invalidate old preview", () => {
  for (const change of [
    (p) => {
      p.sources[0].versions.push({
        id: "v3",
        number: 2,
        content: p.sources[0].versions[0].content,
        createdAt: LATER,
      });
      p.sources[0].currentVersionId = "v3";
    },
    (p) => {
      p.tasks[0].status = "done";
    },
    (p) => {
      p.tasks[0].checkpoints.push({
        ...p.tasks[0].checkpoints[0],
        number: 2,
        nextStep: "另一明确步骤",
      });
    },
    (p) => {
      p.claims[0].status = "needs_review";
    },
    (p) => {
      p.artifacts[0].content += "\n新增合成文本";
    },
  ]) {
    const p = fixture(),
      preview = buildReportPreview(p, request());
    change(p);
    assert.throws(
      () =>
        saveReport(
          p,
          {
            request: preview.request,
            previewToken: preview.previewToken,
            acknowledgeWarnings: true,
          },
          { now: NOW, id: () => "r" },
        ),
      { code: "REPORT_STALE", status: 409 },
    );
    assert.equal(p.reports, undefined);
  }
  const p = fixture(),
    preview = buildReportPreview(p, request({ includeTasks: false }));
  p.tasks[0].status = "done";
  p.claims[2].text = "无关修改";
  assert.equal(
    buildReportPreview(p, preview.request).previewToken,
    preview.previewToken,
  );
});

test("saved reports retain exact historical content when sources and reviewed content change", () => {
  const p = fixture(),
    saved = save(p),
    original = structuredClone(saved),
    originalHtml = reportToHtml(saved);
  p.sources[0].versions.push({
    id: "v3",
    number: 2,
    content: "新合成正文",
    createdAt: LATER,
  });
  p.sources[0].currentVersionId = "v3";
  for (const [entity, kind] of [
    [p.claims[0], "claim"],
    [p.artifacts[0], "artifact"],
    [p.tasks[0], "task"],
  ]) {
    const fields =
      kind === "claim"
        ? { text: entity.text, evidence: structuredClone(entity.evidence) }
        : {
            title: entity.title,
            claimIds: [...entity.claimIds],
            ...(kind === "artifact" ? { content: entity.content } : {}),
            claimVersions: null,
          };
    entity.revisions = [
      { number: 1, recordedAt: NOW, ...structuredClone(fields) },
      {
        number: 2,
        recordedAt: LATER,
        ...structuredClone(fields),
        ...(kind === "claim"
          ? {
              text: "新合成结论",
              evidence: [
                { sourceId: "s1", versionId: "v3", locator: "第 1 行" },
              ],
            }
          : {
              title: "新修订标题",
              ...(kind === "artifact" ? { content: "新修订草稿" } : {}),
              claimVersions: [{ claimId: "c1", version: 2 }],
            }),
      },
    ];
    Object.assign(entity, entity.revisions[1]);
  }
  p.tasks[0].status = "done";
  p.tasks[0].checkpoints.push({
    ...p.tasks[0].checkpoints[0],
    number: 2,
    nextStep: "新版的下一步",
  });
  assert.equal(reportIsStale(p, saved), true);
  assert.deepEqual(saved, original);
  assert.equal(reportToHtml(getReport(p, saved.id)), originalHtml);
  validate(p);
});

test("old projects without reports remain valid and report numbering/count/history integrity are checked", () => {
  validate(fixture());
  const p = fixture();
  save(p);
  save(p, request({ title: "第二版" }), { now: LATER });
  validate(p);
  assert.equal(p.reports[1].number, 2);
  for (const mutate of [
    (p) => {
      p.reports[0].number = 8;
    },
    (p) => {
      p.reports[0].spec.sections[0].content = "被改写";
    },
    (p) => {
      p.reports[0].spec.sources[0].contentHash = "0".repeat(64);
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].spec.sources[0].versionId = "missing";
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].spec.claims.push({
        ...p.reports[0].spec.claims[0],
        claimId: "c-private",
      });
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].spec.tasks[0].nextStep = "伪造继续点";
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].spec.warnings = [];
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].spec.project.isDemo = false;
      p.reports[0].spec.warnings = p.reports[0].spec.warnings.filter(
        (warning) => warning.code !== "SYNTHETIC_DATA",
      );
      rehash(p.reports[0]);
    },
    (p) => {
      p.reports[0].contentHash = "0".repeat(64);
    },
    (p) => {
      p.reports[1].createdAt = "2026-10-25T01:00:00.000Z";
      rehash(p.reports[1]);
    },
  ]) {
    const broken = structuredClone(p);
    mutate(broken);
    assert.throws(() => validate(broken));
  }
  const full = fixture();
  for (let n = 0; n < 30; n++) save(full);
  validate(full);
  assert.throws(() => save(full), { code: "REPORT_LIMIT" });
});

test("report caps fail clearly instead of truncating long drafts, many claims, versions or tasks", () => {
  const long = fixture();
  long.artifacts[0].content = "合".repeat(60001);
  assert.throws(() => buildReportPreview(long, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
  const manyClaims = fixture();
  manyClaims.claims = Array.from({ length: 81 }, (_, i) => ({
    ...manyClaims.claims[0],
    id: `claim-${i}`,
  }));
  manyClaims.artifacts[0].claimIds = manyClaims.claims.map((c) => c.id);
  assert.throws(() => buildReportPreview(manyClaims, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
  const manyTasks = fixture();
  manyTasks.tasks = Array.from({ length: 81 }, (_, i) => ({
    ...manyTasks.tasks[0],
    id: `task-${i}`,
  }));
  assert.throws(() => buildReportPreview(manyTasks, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
  const versions = fixture();
  versions.sources[0].versions = Array.from({ length: 101 }, (_, i) => ({
    id: `version-${i}`,
    number: i + 1,
    content: `合成 ${i}`,
    createdAt: NOW,
  }));
  versions.sources[0].currentVersionId = "version-100";
  versions.claims[0].evidence = versions.sources[0].versions.map((v) => ({
    sourceId: "s1",
    versionId: v.id,
    locator: "第 1 行",
  }));
  assert.throws(() => buildReportPreview(versions, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
});

test("paragraph and citation complexity is rejected before saving an unrenderable report", () => {
  const p = fixture();
  p.artifacts[0].content = "正文" + "\n".repeat(45000) + "结尾";
  assert.throws(() => buildReportPreview(p, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
  assert.equal(p.reports, undefined);
  p.artifacts[0].content = "正文" + "\n".repeat(6000) + "结尾";
  assert.ok(reportToHtml(save(p)).includes("结尾"));
  const many = fixture();
  many.claims[0].evidence = Array.from({ length: 5000 }, (_, index) => ({
    sourceId: "s1",
    versionId: "v1",
    locator: `第${index + 1}处`,
  }));
  assert.throws(() => buildReportPreview(many, request()), {
    code: "REPORT_CONTENT_LIMIT",
  });
});

test("XML-invalid source text fields fail explicitly without being silently removed", () => {
  for (const value of [
    "合成\u0000内容",
    "合成\u000b内容",
    "合成\ufffe",
    "\ud800",
  ])
    for (const field of ["title", "content"]) {
      const p = fixture();
      p.artifacts[0][field] = value;
      assert.throws(() => buildReportPreview(p, request()), {
        code: "REPORT_XML_CHARACTER",
      });
    }
  const p = fixture();
  p.artifacts[0].content = "中文\t制表\n换行\r回车与 emoji 🌱";
  assert.doesNotThrow(() => reportToHtml(save(p)));
});

test("real XML parsing produces offline HTML with escaped hostile text, Chinese paragraphs, metadata and internal references", () => {
  const p = fixture();
  p.artifacts[0].content =
    '<script>alert("bad")</script>\n<img src="https://evil.example/a"> & text\n\n尾段 🌱';
  const report = save(p),
    xml = reportToJats(report),
    html = reportToHtml(report);
  const doc = new DOMParser({
    onError: () => {
      throw new Error("XML invalid");
    },
  }).parseFromString(xml, "application/xml");
  assert.equal(doc.documentElement.tagName, "article");
  assert.equal(
    doc.getElementsByTagName("article-title")[0].textContent,
    "阶段进展",
  );
  assert.match(xml, /dtd-version="1.3"/);
  assert.doesNotMatch(xml, /<!DOCTYPE|<!ENTITY|<script>|<img /);
  assert.match(html, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|link)\b|<[^>]+\ssrc=/i);
  assert.match(html, /href="#ref-1"/);
  assert.match(html, /id="ref-1"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /@page\{size:A4/);
  assert.match(html, /尾段 🌱/);
  assert.match(html, new RegExp(report.contentHash));
  const header = html.split("</header>")[0];
  assert.match(header, /保存版本/);
  assert.match(header, /2026-10-26 09:00:00/);
  assert.doesNotMatch(
    header,
    /快照 SHA-256|research-progress-v1|report-spec-v1/,
  );
  assert.ok(html.indexOf("版本追溯") > html.indexOf("参考资料 · 实际引用版本"));
  assert.match(html, /<small class="source-hash">内容 SHA-256：/);
  assert.equal(jatsToHtml(xml), html);
  assert.doesNotMatch(html, /原作者|doi\.org|期刊名|发表日期：/);
});

test("restricted XML adapter rejects malformed XML, external resources, DTD/entities, PIs and unknown tags/attributes", () => {
  const xml = reportToJats(save(fixture()));
  for (const hostile of [
    `<!DOCTYPE article SYSTEM "https://evil.example/dtd">${xml}`,
    `<!DOCTYPE article [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${xml}`,
    `<?xml-stylesheet href="https://evil.example/x"?>${xml}`,
    xml.replace("<p>", '<p onclick="bad()">'),
    xml.replace("<p>", '<p style="background:url(https://evil.example)">'),
    xml.replace("<p>", "<script>"),
    xml.replace("<p>", "<p>&unknown;"),
    xml.replace("<p>", "<p>&#0;"),
    xml.replace(
      "<p>",
      '<p><ext-link href="https://evil.example">url</ext-link>',
    ),
    xml.replace('rid="ref-1"', 'rid="https://evil.example"'),
    xml.replace('rid="ref-1"', 'rid="missing"'),
    xml.replace('id="ref-1"', 'id="project"'),
    xml.replace("</article>", ""),
    xml.replace("<p>", "<p><![CDATA[bad]]>"),
    xml + "<article />",
    xml.replace("<body>", '<body xmlns="https://evil.example/ns">'),
    xml.replace("<body>", "<body><!-- unsupported -->"),
    "x".repeat(2 * 1024 * 1024 + 1),
  ])
    assert.throws(() => jatsToHtml(hostile), { status: 400 });
});

test("XML adapter transforms parsed content rather than using a hidden report object", () => {
  const xml = reportToJats(save(fixture()));
  const changed = xml.replace("合成值为 5", "已从 XML 实际读取");
  assert.match(jatsToHtml(changed), /已从 XML 实际读取/);
  assert.notEqual(jatsToHtml(changed), jatsToHtml(xml));
  assert.equal(
    reportHash({ a: 1, b: [2, 3] }),
    reportHash({ b: [2, 3], a: 1 }),
  );
});
