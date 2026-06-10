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
  // False while the draft session GET is still in flight (PrHeader passes
  // `session === null`). The old VerdictPicker/SubmitButton cluster was disabled
  // until the real session arrived; we mirror that by freezing the whole control
  // so the chevron menu can't patch a verdict against the EMPTY_SESSION stand-in.
  sessionLoaded: boolean;
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

  const fill: ReviewActionFill = isClosedOrMerged ? 'secondary' : (verdict ?? 'accent'); // 'approve' | 'request-changes' | 'comment' map 1:1 to fill ids

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
  // Freeze (disable main + chevron, gate the menu) while in the submit flow OR
  // before the draft session has loaded — see ReviewActionInputs.sessionLoaded.
  const frozen = i.inSubmitFlow || !i.sessionLoaded;
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

export interface ReviewActionMenuItem {
  id: string;
  label: string;
  kind: 'verdict' | 'action' | 'danger' | 'note'; // 'note' = non-interactive label row
  verdict?: DraftVerdict;
  checked?: boolean;
}
export interface ReviewActionMenuSection {
  header?: string;
  items: ReviewActionMenuItem[];
}

const VERDICT_ITEMS = (current: DraftVerdict | null): ReviewActionMenuItem[] =>
  (Object.keys(VERDICT_LABEL) as DraftVerdict[]).map((v) => ({
    id: `verdict:${v}`,
    label: VERDICT_LABEL[v],
    kind: 'verdict',
    verdict: v,
    checked: current === v,
  }));

const RECONFIRM_NOTE: ReviewActionMenuItem = {
  id: 'reconfirm-note',
  label: 'Verdict needs re-confirmation',
  kind: 'note',
};

export function deriveMenu(i: ReviewActionInputs): ReviewActionMenuSection[] {
  const { session, prState, dialogOpen } = i;
  const isClosedOrMerged = prState !== 'open';
  const pending = session.pendingReviewId !== null;
  const needsReconfirm = session.draftVerdictStatus === 'needs-reconfirm';
  // Mirror DiscardAllDraftsButton.hasDiscardableContent — a leftover pendingReviewId
  // on a closed/merged PR is discardable even with no draft comments/replies.
  const hasDrafts =
    session.draftComments.length > 0 ||
    session.draftReplies.length > 0 ||
    session.pendingReviewId !== null;
  // Spec §4.5: needs-reconfirm is surfaced in TWO places — the button face (Task 4)
  // and a menu note. Re-selecting the verdict re-confirms it (existing patchVerdict).
  const note: ReviewActionMenuItem[] = needsReconfirm ? [RECONFIRM_NOTE] : [];

  if (isClosedOrMerged) {
    return hasDrafts
      ? [{ items: [{ id: 'discard-all', label: 'Discard all drafts', kind: 'danger' }] }]
      : [];
  }

  if (pending) {
    const items: ReviewActionMenuItem[] = [
      { id: 'resume', label: 'Resume & submit…', kind: 'action' },
      ...note,
      ...VERDICT_ITEMS(session.draftVerdict),
    ];
    // Mutual-exclusion invariant: only one discard-pending path live at a time.
    const danger: ReviewActionMenuSection[] = dialogOpen
      ? []
      : [{ items: [{ id: 'discard-pending', label: 'Discard pending review', kind: 'danger' }] }];
    return [{ header: 'Pending review on GitHub', items }, ...danger];
  }

  // Gate the menu's "Submit review…" item on the SAME predicate as the main
  // button (Copilot review): when submit is disabled — frozen, session not yet
  // loaded, or submitDisabledReason is non-null (empty session / head drift /
  // needs-reconfirm) — omit the item rather than offer an inconsistent entry
  // point that bypasses the disabled main button. For reason (a) this leaves
  // just the Verdict section, which is exactly where the user resolves it.
  const submitDisabled =
    i.inSubmitFlow ||
    !i.sessionLoaded ||
    submitDisabledReason(session, i.headShaDrift, i.validatorResults) !== null;
  const submitSection: ReviewActionMenuSection[] = submitDisabled
    ? []
    : [{ items: [{ id: 'submit', label: 'Submit review…', kind: 'action' }] }];
  return [
    { header: 'Verdict', items: [...note, ...VERDICT_ITEMS(session.draftVerdict)] },
    ...submitSection,
  ];
}
