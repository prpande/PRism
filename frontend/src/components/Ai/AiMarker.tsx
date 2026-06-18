import { SparkIcon } from './SparkIcon';
import { AI_PROVENANCE_LABEL } from './aiStrings';
import styles from './AiMarker.module.css';

export interface AiMarkerProps {
  /** 'superscript' (default) = tiny raised glyph beside a text label;
   *  'inline' = baseline glyph for buttons / nav / headers. */
  variant?: 'superscript' | 'inline';
  /** Identity use: decorative glyph only, no sr-only label. Use where adjacent
   *  visible "AI…" text already announces provenance. Default false = provenance. */
  decorative?: boolean;
  className?: string;
}

// Pure presentational AI marker (#489). Holds no hooks: the host mounts it only
// where real AI content renders (never on loading/error copy). Static, non-interactive.
export function AiMarker({ variant = 'superscript', decorative = false, className }: AiMarkerProps) {
  const cls = [
    styles.aiMarker,
    variant === 'inline' ? styles.inline : styles.superscript,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} data-ai-marker="" data-testid="ai-marker">
      <SparkIcon className={styles.glyph} />
      {!decorative && <span className="sr-only">{AI_PROVENANCE_LABEL}</span>}
    </span>
  );
}
