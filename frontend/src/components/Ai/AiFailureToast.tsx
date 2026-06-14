import styles from './AiFailureToast.module.css';
import type { AiSeam } from './aiFailure';

const DISPLAY_NAME: Record<AiSeam, string> = {
  summary: 'summary',
  'file-focus': 'hotspots',
  'hunk-annotations': 'annotations',
  'draft-suggestions': 'draft suggestions',
};

interface Props {
  seams: AiSeam[];
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function AiFailureToast({ seams, retrying, onRetry, onDismiss }: Props) {
  const names = seams.map((s) => DISPLAY_NAME[s]).join(', ');
  return (
    <div className={styles.toast} role="group" aria-label="AI generation failure">
      <span className={styles.message}>
        {`AI couldn't generate: ${names} — the provider failed or timed out.`}
      </span>
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
