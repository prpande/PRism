import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

beforeEach(() => {
  installFakeEventSource();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useInboxUpdates', () => {
  it('shows banner on inbox-updated event', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(result.current.hasUpdate).toBe(false);
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: ['awaiting-author'],
        newOrUpdatedPrCount: 3,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    expect(result.current.summary).toContain('3 new updates');
  });

  it('dismiss clears banner', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.summary).toBe('');
  });

  it('uses singular form when newOrUpdatedPrCount is 1', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    expect(result.current.summary).toBe('1 new update');
  });
});
