// Shared PrDetailDto test-fixture builders, replacing the ~10 hand-rolled
// full-literal `PrDetailDto` fixtures that each re-spelled the entire `pr`
// summary block across the PR-detail test suite (#332). Two shallow builders
// mirror the existing `makePrDetailContextValue` convention in
// src/components/PrDetail/testUtils.tsx: each takes a `Partial` of its type and
// spreads it over neutral defaults. A test tweaking one `pr` field writes
// `makePrDetailDto({ pr: makePr({ headSha: 'feedface' }) })`.
//
// The defaults are deliberately generic — every test that asserts on a specific
// field (title, headSha, the maxCommentId derived from rootComments, etc.)
// overrides that field explicitly, so the fixture reads as "defaults plus the
// fields this test cares about" with no hidden coupling to a default value.
import type {
  PrDetailDto,
  PrDetailPr,
  PrReference,
  IterationDto,
  CommitDto,
  IssueCommentDto,
  ReviewThreadDto,
} from '../../src/api/types';

const DEFAULT_REF: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

export function makePr(overrides: Partial<PrDetailPr> = {}): PrDetailPr {
  return {
    reference: DEFAULT_REF,
    title: 'Test PR',
    body: '',
    author: 'test-author',
    state: 'open',
    headSha: 'headsha',
    baseSha: 'basesha',
    headBranch: 'feature',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

export function makePrDetailDto(overrides: Partial<PrDetailDto> = {}): PrDetailDto {
  return {
    pr: makePr(),
    clusteringQuality: 'ok',
    iterations: [] as IterationDto[],
    commits: [] as CommitDto[],
    rootComments: [] as IssueCommentDto[],
    reviewComments: [] as ReviewThreadDto[],
    timelineCapHit: false,
    ...overrides,
  };
}
