import type { PrSummary } from '../../../api/types';
import { SampleBadge } from '../../Ai/SampleBadge';
import styles from './AiSummaryCard.module.css';

interface AiSummaryCardProps {
  summary: PrSummary | null;
}

export function AiSummaryCard({ summary }: AiSummaryCardProps) {
  if (!summary) return null;

  return (
    <section
      className={`ai-summary-card ${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
      data-testid="ai-summary-card"
    >
      <SampleBadge />
      <div className={styles.aiSummaryBody}>{summary.body}</div>
      <div className={styles.aiSummaryCategory} data-testid="ai-summary-category">
        {summary.category}
      </div>
    </section>
  );
}
