import type { TimelineEvent } from '../../../../api/types';

export type FeedNode =
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'commit-group'; commits: TimelineEvent[]; collapsedByDefault: boolean };

export const COMMIT_GROUP_THRESHOLD = 5;

/**
 * Collapse maximal runs of consecutive `pushed` events (input is newest-first) into a single
 * commit-group node. Runs longer than `threshold` default to collapsed. Non-commit events pass
 * through unchanged. Comments are never grouped (they carry conversation content).
 */
export function groupCommitRuns(
  events: TimelineEvent[],
  threshold: number = COMMIT_GROUP_THRESHOLD,
): FeedNode[] {
  const nodes: FeedNode[] = [];
  let run: TimelineEvent[] = [];

  const flush = () => {
    if (run.length === 0) return;
    nodes.push({ kind: 'commit-group', commits: run, collapsedByDefault: run.length > threshold });
    run = [];
  };

  for (const event of events) {
    if (event.verb === 'pushed') {
      run.push(event);
    } else {
      flush();
      nodes.push({ kind: 'event', event });
    }
  }
  flush();
  return nodes;
}
