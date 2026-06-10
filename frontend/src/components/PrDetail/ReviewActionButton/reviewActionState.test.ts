import { describe, expect, it } from 'vitest';
import { deriveFace } from './reviewActionState';
import type { ReviewSessionDto } from '../../../api/types';

const baseSession: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

const inputs = (over: Partial<ReviewSessionDto> = {}, rest = {}) => ({
  session: { ...baseSession, ...over },
  prState: 'open' as const,
  headShaDrift: false,
  validatorResults: [],
  inSubmitFlow: false,
  dialogOpen: false,
  ...rest,
});

describe('deriveFace — fill + label', () => {
  it('default (no verdict, open) → accent / Submit review', () => {
    const f = deriveFace(inputs());
    expect(f.fill).toBe('accent');
    expect(f.label).toBe('Submit review');
  });
  it('approve drafted → approve fill / Approve', () => {
    const f = deriveFace(inputs({ draftVerdict: 'approve' }));
    expect(f.fill).toBe('approve');
    expect(f.label).toBe('Approve');
  });
  it('request-changes drafted → request-changes fill / Request changes', () => {
    const f = deriveFace(inputs({ draftVerdict: 'request-changes' }));
    expect(f.fill).toBe('request-changes');
    expect(f.label).toBe('Request changes');
  });
  it('closed/merged → secondary / Drafts', () => {
    const f = deriveFace({ ...inputs(), prState: 'merged' });
    expect(f.fill).toBe('secondary');
    expect(f.label).toBe('Drafts');
  });
});
