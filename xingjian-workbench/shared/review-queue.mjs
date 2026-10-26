/**
 * Derive navigation from the project's current review flags only. This is not a
 * review decision: the server preview and token remain authoritative on save.
 */
export function buildReviewQueue(project) {
  const sources = new Map(project.sources.map((source) => [source.id, source]));
  const claims = new Map(project.claims.map((claim) => [claim.id, claim]));
  const ready = [];
  const blocked = [];

  function add(kind, entity) {
    const linkedClaims =
      kind === "claim"
        ? [entity]
        : entity.claimIds.map((id) => claims.get(id)).filter(Boolean);
    const sourceIds = new Set();
    const linkedSources = [];
    for (const claim of linkedClaims) {
      // Use live evidence, never an inferred or historical dependency snapshot.
      for (const evidence of claim.evidence) {
        const source = sources.get(evidence.sourceId);
        if (!source || sourceIds.has(source.id)) continue;
        sourceIds.add(source.id);
        linkedSources.push({ sourceId: source.id, title: source.title });
      }
    }
    const blockedBy =
      kind === "claim"
        ? []
        : linkedClaims
            .filter((claim) => claim.status === "needs_review")
            .map((claim) => ({ claimId: claim.id, text: claim.text }));
    const item = {
      kind,
      entityId: entity.id,
      title: kind === "claim" ? entity.text : entity.title,
      ...(kind === "task" ? { taskStatus: entity.status } : {}),
      sources: linkedSources,
      blockedBy,
    };
    (blockedBy.length ? blocked : ready).push(item);
  }

  for (const claim of project.claims)
    if (claim.status === "needs_review") add("claim", claim);
  for (const task of project.tasks)
    if (task.reviewRequired) add("task", task);
  for (const artifact of project.artifacts)
    if (artifact.status === "needs_review") add("artifact", artifact);
  return [...ready, ...blocked];
}

/** Literal filtering keeps the queue's dependency-first order unchanged. */
export function filterReviewQueue(items, filters) {
  const query = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (
      filters.sourceId &&
      !item.sources.some((source) => source.sourceId === filters.sourceId)
    )
      return false;
    if (filters.readiness === "ready" && item.blockedBy.length) return false;
    if (filters.readiness === "blocked" && !item.blockedBy.length) return false;
    return (
      !query ||
      item.title.toLowerCase().includes(query) ||
      item.sources.some((source) => source.title.toLowerCase().includes(query))
    );
  });
}
