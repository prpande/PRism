# Review threads in the Activity timeline: residency, click-through navigation, and outdated-thread visibility

**Issues:** [#773](https://github.com/prpande/PRism/issues/773) (slice 1 — wire data), [#774](https://github.com/prpande/PRism/issues/774) (slice 2 — timeline residency + navigation). Slice 3 (re-anchoring outdated threads into the current diff) is explicitly deferred; see "Out of scope".

**Gating:** #774 is UI-visual (B1) — human review on spec, plan, and PR. #773 is a backend wire change feeding it.

## Problem

Two intertwined gaps:

1. **Outdated threads are silently invisible.** When GitHub marks a review thread outdated (the anchored line changed in a later push), it returns `line: null`. PRism's parser coerces that to `LineNumber = 0`; the Files tab joins threads to diff rows on `lineNumber === newLineNum`, and no row has line 0, so the thread's widget is never emitted — no error, no fallback surface. The file-tree comment indicator still counts these threads, so a file can show an "unresolved" glyph for a comment the user cannot find. The GraphQL query never requests the fields (`isOutdated`, `originalLine`, `diffHunk`, …) that would let any surface display them.
2. **Inline threads have no timeline presence and no navigation path.** A review with N inline comments renders in the Activity feed as one card containing only the review's top-level body. `TimelineEvent` carries no file path/line/thread id, and no feed item has a click affordance. Finding which file a comment refers to means manually browsing the Files tab.

GitHub's Conversation tab solves both (threads in the conversation, linked to code, outdated ones shown with their frozen hunk snippet). Closing the gap is a product differentiator for PRism's review flow.

## Verified facts this design rests on

Established 2026-07-17 (code reading + live GraphQL/REST verification against a real PR):

- **GitHub semantics:** for LINE-subject threads, `line: null` correlates 1:1 with `isOutdated: true`, and `originalLine`/`originalStartLine` stay populated; `subjectType: FILE` threads have `line: null` from creation regardless of outdated state. GitHub never re-anchors an outdated thread — it is a one-way transition. A comment's `diffHunk` tracks forward while the comment remains resolvable, then freezes at the last commit it resolved against. `subjectType: FILE` threads have no line fields at all and outdate on any push. Every inline comment belongs to a `PullRequestReview` (GitHub wraps standalone comments in an implicit `COMMENTED` review).
- **Current pipeline:** `PRism.GitHub/GitHubReviewService.cs` requests only `id path line isResolved` per thread; `PRism.GitHub/GitHubPrParser.cs` defaults missing/null `line` to `0`; `ReviewThreadDto.AnchorSha` is dead (always `""`). The frozen fixture `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` contains 3 of 6 threads with real `"line": null`.
- **Timeline:** `PRism.GitHub/Activity/GitHubPrTimelineFeedReader.cs` fetches reviews as top-level body only; review events carry id `review:{databaseId}`. `ActivityFeed.tsx` renders review cards via the shared `CommentCard` and has no interactive rows.
- **Navigation seams:** `requestFileView(path)` (prDetailContext → PrDetailView `pendingFilePath` → FilesTab) already performs cross-tab file navigation with focus + polite announce; each thread widget root already carries `data-thread-id` and `tabIndex={-1}` (`ExistingCommentWidget.tsx`). `StaleDraftRow.tsx` contains an explicitly deferred "Show me" gap waiting on exactly this deep-link mechanic. Reactivation of a kept-alive PR tab re-runs `reload()` (#180 contract); `diffScrollMemory` restores a raw pixel offset per PR.

## Decisions

- **D1 — Threads group under their parent review card** (not as independent flat-feed items). Preserves the timeline spec's "one review is one unit" rule and sidesteps the fact that GraphQL thread objects carry no own timestamp. Body-less `COMMENTED` reviews (today a bare "reviewed" marker) become a card shell holding their thread rows.
- **D2 — Collapsed accordion per thread, collapsed by default.** Handles volume (a 50-comment review adds 50 compact rows, not 50 full threads).
- **D3 — Expanded view is read-only and visually mimics the Files-tab thread**: same comment-card components, same resolved styling, plus the frozen `diffHunk` snippet block for code context. Reply/resolve remain exclusively in the Files tab — one interactive surface, no duplicated composer/resolution/self-action-netting state.
- **D4 — Client-side join; no timeline reader/endpoint change.** The frontend already holds every thread via PrDetail's `reviewComments`; slice 1 adds `reviewDatabaseId` as the join key to `review:{databaseId}` events. One source of truth for thread data across tabs.
- **D5 — File-tree comment indicator counts anchored threads only** (`lineNumber != null`). The indicator decorates what is findable in that file's diff; outdated threads get their home in the timeline.
- **D6 — Outdated threads get no click-through in v1.** Their display is the badge + frozen hunk snippet. Re-anchoring (slice 3) is deferred: GitHub itself never re-anchors, the failure-mode list is long (deletion-side comments, file-level threads, renames, ambiguous matches, frozen context), and a heuristic anchor risks pointing a stale comment at code that was changed in response to it.
- **D7 — `LineNumber` becomes nullable on the wire** (`int?`; null = outdated or file-level). The `0` sentinel is a bug, not a contract. The diff-row join is already null-safe.
- **D8 — `DiffHunk` is projected thread-level from the first comment.** Per-comment hunks stay off the wire (payload); the first comment's hunk is the thread's original code context.

## Slice 1 — wire data (#773)

### GraphQL query (`GitHubReviewService.cs`)

Thread level, added to the existing `reviewThreads(first:100)` selection: `isOutdated originalLine originalStartLine subjectType`.
Comment level, added to the nested `comments(first:100)` selection: `diffHunk pullRequestReview{databaseId}`.

Only fields the DTO carries are fetched (`startLine`/`startDiffSide`/`diffSide` are not carried — no consumer in slices 1–2; slice 3 re-anchoring adds what it needs when it exists).

### `ReviewThreadDto` (PRism.Core.Contracts)

```csharp
public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int? LineNumber,          // was int; null = outdated or file-level
    bool IsOutdated,
    int? OriginalLine,
    int? OriginalStartLine,   // multi-line ranges; null for single-line
    string SubjectType,       // "LINE" | "FILE"
    string? DiffHunk,         // first comment's hunk; null if unavailable
    long? ReviewDatabaseId,   // first comment's parent review; timeline join key
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);
```

`AnchorSha` is removed (dead field, always `""`, unfulfilled TODO). `ReviewCommentDto` is unchanged — `DiffHunk`/`ReviewDatabaseId` are projected onto the thread during parsing, not carried per comment.

### Parser (`GitHubPrParser.ParseReviewThreads`)

- `line: null` → `LineNumber = null` (no sentinel).
- New fields mapped with `TryGetProperty` tolerance: absent fields default to `IsOutdated = false`, nulls for the optional fields, `"LINE"` for `SubjectType` — so replaying pre-existing captured payloads (the frozen fixture before regeneration) still parses.
- `DiffHunk`/`ReviewDatabaseId` read from `comments.nodes[0]` when present.

### File-tree comment indicator (`frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts`)

`deriveCommentStateByPath` / `deriveCommentCountsByPath` filter to `t.lineNumber != null` before counting. This closes the "glyph points at nothing" bug immediately, independent of slice 2.

### Frontend consumer sweep (wire-shape rule)

`frontend/src/api/types.ts` mirrors the new shape (`lineNumber: number | null`, new fields). Consumers to touch/verify: `DiffPane.tsx` `threadsByLine` grouping (skip null — already effectively null-safe, make it explicit), `commentIndicatorState.ts` (above), and any test fixtures constructing `ReviewThreadDto`-shaped objects. Backend: besides `GitHubPrParser.cs`, the only other `ReviewThreadDto` construction site in the repo is `tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs` (`MakeDetail()`, currently passes `AnchorSha: "head1"`) — it breaks compilation when the record changes and is updated in the same commit. Playwright cold-start/PR-detail smoke per the standing wire-change rule.

### Testing (slice 1)

- Parser unit tests: null line, populated anchor fields, first-comment projection, absent-field tolerance.
- Fixture: regenerate `pr19-graphql-response.json` via the documented capture + `FixtureStripAllowlist` process with the new scalar fields allowlisted (`isOutdated`, `originalLine`, `originalStartLine`, `subjectType`); `diffHunk` stays **stripped** (nulled) in the fixture — it is freeform code text, and the stripper's contract is to null freeform values. Fixture-based tests assert the 3 real outdated threads surface `lineNumber: null`, `isOutdated: true`, `originalLine` set. `diffHunk` projection and `reviewDatabaseId` are covered by synthetic-payload unit tests instead — the stripper nulls `databaseId` everywhere, so the slice-2 join key never survives the fixture either.
- `commentIndicatorState` tests: outdated threads excluded from glyph/count; file with only outdated unresolved threads shows nothing.

## Slice 2 — timeline residency + click-through (#774)

### Data flow

A small hook (e.g. `useThreadsByReview(reviewComments)`) groups PrDetail's `reviewComments` by `reviewDatabaseId` into `Map<number, ReviewThreadDto[]>`, thread rows ordered by first-comment `createdAt` ascending. `OverviewTab` (which already holds the PrDetail data) runs the hook and passes the map to `ActivityFeed` as a prop — `ActivityFeed` keeps its explicit-props pattern (it does not consume `prDetailContext`) and looks up `review:{databaseId}` events in the map to hand each review card its thread list. Defensive: threads with `reviewDatabaseId == null` are omitted from the timeline (they remain visible in the Files tab if anchored).

Known freshness tradeoff (accepted): a just-posted review's timeline card can appear one refresh cycle before the PrDetail snapshot delivers its threads; the accordion rows appear on the next PrDetail reload. Threads whose parent review sits on an older, not-yet-loaded timeline page render only once that page loads ("Show older activity"). The existing `reviewThreads(first:100)` truncation surfaces through the established #604 cap signal — no new handling.

### Review card: thread accordion rows

Under the review card's body (or directly under the marker-turned-shell for body-less reviews), one row per thread:

- **Collapsed row** (default): disclosure chevron; monospace file path + `:line` chip (current-head `lineNumber`) for anchored threads, or an **Outdated** badge for outdated ones; first-comment author avatar + login; single-line body snippet (ellipsized); reply count (`comments.length − 1`, shown when > 0); resolved state chip matching the Files-tab resolved styling. File-level threads (`subjectType: FILE`) show a **File** chip instead of a line chip; a thread that is both file-level and outdated shows the **File** chip, never the Outdated badge — outdatedness is a weak signal for FILE threads (they outdate on any push), and both states get identical no-click-through treatment. An expanded outdated thread labels its snippet with the original range ("was L592–596", from `originalStartLine`/`originalLine`; "was L596" when `originalStartLine` is null — never mixed with current-head numbers).
- **Expanded**: a muted monospace block rendering the frozen `diffHunk` (scrollable in its own `overflow-x` container), then the comment stack reusing the same `CommentCard` rendering as Files-tab threads (default density). Read-only — no composer, no resolve button. When `DiffHunk` is null (e.g. file-level threads), the snippet block is omitted entirely — the expanded view is just the comment stack, never an empty scrollable box.
- **"View in diff"** button on the row (anchored threads only, visible without expanding). Outdated/file-level threads have no button; the badge + snippet is their surface.
- Rows follow their parent card's visibility (e.g. the existing "Show bots" filter).

The accordion row is a `button` with `aria-expanded`; "View in diff" is a separate button (no nested interactive elements — the row and the action are siblings within the row layout).

### Click-through mechanics

Extend the existing cross-tab plumbing rather than invent new state:

- `requestFileView(path, threadId?)` — `PrDetailView` stashes `{ path, threadId }` (today `pendingFilePath` alone).
- The thread step runs only when `threadId` is present — plain single-arg `requestFileView(path)` calls (HotspotsTab today) behave exactly as they do now.
- The lookup/scroll/focus/highlight step is its **own effect**, gated on the target file's diff rows having actually committed (`selectedPath === target.path` and the diff query settled) — it must not run in the same tick as `setSelectedPath(...)`, or `[data-thread-id="${threadId}"]` reads the previous file's DOM and every cross-file click-through lands on the miss path. `FilesTab`'s pending-file plumbing already guards against exactly this class of stale-render race; the new step gets the same treatment.
- On a hit: scroll the `.diff-pane-body` container to center the widget (manual `container.scrollTo`, mirroring `useChangeNavigation`'s approach — `scrollIntoView` is unused in this codebase and absent in jsdom), `focus()` the widget root (already `tabIndex={-1}`), and apply a transient highlight (~2s CSS animation, gated behind `@media (prefers-reduced-motion: reduce)` with an instant/static highlight fallback — matching `ChangeMinimap.module.css` and `useChangeNavigation`'s reduced-motion handling).
- The pending target is cleared when that effect resolves — success or miss — never synchronously alongside `setSelectedPath`. On a miss (thread went outdated/removed between click and landing): show the existing `Snackbar` with "Comment thread not found in the current diff", paired with the polite live-region announcement (codebase convention pairs sr-only status with a visible cue — `ChangeNavControls`, `ExistingCommentWidget`); the user stays on the selected file.
- #180 robustness: the pending target is one-shot, so a `reload()` on tab re-entry cannot re-fire it; an explicit thread target takes effect after (and therefore wins over) `diffScrollMemory`'s pixel restore.
- Range/commit picker: the pending-file path already forces `activeRange` back to `'all'`; the thread lookup happens against that full diff.

This also unblocks `StaleDraftRow`'s deferred "Show me" navigation (separate follow-up; not in this slice's scope, but the mechanic is designed to be reusable: target by `data-thread-id` today, other `data-*` anchors later).

### Testing (slice 2)

- Unit (vitest): grouping hook (ordering, null `reviewDatabaseId` omission); ActivityFeed rendering — accordion collapsed/expanded content, Outdated/File chips, reply count, resolved styling, bots-filter behavior; "View in diff" invokes `requestFileView(path, threadId)`; FilesTab pending-thread effect — fires only after the target file's rows commit, `scrollTo` called with computed offset (mocked), focus lands on the widget, miss-path shows the snackbar + announces + clears, plain file-only navigation unchanged; resolving a thread in the Files tab is reflected in the timeline row's resolved chip after the detail reload.
- e2e (Playwright, prod project): timeline → click-through → Files tab lands scrolled/focused on the thread, using the existing scenario harness; extend the fake fixture with review threads if it lacks them (related: #453 proposes a seed hook — not a dependency).
- Visual verification screenshots (both themes) posted on the PR per the B1 rule.
- Risk: Overview-tab parity-baseline screenshots may shift beyond the 2% tolerance once thread rows render; if so, regenerate the Linux baseline from the CI artifact and commit it into the PR before merge.

## Out of scope (explicit)

- **Slice 3 — strict re-anchoring** of outdated threads into the current diff (unique-verbatim-match heuristic, RIGHT-side LINE-subject only). Revisit after living with slice 2; file a fresh issue then.
- Interactive reply/resolve from the timeline (option B in the brainstorm).
- Unread/read-receipt integration for thread rows (#160, #697).
- Any redesign of the Files-tab inline thread widgets.
- `StaleDraftRow` "Show me" adoption of the new mechanic (follow-up issue when picked up).

## Rollout / sequencing

Two independently reviewable PRs: #773 first (backend + indicator + consumer sweep; shippable standalone — it fixes the ghost-glyph bug on its own), then #774 (frontend-only). Both follow the standard spec → plan → TDD flow; #774 is gated (UI-visual). Sequencing note: between the two merges an outdated unresolved thread has no surface at all (#773 removes the misleading glyph, #774 adds the real home) — hold the two PRs close together so the gap is bounded by review latency, not development.
