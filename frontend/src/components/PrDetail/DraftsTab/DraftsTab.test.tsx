import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DraftsTab } from './DraftsTab';
import type { DraftCommentDto, PrReference, ReviewSessionDto } from '../../../api/types';

const PR_REF: PrReference = { owner: 'acme', repo: 'api', number: 123 };

const EMPTY_SESSION: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

const ONE_COMMENT: DraftCommentDto = {
  id: 'c1',
  filePath: 'src/Foo.cs',
  lineNumber: 3,
  side: 'right',
  anchoredSha: 'abc',
  anchoredLineContent: 'var x = 1;',
  bodyMarkdown: 'nit',
  status: 'draft',
  isOverriddenStale: false,
  postedCommentId: null,
};

function renderTab(session: ReviewSessionDto) {
  return render(
    <MemoryRouter>
      <DraftsTab prRef={PR_REF} session={session} status="ready" refetch={async () => {}} />
    </MemoryRouter>,
  );
}

describe('DraftsTab empty state (#118)', () => {
  it('renders ONLY the empty-state message when there are 0 drafts — no redundant count header', () => {
    renderTab(EMPTY_SESSION);
    expect(screen.getByText(/No drafts on this PR yet/i)).toBeInTheDocument();
    // The redundant "0 drafts" count header must be gone.
    expect(screen.queryByText(/\b0 drafts\b/i)).not.toBeInTheDocument();
    expect(document.querySelector('.drafts-tab-header')).toBeNull();
  });

  it('still renders the count header when there is at least one draft', () => {
    renderTab({ ...EMPTY_SESSION, draftComments: [ONE_COMMENT] });
    expect(screen.getByText(/1 draft\b/i)).toBeInTheDocument();
    expect(document.querySelector('.drafts-tab-header')).not.toBeNull();
    expect(screen.queryByText(/No drafts on this PR yet/i)).not.toBeInTheDocument();
  });
});
