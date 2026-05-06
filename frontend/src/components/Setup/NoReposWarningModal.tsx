import styles from './NoReposWarningModal.module.css';

interface Props {
  onContinue: () => void | Promise<void>;
  onEdit: () => void;
  busy?: boolean;
}

export function NoReposWarningModal({ onContinue, onEdit, busy }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="no-repos-title" className={styles.backdrop}>
      <div className={styles.modal}>
        <h2 id="no-repos-title">No repos selected</h2>
        <p>
          Your token has no repositories selected. You&apos;ll see an empty inbox until
          you add repos in your GitHub token settings.
        </p>
        <p>Continue anyway, or go back and edit the token scope?</p>
        <div className={styles.actions}>
          <button type="button" onClick={onEdit} disabled={busy}>
            Edit token scope
          </button>
          <button type="button" onClick={() => void onContinue()} disabled={busy}>
            {busy ? 'Saving…' : 'Continue anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
