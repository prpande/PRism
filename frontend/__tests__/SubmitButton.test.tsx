import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SubmitButton } from '../src/components/PrDetail/SubmitButton';
import type { DraftCommentDto, ReviewSessionDto } from '../src/api/types';

const emptySession: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftSummaryMarkdown: null,
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

function comment(overrides: Partial<DraftCommentDto>): DraftCommentDto {
  return {
    id: 'd1',
    filePath: 'src/Foo.cs',
    lineNumber: 1,
    side: 'right',
    anchoredSha: 'a'.repeat(40),
    anchoredLineContent: 'x',
    bodyMarkdown: 'b',
    status: 'draft',
    isOverriddenStale: false,
    ...overrides,
  };
}

function btn() {
  return screen.getByRole('button', { name: /submit review/i });
}

describe('SubmitButton enable rules (spec § 9)', () => {
  it('(a) no verdict + no drafts + no replies + empty summary → disabled', () => {
    render(<SubmitButton session={emptySession} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('(b) a non-overridden Stale draft → disabled', () => {
    const session: ReviewSessionDto = {
      ...emptySession,
      draftVerdict: 'approve',
      draftComments: [comment({ status: 'stale', isOverriddenStale: false })],
    };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('(b) an overridden Stale draft does NOT block on its own', () => {
    const session: ReviewSessionDto = {
      ...emptySession,
      draftVerdict: 'approve',
      draftComments: [comment({ status: 'stale', isOverriddenStale: true })],
    };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeEnabled();
  });

  it('(c) DraftVerdictStatus needs-reconfirm → disabled', () => {
    const session: ReviewSessionDto = {
      ...emptySession,
      draftVerdict: 'approve',
      draftVerdictStatus: 'needs-reconfirm',
    };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('(d) a Blocking validator result → disabled', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    render(
      <SubmitButton
        session={session}
        headShaDrift={false}
        validatorResults={[{ severity: 'Blocking', message: 'nope' }]}
        onSubmit={() => {}}
      />,
    );
    expect(btn()).toBeDisabled();
  });

  it('(d) a Suggestion validator result does NOT block', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    render(
      <SubmitButton
        session={session}
        headShaDrift={false}
        validatorResults={[{ severity: 'Suggestion', message: 'maybe' }]}
        onSubmit={() => {}}
      />,
    );
    expect(btn()).toBeEnabled();
  });

  it('(e) verdict Comment + no inline content + empty summary → disabled', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'comment' };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('(e) verdict Comment + a summary → enabled', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'comment', draftSummaryMarkdown: 'LGTM' };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeEnabled();
  });

  it('(f) head-sha drift → disabled even when everything else is clear', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    render(<SubmitButton session={session} headShaDrift validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('all rules clear → enabled, clicking fires onSubmit', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    const onSubmit = vi.fn();
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={onSubmit} />);
    expect(btn()).toBeEnabled();
    fireEvent.click(btn());
    expect(onSubmit).toHaveBeenCalled();
  });

  it('disabled prop (e.g. pipeline in-flight) overrides an otherwise-enabled state', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} disabled onSubmit={() => {}} />);
    expect(btn()).toBeDisabled();
  });

  it('disabled state carries a reason tooltip', () => {
    render(<SubmitButton session={emptySession} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toHaveAttribute('title');
    expect(btn().getAttribute('title')!.length).toBeGreaterThan(0);
  });

  it('uses the primary-button vocabulary (spec § 17 #18)', () => {
    const session: ReviewSessionDto = { ...emptySession, draftVerdict: 'approve' };
    render(<SubmitButton session={session} headShaDrift={false} validatorResults={[]} onSubmit={() => {}} />);
    expect(btn()).toHaveClass('btn', 'btn-primary');
  });
});
