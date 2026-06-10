# Plumb real data into the Inbox Activity rail — design

**Issue:** [#137](https://github.com/prpande/PRism/issues/137)
**Date:** 2026-06-09
**Tier / Risk:** T3 (full — net-new behavior across backend adapters, a core builder,
a new endpoint, a frontend hook, the rail rewrite, and a Settings control) — **gated
B1** (`needs-design` label; the rail's rendered output a human must eyeball) **and
B2** (auth / PAT-scopes — new GitHub API surface; PAT-scope determination is an
acceptance criterion). Human gates apply; this is **not** a hands-off run.

**Shipped in two phases / two PRs** — see § Phasing.

**Depends on:** [#309](https://github.com/prpande/PRism/pull/309)
(`feature/283-default-ai-preview-on`). #309 decouples the rail from the AI gate and
adds the `inbox.showActivityRail` config flag (Bool, **default false**, config-only —
#309 deliberately deferred the Settings UI "until the rail carries real data").
This branch is cut from #309's branch; #137 must land **after** #309 (or rebase onto
its merge commit).

## Goal

The Inbox right rail renders two panels — **Activity** and **Watching** — from a
hard-coded `activityData.ts` mock. Replace the mock with **real GitHub data**, with
graceful loading / empty / degraded states, and surface the now-real rail through a
**Settings toggle**. Determine and document the PAT scopes the new data requires.

Non-goal restatement: the AI-gate decoupling (issue AC #5) is delivered by #309 and
is **out of scope** here. #137 owns the *data* and the *Settings UI* #309 deferred.

### Why a rail, and not just more inbox columns

The inbox sections (`review-requested`, `awaiting-author`, `authored-by-me`,
`mentioned`, `recently-closed`) and the CI-failing filter already surface *which PRs
need me*. A rail that merely re-listed those PRs one column over would be redundant.
The rail's **distinct** value is the one thing the inbox does not carry: **actor
attribution on activity** — *who* opened / pushed to / reviewed / commented on a PR,
drawn from received_events. That is why **Phase 1 ships the actor feed first** (see
§ Phasing): it delivers the differentiating value at a fraction of the complexity, and
proves the rail earns its column before the rest is built.

## Phasing

The work splits into two independently-shippable PRs. **Phase 2 is gated on a Phase 1
keep decision** — the owner runs Phase 1 (default-off flag, opt-in) for ~1–2 weeks and
only proceeds to Phase 2 if they find the feed useful. This front-loads the
differentiating value, defers the expensive merge machinery until it's justified, and
keeps Phase 1 disposable: if cut, Phase 1 is still self-contained (real actor feed,
mock deleted, toggle wired) and no Phase-2 wire surface was ever shipped.

| | **Phase 1 — Activity (actor feed)** | **Phase 2 — merge + Watching** *(gated on Phase 1 keep)* |
|---|---|---|
| **Activity source** | `received_events` only (carries the actor) | + `notifications` merged in (fresh, you-relevant) |
| **Watching panel** | hidden (rail shows Activity only) | `/user/subscriptions` + count |
| **Merge engine** | one source → window → within-feed dedup → sort | full: two-stage cross-feed dedup, actor-preserving merge, event-slot reservation |
| **Verb phrasing** | actor always present (reviewed/commented/opened/merged; no "pushed") | + actorless templates (notifications carry no actor) |
| **Bot filter** | in-rail toggle, **default hidden**, **transient** (`useState`, not persisted) | + persist the choice if the friction proves real |
| **Refresh** | ~90s poll, last-good retention | + ~60s server TTL cache (3 calls/miss) + visibility-pause |
| **Routing** | in-app `<Link>` (received_events always carry a PR URL) | + external/fallback handling for varied notification URLs |
| **New classic scope** | none (`repo` covers received_events) | none (`repo` covers notifications + subscriptions) |
| **New FG permission** | Events: read | + Notifications: read, Metadata: read |
| **Wire contract** | `Items`, `GeneratedAt`, `Degraded{ReceivedEvents}` | + `Watching[]`, `Degraded{+Notifications,+Watching}` (additive) |

Each phase gets its own implementation plan (`writing-plans`) and its own B1 visual
sign-off. Sections below are tagged **[P1]**, **[P2]**, or **[shared]**.

## Background — what exists today *(shared)*

- `frontend/src/components/ActivityRail/ActivityRail.tsx` renders two `<section>`s
  from static arrays in `activityData.ts` (`ActivityItem`, `WatchedRepo`). The
  exports are consumed only by the rail — deletion is clean (no external importers).
- The rail is rendered by `InboxPage.tsx`; after #309 it is gated on
  `preferences.inbox.showActivityRail` (not `useAiGate`). Responsive cutoff hides it
  under 1180px (`InboxPage.module.css`). `.rail` is a flex column of self-contained
  `.section` cards (no two-section grid / nth-child rules), so removing one section in
  P1 is layout-clean.
- **No** backend activity/feed endpoint exists. The GitHub client calls only PR
  detail, timeline, search, content, and validation APIs — **no** events /
  notifications / subscriptions calls.
- Per-concern GitHub adapters establish the pattern this spec follows:
  `GitHubCiFailingDetector`, `GitHubPrEnricher`, `GitHubSectionQueryRunner`
  (`PRism.GitHub/Inbox/`), each fault-isolated and individually testable. They key
  caches on **data identity**, not the token — this spec follows that precedent.
- The inbox refresh pipeline (`IInboxRefreshOrchestrator` + SSE + polling) is
  **deliberately not reused** — see § Architecture decision.
- All `/api/*` endpoints are gated globally by `HostHeaderCheckMiddleware` →
  `OriginCheckMiddleware` → `SessionTokenMiddleware` (registered in `Program.cs`
  before endpoint mapping); a new endpoint inherits this.

## Data sources *(shared)*

| Phase | Panel | GitHub API | Carries | Freshness | Classic scope | Fine-grained permission |
|---|---|---|---|---|---|---|
| P1 | Activity | `GET /received_events` (auth as self) | `actor`, event `type`, repo, payload, `created_at` — **carries actor**; private events included when authed as self | **laggy: 30s–6h** | `repo` (already required) | Events: read |
| P2 | Activity | `GET /notifications` | subject (PR/issue/…), `reason`, repo, `updated_at` — **no actor** | fresh | `repo` (already required) | Notifications: read |
| P2 | Watching | `GET /user/subscriptions` | watched repos (full names) | n/a | `repo` (already required) | Metadata: read |

The "Classic scope" column is uniform: the `repo` scope PRism **already requires**
covers all three endpoints (notifications doc: "require the `notifications` **or**
`repo` scopes"; events/subscriptions work with any authenticated token, and `repo`
grants the private-repo visibility the user expects). **No new classic scope in either
phase** — classic is the recommended token type, verified live (acceptance criterion).
The fine-grained column is the only place a new permission appears; the exact FG set
per phase is confirmed empirically during implementation.

**received_events staleness is an accepted tradeoff** — and Phase 1 is the deliberate
test of whether it's tolerable. Each item renders its own relative timestamp (`5h
ago`), the per-item age cue, so a stale line is self-labeling. In Phase 2 the
notification merge keeps fresh items on top; ordering is **priority-then-time, not
strictly chronological** across tiers (accepted — no separator; the timestamp
suffices).

## Architecture decision — dedicated endpoint, isolated from the inbox *(shared)*

Activity is sourced, scoped, and timed independently of the inbox sections (different
APIs, failure modes, and a feed that lags hours vs. an inbox that refreshes fast).
Folding it into the inbox orchestrator/snapshot/SSE would couple unrelated domains and
risk a feed failure tainting the inbox. **Decision:** a standalone `GET /api/activity`
with its own poll loop. Rejected: fold-into-inbox-snapshot (coupling); notifications-
only (loses the actor — the Phase 1 payoff).

## Scope of items — PR-anchored only (v1) *(shared, with per-phase source sets)*

Every Activity item is **anchored to a pull request**, so every row is clickable to a
real PR and the dedup key is unambiguous (a real PR number — an Issue #5 and a PR #5
never collide).

**[P1] received_events type set** — **verified live against the owner's real feed**
(78 PR-anchored events, 100% carrying both actor and PR number). Each row below was
observed; reviews dominate (~48), then review-comments (~14), then PR lifecycle (~11).
**These percentages are descriptive of one feed at one time, not a GitHub API
contract** — the API guarantees neither actor-presence nor a stable payload shape. The
normalizer's drop-on-missing-actor/PR-number path (§ Builder step 1) is the fallback
for when they don't hold; because drops are silent, the builder **logs a debug counter
of dropped-but-recognized events** so feed thinning from a payload-shape shift is
observable during the dogfood window instead of masquerading as a quiet feed.

| Event type | → Verb | PR number from |
|---|---|---|
| `PullRequestReviewEvent` | Reviewed | `payload.pull_request.number` |
| `PullRequestReviewCommentEvent` | Commented | `payload.pull_request.number` |
| `IssueCommentEvent` **only when `payload.issue.pull_request` present** | Commented | `payload.issue.number` |
| `PullRequestEvent` action `opened`/`reopened` | Opened / Reopened | `payload.pull_request.number` |
| `PullRequestEvent` action `closed` | Closed / Merged (if `payload.pull_request.merged`) | `payload.pull_request.number` |

**No "pushed" verb (confirmed gap).** `PushEvent` references a branch/commits and
carries **no PR number**, and the PR `synchronize` action (the "new commits on the PR"
signal) is **filtered out of the Events API** — verified against three busy public
repos (0 `synchronize` in 300 events) *and* the owner's live feed. So the original
mock's "pushed iter N to #PR" line is **not buildable from `received_events`**; the
value comes from reviewed / commented / opened / merged instead (which the live feed
has in abundance). `IssueCommentEvent` on a plain issue (no `pull_request` marker) is
dropped. Any unmapped type → dropped (not `Other`, to keep the feed PR-clean).

**Bots appear and are hidden by default.** The live feed includes loud bot actors
(`mergewatch-playlist[bot]`, `Copilot`, etc.). They are **filtered out by default** and
revealed via an in-rail toggle (see § P1 frontend) — the owner's call, because the bots
are noise and the human signal is what the rail is for. Each item is server-tagged
`ActorIsBot` — detected by the `[bot]` login suffix, **plus a small known-bot
allowlist** for suffix-less review bots (e.g. `Copilot`, whose login lacked the suffix
in the live feed — confirm the exact login at implementation). **Note the interaction
with the keep/cut gate:** with bots hidden by default and a review-dominated feed (many
reviews are bot-authored), the *default* human-only view is sparser than the raw feed —
during the P1 trial, toggle bots **on** at least once to judge full volume so a
bot-filtered default doesn't read as a falsely-quiet feed.

**Within-feed dedup (Phase 1, required).** The live feed emits the *same* actor / verb
/ PR more than once (e.g. `Copilot reviewed #195` appeared twice). Phase 1's builder
therefore collapses duplicates on **`(Repo, PrNumber, Verb, ActorLogin)`**, keeping the
most recent. (This is the single-source precursor to Phase 2's cross-feed merge.)

**[P2] notifications scope:** only `subject.type == "PullRequest"`; Issue / Discussion
/ Release / CheckSuite (`ci_activity`) / Commit subjects are **dropped**. Non-PR
subjects (notably `ci_activity`) are in § Out of scope as a deferred extension.

## Contracts *(phased — P1 ships only what P1 populates; P2 adds additively)*

```
// --- P1 ---
public enum ActivitySource { ReceivedEvent }                 // wire: kebab-case; P2 adds Notification
public enum ActivityVerb {                                    // wire: kebab-case; P1 emits a subset
  Opened, Reopened, Closed, Merged, Reviewed, Commented, Other   // NB: no Pushed — not derivable (see § Scope)
}                                                             // P2 adds ReviewRequested, Mentioned

public sealed record ActivityItem(
  string? ActorLogin, string? ActorAvatarUrl,   // P1 always populates (events carry actor); nullable so P2 notifications fit
  bool ActorIsBot,                              // server-tagged; client filters on the in-rail toggle
  ActivityVerb Verb, string Repo,
  int PrNumber, string? Title, string Url,
  DateTimeOffset Timestamp, ActivitySource Source);

public sealed record ActivityDegradation(bool ReceivedEvents);   // P2 grows to add Notifications, Watching

public sealed record ActivityResponse(
  IReadOnlyList<ActivityItem> Items,
  DateTimeOffset GeneratedAt,
  ActivityDegradation Degraded);                // P2 adds IReadOnlyList<WatchedRepoActivity> Watching

// --- P2 adds ---
public sealed record WatchedRepoActivity(string Repo, int Count, string Url);
```

P1 ships **no Watching list and a single-flag degradation record** — no always-empty
`Watching[]` and no always-false flags on the wire. P2 adds `Watching` to
`ActivityResponse` and grows `ActivityDegradation` (additive; the frontend reads both
leniently, mirroring `usePreferences`/`useEventSource`). Enums serialize kebab-case
(architectural invariant). `ActivityVerb.Other` is the lenient fallback for a mapped-
but-unrecognized variant; never throw. `PrNumber` is non-nullable (every item is
PR-anchored).

---

# Phase 1 — Activity (actor feed), received_events only

## P1 backend

### Reader (`PRism.GitHub/Activity/GitHubReceivedEventsReader`)

`IReceivedEventsReader.ReadAsync(ct) → IReadOnlyList<RawReceivedEvent>`, behind a
`PRism.Core/Activity/` interface, mirroring the `Inbox/` adapters. **Fault-isolated:**
catches transport / 429 / 403 / cancellation-adjacent failures, returns **empty + sets
`Degraded.ReceivedEvents`** — never throws (mirrors `GitHubCiFailingDetector`).

### Builder (`PRism.Core/Activity/ActivityFeedBuilder`) — single-source form

Pure, unit-testable with a fake reader. One source, but real data showed it still
needs a within-feed dedup:

1. **Normalize** each event in the [P1] type set → `ActivityItem` (`ActorLogin` +
   `ActorAvatarUrl` from `actor`, `ActorIsBot` per the detection rule (`[bot]` suffix +
   known-bot allowlist), `Verb` per the table, `Repo`, `PrNumber` from the payload
   field named in the table, `Url`, `Timestamp = created_at`, `Source = ReceivedEvent`).
   Events outside the set are dropped. **If `actor` or the PR number is unexpectedly
   absent on a recognized type, drop the item** (keeps the P1 guarantee that every
   emitted item has a non-null `ActorLogin`) **and increment a debug-logged
   dropped-recognized counter** so a payload-shape shift surfaces as an observable
   number, not silent feed thinning.
2. **Window** to the last 24h.
3. **Within-feed dedup** — collapse only **true API duplicates**, keyed on the GitHub
   event **`id`** (the Events API re-emits the same logical event — e.g. `Copilot
   reviewed #195` appeared twice with the *same* event id). **Do not** collapse on a
   semantic `(Repo, PrNumber, Verb, ActorLogin)` tuple: that erases two genuinely
   distinct same-actor actions (e.g. `noah.s reviewed #1810` requesting-changes at 9am
   then approving at 4pm), which is exactly the actor-attribution signal the rail
   exists to show. *(Confirm the GitHub event `id` is present on `received_events`
   items during implementation; if it is not, fall back to the semantic tuple **plus a
   short time-window** so only near-simultaneous repeats collapse.)*
4. **Sort** by `Timestamp` desc. **Do NOT cap server-side** — return the deduped 24h
   set up to a safety max (`MaxRawItems`, ~50) so the client can filter bots and *then*
   cap to `MaxActivityItems` (12) without leaving gaps (see § P1 frontend).

The builder leaves a clean seam for Phase 2 to insert the notification source + the
cross-feed dedup/merge/slot-reservation stages.

### Endpoint (`PRism.Web/Endpoints/ActivityEndpoints.cs`)

`GET /api/activity` → `IActivityProvider.GetActivityAsync(ct)` → `ActivityResponse`.
No orchestrator.

- **Auth:** inherits the global middleware pipeline like every other `/api/*`
  endpoint — requires a valid `prism-session` token; **not** a new unauthenticated
  surface. Precise per-middleware reality (so the plan doesn't over-credit the
  pipeline): `SessionTokenMiddleware` (per-process random cookie) is the **effective
  gate for this GET**; `HostHeaderCheckMiddleware` is enforced **sidecar-mode +
  non-Development only** (`Program.cs` passes `sidecar.Enabled && !IsDevelopment()`),
  and `OriginCheckMiddleware` gates **mutating** methods (a GET passes its origin
  check). This is the same posture as every existing GET `/api/*` endpoint — #137
  introduces no new exposure — but DNS-rebinding defense for this endpoint in
  browser-tab mode rests on the session cookie, not the Host-header check.
- **No server cache in P1.** A single user polling ~90s = ~1 GitHub call/90s, which
  needs no cache. (The TTL cache lands in P2, where the merge makes 3 calls per miss
  and the cache must also handle identity-change invalidation — see P2.)
- **Failure shape:** **always returns 200** — failure surfaces via
  `Degraded.ReceivedEvents` + empty `Items` (never 500). No token (e.g. revoked after
  enabling) → empty + degraded; the primary gate is the frontend (toggle off → no
  fetch) and the auth pipeline (Settings unreachable without a token).

DI wiring in `PRism.GitHub/ServiceCollectionExtensions.cs` (reader) and the Web
composition root (provider + endpoint).

## P1 frontend

### Hook — `frontend/src/hooks/useActivity.ts`

Fetches `/api/activity`; polls every **~90s**; **retains last-good data across a failed
poll** (no error flash on a transient blip). Exposes `{ data, isLoading, error }`,
following `useEventSource` / `usePrDetail` conventions. (Tab-hidden visibility-pause is
deferred to P2, where the 3-call cost makes it worth the extra surface.)

### `ActivityRail.tsx`

Consumes `useActivity`; renders **only the Activity panel** in P1 — the Watching
`<section>` is removed (no faked panel). The single Activity card keeps the existing
`.section` card chrome; the rail is content-height (the existing flex-column model),
not stretched to inbox height.

- **Verb phrasing:** every P1 item has an actor → `{actor} {verbPhrase} {prRef}`
  (e.g. "noah.s reviewed #1810", "rohitpradhan03 commented on MindBodyPOS#5436",
  "jules.t merged #1827"), with a small avatar + login. (Actorless templates arrive in
  P2 with notifications.) **Avatar:** reuse the existing `Avatar` component (#127) at
  its small (`sm`) slot with the same initials/placeholder fallback the PR-detail
  comment cards use (#129) for a null/404 `ActorAvatarUrl`. In P1 `ActorLogin` is never
  null; the null-actor avatar slot only matters in P2 (actorless notification rows),
  where the slot shows the generic placeholder, not an empty gap.
- **Accessible name for each row:** the `Title` field is on the wire but, to keep row
  density, is **not** in the visible phrase. The clickable `<Link>`/`<a>` carries an
  `aria-label` that appends the title — e.g. `noah.s reviewed #1810 — Fix login
  redirect loop` — so a screen-reader user gets PR context the sighted compact row
  omits. If `Title` is null, the label is the visible phrase alone.
- **Bot filter toggle (in-rail header):** a small control at the top of the Activity
  panel toggles bot-authored items in/out — **default hidden** (`mergewatch[bot]`,
  `Copilot`, etc. filtered out; toggle reveals them). The panel header becomes a
  three-element flex row — `"Activity"` title · `"last 24h"` muted label · toggle pinned
  to the trailing edge; under squeeze the muted label drops before the title or toggle.
  The control is an `aria-pressed` **toggle button** with a stable accessible name
  (`"Show bots"`, `aria-pressed` reflecting on/off) — matching PRism's existing
  toggle-button convention (gear / AI toggle) rather than a label that swaps between
  "show"/"hide". Filtering is **client-side and instant**: the hook holds the full
  deduped set (`ActorIsBot`-tagged); the rail filters per the toggle, **then** caps to
  `MaxActivityItems` (12) — so revealing bots fills in instead of leaving the human-only
  view artificially short. **The toggle is transient P1 state** — a `useState`
  initialized to *hidden*, **not** persisted. (Rationale: P1 is gated on a keep
  decision, so a persisted `inbox.activityRailShowBots` preference would be ~5–6 sites
  of config plumbing — `ConfigStore` allowlist + apply arm, `AppConfig`, DTO, TS type,
  `PreferencesContext` union + read/write — at risk of being dead weight if Phase 1 is
  cut. With the default already hidden, the common case needs no persistence; if
  re-revealing bots every session proves annoying during the trial, **P2 adds the
  persisted preference** via the same cheap #275 pattern, demand-validated.) This is
  distinct from the Settings "Show activity rail" master toggle.
- **Clickable items (in-app):** received_events items always carry a GitHub PR
  `html_url` (`github.com/{owner}/{repo}/pull/{n}`). A small parser extracts
  owner/repo/number from that URL into a `PrReference` and builds the **in-app router
  `<Link>`** to PRism's `/pr/{owner}/{repo}/{n}` route (this reuses the `PrReference`
  shape, **not** `parsePrRefFromPathname`'s regex, which matches PRism's own pathname
  — not a github.com URL). If the parse fails (defensive), fall back to an `<a>`
  opening the GitHub URL via the existing open-in-GitHub path (#131) — never throw.
  Both render as focusable, keyboard-activatable anchors. (The richer external-link
  affordance for varied URL shapes is a P2 concern when notification URLs arrive.)
- **States:**
  - *Loading — cold inbox load* (first paint): `InboxSkeleton`'s rail renders a
    **single** panel in P1. The existing skeleton always draws two stacked blocks
    inside its `showRail` branch (`InboxSkeleton.tsx`); the change is to that block
    **count inside the existing `showRail` branch** (not the boolean prop, which only
    decides whether the rail column appears). The second block returns with Watching
    in P2.
  - *Loading — rail mounting after a preference flip:* enabling **Settings → Inbox →
    Show activity rail** while the inbox is already painted mounts the rail with
    `useActivity` `isLoading && !data` but **without** the `InboxSkeleton` path (the
    inbox itself isn't loading). The rail must render its **own** in-card skeleton
    (the `.section` chrome + a couple of placeholder rows) on this path — never a bare
    panel and never a flash of the empty/degraded copy before the first fetch resolves.
    This is the most common first impression of the rail, so it is specified, not left
    to the implementer.
  - *Empty (quiet feed):* **`No pull-request activity in the last 24h`** — names the
    window so a functional-but-quiet feed reads as working, not broken.
  - *Empty (bots filtered out):* when the feed has items but the bot toggle is **off**
    and the human-only set is empty (e.g. a 24h window where every actor was a bot),
    show **`No human activity in the last 24h — turn on "Show bots" to see bot
    activity`**. This names the *filter* as the cause, not the window, so the user who
    just watched rows disappear isn't told the feed is quiet.
  - *Degraded / Error:* a single generic inline note **`Activity unavailable`**, shown
    when the fetch fails (and no last-good data) or `Degraded.ReceivedEvents` is true.
    It uses a **distinct treatment from the empty state** (a muted warning/alert style,
    not the same plain muted text) so "broken" and "quiet" are visually separable. No
    cause-specific messaging (rationale below). **The activity rail does not special-case
    a revoked GitHub PAT.** ce-doc-review surfaced a "distinguish 401 → Reconnect GitHub"
    idea; investigation of the auth code (`apiClient` → `prism-auth-rejected` →
    `isAuthed`, `App.tsx`) showed that path fires on **PRism session-cookie** 401s, not
    on **GitHub PAT** revocation — a mid-session PAT revocation has **no global reconnect
    surface today** (every GitHub-backed feature, inbox included, just degrades). Adding
    `AuthInvalid` to *only* this endpoint would make the rail say "Reconnect" while the
    inbox silently degrades on the same dead token — inconsistent, and worse than uniform
    degradation. The real gap (a global GitHub-401 → reconnect affordance) is filed as
    **[#312](https://github.com/prpande/PRism/issues/312)** and is out of scope for #137;
    this rail conforms to the house degrade-quietly pattern until that global surface
    exists, then feeds it like every other GitHub surface.
- **Rendering safety:** GitHub-supplied strings (`Title`, `ActorLogin`) render as text
  via React's default escaping — never `dangerouslySetInnerHTML`.
- Relative-time rendering **reuses the inbox row's existing relative-time formatter** so
  rail and inbox stay consistent (minutes/hours only given the 24h window).
- Delete `activityData.ts`; relocate the `ActivityItem` TS type alongside the hook or
  in `api/types`. (Existing `__tests__/ActivityRail.test.tsx` asserts two sections /
  "Watching" / "idle" and must be rewritten for the one-section P1 rail; the e2e
  `parity-baselines` rail spec still enables via `aiPreview` and must switch to
  `showActivityRail` — both are expected churn captured in the P1 plan.)

**Why a single generic degraded note (cause distinction rejected, shared P1+P2):** the
flag is a boolean. Distinguishing "missing FG permission" from a 429 or transport
error is unreliable — GitHub returns 403 for several causes and the signal differs by
token type. A "grant access" hint would also steer users toward a **fine-grained**
token, which PRism discourages (FG can't call the Checks API) and classic users never
need. A generic note is honest and simpler. (Out of scope: `DegradationCause`.)

## P1 Settings toggle UI

Add a **"Show activity rail"** toggle under **Settings → Inbox**, bound to the existing
`inbox.showActivityRail` field (#309 created it config-only, default false). Mirrors the
`defaultSort` / `sectionOrder` rows (same preferences plumbing). A **static** sub-label
reads **"Hidden on narrow windows."** (always shown — the panel does not branch on
viewport). Turning it on, with real data backing the rail, completes #309's deferral.

## P1 PAT scopes

- **Classic:** `repo` (already required) — `/received_events` works with the
  authenticated token; `repo` grants private-repo visibility. **No new classic scope.**
  `RequiredScopes` unmodified (stays off the auth-validation surface). Verified live.
- **Fine-grained:** **Events: read** (confirmed empirically). Documented in PAT guidance
  (`#213` lineage); missing → graceful degrade (generic note), no blocking validation.

## P1 testing (TDD red → green)

- **Builder** (fake reader): the type→verb table (Review/ReviewComment/IssueComment-on-
  PR/PR-opened/closed-merged); `IssueCommentEvent` kept only when `payload.issue.
  pull_request` present (plain-issue comment dropped); `PushEvent` dropped; actor-absent
  event dropped **and counted** (dropped-recognized counter increments); **`ActorIsBot`
  tagging** (`[bot]` suffix + allowlist; `Copilot` → bot); **event-`id` dedup** collapses
  a re-emitted duplicate (same event id) but **keeps two distinct same-actor/verb/PR
  events with different ids** (e.g. two separate reviews hours apart — must NOT collapse);
  24h windowing; sort; returns up to `MaxRawItems` (no server cap to 12).
- **Reader** (mocked `HttpClient`): received_events shape parsing; PR-number extraction
  per type; 429 / 403 → empty + degraded.
- **Endpoint:** 200 happy; 200 degraded; no-token → empty + degraded; served behind
  session-auth middleware.
- **Hook** (vitest): poll cadence; error path; last-good retention.
- **Rail** (vitest): actor phrasing render; empty-state copy; degraded note distinct
  from empty; in-app link parse (valid GitHub PR URL → `/pr/…` Link; malformed → safe
  external fallback, no throw); **bot toggle defaults to hidden, reveals `ActorIsBot`
  items client-side and re-caps to 12** (transient `useState`, no preference read/write).
- **Settings toggle:** reflects + writes `inbox.showActivityRail`.
- **e2e:** rail visual baseline with real-shaped fake data via a Test-env activity fake
  seam mirroring `PRISM_E2E_FAKE_REVIEW` (`ASPNETCORE_ENVIRONMENT=Test`). **Prefer the
  DI-swap model** — register a fake `IActivityProvider` under the `PRISM_E2E_FAKE_REVIEW`
  guard (as `FakeReviewBackingStore` swaps the review services) — over a test-only HTTP
  route, because the DI swap never exposes an HTTP surface that could inject arbitrary
  actor logins / PR URLs in production. If a seeding route is unavoidable it must live
  inside `MapTestEndpoints` under the same env-guard, with a negative test mirroring
  `TestEndpoints_NotRegisteredInProduction_404`. Final seam shape is a planning artifact
  (§ Deferred to plan). Baselines regenerated after owner B1.

## P1 acceptance criteria

- [ ] Activity panel renders real `received_events` (PR-anchored type set: reviewed /
      commented / opened / closed / merged), actor + verb + PR ref + relative time;
      items open the PR in-app.
- [ ] Within-feed dedup collapses **re-emitted duplicates by event `id`** while keeping
      genuinely distinct same-actor events; no "pushed" verb (confirmed unavailable).
- [ ] In-rail bot toggle (**default hidden**) reveals `[bot]`/known-bot actors
      client-side and re-caps to 12; transient `useState`, **not** persisted.
- [ ] Watching `<section>` not rendered; loading skeleton shows a single panel.
- [ ] Empty state reads "No pull-request activity in the last 24h"; degraded note is
      visually distinct from empty.
- [ ] Settings → Inbox "Show activity rail" toggle present + wired, static narrow-window
      sub-label.
- [ ] `/api/activity` behind existing session-auth middleware; no server cache in P1.
- [ ] Classic `repo` covers received_events (verified live); FG Events:read documented +
      graceful-degrade.
- [ ] `activityData.ts` mock deleted; affected unit + e2e tests updated.
- [ ] Activity / inbox isolation: an activity-source failure does not break the inbox.

## P1 → P2 gate (keep decision)

After ~1–2 weeks of Phase 1 dogfooding, the owner makes a **qualitative keep / cut
self-assessment**: did the actor feed prove useful in practice? (PRism has no usage
telemetry; this is deliberately a judgment call, not a measured click rate — adding
analytics is out of scope.) **Keep → build Phase 2. Cut → stop here** (Phase 1 is
self-contained).

**The gate is pre-registered with a falsifiable CUT criterion, not just a keep
rationale** — written here, before Phase 1 ships, while incentives are neutral (the
self-assessor is also the builder; a post-build "did it prove useful?" is a sunk-cost
question otherwise):

- **CUT if:** over the active trial, the owner cannot recall a single concrete instance
  where an actor line **changed an action they took** (opened a PR from the rail they'd
  not have found via the inbox, re-reviewed because of a named reviewer's activity,
  etc.). A lightweight manual tally of rail-originated PR opens (not analytics) anchors
  this. "Interesting to glance at" is a cut, not a keep.
- **KEEP if:** the tally is non-trivial **and** the value wasn't an artifact of one
  unusually busy week.
- **Anti-false-cut guard (bounded):** distinguish *"genuinely valuable but my watched
  repos were quiet"* from *"the concept doesn't help"* — the "No pull-request activity
  in the last 24h" empty copy and the dropped-recognized debug counter both exist so a
  quiet *or* a silently-thinning feed doesn't masquerade as a useless one. If the watch
  graph was chronically quiet, the window may be widened **once** (e.g. to 72h) — **not
  open-endedly**, since "widen until it looks useful" is exactly how the initial
  dormant-watch-list false-negative was nearly rationalized into a keep.

---

# Phase 2 — notifications merge + Watching *(gated on the P1 keep decision)*

Phase 2 adds the second Activity source and the Watching panel. All merge-engine
correctness lives here — it only exists once two feeds combine.

## P2 backend

### New readers (`PRism.GitHub/Activity/`)

- `INotificationsReader.ReadAsync(since, ct) → IReadOnlyList<RawNotification>`
- `IWatchedReposReader.ReadAsync(ct) → IReadOnlyList<string>`

Both fault-isolated → empty + `Degraded.Notifications` / `Degraded.Watching`. The
degradation record and `ActivityResponse` grow additively (see § Contracts).

### Builder — full multi-source form

Insert between normalize and cap:

1. **Normalize** PullRequest-subject notifications → `ActivityItem` (`Verb` from
   `reason`, `Repo`, `PrNumber` from `subject.url` `…/pulls/{n}`, `Title`, `Url`,
   `Timestamp = updated_at`, `Source = Notification`, `ActorLogin = null`). Non-PR
   subjects dropped.
2. **Two-stage cross-feed merge** (this is the crux — the matching mechanism, not just
   the outcome):
   - **Stage A — group** all items by the actor-independent sub-key
     **`(Repo, PrNumber, Verb)`**.
   - **Stage B — within each group:** a null-actor notification **merges into the
     actor-bearing event** in that group (the merged item takes the **event's actor +
     avatar** and prefers the **notification's you-relevant framing** when its `reason`
     is `review-requested`/`mention`, else the event's). Two **distinct non-null
     actors** in a group stay **separate items** (the actor detail is the payoff and is
     never collapsed). **3-way case** (one null notification + ≥2 distinct-actor
     events): if the notification's `reason` is **genuinely you-relevant**
     (`review_requested`/`mention`), it stays its **own actorless row** rather than
     merging — the "you were asked / mentioned" meaning is actor-independent and must
     not be bound to whichever actor happened to act last. Only a **non-you-relevant
     duplicate** notification merges, and then into the **most-recent** matching event
     by `Timestamp`; the others remain separate.
   - Note: the merge only fires when the verb matches on both sides. A notification
     whose `reason` maps to a verb with no event counterpart (e.g. `subscribed` →
     `Other`) will **not** merge with a concrete-verb event for the same PR — by design
     it stays a separate "you're subscribed" line. The `reason`→verb table (deferred to
     plan) must map the common you-relevant reasons (`review_requested`, `mention`,
     `comment`, `state_change`) to the **same verbs the event side produces** so real
     duplicates collapse; `subscribed`/unknown → `Other`.
3. **Priority-merge / cap (`MaxActivityItems` = 12).** Sort each tier by `Timestamp`
   desc. **Reserve `MinEventSlots` (4) for event-sourced items:** fill up to
   `MaxActivityItems - MinEventSlots` (8) with notification items, then the remainder
   with event items, then backfill unused reserved slots with leftover notifications.
   A notification flood can no longer starve every actor line.
4. **Watching.** From `/user/subscriptions`; `Count` = windowed (24h) merged items
   touching the repo, **computed BEFORE the cap** (so a repo above the 12-item cap
   never wrongly shows `idle`). Sort by `Count` desc then name; `Count > 0` first,
   padding with `idle` watched repos up to `MaxWatchingRows` (8). `Url` =
   `https://{host}/{repo}`.

### Endpoint cache + identity-change invalidation

P2 adds a **single process-lifetime `ActivityResponse` behind a ~60s TTL**, held as an
instance field on the singleton `IActivityProvider`. **Not keyed by token** — PRism is
single-user (the `Func<Task<string?>>` token reader prevents stale-token capture). This
avoids storing the PAT as a heap key and bounds cost to **≤3 GitHub calls / 60s**.
**Identity change must invalidate it:** `IActivityProvider` exposes `Reset()`, wired
into the `/api/auth/replace` flow alongside the existing `activePrCache.Clear()` /
`activeRegistry.RemoveAll()` — otherwise the new identity could be served the prior
identity's feed data for up to 60s. **Two wiring decisions for the plan:**
- **Same-login token rotation.** The existing reset block fires **only when
  `identityChanged`** (`priorLogin != newLogin`). Rotating to a *different PAT for the
  same login* (e.g. after revoking a leaked token whose `repo` access has since been
  narrowed) leaves `identityChanged == false`, so the activity cache — like the PR
  cache today — would serve the old token's (possibly broader-scope, private-repo) feed
  for up to 60s. Because the activity feed surfaces **private-repo events whose
  visibility depends on current token scope**, the plan should call `Reset()` on
  **every successful `/api/auth/replace` commit**, not only the login-change branch (or
  explicitly accept and document the 60s window). This is a stronger requirement than
  the PR cache's current policy and is called out deliberately.
- **Subscribe vs. imperative call.** The same `identityChanged` block already publishes
  an in-process `IdentityChanged` bus message. The plan should weigh having
  `IActivityProvider` **subscribe** to that message over adding a fourth manual call —
  subscription co-locates invalidation with the other reset consumers and prevents a
  future identity-reset path from silently missing the activity cache.

## P2 frontend

- **Actorless verb phrasing:** notifications carry no actor, so each verb gains a second
  **actor-absent template** (subject-first): "Review requested on #1842", "You were
  mentioned in #1810", "New comment on #1827". An actorless row never renders as a
  dangling fragment.
- **Watching panel:** re-introduce the `<section>` (and the second `InboxSkeleton` rail
  block) — repo + `count`, or muted `idle` at 0.
- **Routing:** notification `Url`s may be non-PR shapes; the in-app-vs-external split,
  external-link icon, and `aria-label` "opens on GitHub" gain their full treatment here.
- **Degraded note:** unchanged single generic note, now covering all three sources.

## P2 PAT scopes

- **Classic:** `repo` covers `/notifications` and `/user/subscriptions`. No new scope.
- **Fine-grained:** + **Notifications: read**, **Metadata: read**. Documented; missing →
  graceful degrade.

## P2 testing (TDD red → green) — merge-engine correctness

- Notifications normalize; non-PullRequest subjects dropped.
- **Two-stage merge:** notification + event, same `(Repo,PrNumber,Verb)` → **one** item
  keeping the event's actor AND the notification's you-relevant framing.
- **Distinct actors:** two different actors, same PR + verb → **two** items.
- **3-way:** one notification + two distinct-actor events → notification merges into the
  most-recent event; the other stays separate.
- **No-counterpart reason:** `subscribed`→`Other` does not merge with a `Closed` event
  for the same PR (stays two items). (Uses a real verb — there is no `Pushed` event;
  see § Scope.)
- **Cap:** 20 notifications + 5 events → **≥ `MinEventSlots` (4)** event items survive.
- Watching count computed pre-cap; idle ordering + padding.
- Cache invalidated on `identityChanged` (no cross-identity data within TTL).
- Degradation aggregation across three sources.
- Reader tests (mocked `HttpClient`) for notifications + subscriptions; 429/403 → empty
  + degraded.
- Rail: actorless phrasing; Watching panel render; external-routing affordance.
- e2e: rail baseline updated for two-source feed + Watching. **Pre-commit the updated
  baselines in the P2 PR** (adding Watching is an intentional layout change, not a
  regression) so reviewers don't see a wall of false-positive snapshot diffs.

## P2 acceptance criteria

- [ ] Activity panel renders merged notifications + received_events (24h), with actor-
      present and actor-absent phrasing both correct.
- [ ] Merge engine passes all § P2 testing merge cases (two-stage merge, distinct
      actors, 3-way, no-counterpart, slot reservation).
- [ ] Watching panel renders real `/user/subscriptions` repos; `count` = in-window
      (pre-cap) feed items; `idle` at 0.
- [ ] `ActivityResponse` / `ActivityDegradation` grown additively; cache invalidated on
      identity change.
- [ ] Classic `repo` covers notifications + subscriptions (verified live); FG
      Notifications/Metadata read documented + graceful-degrade.

---

## Error handling & fault isolation *(shared)*

- Per-reader try/catch → empty + degradation flag; 429 / 403 fault-isolated.
- Builder never throws on unknown reason/type (P1 drops; P2 → `Other`).
- Endpoint never 500s on partial/total failure; 200 with `Degraded`.
- The rail is fully isolated from the inbox (separate endpoint + hook) — an activity
  failure can never break the inbox list.

## Constants *(shared)*

- Activity window: **24h** (matches the existing "last 24h" label). Not configurable.
  Both `24h` and `MaxActivityItems = 12` are **provisional** — they are inherited from
  the mock's copy, not derived from the feed's freshness. Given the 30s–6h source lag
  and a weekend/part-time gap (Mon morning could show an empty rail despite relevant
  Fri activity), the P1 trial is also the test of whether 24h is wide enough; revisit
  both after the keep decision rather than treating them as fixed.
- `MaxActivityItems` = 12 (**visible cap, applied client-side after bot-filter**);
  `MaxRawItems` ≈ 50 (server returns the deduped 24h set up to this so the client can
  filter + re-cap without gaps); `MinEventSlots` (P2) = 4; `MaxWatchingRows` (P2) = 8
  (≈ the rail's per-viewport row capacity at standard density; an arbitrary bound on an
  unbounded watched-repo list, revisit in P2 UX polish).
- Poll cadence: ~90s client. Server TTL cache (~60s) is **P2 only**.

## Out of scope / deferred *(shared)*

- AI-gate decoupling (#309).
- Non-PR notification subjects (`ci_activity` / CheckSuite, Issue, Discussion, Release,
  Commit) — v1 is PR-anchored.
- Cause-specific degradation messaging (`DegradationCause` enum, "grant access" hint).
- A per-item staleness qualifier or a `GeneratedAt` "last updated N min ago" footer.
- Usage telemetry / click instrumentation for the keep decision.
- Configurable activity window; real-time SSE push (poll-only by decision).
- Marking notifications read / acting on threads from the rail.

## Deferred to plan *(shared)*

- Exact shape of the e2e activity fake seam (env flag vs. fake reader DI vs. test-only
  route; must inherit the Test-env guard).
- The exact event-`type`→`ActivityVerb` (P1, beyond the table above) and
  `reason`→`ActivityVerb` (P2) maps — with the P2 constraint that you-relevant reasons
  map to the same verbs the event side produces, so real cross-feed duplicates collapse.
