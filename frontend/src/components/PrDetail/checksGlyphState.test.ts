import { describe, expect, it } from 'vitest';
import { checksGlyphState } from './checksGlyphState';
import type { CheckRun } from '../../api/types';

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x',
  status: 'completed',
  conclusion: 'success',
  source: 'check-run',
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  ...over,
});

describe('checksGlyphState', () => {
  it('all queued/in-progress → in-progress lead, no failing count', () => {
    const s = checksGlyphState([
      run({ status: 'queued', conclusion: null }),
      run({ status: 'in-progress', conclusion: null }),
    ]);
    expect(s.lead).toBe('in-progress');
    expect(s.failingCount).toBe(0);
    expect(s.ariaSummary).toBe('Checks — running');
  });

  it('running + failing → in-progress wins the lead, failing counted', () => {
    const s = checksGlyphState([
      run({ status: 'in-progress', conclusion: null }),
      run({ conclusion: 'failure' }),
    ]);
    expect(s.lead).toBe('in-progress');
    expect(s.failingCount).toBe(1);
  });

  it('cancelled-only → red badge + NO lead glyph (cancelled is failing tier)', () => {
    const s = checksGlyphState([run({ conclusion: 'cancelled' })]);
    expect(s.lead).toBe('none');
    expect(s.failingCount).toBe(1);
    expect(s.ariaSummary).toBe('Checks — 1 cancelled');
  });

  it('all green → all-green tick', () => {
    const s = checksGlyphState([run({ conclusion: 'success' }), run({ conclusion: 'success' })]);
    expect(s.lead).toBe('all-green');
    expect(s.failingCount).toBe(0);
    expect(s.ariaSummary).toBe('Checks — all passing');
  });

  it('failure + success terminal → no lead glyph, count + plural aria', () => {
    const s = checksGlyphState([
      run({ conclusion: 'failure' }),
      run({ conclusion: 'timed-out' }),
      run({ conclusion: 'success' }),
    ]);
    expect(s.lead).toBe('none');
    expect(s.failingCount).toBe(2);
    expect(s.ariaSummary).toBe('Checks — 2 failing');
  });

  it('empty → no lead glyph, neutral aria', () => {
    const s = checksGlyphState([]);
    expect(s.lead).toBe('none');
    expect(s.failingCount).toBe(0);
    expect(s.ariaSummary).toBe('Checks');
  });

  it('action-required is NOT failing and does NOT make all-green', () => {
    const s = checksGlyphState([
      run({ conclusion: 'action-required' }),
      run({ conclusion: 'success' }),
    ]);
    expect(s.lead).toBe('none');
    expect(s.failingCount).toBe(0);
  });
});
