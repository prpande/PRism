import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTimelineFeed } from './useTimelineFeed';
import * as api from '../../../../api/timeline';
import type { TimelineEvent } from '../../../../api/types';

const ev = (id: string): TimelineEvent => ({
  id,
  verb: 'approved',
  actor: { login: 'a', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z',
  body: null,
  commitCount: null,
  subject: null,
});
const pr = { owner: 'acme', repo: 'api', number: 7 };

afterEach(() => vi.restoreAllMocks());

describe('useTimelineFeed', () => {
  it('loads the newest page on mount', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('1')],
      olderCursor: 'C',
      hasOlder: true,
    });
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.hasOlder).toBe(true);
  });

  it('appends older events (deduped) on loadOlder', async () => {
    const spy = vi
      .spyOn(api, 'getTimelinePage')
      .mockResolvedValueOnce({ events: [ev('2')], olderCursor: 'C', hasOlder: true })
      .mockResolvedValueOnce({ events: [ev('1'), ev('2')], olderCursor: null, hasOlder: false });
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.hasOlder).toBe(false));
    expect(result.current.events.map((e) => e.id)).toEqual(['2', '1']); // no duplicate '2'
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches the newest page when prUpdatedSignal changes', async () => {
    const spy = vi
      .spyOn(api, 'getTimelinePage')
      .mockResolvedValueOnce({ events: [ev('1')], olderCursor: 'C', hasOlder: true })
      .mockResolvedValueOnce({ events: [ev('9'), ev('1')], olderCursor: 'C', hasOlder: true });
    const { result, rerender } = renderHook(
      ({ sig }) => useTimelineFeed(pr, { prUpdatedSignal: sig }),
      { initialProps: { sig: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ sig: 1 });
    await waitFor(() => expect(result.current.events[0].id).toBe('9'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not refetch-newest on PR navigation, only the initial load (firstSignal reset)', async () => {
    // PrDetailView is reused across PR navigation (not remounted), so prUpdatedSignal can already
    // be non-zero when a different prRef arrives — mount with sig=1 directly (not advanced later)
    // so firstSignal.current is only ever flipped false-by-mount, never by a genuine live-refresh.
    const prB = { owner: 'acme', repo: 'api', number: 8 };
    const spy = vi
      .spyOn(api, 'getTimelinePage')
      // PR A initial load
      .mockResolvedValueOnce({ events: [ev('1')], olderCursor: null, hasOlder: false })
      // PR B initial load (loadFirstPage effect — expected)
      .mockResolvedValueOnce({ events: [ev('9')], olderCursor: null, hasOlder: false })
      // Only consumed by a buggy extra refetchNewest(B) call racing the initial load above.
      .mockResolvedValueOnce({ events: [ev('99')], olderCursor: null, hasOlder: false });
    const { result, rerender } = renderHook(
      ({ prRef, sig }) => useTimelineFeed(prRef, { prUpdatedSignal: sig }),
      { initialProps: { prRef: pr, sig: 1 } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.liveAnnouncement).toBe('');

    // Navigate to PR B with prUpdatedSignal unchanged (non-zero) — simulates PrDetailView reuse.
    rerender({ prRef: prB, sig: 1 });
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(['9']));

    // Only the initial load for B should have fired — not an extra refetchNewest alongside it.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.liveAnnouncement).toBe('');
  });

  it('sets error status when the fetch rejects', async () => {
    vi.spyOn(api, 'getTimelinePage').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('reload recovers from an initial-load error', async () => {
    const spy = vi
      .spyOn(api, 'getTimelinePage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ events: [ev('1')], olderCursor: null, hasOlder: false });
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
