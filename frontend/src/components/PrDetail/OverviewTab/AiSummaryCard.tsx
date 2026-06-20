import { useState, useRef, useEffect } from 'react';
import type { PrSummary } from '../../../api/types';
import { Spinner } from '../../Spinner/Spinner';
import { SampleBadge } from '../../Ai/SampleBadge';
import { AiMarker } from '../../Ai/AiMarker';
import { Skeleton } from '../../Skeleton/Skeleton';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import styles from './AiSummaryCard.module.css';

interface AiSummaryCardProps {
  summary: PrSummary | null;
  loading: boolean;
  error: boolean;
  isStale?: boolean;
  regenerating?: boolean;
  regenerateError?: boolean;
  onRegenerate?: () => void;
  live?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  feature: 'Feature',
  fix: 'Fix',
  refactor: 'Refactor',
  docs: 'Docs',
  test: 'Test',
  chore: 'Chore',
  revert: 'Revert',
};

export function AiSummaryCard({
  summary,
  loading,
  error,
  isStale = false,
  regenerating = false,
  regenerateError = false,
  onRegenerate,
  live = false,
}: AiSummaryCardProps) {
  // Hooks MUST run before the early returns below (rules-of-hooks).
  // Announce a successful regenerate to AT: when `regenerating` goes true→false
  // with no error, surface "Summary updated" briefly.
  const [announce, setAnnounce] = useState('');
  const wasRegenerating = useRef(false);
  useEffect(() => {
    const justFinished = wasRegenerating.current && !regenerating && !regenerateError;
    wasRegenerating.current = regenerating;
    if (!justFinished) return;
    setAnnounce('Summary updated');
    const t = setTimeout(() => setAnnounce(''), 1500);
    return () => clearTimeout(t);
  }, [regenerating, regenerateError]);

  // #525 D6 — stale-on-MOUNT announce. The primary cap-change flow is cross-page (change the cap in
  // Settings → return to the PR): the card remounts with the "Out of date" chip already present, so the
  // polite live region is silent (initial content isn't announced; only later mutations are). A later
  // false→true flip while mounted DOES insert the chip → announced naturally, so this runs ONCE on mount
  // for the already-stale case only. Also covers pre-existing base-SHA drift detected before mount.
  // Live-only (the chip is Live-only). The announce text avoids the literal "out of date" so it doesn't
  // collide with the chip when both sit in the region.
  const didMountStaleAnnounce = useRef(false);
  useEffect(() => {
    if (didMountStaleAnnounce.current) return;
    didMountStaleAnnounce.current = true; // mount-only: a later isStale flip is announced via chip insertion
    if (!(live && isStale)) return;
    setAnnounce('Summary is no longer up to date.');
    const t = setTimeout(() => setAnnounce(''), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only snapshot of live/isStale by design
  }, []);

  if (loading) {
    return (
      <section
        className={`${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
        aria-busy="true"
      >
        <span className={styles.aiSummaryLabel}>
          <AiMarker variant="lead" state="working" decorative />
          AI Summary
        </span>
        <span className="sr-only" aria-live="polite">
          Loading AI summary…
        </span>
        <Skeleton height={16} />
        <Skeleton height={16} width="80%" />
      </section>
    );
  }
  if (error) {
    return (
      <section
        className={`${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
        role="status"
      >
        <div className={styles.aiSummaryError}>
          AI summary unavailable — reopen this PR to try again.
        </div>
      </section>
    );
  }
  if (!summary) return null;

  // Normalize case: the Live parser emits lowercase canonical categories, but the Preview
  // PlaceholderPrSummarizer emits capitalized ones (e.g. "Refactor"). Out-of-taxonomy / empty
  // values fall through to no chip (body-only), per spec §10.
  const label = summary.category ? CATEGORY_LABELS[summary.category.toLowerCase()] : undefined;
  const showStale = live && isStale; // Live-only (spec §8)

  return (
    <section
      className={`ai-summary-card ${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
      data-testid="ai-summary-card"
    >
      {/* Single header row, rendered identically in Preview and Live so both modes share one
          layout: the AI-summary label, the Preview-only Sample badge, and the Live-only status
          region (stale chip + Regenerate) all sit on one vertically-centered flex row. The
          category chip and body fall below the header in BOTH modes. */}
      <div className={styles.aiSummaryHead} data-testid="ai-summary-head">
        <span className={styles.aiSummaryLabel}>
          <AiMarker variant="lead" decorative />
          AI Summary
        </span>
        <SampleBadge />
        {/* Live-only status region. Always present WITHIN Live (even when not stale) so a
            later-inserted "Out of date" chip / "Summary updated" announce is surfaced to AT via the
            polite live region. Absent in Preview/Off, where there is nothing to announce. */}
        {live && (
          <span className={styles.aiSummaryStatus} role="status" aria-live="polite">
            {showStale && (
              <>
                <span className="chip chip-status-stale" data-testid="ai-summary-stale-chip">
                  Out of date
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="Regenerate summary"
                  title="Regenerate summary"
                  disabled={regenerating}
                  onClick={onRegenerate}
                  data-testid="ai-summary-regenerate"
                >
                  {regenerating ? (
                    <Spinner decorative size="sm" />
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                  )}
                </button>
                {regenerateError && (
                  <span className={styles.aiSummaryError} data-testid="ai-summary-regenerate-error">
                    Couldn't regenerate — try again.
                  </span>
                )}
              </>
            )}
            {announce && <span className="sr-only">{announce}</span>}
          </span>
        )}
      </div>
      {label && (
        <span className={styles.chip} data-testid="ai-summary-category">
          {label}
        </span>
      )}
      <MarkdownRenderer source={summary.body} className={`ai-markdown ${styles.aiSummaryBody}`} />
    </section>
  );
}
