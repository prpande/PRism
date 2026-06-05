import { useEffect, useState } from 'react';
import type { DraftVerdict, PrReference, ReviewSessionDto, ValidatorResult } from '../../api/types';
import type { ComposerOwnerKey } from '../../hooks/useDraftSession';
import { formatAge } from '../../utils/relativeTime';
import { sendPatch } from '../../api/draft';
import {
  SubmitConflictError,
  discardAllDrafts,
  isKnownSubmitErrorCode,
  verdictToSubmitWire,
  type KnownSubmitErrorCode,
} from '../../api/submit';
import { useSubmit } from '../../hooks/useSubmit';
import { useAiGate } from '../../hooks/useAiGate';
import { useSubmitToasts } from '../../hooks/useSubmitToasts';
import { useToast } from '../Toast';
import { PrSubTabStrip, type PrTabId } from './PrSubTabStrip';
import { VerdictPicker } from './VerdictPicker';
import { SubmitButton } from './SubmitButton';
import { SubmitInProgressBadge } from './SubmitInProgressBadge';
import { DiscardAllDraftsButton } from './DiscardAllDraftsButton';
import { DiscardPendingReviewConfirmationModal } from './DiscardPendingReviewConfirmationModal';
import { ImportedDraftsBanner } from './ForeignPendingReviewModal/ImportedDraftsBanner';
import styles from './PrHeader.module.css';
import { AskAiButton } from './AskAiButton';
import { Avatar } from '../Avatar/Avatar';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { SubmitDialog } from './SubmitDialog/SubmitDialog';

// Closed/merged PRs can't accept a review submit; the verdict picker is hidden
// and the bulk-discard button surfaces (spec § 13.1). PrDetailPage derives this
// from data.pr.isMerged / data.pr.isClosed.
export type PrState = 'open' | 'closed' | 'merged';

// Frontend-side canned validator result for the demo (spec § 14.1). No
// IPreSubmitValidator.ValidateAsync call — the placeholder mirrors S0–S4's
// "frontend stub data, not backend-served" precedent.
export const CANNED_PRESUBMIT_VALIDATOR_RESULTS: ValidatorResult[] = [
  {
    severity: 'Suggestion',
    message: '3 inline threads on the same file (`src/Foo.cs`) — consider consolidating?',
  },
];

// Feeds SubmitButton's enable-rule evaluation while the draft session hasn't
// loaded yet — the `disabled` override keeps the button off regardless.
const EMPTY_SESSION: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

interface PrHeaderProps {
  reference: PrReference;
  title: string;
  author: string;
  avatarUrl?: string | null;
  branchInfo?: { headBranch: string; baseBranch: string };
  mergeability?: string;
  ciSummary?: string;
  iterationLabel?: string;
  activeTab: PrTabId;
  onTabChange: (tab: PrTabId) => void;
  fileCount?: number;
  draftsCount?: number;
  // S5 — the draft session drives the verdict picker + Submit button + the
  // in-flight-submit recovery badge. Null while the PR detail is loading.
  session?: ReviewSessionDto | null;
  // Rule (f): the most-recent active-PR poll observed head_sha drift.
  headShaDrift?: boolean;
  // The PR's currently-known head sha — shown (truncated) in the
  // stale-commit-oid banner inside the submit dialog (spec § 12).
  currentHeadSha?: string;
  // Closed/merged PRs hide the verdict picker + disable Submit and surface the
  // bulk-discard button instead (spec § 13.1). Defaults to 'open' (loading).
  prState?: PrState;
  // Cross-tab ownership (spec § 5.7a). Threads into the SubmitDialog's PR-root
  // Edit toggle + editor so a peer-owned PR can't be edited from here.
  readOnly?: boolean;
  // Cross-surface composer registry (shared with the Overview-tab composer) so
  // the SubmitDialog's PR-root edit mode holds the draft mutually-exclusively.
  registerOpenComposer?: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Returns the ownerKey holding the PR-root draft (or null) — drives the
  // SubmitDialog Edit-disabled cross-surface lock.
  getPrRootHolder?: () => ComposerOwnerKey | null;
  // Called after a verdict patch so the page refetches the session (own-tab
  // SSE events are filtered, so the change wouldn't otherwise round-trip).
  onSessionRefetch?: () => void;
  // Merged/closed timestamp for the header status label (Task 13).
  mergedAt?: string | null;
  closedAt?: string | null;
}

export function PrHeader({
  reference,
  title,
  author,
  avatarUrl,
  branchInfo,
  mergeability,
  ciSummary,
  iterationLabel,
  activeTab,
  onTabChange,
  fileCount,
  draftsCount,
  session = null,
  headShaDrift = false,
  currentHeadSha = '',
  prState = 'open',
  readOnly = false,
  registerOpenComposer,
  getPrRootHolder,
  onSessionRefetch,
  mergedAt,
  closedAt,
}: PrHeaderProps) {
  const validatorResults: ValidatorResult[] = useAiGate('preSubmitValidators')
    ? CANNED_PRESUBMIT_VALIDATOR_RESULTS
    : [];

  const submit = useSubmit(reference);
  const { show } = useToast();
  // Cross-cutting submit toasts: submit-duplicate-marker-detected /
  // submit-orphan-cleanup-failed (spec § 11.4 / § 13.2).
  useSubmitToasts(reference, { showToast: (message) => show({ kind: 'info', message }) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toggle: toggleAskAi } = useAskAiDrawer();
  const isClosedOrMerged = prState !== 'open';

  // Closed-dialog discard surface (spec § 4.9). When the SubmitDialog is shut,
  // the pill next to Submit offers the same Discard action. It needs its OWN
  // confirmation-modal instance + open/error state: the dialog's modal is
  // unmounted while `dialogOpen` is false, so the pill can't share it. The two
  // surfaces are mutually exclusive (`!dialogOpen` gates the pill), so they
  // never both drive a discard at once. discardInFlight / discardOwnPendingReview
  // come from the shared `submit` instance — the single in-flight flag is fine
  // because only one surface is mounted at a time.
  //
  // Deviation from spec § 4.9: the visibility predicate uses PrHeader's local
  // `dialogOpen` (which actually mounts the SubmitDialog) rather than
  // `submit.submitDialogOpen`. Task 22 wired the dialog off `dialogOpen` and
  // never calls openSubmitDialog/closeSubmitDialog, so the hook's flag stays
  // false here — gating the pill on it would leave the pill visible behind the
  // open dialog. `dialogOpen` is the faithful "is the dialog open?" signal.
  const [pillDiscardModalOpen, setPillDiscardModalOpen] = useState(false);
  const [pillDiscardError, setPillDiscardError] = useState<string | null>(null);

  // Any active submit flow freezes the header verdict picker (spec § 8.3 — held
  // from Confirm through success or failure; the stale-commitOID/failed retry
  // paths re-fire with the last-confirmed verdict, so a mid-flow change would
  // be a no-op) and disables Submit Review (can't open a second dialog).
  const inSubmitFlow = submit.state.kind !== 'idle';

  // A successful submit clears the session server-side; the own-tab SSE filter
  // can swallow the pipeline's state-changed event, so refetch explicitly so the
  // header (verdict picker, recovery badge, Submit button enable state) reflects
  // the cleared session without a manual reload (adversarial #3). onSessionRefetch
  // is intentionally not a dep — it's re-created each render by PrDetailPage.
  useEffect(() => {
    if (submit.state.kind === 'success') {
      onSessionRefetch?.();
      // Imported drafts (if any) were adjudicated + submitted — the post-Resume
      // banner is moot now.
      submit.clearLastResume();
    }
    // `onSessionRefetch` is intentionally omitted — it's re-created each render
    // by PrDetailPage; including it would re-run the refetch every render while
    // in `success`. `submit.clearLastResume` is stable (useCallback([])).
  }, [submit.state.kind, submit.clearLastResume]);

  const patchVerdict = (verdict: DraftVerdict | null) => {
    void sendPatch(reference, { kind: 'draftVerdict', payload: verdict }).then(() => {
      onSessionRefetch?.();
    });
  };

  const closeDialog = () => {
    setDialogOpen(false);
    submit.reset();
  };

  const onResume = () => {
    // R3 — re-enter the pipeline at Step 1's "match by ID" outcome via the
    // persisted pendingReviewId; default to Comment if no verdict was set.
    setDialogOpen(true);
    void submit
      .submit(verdictToSubmitWire(session?.draftVerdict ?? 'comment'))
      .catch(surfaceSubmitError);
  };

  // Maps backend SubmitErrorDto.code values to user-facing toast copy. Keep in
  // sync with PrSubmitEndpoints.cs (the SubmitAsync rule a–f rejections + the
  // submit-in-progress 409). An unknown code (forward-compat: server schema
  // bump arriving before the FE knows about it) falls through to the
  // server-supplied message so it's still visible, not silent. A *known* code
  // missing from the switch is a compile-time error — no `default` clause +
  // exhaustive narrowing via `KnownSubmitErrorCode` enforces parity.
  // Regression: prior to this map, the catch was empty with a comment claiming
  // useSubmitToasts handled it — that hook only listens for two SSE events,
  // not HTTP 4xx, which made every pre-pipeline rejection invisible.
  const submitErrorMessage = (err: SubmitConflictError): string => {
    if (!isKnownSubmitErrorCode(err.code)) return err.message;
    const code: KnownSubmitErrorCode = err.code;
    switch (code) {
      case 'head-sha-not-stamped':
        return "Couldn't submit — the PR view hasn't been stamped yet. Reload the PR and try again.";
      case 'tab-id-missing':
        // Cross-tab-stamp slice: the server got no X-PRism-Tab-Id header (or one outside the
        // allowlist). The remedy is to reload THIS tab so getTabId() mints a fresh id and the
        // first /mark-viewed call stamps it. "Reload the PR" (the head-sha-not-stamped wording
        // above) would point the user at the wrong remediation — the PR detail isn't stale,
        // the tab itself is.
        return "Couldn't submit — this browser tab is in an unexpected state. Reload the tab and try again.";
      case 'head-sha-drift':
        return "Couldn't submit — the PR's head commit changed since you last viewed it. Reload the PR.";
      case 'unauthorized':
        return "Couldn't submit — your subscription to this PR was lost. Reload the PR.";
      case 'no-session':
        return "Couldn't submit — no draft session for this PR. Reload the PR.";
      case 'stale-drafts':
        return "Couldn't submit — there are stale drafts. Resolve or override them in the Drafts tab first.";
      case 'verdict-needs-reconfirm':
        return "Couldn't submit — re-confirm your verdict before submitting.";
      case 'no-content':
        return "Couldn't submit — a Comment-verdict review needs at least one inline comment, reply, or summary.";
      case 'verdict-invalid':
        return "Couldn't submit — verdict must be Approve, Request changes, or Comment.";
      case 'submit-in-progress':
        return 'A submit is already in flight for this PR. Wait for it to finish or refresh the page.';
      case 'pending-review-state-changed':
        // Normally handled by surfaceForeignReviewError on the Resume/Discard
        // path. If a submit ever surfaces it (race between submit and a peer
        // changing pending-review state), fall back to the server message.
        return err.message;
      case 'delete-failed':
        // 502 from cleanup of the foreign pending review on discardAll —
        // user-visible copy lives in onDiscardAllDrafts; if it ever flows here,
        // honour the server message.
        return err.message;
    }
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
    show({ kind: 'info', message: 'Pending review discarded' });
  };

  return (
    <div className={styles.prHeader} data-testid="pr-header">
      <div className={styles.prHeaderTop}>
        <div className="pr-meta col gap-1">
          <div className="row gap-2 muted-2 pr-meta-repo">
            <span>
              {reference.owner}/{reference.repo}
            </span>
            <span aria-hidden="true">·</span>
            <span>#{reference.number}</span>
          </div>
          <h1 className={styles.prTitle} data-testid="pr-title">
            {title}
          </h1>
          {prState === 'merged' && mergedAt && (
            <span className={styles.statusMerged}>Merged {formatAge(mergedAt)}</span>
          )}
          {prState === 'closed' && closedAt && (
            <span className={styles.statusClosed}>Closed {formatAge(closedAt)}</span>
          )}
          <div className={`row gap-3 muted-2 ${styles.prSubtitle}`}>
            <span className={`pr-subtitle-author ${styles.subtitleAuthor}`}>
              <Avatar src={avatarUrl} login={author} size="lg" />
              {author}
            </span>
            {branchInfo && (
              <span className="pr-subtitle-branch">
                {branchInfo.headBranch} → {branchInfo.baseBranch}
              </span>
            )}
            {ciSummary && <span className={`chip chip-ci chip-ci-${ciSummary}`}>{ciSummary}</span>}
            {mergeability && (
              <span className={`chip chip-mergeability chip-mergeability-${mergeability}`}>
                {mergeability}
              </span>
            )}
            {iterationLabel && <span className="chip">{iterationLabel}</span>}
          </div>
        </div>
        <div className={styles.prActions}>
          {/* Only when nothing is in flight in *this* tab — re-firing submit()
              over an active pipeline would 409 and (caught) wedge the dialog. */}
          {session && submit.state.kind === 'idle' && (
            <SubmitInProgressBadge session={session} onResume={onResume} />
          )}
          {/* Verdict picker is hidden (not disabled) on a closed/merged PR — a
              verdict can't be submitted there (spec § 13.1). */}
          {!isClosedOrMerged && (
            <VerdictPicker
              value={session?.draftVerdict ?? null}
              verdictStatus={session?.draftVerdictStatus}
              disabled={!session || inSubmitFlow}
              onChange={patchVerdict}
            />
          )}
          {/* Read order on a closed/merged PR: [Discard all drafts | Submit (disabled)]. */}
          {session && isClosedOrMerged && (
            <DiscardAllDraftsButton
              prState={prState}
              session={session}
              onDiscard={onDiscardAllDrafts}
            />
          )}
          {/* Closed-dialog discard surface (spec § 4.9) — mutually exclusive
              with the SubmitDialog's footer Discard button via `!dialogOpen`. */}
          {session?.pendingReviewId != null && !dialogOpen && (
            <button
              type="button"
              className={styles.pendingReviewPill}
              data-testid="pending-review-pill"
              onClick={() => {
                setPillDiscardError(null);
                setPillDiscardModalOpen(true);
              }}
            >
              Pending review on GitHub · Discard
            </button>
          )}
          <SubmitButton
            session={session ?? EMPTY_SESSION}
            headShaDrift={headShaDrift}
            validatorResults={validatorResults}
            disabled={!session || inSubmitFlow || isClosedOrMerged}
            onSubmit={() => setDialogOpen(true)}
          />
          <AskAiButton onClick={toggleAskAi} />
        </div>
      </div>
      <PrSubTabStrip
        activeTab={activeTab}
        onTabChange={onTabChange}
        fileCount={fileCount}
        draftsCount={draftsCount}
      />
      {submit.lastResume && (
        <ImportedDraftsBanner
          snapshotA={submit.lastResume.snapshotA}
          snapshotB={submit.lastResume.snapshotB}
          hasResolvedImports={submit.lastResume.hasResolvedImports}
        />
      )}
      {dialogOpen && session && (
        <SubmitDialog
          open
          reference={reference}
          session={session}
          prState={prState}
          readOnly={readOnly}
          validatorResults={validatorResults}
          submitState={submit.state}
          headShaDrift={headShaDrift}
          currentHeadSha={currentHeadSha}
          registerOpenComposer={registerOpenComposer}
          getPrRootHolder={getPrRootHolder}
          discardOwnPendingReview={submit.discardOwnPendingReview}
          discardInFlight={submit.discardInFlight}
          onDiscardSuccess={() => show({ kind: 'info', message: 'Pending review discarded' })}
          onClose={closeDialog}
          onSubmit={(verdict) => {
            void submit.submit(verdict).catch(surfaceSubmitError);
          }}
          onRetry={() => {
            void submit.retry().catch(surfaceSubmitError);
          }}
          onVerdictChange={patchVerdict}
          onResumeForeignPendingReview={onResumeForeignPendingReview}
          onDiscardForeignPendingReview={onDiscardForeignPendingReview}
        />
      )}
      {/* Pill's OWN modal instance — the SubmitDialog's modal is unmounted while
          the dialog is closed, so the pill can't reuse it (spec § 4.9). */}
      <DiscardPendingReviewConfirmationModal
        open={pillDiscardModalOpen}
        onCancel={() => {
          if (submit.discardInFlight) return;
          setPillDiscardModalOpen(false);
          setPillDiscardError(null);
        }}
        onDiscard={() => void handlePillDiscard()}
        discardInFlight={submit.discardInFlight}
        errorMessage={pillDiscardError}
      />
    </div>
  );
}
