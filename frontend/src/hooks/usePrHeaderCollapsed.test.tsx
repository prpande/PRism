import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { usePrHeaderCollapsed, _clearStoreForTest } from './usePrHeaderCollapsed';

afterEach(() => _clearStoreForTest());

describe('usePrHeaderCollapsed', () => {
  test('defaults to expanded (false)', () => {
    const { result } = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(result.current[0]).toBe(false);
  });

  test('toggle flips the flag', () => {
    const { result } = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
  });

  test('a fresh mount with the same key reads the persisted value', () => {
    const first = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => first.result.current[1]());
    const second = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(second.result.current[0]).toBe(true);
  });

  test('state is per-key', () => {
    const a = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => a.result.current[1]());
    const b = renderHook(() => usePrHeaderCollapsed('acme/api/2'));
    expect(b.result.current[0]).toBe(false);
  });

  test('_clearStoreForTest resets persistence', () => {
    const a = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => a.result.current[1]());
    _clearStoreForTest();
    const b = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(b.result.current[0]).toBe(false);
  });
});
