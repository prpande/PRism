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
import { PrRootConversation } from './PrRootConversation';
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
      <PrRootConversation comments={prDetail.rootComments} />
      <ReviewFilesCta hasFiles={hasFiles} onReviewFiles={handleReviewFiles} />
    </div>
  );
}
