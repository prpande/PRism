import type { ReviewSessionDto } from '../../src/api/types';

export function makeEmptyReviewSession(
  overrides: Partial<ReviewSessionDto> = {},
): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
    ...overrides,
  };
}
