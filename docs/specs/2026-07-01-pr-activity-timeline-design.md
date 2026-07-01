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
top. New activity (approvals, pushes, review requests) appears **live** via the existing SSE
channel.

## Scope

### In v1

1. A new per-PR, ordered, **timestamped**, paginated GraphQL read of the PR timeline.
2. A unified Overview feed component that **subsumes `PrRootConversation`**: composer at top, then a
   newest-first rail interleaving comment cards and event markers.
3. Reuse of the existing `ActivityVerb` vocabulary, `ActivityRail` row visual language, `knownBots`
   filtering, and the `PrRootConversation` comment/draft/composer flow.
4. Cursor-based "Show older activity" pagination (satisfies the #604 single-page-truncation class).
5. **Live-refresh** off the existing `pr-updated` SSE frame: a new review/approval/push refetches
   the feed's newest page so it appears without a manual reload.
6. A new bus event + `PrDetailLoader` subscription so a fresh review/approval — which does **not**
   change `headSha` — evicts the stale PR-detail snapshot.

### Deferred to follow-ups (prioritized)

1. **Per-event streaming/append** — push and animate individual new events in place without a
   full newest-page refetch. This is the immediate next increment; it completes the "live" feel
   beyond the v1 refetch approach. Filed as the #1 follow-up.
2. **"New since last visit" unseen divider** — a visual marker delimiting events the user has not
   yet seen. Requires a new timeline-specific high-water (see "Seen-state" below); the existing
   head-SHA / comment-id anchors do not map to events.

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
4. **Ordering — newest-first at the unit level.** A root comment keeps its replies attached as one
   block; blocks and standalone events are ordered newest-first by the block's latest activity.
   Replies remain chronological **within** their parent block, so no reply renders above the
   comment it answers.
5. **Composer at top.** Pinned above the feed so adding a comment never requires scrolling past the
   entire history.
6. **Bot noise.** Reuse `knownBots` + a "show bots" toggle, mirroring `ActivityRail`.
7. **Refresh.** Fetch-on-load + on-refresh + live-refresh via the existing `pr-updated` SSE frame.

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
  `PULL_REQUEST_REVIEW` (state + body + author), `REVIEW_REQUESTED_EVENT` /
  `REVIEW_REQUEST_REMOVED_EVENT`, `PULL_REQUEST_COMMIT` (commit count/author),
  `READY_FOR_REVIEW_EVENT`, `REOPENED_EVENT`, `CLOSED_EVENT`, `MERGED_EVENT`. Uses forward/backward
  `pageInfo` cursors — no unbounded single read (coordinates with #604).
- Extends the #598/#532 aliased-GraphQL layer; **no** REST fan-out.

**New event contract.** A `TimelineEvent` record carrying: `Verb` (`ActivityVerb`), actor
(`Login`, `AvatarUrl`, `IsBot`), `Timestamp`, and a verb-specific payload (e.g. commit count for
`Pushed`, requested reviewer for `ReviewRequested`, body for comments/reviews-with-body). Reuses the
`ActivityVerb` enum (`PRism.Core/Activity/ActivityContracts.cs`).

**Comments vs. event markers.** Top-level PR comments and **reviews that carry a body** render as
comment **cards** (they have substantive content). Bare state changes — approval with no body,
changes-requested with no body, pushes, review requests, ready/reopened/closed/merged — render as
one-line **markers**.

**Cache invalidation.** PR-detail snapshots are keyed `CacheKey(prRef, headSha, generation)` and
`PrDetailLoader.Invalidate(prRef)` (`PRism.Core/PrDetail/PrDetailLoader.cs:337`) already backs five
bus subscriptions. A fresh review/approval does **not** move `headSha`, so the timeline would go
stale. We add a bus event (or reuse `DraftSubmitted` / the review name-list delta already on
`ActivePrUpdated`) and a matching `PrDetailLoader` subscription that calls `Invalidate(prRef)`,
following the existing `OnRootCommentPosted` / `OnDraftSubmitted` pattern.

**Live-refresh over SSE.** `SseChannel` (`PRism.Web/Sse/SseChannel.cs`) already fans out a
`pr-updated` frame from `ActivePrUpdated`, which carries `Approvals` / `ChangesRequested` /
`Approvers` name-lists (#593). PR-detail already subscribes to this feed for live mergeability
(#655, `prDetailContext.tsx`). v1 live-refresh: on a `pr-updated` frame for the active PR, refetch
the feed's newest page and merge. No new backend stream in v1.

### Frontend

**New unified feed component** in `frontend/src/components/PrDetail/OverviewTab/`, wired into
`OverviewTab.tsx` in place of `PrRootConversation` (after `StatsTiles`). It:

- **Reuses** the composer + draft-comment + comment-post flow currently in `PrRootConversation`
  (moved/lifted, not rewritten), preserving the comment-post → `Invalidate` behavior.
- **Reuses** the `ActivityRail` `Row` visual vocabulary
  (`frontend/src/components/ActivityRail/ActivityRail.tsx:75`): `VERB_PHRASE` / `ACTORLESS_LEAD`
  verb→phrase maps, `Avatar`, the glyph/`NotifIcon` treatment, and `formatAge` relative time.
- Renders a **vertical rail (spine)** connecting nodes. Each node shows a **glyph** (verb-specific
  icon for events) or the author **avatar** (comments/actor events), plus **user id** and relative
  time — matching the current root-conversation and activity-rail look and feel.
- Orders units newest-first with replies attached to their parent block (see decision #4).
- Provides a **"Show older activity"** control that pages back via the cursor, and a **"show bots"**
  toggle.
- Subscribes to the `pr-updated` SSE feed for live-refresh.

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
`ChangesRequested` (card if the review has a body, else marker), `ReviewRequested`, `Pushed`,
`Opened`, `Reopened`, `Closed`, `Merged`, plus `ReadyForReview` (map to an appropriate verb/marker).
Excluded: labeled, milestoned, cross-referenced, assigned, renamed, deploys, and other non-review
noise.

## Testing

- **Backend:** unit tests for the new `ReadPageAsync` — ordering, timestamp parsing, cursor
  pagination (including a multi-page history that would truncate under a single read, per #604), verb
  mapping for each included event type, bot flagging, and fault isolation (non-2xx → empty/degraded,
  mirroring `GitHubPrTimelineReader`). A byte-identity golden for the new GraphQL query captured at
  the public seam, per the repo's aliased-batch testing precedent.
- **Invalidation:** a test that a review-posted bus event evicts the PR-detail snapshot even though
  `headSha` is unchanged.
- **Frontend:** vitest for the unified feed — newest-first unit ordering with replies attached,
  comment-card vs. marker selection, bot toggle, "Show older" pagination, and composer-at-top
  posting. Preserve/port the existing `PrRootConversation` composer/draft tests.
- **Live-refresh:** a test that a `pr-updated` SSE frame triggers a newest-page refetch and merges a
  new event.
- **e2e:** validate against a real multi-reviewer PR with reviews/approvals/pushes (per issue
  verification). Check the parity/visual specs for the Overview tab before changing its DOM.

## Verification

- Overview shows an ordered, newest-first feed for a real PR with multiple reviews/approvals/pushes.
- Comment bodies appear exactly once (no duplication with any other Overview surface).
- The composer is reachable at the top without scrolling the feed.
- A new approval (no `headSha` change) appears after refresh **and** live via `pr-updated`.
- Long histories page correctly via "Show older activity" without silent truncation.
- Bot events are filtered/toggleable.

## Risks / open questions

- **Blast radius.** This reworks the Overview conversation rather than adding an isolated card. The
  composer, draft replies, and the `headSha`-keyed comment-post invalidation must keep working
  through the new feed; existing `PrRootConversation` tests get reworked. Mitigation: lift the
  composer/draft flow intact rather than rewriting it.
- **Reply threading model.** Confirm during planning whether root-conversation replies nest under
  their parent (assumed here) or are flat, and that the newest-first-at-unit ordering matches the
  actual reply data shape.
- **Ready-for-review verb.** `ActivityVerb` has no explicit `ReadyForReview`; confirm the mapping
  (new verb vs. reuse of an existing one) during planning.

## Related

- #137 (closed) — inbox Activity/Watching real data (the inbox-side counterpart).
- #604 — activity-read pagination/truncation (shared data path; coordinate cursors).
- #598 / #532 — GraphQL batching/consolidation (extend, don't bypass).
- #593 / #655 — `ActivePrUpdated` review name-lists + PR-detail SSE subscription (live-refresh seam).
