import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboxResponse } from '../api/types';

const { get, ApiError } = vi.hoisted(() => {
  const get = vi.fn();
  class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`status ${status}`);
      this.status = status;
    }
  }
  return { get, ApiError };
});
vi.mock('../api/inbox', () => ({ inboxApi: { get } }));
vi.mock('../api/client', () => ({ ApiError }));

import { useInbox } from './useInbox';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// The hook stores the response opaquely; a tagged object is enough to prove which
// attempt's result won.
const tagged = (tag: string) => ({ tag }) as unknown as InboxResponse;
const tagOf = (data: InboxResponse | null) => (data as unknown as { tag?: string } | null)?.tag;

describe('useInbox generation guard (#330)', () => {
  beforeEach(() => get.mockReset());

  it('a stale in-flight load that resolves last does NOT overwrite a newer reload', async () => {
    const first = deferred<InboxResponse>();
    const second = deferred<InboxResponse>();
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useInbox()); // gen 1 in flight (mount)
    act(() => {
      void result.current.reload(); // gen 2 in flight — supersedes gen 1
    });

    // Resolve the NEWER attempt first, then the STALE one.
    await act(async () => {
      second.resolve(tagged('new'));
    });
    await waitFor(() => expect(tagOf(result.current.data)).toBe('new'));
    await act(async () => {
      first.resolve(tagged('stale'));
    });

    // The stale gen-1 resolve is dropped by isCurrent() — data stays 'new'.
    expect(tagOf(result.current.data)).toBe('new');
  });

  it('aborts the 503 retry loop on unmount — no further fetch fires', async () => {
    get.mockRejectedValueOnce(new ApiError(503)); // first attempt 503 → schedules a retry
    const { unmount } = renderHook(() => useInbox());
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    unmount(); // cleanup bumps the generation → the parked retry is now stale

    // Wait past the 500ms first-retry delay; the post-delay isCurrent() check must
    // short-circuit before a second fetch (the unmount-mid-retry leak the guard closes).
    await new Promise((r) => setTimeout(r, 600));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
