import { test, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import {
  useSlotScrollMemory,
  isSlotScrollSubTab,
  _clearSlotScrollStoreForTest,
} from './slotScrollMemory';

// jsdom's scrollTop getter returns 0 and ignores writes, and scrollHeight/
// clientHeight are always 0. Override them so the capture listener's reads/writes
// and its "is the slot a bounded scroller?" guard are observable. Defaults make the
// slot a bounded scroller (scrollHeight 2464 > clientHeight 352).
function makeWritableScrollTop(el: HTMLElement, bounded = true): void {
  Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: 2464, writable: true, configurable: true });
  Object.defineProperty(el, 'clientHeight', {
    value: bounded ? 352 : 2464,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  _clearSlotScrollStoreForTest();
});

// Harness mirroring the real wiring: a PrDetailView-like root (carries pageRef and
// the hook) containing one or more `[data-subtab]` slots. `active` toggles the
// keep-alive activation; `subTab` is the effectiveSubTab driving which slot is the
// scroller. Under real keep-alive every visited slot stays mounted, so the harness
// renders all requested slots at once and the hook targets `[data-subtab="<subTab>"]`.
function Harness({
  refKey,
  subTab,
  active,
  slots = ['overview'],
  refs,
}: {
  refKey: string;
  subTab: string;
  active: boolean;
  slots?: string[];
  refs?: Record<string, HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useSlotScrollMemory({ rootRef, refKey, subTab, active });
  return (
    <div ref={rootRef}>
      {slots.map((id) => (
        <div
          key={id}
          data-subtab={id}
          ref={(el) => {
            if (el) makeWritableScrollTop(el);
            if (refs) refs[id] = el;
          }}
        />
      ))}
    </div>
  );
}

function getSlot(id = 'overview'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-subtab="${id}"]`);
  if (!el) throw new Error(`slot ${id} not rendered`);
  return el;
}

test('exposes isSlotScrollSubTab matching the marker allow-list (overview/hotspots/checks)', () => {
  expect(isSlotScrollSubTab('overview')).toBe(true);
  expect(isSlotScrollSubTab('hotspots')).toBe(true);
  expect(isSlotScrollSubTab('checks')).toBe(true);
  expect(isSlotScrollSubTab('files')).toBe(false);
  expect(isSlotScrollSubTab('drafts')).toBe(false);
});

test('restores the captured slot scrollTop after a deactivate/reactivate round-trip', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  const slot = getSlot();

  // User scrolls the slot; the capture listener records it.
  slot.scrollTop = 1200;
  slot.dispatchEvent(new Event('scroll'));

  // Leave (active=false). In the browser the marker removal clamps scrollTop to 0;
  // simulate that clamp here since jsdom has no layout.
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={false} />);
  slot.scrollTop = 0;

  // Return (active=true) → restore writes the recorded offset back.
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  expect(slot.scrollTop).toBe(1200);
});

test('does not restore a stale offset onto a different PR tab (per-refKey isolation)', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  const slot = getSlot();
  slot.scrollTop = 800;
  slot.dispatchEvent(new Event('scroll'));
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={false} />);
  slot.scrollTop = 0;

  // A different PR tab activates: it has no stored offset, so it must stay at 0.
  rerender(<Harness refKey="acme/api/999" subTab="overview" active={true} />);
  expect(slot.scrollTop).toBe(0);
});

test('keys each sub-tab independently — switching sub-tab restores that tab, re-acquires capture', () => {
  // The slot store key is `${refKey}|${subTab}` (distinct from diffScrollMemory's
  // refKey-only key) because one PR has three independently-scrolled slots. This also
  // proves capture RE-ACQUIRES the listener onto the new slot when subTab changes
  // (the slot is parent-acquired via querySelector, not a stable child bodyRef).
  const refs: Record<string, HTMLElement | null> = {};
  const view = (subTab: string, active: boolean) => (
    <Harness
      refKey="acme/api/7"
      subTab={subTab}
      active={active}
      slots={['overview', 'checks']}
      refs={refs}
    />
  );
  const { rerender } = render(view('overview', true));
  const overview = refs.overview!;
  const checks = refs.checks!;

  // Scroll Overview; captured under acme/api/7|overview.
  overview.scrollTop = 500;
  overview.dispatchEvent(new Event('scroll'));

  // Switch to Checks. Checks has no stored offset → stays at top. (Re-acquire: the
  // capture listener now follows the checks slot.)
  rerender(view('checks', true));
  expect(checks.scrollTop).toBe(0);

  // Scroll Checks; this must be captured (proves the listener moved to the checks slot).
  checks.scrollTop = 300;
  checks.dispatchEvent(new Event('scroll'));

  // Back to Overview → its own 500 is restored, not Checks' 300.
  rerender(view('overview', true));
  expect(overview.scrollTop).toBe(500);

  // Forward to Checks again → its own 300 is restored.
  rerender(view('checks', true));
  expect(checks.scrollTop).toBe(300);
});

test("scopes restore to the activating view's OWN slot when two PR views are mounted (cross-view isolation)", () => {
  // Two kept-alive PrDetailViews are in the DOM at once, each with its own overview
  // slot. useSlotScrollMemory must write the activating view's offset onto ITS OWN
  // slot (via the per-view rootRef), never the first slot in document order. Only two
  // simultaneous slots discriminate a scoped query from an unscoped document.querySelector.
  const refsA: Record<string, HTMLElement | null> = {};
  const refsB: Record<string, HTMLElement | null> = {};
  const view = (aActive: boolean, bActive: boolean) => (
    <>
      <Harness refKey="acme/api/7" subTab="overview" active={aActive} refs={refsA} />
      <Harness refKey="acme/api/999" subTab="overview" active={bActive} refs={refsB} />
    </>
  );
  const { rerender } = render(view(true, false));
  const slotA = refsA.overview!;
  const slotB = refsB.overview!;

  // View B records a 300 offset. (Production hides an inactive view via `hidden`, so
  // its slot can't really scroll; the harness applies no hiding, which lets this
  // dispatch reach the listener. The property under test is rootRef SCOPING.)
  slotB.scrollTop = 300;
  slotB.dispatchEvent(new Event('scroll'));

  // Activate B, deactivate A. B's restore is scoped to B's own rootRef.
  rerender(view(false, true));

  expect(slotB.scrollTop).toBe(300);
  // An unscoped document.querySelector would have matched A's slot (first in document
  // order) and written 300 there; per-view rootRef scoping keeps A untouched at 0.
  expect(slotA.scrollTop).toBe(0);
});

test('a scroll back to the top (0) is preserved, not force-restored to a prior value', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  const slot = getSlot();
  slot.scrollTop = 1200;
  slot.dispatchEvent(new Event('scroll'));
  // User scrolls back to the top — the latest captured value is now 0.
  slot.scrollTop = 0;
  slot.dispatchEvent(new Event('scroll'));
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={false} />);
  slot.scrollTop = 0;
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  expect(slot.scrollTop).toBe(0);
});

test('ignores the clamp-to-0 scroll fired when the slot becomes unbounded (sub-tab switch away)', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  const slot = getSlot();
  slot.scrollTop = 900;
  slot.dispatchEvent(new Event('scroll'));

  // Switch away keeps the slot in the DOM but removes data-detail-active: the slot
  // reflows to unbounded and the browser clamps scrollTop to 0, firing a scroll. That
  // scroll must NOT overwrite the stored 900 (guard: scrollHeight > clientHeight).
  (slot as unknown as { clientHeight: number }).clientHeight = 2464; // == scrollHeight → unbounded
  slot.scrollTop = 0;
  slot.dispatchEvent(new Event('scroll'));

  // Return: slot bounded again; restore must write back the real 900.
  (slot as unknown as { clientHeight: number }).clientHeight = 352;
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={false} />);
  rerender(<Harness refKey="acme/api/7" subTab="overview" active={true} />);
  expect(slot.scrollTop).toBe(900);
});

test('is a no-op for a non-allow-list sub-tab (no capture, no restore)', () => {
  // Files/Drafts are not slot-scrollers (no data-detail-active marker), so the hook
  // must neither capture nor restore for them — leaving today's behavior untouched.
  const { rerender } = render(
    <Harness refKey="acme/api/7" subTab="files" active={true} slots={['files']} />,
  );
  const slot = getSlot('files');
  slot.scrollTop = 750;
  slot.dispatchEvent(new Event('scroll'));
  rerender(<Harness refKey="acme/api/7" subTab="files" active={false} slots={['files']} />);
  slot.scrollTop = 0;
  rerender(<Harness refKey="acme/api/7" subTab="files" active={true} slots={['files']} />);
  // Nothing was captured, so nothing restores — the slot stays at 0.
  expect(slot.scrollTop).toBe(0);
});
