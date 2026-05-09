import type { PrSummary } from '../../../api/types';

interface AiSummaryCardProps {
  summary: PrSummary | null;
}

export function AiSummaryCard({ summary }: AiSummaryCardProps) {
  if (!summary) return null;

  return (
    <section className="ai-summary-card overview-card overview-card-hero ai-tint">
      <div className="ai-summary-chip muted">
        AI preview — sample content, not generated from this PR
      </div>
      <div className="ai-summary-body">{summary.body}</div>
      <div className="ai-summary-category">{summary.category}</div>
    </section>
  );
}
