import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens } from './formatUsage';

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
