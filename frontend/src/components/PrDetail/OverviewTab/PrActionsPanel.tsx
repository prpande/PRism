// frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import { usePrAction, type PrActionKind } from '../../../hooks/usePrAction';
import styles from './PrActionsPanel.module.css';

// In-flight announcements for the visually-hidden live region (round-2 finding D3 — AT was silent
// during the write). Success-message copy (e.g. "Pull request closed") is a B1 a11y follow-up:
// the wording + the reopen-vs-ready ambiguity is an owner copy decision, not a mechanical fix.
const PENDING_ANNOUNCE: Record<PrActionKind, string> = {
  close: 'Closing pull request…',
  reopen: 'Reopening pull request…',
  ready: 'Marking ready for review…',
  'convert-to-draft': 'Converting to draft…',
};

export function PrActionsPanel() {
  const { prRef, prDetail, readOnly, reload } = usePrDetailContext();
  const pr = prDetail?.pr;
  // Pass the OBSERVED lifecycle state (not prDetail identity) so the fallback reconciles on THIS
  // action's target, immune to unrelated reloads (round-2 finding A1).
  const { pending, invoke } = usePrAction({
    prRef,
    reload,
    prState: pr ? { isClosed: pr.isClosed, isDraft: pr.isDraft } : undefined,
  });
  const [confirmingClose, setConfirmingClose] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Action-set visibility — computed BEFORE the suppression early-return so the focus-swap effect
  // (a hook) is unconditional (rules-of-hooks). `!!pr &&` guards the cold-load window.
  const showReopen = !!pr && pr.isClosed;
  const showClose = !!pr && !pr.isClosed;
  const showReady = !!pr && !pr.isClosed && pr.isDraft;
  const showConvertDraft = !!pr && !pr.isClosed && !pr.isDraft;
  const signature = `${showReady}|${showConvertDraft}|${showReopen}|${showClose}`;

  // Round-2 finding E: an external state change that alters the action set clears an open confirm.
  useEffect(() => {
    if (confirmingClose && (pr?.isClosed || pr?.isMerged)) setConfirmingClose(false);
  }, [pr?.isClosed, pr?.isMerged, confirmingClose]);

  // Focus the Cancel button when the confirm morph opens (a11y).
  useEffect(() => {
    if (confirmingClose) cancelRef.current?.focus();
  }, [confirmingClose]);

  // Focus-on-swap (round-2 findings A2/D2, folded inline per scope S4): when the visible action set
  // changes while focus is parked inside the panel, keep focus on the container instead of letting
  // it fall to <body>. This is RELIABLE here because every invoke/Confirm parks focus on the
  // container FIRST (onInvoke below) — so when the focused button is removed by the swap, focus is
  // already on the container, and `el.contains(activeElement)` is true. (The naive version read
  // activeElement AFTER removal, by which point it is already <body> and the guard fails.)
  const sigRef = useRef(signature);
  useEffect(() => {
    if (sigRef.current !== signature) {
      const el = containerRef.current;
      if (el && el.contains(document.activeElement)) el.focus();
      sigRef.current = signature;
    }
  }, [signature]);

  // Dismiss-on-click-outside (spec decision 2) — mirror ReviewActionMenu.tsx's mousedown pattern.
  useEffect(() => {
    if (!confirmingClose) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setConfirmingClose(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [confirmingClose]);

  // Suppression: cold-load, readOnly, merged.
  if (!pr || readOnly || pr.isMerged) return null;

  const busy = pending !== null;
  const siblingsDisabled = busy || confirmingClose;

  // Nothing to show (defensive — merged already returned null).
  if (!showReopen && !showClose && !showReady && !showConvertDraft) return null;

  // Park focus on the container BEFORE invoking, so when the triggered button is removed by the
  // resulting set-swap (or the Confirm span unmounts) focus is already inside the panel and the
  // focus-swap effect can keep it there rather than the browser dropping it to <body>.
  const onInvoke = (kind: PrActionKind) => {
    containerRef.current?.focus();
    invoke(kind);
  };

  return (
    // tabIndex={-1} so the focus-swap effect can land focus on the panel when the button set changes.
    <div
      ref={containerRef}
      className={styles.panel}
      role="group"
      aria-label="PR actions"
      tabIndex={-1}
    >
      <span className={styles.regionTag}>PR actions</span>

      {/* Visually-hidden live region (NOT role="alertdialog" — that implies a modal w/ focus trap,
          which this inline morph is not; codebase uses Modal for alertdialog). Announces the
          confirm prompt AND the in-flight state. Pattern: AiFailureContainer / GitHubAuthBanner. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {confirmingClose
          ? 'Close this PR? Use Cancel or Confirm close.'
          : pending
            ? PENDING_ANNOUNCE[pending]
            : ''}
      </span>

      {showReady && (
        <button
          className={styles.btnReady}
          disabled={siblingsDisabled || pending === 'ready'}
          onClick={() => onInvoke('ready')}
        >
          {pending === 'ready' ? 'Marking ready…' : 'Ready for review'}
        </button>
      )}

      {showConvertDraft && (
        <button
          className={styles.btn}
          disabled={siblingsDisabled || pending === 'convert-to-draft'}
          onClick={() => onInvoke('convert-to-draft')}
        >
          {pending === 'convert-to-draft' ? 'Converting…' : 'Convert to draft'}
        </button>
      )}

      {showReopen && (
        <button
          className={styles.btnReopen}
          disabled={busy || pending === 'reopen'}
          onClick={() => onInvoke('reopen')}
        >
          {pending === 'reopen' ? 'Reopening…' : 'Reopen'}
        </button>
      )}

      {showClose && !confirmingClose && (
        // The pending label lives HERE (not on Confirm close): clicking Confirm sets
        // confirmingClose=false + pending='close' in one batch, so the confirm span unmounts and
        // the plain Close button is what renders during the in-flight state. (Plan ce-doc-review.)
        <button
          className={styles.btnClose}
          disabled={siblingsDisabled}
          onClick={() => setConfirmingClose(true)}
        >
          {pending === 'close' ? 'Closing…' : 'Close'}
        </button>
      )}

      {showClose && confirmingClose && (
        <span
          className={styles.confirm}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setConfirmingClose(false);
            }
          }}
        >
          {/* The visible label says "Confirm close?" to avoid overlapping with the sr-only live
               region text ("Close this PR? …") — both would otherwise match the test's
               /close this pr\?/i regex and trip getByText's strict single-match guard. */}
          <span className={styles.confirmQ}>Confirm close?</span>
          <button ref={cancelRef} className={styles.btn} onClick={() => setConfirmingClose(false)}>
            Cancel
          </button>
          <button
            className={styles.btnConfirm}
            // onInvoke parks focus on the container before the confirm span (and this button) unmount,
            // so the keyboard user is not dropped to <body> through the in-flight period.
            onClick={() => {
              onInvoke('close');
              setConfirmingClose(false);
            }}
          >
            Confirm close
          </button>
        </span>
      )}
    </div>
  );
}
