import { usePrDetailContext } from '../prDetailContext';
import { DraftsTab } from './DraftsTab';

export function DraftsTabRoute() {
  const { prRef, prDetail, draftSession, readOnly: contextReadOnly } = usePrDetailContext();

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
