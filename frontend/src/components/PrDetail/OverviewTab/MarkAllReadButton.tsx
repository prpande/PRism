import { useFirstActivePrPollComplete } from '../../../hooks/useFirstActivePrPollComplete';
import { sendPatch } from '../../../api/draft';
import type { PrReference } from '../../../api/types';

// Caveat for future maintainers: in the current PoC, the backend
// `markAllRead` patch resolves to `PatchOutcome.NoOp` until
// `IActivePrCache.HighestIssueCommentId` is populated by `ActivePrPoller`
// (deferred — see deferrals doc § "[Defer] IActivePrCache.HighestIssueCommentId
// populated by ActivePrPoller"). The button will appear functional and the
// `state-changed` SSE event still fires (advancing the inbox-badge through
// PR4's `useStateChangedSubscriber`), but the persisted cursor will not move
// in dogfooding. Don't chase a phantom no-op bug here.
export interface MarkAllReadButtonProps {
  prRef: PrReference;
}

export function MarkAllReadButton({ prRef }: MarkAllReadButtonProps) {
  const ready = useFirstActivePrPollComplete(prRef);

  const handleClick = async () => {
    const result = await sendPatch(prRef, { kind: 'markAllRead' });
    if (!result.ok) {
      // Surface in DevTools without yanking the user out of the page.
      // Per the PR5 [Decision] in the deferrals doc, an inline error UX is
      // deferred to S6 polish to mirror the InlineCommentComposer discard
      // failure UX deferral.
      console.warn('mark-all-read failed', result);
    }
  };

  return (
    <button
      type="button"
      className="mark-all-read-button"
      disabled={!ready}
      aria-disabled={!ready}
      title={ready ? 'Mark all conversation comments read' : 'Loading…'}
      onClick={handleClick}
    >
      Mark all read
    </button>
  );
}
