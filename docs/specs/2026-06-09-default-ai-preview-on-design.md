# Default AI preview ON for new installs — design

**Issue:** [#283](https://github.com/prpande/PRism/issues/283)
**Date:** 2026-06-09
**Tier / Risk:** T2 — gated B1 (UI-visual; `needs-design` label)

## Goal

Make AI preview features **on by default for fresh installs**, so a new user sees
the AI surfaces without first discovering the Settings → Appearance toggle. AI is
still backed by **placeholder** (canned, local) implementations — no real LLM is
wired — so the surfaces shown by default must honestly read as an *in-development
preview*, never as a finished or broken feature.

This is an accepted, deliberate choice (owner): flip the default **now**, with
placeholder output visible. Existing users are unaffected — only fresh installs
(no saved `config.json`) pick up the new default.

## Background — what drives the default

A single boolean, `UiConfig.AiPreview`, gates every AI surface:

- **Default lives at** `PRism.Core/Config/AppConfig.cs:24` —
  `new UiConfig("system", "indigo", false, "comfortable", "m")`. The `false` is
  `AiPreview`. Flipping it to `true` is the core change.
- It flows to `AiPreviewState.IsOn`; `AiSeamSelector.Resolve<T>()` picks the
  `PRism.AI.Placeholder` implementation set when ON (no-op when OFF). The frontend
  gates each surface via `useAiGate(key)` (`capabilities[key] && preferences.ui.aiPreview`).
- **Existing users preserved:** `ConfigStore.ReadFromDiskAsync` deserializes a
  present `config.json` and backfills only *null* sub-records; it never overwrites
  a value the user already has. A fresh install (no file) writes `AppConfig.Default`.

## Honesty audit (what a fresh default-on user actually sees)

Of the nine seams, only some render on a *real* fresh install:

| Surface | Renders on a real fresh install? | Marked as preview today? |
|---|---|---|
| PR summary card | Yes, always | ✅ "AI preview — sample content, not generated from this PR" |
| Pre-submit validator | On submit | ✅ same chip |
| Composer assistant / Ask-AI | When composing | ✅ "AI preview — composer suggestions appear here" |
| **Inbox category chip** ("Refactor" on every row) | **Yes — every inbox row** | ❌ bare chip, no marker |
| **Activity rail** (fabricated activity feed) | **Yes — inbox sidebar** | ❌ no marker, fully fabricated |
| File-focus dots | No — canned anchor `src/Calc.cs` won't match real files | renders nothing |
| Hunk annotations | No — anchored to `src/Calc.cs` | renders nothing |
| Draft suggestions | No — anchored to `src/Calc.cs` (stale-draft only) | renders nothing |

**The honesty gap is the two inbox surfaces** — and they are on the *first screen*
a new user lands on. The category chip stamps "Refactor" on every PR; the activity
rail (`ActivityRail.tsx` + static `activityData.ts`) shows a fabricated feed of
teammate activity ("amelia.cho pushed iter 3 to #1842", fake repos) with no
"sample" marker. On a real first run these read as wrong/broken, not as preview.

The diff-anchored surfaces (file focus, hunk annotations, draft suggestions) render
**nothing** on a real PR because their canned data targets `src/Calc.cs`, which the
user's diff won't contain. They are therefore not dishonest and are **left
untouched** (accepted).

## Scope (owner-approved: scope A — "mark what actually shows")

1. **Flip the default.** `AppConfig.cs:24` `AiPreview` `false → true`.
2. **Mark the inbox category chip** so it reads as an AI-preview sample, not a real
   classification.
3. **Mark the activity rail** so the whole aside reads as sample/preview.
4. **Copy:** verify welcome / Help / Settings copy is consistent with default-on.
   No change unless a contradiction is found (audit result below: none expected).
5. **Tests** cover the new default and the two new markers.

**Out of scope:** marking the diff-anchored surfaces (render nothing on real PRs);
any change to placeholder content/anchors; wiring a real LLM; the privacy/egress
review that a *real* model would require (placeholder is local, zero egress —
confirmed structurally).

### Rejected alternatives
- **B — full per-surface marker pass (all 9 seams).** Most of the extra work lands
  on surfaces that never render on a real install. Higher ceremony, near-zero
  marginal honesty value. Rejected as gold-plating.
- **C — suppress the activity rail by default.** Keeps the worst offender off even
  when AI preview is on. Held as the **fallback** if, at the visual gate, a
  labeled-but-fabricated feed still reads as clutter rather than preview.

## Component designs

### C1 — Default flip (`PRism.Core/Config/AppConfig.cs`)
Change the third `UiConfig` positional arg from `false` to `true`. One line.

**Ripple risk:** flipping `AppConfig.Default` changes the implied AI state for any
backend/integration/e2e test or fixture that builds `AppConfig.Default` (or relies
on the server's default config) and assumes AI **off**. The implementation MUST
sweep for these and make the assumption explicit at the call site (construct a
`UiConfig` with `AiPreview: false` where a test genuinely needs AI off), rather
than silently inheriting the new default. Candidate areas: `PRism.Web.Tests`
AI-endpoint tests that assert 204-when-off, `ConfigStore` tests, any `WebApplicationFactory`
default-config fixture, and the frontend `ai-gating-sweep` e2e (which sets state
explicitly via mocks and should be unaffected, but must be re-run to confirm).

### C2 — Inbox category chip marker (`frontend/src/components/Inbox/InboxRow.tsx:100`)
Today: `{showCategoryChip && enrichment?.categoryChip && (<span className={chipWrap}><span className={chip}>{enrichment.categoryChip}</span></span>)}`.

Add a compact, unmistakable preview affordance to the chip:
- A small leading **"AI" marker** within the chip (muted/preview visual treatment),
  keeping the chip a single compact element suitable for a dense inbox row.
- An accessible label on the chip: `title` + `aria-label` =
  `"AI preview — sample category, not generated from this PR"`.

Exact visual form (glyph vs. text tag, color) is finalized at the B1 screenshot
gate; the design contract is: a screen-reader user and a sighted user can both tell
the category is an AI-preview sample, not a real label.

### C3 — Activity rail marker (`frontend/src/components/ActivityRail/ActivityRail.tsx`)
Today: an `aside` with an "Activity / last 24h" header and a fabricated list.

Add a **single** muted preview marker scoping the whole rail — e.g. a sub-label in
the rail header reading `"AI preview — sample activity"`. One marker for the aside
(not per item), so the entire fabricated feed is clearly framed as sample. The
marker is part of the rail's own accessible structure (within the `aria-label="Activity"`
landmark).

### C4 — Copy audit (verify-only)
- **Welcome** (`WelcomePage.tsx:20`): "AI that surfaces the hunks worth a closer
  look, still in active development." Already frames AI as in-development →
  consistent with default-on. No change.
- **Settings** (`AppearancePane.tsx`): toggle help "Show AI-generated PR summaries
  and hotspots" — neutral, accurate whether default-on or off. No change.
- **Help** (`HelpModal.tsx`): makes no AI claim → nothing to contradict. No change.
- Audit conclusion recorded in the PR `## Proof`; AC #3 satisfied by verification.

### C5 — Egress confirmation (no code)
`PRism.AI.Placeholder` contains no `HttpClient`/`fetch`/external URL; every seam
returns `Task.FromResult(<canned>)`. Existing endpoint tests already assert canned
output. Egress = zero is structural; confirmed in `## Proof`. No new test (a
"no-network" assertion would be a brittle architecture test for zero marginal
value).

## Testing strategy

- **Backend (new):** a `ConfigStore`/`AppConfig` test asserting a no-saved-config
  load yields `Ui.AiPreview == true` (AC #1, AC #5). A complementary assertion that
  an existing config with `aiPreview:false` is preserved across load.
- **Backend (ripple):** update any test that depended on the old default-off so it
  sets `AiPreview` explicitly; keep the 204-when-off endpoint tests meaningful by
  constructing an explicitly-off config.
- **Frontend (new):** `InboxRow` test — when `showCategoryChip` and an enrichment
  are present, the chip exposes the preview accessible label. `ActivityRail` test —
  the preview marker renders.
- **Frontend (regression):** re-run `ai-gating-sweep.spec.ts` (mock-driven, sets
  state explicitly) to confirm no reliance on the old default.

## Acceptance criteria mapping

1. Fresh install default `aiPreview = true`; existing preserved → C1 + backend tests.
2. Every default-shown surface honestly reads as in-development → C2 + C3 (the two
   unmarked surfaces); others already marked or render nothing.
3. Welcome/Help/Settings copy consistent → C4 (verify-only).
4. Placeholder seam zero egress → C5 (structural confirmation in Proof).
5. Tests cover the new default → backend tests in Testing strategy.

## B1 visual gate

At green-and-ready, post Playwright screenshots of (a) the inbox with the marked
category chip + marked activity rail and (b) a PR-detail summary card, for the
owner's eyeball-assert. If the labeled activity rail still reads as clutter, fall
back to alternative **C** (suppress the rail by default) for that one surface.
