import { useEffect, useState } from 'react';
import type { DraftVerdict, PrReference, ReviewSessionDto, ValidatorResult } from '../../api/types';
import { sendPatch } from '../../api/draft';
import { SubmitConflictError, discardAllDrafts, verdictToSubmitWire } from '../../api/submit';
import { useCapabilities } from '../../hooks/useCapabilities';
import { usePreferences } from '../../hooks/usePreferences';
import { useSubmit } from '../../hooks/useSubmit';
import { useSubmitToasts } from '../../hooks/useSubmitToasts';
import { useToast } from '../Toast';
import { PrSubTabStrip, type PrTabId } from './PrSubTabStrip';
import { VerdictPicker } from './VerdictPicker';
import { SubmitButton } from './SubmitButton';
import { SubmitInProgressBadge } from './SubmitInProgressBadge';
import { DiscardAllDraftsButton } from './DiscardAllDraftsButton';
import { ImportedDraftsBanner } from './ForeignPendingReviewModal/ImportedDraftsBanner';
import { AskAiButton } from './AskAiButton';
import { AskAiEmptyState } from './AskAiEmptyState';
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
  draftSummaryMarkdown: null,
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
  // Called after a verdict patch so the page refetches the session (own-tab
  // SSE events are filtered, so the change wouldn't otherwise round-trip).
  onSessionRefetch?: () => void;
}

export function PrHeader({
  reference,
  title,
  author,
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
  onSessionRefetch,
}: PrHeaderProps) {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  const aiPreview = preferences?.aiPreview ?? false;
  const validatorResults: ValidatorResult[] =
    aiPreview && !!capabilities?.preSubmitValidators ? CANNED_PRESUBMIT_VALIDATOR_RESULTS : [];

  const submit = useSubmit(reference);
  const { show } = useToast();
  // Cross-cutting submit toasts: submit-duplicate-marker-detected /
  // submit-orphan-cleanup-failed (spec § 11.4 / § 13.2).
  useSubmitToasts(reference, { showToast: (message) => show({ kind: 'info', message }) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const isClosedOrMerged = prState !== 'open';

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
  }, [submit.state.kind]);

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
    void submit.submit(verdictToSubmitWire(session?.draftVerdict ?? 'comment')).catch(() => {
      // 409 / 4xx: useSubmit already reset to idle; PR5's useSubmitToasts
      // surfaces the code. The dialog stays open in idle.
    });
  };

  // Foreign-pending-review prompt (spec § 11). Resume imports the foreign
  // review's threads as Draft entries (adjudicated from the Drafts tab) and
  // closes the dialog; Discard deletes it on github.com. A TOCTOU 409
  // (`pending-review-state-changed`) surfaces a toast and useSubmit resets to
  // idle (spec § 11.4).
  const surfaceForeignReviewError = (err: unknown) => {
    if (err instanceof SubmitConflictError && err.code === 'pending-review-state-changed') {
      show({
        kind: 'info',
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

  return (
    <div className="pr-header">
      <div className="pr-header-top">
        <div className="pr-meta col gap-1">
          <div className="row gap-2 muted-2 pr-meta-repo">
            <span>
              {reference.owner}/{reference.repo}
            </span>
            <span aria-hidden="true">·</span>
            <span>#{reference.number}</span>
          </div>
          <h1 className="pr-title">{title}</h1>
          <div className="row gap-3 muted-2 pr-subtitle">
            <span className="pr-subtitle-author">{author}</span>
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
        <div className="pr-actions">
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
              prRef={`${reference.owner}/${reference.repo}/${reference.number}`}
              prState={prState}
              session={session}
              onDiscard={onDiscardAllDrafts}
            />
          )}
          <SubmitButton
            session={session ?? EMPTY_SESSION}
            headShaDrift={headShaDrift}
            validatorResults={validatorResults}
            disabled={!session || inSubmitFlow || isClosedOrMerged}
            onSubmit={() => setDialogOpen(true)}
          />
          <AskAiButton aiPreview={aiPreview} onClick={() => setAskAiOpen(true)} />
        </div>
      </div>
      <AskAiEmptyState open={askAiOpen} onClose={() => setAskAiOpen(false)} />
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
          validatorResults={validatorResults}
          submitState={submit.state}
          headShaDrift={headShaDrift}
          currentHeadSha={currentHeadSha}
          onClose={closeDialog}
          onSubmit={(verdict) => {
            void submit.submit(verdict).catch(() => {
              // See onResume — PR5's useSubmitToasts handles the 409 toast.
            });
          }}
          onRetry={() => {
            void submit.retry();
          }}
          onVerdictChange={patchVerdict}
          onResumeForeignPendingReview={onResumeForeignPendingReview}
          onDiscardForeignPendingReview={onDiscardForeignPendingReview}
        />
      )}
    </div>
  );
}
