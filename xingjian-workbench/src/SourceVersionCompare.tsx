import { useState } from "react";
import type { Source } from "../shared/contracts";
import TextDiff from "./TextDiff";

export default function SourceVersionCompare({
  source,
  visibleVersionId,
}: {
  source: Source;
  visibleVersionId: string;
}) {
  const visible = source.versions.find(
    (version) => version.id === visibleVersionId,
  )!;
  const initialBefore =
    visible.id !== source.currentVersionId
      ? visible.id
      : (source.versions.at(-2)?.id ?? visible.id);
  const [beforeId, setBeforeId] = useState(initialBefore);
  const [afterId, setAfterId] = useState(source.currentVersionId);
  const before = source.versions.find((version) => version.id === beforeId);
  const after = source.versions.find((version) => version.id === afterId);
  return (
    <details className="source-version-comparison">
      <summary>
        对比资料版本 <span>只读查看，不修改引用和复核状态</span>
      </summary>
      {source.versions.length < 2 ? (
        <p className="muted small">
          这份资料只有一个版本。保存新版本后，可在这里核对变化。
        </p>
      ) : (
        <>
          <div className="source-compare-selectors">
            <label>
              对比起始版本
              <select
                aria-label="对比起始版本"
                value={beforeId}
                onChange={(event) => setBeforeId(event.target.value)}
              >
                {source.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.number}
                    {version.id === source.currentVersionId
                      ? " · 当前"
                      : " · 历史"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              对比目标版本
              <select
                aria-label="对比目标版本"
                value={afterId}
                onChange={(event) => setAfterId(event.target.value)}
              >
                {source.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.number}
                    {version.id === source.currentVersionId
                      ? " · 当前"
                      : " · 历史"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {before && after && (
            <TextDiff
              key={`${before.id}-${after.id}`}
              label="资料版本差异"
              before={before.content}
              after={after.content}
              beforeLabel={`起始资料 · v${before.number}`}
              afterLabel={`目标资料 · v${after.number}`}
            />
          )}
        </>
      )}
    </details>
  );
}
