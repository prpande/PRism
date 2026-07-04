import type { PrDetailDto } from '../../api/types';

/**
 * Build the canonical "all changes" diff range string for a PR.
 *
 * The `..` is a separator the backend's `/diff?range=` endpoint splits to
 * recover the two SHAs — NOT git's two-dot range operator. The backend then
 * hits GitHub's `compare/{base}...{head}` (three-dot, common-ancestor)
 * endpoint, which is the correct semantics for a PR diff. See
 * `GitHubReviewService.FetchCompareFilesAsync` for the GitHub-side call.
 */
export function buildAllRange(pr: PrDetailDto['pr']): string {
  return `${pr.baseSha}..${pr.headSha}`;
}

/**
 * The commit SHA a NEW inline comment should anchor to, given the diff range
 * currently displayed in the Files tab (#723).
 *
 * Inline comments post to GitHub with `commit_id = anchoredSha`
 * (`PrCommentEndpoints`), so the anchor must be the RIGHT-side commit of the
 * range on screen — an iteration's `afterSha` when an older iteration is
 * active, or the PR head for the "All changes" view. Anchoring an
 * older-iteration line to head makes GitHub reject or misplace the comment
 * (the line may not exist at head).
 *
 * `iterationRange` is `"{before}..{after}"` — either `buildAllRange`
 * (`base..head`, whose after side already IS head) or `IterationTabStrip`'s
 * `iterRange` (`beforeSha..afterSha`). SHAs contain no `..`, so the anchor is
 * the text after the separator. `null` (the low-quality commit-picker view,
 * which has no iteration range) falls back to head, as does any value missing
 * the separator.
 */
export function anchorShaForRange(iterationRange: string | null, headSha: string): string {
  if (iterationRange === null) return headSha;
  return iterationRange.split('..')[1] || headSha;
}
