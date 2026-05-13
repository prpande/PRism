import type { APIRequestContext, Page } from '@playwright/test';

// Submit-pipeline E2E helpers (S5 PR7). Builds on the s4 setup helpers; adds drivers for the
// /test/submit/* hooks landed in PR7 Task 61 (FakeReviewSubmitter introspection + knobs).
//
// All /test/* calls use the ABSOLUTE backend origin (http://localhost:5180) — the Vite dev server
// (the `dev` Playwright project) only proxies /api, not /test, so a relative URL would 404 there.
// OriginCheckMiddleware requires an Origin header on every mutating verb, so each POST supplies it.
export { resetBackendState, setupAndOpenScenarioPr, openScenarioFilesTab } from './s4-setup';

const BACKEND = 'http://localhost:5180';
const ORIGIN_HEADER = { Origin: BACKEND } as const;

async function postTest(
  request: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<unknown> {
  const resp = await request.post(`${BACKEND}${path}`, {
    headers: ORIGIN_HEADER,
    data: data ?? {},
  });
  if (!resp.ok()) throw new Error(`POST ${path} failed: ${resp.status()} ${await resp.text()}`);
  return resp.json().catch(() => ({}));
}

// IReviewSubmitter method names — the failure-injection knob keys (must match the C# nameof()s).
export const SubmitMethod = {
  Begin: 'BeginPendingReviewAsync',
  AttachThread: 'AttachThreadAsync',
  AttachReply: 'AttachReplyAsync',
  Finalize: 'FinalizePendingReviewAsync',
  DeletePendingReview: 'DeletePendingReviewAsync',
  DeletePendingReviewThread: 'DeletePendingReviewThreadAsync',
  FindOwn: 'FindOwnPendingReviewAsync',
} as const;

// One-shot failure on the next call to `method`. afterEffect=true → the side effect lands first,
// then it throws (the lost-response window).
export async function injectSubmitFailure(
  request: APIRequestContext,
  method: string,
  opts: { message?: string; afterEffect?: boolean } = {},
): Promise<void> {
  await postTest(request, '/test/submit/inject-failure', {
    methodName: method,
    message: opts.message,
    afterEffect: opts.afterEffect ?? false,
  });
}

// Holds BeginPendingReviewAsync for delayMs (so a 2nd tab can race the per-PR submit lock).
export async function setBeginDelay(request: APIRequestContext, delayMs: number): Promise<void> {
  await postTest(request, '/test/submit/set-begin-delay', { delayMs });
}

export interface SeedThread {
  filePath: string;
  lineNumber: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  isResolved?: boolean;
  replies?: Array<{ body: string }>;
}

// Pre-seeds a pending review on a PR (foreign relative to the session's PendingReviewId). commitOid
// defaults to the backing store's current head sha. Returns the assigned pullRequestReviewId.
export async function seedPendingReview(
  request: APIRequestContext,
  pr: { owner: string; repo: string; number: number },
  opts: { commitOid?: string; threads?: SeedThread[] } = {},
): Promise<{ pullRequestReviewId: string; commitOid: string; threadCount: number }> {
  const body = (await postTest(request, '/test/submit/seed-pending-review', {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    commitOid: opts.commitOid,
    threads: (opts.threads ?? []).map((t) => ({
      filePath: t.filePath,
      lineNumber: t.lineNumber,
      side: t.side,
      body: t.body,
      isResolved: t.isResolved ?? false,
      replies: t.replies ?? [],
    })),
  })) as { pullRequestReviewId: string; commitOid: string; threadCount: number };
  return body;
}

export interface InspectThread {
  pullRequestReviewThreadId: string;
  filePath: string;
  lineNumber: number;
  isResolved: boolean;
  body: string;
  replies: Array<{ commentId: string; body: string }>;
}
export interface InspectPendingReview {
  pendingReview: {
    pullRequestReviewId: string;
    commitOid: string;
    summaryBody: string;
    threadCount: number;
    replyCount: number;
    threads: InspectThread[];
  } | null;
  attachThreadCallCount: number;
  attachReplyCallCount: number;
  deleteThreadCallCount: number;
  findOwnCallCount: number;
}

export async function inspectPendingReview(
  request: APIRequestContext,
  pr: { owner: string; repo: string; number: number },
): Promise<InspectPendingReview> {
  const resp = await request.get(
    `${BACKEND}/test/submit/inspect-pending-review?owner=${pr.owner}&repo=${pr.repo}&number=${pr.number}`,
  );
  if (!resp.ok())
    throw new Error(`GET inspect-pending-review failed: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()) as InspectPendingReview;
}

// Flips the scenario PR's open/closed/merged state.
export async function setPrState(
  request: APIRequestContext,
  state: 'OPEN' | 'CLOSED' | 'MERGED',
): Promise<void> {
  await postTest(request, '/test/set-pr-state', { state });
}

// Records "viewed this PR at the current head" on the session so the submit head-sha-drift gate
// passes (the real frontend does this via the demo's "click Reload" step; E2E specs that don't
// exercise a reload use this hook). Returns the head sha that was recorded.
export async function recordPrViewed(
  request: APIRequestContext,
  pr: { owner: string; repo: string; number: number } = { owner: 'acme', repo: 'api', number: 123 },
): Promise<string> {
  const body = (await postTest(request, '/test/mark-pr-viewed', {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
  })) as {
    headSha: string;
  };
  return body.headSha;
}

// Pushes a new head commit to the scenario PR (advances the active-PR poller's view → a `pr-updated`
// SSE → the "PR updated — Reload" banner). Absolute URL so it works in the `dev` project too.
export async function advanceHead(
  request: APIRequestContext,
  newHeadSha: string,
  fileChanges: Array<{ path: string; content: string }>,
): Promise<void> {
  await postTest(request, '/test/advance-head', { newHeadSha, fileChanges });
}

// Opens the scenario PR's Files tab, selects src/Calc.cs, clicks the diff-comment affordance on the
// given new-side line, types `body`, and waits for the 250ms auto-save PUT to land — so the draft is
// durable before the spec moves on. Mirrors what s4-drafts-survive-restart.spec.ts does.
export async function createInlineDraft(page: Page, line: number, body: string): Promise<void> {
  await page.goto('/pr/acme/api/123/files');
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();
  const addBtn = page.getByRole('button', { name: new RegExp(`add comment on line ${line}`, 'i') });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill(body);
  await savePromise;
}
