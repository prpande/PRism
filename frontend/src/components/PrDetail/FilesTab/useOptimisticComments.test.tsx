import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useOptimisticComments } from './useOptimisticComments';
import { OPTIMISTIC_FALLBACK_MAX_AGE_MS } from './optimisticComment';

// Unit coverage for the optimistic-comment subsystem extracted from FilesTab
// (#327 slice 2). The pure eviction predicate is unit-tested in
// optimisticComment.test.ts; the FULL FilesTab integration (composer post →
// placeholder → refetch → eviction) lives in
// __tests__/FilesTabOptimisticEviction.test.tsx. This file exercises the hook
// seam itself: notePosted / noteReplyPosted stashing, the per-line placeholder
// filter (databaseId de-dup), the thread grouping, and the two prune paths
// (refetch-generation change + the bounded one-shot fallback timer).

type Threads = Parameters<typeof useOptimisticComments>[0];

const anchor = { filePath: 'src/main.ts', lineNumber: 1, side: 'right' as const };

function threadsWith(databaseId: number | null): Threads {
  return [{ comments: [{ databaseId }] }];
}

function setup(initialThreads: Threads = []) {
  return renderHook(({ threads }: { threads: Threads }) => useOptimisticComments(threads), {
    initialProps: { threads: initialThreads },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useOptimisticComments', () => {
  it('notePosted stashes a new-inline placeholder surfaced by placeholdersForLine at its anchor line only', () => {
    const { result } = setup();

    act(() => {
      result.current.notePosted(anchor, 123, 'hello world');
    });

    const placeholders = result.current.placeholdersForLine('src/main.ts', 1);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      threadId: null,
      anchorKey: 'src/main.ts:1:right',
      body: 'hello world',
      author: 'You',
      postedCommentId: 123,
    });

    // Other lines / files see nothing — and line 1 must not prefix-match line 12.
    expect(result.current.placeholdersForLine('src/main.ts', 12)).toHaveLength(0);
    expect(result.current.placeholdersForLine('other.ts', 1)).toHaveLength(0);

    // New-inline placeholders (threadId === null) are not grouped by thread.
    expect(result.current.optimisticByThread).toEqual({});
  });

  it('de-dups the placeholder out of placeholdersForLine when a real comment with matching databaseId arrives', () => {
    const { result, rerender } = setup();

    act(() => {
      result.current.notePosted(anchor, 123, 'hello world');
    });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(1);

    // The refetch lands the just-posted comment WITH its databaseId — the
    // placeholder vanishes at once (render-time de-dup + fast-path prune).
    rerender({ threads: threadsWith(123) });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(0);
  });

  it('noteReplyPosted groups the placeholder under its thread and prunes it via the databaseId fast-path', () => {
    const { result, rerender } = setup();

    act(() => {
      result.current.noteReplyPosted('thread-1', 456, 'my reply');
    });

    expect(result.current.optimisticByThread['thread-1']).toHaveLength(1);
    expect(result.current.optimisticByThread['thread-1'][0]).toMatchObject({
      threadId: 'thread-1',
      body: 'my reply',
      author: 'You',
      postedCommentId: 456,
    });
    // Reply placeholders are not new-inline placeholders.
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(0);

    // Refetch lands the real reply with a matching databaseId → pruned.
    rerender({ threads: threadsWith(456) });
    expect(result.current.optimisticByThread).toEqual({});
  });

  it('prunes an aged databaseId-less placeholder when a refetch generation lands (effect path, no timer)', () => {
    const { result, rerender } = setup();

    act(() => {
      result.current.notePosted(anchor, 999, 'never matched');
    });

    // A first refetch lands the comment WITHOUT a databaseId (real GitHub
    // responses ship databaseId: null) — gen bumps but the placeholder is not
    // yet aged, so it survives.
    rerender({ threads: threadsWith(null) });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(1);

    // Move the fake system clock past the bound WITHOUT firing pending timers,
    // then land a further refetch: the gen-change prune alone evicts it.
    vi.setSystemTime(Date.now() + OPTIMISTIC_FALLBACK_MAX_AGE_MS + 1);
    rerender({ threads: threadsWith(null) });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(0);
  });

  it('prunes an aged databaseId-less placeholder via the one-shot fallback timer without a further refetch', () => {
    const { result, rerender } = setup();

    act(() => {
      result.current.notePosted(anchor, 999, 'never matched');
    });

    // Let a little time pass so the placeholder pre-dates the refetch below —
    // the timer that refetch arms then fires strictly after the age bound.
    act(() => {
      vi.advanceTimersByTime(5);
    });

    // A refetch lands (gen bump) but the placeholder is younger than the bound
    // → survives, and the one-shot fallback timer is (re-)armed.
    rerender({ threads: threadsWith(null) });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(1);

    // No further refetch: the fallback timer alone fires at the age bound and
    // evicts the now-aged placeholder.
    act(() => {
      vi.advanceTimersByTime(OPTIMISTIC_FALLBACK_MAX_AGE_MS);
    });
    expect(result.current.placeholdersForLine('src/main.ts', 1)).toHaveLength(0);
  });
});
