---
source-doc: docs/specs/2026-05-06-s3-pr-detail-read-design.md
created: 2026-05-07
last-updated: 2026-05-09
status: open
revisions:
  - 2026-05-07: PR5-design — recorded multimap chosen over (a) last-SSE-wins / (b) reject-second-SSE for `{cookieSessionId → Set<subscriberId>}`
  - 2026-05-08: PR6 implementation — recorded AbortController-keyed-to-Promise-generation defer for useActivePrUpdates subscribe POST
  - 2026-05-08: PR6 preflight reviewer pass — recorded reconnect-storm-no-backoff, ping-fetch-no-timeout, malformed-handshake-recovery, commentCountDelta-dedup, multi-tab-coordination, owner/repo route-param validation, useDelayedLoading 2nd-cycle race, PR-number permissive validation, no-degraded-UX-signal, reload-loop-tombstone, DELETE-before-POST race
  - 2026-05-08: PR6 review-loop pass — recorded empty-PrHeader-during-cold-load defer
  - 2026-05-08: PR7 preflight — recorded responsive-sheet, AI-focus-dot, inline-toast, viewed-semantics-graph-walk deferrals
---

# Deferrals — S3 PR-detail (read) spec

Tradeoffs surfaced during a multi-session rigor pass on the S3 spec. Source: `compound-engineering:ce-doc-review` 7-persona pass on 2026-05-07 (coherence + feasibility + product-lens + design-lens + security-lens + scope-guardian + adversarial), followed by an in-conversation rigor pass that labeled each finding Apply / Defer / Skip.

The original 26 Apply items landed in commit `6c2a487`. A subsequent **plan ce-doc-review pass** on the synced plan reversed several of those spec-level Apply items based on new plan-rigor evidence (3-persona consensus on some, on-main code drift on others, design redesign on one). Those reversals are recorded below with status `[Superseded]` so the temporal record stays clean.

The 4 Defer + 6 Skip items remain unchanged from the original rigor pass. The 5 `[Superseded]` entries are new this round.

## [Defer] AiHunkAnnotation slot premature scaffolding (B8)

- **Source:** `ce-doc-review` 7-persona pass — product-lens (confidence 0.75)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** The `IHunkAnnotator` interface ships in `PRism.AI.Contracts/Seams/` (already shipped in S0+S1, validated by the architectural commitment). The frontend `AiHunkAnnotation.tsx` component is dead UI in PoC ("never inserted in PoC even with toggle on" per spec § 4 line 30). The architectural-commitment goal — "every AI seam interface ships in S0+S1, placeholders graduate slice-by-slice" — is satisfied by the interface alone. The component file is implementer-discretion; either include it as a no-render stub or defer until v2 ships a concrete IHunkAnnotator.
- **Revisit when:** v2 AI ships a concrete `IHunkAnnotator` implementation that needs an inline-hunk-aligned widget surface. At that point, decide the placement geometry against the actual AI behavior (current spec assumes "above hunk header, gutter-aligned, max-width matches hunk width" — that geometry is a guess until real AI exists).
- **Original finding evidence:** "AI hunk annotations are *not* inserted in PoC even with the toggle on (per spec § 4: 'never inserted in PoC')"

## [Defer] Multi-window state.json corruption (B19)

- **Source:** `ce-doc-review` 7-persona pass — adversarial (confidence 0.78)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Real gap (two PRism windows on the same machine cause last-write-wins on `state.json` despite the per-launch token), but the fix is bigger than a spec edit — adding a named-mutex single-instance enforcement plus IPC for "focus existing window on second launch" deserves its own brainstorm. The S3 spec § 9.5 deferred-items table gained a row pointing at the new architectural-readiness backlog item: *"Before P0+ — single-instance via named mutex (Win32 `CreateMutex` / Unix `flock` on `state.json.lock`); on second launch, the existing window receives an IPC focus signal and the new launch exits."*
- **Revisit when:** A user reports lost viewed-marks from concurrent windows, OR before P0+ scope work begins (whichever comes first). Brainstorming should weigh named-mutex vs. mtime-based optimistic concurrency in `SaveAsync`.
- **Original finding evidence:** "Two PRism windows on the same machine each get their own per-launch token (X-PRism-Session) and each open the same state.json. … last-write-wins corruption."

## [Defer] Sub-1180px sheet auto-collapse pin affordance (D10)

- **Source:** `ce-doc-review` 7-persona pass — design-lens (confidence 0.62)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** Power users below 1180px who want to scan several files quickly cannot keep the file-tree sheet pinned (auto-collapse on file select). j/k still works without the sheet, but new users who don't know the shortcuts must repeatedly tap-open the sheet. Adding a pin toggle is a real UX improvement, but it's also implementer judgment whether the use-case justifies the affordance — the design-handoff prototype doesn't include a pin, and the alternative (auto-collapse keeps the diff pane the focal content) is defensible. Spec § 7.7 doesn't add the pin; implementer can if dogfooding surfaces the need.
- **Revisit when:** Dogfooding or a usability test surfaces "I keep losing my place opening/closing the sheet" complaints, OR S6 polish work explicitly addresses narrow-viewport ergonomics.
- **Original finding evidence:** "Power users who want to scan several files quickly cannot keep the sheet pinned. … No 'pin' affordance is specified; no decision recorded about why auto-collapse beats pin-toggle."

## [Defer] ForcePushMultiplier algorithmic change for CI-amend (B2 partial)

- **Source:** `ce-doc-review` 7-persona pass — adversarial (confidence 0.85, spec-lens partial)
- **Severity:** P1 (defer of finding's algorithmic suggestion; the spec § 11.5 wording clarification was Apply'd)
- **Date:** 2026-05-07
- **Reason:** The adversarial reviewer flagged that `ForcePushMultiplier` returns 1.0 (no signal) when force-pushes happen within `forcePushLongGapSeconds` (default 600s), and called this a "blind spot" for CI-amend pipelines. After rigor pushback: zero signal IS the correct signal — CI-amend pipelines should cluster as a single iteration because the user perceives them that way. The reviewer's proposed fix (add CI-amend-aware multiplier or carve CI-amend out of coverage) misreads the algorithm's design intent. § 11.5 was clarified to state CI-amend's expected ground truth as "1 iteration covering the entire amend sequence" — no algorithm change needed.
- **Revisit when:** Discipline-check empirically shows >70% disagreement on CI-amend PRs even when the developer's own ground truth is "1 iteration", indicating a different signal failure than the one the reviewer hypothesized. Or: P0+ calibration corpus reveals a class of CI-amend pipelines the developer DOES perceive as multiple iterations (e.g., long-running CI failures interspersed with feature work).
- **Original finding evidence:** "ForcePushMultiplier returns 1.5 only when Δt > 600s. In a CI-amend pipeline where the user force-pushes every 30s for 10 fast amend commits in 30 seconds, every Δt is < 600s, so the multiplier collapses to 1.0 for every pair. The algorithm has zero force-push signal in exactly the 'CI-amend pipeline' scenario the discipline check (§ 11.5 step 1) is supposed to validate."

## [Skip] Disabled Drafts tab is phantom affordance (B7)

- **Source:** `ce-doc-review` 7-persona pass — product-lens (confidence 0.65)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** The product-lens reviewer argued for hiding the Drafts tab in S3 (show only Overview + Files until S4 lights up the composer). Counter-argument that wins: `design/handoff/` is authoritative on visual/interaction conflicts (per CLAUDE.md and the saved memory `design_handoff_authoritative`), and the handoff's 3-tab strip exists for a reason — discoverability of the slice's eventual scope. The 0.65 confidence on the reviewer's side, weighed against the explicit handoff-wins authority, drops the finding.
- **Revisit when:** N/A — design choice with established authority. Only revisit if the handoff itself changes to drop the Drafts tab in S3.

## [Skip] Reload-not-mount sophisticated mental model (B9)

- **Source:** `ce-doc-review` 7-persona pass — product-lens (confidence 0.70)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** The product-lens reviewer flagged that "Reload doesn't write `lastViewedHeadSha` until first re-mount" is a sophisticated mental model — most apps treat Reload as "consider this seen." The decision was already weighed and chosen via Q2 in the original brainstorming session that produced the spec; § 3 deviations row records the deliberate intent (Reload is reversible, first-mount is the explicit commitment). Re-litigating without new evidence violates the "don't retreat unless new evidence" rule.
- **Revisit when:** N/A unless dogfooding surfaces concrete user confusion about the unread-badge behavior. If users complain "I clicked Reload, why is it still unread?", the decision is a candidate for reversal.

## [Skip] SkippableFact harness over-engineered (B10)

- **Source:** `ce-doc-review` 7-persona pass — scope-guardian (confidence 0.72)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Scope-guardian argued for replacing `Xunit.SkippableFact` + permanent test class with a throwaway console tool, on the grounds that the discipline check is described as "one-shot." Counter-argument: the cost is small (one NuGet dep + one test class), and the harness is expected to re-run when new multipliers are added in P0+ — making it less one-shot than the framing suggests. Reusing xunit infrastructure is cheaper than maintaining a parallel console runner. § 11.5 was updated to state this explicitly ("expected to re-run when new multipliers are added in P0+").
- **Revisit when:** N/A unless P0+ calibration concludes the harness is genuinely one-shot and won't re-run. Cost of removing then is also small.

## [Skip] overview-card-hero-no-ai modifier is design padding (B26)

- **Source:** `ce-doc-review` 7-persona pass — scope-guardian (confidence 0.60)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Scope-guardian wanted to drop the `overview-card-hero-no-ai` CSS modifier on grounds that AI-off Overview being "not generic-dashboard" is design padding. Same authority resolution as B7: `design/handoff/` is authoritative, and the spec defers to the handoff. Without reading the handoff to confirm the non-AI hero treatment is shown there, the safe default is to keep — the spec's job isn't to second-guess the handoff.
- **Revisit when:** Handoff changes to drop the non-AI hero treatment, or the implementation finds the modifier produces visual weirdness that contradicts the handoff's intent.

## [Skip] Endpoint consolidation mark-viewed + files/viewed (SG4)

- **Source:** `ce-doc-review` 7-persona pass — scope-guardian (confidence 0.55)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** Scope-guardian argued the two POST endpoints could merge into a single tagged-body POST. Counter-argument: they have legitimately different request shapes (`{headSha, maxCommentId}` vs `{path, headSha, viewed}`), different stale-headSha semantics, and the security-middleware exercises double-cover the contract instead of leaving an under-tested merged endpoint. The "savings" (one route, one test row, one middleware exercise) are minor compared to the loss of contract clarity. Two endpoints is the right cut.
- **Revisit when:** A future composer/reply endpoint shape forces a third "viewed-shaped" endpoint, at which point a unified `POST /api/pr/{ref}/state-update` with a discriminator might be worth the refactor.

## [Skip] Defer PrRootConversation to S4 (SG5)

- **Source:** `ce-doc-review` 7-persona pass — scope-guardian (confidence 0.55)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** Scope-guardian argued that read-only PR-root conversation without the reply composer is incomplete and should defer to S4 alongside the composer. Counter-argument: the inclusion was an explicit Q4 user decision in the original brainstorming — single API call, single read-only list, low-cost — that the spec records under § 3 deviations. The "incomplete affordance" objection is the same argument as B7 (Drafts tab) and lands in the same place: deliberate user choice, recorded, holds.
- **Revisit when:** N/A unless dogfooding shows users repeatedly trying to reply on the read-only feed and getting frustrated. S4 should treat the existing read-only feed as "already there, just wire the composer" rather than re-litigating the inclusion.

---

## Meta-process decisions during this review pass

The following decisions were made in-conversation during the S3 rigor pass + the follow-up slimming pass on 2026-05-07. They are about the **deferrals tracking system itself** (where deferrals docs live, what they cover, how they're indexed, how the rule is automated) rather than the S3 spec content. Recorded here for context until a dedicated `CLAUDE-deferrals.md` (or similar repo-meta sidecar) surfaces if more such decisions accumulate.

### [Skip] Appendix-inside-source-doc layout for deferrals

- **Source:** in-conversation layout question (AskUserQuestion 3-option choice) — 2026-05-07
- **Severity:** n/a (process decision)
- **Date:** 2026-05-07
- **Reason:** Considered putting deferrals as a "Review deferrals" appendix inside each spec/plan source doc. Rejected because (a) source doc grows over time, mixing design content with review meta-decisions; (b) hard to skim deferrals across the corpus; (c) deferrals can come from multiple sessions, accumulating into a doc tail that competes with the design narrative. Sidecar wins on separation-of-concerns.
- **Revisit when:** N/A unless sidecar maintenance overhead becomes a real cost.

### [Skip] Top-level dated files layout for deferrals

- **Source:** in-conversation layout question (AskUserQuestion 3-option choice) — 2026-05-07
- **Severity:** n/a (process decision)
- **Date:** 2026-05-07
- **Reason:** Considered `docs/deferrals/YYYY-MM-DD-<topic>-review.md` per review session. Rejected in favor of sidecar (`<source>-deferrals.md` next to the source doc). Sidecar wins on (a) provenance: future-us editing the source doc sees the deferrals adjacent in the directory listing, no cross-link traversal; (b) renames stay coupled (mv source moves both); (c) one sidecar per source covers multiple sessions over time, while top-level dated files fragment per-session.
- **Revisit when:** N/A unless cross-corpus chronological browsing becomes the primary access pattern (currently per-source is dominant).

### [Skip] Separate top-level `docs/deferrals/` index directory

- **Source:** in-conversation push-back from user — 2026-05-07
- **Severity:** n/a (process decision)
- **Date:** 2026-05-07
- **Reason:** Initial draft created `docs/deferrals/README.md` as a cross-corpus index of all sidecars. User pushed back: existing `docs/specs/README.md` already manages spec metadata corpus-wide (status groups, plan refs, PR refs); extending one bullet line per spec to also reference its deferrals sidecar is cheaper than spinning up a new top-level directory with its own README. Cross-corpus discovery is satisfied by the spec index's existing role. Don't create new management infrastructure when existing infra already covers the use case.
- **Revisit when:** A non-spec/non-plan source doc (e.g., a top-level architecture doc) accumulates a sidecar that has no natural home in `docs/specs/README.md` or `docs/plans/README.md` (the latter doesn't yet exist). At that point, either extend the affected README or — only if many such cases accumulate — introduce a cross-corpus index.

### [Skip] CI-driven automation for deferrals tracking

- **Source:** in-conversation framing question — 2026-05-07
- **Severity:** n/a (process decision)
- **Date:** 2026-05-07
- **Reason:** User asked for "automation". Considered adding a `.github/workflows/` step that fails the build if a `ce-doc-review` was run without a corresponding deferrals-doc commit. Rejected because (a) the existing PRism doc-maintenance pattern is human-discipline-via-CLAUDE.md, not CI; (b) parallel mechanisms for one rule add cognitive load; (c) the team size doesn't yet justify CI tooling overhead; (d) the rule's scope (any planning/architectural decision) is hard to detect from a diff — a brainstorming Q-decision doesn't produce a deterministic file signature. Claude is the executor; CLAUDE.md is the trigger.
- **Revisit when:** Team grows past the size where Claude-as-executor-via-CLAUDE.md works reliably (multiple contributors who haven't internalized the rule), OR a missed deferral causes a real "we re-decided the same thing" incident worth a CI-tooling investment.

### [Skip] Verbose CLAUDE.md addition (47 lines with full subsections)

- **Source:** in-conversation slimming pass — 2026-05-07
- **Severity:** n/a (process decision)
- **Date:** 2026-05-07
- **Reason:** Initial CLAUDE.md draft added 47 lines including full subsections for "Spec→plan sync rule" and "Deferrals tracking", with a sources table, status taxonomy, failure-modes prose, and how-automatic discussion. User pushed back: the existing doc-maintenance pattern is "table row + short paragraph", and the subsection content duplicated info that lives better in the schema/sidecar itself. Slimmed to 23 lines: 2 table rows + 1 brief schema fenced block + a few sentences. The schema and source taxonomy live in the sidecar README and the first sidecar respectively; CLAUDE.md just states the rule.
- **Revisit when:** A future contributor finds the slim version under-specified and asks for more guidance. At that point, expand selectively rather than restoring the full bloat.

---

## Spec-rigor Apply items reversed by plan-rigor pass

The following items were Apply'd during the original spec-rigor pass (commit `6c2a487`) and then reversed during the plan-rigor pass + Q1-Q6 user decisions on 2026-05-07. They're recorded here as `[Superseded]` so the temporal record stays clean: future readers see what was tried, why it was reversed, and where the new design lives.

### [Superseded] IDistanceMultiplier signature change to pair-local `Multiply(before, after, forcePushesInGap)`

- **Source:** Originally `[Apply]` from spec-rigor pass A9 (2026-05-07); reversed by Q1 user decision after plan-rigor feasibility reviewer P1.1 surfaced on-main code drift
- **Severity:** P1
- **Date:** 2026-05-07
- **Reason:** Spec-rigor accepted A9's "show the IDistanceMultiplier signature so the additivity claim is checkable" finding. The signature shown in the spec edit was an idealized guess — `Multiply(Commit before, Commit after, IReadOnlyList<ForcePushEvent> forcePushesInGap)` — that didn't match on-main code (PR #15 shipped `For(ClusteringCommit prev, ClusteringCommit next, ClusteringInput input, IterationClusteringCoefficients coefficients)` with whole-input access). The drift was created by the spec rigor pass itself, not by an actual design intent. Plan-rigor feasibility reviewer P1.1 caught the contradiction. Reverted to the on-main signature: spec § 6.4 now shows `For(...)` with whole-input access; the plan's Task 2 follow-up signature-change item is dropped.
- **Revisit when:** N/A unless the team decides to do a non-trivial back-port to narrow the interface to pair-local. Cost (back-port + ripple through `FileJaccardMultiplier`'s cap-gate logic) is real; benefit (additivity checkability) is theoretical.
- **New decision lives in:** spec § 6.4 (revised pseudocode in commit applying Q1).

### [Superseded] OneTabPerCommitClusteringStrategy as discipline-check fallback

- **Source:** Originally `[Apply]` from spec-rigor pass B1 (2026-05-07); reversed by Q5 user decision after plan-rigor 3-persona consensus + design redesign
- **Severity:** P1
- **Date:** 2026-05-07
- **Reason:** Spec-rigor accepted B1's "70% gate has no failure criterion" finding by adding `OneTabPerCommitClusteringStrategy` as a deterministic fallback (one IterationCluster per commit, sorted by `committedDate`). Plan-rigor 3-persona consensus (product-lens P2.24, scope-guardian SG5, adversarial A8) flagged this as both preemptive (build infra you might not need) AND wrong-shaped (one-tab-per-commit produces N tabs which scales poorly, e.g., 50-commit PR → 50 tabs). User-redesign during Q5 produced a cleaner fallback: `ClusteringQuality: Ok | Low` signal on `PrDetailDto`, with frontend swapping `IterationTabStrip` ↔ `CommitMultiSelectPicker` based on the signal. Same fallback UX for three triggers: ≤1 commit, per-PR degenerate detector, global `iterations.clusteringDisabled = true` config flag.
- **Revisit when:** N/A — superseded design is materially better. If `CommitMultiSelectPicker` proves wrong-shaped in dogfooding, redesign happens against THAT, not against OneTabPerCommit.
- **New decision lives in:** spec § 6.4 (ClusteringQuality types + revised pseudocode), § 7.2.1 (CommitMultiSelectPicker frontend section), plan Task 2 follow-up + Task 4 + Task 7.

### [Superseded] `SkipJaccardAboveCommitCount` lowered 100 → 50

- **Source:** Originally `[Apply]` from spec-rigor pass B5 (2026-05-07); reversed by Q6 user decision after plan-rigor scope-guardian P2.27
- **Severity:** P1
- **Date:** 2026-05-07
- **Reason:** Spec-rigor accepted B5's "per-commit fan-out trips secondary rate limit" finding by lowering the cap from 100 to 50 + adding 100ms inter-batch pace + adding dedicated `x-ratelimit-resource: secondary` handling. Plan-rigor scope-guardian P2.27 challenged the cap-lowering: no measurement justifies 50 over 100; halving the budget halves Jaccard signal on 50-100 commit PRs (a common dogfood size) without proven defensive benefit; the 100ms inter-batch pace + concurrency-8 cap alone are the actual defense. User Q6 confirmed: revert cap to 100, keep the pacing + cap defense, simplify 403 handling.
- **Revisit when:** Dogfooding empirically trips secondary rate limits at 100 commits (in which case lower to 50 with measurement evidence).
- **New decision lives in:** spec § 6.4 implementation note, plan Task 2 follow-up coefficient defaults.

### [Superseded] Dedicated `x-ratelimit-resource: secondary` header parsing + Retry-After respect

- **Source:** Originally `[Apply]` from spec-rigor pass B5 (paired with cap-lowering, 2026-05-07); reversed by Q6 user decision after plan-rigor scope-guardian P2.28
- **Severity:** P1
- **Date:** 2026-05-07
- **Reason:** Spec-rigor accepted dedicated handling for 403 responses with `x-ratelimit-resource: secondary` header — pause for `Retry-After`, set `_secondaryRateLimitTripped` session flag, degrade. Plan-rigor scope-guardian P2.28 challenged: GitHub's secondary-limit error shape isn't a stable contract (the header isn't formally documented as guaranteed across all endpoints); generic "any 403/4xx in fan-out → mark `ChangedFiles = null`, mark session degraded, log warning, continue" handles the same failure case without parsing headers, without an integration smoke test that's typically skipped, and without session-scoped flag bookkeeping. User Q6 confirmed: drop the dedicated handling.
- **Revisit when:** GitHub formally documents the secondary-rate-limit response shape AND dogfooding shows the simpler degrade misses important recovery (e.g., we keep retrying past Retry-After and exhausting tokens). Currently no evidence of either.
- **New decision lives in:** spec § 10.1 (consolidated 403/4xx row), plan Task 2 follow-up.

### [Superseded] Bespoke `BodySizeLimitMiddleware` for 16 KiB cap on mutating endpoints

- **Source:** Originally `[Apply]` during spec-rigor pass (P0-shaped security finding via several reviewers); reversed by plan-rigor scope-guardian P2.3
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Spec-rigor accepted the security need to cap mutating endpoint bodies at 16 KiB. Implementation chose a bespoke `BodySizeLimitMiddleware` with explicit pipeline-ordering, `CappedRoutes` substring path-matcher, and Content-Length null-rejection logic. Plan-rigor scope-guardian P2.3 challenged: ASP.NET Core ships `[RequestSizeLimit]` endpoint metadata + Kestrel's per-route `MaxRequestBodySize` for free; bespoke middleware is parallel infrastructure with substring path-matching that's fragile to new endpoints. Replaced with `[RequestSizeLimit(16384)]` attribute on the four mutating route declarations. Same cap, same pre-binding rejection, framework-native handling for chunked encoding.
- **Revisit when:** N/A — framework primitive does the job. Only revisit if a future need (e.g., dynamic per-endpoint cap based on route metadata) outgrows `[RequestSizeLimit]`.
- **New decision lives in:** spec § 8 pipeline ordering, plan Task 5 endpoint declarations.

## [Superseded] Cookie-only on `/api/events`, header-only on other `/api/*` (cookie-OR-header now)

- **Source:** PR5 implementation — CI build-and-test failure on PR #22 surfaced that the existing frontend's `apiClient` does not echo `X-PRism-Session` as a header. Same-origin fetch carries the cookie automatically; the strict cookie-vs-header split landed in the original spec broke every existing SPA call.
- **Severity:** P1 (broke existing frontend; CI red on cold-start + no-browser e2e tests)
- **Date:** 2026-05-08
- **Reason:** Original spec § 8 prescribed cookie-only on `/api/events` (because EventSource can't set custom headers) and header-only everywhere else (defending against same-origin cookie replay from a stale tab). In practice the SPA shipped in earlier slices does NOT read `document.cookie` and echo as `X-PRism-Session` — it relies on the browser's automatic cookie attachment for same-origin fetches. The strict header-only policy on non-SSE `/api/*` would have required a frontend update to land in the same PR, which is out of S3 PR5's backend-only scope. Widening to cookie-OR-header preserves the security model: cookie is per-process random, `SameSite=Strict` (cross-origin attackers cannot get it sent), and `OriginCheckMiddleware` rejects empty Origin on mutating verbs. Cookie-only auth on /api/* is equivalent proof of session because all three protections compose. `/api/health` is exempted entirely (liveness probe convention; no sensitive data).
- **Revisit when:** N/A — cookie-OR-header is the long-term policy. The frontend can still echo the header for clients that prefer that style; both forms work. Only revisit if a future threat surfaces that distinguishes cookie from header (none currently in the spec § 6.2 threat model).
- **Original finding evidence:** Spec § 8 (line 956 pre-edit) "For mutating verbs and GETs other than `/api/events`, the middleware reads `X-PRism-Session` from the request header. For `GET /api/events` ..., the middleware reads the same token from the `prism-session` cookie." Now superseded — § 8 reads "accepts EITHER the `X-PRism-Session` request header OR the `prism-session` cookie value."

## [Defer] Reconnect storm — no backoff or jitter on watchdog/onerror reconnect

- **Source:** PR6 preflight — reliability reviewer (P2)
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** `events.ts:reconnect()` unconditionally calls `connect()` to open a fresh EventSource. If the server is flapping (5xx during a deploy, LB returning RST, captive-portal interception), each new connection fires `onerror` almost immediately, hits the ping path, and triggers another reconnect. No exponential backoff, no jitter, no soft cap. PR6 inherits the simpler "reconnect immediately" model from the spec § 7.4 prose, which only specifies *what* to reconnect on, not *with what timing discipline*. Native browser EventSource retry is suppressed by our explicit `es.close() + new EventSource()` pattern, so we lose its built-in 3–5s baseline. Real-world impact bounded by ping-path-once-per-instance (events.ts:88) + the captured-self guard (events.ts:80) which prevent duplicate reconnects from a single failure event, but a *persistent* server-side flap would still produce a tight loop.
- **Revisit when:** Dogfooding produces a connection-flap incident OR a load test of the local backend during deploy reveals the storm. Plan for the fix: 1s → 2s → 4s → 8s → 16s → 30s capped exponential backoff with ±25% jitter, reset on `subscriber-assigned` arrival.
- **Original finding evidence:** "Reconnect storm under flapping network — no backoff, no jitter, no max attempts. … Tight loop bounded only by ping latency."

## [Defer] /api/events/ping probe has no timeout — hung probe stalls reconnect indefinitely

- **Source:** PR6 preflight — reliability reviewer (P2)
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** `events.ts:onerror → fetch('/api/events/ping')` has no `AbortSignal.timeout()` wrapper. If the backend is partitioned mid-request (TCP black hole — LB dropped the connection but kernel hasn't reset), the fetch hangs for the browser default (often 60–300s). During that window `probed=true` so subsequent `onerror` fires no-op and the watchdog isn't running (no events arriving means no watchdog reset, but it also doesn't fire — only set on connection open). Stream wedges silently until OS-level fetch timeout. The captured-self guard added in PR6 doesn't help: it gates against superseded EventSources, not against a hung probe on the *current* one.
- **Revisit when:** Dogfooding observes a "page unresponsive on bad network" symptom OR the reconnect-storm fix lands (likely paired). Suggested fix: `fetch('/api/events/ping', { signal: AbortSignal.timeout(5000) })` + AbortError → reconnect.
- **Original finding evidence:** "If the backend is partitioned mid-request … this fetch hangs for the browser default (often 60–300s) … stream wedges silently until OS-level fetch timeout."

## [Defer] Malformed `subscriber-assigned` handshake leaves idPromise pending forever

- **Source:** PR6 preflight — reliability reviewer (P2) + adversarial (P2)
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** `events.ts` subscriber-assigned handler wraps `JSON.parse` in try/catch; on parse failure, swallows and resets the watchdog. `idPromise` stays pending. `useActivePrUpdates`'s loop awaits `stream.subscriberId()` and never proceeds — no subscribe POST fires for the lifetime of this stream. Probability is low (server is trusted same-origin), but the failure is silent and persistent until the user navigates away or the watchdog stalls (which only fires after 35s of no events — heartbeats from the same stream still reset it, so the dead-handshake state can persist for the full session). Captured-self guard doesn't help here.
- **Revisit when:** Dogfooding produces "banner never fires for this PR" reports OR a proxy/load-balancer in deploy injects a malformed subscriber-assigned event. Suggested fix: on parse failure of `subscriber-assigned`, call `reconnect()` instead of just resetting the watchdog. Alternative: expose an `onError` callback on the stream so consumers can surface the broken state in UI.
- **Original finding evidence:** "subscriber-assigned listener wraps JSON.parse in try/catch; on parse failure, swallows and just resetsWatchdog(). idPromise stays pending."

## [Defer] commentCountDelta accumulates across SSE reconnects without dedup

- **Source:** PR6 preflight — reliability reviewer (P2)
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** `useActivePrUpdates` aggregates `commentCountDelta` additively for the lifetime of the hook (only reset by `clear()`). On SSE reconnect (watchdog or onerror path), the server may resend the same `pr-updated` events from a buffered queue — there is no event-id resume protocol in the current SSE design. The same delta could be counted twice. `headShaChanged` is boolean OR so re-delivery is harmless there. The banner copy "N new comments" could overcount.
- **Revisit when:** SSE protocol gains an event-id resume header (Last-Event-ID per spec) AND the backend implements at-most-once delivery, OR dogfooding shows visible count drift. Suggested fix: assign a server-side event id to each `pr-updated`, dedup client-side. Or: coerce `commentCountDelta` to a boolean "has-new-comments" indicator until the resume protocol is defined.
- **Original finding evidence:** "If the SSE stream reconnects mid-session, the server may resend events … the same delta can be counted twice."

## [Defer] Multi-tab coordination — every tab opens its own EventSource and runs independent reload-on-401

- **Source:** PR6 preflight — adversarial reviewer (P2)
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** `EventStreamProvider` mounts once per tab (no SharedWorker / BroadcastChannel coordination). With 5 PRism tabs open, a session-rotation event fires `onerror` on all 5 EventSources simultaneously, each pings, each receives 401, each reloads. 5× navigation burst, 5× /api/auth/state during reload race. Some tabs route to /setup, others to /, others retry — inconsistent state across tabs. Same applies to subscribe POST: each tab subscribes independently to the same prRef, leaving N entries on the server side for one user-visible PR. The cookie-keyed multimap design (deferrals entry below) accommodates this server-side, but the client-side fanout is still wasteful.
- **Revisit when:** Multi-tab dogfooding produces a "tabs in different states" symptom OR a load test of the auth-rotation path shows the burst. Long-term fix: SharedWorker for SSE. Short-term fix: `BroadcastChannel('prism-auth')` so only the first tab to detect 401 fires the reload; others observe the broadcast and route to /setup via the existing `prism-auth-rejected` event.
- **Original finding evidence:** "Every PRism tab opens its own EventSource and runs independent reload-on-401 logic. … Network burst of >50 requests against the local backend."

## [Defer] Reload-on-401 tombstone — defense-in-depth against reload loop

- **Source:** PR6 preflight — adversarial reviewer (P1, but mitigated by EventStreamProvider gating); security reviewer concurred path is safe
- **Severity:** P2 (defensive — the current path is sound *if* `useAuth` correctly transitions `isAuthed` to false on cookie rotation; tombstone protects against future regressions)
- **Date:** 2026-05-08
- **Reason:** `events.ts` `onerror → fetch('/api/events/ping')` returns 401 → `window.location.reload()`. After reload, `App.tsx:78` only mounts `EventStreamProvider` when `isAuthed`, which derives from `useAuth().authState.hasToken`. If `/api/auth/state` correctly returns `hasToken: false` on cookie rotation, no SSE re-opens and no loop occurs. Path is safe. But: a future refactor that mounts `EventStreamProvider` unconditionally, or a session bug where `useAuth` reports `hasToken: true` despite a stale cookie, would create a tab-bound infinite reload loop. Adversarial reviewer cited 0.82 confidence; security reviewer cited the gating mitigation.
- **Revisit when:** Either of the trigger conditions surfaces (refactor of `EventStreamProvider` mounting, or a `useAuth`/cookie-rotation timing bug). Suggested defense: `sessionStorage.setItem('prism-auth-reload', Date.now())` before reload; on next mount check the timestamp and if a reload happened within e.g. 10s, suppress and dispatch `prism-auth-rejected` instead of reloading again. Plus: add a regression test asserting `EventStreamProvider` does not mount on `/setup`.
- **Original finding evidence:** "Trigger: SessionTokenMiddleware rejects … the browser still has a stale cookie. … Indefinite reload loop until user closes the tab."

## [Defer] DELETE-before-POST ordering race on rapid mount-unmount

- **Source:** PR6 preflight — reliability reviewer (P1) + correctness reviewer (P2) + adversarial reviewer (P2 race-on-Outlet-remount)
- **Severity:** P2 (server-side state drift; user-visible failure is "banner stops firing" until next session)
- **Date:** 2026-05-08
- **Reason:** `useActivePrUpdates` cleanup fires `apiClient.delete(...)` synchronously on unmount. If unmount happens between `await stream.subscriberId()` and the POST landing on the server, network reordering can deliver DELETE before POST. Server idempotency on DELETE for unknown prRef = 204 noop, but POST after DELETE leaves a *dangling* subscription. Subsequent dogfooding when the user revisits the same PR → POST adds a second entry; cookie-keyed multimap accommodates, but server-side load grows without cleanup. Also relevant for React StrictMode dev double-mount: mount → POST queued → unmount → DELETE → mount → POST → DELETE-before-POST possible. The deferred AbortController-on-subscribe (entry below) addresses the in-flight cancellation; this entry adds the *server-side ordering-resilience* angle.
- **Revisit when:** Same trigger as the AbortController defer — if dogfood SSE reconnect storms or rapid mount-unmount cycles produce visible subscription leakage. Fix candidates: (a) sequence-numbered subscribe/unsubscribe with server-side discard of stale DELETEs, (b) await the POST in cleanup using `navigator.sendBeacon` for unmount-during-unload paths, (c) hook the AbortController fix to also synchronize the cleanup DELETE to fire only after the POST resolves.
- **Original finding evidence:** "DELETE may arrive at the server before the POST. With idempotent server semantics this is benign … but a subscription leak across many sessions accumulates."

## [Defer] No user-visible signal when SSE is permanently broken

- **Source:** PR6 preflight — reliability reviewer (P1)
- **Severity:** P2 (degradation UX, not correctness)
- **Date:** 2026-05-08
- **Reason:** All SSE error paths swallow silently — subscribe POST failures, ping failures, malformed handshake. The only user-visible contract is `BannerRefresh` (rendered iff `hasUpdate`). If SSE is broken, the user sees a static page with no indication that updates won't arrive. Spec § 7.4 implicitly treats SSE as "best-effort" but the implementation doesn't surface degradation. Out of PR6 scope (not in spec § 7.4 explicitly), but worth tracking.
- **Revisit when:** Dogfooding produces "I didn't see the banner update" complaints, OR a future spec slice formalizes a streamHealthy boolean. Suggested fix: track a `streamHealthy` boolean inside the EventStreamHandle (true after first successful subscriber-assigned, flips to false on N consecutive errors); surface a subtle "Updates paused — Reload to refresh" indicator in the header when false for >30s.
- **Original finding evidence:** "Every error path is a silent .catch(() => {}) … the user sees a static page with no indication that updates won't arrive."

## [Defer] Owner/repo route-param validation in PrDetailPage

- **Source:** PR6 preflight — security reviewer (P3) + adversarial reviewer (P3 PR-number permissive)
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** `PrDetailPage` parses `:owner`, `:repo`, `:number` from route params. `number` is guarded via `Number.isNaN`, but: (a) `Number('-1')`, `Number('0')`, `Number('1.5')`, `Number('1e3')`, `Number('  42  ')` all pass the guard; (b) `owner` and `repo` are not validated against GitHub's repo-name grammar (alnum + `-`, `_`, `.`). Adversarial values like `..` or `%2e%2e` are constrained server-side by route-binding (`{number:int}`), so the worst case is a wasted GitHub API call with `owner=".."`. Server validates all three before dispatching to GitHub APIs. JSX auto-escapes when these values render in PrHeader. Risk is bounded to wasted upstream calls and noisy 4xx logs — not exploitable.
- **Revisit when:** Dogfooding shows users hitting the page with malformed deep-links, OR a future security review tightens the input-validation perimeter. Fix: validate at the boundary with `^[A-Za-z0-9._-]+$` for owner/repo and `^[1-9]\d*$` for number; render the same `Invalid PR reference` alert path that's already in place for missing/non-numeric `number`.
- **Original finding evidence:** "Owner and repo are not validated against GitHub's repo-name grammar … `Number('1e3')` passes the NaN guard."

## [Defer] useDelayedLoading second-loading-cycle race — showStartedAt not re-stamped

- **Source:** PR6 preflight — adversarial reviewer (P3)
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** If a second loading cycle starts while `show` is still `true` from the previous cycle's hold window, `showStartedAt` is never re-stamped. When the second cycle completes, `remaining = HOLD_MS - (Date.now() - showStartedAt)` may be negative (skeleton clears immediately), defeating the anti-flicker contract for back-to-back rapid reload clicks. User-visible impact: rapid Reload→Reload causes the second cycle's spinner to flash off too soon. Edge case (requires sub-100ms-spaced reload clicks); the existing tests don't cover this scenario. The fix is small (track `actualIsLoading` via ref and re-stamp `showStartedAt` on each false→true edge of `actualIsLoading` even when `show` is already `true`).
- **Revisit when:** A user reports "skeleton flickers when I click Reload twice fast", OR S6 polish work explicitly addresses skeleton-timing micro-UX.
- **Original finding evidence:** "useDelayedLoading race when actualIsLoading toggles within 100ms WAIT_MS — stale showStartedAt yields HOLD past completion."

## [Defer] AbortController.signal keyed to Promise generation on subscribe POST

- **Source:** PR6 implementation — useActivePrUpdates design choice; surfaced while deciding whether to extend apiClient with optional `{ signal }` opts
- **Severity:** P2 (defensive correctness; no observable user impact in PoC)
- **Date:** 2026-05-08
- **Reason:** Spec § 7.4 prescribes that `POST /api/events/subscriptions` calls run with an `AbortController.signal` returned by `EventStreamHandle.reconnectSignal()`, "keyed to the current Promise generation; on reconnect (Promise re-resets), all in-flight POSTs are aborted before new ones fire against the new subscriberId." `useActivePrUpdates` ships in PR6 *without* this wiring — it simply awaits `stream.subscriberId()` and POSTs once, with no abort on reconnect. The defense is sound but unnecessary in PoC because the backend's `TrySubscribe(cookieSessionId, prRef)` resolves to the *most recent* `subscriberId` for the cookie (per the multimap design — same deferrals doc, the `[Skip] Singular {cookieSessionId → subscriberId} map` entry below). Even an in-flight POST landing post-reconnect routes to the new `subscriberId`, so correctness holds. The abort signal protects against wasted work during reconnect storms and against future server-side semantics changes that might tighten the cookie/subscriber pairing. `apiClient.post/get/delete` remains signal-less in PR6; extending it lands with this defer.
- **Revisit when:** Dogfooding shows visible latency from queued in-flight subscribe POSTs during SSE reconnect storms, OR a security review tightens the cookie/subscriber pairing semantics so an in-flight POST under a stale `subscriberId` is no longer routed correctly.
- **Original finding evidence:** Spec § 7.4 — "Subscribe POSTs are issued with an `AbortController.signal` keyed to the current Promise generation; on reconnect (Promise re-resets), all in-flight POSTs are aborted before new ones fire against the new subscriberId."
- **Where the gap lives in code:** `frontend/src/hooks/useActivePrUpdates.ts:21-37` (the `apiClient.post(...)` call has no `signal` option); `frontend/src/api/client.ts` (apiClient.get/post/delete signatures don't accept `{ signal }` yet).

## [Defer] Empty `<h1>` and author span in `PrHeader` during cold-load window

- **Source:** PR6 review-loop pass — Copilot inline review on commit `fbf9890` (comment 3207130646)
- **Severity:** P3 (a11y polish; no correctness impact, contained to first fetch / PR-navigation window after `usePrDetail` reload-flash fix)
- **Date:** 2026-05-08
- **Reason:** `PrDetailPage` renders `PrHeader` unconditionally and passes `data?.pr.title ?? ''` / `data?.pr.author ?? ''` while the detail fetch is in flight, producing a literally empty `<h1 class="pr-title" />` and empty `<span class="pr-subtitle-author" />` until `data` resolves. Spec § 7.6 (line 838) calls for a *delayed* skeleton on the loading state ("header bar + 3-tab strip + body grid placeholder, renders only if pending > 100 ms; holds ≥ 300 ms"); the current implementation only skeletonises the body grid (`{showSkeleton ? <PrDetailSkeleton /> : <Outlet />}`) and leaves the header bar in its real DOM with empty fields. Two prior reviewer passes (Copilot + claude-review) classified the PR as merge-ready before this finding surfaced. The cleanest spec-aligned fix is non-trivial — either a header-skeleton component (new CSS shimmer placeholders for title/author + skeletonised tab strip) gated on `showSkeleton`, or restructuring `PrHeader` to take an optional `data` prop and render placeholder bars internally. Both options touch design-system tokens (`design/handoff/tokens.css`) and exceed the scope of "address open review comments". The owner/repo/`#number` chrome derived from URL params *does* render correctly during cold-load, so users still get orientation. After the f6be600 + fbf9890 fixes, the empty-fields window is bounded to (a) initial cold mount until the first fetch resolves, and (b) PR navigation between different PRs — never on Reload anymore.
- **Revisit when:** S6 polish work explicitly addresses skeleton-timing micro-UX, OR an a11y review flags the empty `<h1>` as a release blocker, OR design-handoff lands a header-skeleton spec. Fix candidates: (1) gate `<h1>` and author span rendering on `title` / `author` being non-empty (drops them from the DOM during loading — fewer a11y signals but no empty elements); (2) introduce a `pr-header-skeleton` shimmer placeholder bound to `showSkeleton`; (3) move `PrHeader` *inside* the `showSkeleton ? <PrDetailSkeleton /> : ...` branch so loading shows a full-page skeleton (closest to spec § 7.6 wording).
- **Original finding evidence:** "`PrHeader` is rendered even while `usePrDetail` is still loading, but `title`/`author` are passed as empty strings when `data` is null. This creates an empty `<h1>` (and empty author text) during slow loads, which is confusing and not great for accessibility/screen readers."
- **Where the gap lives in code:** `frontend/src/pages/PrDetailPage.tsx:73-84` (the `PrHeader` invocation with `?? ''` fallbacks); `frontend/src/components/PrDetail/PrHeader.tsx:40-42` (the unconditional `<h1>` and author `<span>`).

## [Skip] Singular `{cookieSessionId → subscriberId}` map (last-SSE-wins or reject-second-SSE)

- **Source:** PR5-design session — main-conversation rigor pass before any code, weighed three alternatives for resolving spec § 6.2 line 314 ambiguity
- **Severity:** P2 (multi-tab dogfood UX)
- **Date:** 2026-05-07
- **Reason:** Spec § 6.2 line 314 specifies a singular `{cookieSessionId → subscriberId}` map, but the `prism-session` cookie value is per-process — every tab in the same browser carries the same cookie, so two simultaneous SSE connections from the same user collide on the map key. Three plausible policies were weighed:
  - **(a) Last-SSE-wins** (overwrite). Old tab keeps its SSE open but its `POST /api/events/subscriptions` calls now resolve to the *new* tab's `subscriberId`, silently mis-attributing subscriptions. Subtle correctness bug for routine multi-tab usage.
  - **(b) Reject second SSE** (409 on second `GET /api/events`). Breaks the multi-tab dogfood path entirely; teammate-friction memory (`teammate_friction_preference`) is non-negotiable.
  - **(c) Multimap with most-recent-wins for POST/DELETE.** `{cookieSessionId → Set<subscriberId>}` keyed by cookie, ordered by SSE-connection arrival time. POST/DELETE resolve to the *most recent* `subscriberId` for that cookie; older entries continue receiving fanout for already-registered PRs. Preserves multi-tab correctness for the dominant case (each tab subscribes to its own foreground PR) and accepts the edge case (older tab's *new* subscribe routes through the newer tab's id) as a wash — same browser, same user, same trust boundary per spec § 6.2 last-paragraph threat model.
  Chosen: (c). (a) and (b) skipped.
- **Revisit when:** N/A. (c) preserves the spec's stated security property ("an authenticated tab can only operate on its own SSE connection's subscriberId" — generalized: only on a subscriberId belonging to *its own browser session*) and matches the dominant dogfood path. Revisit only if dogfooding surfaces an attack from same-cookie tab boundary, which would invalidate the underlying same-browser-trust premise rather than the multimap itself.
- **Original finding evidence:** Spec § 6.2 line 313-317 says "SseChannel maintains `{cookieSessionId → subscriberId}` mapping" (singular), but lines 315-317 simultaneously imply per-tab subscriber semantics ("an authenticated tab can only operate on its own SSE connection's subscriberId"). Spec internally inconsistent on multiplicity; this entry resolves the inconsistency to (c).

## [Defer] Sub-1180px responsive sheet for file tree (P1.13)

- **Source:** PR7 preflight — adversarial + reliability reviewers
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** Spec § 7.7 prescribes collapsible left sheet overlay at <1180px with focus trap, Esc-close, scrim-click-close, body-scroll-lock, and viewport-widen auto-collapse. PR7 ships the file tree as a static left pane at all widths. The responsive sheet wrapper (`FileTreeSheet.tsx`) plus `useViewportBreakpoint` hook are deferred to avoid coupling tree-building correctness to viewport-resize behaviour in the same PR. Tree logic, viewed semantics, and keyboard shortcuts are independently testable without the responsive wrapper.
- **Revisit when:** S6 polish work addresses narrow-viewport ergonomics, OR dogfooding on a <1180px display surfaces "file tree covers the diff" complaints.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — the `files-tab-content` div uses a static two-pane layout; no `useViewportBreakpoint` hook exists yet.

## [Defer] AI focus dot column in FileTree (spec § 7.2 line 710)

- **Source:** PR7 preflight — correctness reviewer
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** Spec requires a 16px column reserved for AI focus dots even when `aiPreview` is off, with `aria-label` suffixed "(preview)" when backed by `PlaceholderFileFocusRanker`. PR7 ships file tree rows without this column because `useCapabilities()['ai.fileFocus']` returns `false` in PoC and the dot is purely visual filler. The 16px reservation prevents layout shift on `aiPreview` toggle, but since `aiPreview` defaults to off and the toggle doesn't exist in S3, the shift is unobservable.
- **Revisit when:** v2 lights up `ai.fileFocus` capability and ships a real `FileFocusRanker`, OR S6 adds the `aiPreview` toggle in the settings panel.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` — `FileNodeComponent` has no focus-dot span.

## [Defer] Inline toast for viewed-checkbox rollback (spec § 7.2 line 737)

- **Source:** PR7 preflight — reliability reviewer
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** Spec prescribes inline toast with role=status, aria-live=polite, 4s auto-dismiss, click-to-dismiss, --t-med animation on 422/409 rollback from POST /files/viewed. PR7 rolls back silently (the viewed checkbox reverts, but no toast appears). The rollback itself is implemented — only the visual feedback toast is missing.
- **Revisit when:** Dogfooding encounters 422 cap-exceeded or 409 stale-head-sha failures frequently enough to warrant user-visible feedback, OR S6 polish work formalizes toast patterns.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:handleToggleViewed` catch block — rolls back state but does not render a toast.

## [Defer] File-viewed graph-walk semantics (spec § 7.2 line 730)

- **Source:** PR7 preflight — correctness reviewer
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** Spec § 7.2 defines two viewed modes: (a) default mode walks the full PR commit graph between ViewedFiles[path] and headSha checking changedFiles, (b) skipped-Jaccard mode uses exact-SHA match. PR7 implements client-side viewed state as a simple Set<string> toggle without either graph walk or SHA comparison — viewed is purely a client-side UI toggle with optimistic POST. The backend POST persists the viewed mark; the graph-walk or SHA-match logic that determines whether a file is *still* viewed after new iterations is a read-path concern that requires `PrDetailDto.viewedFiles` data (not yet surfaced in the DTO). This is by design: PR7 focuses on the file-tree layout and diff-fetching infrastructure; viewed-semantics accuracy depends on backend data that lands with full state-management polish.
- **Revisit when:** Backend surfaces `ViewedFiles` in PrDetailDto and commit `changedFiles` data, enabling the frontend to compute accurate viewed status. Likely S4 or S5.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:38` — `viewedPaths` is `useState<Set<string>>(new Set())` with no initialisation from backend data.

## [Defer] Shiki syntax highlighting in DiffPane (spec § 7.2 line 718)

- **Source:** PR8 preflight — correctness reviewer
- **Severity:** P2
- **Date:** 2026-05-08
- **Reason:** Spec requires DiffPane lines to be syntax-highlighted via the shared Shiki instance. PR8 ships the shikiInstance module with lazy initialization and uses it in MarkdownRenderer code blocks, but DiffPane currently renders plain-text diff lines without Shiki tokenization. Integrating Shiki into the per-line rendering requires mapping file extensions to language IDs and handling the async highlighter load state within the diff table — non-trivial but visual-only polish.
- **Revisit when:** S5 or S6 polish round addresses syntax coloring across the diff surface.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` — `renderContent()` returns plain `<span>` without Shiki token spans.

## [Defer] react-diff-view integration (spec § 7.2 line 716)

- **Source:** PR8 preflight — architecture reviewer
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Spec calls for react-diff-view to render side-by-side/unified views. PR8 implements a custom lightweight diff table parser (parseHunkLines) that handles the core unified diff format correctly, with side-by-side/unified layout switching. The react-diff-view library was installed but not used — the custom implementation is simpler to test, understand, and extend for the PoC. react-diff-view would provide richer features (fold/expand context, scroll sync in split view) that can be adopted later.
- **Revisit when:** Dogfooding reveals need for advanced diff UX features (context expansion, scroll-sync in split view), or the custom parser hits edge cases with complex merge diffs.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` — uses custom `parseHunkLines` instead of react-diff-view's `parseDiff`/`Diff`/`Hunk` components.

## [Defer] Diff-mode persistence to state.json (spec § 6.3 + § 7.2)

- **Source:** PR8 preflight — correctness reviewer
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Spec § 6.3 specifies DiffMode persistence via AppState.UiPreferences.DiffMode, with the endpoint landing in S4 settings. PR8 implements in-memory diffMode state (useState in FilesTab) as the plan prescribes for S3 — persistence wires up when the S4 settings endpoint ships.
- **Revisit when:** S4 settings surface ships `AppState.UiPreferences.DiffMode` endpoint.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — `diffMode` is `useState<DiffMode>('side-by-side')` with no persistence layer.

## [Defer] d-key tooltip "side-by-side requires ≥ 900px" (spec § 7.7)

- **Source:** PR8 preflight — reliability reviewer
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Spec says pressing d below 900px shows a tooltip informing the user that side-by-side requires a wider viewport. PR8 suppresses the toggle (no-op below 900px) but doesn't show a tooltip. The suppression itself is correct; the tooltip is polish.
- **Revisit when:** S6 polish round or design system tooltip component lands.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:handleToggleDiffMode` — returns early without tooltip.
