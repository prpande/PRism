import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInboxFilters } from './useInboxFilters';
import type { SortKey } from './applyInboxFilters';
import type { InboxSection, PrInboxItem } from '../../../api/types';

// Complete fixtures: applyInboxFilters sorts UNCONDITIONALLY (even with no active
// filter), so the comparator reads updatedAt/reference — partial `as never` stubs
// throw `undefined.localeCompare` at runtime (tsc won't catch it). Reuse a full
// PrInboxItem shape (same as Task 11's `pr()` factory).
const item = (repo: string, author: string, n: number, commentCount = 0): PrInboxItem => ({
  reference: { owner: 'acme', repo: repo.split('/')[1], number: n },
  title: 't',
  author,
  repo,
  updatedAt: `2026-06-0${n}T00:00:00Z`,
  pushedAt: '2026-06-01T00:00:00Z',
  commitCount: 1,
  changedFiles: 0,
  commentCount,
  additions: 0,
  deletions: 0,
  headSha: 's',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
});
const secs: InboxSection[] = [
  { id: 'a', label: 'a', items: [item('acme/api', 'dana', 1), item('acme/bff', 'pat', 2)] },
];

describe('useInboxFilters', () => {
  it('derives repo + author values from the full snapshot', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    expect(result.current.repoValues).toEqual(['acme/api', 'acme/bff']);
    expect(result.current.authorValues).toEqual(['dana', 'pat']);
  });

  it('clear() resets every facet incl. the query', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    act(() => result.current.setQuery('retry'));
    act(() => result.current.toggleCi('failing'));
    act(() => result.current.clear());
    expect(result.current.query).toBe('');
    expect(result.current.filters).toEqual({ text: '', ci: [], repos: [], authors: [] });
    expect(result.current.active).toBe(false);
  });

  it('a plain term sets the effective text filter and is active', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    act(() => result.current.setQuery('retry'));
    expect(result.current.query).toBe('retry');
    expect(result.current.filters.text).toBe('retry');
    expect(result.current.active).toBe(true);
  });

  it('a PR-URL-shaped query does NOT filter (effective text empty, not active)', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    act(() => result.current.setQuery('https://github.com/foo/bar/pull/42'));
    // Raw query holds the URL (so the input still shows it)...
    expect(result.current.query).toBe('https://github.com/foo/bar/pull/42');
    // ...but the effective text filter is empty — the inbox is NOT filtered.
    expect(result.current.filters.text).toBe('');
    expect(result.current.active).toBe(false);
  });

  it('a NON-PR URL also strips (no fake "No PRs match" zero-state)', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    // A pasted issue/commit/repo URL is still URL-shaped — it must NOT become a
    // literal text filter that empties the inbox.
    act(() => result.current.setQuery('https://github.com/o/r/issues/9'));
    expect(result.current.query).toBe('https://github.com/o/r/issues/9');
    expect(result.current.filters.text).toBe('');
    expect(result.current.active).toBe(false);
  });

  it('toggleCi accumulates and de-accumulates (toggle twice → back to [])', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    // First toggle: 'failing' added
    act(() => result.current.toggleCi('failing'));
    expect(result.current.filters.ci).toEqual(['failing']);
    // Second toggle: 'failing' removed
    act(() => result.current.toggleCi('failing'));
    expect(result.current.filters.ci).toEqual([]);
  });

  it('setSort reorders items within a section', () => {
    // item(repo, author, n, commentCount)
    // n drives updatedAt (2026-06-0n) so item 2 is newer by updated, item 1 has more comments.
    const twoItems: InboxSection[] = [
      {
        id: 'a',
        label: 'a',
        items: [
          item('acme/api', 'dana', 1, 10), // older updatedAt, more comments
          item('acme/bff', 'pat', 2, 1), // newer updatedAt, fewer comments
        ],
      },
    ];
    const { result } = renderHook(() => useInboxFilters(twoItems, 'updated'));
    // Default 'updated' sort: item n=2 (newer) first
    expect(result.current.result.sections[0].items[0].reference.number).toBe(2);
    expect(result.current.sort).toBe('updated');
    // Switch to 'comments' sort: item n=1 (more comments) first
    act(() => result.current.setSort('comments'));
    expect(result.current.sort).toBe('comments');
    expect(result.current.result.sections[0].items[0].reference.number).toBe(1);
  });

  it('adopts a late-resolving initialSort (preferences losing the cold-load race)', () => {
    // Cold load: inbox snapshot beats the preferences fetch, so the hook first
    // mounts with the 'updated' fallback; `initialSort` resolves to the real
    // inbox.defaultSort a render later. The hook must adopt it, not stay stuck.
    const { result, rerender } = renderHook(({ s }: { s: SortKey }) => useInboxFilters(secs, s), {
      initialProps: { s: 'updated' },
    });
    expect(result.current.sort).toBe('updated');
    rerender({ s: 'comments' });
    expect(result.current.sort).toBe('comments');
  });

  it('a user sort wins over a later initialSort change (no yank-out-from-under)', () => {
    const { result, rerender } = renderHook(({ s }: { s: SortKey }) => useInboxFilters(secs, s), {
      initialProps: { s: 'updated' },
    });
    // User explicitly picks a sort...
    act(() => result.current.setSort('diff'));
    expect(result.current.sort).toBe('diff');
    // ...then the preference resolves/changes later — the user's choice stands.
    rerender({ s: 'comments' });
    expect(result.current.sort).toBe('diff');
  });
});
