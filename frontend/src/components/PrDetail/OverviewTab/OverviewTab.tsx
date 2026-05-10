import { useMemo } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { PrDetailDto, PrReference } from '../../../api/types';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { usePreferences } from '../../../hooks/usePreferences';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useAiSummary } from '../../../hooks/useAiSummary';
import { buildAllRange } from '../range';
import { AiSummaryCard } from './AiSummaryCard';
import { PrDescription } from './PrDescription';
import { StatsTiles } from './StatsTiles';
import { PrRootConversation, type PrRootConversationReplyContext } from './PrRootConversation';
import { ReviewFilesCta } from './ReviewFilesCta';

interface OverviewTabContext {
  prDetail: PrDetailDto;
}

export function OverviewTab() {
  const { prDetail } = useOutletContext<OverviewTabContext>();
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

  // hasFiles only goes false when the diff has loaded successfully AND
  // contains zero files (truly empty PR). During loading or on error,
  // keep the CTA enabled — the user proceeds to the Files tab where
  // skeleton/error UX lives. This avoids the "No files to review yet"
  // tooltip flashing during the load window or masking a fetch failure
  // as an empty-PR state.
  const hasFiles = !(diff.data !== null && diff.data.files.length === 0);

  const handleReviewFiles = () =>
    navigate(`/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/files`);

  // PR5 PoC scope: OverviewTab does not own a `useDraftSession` instance —
  // the PR-root composer always opens empty and the user finds existing
  // PR-root drafts via the Drafts tab (PR6 wiring). On close we pass a
  // no-op refetch; the composer's own auto-save/discard already round-trips
  // through `sendPatch`. `registerOpenComposer` is a no-op for the same
  // reason (no parallel session merge could clobber this composer's body).
  // TODO(s4-pr6): hydrate `existingPrRootDraft` from
  // `useDraftSession.session.draftComments.find(d => d.filePath === null)`
  // once OverviewTab gains a session instance, and replace the no-op
  // `registerOpenComposer` / `onComposerClose` with the live ones.
  //
  // `replyContext` is memoized so its reference is stable across renders.
  // PrRootConversationActions's `registerOpenComposer` useEffect
  // (and PrRootReplyComposer's mount-time effect) re-runs when its
  // dependency reference changes — without memoization, every parent
  // render would tear down and re-create the registry entry.
  const replyContext: PrRootConversationReplyContext = useMemo(
    () => ({
      prRef,
      prState: prDetail.pr.isMerged ? 'merged' : prDetail.pr.isClosed ? 'closed' : 'open',
      existingPrRootDraft: null,
      registerOpenComposer: () => () => undefined,
      onComposerClose: () => undefined,
    }),
    [prRef, prDetail.pr.isMerged, prDetail.pr.isClosed],
  );

  return (
    <div className="overview-tab overview-grid">
      <AiSummaryCard summary={aiSummary} />
      <PrDescription title={prDetail.pr.title} body={prDetail.pr.body} aiPreview={aiPreview} />
      <StatsTiles
        filesCount={filesCount}
        draftsCount={0}
        threadsCount={threadsCount}
        viewedCount={0}
      />
      <PrRootConversation comments={prDetail.rootComments} replyContext={replyContext} />
      <ReviewFilesCta hasFiles={hasFiles} onReviewFiles={handleReviewFiles} />
    </div>
  );
}
