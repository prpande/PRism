import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { VerdictPicker } from '../VerdictPicker';
import { CountsBlock } from './CountsBlock';
import { PreSubmitValidatorCard } from './PreSubmitValidatorCard';
import { SubmitProgressIndicator } from './SubmitProgressIndicator';
import { StaleCommitOidBanner } from './StaleCommitOidBanner';
import { ForeignPendingReviewModal } from '../ForeignPendingReviewModal/ForeignPendingReviewModal';
import { PrRootBodyEditor } from '../Composer/PrRootBodyEditor';
import { DiscardPendingReviewConfirmationModal } from '../DiscardPendingReviewConfirmationModal';
import { submitDisabledReason } from '../SubmitButton';
import {
  COMPOSER_CREATE_THRESHOLD,
  type ComposerSaveBadge,
} from '../../../hooks/useComposerAutoSave';
import { useCantEditRootBodyReason } from '../../../hooks/useCantEditRootBodyReason';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import type {
  DiscardOwnPendingReviewError,
  DiscardOwnPendingReviewResult,
} from '../../../api/submit';
import type {
  DraftVerdict,
  PrReference,
  ReviewSessionDto,
  ValidatorResult,
} from '../../../api/types';
import type { SubmitState } from '../../../hooks/useSubmit';

type AutosaveControl = { flush: () => Promise<string | null>; badge: ComposerSaveBadge };

// No-op registry/holder defaults so renders that don't wire the draft session
// (e.g. isolated unit tests of the submit lifecycle) still mount. PrHeader
// supplies the real session-backed implementations in production.
const NOOP_REGISTER_OPEN_COMPOSER = (): (() => void) => () => {};
const NOOP_GET_PR_ROOT_HOLDER = (): ComposerOwnerKey | null => null;

interface Props {
  open: boolean;
  reference: PrReference;
  // #131 — authoritative PR web URL (PrDetailPr.htmlUrl). Absent → omit the
  // "View on GitHub" link in the success footer. Nullable because PrDetailView
  // passes data?.pr.htmlUrl (string | null | undefined).
  htmlUrl?: string | null;
  session: ReviewSessionDto;
  // The PR's open/closed/merged state — threads into PrRootBodyEditor's
  // closed-banner + autosave gate.
  prState?: 'open' | 'closed' | 'merged';
  // Cross-tab ownership: a peer tab claimed this PR. Disables the Edit toggle
  // (with the other-tab tooltip) and short-circuits the editor's autosave.
  readOnly?: boolean;
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
  // Cross-surface composer registry (shared with the Overview-tab composer) so
  // only one surface holds the PR-root draft at a time within a tab.
  registerOpenComposer?: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Returns the ownerKey holding the PR-root draft (or null). Drives the
  // Edit-disabled cross-surface lock.
  getPrRootHolder?: () => ComposerOwnerKey | null;
  // Discard-pending-review action + its in-flight flag (from useSubmit). The
  // dialog drives the modal's onDiscard with this; discardInFlight gates the
  // close + the "Cancelling…" sequencing label.
  discardOwnPendingReview?: () => Promise<
    DiscardOwnPendingReviewResult | DiscardOwnPendingReviewError
  >;
  discardInFlight?: boolean;
  // Optimistic success toast after a discard 204 — the host owns the toast
  // surface (PrHeader's useToast).
  onDiscardSuccess?: () => void;
  // Cancel / Close — the caller resets useSubmit.
  onClose(): void;
  // Confirm — the caller calls useSubmit.submit(verdict).
  onSubmit(verdict: DraftVerdict): void;
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
    htmlUrl,
    session,
    prState = 'open',
    readOnly = false,
    validatorResults,
    submitState,
    headShaDrift = false,
    currentHeadSha = '',
    registerOpenComposer = NOOP_REGISTER_OPEN_COMPOSER,
    getPrRootHolder = NOOP_GET_PR_ROOT_HOLDER,
    discardOwnPendingReview,
    discardInFlight = false,
    onDiscardSuccess,
    onClose,
    onSubmit,
    onRetry,
    onVerdictChange,
    onResumeForeignPendingReview,
    onDiscardForeignPendingReview,
  } = props;

  // The unified PR-root draft (filePath/lineNumber null) — the SAME draft the
  // Overview-tab composer edits. Post-V7 this replaced the summary textarea.
  const prRootDraft =
    session.draftComments.find((d) => d.filePath === null && d.lineNumber === null) ?? null;

  const [verdict, setVerdict] = useState<DraftVerdict | null>(session.draftVerdict);
  const [editing, setEditing] = useState(false);
  // Controlled draftId for the editor (null→uuid on first autosave-create).
  const [, setBodyDraftId] = useState<string | null>(prRootDraft?.id ?? null);
  // Live body surfaced from the editor — drives the submit-disabled override
  // while editing (replicates the old inline-summary override).
  const [editingBody, setEditingBody] = useState<string>(prRootDraft?.bodyMarkdown ?? '');
  const editorControl = useRef<AutosaveControl | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmingRef = useRef(false);
  const closingRef = useRef(false);
  const [escNotice, setEscNotice] = useState('');
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  // Cross-surface lock: the Overview composer (or another tab) may hold the
  // draft. Edit is disabled with a reason-specific tooltip when non-null.
  const prRootHolder = getPrRootHolder();
  const cantEdit = useCantEditRootBodyReason({ readOnly, ownerKey: 'submit-dialog', prRootHolder });

  // Re-seed the local picker from the session, but only on the false→true `open`
  // transition (`openRef` guards it) — a mid-session re-sync would clobber an
  // in-progress verdict pick. Always opens in preview (spec § 4.8).
  const openRef = useRef(open);
  useEffect(() => {
    const justOpened = open && !openRef.current;
    openRef.current = open;
    if (!justOpened) return;
    setVerdict(session.draftVerdict);
    setEditing(false);
    setEscNotice('');
    setDiscardModalOpen(false);
    setDiscardError(null);
  }, [open, session]);

  const handleAutosaveControl = useCallback((control: AutosaveControl) => {
    editorControl.current = control;
  }, []);

  // onDraftLost → return to preview so the dialog isn't stranded in an edit
  // shell with a deleted draft (spec § 4.8 / 4.11).
  const handleDraftLost = useCallback(() => {
    setEditing(false);
  }, []);

  // Close path: when editing, drain the editor's debounce so an in-flight
  // 250ms autosave isn't lost on unmount (spec § 4.8). Blocked entirely while a
  // discard is in flight (mirrors the postInFlight rule, spec § 4.7).
  const handleClose = useCallback(() => {
    if (discardInFlight) return;
    if (closingRef.current) return;
    if (!editing || !editorControl.current) {
      onClose();
      return;
    }
    closingRef.current = true;
    void editorControl.current
      .flush()
      .catch(() => {})
      .finally(() => {
        closingRef.current = false;
        onClose();
      });
  }, [discardInFlight, editing, onClose]);

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
  // own Cancel + "Recreate and resubmit" buttons; Esc dismisses (≡ Cancel,
  // useSubmit resets to idle) since nothing was submitted and there's no
  // editable content to protect — unlike the idle dialog, Esc isn't trapped.
  if (kind === 'stale-commit-oid') {
    return (
      <Modal open={open} title="The PR’s head commit changed." onClose={onClose}>
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
  // The verdict picker + body editor are frozen for the whole submit flow
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

  // Re-evaluate the § 9 rules against the *local* verdict + the *live* PR-root
  // body (both are editable in-dialog; clearing the body or changing the verdict
  // must reflect immediately, ahead of the PUT /draft round-trip — otherwise
  // Confirm shows enabled then the server 4xx's). When editing, splice the live
  // body into the PR-root draft; when the live body falls below the create
  // threshold, drop the PR-root draft entirely so isEmptyContent (which keys on
  // DraftComments.Count) sees "no PR-root draft" and gates Submit (spec § 4.8).
  // headShaDrift is normally false here (drift disables the header button before
  // the dialog opens) but can flip true mid-edit, so it's threaded through.
  const effectiveSession: ReviewSessionDto = (() => {
    if (!editing) {
      return { ...session, draftVerdict: verdict };
    }
    const isPrRoot = (d: { filePath: string | null; lineNumber: number | null }) =>
      d.filePath === null && d.lineNumber === null;
    const bodyHasContent = editingBody.trim().length >= COMPOSER_CREATE_THRESHOLD;
    const draftComments = bodyHasContent
      ? session.draftComments.map((d) => (isPrRoot(d) ? { ...d, bodyMarkdown: editingBody } : d))
      : session.draftComments.filter((d) => !isPrRoot(d));
    return { ...session, draftVerdict: verdict, draftComments };
  })();
  const confirmReason = submitDisabledReason(effectiveSession, headShaDrift, validatorResults);
  const confirmDisabled = confirmReason !== null;

  const title = success
    ? 'Review submitted.'
    : failed
      ? `Submit failed at ${(submitState as Extract<SubmitState, { kind: 'failed' }>).failedStep}.`
      : inFlight
        ? 'Submitting your review…'
        : 'Submit review';

  const prUrl = htmlUrl;

  const editTooltip =
    cantEdit === 'editing-in-other-tab'
      ? 'Another tab is editing this PR.'
      : cantEdit === 'editing-in-overview-composer'
        ? 'Close the Overview composer to edit here.'
        : undefined;

  const handleConfirm = async () => {
    // Guard the flush round-trip — the dialog stays `idle` (Confirm enabled)
    // until the parent's submit() flips the state, so a rapid double-click would
    // otherwise fire two onSubmit calls.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      // Flush the debounced body save so a keystroke <250ms before Confirm
      // still lands in the session the pipeline reads (spec § 8.2). Default to
      // Comment when no verdict was picked (spec § 6).
      if (editing) await editorControl.current?.flush();
      onSubmit(verdict ?? 'comment');
    } finally {
      confirmingRef.current = false;
    }
  };

  // Discard footer button visibility: a pending review exists OR a submit is
  // in flight for this PR (spec § 4.8).
  const showDiscard = session.pendingReviewId !== null || kind === 'in-flight';

  const handleDiscard = async () => {
    if (!discardOwnPendingReview) return;
    setDiscardError(null);
    const r = await discardOwnPendingReview();
    if (!r.ok) {
      // The modal renders "Couldn't discard: {message}." and appends its own
      // period — strip a trailing one so we never show "..".
      setDiscardError(r.message.endsWith('.') ? r.message.slice(0, -1) : r.message);
      return;
    }
    // 204: close the modal + the dialog + surface the optimistic toast.
    setDiscardModalOpen(false);
    onDiscardSuccess?.();
    onClose();
  };

  return (
    <Modal open={open} title={title} onClose={handleClose} disableEscDismiss>
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

          <section data-section="summary" className="submit-dialog__section submit-dialog__pr-root">
            <header className="submit-dialog__pr-root-header">
              <span className="submit-dialog__summary-label" id="submit-dialog-pr-root-label">
                PR-level body
              </span>
              {!editing ? (
                <button
                  type="button"
                  className="composer-preview-toggle"
                  data-testid="pr-root-edit-toggle"
                  disabled={frozen || cantEdit !== null}
                  title={editTooltip}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-preview-toggle"
                  data-testid="pr-root-done-toggle"
                  onClick={() => setEditing(false)}
                >
                  Done
                </button>
              )}
            </header>

            <div className="submit-dialog__pr-root-body" data-section="summary-preview">
              {editing ? (
                <PrRootBodyEditor
                  key={prRootDraft?.id ?? 'new'}
                  prRef={reference}
                  prState={prState}
                  draftId={prRootDraft?.id ?? null}
                  onDraftIdChange={setBodyDraftId}
                  registerOpenComposer={registerOpenComposer}
                  ownerKey="submit-dialog"
                  initialBody={prRootDraft?.bodyMarkdown ?? ''}
                  readOnly={readOnly}
                  onBodyChange={setEditingBody}
                  onAutosaveControl={handleAutosaveControl}
                  onDraftLost={handleDraftLost}
                />
              ) : editingBody.trim().length > 0 ? (
                <MarkdownRenderer source={editingBody} />
              ) : (
                <p className="muted">No PR-level body — click Edit to add one.</p>
              )}
            </div>
          </section>

          <section data-section="counts" className="submit-dialog__section">
            <CountsBlock
              // The PR-root draft (filePath/lineNumber null) ships as the review
              // body, not a thread — StepAttachThreadsAsync filters it out — so
              // exclude it from the thread count. Matches DiscardAllDraftsButton.
              threadCount={
                session.draftComments.filter((d) => !(d.filePath === null && d.lineNumber === null))
                  .length
              }
              replyCount={session.draftReplies.length}
            />
          </section>

          {showProgress && (
            <section data-section="progress" className="submit-dialog__section">
              {inFlight && discardInFlight && (
                <p className="submit-dialog__spinner" role="status" aria-live="polite">
                  Cancelling…
                </p>
              )}
              <SubmitProgressIndicator steps={progressSteps} />
            </section>
          )}
        </div>

        <footer className="submit-dialog__footer">
          {showDiscard && (
            <button
              type="button"
              className="btn btn-secondary submit-dialog__discard"
              data-testid="dialog-discard"
              disabled={discardInFlight}
              onClick={() => {
                setDiscardError(null);
                setDiscardModalOpen(true);
              }}
            >
              Discard pending review
            </button>
          )}

          {!success && (
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-secondary"
              data-modal-role="cancel"
              disabled={inFlight || discardInFlight}
              onClick={handleClose}
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
              {prUrl && (
                <a className="btn btn-secondary" href={prUrl} target="_blank" rel="noreferrer">
                  View on GitHub →
                </a>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </footer>
      </div>

      <DiscardPendingReviewConfirmationModal
        open={discardModalOpen}
        onCancel={() => {
          if (discardInFlight) return;
          setDiscardModalOpen(false);
          setDiscardError(null);
        }}
        onDiscard={() => void handleDiscard()}
        discardInFlight={discardInFlight}
        errorMessage={discardError}
      />
    </Modal>
  );
}
