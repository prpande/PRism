import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrossTabPrPresence } from '../src/hooks/useCrossTabPrPresence';
import { __resetTabIdForTest } from '../src/api/draft';
import type { PrReference } from '../src/api/types';

// Mounts a fresh hook with a distinct tab id (simulates a separate browser
// tab). Each call resets the module-level _tabId so the next getTabId()
// inside the hook returns a fresh UUID; the hook captures that value into
// a per-mount ref, so the rest of the module-level state cannot disturb
// this instance's identity.
function mountTab(prRef: PrReference | null) {
  __resetTabIdForTest();
  return renderHook(() => useCrossTabPrPresence(prRef));
}

// ---------------------------------------------------------------------------
// In-memory BroadcastChannel shim. jsdom 29 does not implement BroadcastChannel
// (Node provides it globally, but the jsdom window does not expose it). The
// shim keeps tests deterministic — messages dispatch synchronously inside the
// post call, which removes the need for waitFor + act dances around an async
// channel queue.
// ---------------------------------------------------------------------------

interface Listener {
  (ev: MessageEvent): void;
}

class FakeBroadcastChannel {
  static instances = new Map<string, Set<FakeBroadcastChannel>>();
  readonly name: string;
  private listeners = new Set<Listener>();
  private onmessageListener: Listener | null = null;
  private closed = false;

  constructor(name: string) {
    this.name = name;
    if (!FakeBroadcastChannel.instances.has(name))
      FakeBroadcastChannel.instances.set(name, new Set());
    FakeBroadcastChannel.instances.get(name)!.add(this);
  }

  set onmessage(fn: Listener | null) {
    this.onmessageListener = fn;
  }

  addEventListener(type: 'message', fn: Listener) {
    if (type !== 'message') return;
    this.listeners.add(fn);
  }

  removeEventListener(type: 'message', fn: Listener) {
    if (type !== 'message') return;
    this.listeners.delete(fn);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new Error('channel closed');
    const peers = FakeBroadcastChannel.instances.get(this.name);
    if (!peers) return;
    // Synchronous dispatch — see file-header note.
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      const ev = { data } as MessageEvent;
      if (peer.onmessageListener) peer.onmessageListener(ev);
      for (const l of peer.listeners) l(ev);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const peers = FakeBroadcastChannel.instances.get(this.name);
    if (peers) peers.delete(this);
    this.listeners.clear();
    this.onmessageListener = null;
  }

  static reset() {
    for (const set of FakeBroadcastChannel.instances.values()) {
      for (const ch of set) ch.closed = true;
    }
    FakeBroadcastChannel.instances.clear();
  }
}

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  sessionStorage.clear();
});

afterEach(() => {
  FakeBroadcastChannel.reset();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('useCrossTabPrPresence', () => {
  it('OpenSamePrInTwoTabs_BothTabsShowBanner', () => {
    const tabA = mountTab(ref);
    // Tab A mounted, posted open. No peer yet.
    expect(tabA.result.current.showBanner).toBe(false);

    const tabB = mountTab(ref);
    // Tab B mounts, posts open. A receives → shows banner. B receives
    // a follow-up 'present' from A → shows banner.

    expect(tabA.result.current.showBanner).toBe(true);
    expect(tabB.result.current.showBanner).toBe(true);
    expect(tabA.result.current.readOnly).toBe(false);
    expect(tabB.result.current.readOnly).toBe(false);

    tabA.unmount();
    tabB.unmount();
  });

  it('TakeOver_TransitionsOtherTabToReadOnly', () => {
    const tabA = mountTab(ref);
    const tabB = mountTab(ref);
    expect(tabA.result.current.showBanner).toBe(true);
    expect(tabB.result.current.showBanner).toBe(true);

    act(() => tabA.result.current.takeOver());

    // Claiming tab: banner clears, readOnly stays false.
    expect(tabA.result.current.showBanner).toBe(false);
    expect(tabA.result.current.readOnly).toBe(false);
    // Yielded tab: banner clears, readOnly flips true.
    expect(tabB.result.current.readOnly).toBe(true);
    expect(tabB.result.current.showBanner).toBe(false);

    tabA.unmount();
    tabB.unmount();
  });

  it('BannerDismissForSession_PersistsToSessionStorage_NoReshow', () => {
    const tabA = mountTab(ref);
    const tabB = mountTab(ref);
    expect(tabA.result.current.showBanner).toBe(true);

    act(() => tabA.result.current.dismissForSession());
    expect(tabA.result.current.showBanner).toBe(false);
    expect(
      sessionStorage.getItem(`prism:pr-presence-dismissed:${ref.owner}/${ref.repo}/${ref.number}`),
    ).toBe('true');

    tabA.unmount();
    tabB.unmount();

    // Re-mount tab A in the same session; the dismiss flag is still in
    // sessionStorage, so the banner stays suppressed even when a new peer
    // (tab C) joins. (In real browsers sessionStorage is per-tab; in jsdom
    // it is a single instance, so we only assert the same-tab no-reshow
    // case here. The real-browser per-tab semantics are exercised by the
    // Playwright multi-tab spec in Task 48.)
    const tabAAgain = mountTab(ref);
    const tabC = mountTab(ref);
    expect(tabAAgain.result.current.showBanner).toBe(false);

    tabAAgain.unmount();
    tabC.unmount();
  });

  it('RequestFocus_BringsOtherTabToFront', () => {
    const focusSpy = vi.fn();
    const originalFocus = window.focus;
    Object.defineProperty(window, 'focus', { configurable: true, value: focusSpy });

    try {
      const tabA = mountTab(ref);
      const tabB = mountTab(ref);

      // Both mounted; banners visible. Tab A asks to switch to the other.
      act(() => tabA.result.current.switchToOther());

      // Tab B (the "other") receives request-focus and calls window.focus().
      // jsdom has a single window object shared across both renderHook
      // calls; the spy fires once — for B — because BroadcastChannel does
      // not echo a message back to the sender.
      expect(focusSpy).toHaveBeenCalledTimes(1);

      tabA.unmount();
      tabB.unmount();
    } finally {
      Object.defineProperty(window, 'focus', { configurable: true, value: originalFocus });
    }
  });

  it('passing null prRef is inert (no channel, no banner)', () => {
    const { result } = mountTab(null);
    expect(result.current.showBanner).toBe(false);
    expect(result.current.readOnly).toBe(false);
    // The mutators are still callable but no-op.
    expect(() => result.current.switchToOther()).not.toThrow();
    expect(() => result.current.takeOver()).not.toThrow();
    expect(() => result.current.dismissForSession()).not.toThrow();
  });
});
