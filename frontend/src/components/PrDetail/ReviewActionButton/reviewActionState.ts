import type { DraftVerdict, ReviewSessionDto, ValidatorResult } from '../../../api/types';
import type { PrState } from '../PrHeader';

export type ReviewActionFill = 'accent' | 'approve' | 'request-changes' | 'comment' | 'secondary';

export interface ReviewActionInputs {
  session: ReviewSessionDto;
  prState: PrState;
  headShaDrift: boolean;
  validatorResults: ValidatorResult[];
  inSubmitFlow: boolean;
  dialogOpen: boolean;
}

export interface ReviewActionFace {
  fill: ReviewActionFill;
  label: string;
  pending: boolean;
  needsReconfirm: boolean;
  mainAction: 'submit' | 'resume' | 'none';
  mainDisabled: boolean;
  mainDisabledReason: string | null;
  frozen: boolean;
  pendingTooltip: string | null;
}

const VERDICT_LABEL: Record<DraftVerdict, string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

export function deriveFace(i: ReviewActionInputs): ReviewActionFace {
  const { session, prState } = i;
  const isClosedOrMerged = prState !== 'open';
  const verdict = session.draftVerdict;
  const pending = session.pendingReviewId !== null;

  const fill: ReviewActionFill = isClosedOrMerged
    ? 'secondary'
    : verdict ?? 'accent'; // 'approve' | 'request-changes' | 'comment' map 1:1 to fill ids

  const label = isClosedOrMerged
    ? 'Drafts'
    : verdict
      ? VERDICT_LABEL[verdict]
      : pending
        ? 'Resume review'
        : 'Submit review';

  // Filled in by Task 2 — stubbed so the module type-checks.
  return {
    fill,
    label,
    pending,
    needsReconfirm: false,
    mainAction: 'submit',
    mainDisabled: false,
    mainDisabledReason: null,
    frozen: false,
    pendingTooltip: null,
  };
}
