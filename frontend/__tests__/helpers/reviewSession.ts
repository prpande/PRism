// Shared empty-ReviewSessionDto test fixture (#674), replacing the top-level
// `const … : ReviewSessionDto = { …all-empty… }` literal that was hand-copied
// across several test files and drifted only in field ordering. Mirrors the
// helpers/prDetail.ts convention: neutral defaults, a `Partial` spread last so
// overrides win — makeEmptyReviewSession({ draftVerdict: 'approve' }).
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
