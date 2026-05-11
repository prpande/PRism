import { useMemo } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { PrReference } from '../../../api/types';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { usePreferences } from '../../../hooks/usePreferences';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useAiSummary } from '../../../hooks/useAiSummary';
import type { PrDetailOutletContext } from '../../../pages/PrDetailPage';
import { buildAllRange } from '../range';
import { AiSummaryCard } from './AiSummaryCard';
import { PrDescription } from './PrDescription';
import { StatsTiles } from './StatsTiles';
import { PrRootConversation, type PrRootConversationReplyContext } from './PrRootConversation';
import { ReviewFilesCta } from './ReviewFilesCta';

export function OverviewTab() {
  const { prDetail, draftSession, readOnly } = useOutletContext<PrDetailOutletContext>();
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  const navigate = useNavigate();
  const params = useParams<{ owner: string; repo: string; number: string }>();

  const prRef: PrReference = useMemo(
    () => ({ owner: params.owner!, repo: params.repo!, number: Number(params.number) }),
    [params.owner, params.repo, params.number],
  );

  const aiPreview = preferences?.aiPreview ?? false;
  const aiOn = !!capabilities?.summary && aiPreview;

  const diff = useFileDiff(prRef, buildAllRange(prDetail.pr));
  const aiSummary = useAiSummary(prRef, aiOn);

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

  const handleReviewFiles = () =>
    navigate(`/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/files`);

  // Hydrate `existingPrRootDraft` from the shared draft session so the
  // PR-root composer opens with the persisted body when one exists. PR-root
  // drafts are anchor-less (filePath / lineNumber / side / anchoredSha all
  // null) per spec § 5.6. There is at most one PR-root draft per PR.
  const existingPrRootDraft = useMemo(
    () => draftSession.session?.draftComments.find((d) => d.filePath === null) ?? null,
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
    <div className="overview-tab overview-grid">
      <AiSummaryCard summary={aiSummary} />
      <PrDescription title={prDetail.pr.title} body={prDetail.pr.body} aiPreview={aiPreview} />
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
