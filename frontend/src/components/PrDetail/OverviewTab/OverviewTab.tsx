import { useMemo } from 'react';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useAiSummary } from '../../../hooks/useAiSummary';
import { useAiGate } from '../../../hooks/useAiGate';
import { usePrDetailContext } from '../prDetailContext';
import { buildAllRange } from '../range';
import { AiSummaryCard } from './AiSummaryCard';
import { PrDescription } from './PrDescription';
import { StatsTiles } from './StatsTiles';
import { PrRootConversation, type PrRootConversationReplyContext } from './PrRootConversation';
import { ReviewFilesCta } from './ReviewFilesCta';
import { prRootDraft } from '../draftKinds';
import styles from './OverviewTab.module.css';

export function OverviewTab() {
  const { prRef, prDetail, draftSession, readOnly, onSelectSubTab, subscribed } =
    usePrDetailContext();
  const aiOn = useAiGate('summary');

  const diff = useFileDiff(prRef, buildAllRange(prDetail.pr));
  const {
    summary: aiSummary,
    loading: aiLoading,
    error: aiError,
  } = useAiSummary(prRef, aiOn, subscribed, /* baseShaChanged — threaded in Task 15 */ false);

  const filesCount = diff.data?.files.length ?? 0;
  const threadsCount = prDetail.reviewComments.length;
  const draftsCount =
    (draftSession.session?.draftComments.length ?? 0) +
    (draftSession.session?.draftReplies.length ?? 0);

  // hasFiles only goes false when the diff has loaded successfully AND
  // contains zero files (truly empty PR). During loading or on error,
  // keep the CTA enabled — the user proceeds to the Files tab where
  // skeleton/error UX lives. This avoids the "No files to review yet"
  // tooltip flashing during the load window or masking a fetch failure
  // as an empty-PR state.
  const hasFiles = !(diff.data !== null && diff.data.files.length === 0);

  const handleReviewFiles = () => onSelectSubTab('files');

  // Hydrate `existingPrRootDraft` from the shared draft session so the
  // PR-root composer opens with the persisted body when one exists. PR-root
  // drafts are anchor-less (filePath null is the discriminator) per spec § 5.6.
  // There is at most one PR-root draft per PR. (#324 — shared predicate.)
  const existingPrRootDraft = useMemo(
    () => prRootDraft(draftSession.session?.draftComments ?? []),
    [draftSession.session],
  );

  // `replyContext` is memoized so its reference is stable across renders.
  // PrRootConversationActions's `registerOpenComposer` useEffect
  // (and PrRootReplyComposer's mount-time effect) re-runs when its
  // dependency reference changes — without memoization, every parent
  // render would tear down and re-create the registry entry.
  const replyContext: PrRootConversationReplyContext = useMemo(
    () => ({
      prRef,
      prState: prDetail.pr.isMerged ? 'merged' : prDetail.pr.isClosed ? 'closed' : 'open',
      existingPrRootDraft,
      registerOpenComposer: draftSession.registerOpenComposer,
      onComposerClose: draftSession.refetch,
      readOnly,
    }),
    [
      prRef,
      prDetail.pr.isMerged,
      prDetail.pr.isClosed,
      existingPrRootDraft,
      draftSession.registerOpenComposer,
      draftSession.refetch,
      readOnly,
    ],
  );

  return (
    <div className={`${styles.overviewTab} ${styles.overviewGrid}`} data-testid="overview-tab">
      <AiSummaryCard summary={aiSummary} loading={aiLoading} error={aiError} />
      <PrDescription title={prDetail.pr.title} body={prDetail.pr.body} aiPreview={aiOn} />
      <StatsTiles
        filesCount={filesCount}
        draftsCount={draftsCount}
        threadsCount={threadsCount}
        viewedCount={0}
      />
      <PrRootConversation comments={prDetail.rootComments} replyContext={replyContext} />
      <ReviewFilesCta hasFiles={hasFiles} onReviewFiles={handleReviewFiles} />
    </div>
  );
}
