import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Skeleton } from '../Skeleton/Skeleton';
import { getEgressDisclosure, postAiConsent, type EgressDisclosure } from '../../api/aiConsent';

interface Props {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
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
      onClose={onDecline}
      defaultFocus="cancel"
      role="dialog"
    >
      {failed ? (
        <div role="alert" aria-live="assertive">
          Couldn&apos;t load the data-sharing disclosure. Close and try again.
        </div>
      ) : !disclosure ? (
        <div aria-busy="true">
          <span className="sr-only" aria-live="polite">
            Loading data-sharing disclosure…
          </span>
          <Skeleton height={14} />
          <Skeleton height={14} width="70%" />
        </div>
      ) : (
        <div>
          <p>Live AI generates a real, diff-grounded summary of this pull request.</p>
          <p>
            To do that, the following leaves your device to <strong>{disclosure.recipient}</strong>:
          </p>
          <ul>
            {disclosure.dataCategories.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {submitError && (
        <div role="alert" aria-live="assertive">
          Couldn&apos;t enable Live AI. Please try again.
        </div>
      )}
      <div className="modal-actions row gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          data-modal-role="cancel"
          onClick={onDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-modal-role="primary"
          onClick={() => void accept()}
          disabled={!disclosure || failed || submitting}
        >
          Enable Live
        </button>
      </div>
    </Modal>
  );
}
