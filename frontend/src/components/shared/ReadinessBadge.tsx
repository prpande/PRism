import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  isBadgeRendered,
  READINESS_SHORT,
  READINESS_LONG,
  READINESS_TOOLTIP,
  READINESS_CHIP_CLASS,
  type MergeReadiness,
} from './mergeReadiness';
import { ReadinessTooltipCtxRaw, useReadinessTooltip } from './ReadinessTooltipContext';
import styles from './ReadinessBadge.module.css';

const HOVER_OPEN_MS = 300;

interface ReadinessBadgeProps {
  readiness: MergeReadiness;
  variant: 'compact' | 'expanded';
  id: string;
  approvals?: number | null;
  changesRequested?: number | null;
  updatedAt?: string | null;
}

function countsLine(approvals?: number | null, changes?: number | null): string | null {
  // Suppress the whole line when both are unavailable (review-only PR -> null counts).
  if (approvals == null && changes == null) return null;
  const parts: string[] = [];
  if ((changes ?? 0) > 0) parts.push(`Changes requested by ${changes}`);
  if ((approvals ?? 0) > 0) parts.push(`${approvals} approval${approvals === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

function ageLine(updatedAt?: string | null): string | null {
  if (!updatedAt) return null;
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  // Sanity floor: a default/min DateTimeOffset (0001-01-01) leaking from a non-parser Pr
  // construction site would render an absurd "Updated 738000d ago". Suppress beyond ~10y.
  if (mins > 10 * 365 * 24 * 60) return null;
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  return `Updated ${Math.round(hrs / 24)}d ago`;
}

export function ReadinessBadge({
  readiness,
  variant,
  id,
  approvals,
  changesRequested,
  updatedAt,
}: ReadinessBadgeProps) {
  const ctx = useContext(ReadinessTooltipCtxRaw);
  const { openId, setOpenId } = useReadinessTooltip();

  // When there is no provider, ctx is null — fall back to local open state so
  // the badge works in isolation (singleton coordination is inert, but open/close works).
  const [localOpen, setLocalOpen] = useState(false);
  const inProvider = ctx !== null;

  // Open state: singleton-driven inside provider, local-driven outside.
  const open = inProvider ? openId === id : localOpen;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const describedById = useId();

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 6, left: r.left });
  }, []);

  const openNow = useCallback(() => {
    place();
    if (inProvider) {
      setOpenId(id);
    } else {
      setLocalOpen(true);
    }
  }, [id, inProvider, place, setOpenId]);

  const close = useCallback(() => {
    if (inProvider) {
      if (openId === id) setOpenId(null);
    } else {
      setLocalOpen(false);
    }
  }, [id, inProvider, openId, setOpenId]);

  // Close if this badge's state collapses to a no-badge state while open (spec §6).
  useEffect(() => {
    if (open && !isBadgeRendered(readiness)) {
      if (inProvider) {
        setOpenId(null);
      } else {
        setLocalOpen(false);
      }
    }
  }, [open, readiness, inProvider, setOpenId]);

  // While open, dismiss on scroll/resize (non-interactive popover; simplest clip-safe choice) —
  // BUT not when the trigger holds keyboard focus: a keyboard user who arrow-scrolls the inbox
  // would otherwise lose the tooltip's announced description while the element stays focused.
  // Pointer-driven open always closes on scroll (the pointer has left the trigger).
  useEffect(() => {
    if (!open) return;
    const onScrollResize = () => {
      if (document.activeElement === triggerRef.current) return; // keyboard-focused: keep open
      if (inProvider) {
        setOpenId(null);
      } else {
        setLocalOpen(false);
      }
    };
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [open, inProvider, setOpenId]);

  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  if (!isBadgeRendered(readiness)) return null;

  const label = variant === 'compact' ? READINESS_SHORT[readiness] : READINESS_LONG[readiness];
  const showDot = readiness === 'ready-with-changes-requested';
  const counts = countsLine(approvals, changesRequested);
  const age = ageLine(updatedAt);

  return (
    <span className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={`chip ${READINESS_CHIP_CLASS[readiness]} ${styles.trigger}`}
        data-readiness={readiness}
        aria-label={`Merge readiness: ${READINESS_SHORT[readiness]}`}
        aria-describedby={open ? describedById : undefined}
        onMouseEnter={() => {
          hoverTimer.current = window.setTimeout(openNow, HOVER_OPEN_MS);
        }}
        onMouseLeave={() => {
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          close();
        }}
        onFocus={openNow}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        {showDot && <span className={styles.dot} data-readiness-dot aria-hidden="true" />}
        {label}
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            id={describedById}
            role="tooltip"
            className={styles.popover}
            style={{ top: coords.top, left: coords.left }}
          >
            <div className={styles.reasonRow}>
              <span className={`chip ${READINESS_CHIP_CLASS[readiness]}`}>
                {READINESS_LONG[readiness]}
              </span>
            </div>
            <div className={styles.oneLiner}>{READINESS_TOOLTIP[readiness]}</div>
            {counts && <div className={styles.fact}>{counts}</div>}
            {age && <div className={styles.fact}>{age}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}
