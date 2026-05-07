---
source-doc: docs/plans/2026-05-06-s3-pr-detail-read.md
created: 2026-05-07
last-updated: 2026-05-08 (PR5 implementation — SensitiveFieldScrubber wire-up deferred)
status: open
---

# Deferrals — S3 PR-detail (read) plan

Records deferred / skipped items affecting the S3 plan, regardless of source. The
original (and largest) batch comes from the `compound-engineering:ce-doc-review`
7-persona rigor pass on 2026-05-07. Subsequent rounds — implementation
follow-ups carried over from a shipped PR, post-merge realizations, etc. — are
appended below using the same schema; each entry's `Source:` field names the
session.

The Apply items from the original ce-doc-review pass (~30 individual edits across
Tasks 1-11) landed in the commit applying Q1-Q6 + plan-rigor decisions. The
remaining Defer / Skip items from that pass are recorded below.

The companion spec deferrals sidecar (`docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`) records:
- The original spec-rigor pass's Defer/Skip items (4 + 6)
- 5 meta-process Skip items about the deferrals tracking system itself
- 5 `[Superseded]` items where spec-rigor Apply decisions got reversed by this plan-rigor pass

This sidecar covers the remainder: plan-affecting items that don't touch the spec.

## [Defer] PrDetailLoader 3-round-trip perf budget

- **Source:** plan ce-doc-review 7-persona pass — feasibility (confidence 0.6)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Plan's `PrDetailLoader.LoadAsync` makes ~3 round trips on cold-load: PollActivePrAsync (3 REST calls), GetPrDetailAsync (1 GraphQL), GetTimelineAsync (1 GraphQL + N per-commit REST calls up to `SkipJaccardAboveCommitCount = 100`). Worst case (100 commits): 5 + 100 = ~105 round trips, paced 100ms inter-batch = several seconds. The plan doesn't state an end-to-end perf budget. For PoC dogfooding, we don't yet have real-world latency measurements — defer perf budget definition until dogfooding produces evidence.
- **Revisit when:** Dogfooding shows real-world latency exceeding ~2s p95 cold-load on typical PRs (likely on PRs near the 100-commit cap), OR before P0+ scope work begins. At that point, decide: streaming response (NDJSON), parallelism, or perf SLO documentation.
- **Original finding evidence:** "PrDetailLoader.LoadAsync makes 3 API round trips per cache miss — perf claim missing"

## [Defer] PR4 reads-vs-writes split (mark-viewed/files-viewed into PR4b)

- **Source:** plan ce-doc-review 7-persona pass — product-lens (confidence 0.55)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** PR4 lands GET endpoints (PR detail, diff, file) + write endpoints (mark-viewed, files/viewed) + path canonicalization + 16 KiB body cap. Product-lens suggested splitting reads (PR4a) from writes (PR4b) so reads ship sooner. Counter-argument: frontend Tasks 6-9 need both reads AND writes to demo the slice end-to-end; splitting delays the demo. Marginal P3 finding; implementer's call at execution time. If reviewer pool can absorb the bundled diff, no split. If review fatigue surfaces, split.
- **Revisit when:** Implementer is opening PR4 and judges the diff size (~500 lines + tests) is too large for one review pass.
- **Original finding evidence:** "Mark-viewed/files-viewed split into one PR could split. PR4 lands GET /api/pr/{ref}, GET /diff, GET /file…plus POST /mark-viewed, POST /files/viewed"

## [Defer] Selectively re-test path canonicalization for percent-decoded `%2E%2E`

- **Source:** plan ce-doc-review 7-persona pass — security-lens P2.6 (partial; main fix Apply'd)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** P2.6's main concern (post-URL-decode handling) was Apply'd via comment + 1 regression test. Plan-rigor's deeper concern about overlong UTF-8 sequences (e.g., a 3-byte encoding of `..` smuggled past the byte-length check) remains untested. .NET's UTF-8 decoder rejects overlong sequences before our code sees them, so the gap is theoretical. Defer: write the regression test only if a real bypass is reported.
- **Revisit when:** A security report or audit identifies a path-traversal vector via overlong UTF-8 or other sub-NFC encoding form.
- **Original finding evidence:** "Path canonicalization runs after URL-decode … additional concern: overlong UTF-8 sequences"

## [Skip] Cookie HttpOnly=false split into HttpOnly EventSource cookie + JS-readable meta tag

- **Source:** plan ce-doc-review 7-persona pass — security-lens P2.5 (confidence 0.62)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Security-lens flagged that `prism-session` cookie has `HttpOnly = false` to let the SPA read it for `X-PRism-Session` header. This makes the token XSS-extractable. Suggested fix: split into a HttpOnly EventSource-only cookie + a JS-readable meta tag for fetch calls. Counter-argument that wins: localhost-only threat model — same-machine sibling processes can read browser-local state regardless of HttpOnly (they have direct OS access to browser cookie stores). Markdown sanitization corpus + version pin + Renovate label is the primary XSS defense. Cookie split adds complexity (two-token plumbing, two-rotation paths, cross-token consistency tests) for marginal hardening against an attack vector already partially mitigated by the threat model assumption.
- **Revisit when:** Threat model expands beyond localhost (e.g., PRism ever runs against a remote backend), OR a markdown sanitization bypass is reported in dogfooding.

## [Skip] Mermaid corpus expansion to 8+ behavioral tests

- **Source:** plan ce-doc-review 7-persona pass — adversarial A7 (confidence 0.7)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Same compromise as the spec-rigor decision. Adversarial reviewer suggested expanding Mermaid behavioral test corpus from 3 to 8+ tests covering known CVE shapes (click directives, classDef CSS injection, gantt dateFormat, etc.). The spec rigor pass landed 3 tests + version-pin-as-primary-defense. Adversarial argues 3 is too few for a library with CVE history. Counter (same as spec rigor): unit-testing a third-party library's hardened-mode is upstream's job; PRism's defense is the version pin + Renovate manual-approval label. Expanding the corpus reimplements upstream's test suite. Apply only the small clarifier already in the spec: document Renovate review semantics (must check changelog for security-relevant fixes, not just version-bump auto-approve).
- **Revisit when:** Mermaid ships a security-relevant patch that the existing 3-test corpus misses, OR PRism-rendered Mermaid causes an actual XSS report in dogfooding.

## [Skip] Drop ResetToDefaultAsync as marginal abstraction

- **Source:** plan ce-doc-review 7-persona pass — scope-guardian P2.37 (confidence 0.55)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** Scope-guardian argued that `ResetToDefaultAsync` is a single-caller, single-test abstraction; Setup could call `File.Delete` directly with a comment about why. Counter: the abstraction earns its keep by encapsulating the file path inside `AppStateStore` (no leak of `_path` to Setup) and centralizes the read-only-mode bypass invariant inside one method. Cost is small (~10 lines). The "single caller" critique applies to many small methods that aggregate a future-changeable piece of behavior; not a strong YAGNI signal here.
- **Revisit when:** N/A — abstraction tax is small; encapsulation win is real.

## [Skip] OneTabPerCommit fallback ships preemptively (now moot)

- **Source:** plan ce-doc-review 7-persona pass — product-lens P2.24, scope-guardian SG5, adversarial A8 (3-persona consensus)
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** This plan-rigor finding pushed for deferring `OneTabPerCommitClusteringStrategy` until calibration actually fails. The Q5 user-decision discussion produced a complete redesign of the fallback (drop OneTabPerCommit entirely; introduce `ClusteringQuality: Ok | Low` + `CommitMultiSelectPicker` frontend swap). The "preemptive ship" critique no longer applies because the original target was scrapped. The redesign IS shipped preemptively (the `CommitMultiSelectPicker` component lands in S3, not deferred), but for different reasons: it serves three triggers (≤1 commit, per-PR degenerate, global flag), at least one of which (1-commit PRs) is a guaranteed-to-fire case. Documenting the original critique here so future readers see the full reasoning chain that led to the redesign.
- **Revisit when:** N/A — superseded by Q5 redesign.
- **See also:** `[Superseded] OneTabPerCommitClusteringStrategy as discipline-check fallback` in the spec deferrals sidecar.

## [Skip] Plan-length premise (3882 lines) is process-padding

- **Source:** plan ce-doc-review 7-persona pass — adversarial A11 (confidence 0.55)
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** Adversarial reviewer challenged the plan's 3882-line length as process-padding. Reviewer's own counter-test on the same finding showed the bulk is load-bearing (Tasks 4, 5, 7, 8 contain non-trivial implementation detail not in the spec). Length itself isn't a flaw; specific over-spec'd sub-items were challenged separately under other findings. Skip: not actionable.
- **Revisit when:** N/A — not a finding to apply.

---

## [Defer] Cursor pagination on `GetPrDetailAsync` GraphQL connections (`MaxTimelinePages = 10`)

- **Source:** PR #19 implementation — Task 3.4 (GraphQL impl) shipped single-page-with-cap-detection instead of the spec'd cursor loop
- **Severity:** P2
- **Date:** 2026-05-07
- **Reason:** Spec § 6.1 calls for cursor-paginated fetches up to `MaxTimelinePages = 10` on every connection where `pageInfo.hasNextPage` is true. PR #19 ships a simpler shape: single page with `TimelineCapHit` derived from `pageInfo.hasNextPage` on any of the three connections (`comments`, `reviewThreads`, `timelineItems`). The user-visible cap-hit signal — the explicit "Some history beyond N pages was not loaded" banner the frontend will render — works correctly with the simpler shape. Cursor pagination would close the gap for PRs with > 100 comments / threads / timeline items, but adds non-trivial code (cursor extraction + per-connection loop + reassembly) that the user-visible UX doesn't yet exercise. Defer until either (a) PrDetailLoader (Task 4) actually consumes the field and the cap is felt in practice, or (b) dogfooding produces a PR where the missing history is user-blocking.
- **Revisit when:** PrDetailLoader is implementing the snapshot-composition path AND a Task 4 / S3 dogfooding case shows the cap-hit banner firing on PRs the user wants to act on. Default decision at that point: implement the cursor loop (the spec's design). Backstop: even without cursor pagination, `TimelineCapHit` keeps the user honest.
- **Original finding evidence:** `GetPrDetailAsync` code comment in `PRism.GitHub/GitHubReviewService.cs`: "Cursor pagination up to MaxTimelinePages = 10 is a follow-up (spec § 6.1; Q2 cap detection); the cap-hit signal is the user-visible contract that matters today." PR #19 body § Spec alignment notes.

## [Defer] `PaginatedFakeHandler.Reset()` for repeat-route tests

- **Source:** PR #19 review — reply to Copilot inline comment 3202327866 promised a future Reset() for tests that need to call the same route across phases
- **Severity:** P3
- **Date:** 2026-05-07
- **Reason:** PR #19's hardening of `PaginatedFakeHandler` made over-call return HTTP 500 (was empty 200) so pagination bugs surface loudly. A consequence: tests that legitimately want to call a route across multiple phases (e.g., re-fetch verification, retry tests) currently have to script enough explicit pages or re-construct the handler. A `Reset()` method that clears `Rule.Index` would let tests do this cleanly. No such test exists in S3 today; defer until a Task 4+ test needs this shape.
- **Revisit when:** A test in Task 4-11 wants to assert behavior across two calls to the same route (e.g., "PrDetailLoader caches the response — second call is served from cache, not the handler"). At that point, add `Reset()` (and maybe a `RouteReplay()` variant that loops pages indefinitely) and document the choice.
- **Original finding evidence:** PR #19 reply to comment 3202327866: "Tests that need 'infinite empty pages' must script enough explicit pages or call a future `Reset()`."

## [Defer → Resolved] Doc-maintenance debt from PR #19 (roadmap / README § Status / specs index)

- **Source:** PR #19 implementation — `CLAUDE.md` § Documentation maintenance requires slice-progress events to update `docs/roadmap.md` slice row + `README.md` § Status + `docs/specs/README.md` spec status group **in the same PR**. PR #19 didn't.
- **Severity:** P2
- **Date:** 2026-05-07 (deferred); 2026-05-08 (resolved by PR4)
- **Reason:** This is process-debt, not architectural. Three small markdown edits got missed at PR #19 merge time. The deferral lets the next PR (typically PR4 / Task 4) bundle the doc updates with that PR's own slice-progress edits, since both surfaces need updating then anyway. Surfaced as a `[Defer]` rather than `[Skip]` because the project's own policy says these MUST be updated — they're owed, not optional.
- **Revisit when:** ~~Opening any subsequent S3 PR (Task 4+)~~ — **resolved by PR4**: roadmap S3 row, README § Status, and spec index entry all updated in the PR4 doc-maintenance commit alongside PR4's own slice-progress entry.
- **Original finding evidence:** `CLAUDE.md` § Documentation maintenance table row "Slice PR merged (or partial slice progress)"; PR #19 didn't include those edits.

---

## [Defer] Cursor pagination on `GetPrDetailAsync` (revisit notes from PR4)

- **Source:** PR4 implementation — affirms the prior `[Defer]` entry above; PR4 elected to keep the deferral open rather than implement the cursor loop as part of the loader work
- **Severity:** P2 (unchanged)
- **Date:** 2026-05-08
- **Reason:** PR4's loader composition path actively consumes `TimelineCapHit` (propagating it through `PrDetailDto` to the frontend), so the user-visible contract — "Some history beyond N pages was not loaded" banner — is in place and behaves correctly with single-page fetches. The implementation cost of cursor pagination (per-connection cursor extraction across `comments`/`reviewThreads`/`timelineItems`, reassembly into the existing DTO shape, plus tests requiring `FakeGitHubServer` multi-page connection support) is non-trivial and the marginal benefit (PRs with > 100 comments / threads / timeline items showing more history) is unproven against any specific PR the user is trying to act on. No dogfood evidence yet.
- **Revisit when:** Same trigger as the original entry — dogfooding produces a PR where the cap-hit banner fires AND the missing history is user-blocking.

## [Defer] `?commits=` union-diff endpoint branch + `IReviewService.GetUnionDiffAsync` to Task 7

- **Source:** PR4 implementation — endpoint scope decision discussed at PR4 design time
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Spec § 6.1 + § 7.2.1 calls for `GET /api/pr/{ref}/diff?commits=sha1,sha2,sha3` returning a union diff via 3-dot semantics from earliest-selected commit's parent through latest-selected commit's HEAD. This branch is consumed by `CommitMultiSelectPicker` (the `ClusteringQuality: Low` fallback UI) which lands in Task 7. Adding the endpoint branch in PR4 also requires adding `GetUnionDiffAsync` to `IReviewService` (touches Task 3's surface) and an impl in `GitHubReviewService` (extra REST call to resolve earliest commit's parent SHA, then 3-dot compare, plus tests). PR4 chose to defer the entire bundle to Task 7 so the consuming frontend and the consumed endpoint land together with cohesive scope. PR4's `/diff` endpoint only handles `range=`.
- **Revisit when:** Task 7 implementation begins — bundle `GetUnionDiffAsync` (interface + GraphQL/REST impl) + the `?commits=` endpoint branch + frontend `CommitMultiSelectPicker` consumer in one cohesive change.

## [Defer] Bounded-LRU cache for `PrDetailLoader` snapshot store (currently unbounded `ConcurrentDictionary`)

- **Source:** PR4 implementation — replaced the spec'd `MemoryCache(SizeLimit = 50, sliding 1h)` with `ConcurrentDictionary` to avoid a new package dependency for a behavior PR4 did not test independently
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Plan Step 4.3 specified `MemoryCache` with bounded LRU + 1h sliding expiration (P1.4). PR4's implementation uses unbounded `ConcurrentDictionary` for both the snapshot cache and the diff memo. Reasoning: (a) adding `Microsoft.Extensions.Caching.Memory` is a new package dependency that nothing else in the codebase currently uses; (b) `MemoryCache`'s LRU eviction is approximate (compaction-triggered, not strictly oldest-first), so writing a deterministic test for the eviction order is brittle — the plan's "load 51 distinct PRs and assert the 1st is evicted on next access" pattern would be flaky against `MemoryCache`'s actual semantics; (c) PoC dogfood usage rarely hits 50 distinct PRs in a single process lifetime — restart bounds growth in practice. PR4 ships unbounded; bound-add is a follow-up if and when needed.
- **Revisit when:** Dogfooding shows memory growth from cache accumulation, OR a P0+ user reports OOM-class behavior, OR a teammate keeps PRism running long enough that `_snapshots`/`_diffs` accumulate measurably (likely on long-running sessions touching dozens of PRs).
- **Original finding evidence:** Plan Step 4.3 + the in-source comment block at `PrDetailLoader.cs` ("Snapshot cache. PoC: unbounded ConcurrentDictionary…").

## [Defer] `MarkViewedRequest.MaxCommentId` typed as `string?` rather than `long?`

- **Source:** PR #21 review (local pr-autopilot post-open `review` skill, 2026-05-08)
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** Spec § 8 line 896-898 says `maxCommentId` is "highest GitHub `databaseId` (numeric, monotonic)" and `IssueCommentDto.Id` is `long` in `PRism.Core.Contracts`. The wire-format DTO `MarkViewedRequest.MaxCommentId` uses `string?` (verbatim round-trip into `ReviewSessionState.LastSeenCommentId: string?`). The current shape works — the value is monotonic-as-string when frontend computes it from the same numeric source — but the type discipline is loose. Tightening to `long?` cross-cuts S2's existing `LastSeenCommentId` field and would require a migration. Defer to a follow-up that owns both the DTO and the state-shape change end-to-end.
- **Revisit when:** Either S4's drafts work (which already touches `ReviewSessionState`) bundles the type tightening, OR a frontend-side bug surfaces from the string-vs-long discipline gap (e.g., lexicographic vs numeric comparison disagreement).

## [Defer] Route constraints on `{owner}` / `{repo}` and positive-int constraint on `{number}`

- **Source:** PR #21 review — Copilot bot Low + my local L5
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** All five PR4 endpoints use `{owner}` / `{repo}` route segments without constraints, so anything URL-safe lands at the endpoint and goes to GitHub. `{number:int}` accepts negative integers. GitHub-side validation rejects bad values, but explicit route constraints (`{owner:regex([A-Za-z0-9_.-]+)}` and a positive-int constraint on `{number}`) would short-circuit malformed inputs at the routing layer instead of paying for an unnecessary `IReviewService` call. PoC scope; cosmetic at the security level (no bypass). Bundle into a follow-up routing-hygiene PR that touches the inbox endpoints too for consistency.
- **Revisit when:** A second consumer of `{owner}` / `{repo}` — either S4 endpoints or a future security-review pass — surfaces the same finding. Bundle the constraints across all PR-shaped routes in one PR.

## [Defer] Wire `SensitiveFieldScrubber` into the live `ILogger` pipeline as a decorator

- **Source:** PR5 implementation — Step 5.10c plan said "wire as a `ILogger`-wrapping decorator (or via `IConfigureOptions<LoggerFilterOptions>`)" but stopped short of specifying the wiring. Implementation chose to ship the scrubber + comprehensive unit tests now and defer the live-pipeline integration.
- **Severity:** P3
- **Date:** 2026-05-08
- **Reason:** No current ILogger call site in `PRism.Core`, `PRism.GitHub`, or `PRism.Web` emits a blocked field name (`subscriberId` / `pat` / `token`) as a structured-log argument — the scrubber is forward-looking. `Microsoft.Extensions.Logging` doesn't ship a Serilog-style `IDestructuringPolicy` pipeline, so wiring the scrubber means either (a) replacing `ILoggerFactory` with a wrapping factory that proxies every `BeginScope` and `Log<TState>` call through the scrubber (substantial surface area, tricky to keep `LoggerMessage.Define` source-generator output flowing correctly), or (b) writing a custom `ILoggerProvider` and routing through it. Both paths are non-trivial and would expand PR5 well past its 4-commit budget. Shipping the scrubber + unit tests now means: (i) the policy is encoded and tested; (ii) any new code that wants to redact at the call site can invoke `Scrub` directly; (iii) the wire-up lands in a focused follow-up PR that also adds an integration test against a TestLoggerProvider proving the round-trip.
- **Revisit when:** Either (i) a new log call site introduces a structured-log argument named `subscriberId`/`pat`/`token` (becomes blocking), or (ii) S4's drafts work introduces token-handling code paths that log credential-like fields, or (iii) v2 AI integration adds telemetry that may include sensitive fields.
- **Original finding evidence:** Plan Step 5.10c — "Wire as a `ILogger`-wrapping decorator (or via `IConfigureOptions<LoggerFilterOptions>`) so every structured log scope passes through `Scrub` before the underlying provider serializes the event."

## [Superseded] `[RequestSizeLimit(16384)]` endpoint metadata as the body-cap mechanism

- **Source:** Originally `[Apply]` from the spec-rigor → plan-rigor reversal (P2.3, recorded in the spec deferrals sidecar). Reversed by PR5 implementation — the 4-reviewer adversarial preflight pass surfaced ADV-PR5-003: minimal-API endpoint filters (and `WithMetadata(new RequestSizeLimitAttribute(...))`) run AFTER parameter binding, so the JSON body has already been deserialized into the handler argument by the time the size cap is consulted.
- **Severity:** P1 (security — body cap was meant to be pre-binding)
- **Date:** 2026-05-08
- **Reason:** ASP.NET Core's `[RequestSizeLimit]` attribute is a Microsoft.AspNetCore.Mvc filter that does not run for minimal-API routes. `IEndpointFilter` (which `RequestBodyCapFilter` initially was) DOES run for minimal-API routes, but it runs after the framework has bound `[FromBody]` parameters — the body has already been read into the deserializer, and `IHttpMaxRequestBodySizeFeature.IsReadOnly` is true. Honest Content-Length-bearing requests would still be caught by a proactive Content-Length check, but a chunked-encoding attacker (no Content-Length, body streamed in chunks) bypassed both the framework cap (because the filter set it too late) and the proactive check (because Content-Length was null). Replaced with a conditional `app.UseWhen(...)` middleware in `Program.cs` that runs BEFORE routing and parameter binding: it sets `IHttpMaxRequestBodySizeFeature.MaxRequestBodySize = 16 KiB` early (Kestrel honors it; TestServer doesn't), AND rejects honest oversized requests with 413 via the Content-Length pre-check. Same 16 KiB cap, same coverage on POST `/api/events/subscriptions`, framework-native at the right layer.
- **Revisit when:** N/A — UseWhen-middleware pattern is the documented Microsoft answer for pre-binding body caps on minimal APIs. Only revisit if a future ASP.NET Core release adds an `IEndpointFilter` ordering hook that lets filters run pre-binding.
- **New decision lives in:** `PRism.Web/Program.cs` (the new UseWhen middleware), `PRism.Web/Endpoints/EventsEndpoints.cs` (no longer carries `.AddEndpointFilter(new RequestBodyCapFilter(...))`); `PRism.Web/Middleware/RequestBodyCapFilter.cs` was deleted.
