import { useState } from 'react';
import type { DraftVerdict, PrReference, ReviewSessionDto, ValidatorResult } from '../../api/types';
import { sendPatch } from '../../api/draft';
import { verdictToSubmitWire } from '../../api/submit';
import { useCapabilities } from '../../hooks/useCapabilities';
import { usePreferences } from '../../hooks/usePreferences';
import { useSubmit } from '../../hooks/useSubmit';
import { PrSubTabStrip, type PrTabId } from './PrSubTabStrip';
import { VerdictPicker } from './VerdictPicker';
import { SubmitButton } from './SubmitButton';
import { SubmitInProgressBadge } from './SubmitInProgressBadge';
import { AskAiButton } from './AskAiButton';
import { AskAiEmptyState } from './AskAiEmptyState';
import { SubmitDialog } from './SubmitDialog/SubmitDialog';

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
  onSessionRefetch,
}: PrHeaderProps) {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  const aiPreview = preferences?.aiPreview ?? false;
  const validatorResults: ValidatorResult[] =
    aiPreview && !!capabilities?.preSubmitValidators ? CANNED_PRESUBMIT_VALIDATOR_RESULTS : [];

  const submit = useSubmit(reference);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);

  // Verdict picker frozen while the pipeline runs and after success (spec § 8.3).
  const submitting = submit.state.kind === 'in-flight' || submit.state.kind === 'success';

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
          {session && <SubmitInProgressBadge session={session} onResume={onResume} />}
          <VerdictPicker
            value={session?.draftVerdict ?? null}
            verdictStatus={session?.draftVerdictStatus}
            disabled={!session || submitting}
            onChange={patchVerdict}
          />
          <SubmitButton
            session={session ?? EMPTY_SESSION}
            headShaDrift={headShaDrift}
            validatorResults={validatorResults}
            disabled={!session || submitting}
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
      {dialogOpen && session && (
        <SubmitDialog
          open
          reference={reference}
          session={session}
          validatorResults={validatorResults}
          submitState={submit.state}
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
        />
      )}
    </div>
  );
}
