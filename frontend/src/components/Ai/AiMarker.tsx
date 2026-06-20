import { PrismGlyph } from './PrismGlyph';
import { PrismThinking } from './PrismThinking';
import { AI_PROVENANCE_LABEL, AI_WORKING_LABEL } from './aiStrings';
import styles from './AiMarker.module.css';

export interface AiMarkerProps {
  /** 'superscript' (default) = tiny raised glyph beside a text label;
   *  'inline' = baseline glyph for buttons / nav / headers;
   *  'lead' = larger glyph placed before a text label (headings / sub-tabs). */
  variant?: 'superscript' | 'inline' | 'lead';
  /** 'idle' (default) = the static Prism-pyramid provenance glyph (#489). 'working' =
   *  AI in flight: the pyramid spins on its vertical axis with a breathing sparkle
   *  (PrismThinking), in a distinct energised hue (--ai-working-color). Both freeze to
   *  the resting glyph under prefers-reduced-motion. */
  state?: 'idle' | 'working';
  /** Identity use: decorative glyph only, no sr-only label. Use where adjacent
   *  visible "AI…" text already announces provenance/progress. Default false. */
  decorative?: boolean;
  className?: string;
}

// Presentational AI marker (#489, extended in #508). Holds no hooks: the host
// decides when to mount it and in which state. Static or pulsing per `state`.
export function AiMarker({
  variant = 'superscript',
  state = 'idle',
  decorative = false,
  className,
}: AiMarkerProps) {
  const working = state === 'working';
  const cls = [styles.aiMarker, styles[variant], working && styles.working, className]
    .filter(Boolean)
    .join(' ');
  return (
    // Native `title` hover tooltip on the working marker (#508) — "AI is working…".
    // Native title is PRism's house tooltip chrome (used app-wide), so this matches by
    // construction. Working state only; the idle provenance marker carries its own label.
    <span
      className={cls}
      data-ai-marker=""
      data-ai-state={state}
      data-testid="ai-marker"
      title={working ? AI_WORKING_LABEL : undefined}
    >
      {working ? (
        <PrismThinking className={styles.glyph} />
      ) : (
        <PrismGlyph className={styles.glyph} />
      )}
      {!decorative && (
        <span className="sr-only">{working ? AI_WORKING_LABEL : AI_PROVENANCE_LABEL}</span>
      )}
    </span>
  );
}
