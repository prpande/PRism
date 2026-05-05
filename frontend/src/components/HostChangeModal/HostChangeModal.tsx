import styles from './HostChangeModal.module.css';

interface Props {
  oldHost: string;
  newHost: string;
  onContinue: () => void;
  onRevert: () => void;
}

export function HostChangeModal({ oldHost, newHost, onContinue, onRevert }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="hcm-title" className={styles.modal}>
      <div className={styles.card}>
        <h2 id="hcm-title">github.host changed</h2>
        <p>
          You changed <code>github.host</code> from <strong>{oldHost}</strong> to{' '}
          <strong>{newHost}</strong>. Pending reviews and per-thread server stamps in your local
          state were issued by the old host and won't match the new one.
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={onContinue}>
            Continue
          </button>
          <button type="button" onClick={onRevert}>
            Revert
          </button>
        </div>
      </div>
    </div>
  );
}
