import type { HunkAnnotation, AnnotationTone } from '../../../../api/types';
import styles from './AiHunkAnnotation.module.css';

export interface AiHunkAnnotationProps {
  annotation: HunkAnnotation;
}

// Tone → chip variant + label lookup. Adding a tone value here is the only
// touch required when the wire shape widens (e.g., a future v2 emits a new
// tone): map to the appropriate chip variant + handoff-aligned label.
const TONE_CHIP: Record<AnnotationTone, { variant: 'info' | 'warning' | 'danger'; label: string }> =
  {
    calm: { variant: 'info', label: 'Note' },
    'heads-up': { variant: 'warning', label: 'Behavior change' },
    concern: { variant: 'danger', label: 'Concern' },
  };

export function AiHunkAnnotation({ annotation }: AiHunkAnnotationProps) {
  const chip = TONE_CHIP[annotation.tone];
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk-annotation">
      <span className="ai-icon" aria-hidden="true">
        ✨
      </span>
      <div className={styles.aiHunkBody}>
        <div className={`ai-hunk-meta ${styles.aiHunkMeta}`}>
          <span>AI</span>
          <span className={`chip chip-${chip.variant}`}>{chip.label}</span>
        </div>
        <div>{annotation.body}</div>
      </div>
    </div>
  );
}
