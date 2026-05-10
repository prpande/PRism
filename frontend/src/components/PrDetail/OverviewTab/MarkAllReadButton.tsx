import { useEffect, useRef, useState } from 'react';
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
  // In-flight guard so a double-click does not dispatch two concurrent
  // `markAllRead` patches. The handler is async and the button has no other
  // gate against re-entry while the first request is outstanding.
  const [pending, setPending] = useState(false);
  // Mount tracker: the user can navigate away from the Overview tab while a
  // slow markAllRead request is in flight. Without this guard, the finally
  // block calls setPending(false) on an unmounted component (React dev-mode
  // warning; harmless in production but noisy).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await sendPatch(prRef, { kind: 'markAllRead' });
      if (!result.ok) {
        // Surface in DevTools without yanking the user out of the page.
        // Per the PR5 [Decision] in the deferrals doc, an inline error UX is
        // deferred to S6 polish to mirror the InlineCommentComposer discard
        // failure UX deferral.
        console.warn('mark-all-read failed', result);
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const disabled = !ready || pending;

  // Native `disabled` already communicates state to assistive technology;
  // an additional `aria-disabled` would be redundant for buttons that are
  // taken out of the tab order via `disabled`. This is intentionally
  // different from the composer Save buttons, which use `aria-disabled`
  // *without* `disabled` so they remain focusable while signalling state
  // to screen readers (a deliberate PR4 pattern that preserves tooltip
  // hover and Enter-as-confirm semantics on the disabled state).
  return (
    <button
      type="button"
      className="mark-all-read-button"
      disabled={disabled}
      title={ready ? 'Mark all conversation comments read' : 'Loading…'}
      onClick={handleClick}
    >
      Mark all read
    </button>
  );
}
