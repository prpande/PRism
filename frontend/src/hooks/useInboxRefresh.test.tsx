import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInboxRefresh } from './useInboxRefresh';
import { inboxApi } from '../api/inbox';

vi.mock('../api/inbox', () => ({ inboxApi: { refresh: vi.fn() } }));

const refreshMock = vi.mocked(inboxApi.refresh);

function setup() {
  const reload = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const hook = renderHook(() => useInboxRefresh({ reload, onError }));
  return { hook, reload, onError };
}

beforeEach(() => {
  refreshMock.mockReset();
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

describe('useInboxRefresh', () => {
  it('on success: posts, reloads, announces, and shows the confirmation', async () => {
    refreshMock.mockResolvedValue(undefined);
    const { hook, reload } = setup();

    await act(async () => {
      await hook.result.current.refresh();
    });

    expect(refreshMock).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(hook.result.current.announce).toBe('Inbox refreshed');
    expect(hook.result.current.justRefreshed).toBe(true);
    expect(hook.result.current.isRefreshing).toBe(false);
  });

  it('on failure: calls onError, does not reload, leaves no confirmation', async () => {
    refreshMock.mockRejectedValue(new Error('503'));
    const { hook, reload, onError } = setup();

    await act(async () => {
      await hook.result.current.refresh();
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(hook.result.current.justRefreshed).toBe(false);
    expect(hook.result.current.isRefreshing).toBe(false);
  });

  it('ignores a re-entrant call while one is in flight', async () => {
    let resolve!: () => void;
    refreshMock.mockReturnValue(
      new Promise<void>((r) => {
        resolve = () => r();
      }),
    );
    const { hook } = setup();

    let first!: Promise<void>;
    act(() => {
      first = hook.result.current.refresh();
    });
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(refreshMock).toHaveBeenCalledOnce();

    await act(async () => {
      resolve();
      await first;
    });
  });

  it('blocks a re-click within the min-interval of a SUCCESS but allows retry after a FAILURE', async () => {
    refreshMock.mockResolvedValueOnce(undefined);
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    refreshMock.mockRejectedValueOnce(new Error('x'));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    await act(async () => {
      await hook.result.current.refresh();
    });
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(refreshMock).toHaveBeenCalledTimes(3);
  });
});
