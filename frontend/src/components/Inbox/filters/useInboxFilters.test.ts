import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInboxFilters } from './useInboxFilters';
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
  iterationNumber: 1,
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

  it('clear() resets every facet incl. free-text', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    act(() => result.current.setText('retry'));
    act(() => result.current.toggleCi('failing'));
    act(() => result.current.clear());
    expect(result.current.filters).toEqual({ text: '', ci: [], repos: [], authors: [] });
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
});
