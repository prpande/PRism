import { describe, it, expect } from 'vitest';
import { groupByRepo, prId } from './groupByRepo';
import type { PrInboxItem } from '../../api/types';

function pr(owner: string, repo: string, number: number): PrInboxItem {
  return {
    reference: { owner, repo, number },
    title: `PR ${number}`,
    author: 'a',
    repo: `${owner}/${repo}`,
    updatedAt: '2026-05-01T00:00:00Z',
    pushedAt: '2026-05-01T00:00:00Z',
    iterationNumber: 1,
    commentCount: 0,
    additions: 0,
    deletions: 0,
    headSha: 'x',
    ci: 'none',
    lastViewedHeadSha: null,
    lastSeenCommentId: null,
    mergedAt: null,
    closedAt: null,
  };
}

describe('groupByRepo', () => {
  it('returns [] for empty input', () => {
    expect(groupByRepo([])).toEqual([]);
  });

  it('returns one group for a single repo', () => {
    const groups = groupByRepo([pr('acme', 'api', 1), pr('acme', 'api', 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe('acme/api');
    expect(groups[0].items.map((i) => i.reference.number)).toEqual([1, 2]);
  });

  it('preserves first-seen repo order and within-repo order', () => {
    const groups = groupByRepo([pr('acme', 'web', 1), pr('acme', 'api', 2), pr('acme', 'web', 3)]);
    expect(groups.map((g) => g.repo)).toEqual(['acme/web', 'acme/api']);
    expect(groups[0].items.map((i) => i.reference.number)).toEqual([1, 3]);
  });

  it('over a close-desc input yields most-recent-close repo order', () => {
    const groups = groupByRepo([pr('acme', 'a', 9), pr('acme', 'b', 8), pr('acme', 'a', 7)]);
    expect(groups.map((g) => g.repo)).toEqual(['acme/a', 'acme/b']);
  });
});

describe('prId', () => {
  it('formats owner/repo#number', () => {
    expect(prId(pr('acme', 'api', 5))).toBe('acme/api#5');
  });
});
