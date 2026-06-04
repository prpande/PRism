import { test, expect, afterEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { useTabScrollMemory, _clearStoreForTest } from './useTabScrollMemory';

// Creates and appends a [data-app-scroll] div with a writable scrollTop.
// jsdom's scrollTop getter always returns 0 and ignores writes; we override it
// so the hook's reads and writes are actually observable.
function makeScrollSlot(): HTMLDivElement {
  const slot = document.createElement('div');
  slot.setAttribute('data-app-scroll', 'true');
  Object.defineProperty(slot, 'scrollTop', { value: 0, writable: true });
  document.body.appendChild(slot);
  return slot;
}

// Remove all [data-app-scroll] elements between tests so no stale slot leaks,
// and reset the hook's module-level store so a saved offset from one test can't
// bleed into the next (the store outlives individual tests within this file).
afterEach(() => {
  document.querySelectorAll('[data-app-scroll]').forEach((el) => el.remove());
  _clearStoreForTest();
});

// Tiny component for the cross-view race test. Uses the hook's default
// slotSelector so it resolves to the slot created by makeScrollSlot().
function Mem({ prRefKey, active }: { prRefKey: string; active: boolean }) {
  useTabScrollMemory({ prRefKey, subTab: 'files', active });
  return null;
}

test('restores saved scrollTop for a (tab, subTab) on activation', () => {
  const slot = document.createElement('div');
  slot.setAttribute('data-app-scroll', 'true');
  document.body.appendChild(slot);
  Object.defineProperty(slot, 'scrollTop', { value: 0, writable: true });

  const h = renderHook(
    ({ active, subTab }) =>
      useTabScrollMemory({
        prRefKey: 'acme/api/7',
        subTab,
        active,
        slotSelector: '[data-app-scroll]',
      }),
    { initialProps: { active: true, subTab: 'files' as const } },
  );

  slot.scrollTop = 300;
  h.rerender({ active: false, subTab: 'files' }); // deactivate → saves 300
  slot.scrollTop = 0; // another tab scrolled to top
  h.rerender({ active: true, subTab: 'files' }); // reactivate → restores 300
  expect(slot.scrollTop).toBe(300);
});

// Round-2 race guard: two views sharing the scroller, the INCOMING view earlier
// in render order than the OUTGOING. The outgoing view's offset must survive.
test('cross-view swap preserves the outgoing offset regardless of render order', () => {
  const slot = makeScrollSlot();
  const { rerender } = render(
    <>
      <Mem prRefKey="acme/api/8" active={false} />
      <Mem prRefKey="acme/api/7" active={true} />
    </>,
  );
  slot.scrollTop = 420;
  rerender(
    <>
      <Mem prRefKey="acme/api/8" active={true} />
      <Mem prRefKey="acme/api/7" active={false} />
    </>,
  );
  rerender(
    <>
      <Mem prRefKey="acme/api/8" active={false} />
      <Mem prRefKey="acme/api/7" active={true} />
    </>,
  );
  expect(slot.scrollTop).toBe(420);
});
