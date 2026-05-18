import type { APIRequestContext } from '@playwright/test';

// Arms the RealTransportFailureInjector for one in-flight GraphQL call to GitHub.
// Key is the top-level GraphQL selection-field name (e.g. "addPullRequestReviewThread"),
// NOT a C# method name — see design §4.1 + §4.2 for the layer-key rationale.
export async function injectRealFailure(
  request: APIRequestContext,
  opts: { graphQLFieldName: string; afterEffect: boolean; message?: string },
): Promise<void> {
  const resp = await request.post('http://localhost:5181/test/real-inject/inject-failure', {
    data: opts,
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) {
    throw new Error(`POST /test/real-inject/inject-failure failed: ${resp.status()} ${await resp.text()}`);
  }
}
