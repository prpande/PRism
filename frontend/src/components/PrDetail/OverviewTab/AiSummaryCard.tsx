import type { PrSummary } from '../../../api/types';
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
      <div className={`${styles.aiSummaryChip} muted`}>
        AI preview — sample content, not generated from this PR
      </div>
      <div className={styles.aiSummaryBody}>{summary.body}</div>
      <div className={styles.aiSummaryCategory}>{summary.category}</div>
    </section>
  );
}
