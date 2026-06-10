import type { PrSummary } from '../../../api/types';
import { SampleBadge } from '../../Ai/SampleBadge';
import { Skeleton } from '../../Skeleton/Skeleton';
import styles from './AiSummaryCard.module.css';

interface AiSummaryCardProps {
  summary: PrSummary | null;
  loading: boolean;
  error: boolean;
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

export function AiSummaryCard({ summary, loading, error }: AiSummaryCardProps) {
  if (loading) {
    return (
      <section
        className={`${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
        aria-busy="true"
      >
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

  const label = summary.category ? CATEGORY_LABELS[summary.category] : undefined;
  return (
    <section
      className={`ai-summary-card ${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
      data-testid="ai-summary-card"
    >
      <SampleBadge />
      {label && (
        <span className={styles.chip} data-testid="ai-summary-category">
          {label}
        </span>
      )}
      <div className={styles.aiSummaryBody}>{summary.body}</div>
    </section>
  );
}
