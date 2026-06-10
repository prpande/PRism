import type { DraftVerdict, ReviewSessionDto, ValidatorResult } from '../../../api/types';
import type { PrState } from '../PrHeader';
import { submitDisabledReason } from '../SubmitButton';

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

  const needsReconfirm = session.draftVerdictStatus === 'needs-reconfirm';
  const mainAction: ReviewActionFace['mainAction'] = isClosedOrMerged
    ? 'none'
    : pending
      ? 'resume'
      : 'submit';

  // Resume + discard are never gated (today's SubmitInProgressBadge/pill aren't).
  // Only the fresh-submit path consults submitDisabledReason.
  const rawReason =
    mainAction === 'submit'
      ? submitDisabledReason(session, i.headShaDrift, i.validatorResults)
      : null;
  // Spec §4.1: with the inline verdict picker gone, reason (a) must direct the
  // user to the caret menu. submitDisabledReason returns this exact string for (a).
  const REASON_A = 'Pick a verdict or add a comment, reply, or summary before submitting.';
  const submitReason =
    rawReason === REASON_A ? 'Pick a verdict using the ▾ menu, or add a comment.' : rawReason;
  const frozen = i.inSubmitFlow;
  const mainDisabled = isClosedOrMerged || frozen || submitReason !== null;

  return {
    fill,
    label,
    pending,
    needsReconfirm,
    mainAction,
    mainDisabled,
    mainDisabledReason: submitReason,
    frozen,
    pendingTooltip: pending ? 'Pending review on GitHub — not yet submitted' : null,
  };
}
