import { test, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import {
  useDiffScrollCapture,
  useDiffScrollRestore,
  _clearDiffScrollStoreForTest,
} from './diffScrollMemory';

// jsdom's scrollTop getter returns 0 and ignores writes, and scrollHeight/
// clientHeight are always 0. Override them so the capture listener's reads/writes
// and its "is the body a bounded scroller?" guard are observable. Defaults make the
// body a bounded scroller (scrollHeight 2464 > clientHeight 352).
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
  _clearDiffScrollStoreForTest();
});

// Harness mirroring the real wiring: a PrDetailView-like root (carries the restore
// hook) containing a DiffPane-like body (carries the capture hook). `active` toggles
// the keep-alive hide/show; `bodyPresent` mirrors DiffPane's final-branch guard.
function Harness({
  refKey,
  active,
  bodyPresent = true,
  bodyRefOut,
}: {
  refKey: string;
  active: boolean;
  bodyPresent?: boolean;
  bodyRefOut?: (el: HTMLElement | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useDiffScrollRestore({ rootRef, refKey, subTab: 'files', active });
  useDiffScrollCapture(bodyRef, refKey, bodyPresent);
  return (
    <div ref={rootRef}>
      {bodyPresent && (
        <div
          className="diff-pane-body"
          ref={(el) => {
            bodyRef.current = el;
            if (el) makeWritableScrollTop(el);
            bodyRefOut?.(el);
          }}
        />
      )}
    </div>
  );
}

function getBody(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.diff-pane-body');
  if (!el) throw new Error('diff body not rendered');
  return el;
}

test('restores the captured diff scrollTop after a deactivate/reactivate round-trip', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" active={true} />);
  const body = getBody();

  // User scrolls the diff; the capture listener records it.
  body.scrollTop = 1200;
  body.dispatchEvent(new Event('scroll'));

  // Leave (active=false). In the browser the marker removal clamps scrollTop to 0;
  // simulate that clamp here since jsdom has no layout.
  rerender(<Harness refKey="acme/api/7" active={false} />);
  body.scrollTop = 0;

  // Return (active=true) → restore writes the recorded offset back.
  rerender(<Harness refKey="acme/api/7" active={true} />);
  expect(body.scrollTop).toBe(1200);
});

test('does not restore a stale offset onto a different PR tab (per-key isolation)', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" active={true} />);
  const body = getBody();
  body.scrollTop = 800;
  body.dispatchEvent(new Event('scroll'));
  rerender(<Harness refKey="acme/api/7" active={false} />);
  body.scrollTop = 0;

  // A different PR tab activates: it has no stored offset, so it must stay at 0.
  rerender(<Harness refKey="acme/api/999" active={true} />);
  expect(body.scrollTop).toBe(0);
});

test("scopes restore to the activating view's OWN body when two PR views are mounted (cross-tab isolation)", () => {
  // Two kept-alive PrDetailViews are in the DOM at once, each with its own
  // .diff-pane-body. useDiffScrollRestore must write the activating view's offset
  // onto ITS OWN body (via the per-view rootRef), never the first body in document
  // order. A single-view test cannot prove this — with one body present an UNSCOPED
  // document.querySelector passes too; only two simultaneous bodies discriminate.
  const bodies: { a: HTMLElement | null; b: HTMLElement | null } = { a: null, b: null };
  const view = (aActive: boolean, bActive: boolean) => (
    <>
      <Harness refKey="acme/api/7" active={aActive} bodyRefOut={(el) => (bodies.a = el)} />
      <Harness refKey="acme/api/999" active={bActive} bodyRefOut={(el) => (bodies.b = el)} />
    </>
  );
  const { rerender } = render(view(true, false));
  const bodyA = bodies.a;
  const bodyB = bodies.b;
  if (!bodyA || !bodyB) throw new Error('both diff bodies must render');

  // View B records a 300 offset. (In production an inactive view is hidden via
  // `hidden={!active}` so its body can't actually scroll; the Harness applies no
  // hiding, which is what lets this dispatch reach the listener. That's fine —
  // the property under test here is rootRef SCOPING, not event suppression.)
  bodyB.scrollTop = 300;
  bodyB.dispatchEvent(new Event('scroll'));

  // Activate B, deactivate A. B's restore is scoped to B's own rootRef.
  rerender(view(false, true));

  // B restored its OWN body to 300...
  expect(bodyB.scrollTop).toBe(300);
  // ...and did NOT write onto A's body. An unscoped document.querySelector would
  // have matched A's body (first in document order) and written 300 there; the
  // per-view rootRef scoping is exactly what keeps A untouched at 0.
  expect(bodyA.scrollTop).toBe(0);
});

test('a scroll back to the top (0) is preserved, not force-restored to a prior value', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" active={true} />);
  const body = getBody();
  body.scrollTop = 1200;
  body.dispatchEvent(new Event('scroll'));
  // User scrolls back to the top — the latest captured value is now 0.
  body.scrollTop = 0;
  body.dispatchEvent(new Event('scroll'));
  rerender(<Harness refKey="acme/api/7" active={false} />);
  body.scrollTop = 0;
  rerender(<Harness refKey="acme/api/7" active={true} />);
  expect(body.scrollTop).toBe(0);
});

test('ignores the clamp-to-0 scroll fired when the body becomes unbounded (sub-tab switch)', () => {
  const { rerender } = render(<Harness refKey="acme/api/7" active={true} />);
  const body = getBody();
  body.scrollTop = 900;
  body.dispatchEvent(new Event('scroll'));

  // Sub-tab switch away keeps the view displayed but removes the marker: the body
  // reflows to unbounded and the browser clamps scrollTop to 0, firing a scroll.
  // That scroll must NOT overwrite the stored 900.
  (body as unknown as { clientHeight: number }).clientHeight = 2464; // == scrollHeight → unbounded
  body.scrollTop = 0;
  body.dispatchEvent(new Event('scroll'));

  // Return to Files: body bounded again; restore must write back the real 900.
  (body as unknown as { clientHeight: number }).clientHeight = 352;
  rerender(<Harness refKey="acme/api/7" active={false} />);
  rerender(<Harness refKey="acme/api/7" active={true} />);
  expect(body.scrollTop).toBe(900);
});

test('captures even when the diff body appears AFTER first activation (late load)', () => {
  // First render with no body (loading skeleton): no listener can attach yet.
  const { rerender } = render(<Harness refKey="acme/api/7" active={true} bodyPresent={false} />);
  expect(document.querySelector('.diff-pane-body')).toBeNull();

  // Diff loads → body appears; capture must (re)acquire it via the bodyPresent dep.
  rerender(<Harness refKey="acme/api/7" active={true} bodyPresent={true} />);
  const body = getBody();
  body.scrollTop = 640;
  body.dispatchEvent(new Event('scroll'));

  rerender(<Harness refKey="acme/api/7" active={false} bodyPresent={true} />);
  body.scrollTop = 0;
  rerender(<Harness refKey="acme/api/7" active={true} bodyPresent={true} />);
  expect(body.scrollTop).toBe(640);
});
