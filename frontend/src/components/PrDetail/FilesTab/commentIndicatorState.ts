import type { ReviewThreadDto } from '../../../api/types';

// Three visual states collapse to two map values (absent key ⇒ 'none').
export type CommentIndicatorState = 'unresolved' | 'resolved';

// A path is 'unresolved' if ANY thread on it is open, else 'resolved' (it has
// threads and every one is resolved). Unresolved wins on mixed: once set it is
// never downgraded, and a later open thread upgrades a resolved entry.
export function deriveCommentStateByPath(
  threads: ReviewThreadDto[],
): Map<string, CommentIndicatorState> {
  const m = new Map<string, CommentIndicatorState>();
  for (const t of threads) {
    if (!t.isResolved) {
      m.set(t.filePath, 'unresolved');
    } else if (m.get(t.filePath) !== 'unresolved') {
      m.set(t.filePath, 'resolved');
    }
  }
  return m;
}
