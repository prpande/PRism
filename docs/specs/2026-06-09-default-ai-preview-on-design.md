# Default AI preview ON for new installs — design

**Issue:** [#283](https://github.com/prpande/PRism/issues/283)
**Date:** 2026-06-09
**Tier / Risk:** T2 (heavy — ~8-10 files, but one coherent unit) — gated B1
(UI-visual; `needs-design` label). The new `inbox.showActivityRail` field is a
**backward-compatible additive** config scalar (lenient read backfills the default),
following the #275 `SectionOrder` precedent — not a `state.json` schema migration, so
it does not trip the B2 persisted-schema risk surface. Re-confirmed at the pre-PR
re-check.

## Goal

Make AI preview features **on by default for fresh installs**, so a new user sees
the AI surfaces without first discovering the Settings → Appearance toggle. AI is
still backed by **placeholder** (canned, local) implementations — no real LLM is
wired — so the surfaces shown by default must honestly read as an _in-development
preview_, never as a finished or broken feature.

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

| On-disk config shape                          | Resulting `AiPreview`      | Note                                            |
| --------------------------------------------- | -------------------------- | ----------------------------------------------- |
| No file (true fresh install)                  | **true** (Default written) | the target case                                 |
| `ui.aiPreview` key present                    | **its saved value**        | genuine existing users preserved                |
| `ui` present, `aiPreview` key absent          | **false**                  | `System.Text.Json` → `default(bool)`; stays OFF |
| `ui` section entirely absent (legacy partial) | **true**                   | inherits `Default.Ui` via backfill              |

The last row is the only behavior change for a pre-existing file: a legacy
`ui`-less config flips ON. This is **accepted** (such a config predates the `ui`
section entirely; the user never had or saw an AI toggle), but it is tested and
documented rather than asserted away. AC #1's "existing preserved" therefore means
_preserved when the `aiPreview` key is physically on disk_.

## Honesty audit (what a fresh default-on user actually sees)

| Surface                                                 | Renders on a real fresh install? | Marked as preview today?                                     |
| ------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| PR summary card                                         | Yes, always                      | ✅ "AI preview — sample content, not generated from this PR" |
| Pre-submit validator                                    | On submit                        | ✅ same chip                                                 |
| Composer assistant / Ask-AI                             | When composing                   | ✅ "AI preview — composer suggestions appear here"           |
| **Inbox category chip** ("Refactor" on every row)       | **Yes — every inbox row**        | ❌ bare chip, no marker                                      |
| **Activity rail** (two fabricated sections — see below) | **Yes — inbox sidebar**          | ❌ no marker                                                 |
| File-focus dots                                         | No\*                             | n/a (renders nothing)                                        |
| Hunk annotations                                        | No\*                             | n/a (renders nothing)                                        |
| Draft suggestions                                       | No\*\*                           | n/a (renders nothing)                                        |

\* Matching is **exact path** (`FileTree.tsx:194` map lookup by `node.path`;
`DiffPane.tsx:184` `a.path !== selectedPath`). The canned anchor is `src/Calc.cs`.
So these render nothing **unless the user's real diff contains a file at exactly
`src/Calc.cs`** — a low-probability path collision, **accepted** (not a structural
guarantee). Not "renders nothing" as an absolute.

\*\* Draft suggestions are safe for a _stronger_ reason: `UnresolvedPanel.tsx:186`
renders one only when a **real stale draft already exists** at the exact
`src/Calc.cs:3` coordinate — effectively unreachable on a real install, not merely
a path-collision bet.

**The activity rail is worse than a single fabricated list.** `ActivityRail.tsx`
renders **two** `<section>`s over static `activityData.ts`:

1. **Activity** — a fabricated teammate feed ("amelia.cho pushed iter 3 to #1842",
   "ci-bot marked CI failing on #1827").
2. **Watching** — fabricated watched repos ("platform/billing-svc · 2",
   "platform/tenants-api · 1").

Two problems: (a) the rail is a **pure static mockup** — it is _not_ backed by the
`IInboxRanker` placeholder seam or any data pipeline, so wiring a real LLM would not
make it real; (b) the "Watching" section is fabricated **telemetry**, not AI output
at all, so an "AI preview" label on it would itself be inaccurate.

## Scope (owner-approved base: scope A — "mark what shows"), with one open decision

### Code changes

1. **Flip the default** — `AppConfig.cs:24` `AiPreview` `false → true`.
2. **Mark the inbox category chip** (C2) so it reads as an AI-preview sample.
3. **Decouple the activity rail from AI** (C3) — the rail is a non-AI, fully
   fabricated mockup. Gate it on a **new `inbox.showActivityRail` config flag
   (default `false`)** instead of `useAiGate('inboxRanking')`. It no longer appears
   for a default-on install (or any install) unless the flag is enabled. Note the
   two key forms: `inbox.showActivityRail` is the **PATCH/allowlist** key (the
   `POST /api/preferences` wire shape, camelCase dotted-path); the **on-disk
   `config.json`** uses the Storage kebab-case nested shape —
   `{ "inbox": { "show-activity-rail": true } }` — so a manual edit must use that
   form, not the PATCH key. (Same kebab-vs-camel distinction flagged by Copilot on
   PR #309.)

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
- **Mark the rail in place (keep it AI-gated, label the aside).** Rejected by the
  owner: the rail is non-AI, fully fabricated, and not seam-backed, so it does not
  belong under the AI preview toggle at all. Decoupling it (C3) is preferred over
  labeling a fake feed as "AI preview."
- **Park/remove the rail (no config control).** Considered; rejected in favor of a
  config flag so the rail stays real-but-dormant with a clean non-AI control.

## Component designs

### C1 — Default flip + test ripple (`PRism.Core/Config/AppConfig.cs`)

Change the third `UiConfig` positional arg `false → true`. One line.

**Ripple — the real mechanism.** Affected tests do **not** construct a `UiConfig`;
they rely on the server default via `PRismWebApplicationFactory` (real `ConfigStore`
over a fresh temp `DataDir`, no override seam) and toggle behavior by setting
`factory.Services.GetRequiredService<AiPreviewState>().IsOn = …`. The sweep:

**(a) Flip the assertion to `true`** (these assert the _default_):

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

**(b) Make "off" explicit** (these assert behavior _when off_, today via the
default — set `IsOn = false` to keep them meaningful):

- `AiEndpointsTests.cs:22-31`, `AiFileFocusEndpointTests.cs:19-27`,
  `AiDraftSuggestionsEndpointTests.cs:19-27`, `AiHunkAnnotationsEndpointTests.cs:19-27`.

**(c) Unchanged** — `ConfigStoreTests.cs:168` (preserve-existing, stays `BeFalse()`);
do **not** over-sweep `InboxRefreshOrchestratorTests.cs:321` (injects its own
`FakeAiSeamSelector`, immune to the default) or `InboxPage.test.tsx` (mocks
`useAiGate => false`).

### C2 — Inbox category chip marker (`frontend/src/components/Inbox/InboxRow.tsx:100-104`)

Today: `<span className={chipWrap}><span className={chip}>{categoryChip}</span>…</span>`.

**The fake category is visual-only — so the marker is a visual treatment.** The row
is a `<button aria-label={ariaLabel}>` (`InboxRow.tsx:52-56,64`) and that
`ariaLabel` does **not** include the category. A screen reader announces only the
button's own label and **suppresses descendant `aria-label`/`title`** — so a chip
`aria-label` would never be announced, and (more importantly) SR users never
perceive the fabricated "Refactor" at all. There is therefore no SR honesty gap to
close: the category is honest-by-omission for AT. The marker exists for **sighted**
users who see the chip. (Do **not** rely on a chip `aria-label` as an a11y
mechanism — it's swallowed. A `title` may stay as a mouse-hover tooltip only.)

**Marker form (concrete, so the implementer doesn't guess):**

- Prepend a **separate** element inside the chip: `<span className={chipMarker}>AI</span>`
  before the category text — i.e. renders as `AI Refactor`, not a single blob.
- `chipMarker` uses a **muted token (`--text-3`), not `--accent`** (the chip shares
  `--accent` with real signals — unread bar, comment glyph — so the marker must read
  as distinct), with a small fixed `font-size` so its width is known.
- **Width guard:** the marker is fixed-width; if the tail budget is tight, the
  **category text** is shortened, not the marker. The `meta` row is
  `flex-wrap:nowrap; overflow:hidden` (silent clipping) — the marker must not push
  real fields off-screen.

**Per-row repetition — accepted.** The placeholder enricher returns the same
"Refactor" category for every row, so `AI Refactor` repeats down the list. This is
accepted rather than moved to a section-header badge: the chip (and its marker) is
hidden together below the 560px container breakpoint (`InboxRow.module.css:267-275`),
and a section-level badge would not track that per-row hide. The repetition is
inherent to placeholder data and resolves when a real model returns varied
categories. Final visual read is confirmed at the B1 gate.

**Narrow-width is consistent (verified):** below 560px, `.chipWrap` is
`display:none`, so the chip + its marker disappear together — nothing unmarked is
disclosed, and (per above) nothing was announced to AT anyway.

### C3 — Decouple the activity rail from AI (owner decision: config flag)

The rail is a fully fabricated static mockup with two sections (Activity +
Watching), **not** backed by the `IInboxRanker` seam or any data pipeline — and
`IInboxRanker.RankAsync` is **never called in the live inbox pipeline**
(`InboxRefreshOrchestrator.cs:248` resolves only `IInboxItemEnricher`; the ranker
seam is registered in DI but never resolved). NB: the one live `RankAsync` call,
`AiEndpoints.cs:40`, is **`IFileFocusRanker`.RankAsync** — a _different_ interface
that shares the method name, on the PR-detail file-focus surface, unrelated to the
inbox. So the only thing `inboxRanking` gates is the rail's visibility, and the rail
does not belong under the AI preview toggle.

**Change:** introduce a new **non-AI** inbox setting and gate the rail on it. Each
"stop" below is **two code sites** — naming only one risks a half-wired, silently
no-op'ing field:

- **Backend config** — append `bool ShowActivityRail = false` to `InboxConfig`
  (`AppConfig.cs`) **as the last record parameter, after `SectionOrder`** (C# needs
  optional params last; the positional `new InboxConfig(true, …, 14)` at
  `AppConfig.cs:20` stays valid with a trailing defaulted param). Following the
  additive scalar pattern of `SectionOrder`/`DefaultSort` (#275). Default **false**:
  the rail shows for nobody unless explicitly enabled in `config.json`.
- **ConfigStore (two sites)** — add `["inbox.showActivityRail"] = ConfigFieldType.Bool`
  to `_allowedFields` **and** an apply-switch arm
  `"inbox.showActivityRail" => _current with { Inbox = _current.Inbox with { ShowActivityRail = (bool)value! } }`.
  (Allowlist alone passes validation but falls through the apply switch to the
  `_ => throw` default → 400.)
- **PreferencesEndpoints (two sites)** — add `bool ShowActivityRail` to
  `InboxPreferencesDto` (`PreferencesDtos.cs`) **and** pass
  `config.Current.Inbox.ShowActivityRail` in `BuildResponse` (it projects field-by-
  field, not wholesale). camelCase serialization is automatic — no `[JsonPropertyName]`.
- **Frontend type** — add `showActivityRail: boolean` to `InboxPreferences` in
  `frontend/src/api/types.ts` (not the `usePreferences` hook, which is a thin
  re-export). `tsc -b` catches the omission.
- **Frontend gate** — in `InboxPage.tsx`, replace
  `const showActivityRail = useAiGate('inboxRanking')` with
  `preferences?.inbox.showActivityRail ?? false`. The `<ActivityRail/>` render
  (`:117`) and the `<InboxSkeleton showRail=…/>` prop (`:54`) follow the new flag.
- **No Settings UI toggle** — the rail is still a fabricated mockup; surfacing a
  "show sample activity" switch to users would be dishonest until the feed is real.
  Config-only for now; a UI control lands when the rail carries real data.
- **Orphaned, left in place** — `inboxRanking` (the `AiCapabilities` field) and
  `PlaceholderInboxRanker`/`NoopInboxRanker` lose their only consumer. They are
  harmless ceremonial infra; removing them would widen scope into AI-contract
  cleanup, so they stay. Noted for a future cleanup.

**Existing AI-on users lose the rail (intended).** Today the rail is gated purely on
`useAiGate('inboxRanking')`, so every current user who has AI preview ON sees it.
After this change it is gated on the new flag, which is absent from their
`config.json` → backfills `false` → the rail **disappears** for them on upgrade,
with no Settings control to restore it (config-only). This is an accepted
consequence of taking a fabricated mockup out of AI scope — no real data is lost,
and the restore path is hand-editing `config.json` until the feed is real. Called
out here and in the PR `## Proof` so it isn't a silent surprise.

This is the one place the review changed the originally-approved "mark everything
shown" framing — the owner chose to take the rail out of AI scope entirely.

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

- `PRism.AI.Contracts`; every seam returns `Task.FromResult(<canned>)` — zero
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
- **Config round-trip (new):** `inbox.showActivityRail` defaults `false`; survives a
  GET → PATCH(true) → GET round-trip through the preferences endpoint + allowlist.
- **Frontend (new):** `InboxRow` — when `showCategoryChip` + an enrichment are
  present, the `AI` marker span renders before the category text (visual marker
  present). `InboxPage` — the rail does **not** render when `aiPreview` is on but
  `inbox.showActivityRail` is false (decoupled), and **does** render when
  `showActivityRail` is true regardless of `aiPreview`. `InboxSkeleton` — no rail
  placeholder when `showActivityRail` defaults false (cold-load first impression).
- **Frontend (rewrite, decoupling ripple):** the rail no longer toggles with AI —
  - `InboxPage.test.tsx:202-212` ("renders/hides ActivityRail when aiPreview on/off")
    → re-point to `inbox.showActivityRail`.
  - `frontend/e2e/inbox.spec.ts` "AI preview toggle reveals activity rail" → rewrite
    to drive the new flag (or remove the rail assertion; keep the AI-toggle test for
    the chip/PR surfaces).
  - `frontend/e2e/ai-gating-sweep.spec.ts` step (e) rail assertion → remove (rail is
    no longer an AI surface); the sweep still covers chip + PR-detail surfaces.
  - `ActivityRail.test.tsx` (component-internal render) → unchanged.

## Acceptance criteria mapping

1. Fresh install default `aiPreview = true`; existing **with the key on disk**
   preserved → C1 + backend default/edge tests.
2. Every default-shown surface honestly reads as in-development → C2 marks the chip;
   C3 removes the fabricated rail from the default surface (decoupled to a config
   flag, default off); other surfaces are already marked or render nothing (barring
   the accepted `src/Calc.cs` collision).
3. Welcome/Help/Settings copy consistent → C4 (verify-only).
4. Placeholder seam has **zero external egress** — no `HttpClient`/`fetch`/URL; all
   `Task.FromResult(<canned>)` — guarded by the C5 assembly-reference test and
   restated in `## Proof`.
5. Tests cover the new default → backend default/edge tests above.

## B1 visual gate

At green-and-ready, post Playwright screenshots for the owner's eyeball-assert:
(a) the **inbox in a realistic fresh-install state** — a _sparse_ real inbox (the
true first impression), showing the marked category chip and **no activity rail**
(decoupled, default off); (b) a PR-detail summary card with its marked AI summary.
Using a sparse inbox (not seeded demo data) is deliberate — it shows what a new user
actually sees. The marker form on the chip (C2) is the primary thing to eyeball.
