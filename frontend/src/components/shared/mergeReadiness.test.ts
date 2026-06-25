import { describe, it, expect } from 'vitest';
import {
  READINESS_SHORT,
  READINESS_LONG,
  READINESS_TOOLTIP,
  isBadgeRendered,
  type MergeReadiness,
} from './mergeReadiness';

const OPEN_STATES: MergeReadiness[] = [
  'conflicts',
  'behind-base',
  'changes-requested',
  'review-required',
  'blocked-by-protection',
  'unstable',
  'ready-with-changes-requested',
  'ready',
];

describe('mergeReadiness module', () => {
  it('renders a badge only for the 8 open states', () => {
    for (const s of OPEN_STATES) expect(isBadgeRendered(s)).toBe(true);
    for (const s of ['none', 'merged', 'closed'] as MergeReadiness[])
      expect(isBadgeRendered(s)).toBe(false);
  });

  it('has a non-empty short, long, and tooltip string for every open state', () => {
    for (const s of OPEN_STATES) {
      expect(READINESS_SHORT[s]).toBeTruthy();
      expect(READINESS_LONG[s]).toBeTruthy();
      expect(READINESS_TOOLTIP[s]).toBeTruthy();
    }
  });

  it('gives the four yellow states distinct short labels with no shared prefix', () => {
    const yellow = [
      'behind-base',
      'review-required',
      'blocked-by-protection',
      'unstable',
    ] as MergeReadiness[];
    const shorts = yellow.map((s) => READINESS_SHORT[s]);
    expect(new Set(shorts).size).toBe(4);
    // No two share a leading word that truncation could collapse.
    const firstWords = shorts.map((t) => t.split(' ')[0].toLowerCase());
    expect(new Set(firstWords).size).toBe(4);
  });
});
