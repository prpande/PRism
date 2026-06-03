import { useMemo } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import type { PrReference } from '../../../api/types';
import type { PrDetailOutletContext } from '../../../pages/PrDetailPage';
import { DraftsTab } from './DraftsTab';

export function DraftsTabRoute() {
  const {
    draftSession,
    prDetail,
    readOnly: contextReadOnly,
  } = useOutletContext<PrDetailOutletContext>();
  const params = useParams<{ owner: string; repo: string; number: string }>();
  const prRef: PrReference = useMemo(
    () => ({ owner: params.owner!, repo: params.repo!, number: Number(params.number) }),
    [params.owner, params.repo, params.number],
  );

  const prState: 'open' | 'closed' | 'merged' = prDetail.pr.isMerged
    ? 'merged'
    : prDetail.pr.isClosed
      ? 'closed'
      : 'open';

  // Gate mutations when the PR is done (merged/closed) OR when a peer tab
  // owns the draft session (contextReadOnly). The cross-tab signal mirrors
  // FilesTab's own read-only logic — letting this tab Edit/Delete while a
  // peer owns the session would race the peer's in-flight mutations.
  const readOnly = prState !== 'open' || contextReadOnly;

  return (
    <DraftsTab
      prRef={prRef}
      session={draftSession.session}
      status={draftSession.status}
      refetch={draftSession.refetch}
      readOnly={readOnly}
    />
  );
}
