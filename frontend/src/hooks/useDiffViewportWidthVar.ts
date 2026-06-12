import { useEffect } from 'react';
import type { RefObject } from 'react';

// #390 — write the diff body's visible inner width to `--diff-viewport-w` so the
// sticky comment/composer wrapper can size to the viewport, not the over-wide
// table. Mirrors useLockedPaneScroll's jsdom guard (no ResizeObserver in tests).
export function useDiffViewportWidthVar(
  bodyRef: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const apply = (): void => {
      body.style.setProperty('--diff-viewport-w', `${body.clientWidth}px`);
    };
    apply();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => apply());
    ro.observe(body);
    return () => {
      ro.disconnect();
      body.style.removeProperty('--diff-viewport-w');
    };
    // `deps` lets DiffPane re-measure on file / mode / wrap / content-height
    // change (a vertical scrollbar appearing shrinks clientWidth — a
    // ResizeObserver blind spot).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied ...deps re-measure key (#331)
  }, [bodyRef, ...deps]);
}
