import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import styles from './PrDescription.module.css';

interface PrDescriptionProps {
  title: string;
  body: string;
  aiPreview: boolean;
}

export function PrDescription({ title, body, aiPreview }: PrDescriptionProps) {
  const isEmptyBody = body.trim().length === 0;
  // `overview-card` is a literal class hitting the global tokens.css rule
  // (D22 lift). `pr-description` is a literal placeholder for future reach.
  // `overview-card-hero-no-ai` is a literal hitting the hashed
  // .overviewCardHeroNoAi module rule via the test-seam-and-styling-hook
  // unification (D16). The hashed module class is appended in the AI-OFF
  // path to actually paint the hero treatment.
  const cardClass = aiPreview
    ? `overview-card ${styles.prDescription} pr-description`
    : `overview-card ${styles.prDescription} pr-description ${styles.overviewCardHeroNoAi} overview-card-hero-no-ai`;

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
