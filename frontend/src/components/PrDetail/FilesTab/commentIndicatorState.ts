import type { ReviewThreadDto } from '../../../api/types';

// Three visual states collapse to two map values (absent key ⇒ 'none').
export type CommentIndicatorState = 'unresolved' | 'resolved';

// A path is 'unresolved' if ANY thread on it is open, else 'resolved' (it has
// threads and every one is resolved). Unresolved wins on mixed: once set it is
// never downgraded, and a later open thread upgrades a resolved entry. Only
// anchored threads (lineNumber != null) are considered (#773) — an outdated or
// file-level thread isn't findable in this file's diff.
export function deriveCommentStateByPath(
  threads: ReviewThreadDto[],
): Map<string, CommentIndicatorState> {
  const m = new Map<string, CommentIndicatorState>();
  for (const t of threads) {
    if (t.lineNumber == null) continue; // unanchored (outdated/file-level) — not findable in this file's diff (#773)
    if (!t.isResolved) {
      m.set(t.filePath, 'unresolved');
    } else if (m.get(t.filePath) !== 'unresolved') {
      m.set(t.filePath, 'resolved');
    }
  }
  return m;
}

// Per-file thread tallies for the comment-glyph hover tooltip (#513). The glyph itself
// stays count-free (three visual states, owner-directed); the counts surface only on
// hover. `open` = unresolved threads, `resolved` = resolved threads. A path appears iff
// it has ≥1 anchored thread. Threads (conversations), not individual comment messages,
// are the unit — resolution is a per-thread property. Only anchored threads
// (lineNumber != null) are tallied (#773) — an outdated or file-level thread isn't
// findable in this file's diff. Kept a separate pass from the state map (both are
// single loops over a small array) so the well-tested state derivation that drives the
// visual class and sr-only text is untouched.
export interface CommentCounts {
  open: number;
  resolved: number;
}

export function deriveCommentCountsByPath(threads: ReviewThreadDto[]): Map<string, CommentCounts> {
  const m = new Map<string, CommentCounts>();
  for (const t of threads) {
    if (t.lineNumber == null) continue; // unanchored (outdated/file-level) — not findable in this file's diff (#773)
    const c = m.get(t.filePath) ?? { open: 0, resolved: 0 };
    if (t.isResolved) c.resolved += 1;
    else c.open += 1;
    m.set(t.filePath, c);
  }
  return m;
}

// Tooltip wording (owner-approved): unresolved file → "2 unresolved · 1 resolved"
// (drop the resolved half when zero); all-resolved file → "3 resolved". The noun is
// implied, so no singular/plural handling is needed.
export function commentTooltip(c: CommentCounts): string {
  if (c.open > 0) {
    return c.resolved > 0
      ? `${c.open} unresolved · ${c.resolved} resolved`
      : `${c.open} unresolved`;
  }
  return `${c.resolved} resolved`;
}
