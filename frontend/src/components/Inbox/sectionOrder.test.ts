import { describe, it, expect } from 'vitest';
import type { InboxSection } from '../../api/types';
import {
  CANONICAL_WORK_ORDER,
  CANONICAL_DEFAULT_ORDER_STRING,
  orderInboxSections,
  orderedWorkSectionIds,
} from './sectionOrder';

const sec = (id: string): InboxSection => ({ id, label: id, items: [] });
const ids = (xs: InboxSection[]) => xs.map((s) => s.id);

describe('CANONICAL_DEFAULT_ORDER_STRING', () => {
  it('is the four work ids joined, no recently-closed', () => {
    expect(CANONICAL_DEFAULT_ORDER_STRING).toBe(
      'review-requested,awaiting-author,authored-by-me,mentioned',
    );
    expect(CANONICAL_WORK_ORDER).not.toContain('recently-closed');
  });
});

describe('orderInboxSections', () => {
  const live = [
    sec('review-requested'),
    sec('awaiting-author'),
    sec('authored-by-me'),
    sec('mentioned'),
    sec('recently-closed'),
  ];

  it('reorders by the saved permutation, recently-closed pinned last', () => {
    const out = orderInboxSections(live, 'mentioned,authored-by-me,review-requested,awaiting-author');
    expect(ids(out)).toEqual([
      'mentioned',
      'authored-by-me',
      'review-requested',
      'awaiting-author',
      'recently-closed',
    ]);
  });

  it('forces recently-closed last even if the saved order lists it first', () => {
    const out = orderInboxSections(live, 'recently-closed,mentioned,review-requested,awaiting-author,authored-by-me');
    expect(ids(out).at(-1)).toBe('recently-closed');
  });

  it('appends a section absent from the saved order in canonical order (no drop)', () => {
    const out = orderInboxSections(live, 'mentioned,review-requested,awaiting-author');
    expect(ids(out)).toEqual([
      'mentioned',
      'review-requested',
      'awaiting-author',
      'authored-by-me',
      'recently-closed',
    ]);
  });

  it('ignores a saved id that matches no live section', () => {
    const out = orderInboxSections([sec('mentioned'), sec('review-requested')], 'ghost,mentioned,review-requested');
    expect(ids(out)).toEqual(['mentioned', 'review-requested']);
  });

  it('falls back to canonical order for undefined / empty / malformed', () => {
    for (const bad of [undefined, '', '   ', ',,,']) {
      const out = orderInboxSections(live, bad);
      expect(ids(out)).toEqual([
        'review-requested',
        'awaiting-author',
        'authored-by-me',
        'mentioned',
        'recently-closed',
      ]);
    }
  });

  it('arranges a filter-narrowed subset by the saved order', () => {
    const subset = [sec('mentioned'), sec('review-requested')];
    const out = orderInboxSections(subset, 'mentioned,authored-by-me,review-requested,awaiting-author');
    expect(ids(out)).toEqual(['mentioned', 'review-requested']);
  });
});

describe('orderedWorkSectionIds', () => {
  it('returns exactly the four work ids in saved order', () => {
    expect(orderedWorkSectionIds('mentioned,authored-by-me,review-requested,awaiting-author')).toEqual([
      'mentioned',
      'authored-by-me',
      'review-requested',
      'awaiting-author',
    ]);
  });

  it('appends missing ids canonically and dedups / drops unknowns', () => {
    expect(orderedWorkSectionIds('mentioned,bogus,mentioned')).toEqual([
      'mentioned',
      'review-requested',
      'awaiting-author',
      'authored-by-me',
    ]);
  });

  it('returns full canonical order for undefined', () => {
    expect(orderedWorkSectionIds(undefined)).toEqual([
      'review-requested',
      'awaiting-author',
      'authored-by-me',
      'mentioned',
    ]);
  });
});
