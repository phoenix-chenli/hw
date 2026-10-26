import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Search,
  X,
} from "lucide-react";
import type { Project } from "../shared/contracts";
import { resolveEvidenceLocation } from "../shared/evidence-location.mjs";
import {
  findTextMatches,
  lineRangeForSpan,
  splitTextLines,
} from "../shared/text-inspection.mjs";
import type { EvidenceTarget } from "./evidence-types";
import TextDiff from "./TextDiff";
import "./evidence.css";

const PAGE_SIZE = 200;
const SEARCH_LIMIT = 200;

type TextLine = ReturnType<typeof splitTextLines>[number];

function markedText(line: TextLine, start: number | null, end: number | null) {
  if (start === null || end === null || end <= line.start || start >= line.end)
    return line.text || "\u00a0";
  const from = Math.max(0, start - line.start);
  const to = Math.min(line.text.length, end - line.start);
  return (
    <>
      {line.text.slice(0, from)}
      <mark>{line.text.slice(from, to)}</mark>
      {line.text.slice(to)}
    </>
  );
}

export default function EvidenceDialog({
  project,
  target,
  onClose,
}: {
  project: Project;
  target: EvidenceTarget;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [versionId, setVersionId] = useState(target.versionId);
  const [query, setQuery] = useState("");
  const [resultIndex, setResultIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [comparing, setComparing] = useState(false);
  const source = project.sources.find((entry) => entry.id === target.sourceId);
  const referenced = source?.versions.find(
    (entry) => entry.id === target.versionId,
  );
  const current = source?.versions.find(
    (entry) => entry.id === source.currentVersionId,
  );
  const viewed = source?.versions.find((entry) => entry.id === versionId);
  const atReference = versionId === target.versionId;
  const location = useMemo(
    () => resolveEvidenceLocation(project, target),
    [project, target],
  );
  const lines = useMemo(
    () => splitTextLines(viewed?.content ?? ""),
    [viewed?.content],
  );
  const search = useMemo(
    () => findTextMatches(viewed?.content ?? "", query, SEARCH_LIMIT),
    [viewed?.content, query],
  );
  const activeMatch = search.matches[resultIndex] ?? null;
  const matchedLines = activeMatch
    ? lineRangeForSpan(lines, activeMatch.start, activeMatch.end)
    : null;
  const originalLine =
    atReference && location.kind !== "unlocated" ? location.startLine : null;
  const targetLine = query ? (matchedLines?.startLine ?? null) : originalLine;
  const pages = Math.max(1, Math.ceil(lines.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shownLines = lines.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );
  const referenceIsOld =
    !!referenced && referenced.id !== source?.currentVersionId;
  const canCompare = !!referenced && !!current && referenced.id !== current.id;

  useEffect(() => {
    const element = dialog.current;
    returnFocus.current = document.activeElement as HTMLElement | null;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (returnFocus.current?.isConnected)
        returnFocus.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    setVersionId(target.versionId);
    setQuery("");
    setResultIndex(0);
    setComparing(false);
  }, [target.sourceId, target.versionId]);

  useEffect(() => {
    setResultIndex(0);
  }, [query, versionId]);

  useEffect(() => {
    setPage(targetLine ? Math.floor((targetLine - 1) / PAGE_SIZE) : 0);
  }, [targetLine, versionId, query]);

  useEffect(() => {
    if (!targetLine || comparing) return;
    const row = dialog.current?.querySelector<HTMLElement>(
      `[data-evidence-line="${targetLine}"]`,
    );
    (row?.querySelector("mark") ?? row)?.scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
  }, [
    safePage,
    targetLine,
    comparing,
    versionId,
    activeMatch?.start,
    location.start,
    query,
  ]);

  function chooseVersion(nextVersionId: string) {
    setVersionId(nextVersionId);
    setQuery("");
    setResultIndex(0);
    setPage(0);
    setComparing(false);
  }

  function moveResult(step: number) {
    if (!search.matches.length) return;
    setResultIndex(
      (value) => (value + step + search.matches.length) % search.matches.length,
    );
  }

  const anchorStart =
    query && activeMatch
      ? activeMatch.start
      : atReference && !query
        ? location.start
        : null;
  const anchorEnd =
    query && activeMatch
      ? activeMatch.end
      : atReference && !query
        ? location.end
        : null;

  return (
    <dialog
      ref={dialog}
      className="modal evidence-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="modal-heading evidence-heading">
        <div>
          <span className="eyebrow">沿着依据，回到原文</span>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
            查看资料依据
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭资料依据"
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="modal-body evidence-body">
        {!source || !referenced ? (
          <div className="evidence-unavailable" role="alert">
            <FileSearch size={24} aria-hidden="true" />
            <h3>{!source ? "找不到这份引用资料" : "找不到引用的资料版本"}</h3>
            <p>
              这条引用暂时无法读取。请检查项目资料和版本记录；当前不会自动改用其他资料或版本。
            </p>
            <p className="evidence-locator">
              记录的位置：{target.locator || "未记录具体位置"}
            </p>
          </div>
        ) : (
          <>
            <section className="evidence-context" aria-label="引用资料信息">
              <div className="evidence-source-heading">
                <BookOpen size={19} aria-hidden="true" />
                <h3>{source.title}</h3>
                <span
                  className={`evidence-version-badge${referenceIsOld ? " is-historical" : ""}`}
                >
                  引用 v{referenced.number}
                  {referenceIsOld ? " · 历史版本" : " · 当前版本"}
                </span>
              </div>
              <p className="evidence-locator">
                <span>记录的位置</span>
                {target.locator || "未记录具体位置"}
              </p>
              <p className="evidence-reference-notice">
                这条依据引用资料 v{referenced.number}。
                {referenceIsOld && current
                  ? `当前资料为 v${current.number}，旧版仍完整保留。`
                  : "下方显示引用时的资料版本。"}
                查看或查找原文不会修改引用，也不会改变复核、任务或报告状态。
              </p>
            </section>

            <div className="evidence-version-toolbar">
              <div className="field evidence-version-field">
                <label htmlFor={`${id}-version`}>查看依据版本</label>
                <select
                  id={`${id}-version`}
                  value={versionId}
                  onChange={(event) => chooseVersion(event.target.value)}
                >
                  {[...source.versions].reverse().map((version) => (
                    <option key={version.id} value={version.id}>
                      资料 v{version.number}
                      {version.id === referenced.id ? " · 本条引用" : ""}
                      {version.id === source.currentVersionId ? " · 当前" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="evidence-version-actions">
                {!atReference ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => chooseVersion(referenced.id)}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                    返回引用版本
                  </button>
                ) : (
                  referenceIsOld &&
                  current && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => chooseVersion(current.id)}
                    >
                      查看当前版本
                    </button>
                  )
                )}
                {canCompare && (
                  <button
                    type="button"
                    className="button secondary"
                    aria-expanded={comparing}
                    aria-controls={`${id}-comparison`}
                    onClick={() => setComparing((value) => !value)}
                  >
                    {comparing ? "收起版本对比" : "对比引用版与当前版"}
                  </button>
                )}
              </div>
            </div>

            {comparing && referenced && current && (
              <section id={`${id}-comparison`} className="evidence-comparison">
                <TextDiff
                  before={referenced.content}
                  after={current.content}
                  beforeLabel={`引用版 · 资料 v${referenced.number}`}
                  afterLabel={`当前版 · 资料 v${current.number}`}
                  label="引用资料版本对比"
                />
              </section>
            )}

            {!viewed ? (
              <p className="evidence-unavailable" role="alert">
                选中的资料版本暂时无法读取，请返回引用版本查看。
              </p>
            ) : (
              <>
                <div className="evidence-location-note" role="status">
                  <span
                    className={`evidence-location-dot${location.kind === "unlocated" || !atReference ? " is-unlocated" : ""}`}
                    aria-hidden="true"
                  />
                  <p>
                    {atReference
                      ? location.description
                      : `正在查看资料 v${viewed.number}。原引用仍指向 v${referenced.number}，这里不沿用旧版定位。`}
                  </p>
                </div>

                <section
                  className="evidence-search"
                  aria-label="版本内原文查找"
                >
                  <label htmlFor={`${id}-query`}>在此版本查找</label>
                  <div className="evidence-search-input">
                    <Search size={17} aria-hidden="true" />
                    <input
                      id={`${id}-query`}
                      type="search"
                      value={query}
                      maxLength={300}
                      placeholder="输入要核对的原文"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setResultIndex(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          moveResult(event.shiftKey ? -1 : 1);
                        }
                      }}
                    />
                    {query && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="清除查找"
                        onClick={() => setQuery("")}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className="evidence-search-feedback">
                    <p role="status" aria-live="polite">
                      {!query
                        ? "按原文逐字匹配，区分大小写；仅查找当前显示的版本。"
                        : !search.matches.length
                          ? "此版本没有找到相同原文。"
                          : search.truncated
                            ? `找到超过 ${SEARCH_LIMIT} 处，显示前 ${SEARCH_LIMIT} 处；当前第 ${resultIndex + 1} 处。可补充文字缩小范围。`
                            : `找到 ${search.matches.length} 处，当前第 ${resultIndex + 1} 处。`}
                    </p>
                    <div className="evidence-result-actions">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!search.matches.length}
                        onClick={() => moveResult(-1)}
                      >
                        <ArrowUp size={15} aria-hidden="true" />
                        上一个结果
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!search.matches.length}
                        onClick={() => moveResult(1)}
                      >
                        <ArrowDown size={15} aria-hidden="true" />
                        下一个结果
                      </button>
                    </div>
                  </div>
                </section>

                <section className="evidence-reader" aria-label="版本原文">
                  <div className="evidence-reader-heading">
                    <h3>资料 v{viewed.number} · 原文</h3>
                    <p>
                      第 {safePage * PAGE_SIZE + 1}–
                      {Math.min((safePage + 1) * PAGE_SIZE, lines.length)} 行
                      <span> / 共 {lines.length} 行</span>
                    </p>
                  </div>
                  <div
                    className="evidence-content"
                    aria-label={`资料正文 · v${viewed.number}`}
                    tabIndex={0}
                  >
                    {shownLines.map((line) => {
                      const inAnchor =
                        atReference &&
                        !query &&
                        location.startLine !== null &&
                        location.endLine !== null &&
                        line.number >= location.startLine &&
                        line.number <= location.endLine;
                      const inSearch =
                        !!query &&
                        matchedLines !== null &&
                        line.number >= matchedLines.startLine &&
                        line.number <= matchedLines.endLine;
                      return (
                        <div
                          key={line.number}
                          data-evidence-line={line.number}
                          className={`evidence-line${inAnchor ? " is-anchor" : ""}${inSearch ? " is-search-result" : ""}`}
                        >
                          <span
                            className="evidence-line-number"
                            aria-label={`第 ${line.number} 行`}
                          >
                            {line.number}
                          </span>
                          <span className="evidence-line-text">
                            {inAnchor && location.kind === "lines" ? (
                              <mark>{line.text || "\u00a0"}</mark>
                            ) : (
                              markedText(line, anchorStart, anchorEnd)
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <nav
                    className="evidence-pagination"
                    aria-label="资料原文分页"
                  >
                    <p>
                      第 {safePage + 1} / {pages} 页 · 每页最多 {PAGE_SIZE} 行
                    </p>
                    <div>
                      <button
                        type="button"
                        className="button secondary"
                        aria-label="资料上一页"
                        disabled={safePage === 0}
                        onClick={() =>
                          setPage((value) => Math.max(0, value - 1))
                        }
                      >
                        <ChevronLeft size={16} aria-hidden="true" />
                        上一页
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        aria-label="资料下一页"
                        disabled={safePage >= pages - 1}
                        onClick={() =>
                          setPage((value) => Math.min(pages - 1, value + 1))
                        }
                      >
                        下一页
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </nav>
                  <p className="evidence-reader-help">
                    行号对应本版本保存的文本，不能直接等同于原文件页码。高亮仅帮助定位原文，结论是否成立仍需人工核对。
                  </p>
                </section>
              </>
            )}
          </>
        )}
      </div>
      <footer className="modal-actions evidence-footer">
        <p>只读查看 · 返回后可继续填写</p>
        <button type="button" className="button primary" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" />
          返回继续核对
        </button>
      </footer>
    </dialog>
  );
}
