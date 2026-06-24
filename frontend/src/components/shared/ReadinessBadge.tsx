import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Reviewer } from '../../api/types';
import { Avatar } from '../Avatar/Avatar';
import {
  isBadgeRendered,
  READINESS_SHORT,
  READINESS_LONG,
  READINESS_TOOLTIP,
  READINESS_TONE,
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
  // #593 — reviewer name-lists for the popover people section. Absent/empty rows are suppressed.
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
}

const TONE_CLASS: Record<'success' | 'warning' | 'danger', string> = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
};

// Bare stroke glyph per state (24-viewBox, currentColor). NONE shares a shape with the bare CI
// (check/cross/dot) or PR-state (git) glyphs — readiness is its own family (#593).
function glyphInner(r: MergeReadiness) {
  switch (r) {
    case 'ready':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.4 2.4 2.4 4.6-5.2" />
        </>
      );
    case 'ready-with-changes-requested':
    case 'changes-requested':
      // message-warning — the caveat (green) is the same glyph as changes-requested (red).
      return (
        <>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M12 7v3" />
          <path d="M12 13h.01" />
        </>
      );
    case 'review-required':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      );
    case 'behind-base':
      return (
        <>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v5h-5" />
        </>
      );
    case 'blocked-by-protection':
      return (
        <>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </>
      );
    case 'unstable':
      return (
        <>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      );
    case 'conflicts':
      return (
        <>
          <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </>
      );
    default:
      return null;
  }
}

function ReadinessGlyph({ readiness }: { readiness: MergeReadiness }) {
  return (
    <svg
      className={styles.glyphSvg}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyphInner(readiness)}
    </svg>
  );
}

// Count-only fallback line, used in the popover foot ONLY when no named reviewer lists are present
// (older payloads / route-mock fixtures). When names are available the people section replaces it.
function countsLine(approvals?: number | null, changes?: number | null): string | null {
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

function PeopleRole({ label, people }: { label: string; people?: Reviewer[] | null }) {
  if (!people || people.length === 0) return null;
  return (
    <>
      <span className={styles.role}>{label}</span>
      <span className={styles.who}>
        {people.map((p) => (
          <span className={styles.nm} key={`${label}-${p.login}`}>
            <Avatar src={p.avatarUrl} login={p.login} size="sm" />
            {p.login}
          </span>
        ))}
      </span>
    </>
  );
}

export function ReadinessBadge({
  readiness,
  variant,
  id,
  approvals,
  changesRequested,
  updatedAt,
  approvers,
  changesRequestedBy,
  awaitingReviewers,
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

  const tone = READINESS_TONE[readiness];
  const toneClass = tone ? TONE_CLASS[tone] : '';
  const hasPeople =
    (approvers?.length ?? 0) > 0 ||
    (changesRequestedBy?.length ?? 0) > 0 ||
    (awaitingReviewers?.length ?? 0) > 0;
  const counts = countsLine(approvals, changesRequested);
  const age = ageLine(updatedAt);
  const showCountsFallback = !hasPeople && counts != null;

  return (
    <span className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${toneClass} ${variant === 'expanded' ? styles.expanded : styles.compact}`}
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
        <ReadinessGlyph readiness={readiness} />
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
            <div className={`${styles.accent} ${toneClass}`} />
            <div className={`${styles.head} ${toneClass}`}>
              <ReadinessGlyph readiness={readiness} />
              {READINESS_LONG[readiness]}
            </div>
            <div className={styles.reason}>{READINESS_TOOLTIP[readiness]}</div>
            {hasPeople && (
              <div className={styles.people}>
                <PeopleRole label="Approved" people={approvers} />
                <PeopleRole label="Changes by" people={changesRequestedBy} />
                <PeopleRole label="Waiting on" people={awaitingReviewers} />
              </div>
            )}
            {(showCountsFallback || age) && (
              <div className={styles.foot}>
                {showCountsFallback && <div>{counts}</div>}
                {age && <div>{age}</div>}
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
