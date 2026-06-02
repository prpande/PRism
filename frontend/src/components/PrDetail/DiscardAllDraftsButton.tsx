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

// The PR-root review summary is now the PR-root DraftComment (filePath/lineNumber
// both null); its body lives in draftComments. Surfaced separately so the
// confirmation modal can name "summary" distinctly from inline threads.
function prRootSummaryBody(s: ReviewSessionDto): string {
  return (
    s.draftComments.find((d) => d.filePath === null && d.lineNumber === null)?.bodyMarkdown ?? ''
  ).trim();
}

function hasDiscardableContent(s: ReviewSessionDto): boolean {
  return s.draftComments.length > 0 || s.draftReplies.length > 0 || !!s.pendingReviewId;
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
        // Inline threads only — the PR-root draft (filePath/lineNumber null) is the
        // review summary and is named separately via hasSummary, so exclude it here
        // to avoid double-counting it as a "draft comment".
        threadCount={
          session.draftComments.filter((d) => !(d.filePath === null && d.lineNumber === null))
            .length
        }
        replyCount={session.draftReplies.length}
        hasSummary={prRootSummaryBody(session).length > 0}
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
