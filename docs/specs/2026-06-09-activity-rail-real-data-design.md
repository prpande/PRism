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
received_events. That is why **Phase 1 ships the actor feed first** (see § Phasing):
it delivers the differentiating value at a fraction of the complexity, and proves the
rail earns its column before the rest is built.

## Phasing

The work splits into two independently-shippable PRs. **Phase 2 is gated on a Phase 1
keep decision** — the owner runs Phase 1 (default-off flag, opt-in) for ~1–2 weeks and
only proceeds to Phase 2 if the rail stays toggled on and gets used. This replaces a
post-hoc "was it worth it" check with a real go/no-go between the phases, and front-
loads the differentiating value while deferring the expensive merge machinery until
it's justified.

| | **Phase 1 — Activity (actor feed)** | **Phase 2 — merge + Watching** *(gated on Phase 1 keep)* |
|---|---|---|
| **Activity source** | `received_events` only (carries the actor) | + `notifications` merged in (fresh, you-relevant) |
| **Watching panel** | hidden (rail shows Activity only) | `/user/subscriptions` + count |
| **Merge engine** | trivial: one source → window → cap → sort | full: cross-feed dedup, actor-preserving merge, event-slot reservation |
| **Verb phrasing** | actor always present | + actorless templates (notifications carry no actor) |
| **New classic scope** | none (`repo` covers received_events) | none (`repo` covers notifications + subscriptions) |
| **New FG permission** | Events: read | + Notifications: read, Metadata: read |
| **Deliverable** | endpoint + hook + Activity panel + Settings toggle, mock deleted | notifications reader + subscriptions reader + Watching panel + merge correctness |

Each phase gets its own implementation plan (`writing-plans`) and its own B1 visual
sign-off. The sections below are tagged **[P1]**, **[P2]**, or **[shared]**.

## Background — what exists today *(shared)*

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

## Data sources *(shared)*

| Phase | Panel | GitHub API | Carries | Freshness | Classic scope | Fine-grained permission |
|---|---|---|---|---|---|---|
| P1 | Activity | `GET /received_events` (auth as self) | `actor`, event `type`, repo, payload, `created_at` — **carries actor**; private events included when authed as self | **laggy: 30s–6h** | `repo` (already required) | Events: read |
| P2 | Activity | `GET /notifications` | subject (PR/issue/…), `reason`, repo, `updated_at` — **no actor** | fresh | `repo` (already required) | Notifications: read |
| P2 | Watching | `GET /user/subscriptions` | watched repos (full names) | n/a | `repo` (already required) | Metadata: read |

The "Classic scope" column is uniform: the `repo` scope PRism **already requires**
covers all three endpoints (the notifications endpoint doc: calls "require the
`notifications` **or** `repo` scopes"; the events/subscriptions endpoints work with
any authenticated token, and `repo` grants the private-repo visibility the user
expects). **No new classic scope in either phase** — classic is the recommended token
type and is verified live (acceptance criterion). The fine-grained column is the only
place a new permission appears; the exact FG set per phase is confirmed empirically
during implementation.

**received_events staleness is an accepted, documented tradeoff** — and Phase 1 is the
deliberate test of whether it's tolerable. Each item renders its own relative
timestamp (`5h ago`), which is the per-item age cue, so a stale event line is self-
labeling. In Phase 2 the notification merge keeps fresh items on top; ordering is
**priority-then-time, not strictly chronological** across tiers (accepted — no visual
separator; the per-item timestamp is sufficient).

## Architecture decision — dedicated endpoint, isolated from the inbox *(shared)*

Activity is sourced, scoped, and timed independently of the inbox sections (different
APIs, different failure modes, a feed that lags hours vs. an inbox that refreshes
fast). Folding it into the inbox orchestrator/snapshot/SSE would couple unrelated
domains and risk a feed failure tainting the inbox. **Decision:** a standalone
`GET /api/activity` with its own poll loop. Rejected alternatives: fold-into-inbox-
snapshot (coupling, shared failure); notifications-only (loses the actor — the Phase 1
payoff).

## Scope of items — PR-anchored only (v1) *(shared)*

Every Activity item is **anchored to a pull request**. Received_events: only PR-related
event types are normalized. Notifications (P2): only `subject.type == "PullRequest"`
subjects are kept; Issue / Discussion / Release / CheckSuite (`ci_activity`) / Commit
subjects are **dropped**. Rationale: every row stays clickable to a real PR, the dedup
key is unambiguous (a real PR number — an Issue #5 and a PR #5 never collide), and it
matches the rail's PR-review purpose. Non-PR subjects (notably `ci_activity`) are
listed in § Out of scope as a deferred extension.

## Contracts *(shared — defined once; phases populate a subset)*

```
public enum ActivitySource { ReceivedEvent, Notification }   // wire: kebab-case (P1 emits ReceivedEvent only)
public enum ActivityVerb {                                    // wire: kebab-case
  Pushed, ForcePushed, Opened, Commented, Reviewed,
  ReviewRequested, Mentioned, Closed, Merged, Other
}

public sealed record ActivityItem(
  string? ActorLogin, string? ActorAvatarUrl,   // always set in P1; nullable for P2 notification items
  ActivityVerb Verb, string Repo,
  int PrNumber, string? Title, string Url,
  DateTimeOffset Timestamp, ActivitySource Source);

public sealed record WatchedRepoActivity(string Repo, int Count, string Url);   // P2

public sealed record ActivityDegradation(
  bool Notifications, bool ReceivedEvents, bool Watching);   // true = that source failed; P1 only sets ReceivedEvents

public sealed record ActivityResponse(
  IReadOnlyList<ActivityItem> Items,
  IReadOnlyList<WatchedRepoActivity> Watching,   // empty in P1
  DateTimeOffset GeneratedAt,
  ActivityDegradation Degraded);
```

Enums serialize kebab-case per the architectural-invariant (kebab-case enums).
`ActivityVerb.Other` is the lenient fallback for an unmapped event `type` / notification
`reason` (forward-compatible; never throw on an unknown kind). `PrNumber` is
non-nullable because every item is PR-anchored. `ActivityDegradation` is
**deliberately boolean per source — no cause enum**: the frontend shows a single
generic degraded note regardless of cause (rationale in § Frontend states).

---

# Phase 1 — Activity (actor feed), received_events only

## P1 backend

### Reader (`PRism.GitHub/Activity/GitHubReceivedEventsReader`)

`IReceivedEventsReader.ReadAsync(ct) → IReadOnlyList<RawReceivedEvent>`, behind a
`PRism.Core/Activity/` interface, mirroring the `Inbox/` adapters. **Fault-isolated:**
catches transport / 429 / 403 / cancellation-adjacent failures, returns **empty + sets
`Degraded.ReceivedEvents`** — never throws (mirrors `GitHubCiFailingDetector`).

### Builder (`PRism.Core/Activity/ActivityFeedBuilder`) — single-source form

Pure, unit-testable with a fake reader. Phase 1 has **one** source, so the engine is
trivial — no cross-feed dedup, no slot reservation:

1. **Normalize** each PR-related received-event → `ActivityItem` (`Actor` from `actor`,
   `Repo`, `PrNumber` from payload, `Url`, `Timestamp = created_at`,
   `Source = ReceivedEvent`). Unmapped type → `Other`. Non-PR events dropped.
2. **Window** to the last 24h.
3. **Sort** by `Timestamp` desc; **cap** at `MaxActivityItems` (12).

(The structure leaves a clean seam for Phase 2 to insert the notification source +
dedup/merge/slot-reservation stages between normalize and cap.)

### Endpoint (`PRism.Web/Endpoints/ActivityEndpoints.cs`)

`GET /api/activity` → `IActivityProvider.GetActivityAsync(ct)` → `ActivityResponse`
(`Watching` empty in P1). No orchestrator.

- **Auth:** served through the existing middleware pipeline (`SessionTokenMiddleware`,
  `OriginCheckMiddleware`, and — sidecar mode — `HostHeaderCheckMiddleware`), identical
  to every other `/api/*` endpoint. Requires a valid `prism-session` token; **not** a
  new unauthenticated surface.
- **Cache:** a single process-lifetime `ActivityResponse` behind a ~60s TTL, held as an
  instance field on the singleton `IActivityProvider`. **Not keyed by token** — PRism
  is single-user with one token per process lifetime (the `Func<Task<string?>>` token
  reader prevents stale-token capture; a token swap self-heals within the ≤60s TTL).
  Avoids storing the PAT as a heap dictionary key and bounds the rate-limit cost to
  **≤1 GitHub call per 60s** in P1 (≤3 in P2).
- **Failure shape:** **always returns 200** — partial/total failure surfaces via
  `Degraded` + empty lists (never 500). No token (e.g. revoked after enabling) →
  empty + `Degraded.ReceivedEvents`; the primary gate is the frontend (toggle off → no
  fetch) and the auth pipeline (Settings is unreachable without a token).

DI wiring in `PRism.GitHub/ServiceCollectionExtensions.cs` (reader) and the Web
composition root (provider + endpoint).

## P1 frontend

### Hook — `frontend/src/hooks/useActivity.ts`

Fetches `/api/activity`; polls every **~90s**; **pauses while the tab is hidden**
(`visibilitychange`), refetches on re-show. Retains last-good data across a failed poll
(no error flash on a transient blip). Exposes `{ data, isLoading, error }`, following
`useEventSource` / `usePrDetail` conventions. Subsequent polls are silent.

### `ActivityRail.tsx`

Consumes `useActivity`; renders **only the Activity panel** in P1 (the Watching
`<section>` is removed until P2 — no faked panel).

- **Verb phrasing:** every P1 item has an actor → `{actor} {verbPhrase} {prRef}`
  ("amelia.cho pushed to #1842"), with a small avatar + login. (The actorless template
  set arrives in P2 with notifications.)
- **Clickable items (in scope):** each item links to its PR. When `Url` parses to an
  owner/repo/number we can route to (reuse `parsePrRefFromPathname` logic) → router
  `<Link>` (in-app). Otherwise an `<a>` opening the GitHub URL via the existing open-in-
  GitHub path (#131; desktop `setWindowOpenHandler`), with the shared external-link icon
  and an `aria-label` including "opens on GitHub". Both paths focusable + keyboard-
  activatable; a malformed URL falls back to external open and never throws.
- **States:**
  - *Loading* (first paint): existing `InboxSkeleton showRail` covers the page-level
    skeleton; the rail shows a lightweight per-section skeleton on its own first load.
  - *Empty:* `No recent activity` (rail structure still shown — the user opted in).
  - *Degraded / Error:* a **single generic** inline note (`Activity unavailable`),
    shown when the fetch fails (and no last-good data) or `Degraded.ReceivedEvents` is
    true. No cause-specific messaging (rationale below).
- **Rendering safety:** GitHub-supplied strings (`Title`, `ActorLogin`) render as text
  via React's default escaping — never `dangerouslySetInnerHTML`.
- Relative-time rendering **reuses the inbox row's existing relative-time formatter** so
  rail and inbox stay consistent (minutes/hours only given the 24h window).
- Delete `activityData.ts`; relocate the `ActivityItem` TS type alongside the hook or
  in `api/types`.

**Why a single generic degraded note (cause distinction rejected, shared P1+P2):** the
wire flag is boolean per source. Distinguishing "missing FG permission" from a 429 or a
transport error is unreliable — GitHub returns 403 for several causes and the detection
signal differs by token type. A "grant access" hint would also steer users toward a
**fine-grained** token, which PRism discourages (FG can't call the Checks API) and
classic users never need. A generic note is honest and simpler. Cause-specific
messaging is in § Out of scope.

## P1 Settings toggle UI

Add a **"Show activity rail"** toggle under **Settings → Inbox**, bound to the existing
`inbox.showActivityRail` field (#309 created it config-only, default false). Mirrors the
existing `defaultSort` / `sectionOrder` rows (same preferences plumbing). A **static**
sub-label reads **"Hidden on narrow windows."** (always shown — the panel does not
branch on viewport). Turning it on, with real data backing the rail, completes #309's
deferral.

## P1 PAT scopes

- **Classic:** `repo` (already required) — `/received_events` works with the
  authenticated token; `repo` grants private-repo visibility. **No new classic scope.**
  `RequiredScopes` unmodified (stays off the auth-validation surface). Verified live.
- **Fine-grained:** **Events: read** (confirmed empirically). Documented in PAT
  guidance; missing → graceful degrade (generic note), no blocking validation.

## P1 testing (TDD red → green)

- **Builder** (fake reader): normalize map; non-PR events dropped; 24h windowing; sort
  + cap; unknown type → `Other`.
- **Reader** (mocked `HttpClient`): received_events shape parsing; PR-number from
  payload; 429 / 403 → empty + degraded.
- **Endpoint:** 200 happy; 200 degraded; no-token → empty + degraded; served behind
  session-auth middleware.
- **Hook** (vitest): poll cadence; error path; visibility-pause/resume; last-good
  retention.
- **Rail** (vitest): data render (actor phrasing); empty; degraded note; item link
  parse (valid PR → in-app; non-PR/foreign → external; malformed → external, no throw).
- **Settings toggle:** reflects + writes `inbox.showActivityRail`.
- **e2e:** rail visual baseline with real-shaped fake data via a Test-env activity fake
  seam mirroring `PRISM_E2E_FAKE_REVIEW` (`ASPNETCORE_ENVIRONMENT=Test`). Seam shape is
  a planning artifact (§ Deferred to plan). Baselines regenerated after owner B1.

## P1 acceptance criteria

- [ ] Activity panel renders real `received_events`, PR-anchored, actor + verb + PR ref
      + relative time; items clickable.
- [ ] Watching `<section>` not rendered (no faked panel).
- [ ] Graceful empty / loading / degraded / error states (generic note).
- [ ] Settings → Inbox "Show activity rail" toggle present + wired, static narrow-window
      sub-label.
- [ ] `/api/activity` served behind existing session-auth middleware; cache not keyed
      by token.
- [ ] Classic `repo` covers received_events (verified live); FG Events:read documented +
      graceful-degrade.
- [ ] `activityData.ts` mock deleted.
- [ ] Activity / inbox isolation: an activity-source failure does not break the inbox.

## P1 → P2 gate (keep decision)

After ~1–2 weeks of Phase 1 dogfooding, the owner decides **keep / cut**: does the rail
stay toggled on and get clicked? **Keep → build Phase 2. Cut → stop here** (Phase 1 is
self-contained: real actor feed, mock deleted, toggle wired). This is the real go/no-go
that justifies Phase 2's merge complexity.

---

# Phase 2 — notifications merge + Watching *(gated on the P1 keep decision)*

Phase 2 adds the second Activity source and the Watching panel. All the merge-engine
correctness requirements live here, because they only exist once two feeds combine.

## P2 backend

### New readers (`PRism.GitHub/Activity/`)

- `INotificationsReader.ReadAsync(since, ct) → IReadOnlyList<RawNotification>`
- `IWatchedReposReader.ReadAsync(ct) → IReadOnlyList<string>`

Both fault-isolated → empty + `Degraded.Notifications` / `Degraded.Watching`.

### Builder — full multi-source form

Insert between normalize and cap:

1. **Normalize** PullRequest-subject notifications → `ActivityItem`
   (`Verb` from `reason`, `Repo`, `PrNumber` from `subject.url` `…/pulls/{n}`, `Title`,
   `Url`, `Timestamp = updated_at`, `Source = Notification`, `Actor = null`). Non-PR
   subjects dropped.
2. **Dedup / merge across feeds.** Dedup key = **`(Repo, PrNumber, Verb, ActorLogin)`**
   (`Verb` *is* the coarse verb — the normalized enum value). Consequences, all tested:
   - Two **different** actors, same PR + verb → different `ActorLogin` → **two items**
     (actor detail never collapsed — it's the payoff).
   - A notification (`ActorLogin == null`) and an event (`ActorLogin == X`) for the same
     `(Repo, PrNumber, Verb)` are the **same logical event in both feeds** → **merge
     into one**: take the **actor + avatar from the event** and prefer the
     **notification's you-relevant framing** (`review-requested`, `mention`) else the
     event's. The merged item keeps *both* actor and framing — neither discarded.
3. **Priority-merge / cap (`MaxActivityItems` = 12).** Sort each tier by `Timestamp`
   desc. **Reserve `MinEventSlots` (4) for event-sourced items:** fill up to
   `MaxActivityItems - MinEventSlots` (8) with notification items, then the remainder
   with event items, then backfill unused reserved slots with leftover notifications. A
   notification flood can no longer starve every actor line.
4. **Watching.** From `/user/subscriptions`; `Count` = windowed (24h) merged items
   touching the repo, **computed BEFORE the cap** (so a repo above the 12-item cap never
   wrongly shows `idle`). Sort by `Count` desc then name; `Count > 0` first, padding with
   `idle` watched repos up to `MaxWatchingRows` (8). `Url` = `https://{host}/{repo}`.

## P2 frontend

- **Actorless verb phrasing:** notifications carry no actor, so each verb gains a second
  **actor-absent template** (subject-first): "Review requested on #1842", "You were
  mentioned in #1810", "New comment on #1827". An actorless row never renders as a
  dangling fragment.
- **Watching panel:** re-introduce the `<section>` — repo + `count`, or muted `idle` at
  0 (mirrors the original markup).
- **Degraded note:** unchanged (single generic note), now covering all three sources.

## P2 PAT scopes

- **Classic:** `repo` covers `/notifications` and `/user/subscriptions`. No new scope.
- **Fine-grained:** + **Notifications: read**, **Metadata: read**. Documented; missing →
  graceful degrade.

## P2 testing (TDD red → green) — merge-engine correctness

- Notifications normalize; non-PullRequest subjects dropped.
- **Dedup: two different actors, same PR + verb → two items.**
- **Merge: notification + event, same `(Repo,PrNumber,Verb)` → one item keeping the
  event's actor AND the notification's you-relevant framing.**
- **Cap: 20 notifications + 5 events → ≥ `MinEventSlots` (4) event items survive.**
- Watching count computed pre-cap; idle ordering + padding.
- Degradation aggregation across three sources; unknown reason → `Other`.
- Reader tests (mocked `HttpClient`) for notifications + subscriptions; 429/403 → empty
  + degraded.
- Rail: actorless phrasing; Watching panel render.
- e2e: visual baseline updated for two-source feed + Watching; regenerated after owner B1.

## P2 acceptance criteria

- [ ] Activity panel renders merged notifications + received_events (24h), with actor-
      present and actor-absent phrasing both correct.
- [ ] Merge engine: distinct actors not collapsed; cross-feed duplicates merge keeping
      actor + you-relevant framing; ≥`MinEventSlots` event items survive a notification
      flood.
- [ ] Watching panel renders real `/user/subscriptions` repos with `count` = in-window
      (pre-cap) feed items; `idle` at 0.
- [ ] Classic `repo` covers notifications + subscriptions (verified live); FG
      Notifications/Metadata read documented + graceful-degrade.

---

## Error handling & fault isolation *(shared)*

- Per-reader try/catch → empty + degradation flag; 429 / 403 fault-isolated.
- Builder never throws on unknown reason/type (→ `Other`).
- Endpoint never 500s on partial/total failure; 200 with `Degraded`.
- The rail is fully isolated from the inbox (separate endpoint + hook) — an activity
  failure can never break the inbox list.

## Constants *(shared)*

- Activity window: **24h** (matches the existing "last 24h" label). Not configurable.
- `MaxActivityItems` = 12; `MinEventSlots` (P2) = 4; `MaxWatchingRows` (P2) = 8.
- Poll cadence: ~90s client; ~60s server TTL cache.

## Out of scope / deferred *(shared)*

- AI-gate decoupling (#309).
- Non-PR notification subjects (`ci_activity` / CheckSuite, Issue, Discussion, Release,
  Commit) — v1 is PR-anchored.
- Cause-specific degradation messaging (`DegradationCause` enum, "grant access" hint).
- A per-item staleness qualifier or a `GeneratedAt` "last updated N min ago" footer.
- Configurable activity window; real-time SSE push (poll-only by decision).
- Marking notifications read / acting on threads from the rail.

## Deferred to plan *(shared)*

- Exact shape of the e2e activity fake seam (env flag vs. fake reader DI vs. test-only
  route).
- Exact event-`type`→`ActivityVerb` (P1) and `reason`→`ActivityVerb` (P2) mapping tables
  and the supported received_events `type` set (mechanical; resolved at implementation).
