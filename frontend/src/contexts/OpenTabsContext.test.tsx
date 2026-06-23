import { describe, it, expect } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OpenTabsProvider, useOpenTabs } from './OpenTabsContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <OpenTabsProvider>{children}</OpenTabsProvider>
);

describe('OpenTabsContext', () => {
  it('starts with empty tabs and no unread', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('addTab appends and is idempotent on prRefKey', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const ref = { owner: 'acme', repo: 'api', number: 123 };
    act(() => result.current.addTab(ref, 'Initial title'));
    act(() => result.current.addTab(ref, 'Updated title'));
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].title).toBe('Initial title');
  });

  it('setTitle updates an existing tab without changing order', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    const b = { owner: 'acme', repo: 'api', number: 2 };
    act(() => {
      result.current.addTab(a, null);
      result.current.addTab(b, null);
      result.current.setTitle(a, 'Fixed title for #1');
    });
    expect(result.current.openTabs.map((t) => t.ref.number)).toEqual([1, 2]);
    expect(result.current.openTabs[0].title).toBe('Fixed title for #1');
    expect(result.current.openTabs[1].title).toBeNull();
  });

  it('addTab starts a tab with a null glyphState (state unknown until resolved)', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const ref = { owner: 'acme', repo: 'api', number: 5 };
    act(() => result.current.addTab(ref, 'T'));
    expect(result.current.openTabs[0].glyphState).toBeNull();
  });

  it('setTabState sets the glyph state for an existing tab without changing order', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    const b = { owner: 'acme', repo: 'api', number: 2 };
    act(() => {
      result.current.addTab(a, null);
      result.current.addTab(b, null);
      result.current.setTabState(a, 'merged');
    });
    expect(result.current.openTabs.map((t) => t.ref.number)).toEqual([1, 2]);
    expect(result.current.openTabs[0].glyphState).toBe('merged');
    expect(result.current.openTabs[1].glyphState).toBeNull();
  });

  it('setTabState returns the same tabs reference when the state is unchanged', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, null);
      result.current.setTabState(a, 'merged');
    });
    // The equality guard must bail (preserve array identity) on a re-resolve to
    // the same state, so a polling PrDetailView effect doesn't churn re-renders.
    const before = result.current.openTabs;
    act(() => result.current.setTabState(a, 'merged'));
    expect(result.current.openTabs).toBe(before);
  });

  it('setTabState is a no-op for an unknown tab', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, null);
      result.current.setTabState({ owner: 'ghost', repo: 'repo', number: 99 }, 'closed');
    });
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].glyphState).toBeNull();
  });

  it('closeTab removes by prRefKey', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    const b = { owner: 'acme', repo: 'api', number: 2 };
    act(() => {
      result.current.addTab(a, null);
      result.current.addTab(b, null);
      result.current.markUnread('acme/api/1');
      result.current.closeTab(a);
    });
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].ref.number).toBe(2);
    expect(result.current.unreadKeys.has('acme/api/1')).toBe(false);
  });

  it('markUnread / clearUnread maintain the Set', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, null);
      result.current.markUnread('acme/api/1');
    });
    expect(result.current.unreadKeys.has('acme/api/1')).toBe(true);
    act(() => result.current.clearUnread('acme/api/1'));
    expect(result.current.unreadKeys.has('acme/api/1')).toBe(false);
  });

  it('markUnread sees the post-addTab state in the same act() batch', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 7 };
    act(() => {
      result.current.addTab(a, null);
      result.current.markUnread('acme/api/7');
    });
    expect(result.current.unreadKeys.has('acme/api/7')).toBe(true);
  });

  it('markUnread is a no-op for unknown prRefKeys', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    act(() => result.current.markUnread('ghost/repo/99'));
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('clearAllTabs empties tabs and unread set', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, 't');
      result.current.markUnread('acme/api/1');
      result.current.clearAllTabs();
    });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('useOpenTabs throws outside provider', () => {
    const Probe = () => {
      useOpenTabs();
      return null;
    };
    expect(() => render(<Probe />)).toThrow(/OpenTabsProvider/);
  });

  it('clears all tabs when prism-identity-changed window event fires', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, 'T');
      result.current.markUnread('acme/api/1');
    });
    expect(result.current.openTabs).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new CustomEvent('prism-identity-changed'));
    });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
  });
});
