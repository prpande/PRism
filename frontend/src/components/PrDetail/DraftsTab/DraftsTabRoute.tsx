import { useMemo } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import type { PrReference } from '../../../api/types';
import type { PrDetailOutletContext } from '../../../pages/PrDetailPage';
import { DraftsTab } from './DraftsTab';

export function DraftsTabRoute() {
  const { draftSession } = useOutletContext<PrDetailOutletContext>();
  const params = useParams<{ owner: string; repo: string; number: string }>();
  const prRef: PrReference = useMemo(
    () => ({ owner: params.owner!, repo: params.repo!, number: Number(params.number) }),
    [params.owner, params.repo, params.number],
  );

  return (
    <DraftsTab
      prRef={prRef}
      session={draftSession.session}
      status={draftSession.status}
      refetch={draftSession.refetch}
    />
  );
}
