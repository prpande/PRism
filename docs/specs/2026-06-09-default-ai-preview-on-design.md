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
placeholder output visible. Existing users keep their saved value (see the
qualified preservation rule below) — the new default reaches fresh installs.

**Entry screen.** After connecting a token, a fresh install lands on the **inbox**.
That is why the two inbox AI surfaces (category chip, activity rail) are the
first-impression surfaces this spec scrutinizes — they appear before the user opens
any PR.

## Background — what drives the default

A single boolean, `UiConfig.AiPreview`, gates every AI surface:

- **Default lives at** `PRism.Core/Config/AppConfig.cs:24` —
  `new UiConfig("system", "indigo", false, "comfortable", "m")`. The `false` is
  `AiPreview`. Flipping it to `true` is the core change.
- It flows to `AiPreviewState.IsOn` (seeded at startup from `config.Current.Ui.AiPreview`,
  `ServiceCollectionExtensions.cs:54-60`); `AiSeamSelector.Resolve<T>()` picks the
  `PRism.AI.Placeholder` set when ON (no-op when OFF). The frontend gates each
  surface via `useAiGate(key)` (`capabilities[key] && preferences.ui.aiPreview`);
  capabilities are uniformly AllOn/AllOff from `AiPreviewState.IsOn`.

### Existing-user preservation — the precise rule
`ConfigStore.ReadFromDiskAsync` (`ConfigStore.cs:226-297`): a **missing file**
writes `AppConfig.Default`; a **present file** is deserialized and only **null
top-level sub-records** are backfilled (`Ui = parsed.Ui ?? AppConfig.Default.Ui`,
whole-record granularity — not field-level). `UiConfig.AiPreview` is a
non-nullable `bool`. Consequences after the flip:

| On-disk config shape | Resulting `AiPreview` | Note |
|---|---|---|
| No file (true fresh install) | **true** (Default written) | the target case |
| `ui.aiPreview` key present | **its saved value** | genuine existing users preserved |
| `ui` present, `aiPreview` key absent | **false** | `System.Text.Json` → `default(bool)`; stays OFF |
| `ui` section entirely absent (legacy partial) | **true** | inherits `Default.Ui` via backfill |

The last row is the only behavior change for a pre-existing file: a legacy
`ui`-less config flips ON. This is **accepted** (such a config predates the `ui`
section entirely; the user never had or saw an AI toggle), but it is tested and
documented rather than asserted away. AC #1's "existing preserved" therefore means
*preserved when the `aiPreview` key is physically on disk*.

## Honesty audit (what a fresh default-on user actually sees)

| Surface | Renders on a real fresh install? | Marked as preview today? |
|---|---|---|
| PR summary card | Yes, always | ✅ "AI preview — sample content, not generated from this PR" |
| Pre-submit validator | On submit | ✅ same chip |
| Composer assistant / Ask-AI | When composing | ✅ "AI preview — composer suggestions appear here" |
| **Inbox category chip** ("Refactor" on every row) | **Yes — every inbox row** | ❌ bare chip, no marker |
| **Activity rail** (two fabricated sections — see below) | **Yes — inbox sidebar** | ❌ no marker |
| File-focus dots | No* | n/a (renders nothing) |
| Hunk annotations | No* | n/a (renders nothing) |
| Draft suggestions | No** | n/a (renders nothing) |

\* Matching is **exact path** (`FileTree.tsx:194` map lookup by `node.path`;
`DiffPane.tsx:184` `a.path !== selectedPath`). The canned anchor is `src/Calc.cs`.
So these render nothing **unless the user's real diff contains a file at exactly
`src/Calc.cs`** — a low-probability path collision, **accepted** (not a structural
guarantee). Not "renders nothing" as an absolute.

\*\* Draft suggestions are safe for a *stronger* reason: `UnresolvedPanel.tsx:186`
renders one only when a **real stale draft already exists** at the exact
`src/Calc.cs:3` coordinate — effectively unreachable on a real install, not merely
a path-collision bet.

**The activity rail is worse than a single fabricated list.** `ActivityRail.tsx`
renders **two** `<section>`s over static `activityData.ts`:
1. **Activity** — a fabricated teammate feed ("amelia.cho pushed iter 3 to #1842",
   "ci-bot marked CI failing on #1827").
2. **Watching** — fabricated watched repos ("platform/billing-svc · 2",
   "platform/tenants-api · 1").

Two problems: (a) the rail is a **pure static mockup** — it is *not* backed by the
`IInboxRanker` placeholder seam or any data pipeline, so wiring a real LLM would not
make it real; (b) the "Watching" section is fabricated **telemetry**, not AI output
at all, so an "AI preview" label on it would itself be inaccurate.

## Scope (owner-approved base: scope A — "mark what shows"), with one open decision

### Code changes
1. **Flip the default** — `AppConfig.cs:24` `AiPreview` `false → true`.
2. **Mark the inbox category chip** (C2) so it reads as an AI-preview sample.
3. **Activity rail** (C3) — **OPEN DECISION, see C3.** Either mark the whole aside,
   or suppress it from the default-on first impression. *Recommended: suppress.*

### Verification (no code)
4. **Copy audit** (C4) — confirm welcome / Help / Settings copy is consistent with
   default-on. No change expected.

### Test coverage
5. Backend default + preservation-edge tests; the egress-guard test; frontend marker
   tests; e2e regression. (See Testing strategy.)

**Out of scope:** marking the diff-anchored surfaces (render nothing barring the
accepted `src/Calc.cs` collision); any change to placeholder content/anchors;
wiring a real LLM; hardening `config.json` ACLs or making `AiPreviewState` a
read-only singleton (pre-existing conditions, not introduced here); a seam-bag
type-completeness test (tangential). **`LlmConfig` tripwire:** when `LlmConfig`
(today an empty record, `AppConfig.cs:87`) gains any field naming an endpoint, key,
or model, a privacy/egress review is required **before** the placeholder seam set
is replaced in the live DI registration — because the default-on flag will already
be shipping to every fresh install.

### Rejected / held alternatives
- **B — full per-surface marker pass (all 9 seams).** Most work lands on surfaces
  that never render on a real install. Gold-plating; rejected.
- **C-for-rail — suppress the activity rail by default.** Promoted from "B1 clutter
  fallback" to the **recommended** resolution of the C3 open decision (see C3).

## Component designs

### C1 — Default flip + test ripple (`PRism.Core/Config/AppConfig.cs`)
Change the third `UiConfig` positional arg `false → true`. One line.

**Ripple — the real mechanism.** Affected tests do **not** construct a `UiConfig`;
they rely on the server default via `PRismWebApplicationFactory` (real `ConfigStore`
over a fresh temp `DataDir`, no override seam) and toggle behavior by setting
`factory.Services.GetRequiredService<AiPreviewState>().IsOn = …`. The sweep:

**(a) Flip the assertion to `true`** (these assert the *default*):
- `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs:21`
  (`LoadAsync_creates_defaults_when_file_missing`) → `AiPreview.Should().BeTrue()`.
- `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs:34`
  (`aiPreview` in the default GET response) → `BeTrue()`.
- `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs:15-22`
  (`Returns_AllOff_when_aiPreview_is_false`) — uses a **shared
  `IClassFixture<PRismWebApplicationFactory>`**, so it cannot mutate `IsOn` without
  leaking across the class. Rework it to assert AllOn under the new default, or give
  it an isolated factory; keep the AllOff case by setting `IsOn = false` explicitly
  on an isolated factory.

**(b) Make "off" explicit** (these assert behavior *when off*, today via the
default — set `IsOn = false` to keep them meaningful):
- `AiEndpointsTests.cs:22-31`, `AiFileFocusEndpointTests.cs:19-27`,
  `AiDraftSuggestionsEndpointTests.cs:19-27`, `AiHunkAnnotationsEndpointTests.cs:19-27`.

**(c) Unchanged** — `ConfigStoreTests.cs:168` (preserve-existing, stays `BeFalse()`);
do **not** over-sweep `InboxRefreshOrchestratorTests.cs:321` (injects its own
`FakeAiSeamSelector`, immune to the default) or `InboxPage.test.tsx` (mocks
`useAiGate => false`).

### C2 — Inbox category chip marker (`frontend/src/components/Inbox/InboxRow.tsx:100-104`)
Today: `<span className={chipWrap}><span className={chip}>{categoryChip}</span>…</span>`.

Add the preview affordance **inside the chip element** so it travels with the chip:
- A small leading marker within the chip, using a **muted/preview token (e.g.
  `--text-3`), not `--accent`** (the chip currently shares `--accent` with real
  signals — unread bar, comment glyph — so the marker must read as distinct).
- The chip carries `title` + `aria-label` =
  **`"AI preview — sample category, not generated from this PR"`** (mirrors the
  established `AiSummaryCard` / `PreSubmitValidatorCard` wording, noun adjusted).
- **Width guard:** the chip-with-marker must fit the existing tail budget; if space
  is tight, the **category text** is shortened, not the marker. The `meta` row is
  `flex-wrap:nowrap; overflow:hidden` (silent clipping), so the marker must not push
  real fields off-screen.

**Narrow-width is already consistent (verified):** below the 560px container
breakpoint, `.chipWrap` is `display:none` (`InboxRow.module.css:267-275`) and the
row's own `aria-label` (`InboxRow.tsx:52-56`) does **not** include the category. So
when the chip hides, the fake category disappears from both the visual and a11y
trees — nothing unmarked is disclosed. Placing the marker inside the chip is
sufficient; no separate narrow-width disclosure is needed.

### C3 — Activity rail (`frontend/src/components/ActivityRail/ActivityRail.tsx`) — OPEN DECISION

The rail is a fully fabricated static mockup with two sections (Activity +
Watching), not seam-backed (see audit). Two ways to make AC #2 honest:

- **Recommended — suppress the rail from the default-on first impression.** The
  rail does not render for a fresh default-on install. Decouple it from the
  `useAiGate('inboxRanking')` default so turning AI preview on no longer surfaces a
  wholly-fabricated, non-seam-backed feed on the calm first screen; keep it
  available only behind an explicit off-by-default condition (dev/demo). Rationale:
  marking a 100%-fake feed (incl. non-AI "Watching" telemetry) as "AI preview" is
  awkward and undercuts the product's calm/honest/local-first identity; its
  "preview value" is low because no data pipeline will make it real.
- **Alternative — mark the whole aside.** If the rail stays on by default, the
  preview marker must scope the **`<aside>` above both `<section>`s** (one header
  sub-label does **not** cover "Watching"), with wording that honestly frames *both*
  the fabricated activity *and* the fabricated watched-repos as sample data not from
  the user's account — e.g. `"AI preview — sample data, not from your account"`.

This is the one place the review changed the originally-approved "mark everything
shown" framing; it is the explicit owner decision recorded in the user-review pass.

### C4 — Copy audit (verify-only)
- **Welcome** (`WelcomePage.tsx:20`): "AI that surfaces the hunks worth a closer
  look, still in active development." Already in-development framing → consistent. No
  change.
- **Settings** (`AppearancePane.tsx`): toggle help "Show AI-generated PR summaries
  and hotspots" — accurate either way. No change.
- **Help** (`HelpModal.tsx`): makes no AI claim → nothing to contradict. No change.
- Audit conclusion recorded in PR `## Proof`; AC #3 satisfied by verification.

### C5 — Egress guard (one cheap, non-brittle test)
`PRism.AI.Placeholder` references only `Microsoft.Extensions.DependencyInjection.Abstractions`
+ `PRism.AI.Contracts`; every seam returns `Task.FromResult(<canned>)` — zero
egress today. Because the flip makes this assembly **ship enabled by default to
every fresh install**, the zero-egress claim is now load-bearing. Add a single
**assembly-reference assertion**: `PRism.AI.Placeholder` (and `PRism.AI.Contracts`)
do not reference `System.Net.Http`. This is the non-brittle form of the rejected
"runtime no-network" test — it fails only if someone deliberately adds a
network-capable dependency to the placeholder assembly, which is exactly when it
should fail.

## Testing strategy

- **Backend default + edges (new):** load with **no file** → `Ui.AiPreview == true`
  (AC #1/#5); config with `aiPreview:false` present → preserved as `false`; config
  with `ui` present but `aiPreview` absent → `false`; config with `ui` absent →
  `true` (documents the accepted legacy-flip edge).
- **Backend ripple:** apply the C1 (a)/(b)/(c) sweep.
- **Egress guard (new):** the C5 assembly-reference assertion.
- **Frontend (new):** `InboxRow` — when `showCategoryChip` + an enrichment are
  present, the chip exposes the preview accessible label and the marker is visually
  present. C3-dependent: either an `ActivityRail` test for the aside-level marker
  (Alternative) or an `InboxPage` test that the rail does **not** render by default
  (Recommended).
- **Frontend (regression):** re-run `ai-gating-sweep.spec.ts` (mock-driven, sets
  state explicitly — should be unaffected; confirm).

## Acceptance criteria mapping

1. Fresh install default `aiPreview = true`; existing **with the key on disk**
   preserved → C1 + backend default/edge tests.
2. Every default-shown surface honestly reads as in-development → C2 + C3; others
   already marked or render nothing (barring the accepted `src/Calc.cs` collision).
3. Welcome/Help/Settings copy consistent → C4 (verify-only).
4. Placeholder seam has **zero external egress** — no `HttpClient`/`fetch`/URL; all
   `Task.FromResult(<canned>)` — guarded by the C5 assembly-reference test and
   restated in `## Proof`.
5. Tests cover the new default → backend default/edge tests above.

## B1 visual gate

At green-and-ready, post Playwright screenshots for the owner's eyeball-assert:
(a) the **inbox in a realistic fresh-install state** — a *sparse/empty* real inbox
(the true first impression: little real content + whatever AI surfaces ship on),
showing the marked category chip and the C3 outcome; (b) a PR-detail summary card.
Using a sparse inbox (not seeded demo data) is deliberate — it shows the contrast a
new user actually sees.
