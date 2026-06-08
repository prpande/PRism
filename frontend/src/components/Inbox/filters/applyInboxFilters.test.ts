import { describe, it, expect } from 'vitest';
import {
  applyInboxFilters,
  looksLikePrUrl,
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
  iterationNumber: 1,
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
});

describe('looksLikePrUrl', () => {
  it('is true for http(s) URLs with a /pull/ or /pulls/ segment', () => {
    expect(looksLikePrUrl('https://github.com/foo/bar/pull/42')).toBe(true);
    expect(looksLikePrUrl('http://ghe.acme.com/o/r/pull/9')).toBe(true);
    expect(looksLikePrUrl('https://api.github.com/repos/o/r/pulls/9')).toBe(true);
    // Tolerates surrounding whitespace (pasted text often carries it).
    expect(looksLikePrUrl('  https://github.com/foo/bar/pull/42  ')).toBe(true);
  });

  it('is false for normal filter terms and non-PR URLs', () => {
    expect(looksLikePrUrl('retry')).toBe(false);
    expect(looksLikePrUrl('acme/bff')).toBe(false);
    expect(looksLikePrUrl('')).toBe(false);
    // A URL but not a PR link (no /pull(s)/ segment).
    expect(looksLikePrUrl('https://github.com/foo/bar/issues/1')).toBe(false);
    // A /pull/ path but no scheme — a bare term, not a URL.
    expect(looksLikePrUrl('foo/bar/pull/42')).toBe(false);
  });
});
