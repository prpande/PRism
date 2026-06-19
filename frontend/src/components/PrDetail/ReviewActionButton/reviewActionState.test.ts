import { describe, expect, it } from 'vitest';
import { deriveFace, PRIOR_VERDICT_LABEL } from './reviewActionState';
import type { ReviewSessionDto, ViewerReview } from '../../../api/types';

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

const inputs = (over: Partial<ReviewSessionDto> = {}, rest: Record<string, unknown> = {}) => ({
  session: { ...baseSession, ...over },
  prState: 'open' as const,
  headShaDrift: false,
  validatorResults: [],
  inSubmitFlow: false,
  dialogOpen: false,
  sessionLoaded: true,
  viewerReview: null,
  submittedReviewStale: false,
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
    const f = deriveFace(
      inputs({
        pendingReviewId: 'PR_1',
        draftVerdict: 'approve',
        draftVerdictStatus: 'needs-reconfirm',
      }),
    );
    expect(f.mainAction).toBe('resume');
    expect(f.mainDisabled).toBe(false);
    expect(f.needsReconfirm).toBe(true);
  });
  it('needs-reconfirm flagged from draftVerdictStatus', () => {
    const f = deriveFace(
      inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }),
    );
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
  it('session not loaded → frozen + mainDisabled (chevron + main inert, mirrors old disabled override)', () => {
    const f = deriveFace({ ...inputs({ draftVerdict: 'approve' }), sessionLoaded: false });
    expect(f.frozen).toBe(true);
    expect(f.mainDisabled).toBe(true);
  });
});

const reviewed = (over: Partial<ViewerReview> = {}): ViewerReview => ({
  state: 'approved',
  submittedAt: '2026-02-01T00:00:00Z',
  commitSha: 'sha',
  ...over,
});

describe('deriveFace — submitted review status', () => {
  it('shows submitted verdict when no draft (fill + past-tense label + change action)', () => {
    const f = deriveFace(inputs({}, { viewerReview: reviewed() }));
    expect(f.fill).toBe('approve');
    expect(f.label).toBe('Approved');
    expect(f.mainAction).toBe('change');
    expect(f.mainDisabled).toBe(false);
    expect(f.caption).toEqual({
      mode: 'reviewed',
      priorState: 'approved',
      submittedAt: '2026-02-01T00:00:00Z',
      stale: false,
    });
  });

  it('maps changes-requested and commented', () => {
    expect(
      deriveFace(inputs({}, { viewerReview: reviewed({ state: 'changes-requested' }) })).fill,
    ).toBe('request-changes');
    expect(
      deriveFace(inputs({}, { viewerReview: reviewed({ state: 'changes-requested' }) })).label,
    ).toBe('Changes requested');
    expect(deriveFace(inputs({}, { viewerReview: reviewed({ state: 'commented' }) })).fill).toBe(
      'comment',
    );
  });

  it('flags stale in the caption', () => {
    const f = deriveFace(inputs({}, { viewerReview: reviewed(), submittedReviewStale: true }));
    expect(f.caption).toMatchObject({ mode: 'reviewed', stale: true });
  });

  it('draft wins the face; prior review demotes to a "was" caption', () => {
    const f = deriveFace(inputs({ draftVerdict: 'request-changes' }, { viewerReview: reviewed() }));
    expect(f.fill).toBe('request-changes');
    expect(f.label).toBe('Request changes'); // action label, not past-tense
    expect(f.pending).toBe(false);
    expect(f.caption).toEqual({
      mode: 'was',
      priorState: 'approved',
      submittedAt: '2026-02-01T00:00:00Z',
      stale: false,
    });
  });

  it('no submitted review and no draft → Submit review, no caption', () => {
    const f = deriveFace(inputs());
    expect(f.label).toBe('Submit review');
    expect(f.caption).toBeNull();
  });

  it('PRIOR_VERDICT_LABEL is past-tense', () => {
    expect(PRIOR_VERDICT_LABEL).toEqual({
      approved: 'Approved',
      'changes-requested': 'Changes requested',
      commented: 'Commented',
    });
  });
});

import { deriveMenu } from './reviewActionState';

const ids = (sections: ReturnType<typeof deriveMenu>) =>
  sections.flatMap((s) => s.items.map((it) => it.id));

describe('deriveMenu', () => {
  it('normal verdict menu: 3 verdicts + submit, checked reflects draftVerdict', () => {
    const m = deriveMenu(inputs({ draftVerdict: 'approve' }));
    expect(ids(m)).toEqual([
      'verdict:approve',
      'verdict:request-changes',
      'verdict:comment',
      'submit',
    ]);
    const approve = m.flatMap((s) => s.items).find((it) => it.id === 'verdict:approve');
    expect(approve?.checked).toBe(true);
  });
  it('pending menu: resume + verdicts + discard-pending', () => {
    const m = deriveMenu(inputs({ draftVerdict: 'approve', pendingReviewId: 'PR_1' }));
    expect(ids(m)).toContain('resume');
    expect(ids(m)).toContain('discard-pending');
  });
  it('pending + dialogOpen → discard-pending suppressed (invariant)', () => {
    const m = deriveMenu({
      ...inputs({ draftVerdict: 'approve', pendingReviewId: 'PR_1' }),
      dialogOpen: true,
    });
    expect(ids(m)).not.toContain('discard-pending');
  });
  it('closed/merged → discard-all only', () => {
    const m = deriveMenu({ ...inputs({ draftComments: [{} as never] }), prState: 'merged' });
    expect(ids(m)).toEqual(['discard-all']);
  });
  it('closed/merged with no drafts → empty menu', () => {
    const m = deriveMenu({ ...inputs(), prState: 'closed' });
    expect(ids(m)).toEqual([]);
  });
  it('closed/merged with only a leftover pending review (no draft comments) → discard-all still offered (preserve DiscardAllDraftsButton behavior)', () => {
    const m = deriveMenu({ ...inputs({ pendingReviewId: 'PR_1' }), prState: 'merged' });
    expect(ids(m)).toEqual(['discard-all']);
  });
  it('needs-reconfirm → reconfirm note in the verdict section', () => {
    const m = deriveMenu(
      inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }),
    );
    expect(ids(m)).toContain('reconfirm-note');
  });
  it('empty open session (submit disabled, reason a) → NO submit item, only the Verdict section', () => {
    const m = deriveMenu(inputs());
    expect(ids(m)).toEqual(['verdict:approve', 'verdict:request-changes', 'verdict:comment']);
    expect(ids(m)).not.toContain('submit');
  });
  it('needs-reconfirm (submit disabled) → submit item omitted (no bypass of the disabled main)', () => {
    const m = deriveMenu(
      inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }),
    );
    expect(ids(m)).not.toContain('submit');
  });
  it('session not loaded → submit item omitted', () => {
    const m = deriveMenu({ ...inputs({ draftVerdict: 'approve' }), sessionLoaded: false });
    expect(ids(m)).not.toContain('submit');
  });
});
