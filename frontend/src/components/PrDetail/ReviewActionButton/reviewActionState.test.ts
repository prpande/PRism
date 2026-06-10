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

describe('deriveFace — pending / reconfirm / action / disabled', () => {
  it('pending + verdict → pending true, label keeps verdict word, action=resume', () => {
    const f = deriveFace(inputs({ draftVerdict: 'comment', pendingReviewId: 'PR_1' }));
    expect(f.pending).toBe(true);
    expect(f.label).toBe('Comment');
    expect(f.mainAction).toBe('resume');
    expect(f.pendingTooltip).toMatch(/pending review on github/i);
  });
  it('pending + no verdict → label Resume review, action=resume', () => {
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1' }));
    expect(f.label).toBe('Resume review');
    expect(f.mainAction).toBe('resume');
  });
  it('resume is NEVER disabled by submitDisabledReason (preserve today)', () => {
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1' }));
    expect(f.mainDisabled).toBe(false);
    expect(f.mainAction).toBe('resume');
  });
  it('non-pending empty session → submit disabled, reason (a) directs to the ▾ menu', () => {
    const f = deriveFace(inputs());
    expect(f.mainAction).toBe('submit');
    expect(f.mainDisabled).toBe(true);
    expect(f.mainDisabledReason).toBe('Pick a verdict using the ▾ menu, or add a comment.');
  });
  it('pending + needs-reconfirm → resume stays ENABLED (resume is never gated), face signal shown', () => {
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1', draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }));
    expect(f.mainAction).toBe('resume');
    expect(f.mainDisabled).toBe(false);
    expect(f.needsReconfirm).toBe(true);
  });
  it('needs-reconfirm flagged from draftVerdictStatus', () => {
    const f = deriveFace(inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }));
    expect(f.needsReconfirm).toBe(true);
    expect(f.mainDisabled).toBe(true);
  });
  it('inSubmitFlow → frozen true, mainDisabled true', () => {
    const f = deriveFace({ ...inputs({ draftVerdict: 'approve' }), inSubmitFlow: true });
    expect(f.frozen).toBe(true);
    expect(f.mainDisabled).toBe(true);
  });
  it('closed/merged → mainAction none, mainDisabled true', () => {
    const f = deriveFace({ ...inputs(), prState: 'closed' });
    expect(f.mainAction).toBe('none');
    expect(f.mainDisabled).toBe(true);
  });
});
