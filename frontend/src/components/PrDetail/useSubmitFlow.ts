import { useEffect, useState } from 'react';
import type { DraftVerdict, PrReference, ReviewSessionDto } from '../../api/types';
import { sendPatch } from '../../api/draft';
import { SubmitConflictError, discardAllDrafts, submitErrorMessage } from '../../api/submit';
import {
  useSubmit,
  type ResumeSummary,
  type SubmitState,
  type UseSubmitResult,
} from '../../hooks/useSubmit';
import type { ToastSpec } from '../Toast';

// PrHeader's submit orchestration, extracted for #327 slice 3. The hook OWNS
// the useSubmit(reference) instance plus the SubmitDialog open state and the
// pill-discard modal state; PrHeader stays layout-only and consumes the
// returned surface (state slices to render, handlers to wire into JSX).
export interface UseSubmitFlowOpts {
  reference: PrReference;
  // The draft session (null while loading) — onResume reads its persisted
  // draftVerdict as the resume verdict.
  session: ReviewSessionDto | null;
  // Called after a verdict patch / discard / foreign-review action so the page
  // refetches the session (own-tab SSE events are filtered, so the change
  // wouldn't otherwise round-trip).
  onSessionRefetch?: () => void;
  // Toast emitter (useToast().show) — the moved handlers surface errors and
  // the pill-discard success confirmation through it.
  show: (spec: Omit<ToastSpec, 'id'>) => void;
}

export interface UseSubmitFlowResult {
  // Submit-state slice the PrHeader layout renders (narrowed from the whole
  // useSubmit object so PrHeader can't reach submit mutators directly).
  submitState: SubmitState;
  lastResume: ResumeSummary | null;
  discardInFlight: boolean;
  // Threaded through to SubmitDialog, which drives its own discard button.
  discardOwnPendingReview: UseSubmitResult['discardOwnPendingReview'];
  // Dialog state.
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  // Pill-discard modal state (spec § 4.9). Intent handlers, not raw setters:
  // open clears any stale error first; cancel is a no-op mid-discard.
  pillDiscardModalOpen: boolean;
  pillDiscardError: string | null;
  openPillDiscardModal: () => void;
  cancelPillDiscard: () => void;
  // Moved handlers.
  patchVerdict: (verdict: DraftVerdict | null) => void;
  onResume: () => void;
  // SubmitDialog's confirm/retry actions, pre-wrapped with the submit-error
  // toast catch so PrHeader doesn't need surfaceSubmitError.
  onSubmit: (verdict: DraftVerdict) => void;
  onRetry: () => void;
  onResumeForeignPendingReview: (reviewId: string) => void;
  onDiscardForeignPendingReview: (reviewId: string) => void;
  onDiscardAllDrafts: () => void;
  handlePillDiscard: () => Promise<void>;
  // SubmitDialog's post-discard success confirmation — the hook owns the toast
  // copy so it appears once (the pill path in handlePillDiscard shares it).
  onDialogDiscardSuccess: () => void;
}

export function useSubmitFlow({
  reference,
  session,
  onSessionRefetch,
  show,
}: UseSubmitFlowOpts): UseSubmitFlowResult {
  const submit = useSubmit(reference);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Closed-dialog discard surface (spec § 4.9). When the SubmitDialog is shut,
  // the pill next to Submit offers the same Discard action. It needs its OWN
  // confirmation-modal instance + open/error state: the dialog's modal is
  // unmounted while `dialogOpen` is false, so the pill can't share it. The two
  // surfaces are mutually exclusive (`!dialogOpen` gates the pill), so they
  // never both drive a discard at once. discardInFlight / discardOwnPendingReview
  // come from the shared `submit` instance — the single in-flight flag is fine
  // because only one surface is mounted at a time.
  //
  // Deviation from spec § 4.9: the visibility predicate uses this hook's local
  // `dialogOpen` (which actually mounts the SubmitDialog) rather than
  // `submit.submitDialogOpen`. Task 22 wired the dialog off `dialogOpen` and
  // never calls openSubmitDialog/closeSubmitDialog, so the hook's flag stays
  // false here — gating the pill on it would leave the pill visible behind the
  // open dialog. `dialogOpen` is the faithful "is the dialog open?" signal.
  const [pillDiscardModalOpen, setPillDiscardModalOpen] = useState(false);
  const [pillDiscardError, setPillDiscardError] = useState<string | null>(null);

  // Opening clears any error left over from a previous attempt so the modal
  // doesn't reopen mid-complaint.
  const openPillDiscardModal = () => {
    setPillDiscardError(null);
    setPillDiscardModalOpen(true);
  };

  // Cancel is ignored while the discard POST is in flight — the modal's buttons
  // are disabled then, and Escape must not close it out from under the request.
  const cancelPillDiscard = () => {
    if (submit.discardInFlight) return;
    setPillDiscardModalOpen(false);
    setPillDiscardError(null);
  };

  // A successful submit clears the session server-side. The session refetch that
  // reflects the cleared state in the header (verdict picker, recovery badge, Submit
  // button enable state) is driven by the post-clear `draft-submitted` SSE event
  // (PrDetailView.useDraftSubmittedSubscriber → draftSession.refetch) — NOT here.
  // #392: the prior onSessionRefetch() call fired on the submit-progress
  // Finalize/Succeeded SSE, which the pipeline reports BEFORE ClearSubmittedSession
  // persists, so it read the un-cleared session and the submitted draft popped back
  // into the composer. Removing it leaves no gap: `submit.state.kind === 'success'`
  // is itself SSE-driven (useSubmit), so this effect never had a non-SSE path, and the
  // post-clear draft-submitted + StateChanged(SourceTabId:null) refetches now own the
  // composer-clear. clearLastResume stays — it is timing-independent.
  useEffect(() => {
    if (submit.state.kind === 'success') {
      // Imported drafts (if any) were adjudicated + submitted — the post-Resume
      // banner is moot now.
      submit.clearLastResume();
    }
    // Depend on the transition trigger (`submit.state.kind`) and the stable
    // `submit.clearLastResume` (useCallback([])), NOT the whole `submit` object —
    // useSubmit returns a fresh object literal each render, so depending on it would
    // re-run this effect every render while parked in `success`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrowed to submit.state.kind + the stable submit.clearLastResume; the whole `submit` object is re-created each render (#331)
  }, [submit.state.kind, submit.clearLastResume]);

  const patchVerdict = (verdict: DraftVerdict | null) => {
    void sendPatch(reference, { kind: 'draftVerdict', payload: verdict }).then(() => {
      onSessionRefetch?.();
    });
  };

  const openDialog = () => setDialogOpen(true);

  const closeDialog = () => {
    setDialogOpen(false);
    submit.reset();
  };

  const onResume = () => {
    // R3 — re-enter the pipeline at Step 1's "match by ID" outcome via the
    // persisted pendingReviewId; default to Comment if no verdict was set.
    setDialogOpen(true);
    void submit.submit(session?.draftVerdict ?? 'comment').catch(surfaceSubmitError);
  };

  const surfaceSubmitError = (err: unknown) => {
    if (err instanceof SubmitConflictError) {
      show({ kind: 'error', message: submitErrorMessage(err) });
      return;
    }
    show({
      kind: 'error',
      message: "Couldn't submit — an unexpected error occurred. Try again.",
    });
  };

  const onSubmit = (verdict: DraftVerdict) => {
    void submit.submit(verdict).catch(surfaceSubmitError);
  };

  const onRetry = () => {
    void submit.retry().catch(surfaceSubmitError);
  };

  // Foreign-pending-review prompt (spec § 11). Resume imports the foreign
  // review's threads as Draft entries (adjudicated from the Drafts tab) and
  // closes the dialog; Discard deletes it on github.com. A TOCTOU 409
  // (`pending-review-state-changed`) surfaces a toast and useSubmit resets to
  // idle (spec § 11.4). Surfaced as `error` because the user's explicit
  // Resume/Discard action *failed* — a blue info banner reads as confirmation
  // when the truth is "your action did nothing; retry submit".
  const surfaceForeignReviewError = (err: unknown) => {
    if (err instanceof SubmitConflictError && err.code === 'pending-review-state-changed') {
      show({
        kind: 'error',
        message: 'Your pending review state changed during the prompt. Please retry submit.',
      });
      return;
    }
    // useSubmit has already reset to idle; surface a generic note so the action
    // doesn't fail silently.
    show({ kind: 'error', message: 'Could not complete that action on the pending review.' });
  };

  // Close the dialog synchronously before awaiting — once the resume/discard
  // POST resolves, useSubmit flips its state to `idle`, and if the dialog were
  // still mounted that would flash the full submit form (and jump focus) for one
  // render before the .then unmounts it. The spec also has the dialog close on a
  // TOCTOU 409 here, so optimistic-close + a toast on failure matches both.
  const onResumeForeignPendingReview = (reviewId: string) => {
    setDialogOpen(false);
    void submit
      .resumeForeignPendingReview(reviewId)
      .then(() => onSessionRefetch?.())
      .catch(surfaceForeignReviewError);
  };

  const onDiscardForeignPendingReview = (reviewId: string) => {
    setDialogOpen(false);
    void submit
      .discardForeignPendingReview(reviewId)
      .then(() => onSessionRefetch?.())
      .catch(surfaceForeignReviewError);
  };

  // Closed/merged-PR bulk discard (spec § 13). POST /drafts/discard-all clears
  // all session state and best-effort-deletes the pending review on github.com
  // (a failure there fans out submit-orphan-cleanup-failed → useSubmitToasts).
  const onDiscardAllDrafts = () => {
    void discardAllDrafts(reference)
      .then(() => onSessionRefetch?.())
      .catch(() => {
        show({ kind: 'error', message: 'Could not discard the drafts. Please try again.' });
      });
  };

  // Post-discard success confirmation. Single owner of the toast copy — the
  // pill path (handlePillDiscard) and the SubmitDialog path (passed through as
  // onDialogDiscardSuccess) both show this.
  const showDiscardedToast = () => show({ kind: 'info', message: 'Pending review discarded' });

  // Pill-surface discard (spec § 4.9). Mirrors SubmitDialog.handleDiscard (T22):
  // success → close the modal + optimistic toast; failure → surface the error in
  // the modal (which appends its own period, so strip a trailing one to avoid
  // ".."). The pill has no dialog to close on success — only its own modal.
  const handlePillDiscard = async () => {
    setPillDiscardError(null);
    const r = await submit.discardOwnPendingReview();
    if (!r.ok) {
      setPillDiscardError(r.message.endsWith('.') ? r.message.slice(0, -1) : r.message);
      return;
    }
    setPillDiscardModalOpen(false);
    showDiscardedToast();
  };

  return {
    submitState: submit.state,
    lastResume: submit.lastResume,
    discardInFlight: submit.discardInFlight,
    discardOwnPendingReview: submit.discardOwnPendingReview,
    dialogOpen,
    openDialog,
    closeDialog,
    pillDiscardModalOpen,
    pillDiscardError,
    openPillDiscardModal,
    cancelPillDiscard,
    patchVerdict,
    onResume,
    onSubmit,
    onRetry,
    onResumeForeignPendingReview,
    onDiscardForeignPendingReview,
    onDiscardAllDrafts,
    handlePillDiscard,
    onDialogDiscardSuccess: showDiscardedToast,
  };
}
