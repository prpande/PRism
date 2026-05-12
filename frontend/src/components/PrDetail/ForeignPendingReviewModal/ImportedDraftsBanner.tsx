// Spec § 11.1: shown above the imported drafts after a foreign-pending-review
// Resume. Two independent notes:
//
//  1. Snapshot A → B count staleness — Snapshot A is the counts the user saw in
//     the prompt (the SSE submit-foreign-pending-review event); Snapshot B is
//     what the resume 200 actually imported. If they differ, the pending review
//     changed during the prompt. (Per-thread body-level staleness is explicitly
//     NOT detected — residual risk, logged in the deferrals sidecar.)
//
//  2. IsResolved pre-flight — if any imported thread was resolved on github.com,
//     submitting will re-publish it; the user is asked to edit or discard the
//     resolved threads first.
//
// Renders nothing when neither applies (the common case: counts matched, no
// resolved imports).

interface SnapshotCounts {
  threadCount: number;
  replyCount: number;
}

interface Props {
  snapshotA: SnapshotCounts;
  snapshotB: SnapshotCounts;
  hasResolvedImports: boolean;
}

export function ImportedDraftsBanner({ snapshotA, snapshotB, hasResolvedImports }: Props) {
  const countDrift =
    snapshotA.threadCount !== snapshotB.threadCount ||
    snapshotA.replyCount !== snapshotB.replyCount;

  if (!countDrift && !hasResolvedImports) return null;

  return (
    <div className="imported-drafts-banner banner-warning" role="status" aria-live="polite">
      {countDrift && (
        <p>
          The pending review changed during the prompt — {snapshotB.threadCount} thread(s) /{' '}
          {snapshotB.replyCount} reply(ies) imported (you saw {snapshotA.threadCount} /{' '}
          {snapshotA.replyCount} in the prompt).
        </p>
      )}
      {hasResolvedImports && (
        <p>
          One or more imported thread(s) were resolved on github.com. Submitting will re-publish
          them. Edit or Discard the resolved threads first if you don&rsquo;t want to re-publish
          them.
        </p>
      )}
    </div>
  );
}
