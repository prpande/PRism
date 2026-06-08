import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInboxFilters } from './useInboxFilters';
import type { InboxSection, PrInboxItem } from '../../../api/types';

// Complete fixtures: applyInboxFilters sorts UNCONDITIONALLY (even with no active
// filter), so the comparator reads updatedAt/reference — partial `as never` stubs
// throw `undefined.localeCompare` at runtime (tsc won't catch it). Reuse a full
// PrInboxItem shape (same as Task 11's `pr()` factory).
const item = (repo: string, author: string, n: number): PrInboxItem => ({
  reference: { owner: 'acme', repo: repo.split('/')[1], number: n },
  title: 't',
  author,
  repo,
  updatedAt: '2026-06-01T00:00:00Z',
  pushedAt: '2026-06-01T00:00:00Z',
  iterationNumber: 1,
  commentCount: 0,
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
});
