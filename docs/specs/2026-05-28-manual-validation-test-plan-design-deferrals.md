# Manual Validation Suite — Deferrals & Resumption Notes

> **Capture date:** 2026-05-28
> **Spec:** [`docs/specs/2026-05-28-manual-validation-test-plan-design.md`](./2026-05-28-manual-validation-test-plan-design.md)
> **Phase 1 plan:** [`docs/plans/2026-05-28-validation-suite-phase1-bootstrap.md`](../plans/2026-05-28-validation-suite-phase1-bootstrap.md)

This sidecar captures the state of the manual-validation-suite work at the end of the 2026-05-28 session so a future Claude Code session can resume without re-discovering context. It is not a deferrals-by-implementation-PR doc (the suite hasn't been implemented yet); it's a resumption brief.

---

## State summary

| Workstream | Status |
|---|---|
| SP1 spec (validation suite design) | **Shipped in this PR** — `2026-05-28-manual-validation-test-plan-design.md` v3 (rewritten after ce-doc-review surfaced the published-binary contradiction; settled on black-box framing with `e2e-validation/` at repo root) |
| 5-phase decomposition agreed | ✓ — Phase 1 ships bootstrap + J-P0-01; Phases 2-5 add fixtures/helpers/scenarios by priority tier |
| Phase 1 plan | **Shipped in this PR** — `2026-05-28-validation-suite-phase1-bootstrap.md` v2 (rewritten after ce-doc-review surfaced 5 substantive findings; 9 tasks; ~9 commits expected) |
| Phase 1 ce-doc-review | ✓ — 3 reviewers (coherence, feasibility, scope-guardian); all anchor-75+ findings applied via v2 rewrite |
| Phase 2 plan | **Deferred** — see D1 below; blocks on shell decision |
| Phase 3 plan | **Deferred** |
| Phase 4 plan | **Deferred** |
| Phase 5 plan | **Deferred** |
| Implementation of any phase | **Deferred** — all 5 plans land first, then implementation one PR at a time |

---

## Open decisions (resolve before resuming)

### D1. Standalone-SPA shell choice — BLOCKS Phase 2+

**Question raised at session end:**

> "The final design of the tool is to be implemented as a standalone single page application rather than being a tab on the browser. Does that change our testing strategy and the tools we are using for creating this black box test?"

**Context:** Today PRism ships as a binary that auto-opens the user's default browser to `http://localhost:5180`. Phase 1's plan assumes this shape: Playwright Chromium navigates to `http://localhost:5181` (Test-env port). If PRism becomes a standalone desktop app (Electron / Photino / Tauri / etc.), the SPA loads inside the shell's own window, not in an externally-launched browser. The "open the SPA" mechanism changes; tool compatibility depends on the chosen shell.

**Three architectures considered (paste-ready for follow-up session):**

#### Architecture A — Shell-agnostic launch layer (RECOMMENDED if shell decision is TBD)

- Today: Playwright Chromium against `http://localhost:5181` (Phase 1 v2 plan's current shape).
- Future: `helpers/launch.ts` abstracts the launch model per env var `PRISM_VALIDATION_SHELL` with adapters for `browser` (current), `electron` (Playwright `_electron`), `photino-cdp` (CDP attach against WebView2 — uncertain), `tauri-driver` (separate test runner).
- Specs use `getApp(testInfo)` instead of Playwright's `page` fixture directly, returning a Page-shaped object regardless of source.
- Cost: ~50 lines of abstraction in Phase 1 + per-shell adapter when a new shell lands. Spec count + selectors + fixtures + 4-clause no-faking rule are unchanged.

#### Architecture B — Lock in Playwright + browser-Chromium for now; rework when shell lands

- Build Phase 1 exactly as v2 plan describes (no abstraction layer).
- Cost: 0 today; rewrite cost when shell ships ranges from trivial (Electron — `_electron` swap) to substantial (Tauri — different runner + different selectors API).
- Recommended if shell decision is firm + imminent.

#### Architecture C — Pre-commit to a shell now and architect for it

- Choose Electron / Photino / Tauri today and shape the launch layer + tool choices for it.
- Most efficient if the decision is firm.

**Tool compatibility by shell (for reference):**

| Shell | Playwright support | Notes |
|---|---|---|
| Browser-tab (current) | ✅ Native — Playwright Chromium | Phase 1 v2 plan's assumption |
| Electron | ✅ Via `_electron` API (1st-class) | Playwright launches the Electron app, attaches to its renderer; selectors identical |
| Photino (WebView2 on Win, WebKit on Mac) | ⚠️ Partial — CDP attach against WebView2 may work; WebKit unlikely | Each platform's webview behaves differently |
| Tauri (native WebView) | ❌ Use `tauri-driver` (WebDriver) instead | Different toolchain, different selector API |
| Wails (Go-based, WebView) | ❌ Use Wails' own test runner | Different toolchain |

For OS-level shell integration (system tray, menus, file dialogs, multi-window, app-update prompts), all shells need additional tooling regardless. Those are SHELL-integration tests — a different category from the 44 user-journey scenarios this suite covers.

**Recommended for resumption:**

Pick **A** (shell-agnostic launch layer) unless a shell decision has landed. The cost is ~50 lines in Phase 1's plan as a follow-up commit (the v2 plan currently bakes Playwright Chromium against `http://localhost:5181` directly in `playwright.config.ts` — switching to A means extracting the launch into `helpers/launch.ts` + having specs call `getApp(testInfo)`).

If you pick A: add a `helpers/launch.ts` task to Phase 1's plan and adjust the spec at Task 8 to consume the helper before writing Phases 2-5.

If you pick B: leave Phase 1 v2 plan unchanged; write Phases 2-5 against the same Playwright-Chromium assumption; accept rework when shell lands.

If you pick C: revisit the spec's launch model + the Phase 1 plan's `playwright.config.ts` + the tool pin in `package.json` before proceeding.

---

### D2. Per-phase ce-doc-review choice — ANSWERED (recorded for future-Claude)

**User answer:** "full per-phase review"

**Action:** Every phase plan (2 through 5) gets a full ce-doc-review pass (3 reviewers: coherence + feasibility + scope-guardian — design-lens, security-lens, product-lens, adversarial all suppressed on routine phased plans per the persona-selection rules in the ce-doc-review skill) before commit. Findings applied via rewrite or explicit pushback with reason.

---

### D3. Phases 2-5 plans — DEFERRED

Suggested scopes from the spec's [Future stages](./2026-05-28-manual-validation-test-plan-design.md#future-stages) section:

| Phase | Scope | Estimated tasks |
|---|---|---|
| **2** | Sandbox repo (`prpande/prism-validation-sandbox`) creation + `helpers/fixture-types.ts` + `helpers/reset-fixture.ts` + `helpers/gh-sandbox.ts` + `helpers/inject-real-failure.ts` + `helpers/reconciliation-fixtures.ts` + `scripts/setup-fixtures.ts` (happy-path + multi-iteration + markdown-with-mermaid fixtures) + `scripts/sandbox-health.ts` + J-P0-02..J-P0-08 (7 P0 scenarios) | ~20 |
| **3** | Add `foreign-pending-review`, `stale-commit-oid`, `comment-heavy` fixtures + Recipe C + closed-PR workflow helper + 14 P1 specs | ~25 |
| **4** | Add `single-commit`, `force-push` fixtures + Recipe E + J-P2-11 ordering enforcement (`@last-in-pass` tag + config respect) + 15 P2 specs | ~25 |
| **5** | `scripts/reset-sandbox.ts` + `scripts/fixture-reset-ops.json` + 7 P3 specs + SP1-complete acceptance verification | ~15 |

Each phase ships its own implementation PR after the all-5-plans PR merges.

---

## What's already merged in this PR

- **`docs/specs/2026-05-28-manual-validation-test-plan-design.md`** (v3)
  Validation suite spec — 44 scenarios (8 P0 + 14 P1 + 15 P2 + 7 P3) + 44 V-cases (visual review pack) + Appendix (Recipes A-E, sandbox catalog, fixture-implementation notes, sandbox hygiene contract, out-of-scope rationale, glossary, future-stages section with SP2 + SP3 resumption prompts).

- **`docs/plans/2026-05-28-validation-suite-phase1-bootstrap.md`** (v2)
  Phase 1 plan — 9 tasks: worktree, scaffold, package.json + lockfile, tsconfig + README, `helpers/recipes.ts`, `playwright.config.ts` (Test-env webServer), sanity-check spec [transient], J-P0-01 spec, clean-clone verification. v2 incorporated 9 findings from ce-doc-review (FEAS-1 `/inbox` URL fix, FEAS-2 no-repos-modal handling, FEAS-3 cross-platform shell variants, SG-01 fixture-types defer to Phase 2, SG-02 commit lockfile, FEAS-4 tsx defer, FEAS-5 rationale fix, C-1 file-tree diagram comment, C-2 out-of-scope asymmetry).

- **`docs/specs/2026-05-28-manual-validation-test-plan-design-deferrals.md`** (this file)

---

## Ce-doc-review findings deferred (none)

All Phase 1 plan findings from the 3-reviewer ce-doc-review pass were either applied via the v2 rewrite or explicitly pushed back with reason captured in the session transcript. No outstanding findings carrying over to a future PR.

For reference, the pushed-back findings + reasons:

| Finding | Reason for pushback |
|---|---|
| SG-03: README documents Recipes A/C/D/E that don't exist in Phase 1 | Advisory only; forward-context is useful for future readers; the Quick Start is accurate for Phase 1 |
| SG-04: Task 8 throwaway sanity-check + Task 9 replace pattern is unnecessary task inflation | Advisory; legitimate TDD bootstrapping pattern (verifies launch chain independently of spec logic); transient commit is acceptable audit trail |

---

## Resumption checklist

When picking this work back up:

1. **Resolve D1 (shell decision).**
   - If **A** (shell-agnostic launch layer): add a `helpers/launch.ts` task to Phase 1's plan as a follow-up commit; adjust J-P0-01 spec (Task 8) to consume the helper.
   - If **B** (lock in Playwright + browser-Chromium): no changes to Phase 1 plan; write Phases 2-5 against the current Playwright assumption.
   - If **C** (pre-commit to a shell): revisit the spec's launch model + Phase 1 plan's `playwright.config.ts` + tool pin in `package.json` before proceeding.

2. **Write Phase 2 plan** + ce-doc-review + apply findings.
3. **Write Phase 3 plan** + ce-doc-review + apply findings.
4. **Write Phase 4 plan** + ce-doc-review + apply findings.
5. **Write Phase 5 plan** + ce-doc-review + apply findings.
6. **Final commit + PR** containing Phases 2-5 plans.

After all 5 plans are merged: start implementation, one phase per implementation PR.

---

## Session transcript reference

The 2026-05-28 brainstorming + planning session traversed three major arcs:

1. **Manual validation test plan (original framing)** — `superpowers:brainstorming` produced a 1781-line spec enumerating ~215 manual cases across smoke / regression / visual / appendix. Shipped via commit `68916d3`.

2. **Black-box e2e suite (reframed)** — user pivoted: "no faking or mocking ... external Validation test that can be run by humans manually, but preferably in an automation via an LLM ... intended to mimic a behaviour of an actual user". `superpowers:brainstorming` re-applied; produced 44 user-journey scenarios + revised the visual pack with priority tags. Three rounds of ce-doc-review surfaced the published-binary contradiction (FEAS-001) → 4-clause no-faking rule; the directory-collapse vs full-isolation question → user chose full isolation at repo-root `e2e-validation/`; the SP1/SP2/SP3 boundary → SP1 includes fixtures + helpers + specs, SP2 = orchestrator, SP3 = visual loop. v3 shipped via commit `b3042db`.

3. **Phase 1 plan + Phases 2-5 decomposition** — `superpowers:writing-plans` produced Phase 1 (bootstrap + J-P0-01); ce-doc-review surfaced 5 substantive findings → v2 rewrite. User then asked for all 5 phases planned together; shell-question pivot at session end → this deferrals doc.

The session was 200+ messages; the load-bearing commits are `b3042db` (spec v3) and the Phase 1 plan being shipped with this commit.
