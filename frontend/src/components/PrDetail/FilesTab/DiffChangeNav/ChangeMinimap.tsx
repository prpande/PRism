import { useEffect, useRef, useState } from 'react';
import styles from './ChangeMinimap.module.css';
import type { ChangeTick } from './diffChanges';

// Hover-intent close delay: the bar opens immediately on pointer-enter but
// lingers this long after the pointer leaves before collapsing. A pure CSS
// `:hover` snaps shut the instant the pointer crosses the (narrow) bar edge,
// which feels twitchy and makes the widened bar an unstable click target. The
// grace period keeps it open through small strays and re-entries (#486 review).
const HOVER_CLOSE_MS = 350;

export interface ChangeMinimapProps {
  ticks: ChangeTick[];
  viewport: { topPct: number; heightPct: number };
  onGoToChange: (i: number) => void;
  onScrollToRatio: (r: number) => void;
  // Width of the scroll container's vertical scrollbar. The rail anchors its
  // right edge this far in from the body's edge so it sits just left of the
  // scrollbar — even expanded on hover it never covers (and blocks) it.
  scrollbarW?: number;
}

export function ChangeMinimap({
  ticks,
  viewport,
  onGoToChange,
  onScrollToRatio,
  scrollbarW = 0,
}: ChangeMinimapProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // The hovered index is local state, so it can outlive the tick it points at:
  // navigating to a shorter file with j/k (no mouseleave) shrinks `ticks` while
  // `hovered` stays put. Guard reads against the current length so a stale index
  // never dereferences past the end; the next hover resets it.
  const hoveredTick = hovered !== null ? (ticks[hovered] ?? null) : null;

  // Expanded (widened) state, driven by hover-intent rather than CSS `:hover` so
  // it lingers briefly after the pointer leaves and the whole widened bar — not
  // just the rest-width sliver — is the live target while it is open.
  const [expanded, setExpanded] = useState(false);
  const closeTimer = useRef(0);
  const openRail = () => {
    window.clearTimeout(closeTimer.current);
    setExpanded(true);
  };
  const closeRailSoon = () => {
    if (dragRef.current) return; // never collapse mid-drag
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setExpanded(false), HOVER_CLOSE_MS);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Drag-to-scrub: the rail doubles as a scroll slider (it replaces the native
  // scrollbar in whole-file mode). A press on a gap jumps there at once and then
  // tracks the pointer (scrollbar feel); a press on a tick stays a click-to-jump
  // unless it turns into a drag. `suppressClick` swallows the click the browser
  // fires after a drag so it doesn't jump/scrub a second time (#486 review).
  const dragRef = useRef<{ id: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const scrubTo = (clientY: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const r = (clientY - rect.top) / rect.height;
    onScrollToRatio(Math.min(1, Math.max(0, r)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const isTick = (e.target as HTMLElement).dataset.tick !== undefined;
    dragRef.current = { id: e.pointerId, moved: false };
    openRail();
    const rail = railRef.current;
    if (rail?.setPointerCapture) {
      try {
        rail.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / unsupported */
      }
    }
    // Press on the empty rail jumps there immediately; a press on a tick waits to
    // see whether it becomes a drag (so a plain tick click still jumps).
    if (!isTick) scrubTo(e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    d.moved = true;
    scrubTo(e.clientY);
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    if (d.moved) suppressClick.current = true;
    dragRef.current = null;
    const rail = railRef.current;
    if (rail?.releasePointerCapture) {
      try {
        rail.releasePointerCapture(e.pointerId);
      } catch {
        /* jsdom / unsupported */
      }
    }
    // Pointer capture suppresses the mouseleave that normally starts the collapse,
    // so if the drag ended off the rail, begin the grace timer here.
    if (rail) {
      const r = rail.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeRailSoon();
    }
  };

  const onRailClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return; // tail of a drag — already handled
    }
    // Only when the empty rail (not a tick) is clicked.
    if ((e.target as HTMLElement).dataset.tick !== undefined) return;
    scrubTo(e.clientY);
  };

  return (
    <div
      ref={railRef}
      className={expanded ? `${styles.rail} ${styles.expanded}` : styles.rail}
      data-testid="change-minimap"
      data-expanded={expanded ? 'true' : undefined}
      style={{ right: scrollbarW }}
      aria-hidden="true"
      onClick={onRailClick}
      onMouseEnter={openRail}
      onMouseLeave={closeRailSoon}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className={styles.viewport}
        data-testid="change-minimap-viewport"
        style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }}
      />
      {ticks.map((t, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          data-tick=""
          data-testid="change-tick"
          data-kind={t.kind}
          className={styles.tick}
          style={{ top: `${t.topPct}%`, height: `max(3px, ${t.heightPct}%)` }}
          onClick={() => {
            if (suppressClick.current) return; // tail of a drag — not a jump
            onGoToChange(i);
          }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
        />
      ))}
      {hovered !== null && hoveredTick && (
        <div className={styles.tooltip} style={{ top: `${hoveredTick.topPct}%` }}>
          change {hovered + 1} of {ticks.length} · L{hoveredTick.startLineNum} · +
          {hoveredTick.addCount} −{hoveredTick.delCount}
        </div>
      )}
    </div>
  );
}
