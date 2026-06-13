import { describe, it, expect } from 'vitest';
import {
  applyInboxFilters,
  looksLikePrUrl,
  looksLikeUrl,
  SORT_OPTIONS,
  type InboxFilters,
  type SortKey,
} from './applyInboxFilters';
import type { InboxSection, PrInboxItem } from '../../../api/types';

const pr = (over: Partial<PrInboxItem>): PrInboxItem => ({
  reference: { owner: 'acme', repo: 'api', number: 1 },
  title: 'Fix token refresh',
  author: 'dana',
  repo: 'acme/api',
  updatedAt: '2026-06-01T00:00:00Z',
  pushedAt: '2026-06-01T00:00:00Z',
  commitCount: 1,
  commentCount: 0,
  additions: 1,
  deletions: 0,
  headSha: 'sha',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
  ...over,
});
const section = (id: string, items: PrInboxItem[]): InboxSection => ({ id, label: id, items });
const empty: InboxFilters = { text: '', ci: [], repos: [], authors: [] };
const updated: SortKey = 'updated';

describe('applyInboxFilters', () => {
  it('returns all items (sorted) and filterActive=false when no facet is set', () => {
    const secs = [section('review-requested', [pr({})])];
    const r = applyInboxFilters(secs, empty, updated);
    // applyInboxFilters always returns a fresh sorted copy — deep-equal, not reference-equal.
    expect(r.filterActive).toBe(false);
    expect(r.sections).toEqual(secs);
    expect(r.matchCount).toBe(r.totalCount);
    expect(r.matchCount).toBe(1);
  });

  it('free-text matches title OR repo, case-insensitive', () => {
    const secs = [
      section('s', [pr({ title: 'Retry budget' }), pr({ title: 'Other', repo: 'acme/bff' })]),
    ];
    expect(
      applyInboxFilters(secs, { ...empty, text: 'retry' }, updated).sections[0].items,
    ).toHaveLength(1);
    expect(
      applyInboxFilters(secs, { ...empty, text: 'BFF' }, updated).sections[0].items,
    ).toHaveLength(1);
  });

  it('CI facet keeps only matching ci values (OR within facet)', () => {
    const secs = [section('s', [pr({ ci: 'failing' }), pr({ ci: 'pending' }), pr({ ci: 'none' })])];
    expect(
      applyInboxFilters(secs, { ...empty, ci: ['failing'] }, updated).sections[0].items,
    ).toHaveLength(1);
    expect(
      applyInboxFilters(secs, { ...empty, ci: ['failing', 'pending'] }, updated).sections[0].items,
    ).toHaveLength(2);
  });

  it('facets AND across (CI:failing AND repo:bff)', () => {
    const secs = [
      section('s', [
        pr({ ci: 'failing', repo: 'acme/api' }),
        pr({ ci: 'failing', repo: 'acme/bff' }),
      ]),
    ];
    const r = applyInboxFilters(secs, { ...empty, ci: ['failing'], repos: ['acme/bff'] }, updated);
    expect(r.sections[0].items).toHaveLength(1);
    expect(r.sections[0].items[0].repo).toBe('acme/bff');
  });

  it('hides emptied sections when a filter is active', () => {
    const secs = [section('a', [pr({ ci: 'failing' })]), section('b', [pr({ ci: 'none' })])];
    const r = applyInboxFilters(secs, { ...empty, ci: ['failing'] }, updated);
    expect(r.sections.map((s) => s.id)).toEqual(['a']);
    expect(r.matchCount).toBe(1);
    expect(r.totalCount).toBe(2);
  });

  it('sorts within a section, tie-breaking on reference.number descending', () => {
    const secs = [
      section('s', [
        pr({
          reference: { owner: 'acme', repo: 'api', number: 1 },
          updatedAt: '2026-06-01T00:00:00Z',
        }),
        pr({
          reference: { owner: 'acme', repo: 'api', number: 2 },
          updatedAt: '2026-06-02T00:00:00Z',
        }),
      ]),
    ];
    const r = applyInboxFilters(secs, empty, 'updated');
    // newest updatedAt first
    expect(r.sections[0].items[0].reference.number).toBe(2);
  });

  it('clamps an out-of-set sort to updated instead of crashing', () => {
    // A hand-edited / version-skewed inbox.defaultSort reaches here as an arbitrary
    // string the TS type can't police. It must NOT throw (comparators[bad] is
    // undefined); it falls back to the 'updated' order.
    const secs = [
      section('s', [
        pr({
          reference: { owner: 'acme', repo: 'api', number: 1 },
          updatedAt: '2026-06-01T00:00:00Z',
        }),
        pr({
          reference: { owner: 'acme', repo: 'api', number: 2 },
          updatedAt: '2026-06-02T00:00:00Z',
        }),
      ]),
    ];
    const r = applyInboxFilters(secs, empty, 'alphabetical' as never);
    expect(r.sections[0].items[0].reference.number).toBe(2); // updated-order fallback
  });
});

describe('looksLikePrUrl', () => {
  it('is true for an http(s) owner/repo/pull/{number} URL (mirrors the server parser)', () => {
    expect(looksLikePrUrl('https://github.com/o/r/pull/42')).toBe(true);
    expect(looksLikePrUrl('http://ghe.acme.com/o/r/pull/9')).toBe(true);
    // A deep link past the PR number still resolves to the same PR.
    expect(looksLikePrUrl('https://github.com/o/r/pull/42/files')).toBe(true);
    // Tolerates surrounding whitespace (pasted text often carries it).
    expect(looksLikePrUrl('  https://github.com/foo/bar/pull/42  ')).toBe(true);
    // Case-insensitive on scheme.
    expect(looksLikePrUrl('HTTPS://github.com/o/r/pull/42')).toBe(true);
  });

  it('REJECTS the plural /pulls/ (the API list endpoint, not a single PR)', () => {
    expect(looksLikePrUrl('https://api.github.com/repos/o/r/pulls/9')).toBe(false);
    expect(looksLikePrUrl('https://github.com/o/r/pulls/42')).toBe(false);
  });

  it('REJECTS a branch path that merely contains "pull" deeper in the tree', () => {
    // owner/repo/tree/<branch…>; segment-2 is "tree", not "pull".
    expect(looksLikePrUrl('https://github.com/o/r/tree/feat/pull/x')).toBe(false);
  });

  it('REJECTS a /pull/ with a non-numeric id', () => {
    expect(looksLikePrUrl('https://github.com/o/r/pull/x')).toBe(false);
  });

  it('ACCEPTS a deep link past the id (the id is not end-anchored, by design)', () => {
    // Deliberately un-anchored after the number: a deep link resolves to the same
    // PR, and the staleness-guard tolerance in InboxQueryInput depends on this
    // permissiveness (see looksLikePrUrl's comment). A trailing-junk id like
    // `…/pull/42abc` is left for the server parser to reject.
    expect(looksLikePrUrl('https://github.com/o/r/pull/42/files')).toBe(true);
    expect(looksLikePrUrl('https://github.com/o/r/pull/42?diff=split')).toBe(true);
  });

  it('is false for normal filter terms and non-PR URLs', () => {
    expect(looksLikePrUrl('retry')).toBe(false);
    expect(looksLikePrUrl('acme/bff')).toBe(false);
    expect(looksLikePrUrl('')).toBe(false);
    // A URL but not a PR link (no /pull/ segment).
    expect(looksLikePrUrl('https://github.com/foo/bar/issues/1')).toBe(false);
    // A /pull/ path but no scheme — a bare term, not a URL.
    expect(looksLikePrUrl('foo/bar/pull/42')).toBe(false);
  });
});

describe('looksLikeUrl', () => {
  it('is true for ANY http(s) URL', () => {
    expect(looksLikeUrl('https://github.com/o/r/pull/42')).toBe(true);
    expect(looksLikeUrl('https://github.com/o/r/issues/9')).toBe(true);
    expect(looksLikeUrl('https://github.com/o/r')).toBe(true);
    expect(looksLikeUrl('http://example.com')).toBe(true);
    expect(looksLikeUrl('  https://github.com/o/r  ')).toBe(true);
    expect(looksLikeUrl('HTTP://example.com')).toBe(true);
  });

  it('is false for a bare term or a repo slug', () => {
    expect(looksLikeUrl('retry')).toBe(false);
    expect(looksLikeUrl('acme/bff')).toBe(false);
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('github.com/o/r')).toBe(false); // no scheme
  });
});

it('sort labels are direction-encoding and keys are unchanged', () => {
  // #300 — labels read consistently and convey their fixed (descending) direction
  // without a toggle. Keys MUST be unchanged so persisted inbox.defaultSort survives.
  expect(SORT_OPTIONS).toEqual([
    { key: 'updated', label: 'Recently updated' },
    { key: 'pushed', label: 'Recently pushed' },
    { key: 'diff', label: 'Largest diff' },
    { key: 'comments', label: 'Most comments' },
  ]);
});
