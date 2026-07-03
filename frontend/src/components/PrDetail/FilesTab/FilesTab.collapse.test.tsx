import { describe, it, expect } from 'vitest';
import { effectiveCollapsed, nextOverrides, clearOverride } from './FilesTab';

describe('FilesTab collapse model', () => {
  it('default: resolved collapsed, unresolved expanded (empty overrides)', () => {
    expect(effectiveCollapsed({}, 't1', true)).toBe(true);
    expect(effectiveCollapsed({}, 't2', false)).toBe(false);
  });
  it('explicit override wins over the resolved default', () => {
    expect(effectiveCollapsed({ t1: false }, 't1', true)).toBe(false);
    expect(effectiveCollapsed({ t2: true }, 't2', false)).toBe(true);
  });
  it('toggle flips the effective state and records it', () => {
    expect(nextOverrides({}, 't2', false)).toEqual({ t2: true });
    expect(nextOverrides({}, 't1', true)).toEqual({ t1: false });
    expect(nextOverrides({ t1: false }, 't1', true)).toEqual({ t1: true });
  });
  it('override is sticky and not cleared when isResolved later differs', () => {
    expect(effectiveCollapsed({ t1: false }, 't1', true)).toBe(false);
  });
  it('clearOverride removes the key so effectiveCollapsed falls back to isResolved', () => {
    expect(clearOverride({ t1: false }, 't1')).toEqual({});
    expect(effectiveCollapsed(clearOverride({ t1: false }, 't1'), 't1', true)).toBe(true);
  });
  it('clearOverride on an absent key returns the same object reference (no needless re-render)', () => {
    const m = { t2: true };
    expect(clearOverride(m, 't1')).toBe(m);
  });
});
