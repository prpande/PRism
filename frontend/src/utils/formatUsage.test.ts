import { describe, it, expect } from 'vitest';
import { formatBucketDate, formatCost, formatTokens } from './formatUsage';

describe('formatCost', () => {
  it('renders sub-cent costs with 4 decimals so they do not read as $0.00', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(0.0001)).toBe('$0.0001');
  });
  it('renders cents-and-up with 2 decimals', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(1234.5)).toBe('$1,234.50');
  });
  it('renders exactly zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('formatTokens', () => {
  it('uses thousands separators with no abbreviation', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatBucketDate', () => {
  // Trend buckets are UTC-anchored (the backend keys day buckets on UTC midnight). The label must
  // name that UTC calendar day, NOT the viewer's local day — otherwise a UTC-negative user sees the
  // bar/sr-only summary off by one. Pinning timeZone:'UTC' makes this deterministic regardless of
  // the runner's ambient zone. (en-US to match the rest of the formatters in this module.)
  it('renders the UTC calendar day of a UTC-midnight bucket', () => {
    expect(formatBucketDate('2026-06-18T00:00:00+00:00')).toBe('6/18/2026');
  });
  it('does not roll the date into the viewer local zone for a late-UTC instant', () => {
    // 23:30 UTC is still June 18 in UTC; a naive local render in a positive-offset zone would roll
    // it to June 19. The UTC anchor keeps it on the 18th.
    expect(formatBucketDate('2026-06-18T23:30:00+00:00')).toBe('6/18/2026');
  });
});
