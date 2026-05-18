import { execFileSync } from 'node:child_process';
import type { SandboxFixture } from './sandbox-fixture';

// Hardcoded per design §5.1. YAGNI parameterization until a teammate actually needs a
// different sandbox — at which point the seam is a one-line config object.
const OWNER = 'prpande';
const REPO = 'prism-sandbox';

// gh CLI argv-style invocation — no shell interpolation. Output is JSON; throws on non-zero exit.
function gh<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out) as T;
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

let _viewerLogin: string | null = null;
export function viewerLogin(): string {
  if (_viewerLogin !== null) return _viewerLogin;
  const result = gh<{ data: { viewer: { login: string } } }>([
    'api',
    'graphql',
    '-f',
    'query={ viewer { login } }',
  ]);
  _viewerLogin = result.data.viewer.login;
  return _viewerLogin;
}

export function getPrHeadOid(prNumber: number): string {
  const result = gh<{ data: { repository: { pullRequest: { headRefOid: string } } } }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { headRefOid } } }`,
  ]);
  return result.data.repository.pullRequest.headRefOid;
}

export interface OwnPendingReview {
  id: string;
  commitOid: string;
}

export function listOwnPendingReviews(prNumber: number): OwnPendingReview[] {
  const me = viewerLogin();
  const result = gh<{
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<{ id: string; commit: { oid: string }; author: { login: string } | null }>;
          };
        };
      };
    };
  }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { reviews(states: PENDING, first: 5) { nodes { id author { login } commit { oid } } } } } }`,
  ]);
  return result.data.repository.pullRequest.reviews.nodes
    .filter((r) => r.author?.login === me)
    .map((r) => ({ id: r.id, commitOid: r.commit.oid }));
}

export interface SubmittedReview {
  id: string;
  state: string;
  body: string;
  submittedAt: string;
  commitOid: string;
  threadCount: number;
}

// Filtered by viewer.login AND submittedAt >= sinceTs so prior runs' reviews don't pollute counts.
// sinceTs comes from GitHub server clock (see reset-sandbox-fixture.ts), not test-runner clock.
export function listSubmittedReviewsSince(prNumber: number, sinceTs: string): SubmittedReview[] {
  const me = viewerLogin();
  const result = gh<{
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<{
              id: string;
              state: string;
              body: string;
              submittedAt: string | null;
              author: { login: string } | null;
              commit: { oid: string };
              comments: { totalCount: number };
            }>;
          };
        };
      };
    };
  }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { reviews(first: 10, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) { nodes { id state body submittedAt author { login } commit { oid } comments(first: 1) { totalCount } } } } } }`,
  ]);
  const since = new Date(sinceTs).getTime();
  return result.data.repository.pullRequest.reviews.nodes
    .filter((r) => r.author?.login === me)
    .filter((r) => r.submittedAt && new Date(r.submittedAt).getTime() >= since)
    .map((r) => ({
      id: r.id,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt!,
      commitOid: r.commit.oid,
      threadCount: r.comments.totalCount,
    }));
}

export interface CreatePendingReviewResult {
  pullRequestReviewId: string;
  threadId: string;
}

export function createPendingReview(
  fixture: SandboxFixture,
  opts: { threadBody: string },
): CreatePendingReviewResult {
  // Step 1: addPullRequestReview (creates the PENDING review at the PR's current head).
  const created = gh<{
    data: { addPullRequestReview: { pullRequestReview: { id: string; commit: { oid: string } } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { addPullRequestReview(input: { pullRequestId: "${fixture.prNodeId}", commitOID: "${getPrHeadOid(fixture.prNumber)}" }) { pullRequestReview { id commit { oid } } } }`,
  ]);
  const pullRequestReviewId = created.data.addPullRequestReview.pullRequestReview.id;

  // Step 2: addPullRequestReviewThread (attach one thread at the fixture's anchor line).
  // Body literal contains the user's text; we don't include the PRism HTML-comment marker
  // intentionally — the foreign-pending-review spec relies on the seeded thread having no marker.
  const body = opts.threadBody.replaceAll('"', '\\"');
  const thread = gh<{
    data: { addPullRequestReviewThread: { thread: { id: string } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { addPullRequestReviewThread(input: { pullRequestReviewId: "${pullRequestReviewId}", body: "${body}", path: "${fixture.anchorFile}", line: ${fixture.anchorLine}, side: RIGHT }) { thread { id } } }`,
  ]);

  return {
    pullRequestReviewId,
    threadId: thread.data.addPullRequestReviewThread.thread.id,
  };
}

export function deletePendingReview(reviewId: string): void {
  gh<unknown>([
    'api',
    'graphql',
    '-f',
    `query=mutation { deletePullRequestReview(input: { pullRequestReviewId: "${reviewId}" }) { pullRequestReview { id } } }`,
  ]);
}

export interface AdvanceHeadResult {
  newHeadOid: string;
}

export function advanceHead(
  fixture: SandboxFixture,
  opts: { fileChanges: Array<{ path: string; contentBase64: string }>; commitMessage: string },
): AdvanceHeadResult {
  const expectedHeadOid = getPrHeadOid(fixture.prNumber);
  const additions = opts.fileChanges
    .map((f) => `{ path: "${f.path}", contents: "${f.contentBase64}" }`)
    .join(', ');
  const result = gh<{
    data: { createCommitOnBranch: { commit: { oid: string } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: "${OWNER}/${REPO}", branchName: "${fixture.branch}" }, message: { headline: "${opts.commitMessage}" }, fileChanges: { additions: [${additions}] }, expectedHeadOid: "${expectedHeadOid}" }) { commit { oid } } }`,
  ]);
  return { newHeadOid: result.data.createCommitOnBranch.commit.oid };
}

// REST API force-reset. Returns the Date header value so callers can use it as sinceTs.
export function forceResetBranch(fixture: SandboxFixture): { serverTs: string } {
  // gh api -i prints headers. We extract Date: line.
  const raw = ghText([
    'api',
    '-i',
    '-X',
    'PATCH',
    `repos/${OWNER}/${REPO}/git/refs/heads/${fixture.branch}`,
    '-F',
    `sha=${fixture.baseOid}`,
    '-F',
    'force=true',
  ]);
  const dateHeader = raw.split('\n').find((line) => line.toLowerCase().startsWith('date:'));
  const dateValue = dateHeader?.substring('date:'.length).trim() ?? new Date().toUTCString();
  return { serverTs: new Date(dateValue).toISOString() };
}
