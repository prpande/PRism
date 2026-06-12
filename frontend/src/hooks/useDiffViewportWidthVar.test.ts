import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useDiffViewportWidthVar } from './useDiffViewportWidthVar';

describe('useDiffViewportWidthVar', () => {
  const realResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  afterEach(() => {
    // Always restore the real ResizeObserver, even if a test threw before its own
    // assertion completed — otherwise a mutated global leaks into later tests.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realResizeObserver;
  });

  it('does not throw when ResizeObserver is undefined (jsdom)', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLDivElement>(document.createElement('div'));
        useDiffViewportWidthVar(ref, []);
      });
    }).not.toThrow();
  });

  it('writes the element clientWidth to --diff-viewport-w when ResizeObserver exists', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
    class RO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      RO as unknown as typeof ResizeObserver;
    renderHook(() => {
      const ref = useRef(el);
      useDiffViewportWidthVar(ref, []);
    });
    expect(el.style.getPropertyValue('--diff-viewport-w')).toBe('640px');
  });
});
