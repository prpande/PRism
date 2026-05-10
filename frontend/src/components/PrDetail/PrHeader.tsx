import type { PrReference } from '../../api/types';
import { PrSubTabStrip, type PrTabId } from './PrSubTabStrip';

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
}: PrHeaderProps) {
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
          <button
            type="button"
            className="btn btn-secondary"
            disabled
            aria-disabled="true"
            title="Verdict picker arrives in S4"
          >
            Verdict
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled
            aria-disabled="true"
            title="Submit arrives in S4 with the comment composer"
          >
            Submit review
          </button>
        </div>
      </div>
      <PrSubTabStrip
        activeTab={activeTab}
        onTabChange={onTabChange}
        fileCount={fileCount}
        draftsCount={draftsCount}
      />
    </div>
  );
}
