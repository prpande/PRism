---
source-doc: docs/plans/2026-05-06-s3-pr-detail-read.md
created: 2026-05-07
last-updated: 2026-05-07
status: open
---

# Deferrals — S3 PR-detail (read) plan

Tradeoffs surfaced during the plan-rigor pass on 2026-05-07. Source: `compound-engineering:ce-doc-review` 7-persona pass on the synced plan, followed by an in-conversation rigor pass that labeled each finding Apply / Defer / Skip.

The Apply items (~30 individual edits across Tasks 1-11) landed in commit applying Q1-Q6 + plan-rigor decisions. The 3 Defer + 5 Skip items below are the rejections.

The companion spec deferrals sidecar (`docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`) records:
- The original spec-rigor pass's Defer/Skip items (4 + 6)
- 5 meta-process Skip items about the deferrals tracking system itself
- 5 `[Superseded]` items where spec-rigor Apply decisions got reversed by this plan-rigor pass

This sidecar covers the remainder: plan-specific Defer/Skip items that don't touch the spec.

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
