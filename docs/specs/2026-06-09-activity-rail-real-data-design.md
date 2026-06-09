# Plumb real data into the Inbox Activity rail — design

**Issue:** [#137](https://github.com/prpande/PRism/issues/137)
**Date:** 2026-06-09
**Tier / Risk:** T3 (full — slice-sized, net-new behavior across backend adapters,
a core builder, a new endpoint, a frontend hook, the rail rewrite, and a Settings
control) — **gated B1** (`needs-design` label; the rail's rendered output a human
must eyeball) **and B2** (auth / PAT-scopes — new GitHub API surface; PAT-scope
determination is an acceptance criterion). Human gates apply; this is **not** a
hands-off run.

**Depends on:** [#309](https://github.com/prpande/PRism/pull/309)
(`feature/283-default-ai-preview-on`). #309 decouples the rail from the AI gate and
adds the `inbox.showActivityRail` config flag (Bool, **default false**, config-only —
#309 deliberately deferred the Settings UI "until the rail carries real data").
This branch is cut from #309's branch; #137 must land **after** #309 (or rebase onto
its merge commit).

## Goal

The Inbox right rail renders two panels — **Activity** and **Watching** — from a
hard-coded `activityData.ts` mock (`amelia.cho pushed iter 3 to #1842…`;
`platform/billing-svc 2 … idle`). Replace the mock with **real GitHub data**, with
graceful loading / empty / degraded states, and surface the now-real rail through a
**Settings toggle**. Determine and document the PAT scopes the new data requires.

Non-goal restatement: the AI-gate decoupling (issue AC #5) is delivered by #309 and
is **out of scope** here. #137 owns the *data* and the *Settings UI* #309 deferred.

## Background — what exists today

- `frontend/src/components/ActivityRail/ActivityRail.tsx` renders two `<section>`s
  from static arrays in `activityData.ts`:
  - `ActivityItem { who, what, pr, when, isSystem? }`
  - `WatchedRepo { repo, count }` — `count`'s meaning is currently **undefined**.
- The rail is rendered by `InboxPage.tsx`; after #309 it is gated on
  `preferences.inbox.showActivityRail` (not `useAiGate`). Responsive cutoff hides it
  under 1180px (`InboxPage.module.css`).
- **No** backend activity/feed endpoint exists. The GitHub client
  (`PRism.GitHub/GitHubReviewService*.cs`, `PRism.GitHub/Inbox/*`) calls only PR
  detail, timeline, search, content, and validation APIs — **no** events /
  notifications / subscriptions calls.
- Per-concern GitHub adapters already establish the pattern this spec follows:
  `GitHubCiFailingDetector`, `GitHubPrEnricher`, `GitHubSectionQueryRunner`
  (`PRism.GitHub/Inbox/`), each fault-isolated and individually testable.
- The inbox refresh pipeline (`IInboxRefreshOrchestrator` + SSE + polling) is
  **deliberately not reused** — see § Architecture decision.

## Data sources (decided)

| Panel | GitHub API | Carries | Freshness | Classic scope | FG permission |
|---|---|---|---|---|---|
| Activity | `GET /notifications` | subject (PR/issue), `reason`, repo, `updated_at` — **no actor** | fresh | `repo` ✅ (already required) | Notifications: read |
| Activity | `GET /received_events` (auth as self) | `actor`, event `type`, repo, payload, `created_at` — **carries actor**; private events included when authed as self | **laggy: 30s–6h** | works with auth token; `repo` for private visibility | Events: read |
| Watching | `GET /user/subscriptions` | watched repos (full names) | n/a | works with auth token | Metadata: read *(verify)* |

The two Activity feeds are **complementary, not redundant**: notifications give
"what happened to a thing I care about + why" but no actor; received_events give
"who did what" but lag and are watch-feed-scoped. Merging them recreates the mock's
mix (`amelia.cho pushed iter 3` ← event; `replied to your comment` ← notification).

**received_events staleness is an accepted, documented tradeoff.** The priority-merge
(below) keeps fresh notification items on top, so event-sourced "who pushed" lines may
be stale by up to hours without burying time-critical review requests. The owner chose
the combination knowing the actor detail is the payoff.

## Architecture decision — dedicated endpoint, isolated from the inbox

Activity is sourced, scoped, and timed independently of the inbox sections (three
different APIs, three different failure modes, a feed that lags hours vs. an inbox
that refreshes fast). Folding it into the inbox orchestrator/snapshot/SSE would
couple unrelated domains and risk a notifications failure tainting the inbox.
**Decision:** a standalone `GET /api/activity` with its own poll loop. Rejected
alternatives: fold-into-inbox-snapshot (coupling, shared failure); notifications-only
(loses actor + real watch list — contradicts the chosen combination).

## Backend design

### Contracts (`PRism.Core/Activity/`)

```
public enum ActivitySource { Notification, ReceivedEvent }   // wire: kebab-case
public enum ActivityVerb {                                    // wire: kebab-case
  Pushed, ForcePushed, Opened, Commented, Reviewed,
  ReviewRequested, Mentioned, CiFailed, Closed, Merged, Other
}

public sealed record ActivityItem(
  string? ActorLogin, string? ActorAvatarUrl,
  ActivityVerb Verb, string Repo,
  int? PrNumber, string? Title, string Url,
  DateTimeOffset Timestamp, ActivitySource Source);

public sealed record WatchedRepoActivity(string Repo, int Count, string Url);

public sealed record ActivityDegradation(
  bool Notifications, bool ReceivedEvents, bool Watching);   // true = that source failed

public sealed record ActivityResponse(
  IReadOnlyList<ActivityItem> Items,
  IReadOnlyList<WatchedRepoActivity> Watching,
  DateTimeOffset GeneratedAt,
  ActivityDegradation Degraded);
```

Enums serialize kebab-case per the architectural-invariant (kebab-case enums).
`ActivityVerb.Other` is the lenient fallback for an unmapped notification `reason` /
event `type` (forward-compatible; never throw on an unknown kind).

### Readers (`PRism.GitHub/Activity/`)

Three small adapters behind `PRism.Core/Activity/` interfaces, mirroring the
`Inbox/` adapters:

- `INotificationsReader.ReadAsync(since, ct) → IReadOnlyList<RawNotification>`
- `IReceivedEventsReader.ReadAsync(ct) → IReadOnlyList<RawReceivedEvent>`
- `IWatchedReposReader.ReadAsync(ct) → IReadOnlyList<string>`

**Fault isolation (hard requirement):** each reader catches transport / 429 / 403
(missing-scope) / cancellation-adjacent failures and returns **empty + sets its
degradation flag** — it never throws out of the builder. This mirrors the
`GitHubCiFailingDetector` 429-fault-isolation pattern (#286 / #262). A single failing
source must not blank the whole rail.

### Builder (`PRism.Core/Activity/ActivityFeedBuilder`)

Pure composition over the three reader outputs — no I/O, unit-testable with fakes:

1. **Normalize** each notification and each received-event into an `ActivityItem`.
   - Notification → `{ Verb from reason, Repo, PrNumber from subject.url, Title,
     Url, Timestamp = updated_at, Source = Notification, Actor = null }`.
   - Received-event → `{ Verb from type+payload, Actor from actor, Repo, PrNumber
     from payload, Url, Timestamp = created_at, Source = ReceivedEvent }`.
   - `reason`→verb and `type`→verb maps are explicit tables; unmapped → `Other`.
2. **Window** to the last 24h (drop older).
3. **Dedup** by key `(Repo, PrNumber, coarse-verb)`. When a push appears in both
   feeds, collapse to one item, **preferring the notification framing when its reason
   is you-relevant** (`review-requested`, `mention`), else preferring the event
   (which carries the actor). Items without a `PrNumber` dedup on `(Repo, Url)`.
4. **Priority-merge / cap.** Notification-sourced items are **never dropped for
   capacity**; received-event items fill the remaining slots. Within each tier, sort
   by `Timestamp` desc. Cap at `MaxActivityItems` (12).
5. **Watching.** Start from `/user/subscriptions`. `Count` = number of windowed
   merged items whose `Repo` matches. Sort by `Count` desc, then repo name; show
   repos with `Count > 0` first, padding with `idle` (`Count == 0`) watched repos up
   to `MaxWatchingRows` (8). `Url` = `https://{host}/{repo}`.
6. Aggregate per-source degradation flags into `ActivityDegradation`.

### Endpoint (`PRism.Web/Endpoints/ActivityEndpoints.cs`)

`GET /api/activity` → `IActivityProvider.GetActivityAsync(ct)` → `ActivityResponse`.
No orchestrator. A small **~60s in-memory TTL cache keyed by token** absorbs
overlapping client polls (received_events lags 30s–6h, so sub-minute live calls are
pointless). **Always returns 200** — partial failure surfaces via `Degraded`, total
failure surfaces as empty lists + all-true `Degraded` (never 500). If **no token**
is configured (first-run), returns empty + `GeneratedAt` (the rail flag defaults
off anyway).

DI wiring in `PRism.GitHub/ServiceCollectionExtensions.cs` (readers) and the Web
composition root (provider + endpoint).

## Frontend design

### Hook — `frontend/src/hooks/useActivity.ts`

Fetches `/api/activity`; polls every **~90s**; **pauses while the tab is hidden**
(`visibilitychange`) and refetches on re-show. Exposes `{ data, isLoading, error }`,
following existing hook conventions (`useEventSource` / `usePrDetail`). Subsequent
polls are silent (no skeleton flash).

### `ActivityRail.tsx`

Consumes `useActivity` instead of the static import.

- **Activity list:** `actor` (when present; small avatar + login) + verb phrase +
  PR ref + relative time. A client `verb → phrase` map ("pushed", "commented on",
  "requested your review on", "marked CI failing on"). System-style items
  (`ci-failed`, no actor) keep the muted treatment the mock used.
- **Watching list:** repo + `count`, or muted `idle` at 0 (mirrors current markup).
- **Clickable items (in scope):** each activity item links to the PR — in-app route
  when the `Url` parses to an owner/repo/number we can route to, else the GitHub URL
  via the existing open-in-GitHub path (#131; desktop `setWindowOpenHandler`). A
  non-clickable feed is dead weight.
- **States:**
  - *Loading* (first paint): existing `InboxSkeleton showRail` covers the page-level
    skeleton; the rail itself shows a lightweight per-section skeleton on its own
    first load.
  - *Empty:* `No recent activity` / `Nothing watched` (rail structure still shown —
    the user opted in via the toggle).
  - *Degraded:* quiet inline note (`Some activity may be unavailable`). When the
    degradation is specifically a **missing FG-token permission**, show a one-line
    "Grant notifications access" hint linking to the existing PAT guidance
    (`PatPageLinkBuilder` / setup help).
  - *Error* (whole fetch failed): `Activity unavailable`; silent retry on next poll.
- Delete `activityData.ts`; relocate the `ActivityItem` / `WatchedRepoActivity` TS
  types alongside the hook or in `api/types`.

Relative-time rendering reuses any existing formatter; otherwise a tiny local
`timeAgo` (the mock rendered `12m ago`).

## Settings toggle UI

Add a **"Show activity rail"** toggle under **Settings → Inbox**, bound to the
existing `inbox.showActivityRail` field (#309 created it config-only, default false).
Mirrors the existing `defaultSort` / `sectionOrder` inbox rows (same preferences
plumbing). Copy notes it has no effect below 1180px (the rail is hidden there).
Turning it on with real data now backing the rail is the user-facing completion of
#309's deferral.

## PAT scopes (acceptance criterion)

- **Classic PAT:** `repo` (already required by `RequiredScopes`) satisfies the
  `/notifications` endpoint (the endpoint doc: "require the `notifications` **or**
  `repo` scopes"). `/user/subscriptions` and `/received_events` work with the
  authenticated token; `repo` provides private-repo visibility. **No new classic
  scope.** `RequiredScopes` is **not** modified (keeps this change off the
  reviewer-atomic / auth-validation logic surface). Verified empirically with a live
  classic token during implementation.
- **Fine-grained PAT:** needs **Notifications: read** (and **Events: read** for
  private received_events). PRism steers users to classic PATs (FG can't call the
  Checks API — documented limitation), so real-world impact is near-zero.
  **Decision:** document the FG permissions in the PAT guidance + **degrade
  gracefully** if missing (the 403 → degradation flag → "grant access" hint). **Do
  not** add blocking FG-scope validation — that would touch the auth-validation
  surface for a path most users never hit, and the graceful-degrade already covers it.

Documentation touchpoints: PAT guidance copy (`#213` lineage) + any setup help that
enumerates scopes.

## Error handling & fault isolation (summary)

- Per-reader try/catch → empty + degradation flag; 429 fault-isolated.
- Builder never throws on unknown reason/type (→ `Other`).
- Endpoint never 500s on partial/total failure; 200 with `Degraded`.
- The rail is fully isolated from the inbox (separate endpoint + hook) — an activity
  failure can never break the inbox list.

## Testing strategy (TDD red → green)

**Backend (`PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`):**
- `ActivityFeedBuilder` unit tests with fake readers: normalize maps, 24h windowing,
  dedup (cross-feed push collapse, framing preference), priority-merge (notification
  never dropped for capacity), caps, Watching count + idle + ordering + padding,
  degradation aggregation, unknown reason/type → `Other`.
- Reader tests with mocked `HttpClient`: notifications / events / subscriptions
  response-shape parsing; 429 → empty + degraded; 403 missing-scope → empty +
  degraded.
- Endpoint test: 200 happy shape; 200 degraded shape; no-token empty.

**Frontend (`vitest`):**
- `useActivity`: poll cadence, error path, visibility-pause/resume.
- `ActivityRail`: data render (actor / no-actor / system), empty, degraded (+ FG
  scope hint), error; item link targets (in-app vs GitHub).
- Settings toggle: reflects + writes `inbox.showActivityRail`.

**e2e (Playwright):**
- Rail visual baseline with real-*shaped* fake data via a Test-env activity fake
  seam mirroring `PRISM_E2E_FAKE_REVIEW` (`ASPNETCORE_ENVIRONMENT=Test`). Visual
  baselines (linux-from-CI + win32-local) regenerated after owner B1 sign-off.

## Constants (fixed for v1)

- Activity window: **24h** (matches the existing "last 24h" label). Not configurable.
- `MaxActivityItems` = 12; `MaxWatchingRows` = 8.
- Poll cadence: ~90s client; ~60s server TTL cache.

## Out of scope / deferred

- AI-gate decoupling (#309).
- Configurable activity window.
- Real-time SSE push for activity (poll-only by decision).
- Marking notifications read / acting on threads from the rail.
- Following-based feed tuning beyond the priority-merge.

## Acceptance criteria (checkable)

- [ ] Activity panel renders real merged notifications + received_events (24h).
- [ ] Watching panel renders real `/user/subscriptions` repos with `count` = in-window
      feed items touching the repo; `idle` at 0.
- [ ] PAT scopes determined + documented: classic `repo` covered (verified live); FG
      Notifications/Events read documented + graceful-degrade on missing.
- [ ] Graceful empty / loading / degraded / error states.
- [ ] Settings → Inbox "Show activity rail" toggle present and wired.
- [ ] `activityData.ts` mock deleted.
- [ ] Activity / inbox isolation: an activity-source failure does not break the inbox.
