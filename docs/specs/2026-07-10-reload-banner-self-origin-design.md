# Reload banner fires for the user's own actions

- **Issue:** [#740](https://github.com/prpande/PRism/issues/740)
- **Date:** 2026-07-10
- **Status:** Design — **awaiting human gate (B2)**. Two decisions are open (§3, §5). No implementation proceeds until both are answered.
- **Tier / Risk:** T3 / gated — B1 (`needs-design`, rendered chrome) **and** B2 (behavioral architectural invariant: *Banner, not mutation*).
- **Surfaces:** PR detail (`BannerRefresh`), `ActivePrPoller`, `pr-updated` SSE frame.
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

## 3. GATE DECISION 1 — what does the banner mean?

This must be answered **before** the option choice, because it eliminates options.

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

### E — Client-side identity diff (single-reader) — **new; not in the first draft**

Implements the **origin** reading, which is what #740 asks for.

On a comment-only `pr-updated` frame (used purely as a *trigger*, never as truth), the client
fetches the PR-detail snapshot into a shadow buffer and diffs the review-comment `databaseId`
set against the ids it has already rendered. Ids PRism itself posted are already rendered (the
#450 auto-reload put them there). If every unseen id is one PRism wrote → **no banner**. If any
unseen id is not → **banner**, with an accurate count, and **no auto-apply** (consent preserved).

*Why it is sound where B is not:* both sides of the comparison come from the **same reader**
(`GetPrDetailAsync`), so the `first:100` window cannot diverge against itself. Reload swaps the
shadow buffer in, and the id sets converge. No stuck banner. No wire change, no GraphQL change,
no DTO change. `Banner, not mutation` is untouched: nothing auto-applies.

*Cost / risk.*
- One extra PR-detail GET per comment-change tick. `PrDetailLoader.cs:146` already evicts the
  snapshot on `CommentCountChanged`, so this is the same fetch Reload would have made — brought
  forward. On a large PR that is a real, repeated cost paid whenever **anyone** comments.
- Needs a shadow snapshot so the prefetch does not mutate the rendered view before consent.
- Inherits today's `first:100` blind spot (a comment in thread #150 never triggers). No regression.
- Ids are per-repo monotonic, so "unseen" is well-defined; but the client must persist the set of
  ids it posted across a keep-alive tab switch.

## 5. GATE DECISION 2 — the option

Conditional on §3.

- **If the origin reading (what #740 says) → E.** It satisfies the issue literally, keeps the
  banner for external comments, preserves consent, needs no wire change, and avoids B's cross-reader
  hazard. Fall back to **A** (with credit expiry, accepting the same-window blind spot) if the extra
  detail GET is judged too expensive.
- **If the seen/unseen reading → B (with the single-reader clamp) or D.** B keeps a persistent,
  un-missable signal at the cost of the pinned-query change and the e2e mock sweep. D is smaller in
  the banner itself but carries the full design surface in §4-D and requires amending #740.

**Neither B nor D is implementation-ready as written.** B needs its reconciliation approach chosen
(clamp vs paginate). D needs the composer gate, the toast/snackbar decision, the debounce, the
`active` gate, a persistent fallback cue, and joint-frame copy. E is the only option currently
specified to the level where a plan could be written directly from it.

## 6. Testing strategy

Red-on-main is achievable at the vitest layer for every option; a full Playwright e2e is **not
feasible** for this bug under any option (§7). `development-process.md` mandates a regression test
failing on `main`; the vitest-level test is that gate.

**Under E (recommended if §3 → origin):**
- `useActivePrUpdates` / the new diff hook: a comment-only frame whose unseen ids are all
  PRism-posted leaves `hasUpdate === false`. **RED on main** (today `hasUpdate` is set
  unconditionally, so the banner appears). One whose unseen ids include a foreign id sets it.
- `BannerRefresh` unchanged — the count it renders now comes from the id diff.
- Scenario-pinned, not rule-pinned: the test names the #740 scenario ("post a comment, then a poll
  tick reports the rise") rather than asserting a rendering rule.

**Under D:** `BannerRefresh` with `commentCountDelta={1} headShaChanged={false}` renders nothing.
This **is** RED on main (verified: `formatMessage` returns `"1 new comment — Reload to view"`). But
it pins the *rendering rule*, not the #740 *scenario* — a future change that sets `hasUpdate` from a
new field could reintroduce the defect with this test green. Add a scenario test regardless.

**Backend (`PRism.Core.Tests`)** — the inline `commentChanged` gate (`ActivePrPoller.cs:286`) has
**no dedicated test** today. Add `Publishes_comment_delta_when_inline_count_rises` under every option.
`TickAsync` is `internal`, reachable via `InternalsVisibleTo` (`PRism.Core.csproj:22`); drive it with
an explicit `now`. **Do not use `PRism.Core.Tests`' `FakeReviewEventBus` for any subscription path** —
its `Subscribe` returns `NullDisposable` and never invokes handlers (`FakeReviewEventBus.cs:28-29`);
use the real `ReviewEventBus`.

**e2e** — unchanged under D and E. `no-layout-shift-on-banner.spec.ts:92-95` drives
`headShaChanged: true, commentCountDelta: 0`; a grep of all of `frontend/e2e` for `"new comment"`
returns zero matches.

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
  marker-based adoption; E's client-side id set is a cheaper cousin.
- New: fake `IActivePrBatchReader` for the e2e DI swap (§7).
- New: `Snackbar` has no neutral tone (`'warning' | 'danger'`). Any informational use needs one.

## 9. Review record

6-persona `ce-doc-review`, one pass. `ce-feasibility-reviewer` returned **zero findings** — all ten
falsifiable codebase claims verified true. The other five produced 20 findings; dispositions are in
the PR's `## Proof` section. The material ones, all **Applied**, rewrote this doc: the #450 principle
inheritance was backwards (§2.1), the option space omitted the origin-keyed class (§4-E), §4-A and
§4-B were overstated, the semantics question was assumed rather than asked (§3), and D's design
surface was undercounted (§4-D).
