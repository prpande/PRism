import { useState } from 'react';
import type { ReviewSessionDto } from '../../api/types';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { DiscardAllConfirmationModal } from './DiscardAllConfirmationModal';

// Spec § 13.1: on a closed/merged PR the Submit Review button is disabled and a
// "Discard all drafts" button takes its place (read order
// [Discard all drafts | Submit (disabled)]). Visible only when the PR is
// closed/merged AND the session still holds something (a draft, a reply, a
// non-empty summary, or a leftover pendingReviewId). Below 600px the label
// shortens to "Discard" (spec § 8.5).

interface Props {
  prState: 'open' | 'closed' | 'merged';
  session: ReviewSessionDto;
  onDiscard(): void;
}

function hasDiscardableContent(s: ReviewSessionDto): boolean {
  return (
    s.draftComments.length > 0 ||
    s.draftReplies.length > 0 ||
    (!!s.draftSummaryMarkdown && s.draftSummaryMarkdown.trim() !== '') ||
    !!s.pendingReviewId
  );
}

export function DiscardAllDraftsButton({ prState, session, onDiscard }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const narrow = useMediaQuery('(max-width: 599px)');

  if (prState === 'open' || !hasDiscardableContent(session)) return null;

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmOpen(true)}>
        {narrow ? 'Discard' : 'Discard all drafts'}
      </button>
      <DiscardAllConfirmationModal
        open={confirmOpen}
        prState={prState}
        threadCount={session.draftComments.length}
        replyCount={session.draftReplies.length}
        hasSummary={!!session.draftSummaryMarkdown && session.draftSummaryMarkdown.trim() !== ''}
        hasPendingReview={!!session.pendingReviewId}
        onConfirm={() => {
          setConfirmOpen(false);
          onDiscard();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
