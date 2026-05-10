import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PrHeader } from '../components/PrDetail/PrHeader';
import { BannerRefresh } from '../components/PrDetail/BannerRefresh';
import { UnresolvedPanel } from '../components/PrDetail/Reconciliation/UnresolvedPanel';
import type { PrTabId } from '../components/PrDetail/PrSubTabStrip';
import { usePrDetail } from '../hooks/usePrDetail';
import { useActivePrUpdates } from '../hooks/useActivePrUpdates';
import { useDraftSession, type UseDraftSessionResult } from '../hooks/useDraftSession';
import { useStateChangedSubscriber } from '../hooks/useStateChangedSubscriber';
import type { PrDetailDto, PrReference } from '../api/types';

// Single source of truth for the per-PR draft session is the PrDetailPage.
// Tabs read it via Outlet context; the sticky-top UnresolvedPanel + tab-strip
// drafts count read it directly. Hoisted from FilesTab in S4 PR6 so the
// shared in-memory composer-open registry (refcounted in `useDraftSession`)
// is one instance, not one-per-tab. See deferrals doc § "Session ownership
// hoisted to PrDetailPage".
export interface PrDetailOutletContext {
  prDetail: PrDetailDto;
  draftSession: UseDraftSessionResult;
}

export function PrDetailPage() {
  const {
    owner,
    repo,
    number: numberStr,
  } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();

  if (!owner || !repo || !numberStr) {
    return <div role="alert">Invalid PR reference.</div>;
  }
  const number = Number(numberStr);
  if (Number.isNaN(number)) {
    return <div role="alert">Invalid PR reference: number must be an integer.</div>;
  }

  const ref: PrReference = { owner, repo, number };
  // basePath uses the raw route segment so tabFromPath() matches against the
  // user's actual pathname (a leading-zero or whitespace-equivalent value
  // like /pr/o/r/042 must not be normalized to /pr/o/r/42, which would break
  // tab selection and rewrite the URL on tab clicks). The numeric `number` is
  // only for API calls.
  const basePath = `/pr/${owner}/${repo}/${numberStr}`;
  const activeTab = tabFromPath(location.pathname, basePath);

  return (
    <PrDetailPageInner ref={ref} basePath={basePath} activeTab={activeTab} navigate={navigate} />
  );
}

function PrDetailPageInner({
  ref,
  basePath,
  activeTab,
  navigate,
}: {
  ref: PrReference;
  basePath: string;
  activeTab: PrTabId;
  navigate: (path: string) => void;
}) {
  const { data, showSkeleton, error, reload } = usePrDetail(ref);
  const updates = useActivePrUpdates(ref);
  const draftSession = useDraftSession(ref);
  // Refetch draft session when other tabs / the reload pipeline mutate
  // drafts. Own-tab events are filtered by the subscriber per spec § 5.7.
  useStateChangedSubscriber({ prRef: ref, onSessionChange: draftSession.refetch });

  const handleTabChange = (tab: PrTabId) => {
    if (tab === 'overview') navigate(basePath);
    else if (tab === 'files') navigate(`${basePath}/files`);
    else if (tab === 'drafts') navigate(`${basePath}/drafts`);
  };

  const handleReload = () => {
    updates.clear();
    reload();
  };

  const currentIter = data?.iterations?.at(-1)?.number ?? 0;
  const draftsCount =
    (draftSession.session?.draftComments.length ?? 0) +
    (draftSession.session?.draftReplies.length ?? 0);

  return (
    <div className="pr-detail-page">
      <PrHeader
        reference={ref}
        title={data?.pr.title ?? ''}
        author={data?.pr.author ?? ''}
        branchInfo={
          data ? { headBranch: data.pr.headBranch, baseBranch: data.pr.baseBranch } : undefined
        }
        mergeability={data?.pr.mergeability}
        ciSummary={data?.pr.ciSummary}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        draftsCount={draftsCount}
      />
      <BannerRefresh
        hasUpdate={updates.hasUpdate}
        headShaChanged={updates.headShaChanged}
        commentCountDelta={updates.commentCountDelta}
        currentIterationNumber={currentIter}
        onReload={handleReload}
        onDismiss={updates.clear}
      />
      <UnresolvedPanel prRef={ref} session={draftSession.session} />
      {error && (
        <div role="alert" className="pr-detail-error">
          Couldn't load PR — {error.message}
        </div>
      )}
      {showSkeleton ? (
        <PrDetailSkeleton />
      ) : data ? (
        <Outlet context={{ prDetail: data, draftSession } satisfies PrDetailOutletContext} />
      ) : null}
    </div>
  );
}

function tabFromPath(pathname: string, basePath: string): PrTabId {
  const sub = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : '';
  // Match exact segment or trailing-slash form so lookalike paths like
  // /files-extra don't desync the tab strip from what the nested router
  // actually renders.
  if (sub === '/files' || sub.startsWith('/files/')) return 'files';
  if (sub === '/drafts' || sub.startsWith('/drafts/')) return 'drafts';
  return 'overview';
}

function PrDetailSkeleton() {
  return (
    <div className="pr-detail-skeleton" aria-busy="true" aria-live="polite">
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row skeleton-row-tall" />
    </div>
  );
}
