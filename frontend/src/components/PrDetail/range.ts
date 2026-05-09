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
