# Real-flow Playwright e2e tests

The real-flow suite is an additional test layer on top of PRism's fake-mode e2e suite (`frontend/playwright.config.ts`). It drives PRism against live GitHub at `prpande/prism-sandbox` and catches FE→BE wire-up regressions, live-GitHub mutation acceptance, marker durability, and transport-failure modes the fake elides. It is **local-dev / pre-release only** — not wired into CI.

Design doc: [`docs/specs/2026-05-18-real-flow-e2e-playwright-design.md`](../specs/2026-05-18-real-flow-e2e-playwright-design.md).

## Prereqs (per teammate)

1. **gh CLI authenticated:** `gh auth login --scopes repo`. Fine-grained PATs scoped to `prism-sandbox` with `contents:write` + `pull_requests:write` + `metadata:read` are recommended over classic `repo`-scoped tokens (smaller blast radius if leaked).
2. **Collaborator access on `prpande/prism-sandbox`** (the owner adds you):
   ```bash
   gh api -X PUT repos/prpande/prism-sandbox/collaborators/<your-login> -F permission=push
   ```
3. **GitHub Actions disabled on the sandbox** (one-time, owner-managed):
   ```bash
   gh api -X PUT repos/prpande/prism-sandbox/actions/permissions -F enabled=false
   ```
4. **No branch protection on `master`** that blocks force-push from collaborators.
5. **One-time fixture provisioning:**
   ```bash
   cd frontend && npm run setup-real-e2e-fixtures
   ```
   This creates 4 long-lived branches+PRs on the sandbox under `e2e-real-{happy,foreign,lost-response,stale-oid}-fixture-<your-login>`. The script is idempotent; re-run any time to repair drift.

## Running

```bash
cd frontend && npm run test:e2e:real
```

To run a single spec:

```bash
cd frontend && npx playwright test --config=playwright.real.config.ts s5-real-happy-path
```

Wall-clock ~3-5 minutes for the suite (3 active specs; the stale-oid spec is currently `test.skip`ed pending the deferral — see below). `retries: 0` is intentional — see "Known flake surfaces" below.

## What each spec catches

| Spec | Surface |
|---|---|
| `s5-real-happy-path` | FE `/mark-viewed` wire-up regression net; `addPullRequestReview` + `addPullRequestReviewThread` + `submitPullRequestReview` GitHub acceptance |
| `s5-real-foreign-pending-review` | `FindOwnPendingReviewAsync` GraphQL shape; TOCTOU re-fetch; draft-import flow; anchored-line enrichment from a real file blob |
| `s5-real-lost-response-adoption` | `TestFailureInjectionHandler` seam itself; adoption-vs-foreign branching; **HTML-comment marker durability on live GitHub** (running C7 empirical gate) |
| `s5-real-stale-commit-oid` _(deferred — `test.skip`)_ | `addPullRequestReview` at a non-head OID; `deletePullRequestReview` orphan cleanup; full stale-recreation pipeline against real GraphQL. **See [s5 deferrals doc](../specs/2026-05-11-s5-submit-pipeline-deferrals.md) — section "Real-flow stale-OID spec — SSE/Reload-banner non-surfacing after createCommitOnBranch".** |

## Verifying the regression nets

Per design §8 DoD: before merging a PR that touches the submit pipeline, run each one-line edit below, confirm the named spec fails, restore, and attest in the PR description.

| Spec | Edit to introduce | Expected failure surface |
|---|---|---|
| `s5-real-happy-path` | Comment out `postMarkViewed(...)` in `frontend/src/hooks/usePrDetail.ts` | `waitForResponse(/mark-viewed/)` times out → 400 `head-sha-not-stamped` |
| `s5-real-foreign-pending-review` | Force `FindOwnPendingReviewAsync` to return `null` | Pipeline reaches Begin without foreign-detection; GitHub refuses second pending review → dialog Failed |
| `s5-real-lost-response-adoption` | Remove marker prefix from `DraftThreadRequest.BodyMarkdown` | Adoption can't match on second submit → 2 threads (expected 1) |
| `s5-real-stale-commit-oid` _(spec skipped)_ | _(n/a while deferred — re-enable spec first; see deferrals doc)_ | _(n/a)_ |

## Known flake surfaces

- **Stale-OID spec, SSE-Reload-banner non-surfacing:** spec is currently `test.skip`ed pending root cause. Two hypotheses on file (GitHub PR record propagation lag, or BannerRefresh empty-render on first-poll-after-subscribe). See [deferrals doc](../specs/2026-05-11-s5-submit-pipeline-deferrals.md) for details.
- **Transient GitHub 5xx / rate-limit edge:** Fails one spec; re-run by hand. Repeated failures = real regression.

## Troubleshooting

- **"fixtures.json not found"** → run `npm run setup-real-e2e-fixtures`.
- **"gh: not authenticated"** → `gh auth login --scopes repo`.
- **"viewer login mismatch"** → your `gh` is authed as a different account than the one that generated `fixtures.json`. Re-run setup or switch context.
- **PR exists but branch is at unexpected SHA** → re-run setup script (idempotent: force-resets the branch).
- **Dangling pending review you can't delete via PRism** → `gh api graphql -f query='mutation { deletePullRequestReview(input: { pullRequestReviewId: "PRR_..." }) { pullRequestReview { id } } }'`

## Operator runbook (owner)

- **Onboarding a new teammate:** `gh api -X PUT repos/prpande/prism-sandbox/collaborators/<login> -F permission=push`. Share this doc.
- **Refreshing master if anchor file drifts:** any teammate's setup-script run handles it (the script reads master's current head as the new fixture base).
- **GC'ing stale fixtures for a teammate who left:** list their `e2e-real-*-fixture-<login>` branches via `gh api repos/prpande/prism-sandbox/branches` and delete via `gh api -X DELETE`.

## Pre-release sanity gate

For any version-tag release, run `npm run test:e2e:real` and confirm all 3 currently-active specs pass on first attempt. This is the rot-mitigation per design §10.
