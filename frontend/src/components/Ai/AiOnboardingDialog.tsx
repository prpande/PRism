import { useId, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Modal } from '../Modal/Modal';
import { SparkIcon } from './SparkIcon';
import { SegmentedControl } from '../controls/SegmentedControl';
import { usePreferences } from '../../hooks/usePreferences';
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

export function AiOnboardingDialog({ onDismiss }: { onDismiss: () => void }) {
  const { preferences, set } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const current = preferences?.ui.aiMode ?? 'preview';
  const [pending, setPending] = useState<AiMode>(current);
  const [open, setOpen] = useState(true);
  const regionId = useId();

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
    close();
    if (mode === current) {
      void set('ui.ai.onboardingSeen', true).catch(() => {});
    } else {
      void set('ui.ai.mode', mode)
        .then(() => set('ui.ai.onboardingSeen', true))
        .catch(() => {});
    }
  };

  // Adaptive primary button.
  const onCommit = () => {
    if (pending === 'live') return; // Task 6 replaces this with the Live state machine.
    commitMode(pending);
  };

  // Concise SR status (announces the mode/region change without re-reading the whole legend card).
  const liveStatus =
    pending === 'live'
      ? 'Live selected. Review the data-sharing disclosure below.'
      : pending === 'off'
        ? 'Off selected.'
        : 'Preview selected.';

  const btn = BUTTON[pending];

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
          onChange={(v) => setPending(v)}
          selectedDataRole="cancel"
          describedById={regionId}
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
          <div /* Task 6: inline egress disclosure state machine */ />
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
        <button type="button" className="btn btn-link" onClick={onManage}>
          Manage AI settings →
        </button>
        <button
          type="button"
          className={btn.className}
          data-modal-role="primary"
          onClick={onCommit}
        >
          {btn.label}
        </button>
      </div>
    </Modal>
  );
}
