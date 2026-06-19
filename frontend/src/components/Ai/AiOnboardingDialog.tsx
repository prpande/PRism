import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Modal } from '../Modal/Modal';
import { SparkIcon } from './SparkIcon';
import { SegmentedControl } from '../controls/SegmentedControl';
import { Spinner } from '../Spinner';
import { usePreferences } from '../../hooks/usePreferences';
import { getEgressDisclosure, postAiConsent, type EgressDisclosure } from '../../api/aiConsent';
import { EgressDisclosureBody, EgressDisclosureSkeleton } from '../Settings/EgressDisclosureBody';
import type { AiMode } from '../../api/types';
import styles from './AiOnboardingDialog.module.css';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'preview', label: 'Preview' },
  { value: 'live', label: 'Live' },
] as const;

const BUTTON: Record<AiMode, { label: string; className: string }> = {
  off: { label: 'Turn off AI', className: `btn btn-secondary ${styles.offBtn}` },
  preview: { label: 'Maybe later', className: 'btn btn-ghost' },
  live: { label: 'Enable Live AI', className: 'btn btn-success' },
};

// Concise SR status per mode (announces the change without re-reading the whole legend card).
const LIVE_STATUS: Record<AiMode, string> = {
  off: 'Off selected.',
  preview: 'Preview selected.',
  live: 'Live selected. Review the data-sharing disclosure below.',
};

export function AiOnboardingDialog({ onDismiss }: { onDismiss: () => void }) {
  const { preferences, set } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const current = preferences?.ui.aiMode ?? 'preview';
  const [pending, setPending] = useState<AiMode>(current);
  const [open, setOpen] = useState(true);
  const regionId = useId();

  // Live inline state machine state
  const [disclosure, setDisclosure] = useState<EgressDisclosure | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false); // getEgressDisclosure failed
  const [submitError, setSubmitError] = useState(false); // postAiConsent failed
  const [submitting, setSubmitting] = useState(false);

  // Refs for abort and teardown guard
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  // Teardown: cancel any in-flight fetch or POST on unmount
  useEffect(
    () => () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
    },
    [],
  );

  const close = () => {
    setOpen(false);
    onDismiss();
  };

  // Esc: no commit, no seen. Re-shows next launch.
  const onEsc = () => close();

  // Manage AI settings: seen, navigate, NO mode commit. Mirrors AiFailureToast's
  // navigate('/settings/ai', { state: { backgroundLocation: location } }) shape
  // so the AI pane opens as a modal overlay over the inbox (App.tsx backgroundLocation gate).
  const onManage = () => {
    void set('ui.ai.onboardingSeen', true).catch(() => {});
    close();
    navigate('/settings/ai', { state: { backgroundLocation: location } });
  };

  // Commit a mode (or keep Preview = no mode write), then mark seen. close() fires FIRST so the
  // dialog never blocks on the writes (and onboardingDismissed in InboxPage gates re-mount, so no
  // flash). seen is chained AFTER the mode write *succeeds* — so a failed mode write does not burn
  // the one-shot (the dialog re-shows and the user retries) and never leaves the Live split-brain
  // "consent recorded / mode still Preview". For Preview (no mode change) the seen-write is direct.
  // This preserves spec §6.1's "seen last" while closing the mode-write-fails gap.
  const commitMode = (mode: AiMode) => {
    if (cancelledRef.current) return; // dismissed/unmounted mid-flow — never commit
    close();
    if (mode === current) {
      void set('ui.ai.onboardingSeen', true).catch(() => {});
    } else {
      void set('ui.ai.mode', mode)
        .then(() => set('ui.ai.onboardingSeen', true))
        .catch(() => {});
    }
  };

  // Select a segment — fetches disclosure if Live, aborts prior fetch if switching away.
  // No-op guard: re-selecting the already-selected segment never re-fetches.
  const onSelect = (next: AiMode) => {
    if (next === pending) return;
    setPending(next);
    setFetchError(false);
    setSubmitError(false);
    if (next !== 'live') {
      abortRef.current?.abort();
      setLiveLoading(false);
      setDisclosure(null);
      return;
    }
    setDisclosure(null);
    setLiveLoading(true);
    const ac = new AbortController();
    abortRef.current = ac;
    getEgressDisclosure(ac.signal)
      .then((d) => {
        if (!ac.signal.aborted && !cancelledRef.current) {
          setDisclosure(d);
          setLiveLoading(false);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted && !cancelledRef.current) {
          setFetchError(true);
          setLiveLoading(false);
        }
      });
  };

  // Adaptive primary button handler — Live path goes through consent flow.
  const onCommit = async () => {
    if (pending !== 'live') {
      commitMode(pending);
      return;
    }
    if (!disclosure) return;
    if (disclosure.alreadyConsented) {
      commitMode('live');
      return;
    }
    setSubmitting(true);
    setSubmitError(false);
    try {
      await postAiConsent(disclosure.disclosureVersion);
      if (cancelledRef.current) return; // dismissed mid-POST — never commit Live
      commitMode('live');
    } catch {
      if (!cancelledRef.current) setSubmitError(true); // POST failed — disclosure stays, distinct copy
    } finally {
      if (!cancelledRef.current) setSubmitting(false);
    }
  };

  const liveStatus = LIVE_STATUS[pending];

  const btn = BUTTON[pending];

  // Primary button disabled: while loading disclosure, or while submitting, or no disclosure yet
  // (and no fetch error — fetch error state re-enables via the retry path where disclosure is null).
  const primaryDisabled =
    pending === 'live' && (liveLoading || submitting || (!disclosure && !fetchError));

  return (
    <Modal
      open={open}
      title="Set up AI for your reviews"
      titleIcon={<SparkIcon />}
      align="center"
      onClose={onEsc}
      defaultFocus="cancel"
      role="dialog"
    >
      <p className={styles.lead}>
        {pending === 'live'
          ? 'Live AI generates real, diff-grounded summaries of your pull requests using a real model.'
          : 'PRism is already running AI in Preview — sample output, clearly labeled, nothing sent off your device. Pick how much AI you want; you can change it any time in Settings.'}
      </p>

      <div className={styles.control} data-pending={pending}>
        <SegmentedControl
          label="AI mode"
          options={OPTIONS}
          value={pending}
          onChange={onSelect}
          selectedDataRole="cancel"
          describedById={regionId}
          disabled={submitting}
        />
      </div>

      {/* Live-region status node holds ONLY the concise change announcement, so segment changes
          don't re-read the entire legend. The legend/disclosure region below is NOT a live region;
          it is wired to the control via describedById for on-focus description. */}
      <span className="sr-only" role="status" aria-live="polite">
        {liveStatus}
      </span>

      <div id={regionId}>
        {pending === 'live' ? (
          fetchError ? (
            <div role="alert" className={styles.legend}>
              Couldn&apos;t load the data-sharing disclosure. Try again.
            </div>
          ) : liveLoading || !disclosure ? (
            <EgressDisclosureSkeleton />
          ) : (
            <>
              <EgressDisclosureBody disclosure={disclosure} />
              {submitError && (
                <div role="alert" className={styles.legend}>
                  Couldn&apos;t enable Live AI. Try again.
                </div>
              )}
            </>
          )
        ) : (
          <div className={styles.legend}>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotOff}`} aria-hidden="true" />
              <span>
                <strong>Off</strong> — no AI anywhere.
              </span>
            </div>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotPreview}`} aria-hidden="true" />
              <span>
                <strong>Preview</strong> — sample output, nothing leaves your device.
                {current === 'preview' && <span className={styles.currentPill}>Current</span>}
              </span>
            </div>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotLive}`} aria-hidden="true" />
              <span>
                <strong>Live</strong> — real model summaries of your PRs (shares the diff;
                you&apos;ll confirm first).
              </span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btn-link" onClick={onManage} disabled={submitting}>
          Manage AI settings →
        </button>
        <button
          type="button"
          className={btn.className}
          data-modal-role="primary"
          onClick={() => void onCommit()}
          disabled={primaryDisabled}
        >
          {submitting ? (
            <>
              <Spinner size="sm" decorative />
              Enabling…
            </>
          ) : (
            btn.label
          )}
        </button>
      </div>
    </Modal>
  );
}
