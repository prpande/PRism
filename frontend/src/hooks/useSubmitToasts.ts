import { useEffect, useRef } from 'react';
import { useEventSource } from './useEventSource';
import type { PrReference } from '../api/types';

interface Options {
  showToast(message: string): void;
}

function prRefString(reference: PrReference): string {
  return `${reference.owner}/${reference.repo}/${reference.number}`;
}

// Cross-cutting submit notifications that aren't dialog-state transitions
// (spec § 11.4 / § 13.2):
//   - submit-duplicate-marker-detected — the pipeline found >1 server thread
//     carrying the same PRism client-id marker; it kept the earliest and
//     deleted the rest. The user sees which draft it was so a surprise
//     reconciliation isn't silent.
//   - submit-orphan-cleanup-failed — a closed/merged-PR bulk discard cleared
//     local state but the best-effort github.com pending-review delete failed;
//     it'll be retried on the next successful submit.
// Both are prRef-scoped on the wire but the SSE channel fans out per-PR (broader
// than spec), so a tab for a different PR ignores them.
export function useSubmitToasts(reference: PrReference, { showToast }: Options): void {
  const stream = useEventSource();
  const prRef = prRefString(reference);
  // Hold the latest callback in a ref so a fresh `showToast` closure each render
  // doesn't churn the subscriptions.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    if (!stream) return;
    const offs = [
      stream.on('submit-duplicate-marker-detected', (ev) => {
        if (ev.prRef !== prRef) return;
        showToastRef.current(
          `Duplicate PRism marker detected for draft ${ev.draftId}; PRism kept the earliest server thread and cleaned up the duplicates.`,
        );
      }),
      stream.on('submit-orphan-cleanup-failed', (ev) => {
        if (ev.prRef !== prRef) return;
        showToastRef.current(
          'Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR.',
        );
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [stream, prRef]);
}
