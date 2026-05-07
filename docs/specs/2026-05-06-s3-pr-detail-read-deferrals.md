---
source-doc: docs/specs/2026-05-06-s3-pr-detail-read-design.md
created: 2026-05-07
last-updated: 2026-05-07
status: open
---

# Deferrals — S3 PR-detail (read) spec

Tradeoffs surfaced during a multi-session rigor pass on the S3 spec. Source: `compound-engineering:document-review` 7-persona pass on 2026-05-07 (coherence + feasibility + product-lens + design-lens + security-lens + scope-guardian + adversarial), followed by an in-conversation rigor pass that labeled each finding Apply / Defer / Skip.

The 26 Apply items landed in the spec ([this commit](../specs/2026-05-06-s3-pr-detail-read-design.md), `feat/s3-doc-review` branch). The 4 Defer + 6 Skip items below are the rejections.

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
