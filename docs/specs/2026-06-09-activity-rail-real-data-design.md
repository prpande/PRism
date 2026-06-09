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
| **Merge engine** | trivial: one source → window → sort → cap | full: two-stage cross-feed dedup, actor-preserving merge, event-slot reservation |
| **Verb phrasing** | actor always present | + actorless templates (notifications carry no actor) |
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

**[P1] received_events type set** (each yields a PR number, all carry an actor):

| Event type | → Verb | PR number from |
|---|---|---|
| `PullRequestEvent` action `opened`/`reopened` | Opened/Reopened | `payload.pull_request.number` |
| `PullRequestEvent` action `synchronize` | **Pushed** (new commits to the PR) | `payload.pull_request.number` |
| `PullRequestEvent` action `closed` | Closed / Merged (if `merged`) | `payload.pull_request.number` |
| `PullRequestReviewEvent` | Reviewed | `payload.pull_request.number` |
| `PullRequestReviewCommentEvent` | Commented | `payload.pull_request.number` |
| `IssueCommentEvent` **only when `payload.issue.pull_request` present** | Commented | `payload.issue.number` |

`PushEvent` is **excluded** — it references a branch/commits and carries **no PR
number**; the "pushed to a PR" signal comes from `PullRequestEvent` action
`synchronize` (which does carry the number). `IssueCommentEvent` on a plain issue
(no `pull_request` marker) is dropped. Any unmapped type → dropped (not `Other`, to
keep the feed PR-clean).

**[P2] notifications scope:** only `subject.type == "PullRequest"`; Issue / Discussion
/ Release / CheckSuite (`ci_activity`) / Commit subjects are **dropped**. Non-PR
subjects (notably `ci_activity`) are in § Out of scope as a deferred extension.

## Contracts *(phased — P1 ships only what P1 populates; P2 adds additively)*

```
// --- P1 ---
public enum ActivitySource { ReceivedEvent }                 // wire: kebab-case; P2 adds Notification
public enum ActivityVerb {                                    // wire: kebab-case; P1 emits a subset
  Opened, Reopened, Closed, Merged, Pushed, Reviewed, Commented, Other
}                                                             // P2 adds ReviewRequested, Mentioned

public sealed record ActivityItem(
  string? ActorLogin, string? ActorAvatarUrl,   // P1 always populates (events carry actor); nullable so P2 notifications fit
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

Pure, unit-testable with a fake reader. One source → no dedup, no slot reservation:

1. **Normalize** each event in the [P1] type set → `ActivityItem` (`ActorLogin` +
   `ActorAvatarUrl` from `actor`, `Verb` per the table, `Repo`, `PrNumber` from the
   payload field named in the table, `Url`, `Timestamp = created_at`,
   `Source = ReceivedEvent`). Events outside the set are dropped. **If `actor` is
   unexpectedly absent, drop the item** — this keeps the P1 guarantee that every
   emitted item has a non-null `ActorLogin`.
2. **Window** to the last 24h.
3. **Sort** by `Timestamp` desc; **cap** at `MaxActivityItems` (12).

The builder leaves a clean seam for Phase 2 to insert the notification source + the
dedup/merge/slot-reservation stages between normalize and cap.

### Endpoint (`PRism.Web/Endpoints/ActivityEndpoints.cs`)

`GET /api/activity` → `IActivityProvider.GetActivityAsync(ct)` → `ActivityResponse`.
No orchestrator.

- **Auth:** inherits the global middleware pipeline (`HostHeaderCheckMiddleware`,
  `OriginCheckMiddleware`, `SessionTokenMiddleware`) like every other `/api/*`
  endpoint — requires a valid `prism-session` token; **not** a new unauthenticated
  surface.
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
  (e.g. "amelia.cho pushed to #1842", "noah.s reviewed #1810"), with a small avatar +
  login. (Actorless templates arrive in P2 with notifications.)
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
  - *Loading* (first paint): `InboxSkeleton`'s rail must render a **single** panel in
    P1 (the existing skeleton draws two stacked blocks — parameterize it to one so the
    skeleton matches the one-panel P1 rail and there is no load-time collapse). The
    second block returns with Watching in P2.
  - *Empty:* **`No pull-request activity in the last 24h`** — names the window so a
    functional-but-quiet feed reads as working, not broken.
  - *Degraded / Error:* a single generic inline note **`Activity unavailable`**, shown
    when the fetch fails (and no last-good data) or `Degraded.ReceivedEvents` is true.
    It uses a **distinct treatment from the empty state** (a muted warning/alert style,
    not the same plain muted text) so "broken" and "quiet" are visually separable. No
    cause-specific messaging (rationale below).
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

- **Builder** (fake reader): the type→verb table incl. `synchronize`→Pushed and
  `closed`+merged→Merged; `IssueCommentEvent` kept only when `payload.issue.
  pull_request` present (plain-issue comment dropped); `PushEvent` dropped; actor-absent
  event dropped; 24h windowing; sort + cap.
- **Reader** (mocked `HttpClient`): received_events shape parsing; PR-number extraction
  per type; 429 / 403 → empty + degraded.
- **Endpoint:** 200 happy; 200 degraded; no-token → empty + degraded; served behind
  session-auth middleware.
- **Hook** (vitest): poll cadence; error path; last-good retention.
- **Rail** (vitest): actor phrasing render; empty-state copy; degraded note distinct
  from empty; in-app link parse (valid GitHub PR URL → `/pr/…` Link; malformed → safe
  external fallback, no throw).
- **Settings toggle:** reflects + writes `inbox.showActivityRail`.
- **e2e:** rail visual baseline with real-shaped fake data via a Test-env activity fake
  seam mirroring `PRISM_E2E_FAKE_REVIEW` (`ASPNETCORE_ENVIRONMENT=Test`). Seam shape is
  a planning artifact (§ Deferred to plan); if a test-only route, it inherits the same
  env-guard as `MapTestEndpoints`. Baselines regenerated after owner B1.

## P1 acceptance criteria

- [ ] Activity panel renders real `received_events` (PR-anchored type set), actor +
      verb + PR ref + relative time; items open the PR in-app.
- [ ] `synchronize`→"pushed" line works (the flagship signal) and carries the PR number.
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
self-contained). To avoid a biased "cut", the assessment must distinguish *"the feed
is genuinely valuable but my watched repos were quiet"* from *"the concept doesn't
help"* — the "No pull-request activity in the last 24h" empty copy exists precisely so
a quiet feed doesn't masquerade as a broken one. If the owner's watch graph is
chronically quiet over the trial, widening the dogfooding window (e.g. 72h) is a
cheaper diagnostic than cutting.

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
     events): the notification merges into the **most-recent** event by `Timestamp`;
     the others remain separate.
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
**Identity change must invalidate it:** `IActivityProvider` exposes `Reset()`, and the
`/api/auth/replace` `identityChanged` path calls it alongside the existing
`activePrCache.Clear()` / `activeRegistry.RemoveAll()` — otherwise the new identity
could be served the prior identity's feed data for up to 60s.

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
- **No-counterpart reason:** `subscribed`→`Other` does not merge with a `Pushed` event
  for the same PR (stays two items).
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
- `MaxActivityItems` = 12; `MinEventSlots` (P2) = 4; `MaxWatchingRows` (P2) = 8.
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
