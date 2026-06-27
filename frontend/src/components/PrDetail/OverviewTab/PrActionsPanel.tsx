// frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import { usePrAction, type PrActionKind } from '../../../hooks/usePrAction';
import { PrStateGlyph } from '../../shared/prStateGlyph';
import { MergeMethodPicker, firstAllowed, allowedList } from './MergeMethodPicker';
import type { MergeMethodWire } from '../../../api/prLifecycle';
import { READINESS_LONG, type MergeReadiness } from '../../shared/mergeReadiness';
import styles from './PrActionsPanel.module.css';

// In-flight announcements for the visually-hidden live region (round-2 finding D3 — AT was silent
// during the write). Success-message copy (e.g. "Pull request closed") is a B1 a11y follow-up:
// the wording + the reopen-vs-ready ambiguity is an owner copy decision, not a mechanical fix.
const PENDING_ANNOUNCE: Record<PrActionKind, string> = {
  close: 'Closing pull request…',
  reopen: 'Reopening pull request…',
  ready: 'Marking ready for review…',
  'convert-to-draft': 'Converting to draft…',
  // Placeholder until Task 8 wires the merge affordance (announcement copy is finalized there).
  merge: 'Merging pull request…',
};

// Readiness states that permit a merge attempt (Option X). `unstable` is allowed (non-required
// checks failing) but carries a note; everything else (conflicts, behind-base, review gates,
// protection, none) disables the button with a reason.
const MERGE_ENABLED: ReadonlySet<string> = new Set([
  'ready',
  'ready-with-changes-requested',
  'unstable',
]);

// The Confirm button always NAMES the chosen method (single-method picker renders null, so the
// label is the only place the method is conveyed).
const CONFIRM_LABEL: Record<MergeMethodWire, string> = {
  merge: 'Confirm merge commit',
  squash: 'Confirm squash merge',
  rebase: 'Confirm rebase merge',
};

export function PrActionsPanel() {
  const { prRef, prDetail, readOnly, reload, isLoading } = usePrDetailContext();
  const pr = prDetail?.pr;
  // Pass the OBSERVED lifecycle state (not prDetail identity) so the fallback reconciles on THIS
  // action's target, immune to unrelated reloads (round-2 finding A1).
  const { pending, mergePhase, invoke } = usePrAction({
    prRef,
    reload,
    prState: pr ? { isClosed: pr.isClosed, isDraft: pr.isDraft, isMerged: pr.isMerged } : undefined,
  });
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<MergeMethodWire | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mergeBtnRef = useRef<HTMLButtonElement | null>(null); // Refresh-link focus target (§4a t3)
  const confirmMergeBtnRef = useRef<HTMLButtonElement | null>(null); // focus-on-arm single-method
  const methodPickerRef = useRef<HTMLDivElement | null>(null); // forwarded to the radiogroup root
  const refreshArmedRef = useRef(false); // set on a Refresh click; consumed by the readiness effect

  // Allowed merge methods (default to all on cold-load; the picker collapses to the Confirm label
  // when only one is allowed). Computed before the early return so the focus-on-arm effect (a hook)
  // can read it unconditionally. `readiness` likewise drives the refresh-focus effect.
  const allowed = pr?.allowedMergeMethods ?? { merge: true, squash: true, rebase: true };
  const readiness = (pr?.mergeReadiness ?? 'none') as MergeReadiness;

  // Action-set visibility — computed BEFORE the suppression early-return so the focus-swap effect
  // (a hook) is unconditional (rules-of-hooks). `!!pr &&` guards the cold-load window.
  const showReopen = !!pr && pr.isClosed;
  const showClose = !!pr && !pr.isClosed;
  const showReady = !!pr && !pr.isClosed && pr.isDraft;
  const showConvertDraft = !!pr && !pr.isClosed && !pr.isDraft;
  // Merge is offered only for an open, non-draft, non-closed PR (mergeability is gated separately).
  const showMerge = !!pr && !pr.isClosed && !pr.isMerged && !pr.isDraft;
  const signature = `${showReady}|${showConvertDraft}|${showReopen}|${showClose}`;

  // Round-2 finding E: an external state change that alters the action set clears an open confirm.
  useEffect(() => {
    if (confirmingClose && (pr?.isClosed || pr?.isMerged)) setConfirmingClose(false);
  }, [pr?.isClosed, pr?.isMerged, confirmingClose]);

  // Mirror the close-clear: collapse an open merge-confirm when the PR leaves the mergeable set
  // (success flips isMerged → collapse before the panel unmounts; a draft/close also collapses).
  useEffect(() => {
    if (confirmingMerge && (pr?.isClosed || pr?.isMerged || pr?.isDraft)) setConfirmingMerge(false);
  }, [pr?.isClosed, pr?.isMerged, pr?.isDraft, confirmingMerge]);

  // Focus-on-arm (§4a transition 1): when the merge morph opens, move focus into it — to the
  // default-selected radio when the picker renders (multi-method), or to the Confirm button when
  // it does not (single allowed method → picker returns null). Keyed on the arm edge only.
  useLayoutEffect(() => {
    if (!confirmingMerge) return;
    const multi = allowedList(allowed).length > 1;
    if (multi) {
      methodPickerRef.current
        ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
        ?.focus();
    } else {
      confirmMergeBtnRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm-edge only; `allowed` read live
  }, [confirmingMerge]);

  // Refresh-link focus (§4a transition 3): a `none`-state Refresh click arms refreshArmedRef and
  // calls reload(). When the resulting readiness moves OFF `none`, the reason block unmounts and we
  // move focus to the now-mounted Merge button. If readiness stays `none`, the Refresh link stays
  // mounted and keeps focus. An unrelated (non-Refresh) readiness change leaves refreshArmedRef
  // false, so it never steals focus.
  useEffect(() => {
    if (refreshArmedRef.current && readiness !== 'none') {
      refreshArmedRef.current = false;
      mergeBtnRef.current?.focus();
    }
  }, [readiness]);

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

  // Disable every action while an action is settling (pending is held through the reconcile
  // window — see usePrAction) OR the PR detail is otherwise loading/re-fetching (isLoading). Both
  // prevent firing a second action against a state that hasn't reconciled yet — the user must not
  // be able to click again thinking the first click "didn't take effect" (#566).
  const busy = pending !== null || isLoading;
  const siblingsDisabled = busy || confirmingClose || confirmingMerge;

  // Merge gating (Option X) + disabled-reason copy. `none` has empty READINESS_LONG copy, so supply
  // the "still calculating" string (the only state that also offers a Refresh link).
  const mergeEnabled = showMerge && MERGE_ENABLED.has(readiness);
  const mergeReason =
    readiness === 'none'
      ? 'Mergeability is still being calculated.'
      : READINESS_LONG[readiness] || '';
  // Persisted method choice survives an armed collapse; falls back to the first allowed method.
  const method = selectedMethod ?? firstAllowed(allowed);

  // Past the suppression guard, `pr` is non-null, so exactly one of showReopen (isClosed) /
  // showClose (!isClosed) is always true — the action set is never empty here.

  // Park focus on the container BEFORE invoking, so when the triggered button is removed by the
  // resulting set-swap (or the Confirm span unmounts) focus is already inside the panel and the
  // focus-swap effect can keep it there rather than the browser dropping it to <body>.
  const onInvoke = (
    kind: PrActionKind,
    payload?: { method: MergeMethodWire; headSha: string },
  ) => {
    containerRef.current?.focus();
    invoke(kind, payload);
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
      {/* Row constrained to the Overview card column: label left, action cluster right. */}
      <div className={styles.inner}>
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

        {/* Each button leads with the shared PrStateGlyph for the state it moves the PR TO (the same
            colour-coded octicons the inbox rows show before a PR title): closed=red, open=green,
            draft=blue. Glyphs are aria-hidden, so the accessible name stays the plain label. */}
        <div className={styles.actions}>
          {showReady && (
            <button
              className={`btn ${styles.ready}`}
              disabled={siblingsDisabled || pending === 'ready'}
              onClick={() => onInvoke('ready')}
            >
              <PrStateGlyph state="open" />
              {pending === 'ready' ? 'Marking ready…' : 'Ready for review'}
            </button>
          )}

          {showConvertDraft && (
            <button
              className={`btn ${styles.convert}`}
              disabled={siblingsDisabled || pending === 'convert-to-draft'}
              onClick={() => onInvoke('convert-to-draft')}
            >
              <PrStateGlyph state="draft" />
              {pending === 'convert-to-draft' ? 'Converting…' : 'Convert to draft'}
            </button>
          )}

          {showReopen && (
            <button
              className={`btn ${styles.reopen}`}
              disabled={busy}
              onClick={() => onInvoke('reopen')}
            >
              <PrStateGlyph state="open" />
              {pending === 'reopen' ? 'Reopening…' : 'Reopen'}
            </button>
          )}

          {showClose && !confirmingClose && (
            // The pending label lives HERE (not on Confirm close): clicking Confirm sets
            // confirmingClose=false + pending='close' in one batch, so the confirm span unmounts and
            // the plain Close button is what renders during the in-flight state. (Plan ce-doc-review.)
            <button
              className={`btn ${styles.close}`}
              disabled={siblingsDisabled}
              onClick={() => setConfirmingClose(true)}
            >
              <PrStateGlyph state="closed" />
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
              <button
                ref={cancelRef}
                className="btn btn-secondary"
                onClick={() => setConfirmingClose(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                // Guarded by busy too: if a reload lands while the confirm is open, the commit
                // can't fire against a state that's still settling (#566).
                disabled={busy}
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

          {/* Merge trigger + disabled-reason. The button always renders for an open non-draft PR;
              gating only toggles `disabled` + the reason node, so the affordance is discoverable
              and the reason explains why it can't fire yet. */}
          {showMerge && !confirmingMerge && (
            <div className={styles.mergeWrap}>
              <button
                ref={mergeBtnRef}
                className={`btn ${styles.merge}`}
                disabled={siblingsDisabled || !mergeEnabled}
                aria-describedby={!mergeEnabled ? 'merge-reason' : undefined}
                onClick={() => setConfirmingMerge(true)}
              >
                <PrStateGlyph state="merged" />
                Merge
              </button>
              {!mergeEnabled && (
                <span id="merge-reason" className={styles.mergeReason}>
                  {mergeReason}{' '}
                  {readiness === 'none' && (
                    <button
                      type="button"
                      className={styles.refreshLink}
                      onClick={() => {
                        refreshArmedRef.current = true;
                        reload();
                      }}
                    >
                      Refresh
                    </button>
                  )}
                </span>
              )}
            </div>
          )}

          {showMerge && confirmingMerge && (
            <span
              className={styles.confirm}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setConfirmingMerge(false);
                }
              }}
            >
              <MergeMethodPicker
                allowed={allowed}
                value={method}
                onChange={setSelectedMethod}
                disabled={busy}
                onEscape={() => setConfirmingMerge(false)}
                rootRef={methodPickerRef}
              />
              {readiness === 'unstable' && (
                <span id="merge-unstable-note" className={styles.unstableNote}>
                  Non-required checks are failing
                </span>
              )}
              <button
                ref={confirmMergeBtnRef}
                className="btn btn-danger"
                disabled={busy}
                aria-describedby={readiness === 'unstable' ? 'merge-unstable-note' : undefined}
                // Does NOT collapse the morph: it stays mounted through the in-flight + reconcile
                // window so the Merging…/Checking… labels paint. It collapses via the
                // leaves-mergeable-set effect (success flips isMerged) — never from this click.
                onClick={() => onInvoke('merge', { method, headSha: pr.headSha })}
              >
                {mergePhase === 'checking'
                  ? 'Checking…'
                  : pending === 'merge'
                    ? 'Merging…'
                    : CONFIRM_LABEL[method]}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
