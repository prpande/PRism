import { useEffect, useMemo, useRef, useState } from 'react';
import { sendPatch } from '../../../api/draft';
import type { PrReference, ReviewSessionDto } from '../../../api/types';
import { StaleDraftRow } from './StaleDraftRow';
import type { DraftLike } from '../draftKinds';

interface UnresolvedPanelProps {
  prRef: PrReference;
  session: ReviewSessionDto | null;
  // Own-tab state-changed events are filtered (spec § 5.7), so the
  // panel cannot rely on SSE to refresh after its verdict-confirm or
  // its child rows' Keep-anyway / Delete actions. PrDetailPage passes
  // draftSession.refetch in.
  onMutated: () => void;
  // Spec § 5.7a — when a peer tab claimed cross-tab ownership, gate the
  // verdict-confirm + StaleDraftRow actions so this tab cannot race the
  // claiming tab's edits.
  readOnly?: boolean;
}

interface PanelCounts {
  stale: DraftLike[];
  movedCount: number;
  needsReconfirm: boolean;
}

function computeCounts(session: ReviewSessionDto | null): PanelCounts {
  if (!session) return { stale: [], movedCount: 0, needsReconfirm: false };
  const stale: DraftLike[] = [];
  let movedCount = 0;
  for (const c of session.draftComments) {
    if (c.isOverriddenStale) continue;
    if (c.status === 'stale') stale.push({ kind: 'comment', data: c });
    else if (c.status === 'moved') movedCount++;
  }
  for (const r of session.draftReplies) {
    if (r.isOverriddenStale) continue;
    if (r.status === 'stale') stale.push({ kind: 'reply', data: r });
    else if (r.status === 'moved') movedCount++;
  }
  return {
    stale,
    movedCount,
    needsReconfirm: session.draftVerdictStatus === 'needs-reconfirm',
  };
}

function buildSummary(counts: PanelCounts): string {
  const parts: string[] = [];
  if (counts.stale.length > 0) {
    parts.push(
      `${counts.stale.length} draft${counts.stale.length === 1 ? '' : 's'} need${counts.stale.length === 1 ? 's' : ''} attention`,
    );
  }
  if (counts.movedCount > 0) parts.push(`${counts.movedCount} moved`);
  if (counts.needsReconfirm) parts.push('verdict needs re-confirm');
  return parts.join(' · ');
}

// How long the "All drafts reconciled." announcement stays mounted.
// Long enough for a screen reader to pick up the polite live-region
// update; short enough that it doesn't linger past the user's task.
const RECONCILED_ANNOUNCE_MS = 4000;

export function UnresolvedPanel({
  prRef,
  session,
  onMutated,
  readOnly = false,
}: UnresolvedPanelProps) {
  const counts = useMemo(() => computeCounts(session), [session]);
  const containerRef = useRef<HTMLElement | null>(null);

  const visible = counts.stale.length > 0 || counts.movedCount > 0 || counts.needsReconfirm;

  // Focus the panel programmatically when it first appears so a screen
  // reader announces the region's contents (spec § 5.5b).
  const previousVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !previousVisibleRef.current) {
      containerRef.current?.focus();
    }
    previousVisibleRef.current = visible;
  }, [visible]);

  // staleCount → 0 transition detection. When the last stale draft
  // clears (delete / keep-anyway / reconciliation-pass move), the panel
  // hides — but we hold a hidden aria-live region for a few seconds
  // with "All drafts reconciled." so screen-reader users get the
  // confirmation. Tracked with a ref so React's batched-state path
  // doesn't double-fire on a single transition.
  const previousStaleCountRef = useRef(counts.stale.length);
  const [reconciledAnnounce, setReconciledAnnounce] = useState(false);
  useEffect(() => {
    const prev = previousStaleCountRef.current;
    const now = counts.stale.length;
    previousStaleCountRef.current = now;
    if (prev > 0 && now === 0) {
      setReconciledAnnounce(true);
      const timer = setTimeout(() => setReconciledAnnounce(false), RECONCILED_ANNOUNCE_MS);
      return () => clearTimeout(timer);
    }
  }, [counts.stale.length]);

  const [confirmingVerdict, setConfirmingVerdict] = useState(false);

  const handleConfirmVerdict = async () => {
    if (confirmingVerdict || readOnly) return;
    setConfirmingVerdict(true);
    const result = await sendPatch(prRef, { kind: 'confirmVerdict' });
    setConfirmingVerdict(false);
    if (!result.ok) {
      console.warn('confirm-verdict failed', result);
      return;
    }
    onMutated();
  };

  if (!visible) {
    if (reconciledAnnounce) {
      return (
        <div
          aria-live="polite"
          className="unresolved-panel-announce-only"
          data-testid="unresolved-panel-announce"
        >
          All drafts reconciled.
        </div>
      );
    }
    return null;
  }

  const summary = buildSummary(counts);

  return (
    <section
      ref={containerRef}
      role="region"
      aria-label="Unresolved drafts"
      tabIndex={-1}
      className="unresolved-panel"
    >
      <header className="unresolved-panel-summary">
        <span aria-live="polite" className="unresolved-panel-announce">
          {summary}
        </span>
      </header>
      <ul className="unresolved-panel-rows">
        {counts.stale.map((d) => (
          <StaleDraftRow key={d.data.id} prRef={prRef} draft={d} onMutated={onMutated} />
        ))}
        {counts.needsReconfirm && (
          <li className="verdict-reconfirm-row row gap-2">
            <span className="chip chip-status-stale">Verdict</span>
            <span>Verdict needs re-confirm after the head shifted.</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleConfirmVerdict()}
              disabled={confirmingVerdict || readOnly}
              title={readOnly ? 'Another tab is editing this PR.' : undefined}
            >
              Confirm verdict
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
