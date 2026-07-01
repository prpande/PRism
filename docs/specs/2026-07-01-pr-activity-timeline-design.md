# PR Activity Timeline — unified Overview conversation feed

**Issue:** #620
**Status:** Design (awaiting human review)
**Date:** 2026-07-01

## Problem

The PR-detail **Overview** tab shows the AI summary, description, stats tiles, the root-level
conversation, and a "review files" CTA — but it conveys no sense of **what has happened on the PR
over time**: who reviewed, who approved or requested changes, who was requested as a reviewer,
when it was pushed to / reopened / marked ready. To reconstruct that, the user leaves PRism and
opens the PR on GitHub. We want that activity visible in Overview, in PRism's own design language.

Separately, today's Overview renders the root conversation (`PrRootConversation`) as its own card,
disconnected from any notion of PR events. Bolting a second, parallel "timeline" card next to it
would show two time-ordered lists side by side and force a boundary decision about which one owns
comment bodies. We instead **merge them**: one unified, chronological conversation-and-activity
feed.

## Goal

Replace the standalone root-conversation card with a single **unified Overview feed** — a vertical
timeline rail that interleaves **PR comments** (rendered as cards) and **review-relevant events**
(rendered as compact markers) in one newest-first stream, with the comment composer pinned at the
top. New activity (approvals, pushes, review requests) appears **live** via the SSE channel (which
requires widening the activity poller's emission gate — see Architecture).

## Scope

### In v1

1. A new per-PR, ordered, **timestamped**, paginated GraphQL read of the PR timeline.
2. A unified Overview feed component that **subsumes `PrRootConversation`**: composer at top, then a
   newest-first rail interleaving comment cards and event markers.
3. Reuse of the existing `ActivityVerb` vocabulary, `ActivityRail` row visual language, `knownBots`
   filtering, and the `PrRootConversation` comment/draft/composer flow.
4. Cursor-based "Show older activity" pagination (satisfies the #604 single-page-truncation class).
5. **Commit-run grouping** — a consecutive run of commit/push events coalesces into one group unit;
   runs longer than `COMMIT_GROUP_THRESHOLD` (5) render as an accordion collapsed by default, so a
   burst of frequent commits does not balloon the feed (see decision #8).
6. **Live-refresh** of new activity via SSE. Delivering it for reviews/approvals/review-requests
   requires **widening `ActivePrPoller`'s emission gate** (a reviewer/review-count delta, or a
   dedicated review-detected bus event) — a real backend change, not free wiring (see Architecture →
   Live-refresh). On a published frame for the active PR, the feed refetches its newest page and
   merges.

### Deferred to follow-ups (prioritized)

1. **Per-event streaming/append** — push and animate individual new events in place without a
   full newest-page refetch. This is the immediate next increment; it completes the "live" feel
   beyond the v1 refetch approach. Filed as the #1 follow-up.
2. **"New since last visit" unseen divider** — a visual marker delimiting events the user has not
   yet seen. Requires a new timeline-specific high-water (see "Seen-state" below); the existing
   head-SHA / comment-id anchors do not map to events.
3. **Comment density controls** — grouping/collapse for high-volume *comment* runs (v1 groups only
   commits). Add only if comment volume proves to hurt scannability on real PRs.

### Explicitly out of scope

- Mirroring GitHub's full 30+ timeline event types (labeled, milestoned, cross-referenced,
  assigned, renamed, deploys). We curate a reviewer-relevant subset.
- Any redesign of the file-tab inline review threads.

## Design decisions (resolved)

1. **Curate, don't mirror.** The event subset leans on the existing `ActivityVerb` set (below).
2. **Integrate, don't duplicate.** Rather than an event-markers-only timeline sitting beside the
   conversation (issue #620's design-decision #2), we merge comment bodies and events into one
   feed. This **supersedes** decision #2 — see "Deliberate deviation" below.
3. **Placement.** The unified feed card slots into the Overview grid **immediately after
   `StatsTiles`** (summary → description → stats → **unified feed** → review-files CTA), replacing
   the standalone `PrRootConversation` at its current position.
4. **Ordering — flat, newest-first by timestamp.** PR root comments are flat GitHub issue comments
   (`IssueCommentDto` has no `parentId`/`inReplyTo`; only file-tab review threads nest, and those are
   out of scope). The feed is therefore a single flat interleave of comments and events sorted
   newest-first by timestamp — no reply-block machinery. Same-timestamp ties break deterministically
   by a stable secondary key (GraphQL cursor position / event id) so ordering is stable across loads.
5. **Composer at top.** Pinned above the feed so adding a comment never requires scrolling past the
   entire history. Independent of ordering — the composer pins at top regardless of feed direction;
   the newest-first choice in #4 stands on its own.
6. **Bot noise.** Reuse `knownBots` + a "show bots" toggle, mirroring `ActivityRail`.
7. **Refresh.** Fetch-on-load + on-refresh + live-refresh (see Architecture → Live-refresh).
8. **Commit-run grouping.** A maximal run of *consecutive* commit/push events (adjacent in the feed,
   no comment/review/request between them) coalesces into one group unit. A run of ≤5 renders as a
   compact "pushed N commits" marker with the commits expandable inline; a run of >5
   (`COMMIT_GROUP_THRESHOLD`) renders as an accordion **collapsed by default** ("N commits", expand
   to the chronological list). Rationale: frequent automated commits (Claude-authored work) would
   otherwise flood the timeline with per-commit markers. Grouping is scoped to commits/pushes only —
   comments stay individually visible, since collapsing them would hide the conversation the feed
   exists to surface.

## Deliberate deviation from the issue

Issue #620 design-decision #2 recommended **event markers only, no re-rendered comment bodies**, to
avoid showing comment content twice. We intentionally supersede that: by **merging** the
conversation and the event timeline into a single feed, comment bodies live in exactly one place by
construction, and the duplication concern disappears without coordinating two components. This is
recorded here per the project's "document plan deviations durably" practice.

## Architecture

### Backend

**New per-PR timeline read.** The existing `IPrTimelineReader.ReadLatestAsync`
(`PRism.GitHub/Activity/GitHubPrTimelineReader.cs`) is a **batched, latest-only** read
(`timelineItems(last:1)`) that enriches inbox rows, and its `TimelineActor`
(`PRism.Core/Activity/IPrTimelineReader.cs:15`) carries **no timestamp**. This feature needs a
distinct read:

- A new method (e.g. `ReadPageAsync(prRef, cursor, pageSize, ct)`) returning an ordered, timestamped
  page plus a pagination cursor.
- GraphQL selection covering the curated subset: `ISSUE_COMMENT` (body + author),
  `PULL_REQUEST_REVIEW` (state + body + author), `REVIEW_REQUESTED_EVENT`,
  `PULL_REQUEST_COMMIT` (per-commit author/oid), `READY_FOR_REVIEW_EVENT`, `REOPENED_EVENT`,
  `CLOSED_EVENT`, `MERGED_EVENT`. Uses forward/backward `pageInfo` cursors — no unbounded single read
  (coordinates with #604).
- **`Opened` is not a `timelineItems` type** on GitHub — it is synthesized as the base (oldest) node
  of the feed from the PR node's `createdAt` + `author`, not fetched as an event.
- **`ReviewRequestRemoved` is out of v1 scope** (low review signal), so `REVIEW_REQUEST_REMOVED_EVENT`
  is deliberately not selected — keeping the fetched set and the rendered verb set aligned.
- `PULL_REQUEST_COMMIT` yields **one node per commit**; the "pushed N commits" grouping (decision #8)
  is computed client-side over consecutive commit nodes, not from a single push event.
- Extends the #598/#532 aliased-GraphQL layer; **no** REST fan-out.

**New event contract.** A `TimelineEvent` record carrying: `Verb` (`ActivityVerb`), actor
(`Login`, `AvatarUrl`, `IsBot`), `Timestamp`, and a verb-specific payload (e.g. commit count for
`Pushed`, requested reviewer for `ReviewRequested`, body for comments/reviews-with-body). Reuses the
`ActivityVerb` enum (`PRism.Core/Activity/ActivityContracts.cs`).

**Comments vs. event markers.** Top-level PR comments and **reviews that carry a body** render as
comment **cards** (they have substantive content). Bare state changes — approval with no body,
changes-requested with no body, pushes, review requests, ready/reopened/closed/merged — render as
one-line **markers**. **One review is one unit:** a review that is *both* an approval /
changes-requested *and* carries a body renders as a single card with the state glyph + verb lead
("approved" / "requested changes") on that same card — never a card plus a separate duplicate state
marker.

**Source of truth + freshness.** The feed's content comes from the new paginated timeline endpoint
(`ReadPageAsync`), **not** the `headSha`-keyed PR-detail snapshot that today backs `PrRootConversation`
(`prDetail.rootComments` in `OverviewTab.tsx`). Two consequences the design must honor:

- **The feed owns its own refetch.** On Overview load, on manual refresh, and after a successful
  comment-post, the frontend refetches the timeline's newest page. Because reviews/approvals are read
  live from the timeline endpoint, fetch-on-load already reflects them — `PrDetailLoader` snapshot
  invalidation is **not** the freshness mechanism for the feed. (Any residual `Invalidate(prRef)`
  need is only for other snapshot-derived Overview data — stats tiles, mergeability — i.e. existing
  behavior, not introduced here.)
- **De-duplication.** A just-posted comment must appear **exactly once**: the timeline refetch is the
  single render path; the composer does not separately append its own optimistic copy without
  reconciling against the refetched item by GitHub comment id.

**Live-refresh over SSE.** `SseChannel` (`PRism.Web/Sse/SseChannel.cs`) fans out a `pr-updated` frame
from `ActivePrUpdated`, which *carries* `Approvals` / `ChangesRequested` / `Approvers` name-lists
(#593) and which PR-detail already subscribes to for live mergeability (#655, `prDetailContext.tsx`).
**Verified constraint (`ActivePrPoller.cs:301`):** the frame is only *published* when
`firstPoll || headChanged || baseChanged || commentChanged || stateChanged || readinessChanged`. The
reviewer name-lists ride the frame but do **not** trigger it — so a bare approval that doesn't flip
merge-readiness, a review-request (touches only `AwaitingReviewers`), or a review-with-body (a
`PULL_REQUEST_REVIEW`, not an issue comment) publishes **nothing**. Live-refresh for the events this
feature exists to surface therefore requires **widening the poller's emission gate**: add a
`reviewersChanged` / `reviewCountChanged` delta comparison against prior state, **or** introduce a
dedicated review-detected bus event with its own publish site. This is a real, localized backend
change — v1 includes it. On a published frame for the active PR, the feed refetches its newest page
and merges (respecting the merge/scroll rules in *UI states & interactions*). No new SSE *stream* is
added in v1; per-event streaming is the #1 follow-up.

### Frontend

**New unified feed component** in `frontend/src/components/PrDetail/OverviewTab/`, wired into
`OverviewTab.tsx` in place of `PrRootConversation` (after `StatsTiles`). It:

- **Reuses** the composer + draft-comment + comment-post flow currently in `PrRootConversation`
  (moved/lifted, not rewritten). On a successful post it triggers a **timeline refetch** (not a
  snapshot `Invalidate`) so the new comment appears exactly once (see *Source of truth + freshness*).
- **Reuses** the `ActivityRail` `Row` visual vocabulary
  (`frontend/src/components/ActivityRail/ActivityRail.tsx:75`): `VERB_PHRASE` / `ACTORLESS_LEAD`
  verb→phrase maps, `Avatar`, the glyph/`NotifIcon` treatment, and `formatAge` relative time.
- Renders a **vertical rail (spine)** connecting nodes. Each node shows a **glyph** (verb-specific
  icon for events) or the author **avatar** (comments/actor events), plus **user id** and relative
  time — matching the current root-conversation and activity-rail look and feel.
- **Flat newest-first interleave** of comments and events (decision #4); consecutive commit runs are
  coalesced into a group / accordion (decision #8).
- Provides a **"Show older activity"** control that pages back via the cursor, and a **"show bots"**
  toggle.
- Subscribes to the published SSE frame for live-refresh.

**Wire types.** A new `TimelineFeed` response type in `frontend/src/api/types.ts` mirroring the
backend contract (verb kebab-case, matching `ActivityVerb`).

## Seen-state (why the unseen divider is deferred, not free)

PRism persists a per-PR anchor — last-viewed **head SHA** (`TabStamp`) and a `LastSeenCommentId`
high-water — in `AppState.Reviews.Sessions`, written by the `mark-viewed` call that already fires on
PR-detail open (`usePrDetail.ts`). But timeline events are neither comments nor head-SHA-keyed (a
review/approval moves no head SHA), and there is no stored wall-clock "last viewed at" or per-event
seen set. So an unseen divider needs a **new** timeline-specific high-water. It is a real follow-up,
not a reuse — hence deferred.

## Event subset (curated)

Included verbs (from `ActivityVerb`): `Commented` (as card), `Reviewed` / `Approved` /
`ChangesRequested` (card if the review has a body, else marker), `ReviewRequested`, `Pushed`
(grouped per decision #8), `Opened` (synthesized base node — see Architecture), `Reopened`, `Closed`,
`Merged`. `ReadyForReview` has no existing `ActivityVerb` — its mapping (new verb vs. reuse) is an
open question resolved in planning (see Risks). Excluded: `ReviewRequestRemoved`, labeled, milestoned,
cross-referenced, assigned, renamed, deploys, and other non-review noise.

## UI states & interactions

- **Loading.** Initial feed load uses the project's skeleton pattern (per #181/#244); the "Show older
  activity" control enters a busy/disabled state until its page resolves, so repeated clicks can't
  stack requests.
- **Empty.** A PR with no comments and only the synthesized `Opened` node (or one where the bot
  toggle hides every row) shows an explicit "No activity yet" placeholder below the composer — never a
  blank card that reads as broken.
- **Error / degraded.** On a non-2xx / degraded timeline read, the feed shows an inline error with a
  retry affordance that is **visually distinct from the empty state** — it must not silently render as
  "no activity" (a false-empty). A frontend test asserts this.
- **Live-refresh merge.** When a published frame arrives, the newest page is refetched and merged
  **without moving the user's scroll position**, without stealing focus (e.g. mid-composition), and
  without auto-scrolling to the inserted rows. New rows arrive in place (optional brief highlight). A
  new commit **extends the tail commit-group** rather than spawning a lone marker.
- **End of history.** Once `pageInfo.hasPreviousPage` is false, "Show older activity" is hidden (or
  replaced with a static "Beginning of activity" label) — no permanently-dead button.
- **Commit accordion.** Collapsed by default for runs >5; expand/collapse is keyboard-operable with
  `aria-expanded`; the collapsed row states the count ("18 commits").
- **Bot toggle.** Bots hidden by default (matching `ActivityRail`); the toggle state persists per
  session.
- **Accessibility.** Live-merged updates are announced via an `aria-live="polite"` region so
  screen-reader users learn a new approval/push arrived; "Show older activity", the bot toggle, and
  the commit accordion are keyboard reachable and operable; focus is never stolen on live merge.

## Testing

- **Backend:** unit tests for the new `ReadPageAsync` — ordering, timestamp parsing, cursor
  pagination (including a multi-page history that would truncate under a single read, per #604), verb
  mapping for each included event type, bot flagging, and fault isolation (non-2xx → empty/degraded,
  mirroring `GitHubPrTimelineReader`). A byte-identity golden for the new GraphQL query captured at
  the public seam, per the repo's aliased-batch testing precedent.
- **Poller emission gate:** a test that a review/approval/review-request delta now publishes a frame
  (the widened `ActivePrPoller` gate), which it does not today.
- **Frontend:** vitest for the unified feed — flat newest-first interleave, same-timestamp tie-break
  stability, comment-card vs. marker selection, one-review-one-unit (bodied approval), commit-run
  grouping + accordion collapse at the >5 threshold, bot toggle default/persistence, "Show older"
  pagination + end-of-history, empty vs. degraded-error states (feed must not render false-empty on
  fetch failure), and composer-at-top posting with single-render de-dup. Preserve/port the existing
  `PrRootConversation` composer/draft tests (inventory them first — see Risks).
- **Live-refresh:** a test that a published frame triggers a newest-page refetch and merges a new
  event without moving scroll or stealing focus, and that a new commit extends the tail group.
- **Accessibility:** a test asserting the `aria-live` region announces a merged update and that the
  accordion / bot toggle / "Show older" are keyboard operable.
- **e2e:** validate against a real multi-reviewer PR with reviews/approvals/pushes (per issue
  verification). Check the parity/visual specs for the Overview tab before changing its DOM.

## Verification

- Overview shows a flat, newest-first feed for a real PR with multiple reviews/approvals/pushes.
- Comment bodies appear exactly once (no duplication with any other Overview surface).
- The composer is reachable at the top without scrolling the feed.
- A new approval (no `headSha` change) appears after refresh **and** live (via the widened poller
  frame), without moving the reader's scroll position.
- A burst of >5 consecutive commits shows as one collapsed accordion, expandable to the full list.
- Long histories page correctly via "Show older activity" without silent truncation; the control
  disappears at the beginning of history.
- Bot events are filtered/toggleable; an empty or failed feed is visibly distinct (no false-empty).

## Risks / open questions

- **Blast radius.** This reworks the Overview conversation rather than adding an isolated card. The
  composer, draft replies, and comment-post must keep working through the new feed. Mitigation: lift
  the composer/draft flow intact rather than rewriting it, and **inventory the existing
  `PrRootConversation` composer/draft tests first** so every one is ported, not just cited.
- **Ready-for-review verb.** `ActivityVerb` has no explicit `ReadyForReview`; confirm the mapping
  (new verb vs. reuse of an existing one) during planning.
- **Commit-group boundaries.** A consecutive commit run can span a "Show older" page boundary or grow
  via live-refresh; the group must re-coalesce after a page merge, and a live commit must extend the
  existing tail group rather than spawn a lone marker. Resolve the grouping-across-pages mechanics in
  planning.
- **Poller-gate widening scope.** Widening `ActivePrPoller`'s emission condition must not spam frames
  for no-op review re-reads; the delta comparison needs a stable prior-state anchor
  (`LastApprovals` / `AwaitingReviewers` or equivalent). Confirm the exact trigger in planning.

## Related

- #137 (closed) — inbox Activity/Watching real data (the inbox-side counterpart).
- #604 — activity-read pagination/truncation (shared data path; coordinate cursors).
- #598 / #532 — GraphQL batching/consolidation (extend, don't bypass).
- #593 / #655 — `ActivePrUpdated` review name-lists + PR-detail SSE subscription (live-refresh seam).
