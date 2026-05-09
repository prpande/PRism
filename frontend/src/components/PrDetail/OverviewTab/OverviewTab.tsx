import { useMemo } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { PrDetailDto, PrReference } from '../../../api/types';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { usePreferences } from '../../../hooks/usePreferences';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useAiSummary } from '../../../hooks/useAiSummary';
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

  const allRange = `${prDetail.pr.baseSha}..${prDetail.pr.headSha}`;
  const diff = useFileDiff(prRef, allRange);
  const aiSummary = useAiSummary(prRef, aiOn);

  const filesCount = diff.data?.files.length ?? 0;
  const threadsCount = prDetail.reviewComments.length;

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
      <ReviewFilesCta hasFiles={filesCount > 0} onReviewFiles={handleReviewFiles} />
    </div>
  );
}
