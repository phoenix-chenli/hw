import { useMemo, useState, type Ref } from "react";
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Filter, Link2, Search } from "lucide-react";
import type { Project, ReviewKind } from "../shared/contracts";
import { buildReviewQueue, filterReviewQueue, type ReviewQueueFilters } from "../shared/review-queue.mjs";
import "./review-queue.css";

const labels = { claim: "结论", task: "行动", artifact: "草稿" };
const taskLabels = { todo: "待开始", doing: "进行中", done: "已完成" };
const initialFilters: ReviewQueueFilters = { kind: "all", sourceId: "", query: "", readiness: "all" };
const pageSize = 8;

export default function ReviewQueue({ project, disabled, headingRef, onReview }: {
  project: Project;
  disabled: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onReview: (target: { kind: ReviewKind; entityId: string }) => void;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(0);
  const items = useMemo(() => buildReviewQueue(project), [project]);
  const filtered = useMemo(() => filterReviewQueue(items, filters), [items, filters]);
  const availableSources = project.sources.filter(source => items.some(item => item.sources.some(ref => ref.sourceId === source.id)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const readyCount = items.filter(item => !item.blockedBy.length).length;
  const hasFilters = filters.kind !== "all" || filters.sourceId !== "" || filters.query !== "" || filters.readiness !== "all";
  function updateFilters(next: Partial<ReviewQueueFilters>) {
    setFilters(current => ({ ...current, ...next }));
    setPage(0);
  }
  function clearFilters() {
    setFilters(initialFilters);
    setPage(0);
  }
  return (
    <section className="panel review-queue" aria-label="待复核清单">
      <header className="review-queue-heading">
        <div>
          <span className="section-kicker">把变化逐项核对清楚</span>
          <h2 ref={headingRef} tabIndex={-1}>待复核清单</h2>
          <p>{items.length ? `${readyCount} 项可先核对，${items.length - readyCount} 项等待关联结论。保存一项后，清单按最新内容更新。` : "当前没有待复核内容。资料再次变化时，已关联的内容会回到这里。"}</p>
        </div>
        {items.length ? (
          <div className="review-queue-start"><button type="button" className="button secondary" disabled={disabled} onClick={() => onReview(items[0])}>
            开始逐项复核 <ArrowRight size={16} aria-hidden="true" />
          </button><small>从完整清单第一项开始</small></div>
        ) : <CheckCircle2 size={25} className="review-queue-clear-icon" aria-hidden="true" />}
      </header>
      {items.length > 0 && <>
        <div className="review-queue-types" role="group" aria-label="按内容类型筛选">
          {(["all", "claim", "task", "artifact"] as const).map(kind => (
            <button type="button" key={kind} aria-label={kind === "all" ? "全部" : labels[kind]} aria-pressed={filters.kind === kind} onClick={() => updateFilters({ kind })}>
              {kind === "all" ? "全部" : labels[kind]}
              <span aria-hidden="true">{kind === "all" ? items.length : items.filter(item => item.kind === kind).length}</span>
            </button>
          ))}
        </div>
        <div className="review-queue-filters">
          <label className="review-queue-search">
            <span>查找待复核内容</span>
            <span className="review-queue-input"><Search size={16} aria-hidden="true" /><input value={filters.query} maxLength={200} placeholder="标题或关联资料名称" onChange={event => updateFilters({ query: event.target.value })} /></span>
          </label>
          <label><span>按关联资料筛选</span><select aria-label="按关联资料筛选" value={filters.sourceId} onChange={event => updateFilters({ sourceId: event.target.value })}>
            <option value="">全部关联资料</option>
            {availableSources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
          </select></label>
          <label><span>按处理顺序筛选</span><select aria-label="按处理顺序筛选" value={filters.readiness} onChange={event => updateFilters({ readiness: event.target.value as ReviewQueueFilters["readiness"] })}>
            <option value="all">所有待复核内容</option><option value="ready">可先核对</option><option value="blocked">等待关联结论</option>
          </select></label>
        </div>
        <div className="review-queue-results">
          <p role="status" aria-live="polite" aria-atomic="true">显示 {filtered.length} 项，共 {items.length} 项待复核</p>
          {hasFilters && <button type="button" className="text-button" onClick={clearFilters}>清除筛选</button>}
        </div>
        {visible.length ? <ol className="review-queue-list" start={currentPage * pageSize + 1}>
          {visible.map(item => <li className="review-queue-row" key={`${item.kind}-${item.entityId}`} data-review-kind={item.kind} data-review-id={item.entityId}>
            <div className="review-queue-item-main">
              <div className="review-queue-item-meta"><span className="badge badge-neutral">{labels[item.kind]}</span>
                {item.taskStatus && <span>任务进度：{taskLabels[item.taskStatus]}</span>}
                <span className={item.blockedBy.length ? "review-queue-waiting" : "review-queue-ready"}>{item.blockedBy.length ? `先核对 ${item.blockedBy.length} 项关联结论` : "可先核对"}</span>
              </div>
              <h3>{item.title}</h3>
              <p className="review-queue-sources"><Link2 size={14} aria-hidden="true" /><span>当前关联资料：{item.sources.length ? item.sources.map(source => source.title).join("、") : "没有可显示的关联资料"}</span></p>
              {item.blockedBy.length > 0 && <details className="review-queue-dependencies">
                <summary>查看需要先核对的结论</summary>
                <ul>{item.blockedBy.map(claim => <li key={claim.claimId}><button type="button" className="text-button" aria-label={`先核对结论：${claim.text}`} disabled={disabled} onClick={() => onReview({ kind: "claim", entityId: claim.claimId })}><span>{claim.text}</span><ArrowRight size={14} aria-hidden="true" /></button></li>)}</ul>
              </details>}
            </div>
            <button type="button" className="button subtle review-queue-open" disabled={disabled} onClick={() => onReview(item)}>{item.blockedBy.length ? "查看依赖与原文" : "核对本项"}<ArrowRight size={15} aria-hidden="true" /></button>
          </li>)}
        </ol> : <div className="review-queue-no-results"><Filter size={23} aria-hidden="true" /><h3>没有符合筛选的待复核内容</h3><p>可以调整类型、资料或查找文字；筛选不会清除复核提醒。</p><button type="button" className="button secondary" onClick={clearFilters}>显示全部待复核内容</button></div>}
        {pageCount > 1 && <nav className="review-queue-pagination" aria-label="待复核清单分页"><button type="button" className="button subtle" aria-label="上一页待复核内容" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} aria-hidden="true" />上一页</button><span>第 {currentPage + 1} / {pageCount} 页 · 每页最多 {pageSize} 项</span><button type="button" className="button subtle" aria-label="下一页待复核内容" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight size={16} aria-hidden="true" /></button></nav>}
        <p className="review-queue-footnote">仅依据已建立的关联排序。可先核对不代表结论正确，保存时仍会校验最新依据；每项需分别确认，任务进度与历史报告保留。</p>
      </>}
    </section>
  );
}
