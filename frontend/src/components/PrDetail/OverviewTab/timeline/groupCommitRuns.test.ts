import { describe, it, expect } from 'vitest';
import { groupCommitRuns } from './groupCommitRuns';
import type { TimelineEvent } from '../../../../api/types';

const ev = (id: string, verb: TimelineEvent['verb']): TimelineEvent => ({
  id,
  verb,
  actor: { login: 'a', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z',
  body: verb === 'commented' ? 'hi' : null,
  commitCount: verb === 'pushed' ? 1 : null,
  subject: null,
});

describe('groupCommitRuns', () => {
  it('coalesces a consecutive commit run into one group', () => {
    const nodes = groupCommitRuns([ev('1', 'pushed'), ev('2', 'pushed'), ev('3', 'pushed')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'commit-group', collapsedByDefault: false });
    expect((nodes[0] as { commits: TimelineEvent[] }).commits).toHaveLength(3);
  });

  it('collapses by default when the run exceeds the threshold', () => {
    const run = Array.from({ length: 6 }, (_, i) => ev(String(i), 'pushed'));
    const nodes = groupCommitRuns(run, 5);
    expect(nodes[0]).toMatchObject({ kind: 'commit-group', collapsedByDefault: true });
  });

  it('breaks the run when a non-commit event interrupts it', () => {
    const nodes = groupCommitRuns([ev('1', 'pushed'), ev('2', 'commented'), ev('3', 'pushed')]);
    expect(nodes.map((n) => n.kind)).toEqual(['commit-group', 'event', 'commit-group']);
  });

  it('passes non-commit events through untouched', () => {
    const nodes = groupCommitRuns([ev('1', 'approved')]);
    expect(nodes).toEqual([{ kind: 'event', event: expect.objectContaining({ id: '1' }) }]);
  });
});
