// Shared PrDetailDto test-fixture builders (#332), replacing ~10 hand-rolled
// full-literal fixtures that each re-spelled the whole `pr` block and drifted.
// Mirror the makePrDetailContextValue convention (src/components/PrDetail/
// testUtils.tsx): each spreads a `Partial` over neutral defaults, overrides
// last. Compose for a nested tweak: makePrDetailDto({ pr: makePr({ headSha:
// 'feedface' }) }). Defaults are generic, so each test overrides exactly the
// fields it asserts on — no hidden coupling to a default value.
// `iter`/`commit` (#328) are the shared copies of the factories the pinned
// IterationTabStrip/ComparePicker/CommitMultiSelectPicker tests still inline.
import type {
  CommitDto,
  IterationDto,
  PrDetailDto,
  PrDetailPr,
  PrReference,
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
    isDraft: false,
    openedAt: '2026-05-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

export function iter(n: number, hasResolvableRange = true): IterationDto {
  return {
    number: n,
    beforeSha: `before${n}`,
    afterSha: `after${n}`,
    commits: [],
    hasResolvableRange,
  };
}

export function commit(sha: string, message = `Commit ${sha}`): CommitDto {
  return {
    sha,
    message,
    committedDate: '2026-05-01T00:00:00Z',
    additions: 10,
    deletions: 5,
  };
}

export function makePrDetailDto(overrides: Partial<PrDetailDto> = {}): PrDetailDto {
  return {
    pr: makePr(),
    clusteringQuality: 'ok',
    iterations: [],
    commits: [],
    rootComments: [],
    reviewComments: [],
    timelineCapHit: false,
    ...overrides,
  };
}
