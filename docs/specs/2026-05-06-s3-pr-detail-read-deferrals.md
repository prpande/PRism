---
source-doc: docs/specs/2026-05-06-s3-pr-detail-read-design.md
created: 2026-05-07
last-updated: 2026-05-07
status: open
revisions:
  - 2026-05-07: PR5-design — recorded multimap chosen over (a) last-SSE-wins / (b) reject-second-SSE for `{cookieSessionId → Set<subscriberId>}`
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
