import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Skeleton } from '../Skeleton/Skeleton';
import { Spinner } from '../Spinner';
import { SparkIcon } from '../Ai/SparkIcon';
import { getEgressDisclosure, postAiConsent, type EgressDisclosure } from '../../api/aiConsent';
import styles from './EgressConsentModal.module.css';

interface Props {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

// Decorative inline glyphs (aria-hidden) — no central icon set in this repo.
function WarningTriangleIcon({ className }: { className?: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M8 1.75 14.5 13.5H1.5L8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.25V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}
function CircleAlertIcon({ className }: { className?: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75V8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="10.75" r="0.85" fill="currentColor" />
    </svg>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className={styles.errBox} role="alert" aria-live="assertive">
      <CircleAlertIcon className={styles.errIcon} />
      <span>{message}</span>
    </div>
  );
}

export function EgressConsentModal({ open, onAccept, onDecline }: Props) {
  const [disclosure, setDisclosure] = useState<EgressDisclosure | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Tracks whether the modal is still open. A consent POST can outlive a dismissal
  // (Escape / Decline while it is in flight); without this guard the late resolution
  // would call onAccept() and commit Live despite the user's dismissal.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDisclosure(null);
    setFailed(false);
    setSubmitError(false);
    setSubmitting(false);
    getEgressDisclosure()
      .then((d) => {
        if (!cancelled) setDisclosure(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const accept = async () => {
    if (!disclosure) return;
    setSubmitting(true);
    setSubmitError(false);
    try {
      await postAiConsent(disclosure.disclosureVersion);
      if (!openRef.current) return; // dismissed mid-POST — don't commit Live
      onAccept();
    } catch {
      if (openRef.current) setSubmitError(true); // consent POST failure (incl. 409) — retry allowed (not an LLM call)
    } finally {
      if (openRef.current) setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Enable Live AI"
      titleIcon={<SparkIcon />}
      align="center"
      onClose={onDecline}
      defaultFocus="cancel"
      role="dialog"
    >
      {failed ? (
        <ErrorBox message="Couldn't load the data-sharing disclosure. Close and try again." />
      ) : !disclosure ? (
        <div aria-busy="true">
          <span className="sr-only" aria-live="polite">
            Loading data-sharing disclosure…
          </span>
          <Skeleton height={14} />
          <Skeleton height={14} width="70%" />
          <div className={styles.skeletonCallout}>
            <Skeleton height={14} width="55%" />
            <Skeleton height={12} width="80%" />
            <Skeleton height={12} width="45%" />
          </div>
        </div>
      ) : (
        <div>
          <p className={styles.lead}>
            Live AI generates a real, diff-grounded summary of this pull request.
          </p>
          <div className={styles.callout}>
            <div className={styles.calloutHead}>
              <WarningTriangleIcon className={styles.calloutIcon} />
              <span>
                Sent off your device to{' '}
                <strong className={styles.recipient}>{disclosure.recipient}</strong>:
              </span>
            </div>
            <ul className={styles.dataList}>
              {disclosure.dataCategories.map((c) => (
                <li key={c} className={styles.dataItem}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {submitError && <ErrorBox message="Couldn't enable Live AI. Please try again." />}
      <div className="modal-actions row gap-2">
        <button
          type="button"
          className={`btn ${styles.declineBtn}`}
          data-modal-role="cancel"
          onClick={onDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className={`btn btn-success ${styles.enableBtn}`}
          data-modal-role="primary"
          onClick={() => void accept()}
          disabled={!disclosure || failed || submitting}
        >
          {submitting ? (
            <>
              <Spinner size="sm" decorative />
              Enabling…
            </>
          ) : (
            'Enable Live'
          )}
        </button>
      </div>
    </Modal>
  );
}
