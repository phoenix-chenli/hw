import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  compareText,
  splitTextLines,
  type TextLine,
} from "../shared/text-inspection.mjs";
import "./text-diff.css";

const PAGE_SIZE = 200;
type VisibleItem =
  | { kind: "row"; index: number }
  | { kind: "gap"; start: number; end: number; key: string };

function OriginalPane({ text, label }: { text: string; label: string }) {
  const lines = useMemo(() => splitTextLines(text), [text]);
  const [page, setPage] = useState(0);
  const paneId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => setPage(0), [text]);
  const pages = Math.ceil(lines.length / PAGE_SIZE);
  const currentPage = Math.min(page, pages - 1);
  const endings = [
    ...new Set(
      lines
        .filter((line) => line.endWithBreak > line.end)
        .map((line) => {
          const value = text.slice(line.end, line.endWithBreak);
          return value === "\r\n" ? "CRLF" : value === "\r" ? "CR" : "LF";
        }),
    ),
  ];
  function navigate(nextPage: number) {
    setPage(nextPage);
    heading.current?.focus({ preventScroll: true });
  }
  return (
    <section className="text-diff-original" aria-labelledby={paneId}>
      <h4 id={paneId} ref={heading} tabIndex={-1}>
        {label}
        <span>{lines.length} 行</span>
      </h4>
      <p className="text-diff-original-format">
        换行：{endings.join("、") || "无"} ·{" "}
        {/(?:\r\n|\r|\n)$/.test(text) ? "末尾有换行" : "末尾无换行"}
      </p>
      <div className="text-diff-original-lines">
        {lines
          .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
          .map((line: TextLine) => (
            <div className="text-diff-original-line" key={line.number}>
              <span
                className="text-diff-number"
                aria-label={`第 ${line.number} 行`}
              >
                {line.number}
              </span>
              <span className="text-diff-line-text">
                {line.text || (
                  <span className="text-diff-empty-line">（空行）</span>
                )}
              </span>
            </div>
          ))}
      </div>
      {pages > 1 && (
        <div className="text-diff-pagination" aria-label={`${label}原文分页`}>
          <button
            type="button"
            onClick={() => navigate(currentPage - 1)}
            disabled={currentPage === 0}
            aria-label={`${label}上一页`}
          >
            上一页
          </button>
          <span role="status">
            第 {currentPage + 1} / {pages} 页
          </span>
          <button
            type="button"
            onClick={() => navigate(currentPage + 1)}
            disabled={currentPage + 1 >= pages}
            aria-label={`${label}下一页`}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

export default function TextDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  label = "资料文字差异",
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  label?: string;
}) {
  const comparison = useMemo(() => compareText(before, after), [before, after]);
  const id = useId();
  const [view, setView] = useState<"diff" | "originals">("diff");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [currentChange, setCurrentChange] = useState(-1);
  const focusRow = useRef<number | null>(null);
  const diffHeading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    setShowAll(false);
    setExpanded(new Set());
    setPage(0);
    setCurrentChange(-1);
  }, [before, after]);
  const items = useMemo<VisibleItem[]>(() => {
    const { rows, changes } = comparison;
    if (showAll || changes.length === 0)
      return rows.map((_, index) => ({ kind: "row", index }));
    const visible = new Uint8Array(rows.length);
    for (const change of changes) {
      visible.fill(
        1,
        Math.max(0, change.start - 3),
        Math.min(rows.length, change.end + 3),
      );
    }
    const result: VisibleItem[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (visible[index]) {
        result.push({ kind: "row", index });
        continue;
      }
      const start = index;
      while (index + 1 < rows.length && !visible[index + 1]) index += 1;
      const end = index + 1;
      const key = `${start}:${end}`;
      if (expanded.has(key))
        for (let row = start; row < end; row += 1)
          result.push({ kind: "row", index: row });
      else result.push({ kind: "gap", start, end, key });
    }
    return result;
  }, [comparison, showAll, expanded]);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    if (focusRow.current === null) return;
    const element = document.getElementById(`${id}-row-${focusRow.current}`);
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", behavior: "instant" });
    focusRow.current = null;
  }, [currentPage, currentChange, id, items, view]);
  function navigateChange(direction: -1 | 1) {
    const next =
      currentChange < 0
        ? direction === 1
          ? 0
          : comparison.changes.length - 1
        : Math.max(
            0,
            Math.min(comparison.changes.length - 1, currentChange + direction),
          );
    const index = comparison.changes[next].start;
    const itemIndex = items.findIndex(
      (item) => item.kind === "row" && item.index === index,
    );
    setCurrentChange(next);
    setPage(Math.floor(itemIndex / PAGE_SIZE));
    focusRow.current = index;
  }
  function changeContext() {
    setShowAll(!showAll);
    setExpanded(new Set());
    setPage(0);
  }
  function navigatePage(nextPage: number) {
    setPage(nextPage);
    diffHeading.current?.focus({ preventScroll: true });
  }
  return (
    <section className="text-diff" aria-label={label}>
      <div className="text-diff-toolbar">
        <div
          className="text-diff-view"
          role="group"
          aria-label={`${label}查看方式`}
        >
          <button
            type="button"
            aria-pressed={view === "diff"}
            onClick={() => setView("diff")}
          >
            差异视图
          </button>
          <button
            type="button"
            aria-pressed={view === "originals"}
            onClick={() => setView("originals")}
          >
            完整原文
          </button>
        </div>
        {view === "diff" && comparison.changes.length > 0 && (
          <div
            className="text-diff-navigation"
            role="group"
            aria-label={`${label}变化导航`}
          >
            <button
              type="button"
              disabled={currentChange === 0}
              onClick={() => navigateChange(-1)}
            >
              上一个变化
            </button>
            <span role="status">
              {currentChange < 0
                ? `${comparison.changes.length} 处变化`
                : `第 ${currentChange + 1} / ${comparison.changes.length} 处`}
            </span>
            <button
              type="button"
              disabled={currentChange === comparison.changes.length - 1}
              onClick={() => navigateChange(1)}
            >
              下一个变化
            </button>
          </div>
        )}
      </div>
      {comparison.identical && (
        <p className="text-diff-notice" role="status">
          两个版本内容完全一致。
        </p>
      )}
      {comparison.formatChanged && (
        <p className="text-diff-notice">
          {comparison.changes.length === 0
            ? "正文行内容一致；换行符或末尾换行有变化。"
            : "换行符或末尾换行也有变化，空行与原始内容保留在完整原文中。"}
        </p>
      )}
      {comparison.mode === "coarse" && (
        <p className="text-diff-warning">
          文字较长，已保留相同的开头和结尾；中间以整段删除、整段新增展示，未逐行精细匹配。可切换完整原文逐页核对。
        </p>
      )}
      {view === "originals" ? (
        <div className="text-diff-originals">
          <OriginalPane text={before} label={beforeLabel} />
          <OriginalPane text={after} label={afterLabel} />
        </div>
      ) : (
        <>
          <div className="text-diff-meta">
            <p id={`${id}-heading`} tabIndex={-1} ref={diffHeading}>
              <span>旧：{beforeLabel}</span>
              <span>新：{afterLabel}</span>
            </p>
            {comparison.changes.length > 0 && (
              <button type="button" onClick={changeContext}>
                {showAll ? "收起未变化上下文" : "展开全部上下文"}
              </button>
            )}
          </div>
          <div className="text-diff-lines" aria-describedby={`${id}-heading`}>
            {items
              .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
              .map((item) => {
                if (item.kind === "gap")
                  return (
                    <div className="text-diff-gap" key={`gap-${item.key}`}>
                      <button
                        type="button"
                        onClick={() => {
                          focusRow.current = item.start;
                          setExpanded(
                            (previous) => new Set([...previous, item.key]),
                          );
                        }}
                      >
                        展开 {item.end - item.start} 行未变化内容
                      </button>
                    </div>
                  );
                const row = comparison.rows[item.index];
                const kindLabel =
                  row.kind === "added"
                    ? "新增"
                    : row.kind === "removed"
                      ? "删除"
                      : "未变";
                return (
                  <div
                    id={`${id}-row-${item.index}`}
                    className="text-diff-row"
                    data-kind={row.kind}
                    key={item.index}
                    tabIndex={-1}
                    aria-label={`${kindLabel}，旧第 ${row.beforeLine ?? "无"} 行，新第 ${row.afterLine ?? "无"} 行`}
                  >
                    <span className="text-diff-number">
                      {row.beforeLine ?? "—"}
                    </span>
                    <span className="text-diff-number">
                      {row.afterLine ?? "—"}
                    </span>
                    <span className="text-diff-kind">{kindLabel}</span>
                    <span className="text-diff-line-text">
                      {row.text || (
                        <span className="text-diff-empty-line">（空行）</span>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
          {pages > 1 && (
            <div
              className="text-diff-pagination"
              aria-label={`${label}差异分页`}
            >
              <button
                type="button"
                onClick={() => navigatePage(currentPage - 1)}
                disabled={currentPage === 0}
              >
                上一页差异
              </button>
              <span role="status">
                第 {currentPage + 1} / {pages} 页 · 每页最多 {PAGE_SIZE} 行
              </span>
              <button
                type="button"
                onClick={() => navigatePage(currentPage + 1)}
                disabled={currentPage + 1 >= pages}
              >
                下一页差异
              </button>
            </div>
          )}
          <p className="text-diff-footnote">
            仅比较文字，变化不代表结论一定失效。确认影响前请核对上下文。
          </p>
        </>
      )}
    </section>
  );
}
