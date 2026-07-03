import { useEffect, useId, useState } from 'react';
import type {
  PrReference,
  Reviewer,
  ReviewSessionDto,
  ValidatorResult,
  ViewerReview,
} from '../../api/types';
import { prRefKey } from '../../api/types';
import { usePrHeaderCollapsed } from '../../hooks/usePrHeaderCollapsed';
import type { ComposerOwnerKey } from '../../hooks/useDraftSession';
import { formatAge } from '../../utils/relativeTime';
import { useSubmitFlow } from './useSubmitFlow';
import { useAiGate } from '../../hooks/useAiGate';
import { useSubmitToasts } from '../../hooks/useSubmitToasts';
import { useToast } from '../Toast';
import { PrSubTabStrip, type PrTabId } from './PrSubTabStrip';
import type { ChecksLeadGlyph } from './checksGlyphState';
import { DiscardPendingReviewConfirmationModal } from './DiscardPendingReviewConfirmationModal';
import { DiscardAllConfirmationModal } from './DiscardAllConfirmationModal';
import { ImportedDraftsBanner } from './ForeignPendingReviewModal/ImportedDraftsBanner';
import { isPrRootDraft, prRootDraft } from './draftKinds';
import styles from './PrHeader.module.css';
import { Avatar } from '../Avatar/Avatar';
import { Skeleton } from '../Skeleton';
import { SubmitDialog } from './SubmitDialog/SubmitDialog';
import { OpenInGitHubButton } from './OpenInGitHubButton';
import { ReviewActionButton } from './ReviewActionButton/ReviewActionButton';
import { RefreshButton } from '../controls/RefreshButton';
import { PrStateGlyph, type GlyphState } from '../shared/prStateGlyph';
import { ReadinessBadge } from '../shared/ReadinessBadge';
import { isBadgeRendered, type MergeReadiness } from '../shared/mergeReadiness';

// #128/#203 — double-chevron, authored pointing UP (the expanded state, where
// content folds toward when collapsed). The collapsed state rotates it 180° to
// point DOWN via CSS (.prHeader[data-collapsed] .collapseToggle svg), so the
// glyph always points toward the action (#203 point-toward-action convention).
function CollapseChevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7l4-4 4 4" />
      <path d="M4 12l4-4 4 4" />
    </svg>
  );
}

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

// The PR-root review summary is the draft comment with both filePath and lineNumber
// null; its body lives in draftComments. Named here so the discard-all modal can
// count inline threads separately from the summary (mirrors the helper that used to
// live in DiscardAllDraftsButton, removed in this slice).
function prRootSummaryBody(s: ReviewSessionDto): string {
  return (prRootDraft(s.draftComments)?.bodyMarkdown ?? '').trim();
}

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
  hotspotsCount?: number;
  draftsCount?: number;
  // Spec §8 — gate the Hotspots tab on the fileFocus capability (Preview/Live).
  // Threaded from PrDetailView; absent → tab hidden (AI Off).
  showHotspots?: boolean;
  // Hotspots tab-label marker state (spec §3): threaded from PrDetailView via
  // fileFocusStatusToMarkerState. Absent / null = no marker.
  hotspotsAiState?: 'idle' | 'working' | null;
  // Checks tab lead glyph primitives (Task 11). Threaded from PrDetailView via
  // checksGlyphState; PrSubTabStrip builds <ChecksTabGlyph> at the leaf.
  checksLead?: ChecksLeadGlyph;
  checksFailingCount?: number;
  checksAriaLabel?: string;
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
  // #501 — GitHub draft flag (data.pr.isDraft). Drives the leading state glyph
  // (open→draft) and the info Draft marker. Load-time only; defaults false.
  isDraft?: boolean;
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
  // #131 — authoritative PR web URL (PrDetailPr.htmlUrl). Absent → no button.
  htmlUrl?: string | null;
  /** True while the PR detail is cold-loading (!data && isLoading). Swaps title/author/chip slots for skeletons. */
  loading?: boolean;
  // #344 — proactive manual refresh. When provided, the actions cluster renders a
  // RefreshButton (before Open-in-GitHub). Absent → no button (e.g. surfaces that
  // don't wire the refresh hook). isRefreshing/justRefreshed drive its morph state.
  onRefresh?: () => void;
  isRefreshing?: boolean;
  justRefreshed?: boolean;
  // #512 — the viewer's most-recent submitted review on this PR (null = none).
  viewerReview?: ViewerReview | null;
  // #593 — merge-readiness badge (expanded variant). Replaces the bare mergeability chip.
  // The `mergeability` prop above is kept for legacy callers (§9); the old chip is already removed.
  mergeReadiness?: MergeReadiness;
  approvals?: number | null;
  changesRequested?: number | null;
  updatedAt?: string;
  // #593 — reviewer name-lists for the readiness popover people section.
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
}

export function PrHeader({
  reference,
  title,
  author,
  avatarUrl,
  branchInfo,
  ciSummary,
  iterationLabel,
  activeTab,
  onTabChange,
  fileCount,
  hotspotsCount,
  draftsCount,
  showHotspots = false,
  hotspotsAiState,
  checksLead,
  checksFailingCount,
  checksAriaLabel,
  session = null,
  headShaDrift = false,
  currentHeadSha = '',
  prState = 'open',
  isDraft = false,
  readOnly = false,
  registerOpenComposer,
  getPrRootHolder,
  onSessionRefetch,
  mergedAt,
  closedAt,
  htmlUrl,
  loading = false,
  onRefresh,
  isRefreshing = false,
  justRefreshed = false,
  viewerReview,
  mergeReadiness,
  approvals,
  changesRequested,
  approvers,
  changesRequestedBy,
  awaitingReviewers,
  updatedAt,
}: PrHeaderProps) {
  const validatorResults: ValidatorResult[] = useAiGate('preSubmitValidators')
    ? CANNED_PRESUBMIT_VALIDATOR_RESULTS
    : [];

  const [collapsed, toggleCollapsed] = usePrHeaderCollapsed(prRefKey(reference));
  // Per-instance id for aria-controls. PrTabHost keeps one PrDetailView (hence
  // one PrHeader) mounted PER OPEN TAB simultaneously (inactive ones hidden), so
  // a hardcoded id would duplicate across tabs — invalid HTML and aria-controls
  // would resolve to the first tab's region. useId() guarantees uniqueness.
  const metaId = useId();
  const { show } = useToast();
  // Cross-cutting submit toasts: submit-duplicate-marker-detected /
  // submit-orphan-cleanup-failed (spec § 11.4 / § 13.2).
  useSubmitToasts(reference, { showToast: (message) => show({ kind: 'info', message }) });

  // Submit orchestration (#327 slice 3): the useSubmit instance, the dialog +
  // pill-discard-modal state, and every submit/discard/foreign-review handler
  // live in useSubmitFlow — PrHeader only renders the returned state slices and
  // wires the handlers into the layout below.
  const {
    submitState,
    lastResume,
    discardInFlight,
    discardOwnPendingReview,
    dialogOpen,
    openDialog,
    closeDialog,
    pillDiscardModalOpen,
    pillDiscardError,
    setPillDiscardModalOpen,
    setPillDiscardError,
    patchVerdict,
    onResume,
    onSubmit,
    onRetry,
    onResumeForeignPendingReview,
    onDiscardForeignPendingReview,
    onDiscardAllDrafts,
    handlePillDiscard,
  } = useSubmitFlow({ reference, session, onSessionRefetch, show });

  const [discardAllModalOpen, setDiscardAllModalOpen] = useState(false);

  // #501 — header status glyph discriminant (full set: open/merged/closed/draft).
  // isDone (merged/closed) wins over draft via the prState check.
  const glyphState: GlyphState = isDraft && prState === 'open' ? 'draft' : prState;

  // Any active submit flow freezes the header verdict picker (spec § 8.3 — held
  // from Confirm through success or failure; the stale-commitOID/failed retry
  // paths re-fire with the last-confirmed verdict, so a mid-flow change would
  // be a no-op) and disables Submit Review (can't open a second dialog).
  const inSubmitFlow = submitState.kind !== 'idle';

  // Dev-only signal: if a loaded PR (title present) has no htmlUrl, the escape-
  // hatch links silently disappear — surface that so a ParsePr/GraphQL-shape
  // regression is detectable. PrHeader is the always-rendered common ancestor of
  // all three link sites on the detail page.
  useEffect(() => {
    if (import.meta.env.DEV && title && !htmlUrl) {
      console.warn(
        'PrHeader: PR detail rendered without htmlUrl — Open-in-GitHub links hidden',
        reference,
      );
    }
  }, [title, htmlUrl, reference]);

  const submittedReviewStale =
    viewerReview?.commitSha != null && viewerReview.commitSha !== currentHeadSha;

  return (
    <div
      className={styles.prHeader}
      data-testid="pr-header"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <div className={styles.prHeaderTop}>
        <div className="pr-meta col gap-1" id={metaId}>
          <div className="row gap-2 muted-2 pr-meta-repo">
            <PrStateGlyph state={glyphState} />
            <span>
              {reference.owner}/{reference.repo}
            </span>
            <span aria-hidden="true">·</span>
            <span>#{reference.number}</span>
          </div>
          <h1 className={styles.prTitle} data-testid="pr-title">
            {loading ? (
              <>
                {/* The skeleton is aria-hidden; without this the <h1> would be an
                    empty/unnamed heading in the a11y tree (an AT user navigating
                    by heading would land on a blank one). */}
                <span className="sr-only">Loading pull request…</span>
                <Skeleton width="60%" height={22} data-testid="pr-header-title-skeleton" />
              </>
            ) : (
              title
            )}
          </h1>
          {prState === 'merged' && mergedAt && (
            <span className={styles.statusMerged}>Merged {formatAge(mergedAt)}</span>
          )}
          {prState === 'closed' && closedAt && (
            <span className={styles.statusClosed}>Closed {formatAge(closedAt)}</span>
          )}
          <div className={`row gap-3 muted-2 ${styles.prSubtitle}`}>
            {/* While loading the author slot holds only aria-hidden skeletons;
                hide the whole span from AT so it isn't an empty nameless slot
                (the h1's sr-only "Loading pull request…" carries the signal). */}
            <span
              className={`pr-subtitle-author ${styles.subtitleAuthor}`}
              aria-hidden={loading || undefined}
            >
              {loading ? (
                <>
                  <Skeleton circle width={20} data-testid="pr-header-author-skeleton" />
                  <Skeleton width={110} height={12} />
                </>
              ) : (
                <>
                  <Avatar src={avatarUrl} login={author} size="sm" />
                  {author}
                </>
              )}
            </span>
            {loading && (
              <>
                <Skeleton width={90} height={18} radius={9} data-testid="pr-header-chip-skeleton" />
                <Skeleton width={60} height={18} radius={9} data-testid="pr-header-chip-skeleton" />
              </>
            )}
            {branchInfo && (
              <span className="pr-subtitle-branch">
                {branchInfo.headBranch} → {branchInfo.baseBranch}
              </span>
            )}
            {ciSummary && <span className={`chip chip-ci chip-ci-${ciSummary}`}>{ciSummary}</span>}
            {/* #593 — expanded readiness badge replaces the bare mergeability chip.
                ReadinessBadge returns null for none/merged/closed, so no guard needed.
                The `mergeability` prop (raw GitHub string) is kept for consumers that
                have not yet migrated to `mergeReadiness` (§9 legacy gate). */}
            {mergeReadiness && isBadgeRendered(mergeReadiness) && (
              <ReadinessBadge
                readiness={mergeReadiness}
                variant="expanded"
                id={`detail-readiness-${reference.owner}-${reference.repo}-${reference.number}`}
                approvals={approvals}
                changesRequested={changesRequested}
                updatedAt={updatedAt}
                approvers={approvers}
                changesRequestedBy={changesRequestedBy}
                awaitingReviewers={awaitingReviewers}
              />
            )}
            {iterationLabel && <span className="chip">{iterationLabel}</span>}
            {/* #501 — info Draft marker. Open drafts only; merged/closed win via glyphState.
                A "marker", not a pill/badge. Load-time only (ActivePrUpdated carries no draft).
                The chip-draft class is a collapse-keeplist hook (see Step 4a) — chip-info
                supplies the visuals, chip-draft carries no style of its own. */}
            {prState === 'open' && isDraft && (
              <span className="chip chip-info chip-draft">Draft</span>
            )}
          </div>
        </div>
        {/* No action buttons during cold load: nothing is clickable before the PR
            is loaded, and verdict/submit availability depends on merged-vs-open
            state we don't have yet — keep buttons out of the loading state as a
            rule rather than threading that logic through the skeleton. */}
        {!loading && (
          <div className={styles.prActions}>
            {onRefresh && (
              <RefreshButton
                isRefreshing={isRefreshing}
                justRefreshed={justRefreshed}
                onRefresh={onRefresh}
                label="Refresh PR"
                refreshingLabel="Refreshing PR…"
                title="Refresh PR"
                testId="pr-refresh-button"
                confirmTestId="pr-refresh-confirm"
              />
            )}
            <OpenInGitHubButton href={htmlUrl} />
            <ReviewActionButton
              session={session ?? EMPTY_SESSION}
              sessionLoaded={session !== null}
              prState={prState}
              headShaDrift={headShaDrift}
              validatorResults={validatorResults}
              inSubmitFlow={inSubmitFlow}
              dialogOpen={dialogOpen}
              viewerReview={viewerReview ?? null}
              submittedReviewStale={submittedReviewStale}
              onPatchVerdict={patchVerdict}
              onOpenSubmit={openDialog}
              onResume={onResume}
              onDiscardPending={() => {
                setPillDiscardError(null);
                setPillDiscardModalOpen(true);
              }}
              onDiscardAllDrafts={() => setDiscardAllModalOpen(true)}
            />
          </div>
        )}
      </div>
      <div className={styles.subTabRow}>
        <PrSubTabStrip
          activeTab={activeTab}
          onTabChange={onTabChange}
          fileCount={fileCount}
          hotspotsCount={hotspotsCount}
          draftsCount={draftsCount}
          showHotspots={showHotspots}
          aiMarkerState={hotspotsAiState ?? null}
          checksLead={checksLead}
          checksFailingCount={checksFailingCount}
          checksAriaLabel={checksAriaLabel}
        />
        {/* No collapse toggle during cold load — keep buttons out of the loading
            state (there's nothing to collapse yet). */}
        {!loading && (
          <button
            type="button"
            className={styles.collapseToggle}
            data-testid="pr-header-collapse-toggle"
            aria-expanded={!collapsed}
            aria-controls={metaId}
            aria-label={collapsed ? 'Expand PR details' : 'Collapse PR details'}
            title={collapsed ? 'Expand PR details' : 'Collapse PR details'}
            onClick={toggleCollapsed}
          >
            <CollapseChevron />
          </button>
        )}
      </div>
      {lastResume && (
        <ImportedDraftsBanner
          snapshotA={lastResume.snapshotA}
          snapshotB={lastResume.snapshotB}
          hasResolvedImports={lastResume.hasResolvedImports}
        />
      )}
      {dialogOpen && session && (
        <SubmitDialog
          open
          reference={reference}
          htmlUrl={htmlUrl}
          session={session}
          prState={prState}
          readOnly={readOnly}
          validatorResults={validatorResults}
          submitState={submitState}
          headShaDrift={headShaDrift}
          currentHeadSha={currentHeadSha}
          registerOpenComposer={registerOpenComposer}
          getPrRootHolder={getPrRootHolder}
          discardOwnPendingReview={discardOwnPendingReview}
          discardInFlight={discardInFlight}
          onDiscardSuccess={() => show({ kind: 'info', message: 'Pending review discarded' })}
          onClose={closeDialog}
          onSubmit={onSubmit}
          onRetry={onRetry}
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
          if (discardInFlight) return;
          setPillDiscardModalOpen(false);
          setPillDiscardError(null);
        }}
        onDiscard={() => void handlePillDiscard()}
        discardInFlight={discardInFlight}
        errorMessage={pillDiscardError}
      />
      {/* Discard-all confirmation modal — lifted from DiscardAllDraftsButton now
          that the menu item in ReviewActionButton drives the open state. Only the
          modal's onConfirm calls the real onDiscardAllDrafts; the menu handler
          only opens this modal (setDiscardAllModalOpen(true)). */}
      {session && prState !== 'open' && (
        <DiscardAllConfirmationModal
          open={discardAllModalOpen}
          prState={prState}
          // Inline threads only — exclude the PR-root summary (filePath null), which is
          // named separately via hasSummary, to avoid double-counting. (#324 — shared predicate.)
          threadCount={session.draftComments.filter((d) => !isPrRootDraft(d)).length}
          replyCount={session.draftReplies.length}
          hasSummary={prRootSummaryBody(session).length > 0}
          hasPendingReview={!!session.pendingReviewId}
          onConfirm={() => {
            setDiscardAllModalOpen(false);
            onDiscardAllDrafts();
          }}
          onCancel={() => setDiscardAllModalOpen(false)}
        />
      )}
    </div>
  );
}
