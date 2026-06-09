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

### Why a rail, and not just more inbox columns

The inbox sections (`review-requested`, `awaiting-author`, `authored-by-me`,
`mentioned`, `recently-closed`) and the CI-failing filter already surface *which PRs
need me*. A rail that merely re-listed those PRs one column over would be redundant.
The rail's **distinct** value is the one thing the inbox does not carry: **actor
attribution on activity** — *who* pushed / commented / opened, drawn from
received_events. Notifications contribute the "and why it reached me" reason framing.
The design therefore optimizes for keeping actor-bearing items visible (see the
priority-merge slot reservation), because that is the rail's reason to exist. This is
an accepted owner decision (the alternative — deriving the rail from the inbox with no
new API — was considered and rejected in brainstorming).

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
  (`PRism.GitHub/Inbox/`), each fault-isolated and individually testable. The
  existing adapters key their caches on **data identity** (e.g. `PrReference` +
  `HeadSha`), not on the token — this spec follows that precedent.
- The inbox refresh pipeline (`IInboxRefreshOrchestrator` + SSE + polling) is
  **deliberately not reused** — see § Architecture decision.

## Data sources (decided)

| Panel | GitHub API | Carries | Freshness | Classic scope | Fine-grained permission |
|---|---|---|---|---|---|
| Activity | `GET /notifications` | subject (PR/issue/…), `reason`, repo, `updated_at` — **no actor** | fresh | `repo` (already required) | Notifications: read |
| Activity | `GET /received_events` (auth as self) | `actor`, event `type`, repo, payload, `created_at` — **carries actor**; private events included when authed as self | **laggy: 30s–6h** | `repo` (already required) | Events: read |
| Watching | `GET /user/subscriptions` | watched repos (full names) | n/a | `repo` (already required) | Metadata: read |

The "Classic scope" column is uniform: the `repo` scope PRism **already requires**
covers all three endpoints (the notifications endpoint doc: calls "require the
`notifications` **or** `repo` scopes"; the events/subscriptions endpoints work with
any authenticated token, and `repo` grants the private-repo visibility the user
expects). **No new classic scope** — this is the recommended/primary token type and
is verified live (acceptance criterion). The fine-grained column is the only place a
new permission appears; the exact FG permission set is confirmed empirically during
implementation (FG is a discouraged token type — see § PAT scopes).

The two Activity feeds are **complementary, not redundant**: notifications give
"what happened to a thing I care about + why" but no actor; received_events give
"who did what" but lag and are watch-feed-scoped. Merging them recreates the mock's
mix (`amelia.cho pushed iter 3` ← event; `requested your review on #1842` ←
notification).

**received_events staleness is an accepted, documented tradeoff.** Each item renders
its own relative timestamp (`5h ago`), which is the per-item age cue, so a stale
event line is self-labeling. The priority-merge keeps fresh notification items on top
without burying them; ordering is **priority-then-time, not strictly chronological**
across the notification/event tiers (accepted — no visual separator added; the
per-item timestamp is sufficient).

## Architecture decision — dedicated endpoint, isolated from the inbox

Activity is sourced, scoped, and timed independently of the inbox sections (three
different APIs, three different failure modes, a feed that lags hours vs. an inbox
that refreshes fast). Folding it into the inbox orchestrator/snapshot/SSE would
couple unrelated domains and risk a notifications failure tainting the inbox.
**Decision:** a standalone `GET /api/activity` with its own poll loop. Rejected
alternatives: fold-into-inbox-snapshot (coupling, shared failure); notifications-only
(loses actor + real watch list — contradicts the chosen combination).

## Scope of items — PR-anchored only (v1)

Every Activity item is **anchored to a pull request** in v1. Notification subjects
whose `subject.type` is not `PullRequest` (Issue, Discussion, Release, CheckSuite /
`ci_activity`, Commit) are **dropped** for v1, and only PR-related received_events
types are normalized. Rationale: it keeps every row clickable to a real PR, keeps the
dedup key unambiguous (always a real PR number — an Issue #5 and a PR #5 never
collide), and matches the rail's PR-review purpose. Non-PR subjects (notably
`ci_activity`) are listed in § Out of scope as a deferred extension.

## Backend design

### Contracts (`PRism.Core/Activity/`)

```
public enum ActivitySource { Notification, ReceivedEvent }   // wire: kebab-case
public enum ActivityVerb {                                    // wire: kebab-case
  Pushed, ForcePushed, Opened, Commented, Reviewed,
  ReviewRequested, Mentioned, Closed, Merged, Other
}

public sealed record ActivityItem(
  string? ActorLogin, string? ActorAvatarUrl,
  ActivityVerb Verb, string Repo,
  int PrNumber, string? Title, string Url,
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
event `type` (forward-compatible; never throw on an unknown kind). `PrNumber` is
non-nullable because every v1 item is PR-anchored (see § Scope of items).
`ActivityDegradation` is **deliberately boolean per source — no cause enum**: the
frontend shows a single generic degraded note regardless of cause (see § Frontend
states for why a cause distinction was rejected).

### Readers (`PRism.GitHub/Activity/`)

Three small adapters behind `PRism.Core/Activity/` interfaces, mirroring the
`Inbox/` adapters:

- `INotificationsReader.ReadAsync(since, ct) → IReadOnlyList<RawNotification>`
- `IReceivedEventsReader.ReadAsync(ct) → IReadOnlyList<RawReceivedEvent>`
- `IWatchedReposReader.ReadAsync(ct) → IReadOnlyList<string>`

**Fault isolation (hard requirement):** each reader catches transport / 429 / 403
(missing-permission) / cancellation-adjacent failures and returns **empty + sets its
degradation flag** — it never throws out of the builder. This mirrors the
`GitHubCiFailingDetector` 429-fault-isolation pattern (#286 / #262). A single failing
source must not blank the whole rail.

### Builder (`PRism.Core/Activity/ActivityFeedBuilder`)

Pure composition over the three reader outputs — no I/O, unit-testable with fakes:

1. **Normalize** each PR-anchored notification and each PR-related received-event into
   an `ActivityItem`.
   - Notification (only `subject.type == "PullRequest"`) →
     `{ Verb from reason, Repo, PrNumber parsed from subject.url
     (`…/pulls/{n}`), Title, Url, Timestamp = updated_at, Source = Notification,
     Actor = null }`. Non-PullRequest subjects are dropped here.
   - Received-event (PR-related types only) → `{ Verb from type+payload, Actor from
     actor, Repo, PrNumber from payload, Url, Timestamp = created_at,
     Source = ReceivedEvent }`.
   - `reason`→verb and `type`→verb maps are explicit tables; unmapped → `Other`.
2. **Window** to the last 24h (drop older).
3. **Dedup / merge across feeds.** The dedup key is **`(Repo, PrNumber, Verb,
   ActorLogin)`** (`Verb` *is* the "coarse verb" — the normalized enum value, not the
   raw reason/type). Consequences, all tested:
   - Two **different** actors doing the same verb on the same PR have **different**
     `ActorLogin` → they remain **two items** (the actor detail is the payoff; it is
     never collapsed away).
   - A notification (`ActorLogin == null`) and an event (`ActorLogin == X`) for the
     same `(Repo, PrNumber, Verb)` are recognized as the **same logical event seen in
     both feeds** and **merged into one** item: take the **actor + avatar from the
     event** and the **reason framing/Timestamp source preference from the
     notification when its reason is you-relevant** (`review-requested`, `mention`),
     else keep the event's. The merged item therefore has *both* the actor and the
     you-relevant framing — neither is discarded.
4. **Priority-merge / cap (`MaxActivityItems` = 12).** Sort each tier by `Timestamp`
   desc. To guarantee the actor-bearing payoff survives on busy accounts, **reserve a
   minimum of `MinEventSlots` (4) slots for event-sourced items**: fill up to
   `MaxActivityItems - MinEventSlots` (8) with notification items, then fill the
   remainder with event items, then backfill any unused reserved slots with leftover
   notifications. A flood of notifications can no longer starve every actor line.
5. **Watching.** Start from `/user/subscriptions`. `Count` = number of **windowed
   (24h) merged items touching the repo, computed BEFORE the `MaxActivityItems` cap**
   — so a repo with real recent activity never shows `idle` merely because its items
   fell below the 12-item display cap. Sort by `Count` desc, then repo name; show
   repos with `Count > 0` first, padding with `idle` (`Count == 0`) watched repos up
   to `MaxWatchingRows` (8). `Url` = `https://{host}/{repo}`.
6. Aggregate per-source degradation flags into `ActivityDegradation`.

### Endpoint (`PRism.Web/Endpoints/ActivityEndpoints.cs`)

`GET /api/activity` → `IActivityProvider.GetActivityAsync(ct)` → `ActivityResponse`.
No orchestrator.

- **Auth:** served through the existing middleware pipeline (`SessionTokenMiddleware`,
  `OriginCheckMiddleware`, and — in sidecar mode — `HostHeaderCheckMiddleware`),
  identical to every other `/api/*` endpoint. It requires a valid `prism-session`
  token; it is **not** a new unauthenticated surface.
- **Cache:** a single process-lifetime `ActivityResponse` behind a ~60s TTL, held as
  an instance field on the singleton `IActivityProvider`. **Not keyed by token** —
  PRism is single-user with one token per process lifetime (the `Func<Task<string?>>`
  token reader already prevents stale-token capture; a token swap self-heals within
  the ≤60s TTL). This avoids storing the PAT as a heap dictionary key and bounds the
  rate-limit cost to **at most 3 GitHub calls per 60s** regardless of poll volume.
- **Failure shape:** **always returns 200** — partial failure surfaces via `Degraded`;
  total failure surfaces as empty lists + all-true `Degraded` (never 500). No token
  (e.g. token revoked after enabling the rail) → empty + all-true `Degraded`; the
  primary gate is the frontend (toggle off → no fetch) and the auth pipeline
  (Settings is unreachable without a token), so this is a backstop path.

DI wiring in `PRism.GitHub/ServiceCollectionExtensions.cs` (readers) and the Web
composition root (provider + endpoint).

## Frontend design

### Hook — `frontend/src/hooks/useActivity.ts`

Fetches `/api/activity`; polls every **~90s**; **pauses while the tab is hidden**
(`visibilitychange`) and refetches on re-show. Retains last-good data across a failed
poll (does not flash to error on a transient blip). Exposes
`{ data, isLoading, error }`, following existing hook conventions
(`useEventSource` / `usePrDetail`). Subsequent polls are silent (no skeleton flash).

### `ActivityRail.tsx`

Consumes `useActivity` instead of the static import.

- **Verb phrasing — two templates per verb** (notifications carry no actor):
  - *actor present* → `{actor} {verbPhrase} {prRef}` — e.g. "amelia.cho pushed to #1842".
  - *actor absent* → a subject-first phrase — e.g. "Review requested on #1842",
    "You were mentioned in #1810", "New comment on #1827". Each verb defines **both**
    templates in the phrase map so an actorless row never renders as a dangling
    fragment.
- **Watching list:** repo + `count`, or muted `idle` at 0 (mirrors current markup).
- **Clickable items (in scope):** each item links to its PR. When `Url` parses to an
  owner/repo/number we can route to (reuse `parsePrRefFromPathname` logic), render a
  **router `<Link>`** (in-app). Otherwise render an **`<a>`** that opens the GitHub
  URL via the existing open-in-GitHub path (#131; desktop `setWindowOpenHandler`),
  with the same external-link icon used elsewhere and an `aria-label` that includes
  "opens on GitHub". Both paths are focusable and keyboard-activatable; a malformed
  URL falls back to external open and never throws.
- **States:**
  - *Loading* (first paint): existing `InboxSkeleton showRail` covers the page-level
    skeleton; the rail itself shows a lightweight per-section skeleton on its own
    first load.
  - *Empty:* `No recent activity` / `Nothing watched` (rail structure still shown —
    the user opted in via the toggle).
  - *Degraded:* a **single generic** inline note (`Some activity may be unavailable`),
    shown whenever any `Degraded` flag is true. **No cause-specific messaging and no
    "grant access" hint** — see rationale below.
  - *Error* (whole fetch failed and no last-good data): `Activity unavailable`;
    silent retry on next poll.
- **Rendering safety:** GitHub-supplied strings (`Title`, `ActorLogin`) render as
  text via React's default escaping — never `dangerouslySetInnerHTML`.
- Relative-time rendering **reuses the inbox row's existing relative-time formatter**
  (the same one behind the `12m ago` mock) so the rail and inbox stay consistent;
  only minutes/hours are needed given the 24h window.
- Delete `activityData.ts`; relocate the `ActivityItem` / `WatchedRepoActivity` TS
  types alongside the hook or in `api/types`.

**Why a single generic degraded note (cause distinction rejected):** the wire flag is
a plain boolean per source. Distinguishing "missing FG permission" from a 429 or a
transport error is unreliable — GitHub returns 403 for several causes and the
detection signal differs by token type. More importantly, a "grant notifications
access" hint would steer the user toward a **fine-grained** token, which PRism
deliberately discourages (FG can't call the Checks API — see § PAT scopes) and which
classic users never need (their `repo` scope already covers it). A generic note is
honest, simpler, and avoids pushing users onto a worse token type. Cause-specific
messaging is listed in § Out of scope.

## Settings toggle UI

Add a **"Show activity rail"** toggle under **Settings → Inbox**, bound to the
existing `inbox.showActivityRail` field (#309 created it config-only, default false).
Mirrors the existing `defaultSort` / `sectionOrder` inbox rows (same preferences
plumbing). A **static** sub-label reads **"Hidden on narrow windows."** (always
shown — the Settings panel does not branch on the current viewport). Turning it on,
with real data now backing the rail, is the user-facing completion of #309's
deferral.

## PAT scopes (acceptance criterion)

- **Classic PAT:** `repo` (already required by `RequiredScopes`) satisfies the
  `/notifications` endpoint (endpoint doc: "require the `notifications` **or** `repo`
  scopes"). `/user/subscriptions` and `/received_events` work with the authenticated
  token; `repo` provides private-repo visibility. **No new classic scope.**
  `RequiredScopes` is **not** modified (keeps this change off the reviewer-atomic /
  auth-validation logic surface). Because every classic token PRism accepts *must*
  already carry `repo`, no existing classic user can lack notifications access.
  Verified empirically with a live classic token during implementation.
- **Fine-grained PAT:** needs **Notifications: read** and **Events: read** (and
  Metadata: read for subscriptions) — confirmed empirically during implementation.
  PRism steers users to classic PATs (FG can't call the Checks API — documented
  limitation), so real-world impact is near-zero. **Decision:** document the FG
  permissions in the PAT guidance + **degrade gracefully** if missing (403 →
  degradation flag → generic note). **Do not** add blocking FG-scope validation —
  that would touch the auth-validation surface for a path most users never hit, and
  graceful-degrade already covers it.

Documentation touchpoints: PAT guidance copy (`#213` lineage) + any setup help that
enumerates scopes.

## Error handling & fault isolation (summary)

- Per-reader try/catch → empty + degradation flag; 429 / 403 fault-isolated.
- Builder never throws on unknown reason/type (→ `Other`).
- Endpoint never 500s on partial/total failure; 200 with `Degraded`.
- The rail is fully isolated from the inbox (separate endpoint + hook) — an activity
  failure can never break the inbox list.

## Testing strategy (TDD red → green)

**Backend (`PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`):**
- `ActivityFeedBuilder` unit tests with fake readers:
  - normalize maps; non-PullRequest notification subjects dropped.
  - **dedup: two different actors, same PR + verb → two items** (actor not collapsed).
  - **dedup: notification + event, same (Repo,PrNumber,Verb) → one merged item that
    keeps the event's actor AND the notification's you-relevant framing.**
  - 24h windowing.
  - **cap: 20 notifications + 5 events → at least `MinEventSlots` (4) event items
    survive** (notifications cannot starve actor lines).
  - Watching count computed pre-cap; idle ordering + padding.
  - degradation aggregation; unknown reason/type → `Other`.
- Reader tests with mocked `HttpClient`: notifications / events / subscriptions
  response-shape parsing; PR-number parse from `subject.url`; 429 → empty + degraded;
  403 → empty + degraded.
- Endpoint test: 200 happy shape; 200 degraded shape; no-token → empty + all-degraded;
  endpoint served behind the session-auth middleware.

**Frontend (`vitest`):**
- `useActivity`: poll cadence, error path, visibility-pause/resume, last-good
  retention on failed poll.
- `ActivityRail`: data render (actor / no-actor phrasing), empty, degraded (generic
  note), error.
- **Item link target parse function:** valid PR URL → in-app route; non-PR/foreign
  URL → external; malformed URL → external, no throw.
- Settings toggle: reflects + writes `inbox.showActivityRail`.

**e2e (Playwright):**
- Rail visual baseline with real-*shaped* fake data via a Test-env activity fake
  seam mirroring `PRISM_E2E_FAKE_REVIEW` (`ASPNETCORE_ENVIRONMENT=Test`). The exact
  seam shape (env flag / fake reader DI / test-only route) is a planning artifact —
  see § Deferred to plan. Visual baselines (linux-from-CI + win32-local) regenerated
  after owner B1 sign-off.

## Constants (fixed for v1)

- Activity window: **24h** (matches the existing "last 24h" label). Not configurable.
- `MaxActivityItems` = 12; `MinEventSlots` = 4; `MaxWatchingRows` = 8.
- Poll cadence: ~90s client; ~60s server TTL cache.

## Out of scope / deferred

- AI-gate decoupling (#309).
- Non-PR notification subjects (`ci_activity` / CheckSuite, Issue, Discussion,
  Release, Commit) — v1 is PR-anchored.
- Cause-specific degradation messaging (`DegradationCause` enum, "grant access" hint).
- A per-item staleness qualifier or a `GeneratedAt` "last updated N min ago" footer.
- Configurable activity window; real-time SSE push (poll-only by decision).
- Marking notifications read / acting on threads from the rail.

## Deferred to plan

- Exact shape of the e2e activity fake seam (new env flag vs. fake reader DI vs.
  test-only route).
- Exact `reason`→`ActivityVerb` and event-`type`→`ActivityVerb` mapping tables and
  the supported received_events `type` set (mechanical; resolved at implementation).

## Acceptance criteria (checkable)

- [ ] Activity panel renders real merged notifications + received_events (24h),
      PR-anchored, with actor-present and actor-absent phrasing both correct.
- [ ] Merge engine: distinct actors are not collapsed; cross-feed duplicates merge
      keeping actor + you-relevant framing; ≥`MinEventSlots` event items survive a
      notification flood.
- [ ] Watching panel renders real `/user/subscriptions` repos with `count` = in-window
      (pre-cap) feed items touching the repo; `idle` at 0.
- [ ] PAT scopes determined + documented: classic `repo` covered (verified live); FG
      Notifications/Events read documented + graceful-degrade on missing.
- [ ] Graceful empty / loading / degraded (generic note) / error states.
- [ ] Settings → Inbox "Show activity rail" toggle present and wired, with the static
      narrow-window sub-label.
- [ ] `/api/activity` served behind the existing session-auth middleware.
- [ ] `activityData.ts` mock deleted.
- [ ] Activity / inbox isolation: an activity-source failure does not break the inbox.

## Post-ship validation (owner, not a code gate)

Because the rail is a p3, default-off, single-user surface, "it renders" is not the
same as "it earned its place." After ~1–2 weeks of dogfooding, the owner decides
**keep / cut** based on whether the rail stays toggled on and gets clicked. This is an
explicit exit if the panel proves to be noise beside the inbox.
