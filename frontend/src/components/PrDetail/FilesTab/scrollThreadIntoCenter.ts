/**
 * Centers `target` within the scrollable `container` (the diff-pane body), mirroring
 * useChangeNavigation's reference-frame-agnostic offset math. Honors prefers-reduced-motion.
 * Never uses element.scrollIntoView (unused in this codebase, absent in jsdom). (#774)
 */
export function scrollThreadIntoCenter(container: HTMLElement, target: HTMLElement): void {
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  const targetTop = tRect.top - cRect.top + container.scrollTop;
  const centered = targetTop - container.clientHeight / 2 + tRect.height / 2;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(maxTop, Math.max(0, centered));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  container.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}
