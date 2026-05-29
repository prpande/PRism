import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import styles from './PrDescription.module.css';

interface PrDescriptionProps {
  title: string;
  body: string;
  aiPreview: boolean;
}

export function PrDescription({ title, body, aiPreview }: PrDescriptionProps) {
  const isEmptyBody = body.trim().length === 0;
  // `overview-card` is a literal class that fires the global tokens.css rule
  // (D22 lift) — supplies the card surface (background, border, base padding).
  // `pr-description` is a literal placeholder for future reach (no rule today).
  // `overview-card-hero-no-ai` is a LITERAL test seam only — it has no global
  // rule. The actual hero treatment (larger radius + padding) in the AI-OFF
  // path comes from the hashed `styles.overviewCardHeroNoAi` module class
  // appended alongside it. The literal-class-as-test-seam pattern (D16) lets
  // `OverviewTab.test.tsx` assert `toHaveClass('overview-card-hero-no-ai')`
  // even though CSS Modules has hashed the styling-bearing class.
  const cardClass = aiPreview
    ? `overview-card pr-description`
    : `overview-card pr-description ${styles.overviewCardHeroNoAi} overview-card-hero-no-ai`;

  return (
    <section className={cardClass} data-testid="pr-description">
      {!aiPreview && <div className={styles.prDescriptionTitle}>{title}</div>}
      {isEmptyBody ? (
        <p className={`${styles.prDescriptionEmpty} muted`}>No description provided</p>
      ) : (
        <MarkdownRenderer source={body} className={styles.prDescriptionBody} />
      )}
    </section>
  );
}
