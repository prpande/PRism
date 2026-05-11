import { useCallback, useEffect, useRef, useState } from 'react';
import { getTabId } from '../api/draft';
import type { PrReference } from '../api/types';

// Spec § 5.7a. BroadcastChannel-based "another tab has this PR open" banner.
// Frontend-only mechanism — backend has no knowledge of tab identity. The
// banner surfaces the risk and offers a one-click resolution; it does NOT
// prevent two tabs writing concurrently if the user dismisses or ignores it.
// Conflict-detection UI proper (P4-F9) remains v2.

type PresenceMessage =
  | { kind: 'open'; tabId: string }
  // Sent in response to receiving an 'open' from a peer; this is how a tab
  // that mounted FIRST learns about a tab that mounted LATER beyond the
  // single race window where both posts happen to be in-flight together.
  // Without it, a tab mounted long before its peer would never surface the
  // banner. Suffixed with the responder's tabId so loops are impossible
  // ('present' does not trigger another 'present').
  | { kind: 'present'; tabId: string }
  | { kind: 'request-focus' }
  | { kind: 'claim'; tabId: string };

export interface UseCrossTabPrPresenceResult {
  showBanner: boolean;
  readOnly: boolean;
  // Asks the other tab(s) to focus themselves (request-focus). Each peer
  // listens for the message and calls window.focus().
  switchToOther: () => void;
  // Asserts ownership: this tab keeps composing; the other tab switches to
  // read-only. Clears this tab's banner as a side effect.
  takeOver: () => void;
  // Persists "don't surface the banner again for this PR this session" via
  // sessionStorage. Clears the banner immediately.
  dismissForSession: () => void;
}

function channelName(prRef: PrReference): string {
  return `prism:pr-presence:${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

function dismissKey(prRef: PrReference): string {
  return `prism:pr-presence-dismissed:${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

export function useCrossTabPrPresence(prRef: PrReference | null): UseCrossTabPrPresenceResult {
  // Capture tab identity once per mount so the value stays stable even if
  // module-level state (the `getTabId()` cache) is reset between hook
  // instances in tests. In production this matches the cross-tab identity
  // already used by `useStateChangedSubscriber` (each browser tab has its
  // own JS context → its own _tabId).
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) tabIdRef.current = getTabId();
  const tabId = tabIdRef.current;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const dismissedRef = useRef(false);
  // True between `takeOver()` posting its 'claim' and the resulting state
  // updates. Guards against the simultaneous-claim deadlock where both tabs
  // call takeOver "at once": each tab's incoming claim from the peer would
  // otherwise flip the local tab to read-only, leaving BOTH tabs unable to
  // edit and the user with no in-page recovery. With the ref set, an
  // incoming claim is dropped — the claiming tab insists it kept ownership.
  // (If two tabs really do claim simultaneously, the resulting state is
  // "both tabs editable; banner clears" — a soft glass-jaw, not a deadlock.)
  const claimingRef = useRef(false);
  const [showBanner, setShowBanner] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (!prRef) return;
    setShowBanner(false);
    setReadOnly(false);

    // Read sessionStorage dismiss flag. The flag is per-(prRef, session) —
    // closing the tab clears sessionStorage; a fresh launch sees no flag.
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(dismissKey(prRef)) === 'true';
    } catch {
      // sessionStorage can throw under strict CSP / Safari privacy modes;
      // fall back to in-memory only.
    }
    dismissedRef.current = dismissed;

    const ch = new BroadcastChannel(channelName(prRef));
    channelRef.current = ch;

    const handle = (ev: MessageEvent) => {
      const msg = ev.data as PresenceMessage | undefined;
      if (!msg || typeof msg !== 'object' || !('kind' in msg)) return;
      switch (msg.kind) {
        case 'open':
          if (msg.tabId === tabId) return; // own echo guard (BC suppresses, defensive)
          // Late-joiner sequence: tell them we're here so they also surface
          // the banner. 'present' does not trigger further responses.
          ch.postMessage({ kind: 'present', tabId } satisfies PresenceMessage);
          if (!dismissedRef.current) setShowBanner(true);
          break;
        case 'present':
          if (msg.tabId === tabId) return;
          if (!dismissedRef.current) setShowBanner(true);
          break;
        case 'request-focus':
          // Bring this tab to the foreground. window.focus() is a no-op in
          // many browsers when called from a non-user-gesture context, but
          // a focused EventTarget gets the OS attention hint via the tab
          // strip's "this tab wants attention" affordance — best-effort.
          window.focus();
          break;
        case 'claim':
          if (msg.tabId === tabId) return;
          if (claimingRef.current) return; // simultaneous-claim guard, see claimingRef comment above
          setReadOnly(true);
          setShowBanner(false);
          break;
      }
    };

    ch.addEventListener('message', handle);
    ch.postMessage({ kind: 'open', tabId } satisfies PresenceMessage);

    return () => {
      ch.removeEventListener('message', handle);
      ch.close();
      channelRef.current = null;
    };
  }, [prRef?.owner, prRef?.repo, prRef?.number, tabId]);

  const switchToOther = useCallback(() => {
    channelRef.current?.postMessage({ kind: 'request-focus' } satisfies PresenceMessage);
  }, []);

  const takeOver = useCallback(() => {
    // Set the guard BEFORE posting so the symmetric simultaneous-claim case
    // sees claimingRef=true on this side when the peer's claim arrives.
    claimingRef.current = true;
    channelRef.current?.postMessage({ kind: 'claim', tabId } satisfies PresenceMessage);
    setShowBanner(false);
    // Release the guard after a 50ms safety window. The browser does not
    // guarantee ordering between a `setTimeout(0)` macrotask and a queued
    // BroadcastChannel `message` macrotask, so a 0ms timer can race ahead
    // of the peer claim's dispatch in some engines, dropping the guard
    // and leaving both tabs read-only. 50ms is far longer than any
    // realistic BroadcastChannel propagation window (typically sub-ms
    // same-origin) and short enough that a user clicking Take-over twice
    // by accident still works as expected.
    setTimeout(() => {
      claimingRef.current = false;
    }, 50);
  }, [tabId]);

  const dismissForSession = useCallback(() => {
    if (!prRef) return;
    try {
      sessionStorage.setItem(dismissKey(prRef), 'true');
    } catch {
      // Same fallback as the read path — in-memory only.
    }
    dismissedRef.current = true;
    setShowBanner(false);
  }, [prRef?.owner, prRef?.repo, prRef?.number]);

  return { showBanner, readOnly, switchToOther, takeOver, dismissForSession };
}
