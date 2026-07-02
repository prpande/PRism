import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { MergeReadiness, PrReference, Reviewer } from '../api/types';
import { snapshot } from '../utils/snapshotMerge';
import { useEventSource } from './useEventSource';

export interface ActivePrUpdates {
  hasUpdate: boolean;
  headShaChanged: boolean;
  baseShaChanged: boolean;
  commentCountDelta: number;
  isMerged: boolean;
  isClosed: boolean;
  // true only after the first subscribe POST settles; gates AI fetches that
  // must not fire before the SSE subscription is established (D111 204 guard).
  subscribed: boolean;
  // populated by Task 7 (SSE); undefined until then → the ?? fallback uses the full-load value
  mergeReadiness?: MergeReadiness;
  // #593 — live readiness popover data (counts + reviewer names). undefined until the first
  // pr-updated event; consumers ?? back to the full-load value. Snapshot semantics (assigned from
  // each event, not accumulated), so a later tick can correct or clear them.
  approvals?: number | null;
  changesRequested?: number | null;
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
  // #620 — monotonically-increasing counter bumped on EVERY pr-updated frame for this PR (not
  // gated on mergeReadinessChanged or any other field). Surfaced through prDetailContext so
  // ActivityFeed's useTimelineFeed can live-refresh on a bare approval, review-request, or root
  // comment — frames that carry mergeReadinessChanged=false and would otherwise never be observed.
  prUpdatedSignal: number;
  clear(): void;
}

const initial = {
  hasUpdate: false,
  headShaChanged: false,
  baseShaChanged: false,
  commentCountDelta: 0,
  isMerged: false,
  isClosed: false,
  // #598 Slice B — latest live readiness. undefined until the first pr-updated event with
  // mergeReadinessChanged arrives; the ?? fallback in consumers uses the full-load value until then.
  mergeReadiness: undefined as MergeReadiness | undefined,
  // #593 — latest live popover data (snapshot from each event).
  approvals: undefined as number | null | undefined,
  changesRequested: undefined as number | null | undefined,
  approvers: undefined as Reviewer[] | null | undefined,
  changesRequestedBy: undefined as Reviewer[] | null | undefined,
  awaitingReviewers: undefined as Reviewer[] | null | undefined,
};

export function useActivePrUpdates(prRef: PrReference): ActivePrUpdates {
  const stream = useEventSource();
  const [state, setState] = useState(initial);
  const [subscribed, setSubscribed] = useState(false);
  // #620 — bumped once per pr-updated frame, regardless of what changed. See the
  // ActivePrUpdates.prUpdatedSignal doc comment for why this must NOT gate on
  // mergeReadinessChanged.
  const [prUpdatedSignal, setPrUpdatedSignal] = useState(0);
  const refStr = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  useEffect(() => {
    if (!stream) return;
    // Reset aggregated state when prRef changes so banners don't leak across
    // PR navigations. useState(initial) only fires on first mount; without
    // this, navigating from PR A (with hasUpdate=true) to PR B inherits A's
    // banner until a new event arrives or clear() is called.
    setState(initial);
    // Reset subscription gate so AI fetches don't fire stale on the new ref.
    setSubscribed(false);
    let cancelled = false;
    // Most recent in-flight subscribe POST, so cleanup can chain the DELETE
    // behind it and the server never sees DELETE→POST (which would leave a
    // dangling subscription, #142). Resolved-init = a pre-handshake unmount
    // cleans up immediately (no POST issued, so the DELETE is a server no-op).
    let lastSubscribePost: Promise<unknown> = Promise.resolve();

    const unsubscribe = stream.on('pr-updated', (event) => {
      if (event.prRef !== refStr) return;
      // #620 — bump on EVERY frame for this PR, before any field-specific gating below.
      // Do NOT move this inside a mergeReadinessChanged branch: a bare approval, a
      // review-request, or a root comment all carry mergeReadinessChanged=false and would
      // never bump the signal, silently defeating ActivityFeed's live-refresh.
      setPrUpdatedSignal((n) => n + 1);
      setState((s) => ({
        hasUpdate: true,
        headShaChanged: s.headShaChanged || event.headShaChanged,
        baseShaChanged: s.baseShaChanged || event.baseShaChanged,
        commentCountDelta: s.commentCountDelta + event.commentCountDelta,
        // Latched (once done, stays done). Backend guarantees isMerged/isClosed are
        // mutually exclusive per Task 15a; if both ever arrive, PrDetailPage prioritizes merged.
        isMerged: s.isMerged || event.isMerged,
        isClosed: s.isClosed || event.isClosed,
        // Latch on mergeReadinessChanged: the backend sets that flag only on a change TO a real
        // (non-none) readiness (anti-flicker None guard), so we keep the last meaningful value and
        // ignore transient None ticks that carry mergeReadinessChanged=false.
        mergeReadiness: event.mergeReadinessChanged ? event.mergeReadiness : s.mergeReadiness,
        // #593 — popover data is a snapshot of the current poll: take the event's value whenever it
        // carries the field (incl. an explicit null that clears a now-empty category), else keep the
        // last value. No anti-flicker latch (these aren't subject to the transient-None recompute
        // that gates mergeReadiness). See `snapshot` for why this is `!== undefined`, not `??`.
        approvals: snapshot(event.approvals, s.approvals),
        changesRequested: snapshot(event.changesRequested, s.changesRequested),
        approvers: snapshot(event.approvers, s.approvers),
        changesRequestedBy: snapshot(event.changesRequestedBy, s.changesRequestedBy),
        awaitingReviewers: snapshot(event.awaitingReviewers, s.awaitingReviewers),
      }));
    });

    // Re-subscribes on every reconnect per spec § 7.4: the loop awaits the next
    // handshake, POSTs the subscription, then sleeps until the current
    // reconnect-signal aborts (watchdog stall or onerror-via-ping path).
    async function subscribeLoop() {
      while (!cancelled && stream) {
        try {
          await stream.subscriberId();
          if (cancelled) return;
          // Capture the POST promise synchronously (no await between the
          // cancelled-check and this assignment) so the cleanup closure always
          // sees the live POST it must order the DELETE behind.
          lastSubscribePost = apiClient.post('/api/events/subscriptions', { prRef: refStr });
          await lastSubscribePost;
          if (!cancelled) setSubscribed(true);
        } catch {
          // Subscribe failure is non-fatal: cookie-keyed routing on the server still
          // delivers events. Silent — no observable impact in PoC scope.
        }

        const signal = stream.reconnectSignal();
        if (signal.aborted) continue;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }
    void subscribeLoop();

    return () => {
      cancelled = true;
      unsubscribe();
      // Order-guard (#142): chain the DELETE after the in-flight subscribe POST
      // settles so the server always observes POST→DELETE, never DELETE→POST.
      // A failed POST registered nothing, but we still issue the (idempotent)
      // DELETE to keep one cleanup path.
      void lastSubscribePost
        .catch(() => {
          // Swallow the POST rejection here; the DELETE below runs regardless.
        })
        .then(() =>
          apiClient.delete(`/api/events/subscriptions?prRef=${encodeURIComponent(refStr)}`),
        )
        .catch(() => {
          // Idempotent on the server; failure means nothing to clean up.
        });
    };
  }, [stream, refStr]);

  // #671 — stable identity so consumers that list `clear` in a memo dep array can
  // actually bail out. Concretely: PrDetailView passes it as usePrDetailRefresh's
  // `clearUpdates`, which sits in that hook's `refresh` useCallback deps — a fresh
  // `clear` per render was re-creating `refresh` on every render. setState's own
  // identity is stable and `initial` is a module constant, so the empty dep is correct.
  const clear = useCallback(() => setState(initial), []);

  return { ...state, subscribed, prUpdatedSignal, clear };
}
