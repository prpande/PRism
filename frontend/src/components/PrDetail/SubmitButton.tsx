import type { ReviewSessionDto, ValidatorResult } from '../../api/types';

// Header bar Submit Review button (spec § 9). Replaces the disabled S0–S4
// affordance in place; primary-button vocabulary (spec § 17 #18). The six
// enable rules each contribute a specific disabled-state tooltip.
interface Props {
  session: ReviewSessionDto;
  // Rule (f): the most-recent active-PR poll observed head_sha drift (Reload
  // banner up). The header owns the SHA comparison; the button only needs the
  // boolean.
  headShaDrift: boolean;
  validatorResults: ValidatorResult[];
  onSubmit(): void;
  // Outer override — set while the pipeline is in-flight so the header button
  // can't re-open the dialog mid-run.
  disabled?: boolean;
}

export function SubmitButton({ session, headShaDrift, validatorResults, onSubmit, disabled }: Props) {
  const reason = submitDisabledReason(session, headShaDrift, validatorResults);
  const isDisabled = disabled === true || reason !== null;
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={isDisabled}
      aria-disabled={isDisabled}
      title={reason ?? undefined}
      onClick={isDisabled ? undefined : onSubmit}
    >
      Submit review
    </button>
  );
}

function isEmptyContent(s: ReviewSessionDto): boolean {
  const noDrafts = s.draftComments.length === 0;
  const noReplies = s.draftReplies.length === 0;
  const noSummary = !s.draftSummaryMarkdown || s.draftSummaryMarkdown.trim() === '';
  return noDrafts && noReplies && noSummary;
}

// Exported so the Submit dialog's Confirm button re-evaluates the same rules
// after an in-dialog verdict change (spec § 10 two-surfaces-one-source).
export function submitDisabledReason(
  s: ReviewSessionDto,
  headShaDrift: boolean,
  validators: ValidatorResult[],
): string | null {
  // (a) nothing to submit at all.
  if (s.draftVerdict === null && isEmptyContent(s)) {
    return 'Pick a verdict or add a comment, reply, or summary before submitting.';
  }
  // (b) a draft/reply is stale and the user hasn't overridden it.
  const stale =
    s.draftComments.some((d) => d.status === 'stale' && !d.isOverriddenStale) ||
    s.draftReplies.some((r) => r.status === 'stale' && !r.isOverriddenStale);
  if (stale) return 'Resolve or override the stale drafts in the Drafts tab first.';
  // (c) verdict needs re-confirmation against the latest diff.
  if (s.draftVerdictStatus === 'needs-reconfirm') return 'Re-confirm your verdict before submitting.';
  // (d) a validator returned a blocking result.
  if (validators.some((v) => v.severity === 'Blocking')) return 'Resolve the blocking validator issues first.';
  // (e) a Comment-verdict review with no content of any kind.
  if (s.draftVerdict === 'comment' && isEmptyContent(s)) {
    return 'A Comment review needs a summary or at least one inline comment or reply.';
  }
  // (f) the PR head moved — reload before submitting.
  if (headShaDrift) return 'Reload the PR — its head commit changed since you last viewed it.';
  return null;
}
