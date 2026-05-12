import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { VerdictPicker } from '../VerdictPicker';
import { CountsBlock } from './CountsBlock';
import { PreSubmitValidatorCard } from './PreSubmitValidatorCard';
import { SubmitProgressIndicator } from './SubmitProgressIndicator';
import { StaleCommitOidBanner } from './StaleCommitOidBanner';
import { ForeignPendingReviewModal } from '../ForeignPendingReviewModal/ForeignPendingReviewModal';
import { sendPatch } from '../../../api/draft';
import { verdictToSubmitWire } from '../../../api/submit';
import { submitDisabledReason } from '../SubmitButton';
import type {
  DraftVerdict,
  PrReference,
  ReviewSessionDto,
  ValidatorResult,
  Verdict,
} from '../../../api/types';
import type { SubmitState } from '../../../hooks/useSubmit';

const SUMMARY_DEBOUNCE_MS = 250;

interface Props {
  open: boolean;
  reference: PrReference;
  session: ReviewSessionDto;
  // Canned validator results when aiPreview is on; [] otherwise (the header
  // does the gating — mirrors AiSummaryCard).
  validatorResults: ValidatorResult[];
  submitState: SubmitState;
  // Rule (f): head_sha drift that develops while the dialog is open (the header
  // button is already disabled, but the open dialog's Confirm must follow). Also
  // drives the stale-commit-oid banner's not-yet-Reloaded variant.
  headShaDrift?: boolean;
  // The PR's currently-known head sha — shown (truncated) in the stale-commit-oid
  // banner. May briefly lag the real new head until the user clicks Reload.
  currentHeadSha?: string;
  // Cancel / Close — the caller resets useSubmit.
  onClose(): void;
  // Confirm — the caller calls useSubmit.submit(verdict).
  onSubmit(verdict: Verdict): void;
  // Retry / "Recreate and resubmit" — the caller calls useSubmit.retry().
  onRetry(): void;
  // Picker change — the caller patches PUT /draft and refetches the session.
  onVerdictChange(verdict: DraftVerdict | null): void;
  // Foreign-pending-review prompt — Resume / Discard the foreign review.
  // The caller wires these to useSubmit.resumeForeignPendingReview /
  // discardForeignPendingReview (and surfaces a toast on a TOCTOU 409).
  onResumeForeignPendingReview(pullRequestReviewId: string): void;
  onDiscardForeignPendingReview(pullRequestReviewId: string): void;
}

export function SubmitDialog(props: Props) {
  const {
    open,
    reference,
    session,
    validatorResults,
    submitState,
    headShaDrift = false,
    currentHeadSha = '',
    onClose,
    onSubmit,
    onRetry,
    onVerdictChange,
    onResumeForeignPendingReview,
    onDiscardForeignPendingReview,
  } = props;

  const [verdict, setVerdict] = useState<DraftVerdict | null>(session.draftVerdict);
  const [summary, setSummary] = useState(session.draftSummaryMarkdown ?? '');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmingRef = useRef(false);
  const [escNotice, setEscNotice] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed the local picker + summary from the session, but only on the
  // false→true `open` transition (`openRef` guards it) — a mid-session re-sync
  // would clobber in-progress typing. The auto-saved summary persists across
  // Cancel/reopen (spec § 8.2) by living in the session, so re-reading it on
  // reopen is the right source. `session` is in the deps so the effect closure
  // sees the current value when `open` flips; the `justOpened` guard makes the
  // `session`-only re-runs no-ops.
  const openRef = useRef(open);
  useEffect(() => {
    const justOpened = open && !openRef.current;
    openRef.current = open;
    if (!justOpened) return;
    setVerdict(session.draftVerdict);
    setSummary(session.draftSummaryMarkdown ?? '');
    setEscNotice('');
  }, [open, session]);

  const saveSummary = useCallback(
    (value: string) => {
      void sendPatch(reference, { kind: 'draftSummaryMarkdown', payload: value });
    },
    [reference],
  );

  const flushSummary = useCallback(async () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    await sendPatch(reference, { kind: 'draftSummaryMarkdown', payload: summary });
  }, [reference, summary]);

  const onSummaryChange = (value: string) => {
    setSummary(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      saveSummary(value);
    }, SUMMARY_DEBOUNCE_MS);
  };

  // Esc focuses Cancel, never dismisses (spec § 8.1) — and announces the
  // focus shift through an aria-live region so SR users aren't surprised. The
  // trailing zero-width space toggles so a *repeated* Esc still changes the
  // region's text content and re-announces (adversarial #7). Skipped while the
  // dialog is delegating to a child modal (foreign-prompt) or has collapsed to
  // the stale-commitOID banner — there's no Cancel button in `cancelRef` then,
  // and those surfaces own their own Esc handling.
  useEffect(() => {
    if (
      !open ||
      submitState.kind === 'foreign-pending-review-prompt' ||
      submitState.kind === 'stale-commit-oid'
    )
      return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current?.focus();
      const zwsp = String.fromCharCode(0x200b);
      setEscNotice((prev) => {
        const base =
          'Esc moved focus to Cancel — press Enter to close, or click anywhere in the dialog to continue editing.';
        return prev.endsWith(zwsp) ? base : base + zwsp;
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, submitState.kind]);

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    [],
  );

  const kind = submitState.kind;
  const inFlight = kind === 'in-flight';

  // While the pipeline runs the dialog has no enabled controls (picker, summary,
  // Cancel all disabled; Confirm is a non-interactive spinner) — pull focus onto
  // the dialog container so the focus trap doesn't escape to the page behind the
  // backdrop (adversarial #4). dialogRef is tabIndex={-1}.
  useEffect(() => {
    if (open && inFlight) dialogRef.current?.focus();
  }, [open, inFlight]);

  if (!open) return null;

  // The foreign-pending-review prompt is its own modal (spec § 11), not an
  // in-dialog banner — render it instead of the submit dialog shell.
  if (kind === 'foreign-pending-review-prompt') {
    return (
      <ForeignPendingReviewModal
        open
        snapshot={
          (submitState as Extract<SubmitState, { kind: 'foreign-pending-review-prompt' }>).snapshot
        }
        onResume={onResumeForeignPendingReview}
        onDiscard={onDiscardForeignPendingReview}
        onCancel={onClose}
      />
    );
  }

  // The stale-commit-oid state collapses the dialog body to the banner — the
  // orphan was already deleted server-side, so the verdict picker / summary /
  // counts are moot until the user re-fires (spec § 12). The banner owns its
  // own Cancel + "Recreate and resubmit" buttons.
  if (kind === 'stale-commit-oid') {
    return (
      <Modal open={open} title="The PR’s head commit changed." onClose={onClose} disableEscDismiss>
        <div className="submit-dialog submit-dialog--stale" ref={dialogRef} tabIndex={-1}>
          <StaleCommitOidBanner
            currentHeadSha={currentHeadSha}
            notReloadedYet={headShaDrift}
            onCancel={onClose}
            onResubmit={onRetry}
          />
        </div>
      </Modal>
    );
  }

  const success = kind === 'success';
  const failed = kind === 'failed';
  // The verdict picker + summary textarea are frozen for the whole submit flow
  // — through success, failure, and the stale-commitOID/foreign-prompt branches
  // (the retry paths re-fire with the last-confirmed verdict). Only `idle` is
  // editable. (spec § 8.3)
  const frozen = kind !== 'idle';

  const progressSteps =
    submitState.kind === 'in-flight' ||
    submitState.kind === 'failed' ||
    submitState.kind === 'success'
      ? submitState.steps
      : [];
  // The all-✓ checklist stays visible on success (spec § 8.3).
  const showProgress = inFlight || failed || success;

  // Re-evaluate the § 9 rules against the *local* verdict + the *live* summary
  // (both are editable in-dialog; clearing the textarea or changing the verdict
  // must reflect immediately, ahead of the PUT /draft round-trip — otherwise
  // Confirm shows enabled then the server 4xx's). headShaDrift is normally false
  // here (drift disables the header button before the dialog opens) but can flip
  // true mid-edit, so it's threaded through.
  const confirmReason = submitDisabledReason(
    {
      ...session,
      draftVerdict: verdict,
      // Trimmed-emptiness, matching SubmitButton's isEmptyContent — a
      // whitespace-only textarea is "no summary" for the § 9 rules.
      draftSummaryMarkdown: summary.trim().length > 0 ? summary : null,
    },
    headShaDrift,
    validatorResults,
  );
  const confirmDisabled = confirmReason !== null;

  const title = success
    ? 'Review submitted.'
    : failed
      ? `Submit failed at ${(submitState as Extract<SubmitState, { kind: 'failed' }>).failedStep}.`
      : inFlight
        ? 'Submitting your review…'
        : 'Submit review';

  const prUrl = `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;

  const handleConfirm = async () => {
    // Guard the flushSummary round-trip — the dialog stays `idle` (Confirm
    // enabled) until the parent's submit() flips the state, so a rapid
    // double-click would otherwise fire two onSubmit calls.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      // Flush the debounced summary save so a keystroke <250ms before Confirm
      // still lands in the session the pipeline reads (spec § 8.2). Default to
      // Comment when no verdict was picked (spec § 6).
      await flushSummary();
      onSubmit(verdictToSubmitWire(verdict ?? 'comment'));
    } finally {
      confirmingRef.current = false;
    }
  };

  return (
    <Modal open={open} title={title} onClose={onClose} disableEscDismiss>
      <div className="submit-dialog" ref={dialogRef} tabIndex={-1}>
        <div className="submit-dialog__status" role="status" aria-live="polite">
          {escNotice}
        </div>

        <div className="submit-dialog__body">
          <section data-section="verdict" className="submit-dialog__section">
            <VerdictPicker
              value={verdict}
              verdictStatus={session.draftVerdictStatus}
              disabled={frozen}
              onChange={(v) => {
                setVerdict(v);
                onVerdictChange(v);
              }}
            />
          </section>

          {validatorResults.length > 0 && (
            <section data-section="validator" className="submit-dialog__section">
              <PreSubmitValidatorCard results={validatorResults} />
            </section>
          )}

          <section data-section="summary" className="submit-dialog__section submit-dialog__summary">
            <label className="submit-dialog__summary-label" htmlFor="submit-dialog-summary">
              PR-level summary (optional)
            </label>
            <div className="submit-dialog__summary-cols">
              <textarea
                id="submit-dialog-summary"
                className="textarea submit-dialog__summary-input"
                data-modal-role="primary"
                value={summary}
                disabled={frozen}
                onChange={(e) => onSummaryChange(e.target.value)}
                placeholder="Write a short summary of this review…"
              />
              <div className="submit-dialog__summary-preview" data-section="summary-preview">
                {summary.trim().length === 0 ? (
                  <p className="muted">Nothing to preview yet.</p>
                ) : (
                  <MarkdownRenderer source={summary} />
                )}
              </div>
            </div>
          </section>

          <section data-section="counts" className="submit-dialog__section">
            <CountsBlock
              threadCount={session.draftComments.length}
              replyCount={session.draftReplies.length}
            />
          </section>

          {showProgress && (
            <section data-section="progress" className="submit-dialog__section">
              <SubmitProgressIndicator steps={progressSteps} />
            </section>
          )}
        </div>

        <footer className="submit-dialog__footer">
          {!success && (
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-secondary"
              data-modal-role="cancel"
              disabled={inFlight}
              onClick={onClose}
            >
              Cancel
            </button>
          )}

          {kind === 'idle' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={confirmDisabled}
              title={confirmDisabled ? (confirmReason ?? undefined) : undefined}
              onClick={() => void handleConfirm()}
            >
              Confirm submit
            </button>
          )}
          {inFlight && (
            <span className="submit-dialog__spinner" role="status" aria-live="polite">
              Submitting…
            </span>
          )}
          {failed && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Retry
            </button>
          )}
          {success && (
            <>
              <a className="btn btn-secondary" href={prUrl} target="_blank" rel="noreferrer">
                View on GitHub →
              </a>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}
