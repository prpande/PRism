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
