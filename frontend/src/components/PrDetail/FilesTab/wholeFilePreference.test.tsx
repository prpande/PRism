// wholeFilePreference.test.tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWholeFilePreference, deriveWholeFileEnabled } from './wholeFilePreference';

const base = {
  showFullFile: true,
  failedPaths: new Set<string>(),
  selectedPath: 'a.ts',
  selectedFileStatus: 'modified' as string | undefined,
  selectedFileHunkCount: 3,
  iterationGatePermits: true,
};

describe('deriveWholeFileEnabled', () => {
  it('is true when the global pref is on and the file is eligible', () => {
    expect(deriveWholeFileEnabled(base)).toBe(true);
  });
  it('is false when the global pref is off', () => {
    expect(deriveWholeFileEnabled({ ...base, showFullFile: false })).toBe(false);
  });
  it('is false for a failed path, an ineligible status, no hunks, or a blocked view', () => {
    expect(deriveWholeFileEnabled({ ...base, failedPaths: new Set(['a.ts']) })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, selectedFileStatus: 'added' })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, selectedFileHunkCount: 0 })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, iterationGatePermits: false })).toBe(false);
  });
  it('stays true across a selectedPath change to another eligible file (view-wide)', () => {
    expect(deriveWholeFileEnabled({ ...base, selectedPath: 'b.ts' })).toBe(true);
  });
});

describe('useWholeFilePreference', () => {
  it('toggles the boolean via setShowFullFile', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    expect(result.current.showFullFile).toBe(false);
    act(() => result.current.setShowFullFile(true));
    expect(result.current.showFullFile).toBe(true);
  });
  it('records a failed path and clears it on re-enable (false -> true)', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    act(() => result.current.setShowFullFile(true));
    act(() => result.current.markFailed('a.ts'));
    expect(result.current.failedPaths.has('a.ts')).toBe(true);
    act(() => result.current.setShowFullFile(false));
    act(() => result.current.setShowFullFile(true)); // retry affordance
    expect(result.current.failedPaths.has('a.ts')).toBe(false);
  });
  it('does not clear failed paths when set to true while already true', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    act(() => result.current.setShowFullFile(true));
    act(() => result.current.markFailed('a.ts'));
    act(() => result.current.setShowFullFile(true)); // no false->true transition inside the set itself
    expect(result.current.failedPaths.has('a.ts')).toBe(true);
  });
  it('#510: clearFailed retries one path without disturbing others or the global pref', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    act(() => result.current.setShowFullFile(true));
    act(() => result.current.markFailed('a.ts'));
    act(() => result.current.markFailed('b.ts'));
    act(() => result.current.clearFailed('a.ts'));
    expect(result.current.failedPaths.has('a.ts')).toBe(false); // retried
    expect(result.current.failedPaths.has('b.ts')).toBe(true); // untouched
    expect(result.current.showFullFile).toBe(true); // global pref unchanged
  });
});
