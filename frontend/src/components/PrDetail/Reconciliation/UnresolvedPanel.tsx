import { useEffect, useMemo, useRef, useState } from 'react';
import { sendPatch } from '../../../api/draft';
import type { PrReference, ReviewSessionDto } from '../../../api/types';
import { StaleDraftRow, type StaleDraft } from './StaleDraftRow';

interface UnresolvedPanelProps {
  prRef: PrReference;
  session: ReviewSessionDto | null;
  // Test-only escape hatch: forces the panel to render the
  // "All drafts reconciled." announce-only state. Production callers don't
  // need this — the panel emits the message itself when staleCount transitions
  // from positive to zero (see useEffect in body).
  announceReconciled?: boolean;
}

interface PanelCounts {
  stale: StaleDraft[];
  movedCount: number;
  needsReconfirm: boolean;
}

function computeCounts(session: ReviewSessionDto | null): PanelCounts {
  if (!session) return { stale: [], movedCount: 0, needsReconfirm: false };
  const stale: StaleDraft[] = [];
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

export function UnresolvedPanel({ prRef, session, announceReconciled }: UnresolvedPanelProps) {
  const counts = useMemo(() => computeCounts(session), [session]);
  const containerRef = useRef<HTMLElement | null>(null);
  const lastAnnouncedRef = useRef<string>('');

  // Focus the panel programmatically when it first appears so a screen reader
  // announces the region's contents (per spec § 5.5b).
  const visible = counts.stale.length > 0 || counts.movedCount > 0 || counts.needsReconfirm;
  const previousVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !previousVisibleRef.current) {
      containerRef.current?.focus();
    }
    previousVisibleRef.current = visible;
  }, [visible]);

  const [confirmingVerdict, setConfirmingVerdict] = useState(false);

  const handleConfirmVerdict = async () => {
    if (confirmingVerdict) return;
    setConfirmingVerdict(true);
    const result = await sendPatch(prRef, { kind: 'confirmVerdict' });
    if (!result.ok) {
      console.warn('confirm-verdict failed', result);
      setConfirmingVerdict(false);
    }
    // On success the parent's session refetch (via state-changed SSE) will
    // flip draftVerdictStatus to 'draft' and the row hides naturally.
  };

  // Announce-region content. When the panel is visible, mirror the summary
  // so screen readers track stale-count transitions. When hidden via the
  // explicit `announceReconciled` flag, surface the reconciled message
  // (parents render the panel one more time with that flag set after the
  // last stale draft clears, so the AT user gets confirmation).
  const summary = buildSummary(counts);
  const announceText = announceReconciled && !visible ? 'All drafts reconciled.' : summary;
  if (announceText && announceText !== lastAnnouncedRef.current) {
    lastAnnouncedRef.current = announceText;
  }

  if (!visible) {
    if (announceReconciled) {
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
          <StaleDraftRow key={d.data.id} prRef={prRef} draft={d} />
        ))}
        {counts.needsReconfirm && (
          <li className="verdict-reconfirm-row row gap-2">
            <span className="chip chip-status-stale">Verdict</span>
            <span>Verdict needs re-confirm after the head shifted.</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleConfirmVerdict()}
              disabled={confirmingVerdict}
            >
              Confirm verdict
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
