import { useNavigate, useLocation } from 'react-router-dom';
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
  // #496: when true (any failed seam timed out) the toast shows timeout copy + an "Adjust timeout"
  // deep-link to /settings/ai. Otherwise the existing generic line.
  anyTimedOut: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function AiFailureToast({ seams, retrying, anyTimedOut, onRetry, onDismiss }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  // Both message branches list the failed seams now (claude[bot] #1: the timeout copy used to drop
  // them), so compute once.
  const names = seams.map((s) => DISPLAY_NAME[s]).join(', ');

  const adjustTimeout = () => {
    // backgroundLocation is REQUIRED: it makes the settings modal open OVER the current PR. Without
    // it, App.tsx's isSettingsPath fallback ({ pathname: '/' }) tears the PR down and the failure
    // context is lost. After the user closes Settings the PR remounts, the failed seams remain in the
    // registry, and this toast re-appears so the user can Retry with the new timeout.
    navigate('/settings/ai', { state: { backgroundLocation: location } });
  };

  return (
    <div className={styles.toast} role="group" aria-label="AI generation failure">
      <span className={styles.message}>
        {anyTimedOut
          ? `AI generation timed out: ${names}.`
          : `AI couldn't generate: ${names} — the provider failed or timed out.`}
      </span>
      {/* Retry is the primary recovery path → first in DOM/tab order. "Adjust timeout" is the
          supplementary escape hatch, then Dismiss. (design-lens: primary action first.) */}
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      {anyTimedOut && (
        <button type="button" className={styles.adjust} onClick={adjustTimeout}>
          Adjust timeout
        </button>
      )}
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
