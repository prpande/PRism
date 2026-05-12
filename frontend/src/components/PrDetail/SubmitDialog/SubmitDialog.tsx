import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { VerdictPicker } from '../VerdictPicker';
import { CountsBlock } from './CountsBlock';
import { PreSubmitValidatorCard } from './PreSubmitValidatorCard';
import { SubmitProgressIndicator } from './SubmitProgressIndicator';
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
  // Cancel / Close — the caller resets useSubmit.
  onClose(): void;
  // Confirm — the caller calls useSubmit.submit(verdict).
  onSubmit(verdict: Verdict): void;
  // Retry / "Recreate and resubmit" — the caller calls useSubmit.retry().
  onRetry(): void;
  // Picker change — the caller patches PUT /draft and refetches the session.
  onVerdictChange(verdict: DraftVerdict | null): void;
}

export function SubmitDialog(props: Props) {
  const {
    open,
    reference,
    session,
    validatorResults,
    submitState,
    onClose,
    onSubmit,
    onRetry,
    onVerdictChange,
  } = props;

  const [verdict, setVerdict] = useState<DraftVerdict | null>(session.draftVerdict);
  const [summary, setSummary] = useState(session.draftSummaryMarkdown ?? '');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [escNotice, setEscNotice] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed local fields from the (possibly refetched) session each time the
  // dialog opens — the auto-saved summary persists across Cancel/reopen
  // (spec § 8.2) by living in the session, not in component state.
  // Re-seed local fields only when the dialog opens — mid-session re-syncs from
  // `session` would clobber in-progress typing (the auto-saved summary already
  // round-trips via the session, so the value isn't lost on Cancel/reopen). The
  // deps list is `[open]` by design; this project's eslint config carries no
  // react-hooks/exhaustive-deps rule.
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
  // focus shift through an aria-live region so SR users aren't surprised.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current?.focus();
      setEscNotice(
        'Esc moved focus to Cancel — press Enter to close, or click anywhere in the dialog to continue editing.',
      );
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    [],
  );

  if (!open) return null;

  const kind = submitState.kind;
  const inFlight = kind === 'in-flight';
  const success = kind === 'success';
  const failed = kind === 'failed';
  const staleCommitOid = kind === 'stale-commit-oid';
  const foreignPrompt = kind === 'foreign-pending-review-prompt';
  const frozen = inFlight || success;

  const progressSteps =
    submitState.kind === 'in-flight' || submitState.kind === 'failed' ? submitState.steps : [];
  const showProgress = inFlight || failed;

  // Re-evaluate the § 9 rules against the *local* verdict (the picker is
  // editable in-dialog; a clear/change here must reflect immediately, ahead of
  // the PUT /draft round-trip). headShaDrift is always false here — drift
  // disables the header button, so the dialog can't have opened under it.
  const effectiveSummary = summary.trim().length > 0 ? summary : session.draftSummaryMarkdown;
  const confirmReason = submitDisabledReason(
    { ...session, draftVerdict: verdict, draftSummaryMarkdown: effectiveSummary },
    false,
    validatorResults,
  );
  const confirmDisabled = confirmReason !== null;

  const title = success
    ? 'Review submitted.'
    : failed
      ? `Submit failed at ${(submitState as Extract<SubmitState, { kind: 'failed' }>).failedStep}.`
      : staleCommitOid
        ? 'The PR’s head commit changed.'
        : foreignPrompt
          ? 'Existing pending review found.'
          : inFlight
            ? 'Submitting your review…'
            : 'Submit review';

  const prUrl = `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;

  const handleConfirm = async () => {
    // Flush the debounced summary save so a keystroke <250ms before Confirm
    // still lands in the session the pipeline reads (spec § 8.2). Default to
    // Comment when no verdict was picked (spec § 6).
    await flushSummary();
    onSubmit(verdictToSubmitWire(verdict ?? 'comment'));
  };

  return (
    <Modal open={open} title={title} onClose={onClose} disableEscDismiss>
      <div className="submit-dialog">
        <div className="submit-dialog__status" role="status" aria-live="polite">
          {escNotice}
        </div>

        {staleCommitOid && (
          <div className="submit-dialog__banner banner-warning" role="alert">
            The PR&rsquo;s head commit changed since this pending review was started. The orphan was
            removed and your drafts are preserved; click &ldquo;Recreate and resubmit&rdquo; to
            re-attach them against the new head.
          </div>
        )}
        {foreignPrompt && (
          <div className="submit-dialog__banner banner-warning" role="alert">
            You already have a pending review on this PR (
            {
              (submitState as Extract<SubmitState, { kind: 'foreign-pending-review-prompt' }>)
                .snapshot.threadCount
            }{' '}
            thread(s),{' '}
            {
              (submitState as Extract<SubmitState, { kind: 'foreign-pending-review-prompt' }>)
                .snapshot.replyCount
            }{' '}
            reply(ies)). Resume / Discard handling lands in the next slice — Cancel for now and use
            the Drafts tab.
          </div>
        )}

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
              {staleCommitOid || foreignPrompt ? 'Cancel — nothing was submitted' : 'Cancel'}
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
          {staleCommitOid && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Recreate and resubmit
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
