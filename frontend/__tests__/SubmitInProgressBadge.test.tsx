import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SubmitInProgressBadge } from '../src/components/PrDetail/SubmitInProgressBadge';
import type { ReviewSessionDto } from '../src/api/types';

const baseSession: ReviewSessionDto = {
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

describe('SubmitInProgressBadge (R3)', () => {
  it('renders nothing when there is no pending review id', () => {
    const { container } = render(<SubmitInProgressBadge session={baseSession} onResume={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the resume affordance when a pending review id is persisted', () => {
    const session = { ...baseSession, pendingReviewId: 'PRR_abc' };
    render(<SubmitInProgressBadge session={session} onResume={() => {}} />);
    expect(screen.getByText(/submit in progress/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  });

  it('fires onResume when the badge is clicked', () => {
    const session = { ...baseSession, pendingReviewId: 'PRR_abc' };
    const onResume = vi.fn();
    render(<SubmitInProgressBadge session={session} onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onResume).toHaveBeenCalled();
  });
});
