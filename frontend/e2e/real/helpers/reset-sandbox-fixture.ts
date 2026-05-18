import type { APIRequestContext } from '@playwright/test';
import * as gh from './gh-sandbox';
import type { SandboxFixture } from './sandbox-fixture';

export interface ResetResult {
  // GitHub server clock at the end of the reset — used by listSubmittedReviewsSince
  // to scope assertions to this test only. Read from the forceResetBranch response's
  // Date header rather than test-runner clock to defend against clock skew.
  sinceTs: string;
}

export async function resetSandboxFixture(
  request: APIRequestContext,
  fixture: SandboxFixture,
): Promise<ResetResult> {
  // 1. Delete any leftover viewer-owned pending reviews (crash recovery from prior run).
  for (const p of gh.listOwnPendingReviews(fixture.prNumber)) {
    gh.deletePendingReview(p.id);
  }

  // 2. Force-reset the fixture branch to its baseOid; capture server clock from response.
  const { serverTs } = gh.forceResetBranch(fixture);

  // 3. Clear PRism's local PR session (IAppStateStore.UpdateAsync) AND remove subscribers
  //    from ActivePrSubscriberRegistry — both via /test/clear-pr-session in one POST.
  const resp = await request.post('http://localhost:5181/test/clear-pr-session', {
    data: { owner: 'prpande', repo: 'prism-sandbox', number: fixture.prNumber },
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) {
    throw new Error(`/test/clear-pr-session failed: ${resp.status()} ${await resp.text()}`);
  }

  return { sinceTs: serverTs };
}
