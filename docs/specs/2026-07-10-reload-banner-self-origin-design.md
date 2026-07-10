# Reload banner fires for the user's own actions

- **Issue:** [#740](https://github.com/prpande/PRism/issues/740)
- **Date:** 2026-07-10
- **Status:** Design — **LOCKED**. B2 gate answered 2026-07-10: **origin reading (§3) → option E (§5)**. Implementation plan: `docs/plans/2026-07-10-reload-banner-self-origin.md`.
- **Tier / Risk:** T3 / gated — B1 (`needs-design`, rendered chrome) **and** B2 (behavioral architectural invariant: *Banner, not mutation*).
- **Surfaces:** PR detail (`BannerRefresh`). **Frontend-only** under E — no wire, DTO, GraphQL, or poller change.
- **Revision:** rewritten after a 6-persona `ce-doc-review`. The first draft recommended option D on a misreading of the #450 governing principle (§2.1). That recommendation is withdrawn.

## 1. Problem

Post an inline review comment through PRism. Within one poll tick (default 30s)
the reload banner announces **"1 new comment — Reload to view"** — about the
comment you just wrote, which is already on screen.

The banner is also the only signal that a *teammate* commented while you were
reading. **Hypothesis (not established):** firing it on every comment you post
erodes trust in it, so a real external comment gets dismissed reflexively. There
is no in-context evidence for this — no recorded missed comment, and the
frequency of teammate comments arriving mid-review is unknown. The *verified*
defect is narrow: **a self-post raises a banner.** Any fix that goes beyond that
is justified by design coherence, not by measured harm.

### 1.1 Verified chain (against `main` @ `ca603fb7`; independently re-verified)

1. `ActivePrPoller.cs:286` — `commentChanged = state.LastCommentCount is { } pc && pc != snapshot.CommentCount`.
2. `ActivePrPoller.cs:318` — `commentDelta = snapshot.CommentCount - prior`; published `:321-337`.
3. `ActivePrUpdated.cs:17-35` — the event carries SHAs, counts, merge-readiness and
   reviewer *rosters*, but **no comment-level author or comment id**. Nothing identifies
   *who* wrote the comment or *which* comment it was.
4. `SseEventProjection.cs:37-43,84-88` — projects `commentCountDelta` to the wire; no actor.
5. `useActivePrUpdates.ts:80-90` — filters on `prRef` only, then `hasUpdate: true` and
   `commentCountDelta += event.commentCountDelta`.
6. `BannerRefresh.tsx:52-54` — renders `"N new comment(s) — Reload to view"` iff `commentCountDelta > 0`.

Greps for `selfDelta` / `expectedDelta` / `suppress` / `mute` / `origin` / `actor` /
`echo` / `ignoreNext` / `postedCommentId` across `frontend/src` and all `.cs` return
**no self-origin filter anywhere**. `PrDetailView.tsx:141,146` wires the self-post
subscribers to a bare `reload`; the merge/close path at `:150-153` **does** call
`clearUpdates()`. The omission is specific to comment posts.

### 1.2 Correction to the issue text

The issue claims posting **either** an inline or a root comment raises the banner.
**Only the inline path does.** `CommentCountDelta` derives solely from
`snapshot.CommentCount` = `CountReviewComments(pr)` (`GitHubActivePrBatchReader.cs:122-137`),
the sum over `reviewThreads.nodes.comments.totalCount`. A root issue comment moves a
*separate* `IssueCommentCount` (`:115`), tripping `issueCommentChanged`
(`ActivePrPoller.cs:301-302`), which publishes `CommentCountChanged: false,
CommentCountDelta: 0`. `formatMessage` emits nothing. (Posted to the issue.)

### 1.3 The constraint that rules out the obvious fix

Calling `clearUpdates()` on the self-post path **cannot** work. The offending
`pr-updated` frame does not exist yet at post time — it arrives up to one poll tick
(~30s) later and re-raises `hasUpdate` after the clear.

## 2. Prior art

`docs/specs/2026-06-12-eliminate-reload-banners-design.md` (#450, **shipped** —
`InboxBanner` deleted, `useSingleCommentPostedSubscriber` exists) set the governing rule:

> **auto-apply when no in-flight user work (unsaved drafts, line-anchored selections,
> an open composer) can be invalidated; require explicit consent otherwise.**

It fixed the comment path's *reply-ability* (auto-reload on `single-comment-posted`) and
never touched `BannerRefresh.formatMessage`, whose `commentCountDelta > 0` arm has been
unchanged since the original slice (`25d46159`, confirmed by `git blame`). **#740 is the
bug that leftover arm produces.**

### 2.1 What that principle actually says about *inbound* comments — and what the first draft got wrong

The first draft of this spec claimed #450's principle sanctions auto-applying an inbound
comment. **It does not. It argues the opposite.**

- The principle's own enumeration of in-flight work that forces consent explicitly includes
  **"an open composer."**
- #450 granted *auto* to the comment-post case **because** "the composer has already closed
  on post," and its view-state-preservation proof (§2.3) is conditioned on
  *composer-closed-before-reload*.

That condition holds for **your own** post. It fails for a stranger's comment landing while
you are mid-reply. By #450's rule, the correct disposition for an inbound comment arriving
with an open composer is **consent**, not auto. Any option that auto-applies inbound comments
must therefore carry an explicit composer gate — it cannot inherit safety from #450.

The `Banner, not mutation` invariant (`.ai/docs/architectural-invariants.md:10`) reads:

> Remote state never auto-applies to the diff under the cursor or to the reviewer's drafts.
> Polling produces a non-intrusive banner; reload is explicit. The narrow exception is
> informational **widgets** about other people's content (existing comment bodies,
> thread-state badges).

The exception names *display widgets*, not a page-level reload that swaps the reviewer's
thread list mid-review. Reading it to license auto-apply is a stretch, and it is the same
stretch the first draft made.

## 3. DECISION 1 — what does the banner mean? → **origin** (locked 2026-07-10)

This had to be answered **before** the option choice, because it eliminates options.

- **Origin reading:** "PRism did not cause this." Suppress only what PRism itself wrote.
- **Seen/unseen reading:** "you have not looked at this." Suppress anything already rendered.

They diverge: a comment you author on github.com in a browser is *your* action, but PRism
did not originate it and does not have it locally.

**#740's own words select the origin reading** — *"The banner should signal only **external**
changes"*, and Desired-behavior keeps bannered *"comments/reviews added on GitHub or by
another client."* Under the origin reading, options B and D are both wrong: B suppresses by
seen-ness, D suppresses everything.

The first draft asserted the seen/unseen reading in a single line and then evaluated only
options that survive it. That was the deck-stacking; it is corrected here.

**On the origin/seen-ness distinction in E's implementation.** E's predicate is literally
"is this comment id absent from what PRism has rendered?" — the *seen-ness* test. It is the
correct implementation of the *origin* reading anyway, because the two agree on every case
that can occur:

| Case | Origin says | Rendered-set says | Agree? |
|---|---|---|---|
| PRism posted it | suppress | rendered (#450 auto-reload) → suppress | ✔ |
| Teammate posted it on GitHub | banner | absent → banner | ✔ |
| *You* posted it on github.com in a browser | banner | absent → banner | ✔ |
| External comment already pulled in by a manual Refresh | banner | rendered → suppress | ✘ |

Only the last row diverges, and there the banner would be announcing a comment already on
the reviewer's screen — the very defect #740 reports. Suppressing is correct. The rendered
set is therefore a *sound and slightly more conservative* proxy for origin, not a compromise.

## 4. Options

Costs are stated symmetrically. **A, D, E** compare against a **single** reader and are
immune to the cross-reader hazard; **B** compares two independent readers and is not.

### A — Poller-local origination counter

Poller subscribes to `SingleCommentPostedBusEvent`, keeps a pending-self-post **counter**,
absorbs it against the observed rise each tick. No wire change. Single-reader.

*Cost / risk.* `SingleCommentPostedBusEvent` is published **after** the GitHub POST returns
(`PrCommentEndpoints.cs:154`; `ReviewEventBus.Publish` is synchronous, `ReviewEventBus.cs:17-45`).
A tick whose GraphQL read observes the new comment but whose processing finishes before that
publish emits a false `+1` and leaks the credit. The race window is **narrow** (a sub-tick
interleaving) and the leak is **boundable** (expire credits after N ticks) — the first draft's
"unbounded / strictly worse than the bug" framing was overstated. What remains genuinely
awkward: making it correct wants an *about-to-post* signal emitted **before** the write, plus
rollback on failure — and that rollback is wrong inside #106's lost-response window, where the
write may have succeeded. Also: a blind counter cannot tell *which* `+1` it absorbed, so a
self-post and an external comment in one tick window are indistinguishable.

### B — Absolute-count reconciliation across two readers

Ship the absolute inline-comment count; banner iff `serverCount > lastRenderedCount`.
Implements the **seen/unseen** reading.

*Cost / risk.* Both readers select `reviewThreads(first:100)` with **no `orderBy`**
(`GitHubActivePrBatchReader.cs:76`, `GitHubReviewService.cs:53`; the detail query exposes
`pageInfo{hasNextPage}` but never follows it). Above 100 threads, nothing proves the two
queries return the *same* 100 threads. If the windows diverge, `serverCount != detailCount`
permanently → **a banner Reload cannot clear.** This is **closeable** (compare only counts
originating from one reader, or paginate both) — it is a cost, not a disqualification, and
the first draft wrongly stamped it "unsound." The detail query also lacks `totalCount` on
nested comments, and `PrDetailGraphQLQuery` is byte-pinned by `Frozen_pr_graphql_shape_unchanged`.
Blast radius: 6 production files + ~3 SSE mocks + ~10 PR-detail mocks in `frontend/e2e/`
(not typechecked by `tsc -b` — breakage is runtime-only).

*Benefit the first draft omitted:* the banner **persists until acted on**. Nothing is missable.

### C — Client-side blind delta absorption

Hold a pending credit client-side, net it against the incoming delta. Same blind-swallow
flaw as A, without A's server-side vantage, and the credit must survive ~30s across reload,
unmount, and keep-alive tab switches. **Rejected.**

### D — Retire the comment arm; auto-apply inbound comments

Banner renders only for head-SHA / base-SHA changes. Comment-only frames silently `reload()`
and announce. Implements the **seen/unseen** reading, maximally.

*Cost / risk — substantially larger than the first draft claimed.*
- **Contradicts the principle cited to justify it** (§2.1): needs an explicit composer gate.
  Composer-dirty state lives in `FilesTab/useInlineComposer.ts` and `hooks/useDraftSession.ts`,
  **not** at `PrDetailView` where the reload decision is made — lifting it is unpriced scope.
- **Overrides an explicit requirement of #740** ("the banner remains for genuinely external
  changes"). Choosing D means amending the issue, on the record.
- **Awareness becomes missable.** Today's banner persists; a toast fades. For a review tool a
  *false negative* (merge without seeing a teammate's comment) is worse than a *false positive*
  (a redundant banner you dismiss). #450 accepted this trade for the inbox only because it had a
  persistent fallback — the per-row unread marker. PR detail has no equivalent; one must be designed.
- **No burst coalescing.** `pr-updated` is poll-driven, the same class as `inbox-updated`, which
  #450 debounced *precisely because a single poll cycle emits N frames*. It exempted the
  `*-posted` subscribers only because they fire once per user action. A comment-only subscriber
  is poll-driven and needs the same trailing debounce + queue-one-trailing.
- **Wrong primitive named.** `Snackbar` **persists** (tone union is `'warning' | 'danger'` — no
  neutral treatment exists); `Toast` is the auto-dismissing one (`AUTO_DISMISS_MS` 5s info/success,
  10s error). "Transient snackbar" names neither.
- **Wrong `aria-live` region named.** `PrDetailView.tsx:514`'s `pr-refresh-status` is owned solely
  by `usePrDetailRefresh.announce` (manual Refresh). A second writer creates an ownership conflict.
- **Backgrounded tabs.** PR tabs stay mounted (`hidden={!active}`); every comparable subscriber is
  wired with no `active` guard. The announcement would fire for a PR you are not looking at. The
  house pattern gates visible chrome on `active` (`PrDetailView.tsx:507`).
- **Joint-frame information loss.** A frame carrying *both* a SHA change and a comment change today
  renders `"Iteration 5 + 2 new comments — Reload to view"`. Under D the comment half disappears
  from the banner **and** the auto-apply path excludes joint frames — the information vanishes from
  both surfaces.
- **>100 threads → silence.** A comment beyond the thread window never moves the count, so it never
  reloads and never announces. D does not fix this; it deletes the wrong-but-present banner that was
  the only clue.

*Benefit:* fixes #740 by construction — no origin question, no counting, no reconciliation.

### E — Client-side identity diff (single-reader) — **CHOSEN**

Implements the **origin** reading, which is what #740 asks for.

A comment-only `pr-updated` frame is treated purely as a *trigger*, never as truth. On such a
frame the client re-fetches the PR detail (`getPrDetail`, a pure GET — `api/prDetail.ts:4`) and
counts the review-comment ids in the response that are **absent from the ids it has already
rendered**. That count — not `event.commentCountDelta` — is what the banner displays. Zero →
**no banner**. Non-zero → **banner**, with an accurate count, and **no auto-apply** (consent
preserved).

*Identity key:* `ReviewCommentDto.commentId` (`api/types.ts:318`), the GraphQL node id, mapped
from `nodes{ id }` in the thread fragment (`GitHubReviewService.cs:55`) and non-nullable in the
contract (`PRism.Core.Contracts/ReviewThreadDto.cs:18`). **Not `databaseId`** — that field is
`number | null | undefined` (`api/types.ts:324`) and a null would silently read as "unseen."
Set membership by string equality respects the *GraphQL Node IDs are opaque* invariant
(`architectural-invariants.md:15` — "equality and pass-through only").

*Why it is sound where B is not:* both sides of the comparison come from the **same reader**
(`GetPrDetailAsync`), so the `first:100` window cannot diverge against itself. After Reload the
rendered set *is* the fetched set. No stuck banner. No wire change, no GraphQL change, no DTO
change, no poller change. `Banner, not mutation` is untouched: nothing auto-applies, and the
fetched payload is **discarded** — Reload still refetches, so reload semantics are byte-identical
to today's.

*Why no self-posted-id ledger is needed.* #450 already auto-reloads on `single-comment-posted`,
so by the time the poll frame lands ~30s later PRism's own comment is in the rendered set. The
"ids PRism wrote" set is a strict subset of the rendered set, so tracking it separately is
redundant. This deletes the first draft's cross-tab-persistence cost entirely.

*Cost / risk.*
- **≤1 extra PR-detail GET per 30s poll tick, and only on ticks where the inline comment count
  moved.** Quiet PRs pay nothing. `PrDetailLoader.cs:146` evicts its snapshot on
  `CommentCountChanged`, so this GET *repopulates the head-SHA-keyed cache that the user's Reload
  would otherwise have had to fill* — in the banner case it is not extra work, just earlier work.
  The genuinely wasted case is the suppressed one (your own comment): one detail fetch to avoid
  one false banner.
- **Fail-open.** If the fetch throws, fall back to the raw `commentCountDelta` and show the
  banner. A false positive (a redundant banner) is recoverable; a false negative (never told a
  teammate commented) is not. This is the *Truthful by default* bias.
- **A narrow ordering race.** If a poll tick fires within the ~1s the #450 auto-reload takes to
  land, the rendered set may not yet contain the self-post → one false banner. Mitigated by
  deferring the diff while `usePrDetail.isLoading` is true and by reading the rendered set at
  fetch-resolve time, not at frame-arrival time. Not a regression: today that banner *always*
  shows.
- Inherits today's `first:100` blind spot (a comment in thread #150 never triggers). No regression.

*Bonus:* the count is also **corrected**. `useActivePrUpdates` accumulates
`s.commentCountDelta + event.commentCountDelta` across frames (`:90`), so a self-post followed by
one teammate comment reads "2 new comments" today. E replaces the accumulator with an absolute
diff, so it reads "1". This is the #437 bug class on the comment arm, fixed as a side effect.

## 5. DECISION 2 — the option → **E** (locked 2026-07-10)

Follows from §3's origin reading. E satisfies the issue literally, keeps the banner for external
comments, preserves consent, needs no wire change, and avoids B's cross-reader hazard. It is also
the only option that touches neither the byte-pinned GraphQL query nor the untypechecked
`frontend/e2e` mock bodies.

**Rejected, and why.**

- **A** (poller-local counter) — fallback if E's extra GET had been judged too expensive. It was
  not: the GET is bounded to comment-change ticks and warms the cache Reload needs. A's blind
  counter also cannot separate a self-post from a teammate's comment inside one tick window.
- **B** (absolute-count reconciliation) — implements the wrong reading (seen-ness, not origin),
  and its two readers can permanently disagree above 100 threads.
- **C** (client-side blind delta absorption) — A's flaw without A's vantage.
- **D** (retire the comment arm; auto-apply) — contradicts the #450 principle cited to justify it
  (§2.1), and overrides #740's explicit *"the banner remains for genuinely external changes"*.
  Choosing it would have meant amending the issue on the record.

**Scope boundary.** E does not fix the `first:100` blind spot, does not fix #437's
`headShaChanged`/`baseShaChanged` boolean latch, and does not touch the root-comment path (§1.2
shows it never raised the banner). Each is tracked separately (§8).

## 6. Testing strategy

A full Playwright e2e cannot reproduce this bug (§7). `development-process.md` mandates a regression
test failing on `main`; the **vitest layer is that gate**.

**The red-on-main scenario test.** Render `PrDetailView` with a detail payload already containing
comment `c-self`. Deliver a `pr-updated` frame with `commentCountDelta: 1, headShaChanged: false`.
Stub `getPrDetail`'s second call to return the *same* id set. Assert `reload-banner` is absent.
This is **RED on main** — today `formatMessage` returns `"1 new comment — Reload to view"` the
moment the frame lands, with no fetch and no diff. It is scenario-pinned (it names #740's sequence),
not rule-pinned: a future change that re-derives the count from a different field still has to keep
this green.

Companions, same layer:
- A frame whose refetch introduces a foreign id `c-other` → banner reads `"1 new comment"`.
- Two frames (self, then foreign) → banner reads `"1 new comment"`, **not** `"2"` — pins the
  accumulator fix (§4-E *Bonus*).
- A frame arriving with a SHA change *and* a self-only comment rise → `"Iteration N — Reload to
  view"` with no comment clause. Joint-frame copy is preserved.
- `getPrDetail` rejects → banner shows with the raw delta. Pins **fail-open**.

**Backend (`PRism.Core.Tests`).** E changes no backend code, but it *depends* on the poller emitting
a comment-count frame at all — if that stopped, E would silently never banner. That gate
(`ActivePrPoller.cs:286`) has **no dedicated test** today. Add one characterization test,
`Publishes_comment_delta_when_inline_count_rises`. `TickAsync` is `internal`, reachable via
`InternalsVisibleTo` (`PRism.Core.csproj:22`); drive it with an explicit `now`. It is green on main
by construction — it is a guard, not the regression gate. **Do not use `PRism.Core.Tests`'
`FakeReviewEventBus` for any subscription path** — its `Subscribe` returns `NullDisposable` and never
invokes handlers (`FakeReviewEventBus.cs:28-29`); use the real `ReviewEventBus`.

**e2e — unchanged.** `no-layout-shift-on-banner.spec.ts:92-95` drives `headShaChanged: true,
commentCountDelta: 0`, which E leaves on the untouched SHA path; a grep of all of `frontend/e2e` for
`"new comment"` returns zero matches. No mock bodies need editing.

## 7. Why no end-to-end test for this bug

Under `PRISM_E2E_FAKE_REVIEW=1`, `Program.cs:135-164` swaps ten seams but **not**
`IActivePrBatchReader` — the poller keeps the real `GitHubActivePrBatchReader`
(`ServiceCollectionExtensions.cs:150`), which needs a token; without one the read yields nothing and
the tick's catch-all (`ActivePrPoller.cs:260-268`) publishes nothing. `FakeReviewSubmitter` records
created comments only into an introspection list read by `/test/submit/inspect-review-comments`;
**nothing connects it to any count the poller reads**, so the fake's inline-comment count can never
rise. `/test/emit-pr-updated` publishes `ActivePrUpdated` straight onto the bus, bypassing the poller,
and carries no origin correlation. (Note `PRism.Web/TestHooks/FakePrBatchReader.cs` implements the
*inbox* `IPrBatchReader` — a different interface.)

An e2e would require a fake `IActivePrBatchReader` in the e2e DI swap whose `CommentCount` rises with
the fake submitter. Net-new infrastructure; filed as a follow-up rather than smuggled in here.

## 8. Follow-ups (not this PR)

- **#279** — this closes one member of the banner family; the umbrella's baseline ACs remain.
- **#437** — `useActivePrUpdates` boolean-latches `headShaChanged`/`baseShaChanged` (`s.x || event.x`).
  Same bug class as the comment-delta accumulation. Untouched here.
- **#106** — the write path's knowledge of what it created is the same seam #106 needs for
  marker-based adoption.
- New: fake `IActivePrBatchReader` for the e2e DI swap (§7), which would make this bug
  e2e-reproducible.
- New: `reviewThreads(first:100)` is unpaginated in both readers; comments past the window are
  invisible to the banner. Pre-existing, unchanged by E.

## 9. Review record

6-persona `ce-doc-review`, one pass. `ce-feasibility-reviewer` returned **zero findings** — all ten
falsifiable codebase claims verified true. The other five produced 20 findings; dispositions are in
the PR's `## Proof` section. The material ones, all **Applied**, rewrote this doc: the #450 principle
inheritance was backwards (§2.1), the option space omitted the origin-keyed class (§4-E), §4-A and
§4-B were overstated, the semantics question was assumed rather than asked (§3), and D's design
surface was undercounted (§4-D).

**Post-gate correction (2026-07-10), found while pinning E's seams for the plan.** §4-E named
`databaseId` as the identity key. That field is `number | null | undefined` in the DTO
(`api/types.ts:324`) — a null id would read as "unseen" and re-raise the banner it exists to
suppress. Corrected to `commentId`, the non-nullable node id. The same pass deleted two costs the
first sketch of E carried: the shadow buffer (nothing is auto-applied, so the payload is simply
discarded) and the cross-tab self-posted-id ledger (redundant with #450's auto-reload). Both are
recorded in §4-E.
