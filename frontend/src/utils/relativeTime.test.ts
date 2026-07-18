import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAge } from './relativeTime';

describe('formatAge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "unknown" for an invalid timestamp', () => {
    expect(formatAge('not-a-date')).toBe('unknown');
    expect(formatAge('')).toBe('unknown');
    expect(formatAge('invalid')).toBe('unknown');
  });

  it('returns "just now" when age is less than 60 seconds', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-01T12:00:30Z').getTime();
    vi.setSystemTime(now);
    expect(formatAge('2026-06-01T12:00:00Z')).toBe('just now');
  });

  it('returns "Nm ago" when age is in minutes (< 1 hour)', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-01T12:05:00Z').getTime();
    vi.setSystemTime(now);
    expect(formatAge('2026-06-01T12:00:00Z')).toBe('5m ago');
  });

  it('returns "Nh ago" when age is in hours (< 1 day)', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-01T15:00:00Z').getTime();
    vi.setSystemTime(now);
    expect(formatAge('2026-06-01T12:00:00Z')).toBe('3h ago');
  });

  it('returns "Nd ago" when age is in days', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-04T12:00:00Z').getTime();
    vi.setSystemTime(now);
    expect(formatAge('2026-06-01T12:00:00Z')).toBe('3d ago');
  });
});
