// Spec § 12: shown when the submit pipeline found the persisted pending review
// was anchored to a stale commit (the PR head moved). The orphan was deleted +
// session stamps cleared server-side; this banner is the user-consent gate for
// the resubmit. Cancel is always enabled (distinct from in-flight). If the user
// hasn't Reloaded since (the "Reload" banner is still up), "Recreate and
// resubmit" is disabled with a reminder to Reload first so the drafts get
// re-classified against the new diff; the pipeline's pre-Finalize head_sha
// re-poll (R11) is the downstream net if they push again mid-recreate.

interface Props {
  currentHeadSha: string;
  notReloadedYet: boolean;
  onCancel(): void;
  onResubmit(): void;
}

export function StaleCommitOidBanner({
  currentHeadSha,
  notReloadedYet,
  onCancel,
  onResubmit,
}: Props) {
  const shortSha = currentHeadSha ? currentHeadSha.slice(0, 7) : '';
  return (
    <div className="stale-commit-oid-banner" role="alert">
      <p>
        The PR&rsquo;s head commit changed since this pending review was started. Recreating the
        review{shortSha ? <> against the new head sha <code>{shortSha}</code></> : null}. Your drafts
        are preserved and will be re-attached.
      </p>
      {notReloadedYet && <p>Click Reload first to re-classify your drafts against the new diff.</p>}
      <div className="stale-commit-oid-banner__buttons">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={notReloadedYet}
          title={
            notReloadedYet
              ? 'Reload the PR first to re-classify drafts against the new diff.'
              : undefined
          }
          onClick={onResubmit}
        >
          Recreate and resubmit
        </button>
      </div>
    </div>
  );
}
