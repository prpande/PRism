import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../contexts/OpenTabsContext';
import { useEffect } from 'react';
import { useTabUnreadSignal } from './useTabUnreadSignal';

const listeners: Record<string, ((p: unknown) => void)[]> = {};
vi.mock('./useEventSource', () => ({
  useEventSource: () => ({
    on: (type: string, cb: (p: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
      return () => {
        listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb);
      };
    },
    subscriberId: () => Promise.resolve('test'),
    reconnectSignal: () => new AbortController().signal,
    close: () => {},
  }),
}));

function fireSse(type: string, payload: unknown) {
  (listeners[type] ?? []).forEach((cb) => cb(payload));
}

function Probe() {
  const { openTabs, unreadKeys, addTab } = useOpenTabs();
  useEffect(() => {
    addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
    addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
  }, [addTab]);
  useTabUnreadSignal();
  return (
    <div>
      <div data-testid="unread">{[...unreadKeys].sort().join(',')}</div>
      <div data-testid="tabs">{openTabs.length}</div>
    </div>
  );
}

describe('useTabUnreadSignal', () => {
  beforeEach(() => {
    // Reset listeners between tests so a stale listener from the previous
    // render doesn't fire alongside the new render's listener.
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it('marks tab unread when pr-updated fires for a non-active tab', async () => {
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'acme/api/2', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('acme/api/2');
  });

  it('does NOT mark unread when pr-updated fires for the active tab', async () => {
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'acme/api/1', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });

  it('ignores pr-updated for prRefs that are not open', async () => {
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'ghost/repo/99', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });

  it('does NOT mark the PR unread when the Settings modal is open over it (#134 keep-alive)', async () => {
    const { findByTestId } = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/settings/appearance',
            state: { backgroundLocation: { pathname: '/pr/acme/api/1' } },
          },
        ]}
      >
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // acme/api/1 is the open PR behind the modal scrim — it is the effective
    // active route, so a pr-updated for it must NOT mark it unread.
    fireSse('pr-updated', { prRef: 'acme/api/1', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });

  it('matches nested PR route (/pr/o/r/N/files) as active', async () => {
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1/files']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'acme/api/1', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });
});
