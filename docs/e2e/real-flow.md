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
   This creates 4 long-lived branches+PRs on the sandbox under `e2e-real-{happy,foreign,lost-response,stale-oid}-fixture-<your-login>`. The script is idempotent: re-running with existing branches/PRs is a no-op (it reads the current branch tip as `baseOid`). To repair a drifted branch, delete the branch and PR on GitHub and re-run the script, or call `forceResetBranch` from `e2e/real/helpers/gh-sandbox.ts` directly.

## Running

```bash
cd frontend && npm run test:e2e:real
```

To run a single spec:

```bash
cd frontend && npx playwright test --config=playwright.real.config.ts s5-real-happy-path
```

Wall-clock ~5-8 minutes for the suite (4 active specs; the stale-oid spec adds a real `advanceHead` + Reload-banner + stale-recreate cycle that runs longer than the other three). `retries: 0` is intentional — see "Known flake surfaces" below.

## What each spec catches

| Spec                             | Surface                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s5-real-happy-path`             | FE `/mark-viewed` wire-up regression net; `addPullRequestReview` + `addPullRequestReviewThread` + `submitPullRequestReview` GitHub acceptance                                                 |
| `s5-real-foreign-pending-review` | `FindOwnPendingReviewAsync` GraphQL shape; TOCTOU re-fetch; draft-import flow; anchored-line enrichment from a real file blob                                                                 |
| `s5-real-lost-response-adoption` | `TestFailureInjectionHandler` seam itself; adoption-vs-foreign branching; **HTML-comment marker durability on live GitHub** (running C7 empirical gate)                                       |
| `s5-real-stale-commit-oid`       | `addPullRequestReview` at a non-head OID; `deletePullRequestReview` orphan cleanup; full stale-recreation pipeline against real GraphQL; SSE `pr-updated` wire-shape regression net (PR #65). |

## Verifying the regression nets

Per design §8 DoD: before merging a PR that touches the submit pipeline, run each one-line edit below, confirm the named spec fails, restore, and attest in the PR description.

| Spec                             | Edit to introduce                                                                                                                                    | Expected failure surface                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `s5-real-happy-path`             | Comment out `postMarkViewed(...)` in `frontend/src/hooks/usePrDetail.ts`                                                                             | `waitForResponse(/mark-viewed/)` times out → 400 `head-sha-not-stamped`                                |
| `s5-real-foreign-pending-review` | Force `FindOwnPendingReviewAsync` to return `null`                                                                                                   | Pipeline reaches Begin without foreign-detection; GitHub refuses second pending review → dialog Failed |
| `s5-real-lost-response-adoption` | Remove marker prefix from `DraftThreadRequest.BodyMarkdown`                                                                                          | Adoption can't match on second submit → 2 threads (expected 1)                                         |
| `s5-real-stale-commit-oid`       | Force `IsStaleCommitOid` to return `false` in the submit pipeline (or short-circuit it) so the second submit re-uses the pending review at `baseOid` | Final `reviews[0].commitOid === baseOid`, violating `expect(reviews[0].commitOid).toBe(newHeadOid)`    |

## Known flake surfaces

- **Stale-OID spec, fixture drift after interrupted run:** `advanceHead` has no post-run cleanup; an interrupted run + a regenerate of `fixtures.json` can leave `setup-real-e2e-fixtures` blessing the drifted tip as the new `baseOid`. Symptom: subsequent runs fail at "add comment on line N" because the seeded file no longer has line N. See out-of-band #2 in the investigation finding (`docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md`) for the planned hardening; until then, `forceResetBranch` runs in `beforeEach` (so an in-place re-run is safe) and a full recreate of the branch + PR is the manual escape hatch.
- **Transient GitHub 5xx / rate-limit edge:** Fails one spec; re-run by hand. Repeated failures = real regression.

## Troubleshooting

- **"fixtures.json not found"** → run `npm run setup-real-e2e-fixtures`.
- **"gh: not authenticated"** → `gh auth login --scopes repo`.
- **"viewer login mismatch"** → your `gh` is authed as a different account than the one that generated `fixtures.json`. Re-run setup or switch context.
- **PR exists but branch is at unexpected SHA** → the setup script does not force-reset existing branches. Delete the branch via `gh api -X DELETE /repos/prpande/prism-sandbox/git/refs/heads/<branch>` and re-run the setup script to recreate it, or call `forceResetBranch` from `e2e/real/helpers/gh-sandbox.ts` for a programmatic reset.
- **Dangling pending review you can't delete via PRism** → `gh api graphql -f query='mutation { deletePullRequestReview(input: { pullRequestReviewId: "PRR_..." }) { pullRequestReview { id } } }'`

## Operator runbook (owner)

- **Onboarding a new teammate:** `gh api -X PUT repos/prpande/prism-sandbox/collaborators/<login> -F permission=push`. Share this doc.
- **Refreshing fixtures if master / anchor file drifts:** the setup script only reads master's head when creating a _new_ fixture branch, so existing fixture branches keep their original anchor content. To refresh anchors, delete the affected fixture branch + PR and re-run the setup script.
- **GC'ing stale fixtures for a teammate who left:** list their `e2e-real-*-fixture-<login>` branches via `gh api repos/prpande/prism-sandbox/branches` and delete via `gh api -X DELETE`.

## Pre-release sanity gate

For any version-tag release, run `npm run test:e2e:real` and confirm all 4 currently-active specs pass on first attempt. This is the rot-mitigation per design §10.
