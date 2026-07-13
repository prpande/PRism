# Reload banner fires for the user's own actions

- **Issue:** [#740](https://github.com/prpande/PRism/issues/740)
- **Date:** 2026-07-10
- **Status:** Design — **LOCKED**. Semantics gate answered 2026-07-10: **origin reading (§3)**. Option gate answered 2026-07-13 (owner, in-session): **option G — net self-posts at the poller (§5)**, scoped after a 5-persona `ce-doc-review` to the **single inline comment/reply path** (§9). Implementation plan: `docs/plans/2026-07-10-reload-banner-self-origin.md`.
- **Tier / Risk:** T3 / gated — B1 (`needs-design`, rendered chrome) **and** B2 (behavioral architectural invariant: *Banner, not mutation*).
- **Surfaces:** PR detail (`BannerRefresh`). **Backend-only** under G — the whole change lives in `ActivePrPoller`. **No frontend edit, no SSE wire change, no bus-record change, no GraphQL / DTO / batch-reader change.**

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
3. `ActivePrUpdated.cs` — the event carries SHAs, counts, merge-readiness and
   reviewer *rosters*, but **no comment-level author or comment id**. Nothing identifies
   *who* wrote the comment or *which* comment it was.
4. `SseEventProjection.cs:84-88` — projects `commentCountDelta` to the wire; no actor.
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
`snapshot.CommentCount` = `CountReviewComments(pr)` (`GitHubActivePrBatchReader.cs`),
the sum over `reviewThreads.nodes.comments.totalCount`. A root issue comment moves a
*separate* `IssueCommentCount`, tripping `issueCommentChanged`
(`ActivePrPoller.cs:301-302`), which publishes `CommentCountChanged: false,
CommentCountDelta: 0`. `formatMessage` emits nothing. **The root-comment path needs no
fix and G does not touch it.** (Posted to the issue.)

### 1.3 The constraint that rules out the obvious fix

Calling `clearUpdates()` on the self-post path **cannot** work. The offending
`pr-updated` frame does not exist yet at post time — it arrives up to one poll tick
(~30s) later and re-raises `hasUpdate` after the clear. This is why the fix carries the
self-post knowledge forward from the write path to the poll frame; it cannot be
resolved at the moment of posting.

## 2. Prior art

`docs/specs/2026-06-12-eliminate-reload-banners-design.md` (#450, **shipped** —
`InboxBanner` deleted, `useSingleCommentPostedSubscriber` exists) set the governing rule:

> **auto-apply when no in-flight user work (unsaved drafts, line-anchored selections,
> an open composer) can be invalidated; require explicit consent otherwise.**

It fixed the comment path's *reply-ability* (auto-reload on `single-comment-posted`) and
never touched `BannerRefresh.formatMessage`, whose `commentCountDelta > 0` arm has been
unchanged since the original slice (`25d46159`, confirmed by `git blame`). **#740 is the
bug that leftover arm produces.**

The same #450 work already stood up **exactly the seam G reuses**: `PrDetailLoader`
subscribes to `SingleCommentPostedBusEvent` on the bus to evict its snapshot
(`PrDetailLoader.cs:120`). The write path already announces "PRism just posted this" on
the bus; today the poller ignores it. G makes the poller listen.

### 2.1 What #450's principle says about *inbound* comments

- The principle's enumeration of in-flight work that forces consent explicitly includes
  **"an open composer."** #450 granted *auto* to the comment-post case **because** "the
  composer has already closed on post"; that condition holds for **your own** post and
  fails for a stranger's comment landing while you are mid-reply.
- By #450's rule, the correct disposition for an inbound comment arriving with an open
  composer is **consent (a banner)**, not auto-apply. Any option that auto-applies inbound
  comments must carry an explicit composer gate — it cannot inherit safety from #450.

The `Banner, not mutation` invariant (`.ai/docs/architectural-invariants.md:10`) reads:

> Remote state never auto-applies to the diff under the cursor or to the reviewer's drafts.
> Polling produces a non-intrusive banner; reload is explicit. The narrow exception is
> informational **widgets** about other people's content (existing comment bodies,
> thread-state badges).

The exception names *display widgets*, not a page-level reload that swaps the reviewer's
thread list mid-review. **G upholds this invariant untouched**: it changes only *whether a
banner is raised*, never *what a banner does*. Reload stays explicit; nothing auto-applies.

## 3. DECISION 1 — what does the banner mean? → **origin** (locked 2026-07-10)

This had to be answered **before** the option choice, because it eliminates options.

- **Origin reading:** "PRism did not cause this." Suppress only what PRism itself wrote.
- **Seen/unseen reading:** "you have not looked at this." Suppress anything already rendered.

They diverge: a comment you author on github.com in a browser is *your* action, but PRism
did not originate it and does not have it locally. Under the origin reading it **should
banner** (PRism did not cause it); under the seen/unseen reading it should not (you wrote it).

**#740's own words select the origin reading** — *"The banner should signal only **external**
changes"*, and Desired-behavior keeps bannered *"comments/reviews added on GitHub or by
another client."* A comment you typed in a browser tab is "another client," so #740 wants it
bannered. That is the origin reading, and it eliminates every option that suppresses by
seen-ness (B, D, E below).

**Origin is most cheaply known at the write path.** "PRism caused this" is a fact the
comment-POST endpoint holds directly and publishes on the bus. It is *technically*
recoverable downstream too — the submit pipeline stamps a `prism:client-id` marker into
every posted comment body (`SubmitPipeline.cs`) — but reading it back requires the batch
reader to fetch comment bodies/ids, the same GraphQL + DTO change §8 weighs and declines.
So the cheapest origin-faithful signal is the write-path bus event, which forces the fix to
originate where the write path already speaks and carry that knowledge to the poller. This
is the through-line to §5's choice of G.

## 4. Options

The semantics gate (§3) partitions the field. **Origin-faithful:** A, C, G carry the
write path's "PRism did this" fact forward and suppress on it. **Seen/unseen (rejected by
§3):** B, D, E reconstruct seen-ness downstream and suppress on that. Costs are stated
symmetrically.

### G — net self-posts at the poller — **CHOSEN** (scoped to the single-comment path)

The poller already holds the bus (`_bus`) and already Publishes on it; it simply never
Subscribes. G makes it subscribe to the write-path event, keep a per-PR credit of
self-posts not yet reconciled against GitHub's inline count, and net that credit out of each
tick's observed rise before deciding whether to banner. Option **A** was the same idea
sketched without the corrections below; G is A made correct and scoped.

**The netting, precisely.**

- The poller subscribes to `SingleCommentPostedBusEvent` (→ credit +1), the event the write
  path already publishes on a single inline comment or reply post and `PrDetailLoader`
  already subscribes to. The subscription is held as `IDisposable` and released in
  `Dispose()`, mirroring `PrDetailLoader`.
- Each tick, for each polled PR, before the comment gate:
  `rawDelta = snapshot.CommentCount − LastCommentCount` (the existing `:318` quantity);
  `consumed = min(credit, max(0, rawDelta))`; `credit −= consumed`;
  `externalDelta = rawDelta − consumed`.
- The comment gate and the published delta both switch to `externalDelta`:
  `commentChanged = (LastCommentCount is { } pc && pc != snapshot.CommentCount) && externalDelta != 0`;
  the published `CommentCountDelta = externalDelta`. **`LastCommentCount` still advances
  unconditionally (`:342`)** — a suppressed self-post tick still moves the baseline, so the
  same rise is never re-observed and never re-consumed. (Verified: the state update sits
  outside the publish `if` and after the per-alias-drop `continue`.)
- **On a PR's first poll, its credits are cleared.** firstPoll establishes the baseline
  from the current count (`LastCommentCount` was null), which silently folds in any
  self-rise that landed before the baseline tick; a credit predating that baseline is
  therefore already reconciled and would otherwise orphan. Clearing on firstPoll removes
  that orphan class (and the subscribe→post→firstPoll startup race).
- Credits are pruned alongside `_state` when a PR loses all subscribers
  (`ActivePrPoller.cs:231-234`). The credit map is mutated by the write thread (synchronous
  `bus.Publish` inside the POST) and read/decremented by the poller thread; one lock guards
  every credit read/write. `ActivePrPollerState` stays tick-only.

**Why it is origin-faithful, not seen/unseen.** The credit is created by the *write* event
("PRism posted") and destroyed by the *observed rise it caused*. A comment you authored on
github.com never creates a credit, so it is never netted — it banners. That is the origin
reading, implemented at the one place origin is cheaply known.

**Multi-poster in one window is preserved.** You post (credit 1) and a teammate comments in
the same ~30s window: `rawDelta = 2`, `consumed = 1`, `externalDelta = 1` → the teammate is
still announced.

**The count-based residual — bounded, honest.** A blind credit nets against *the count
rise*, not against the specific comment PRism posted, so it cannot always tell which +1 it
absorbed. Three cases:

- *Pure count-lag (common, benign).* If GitHub's count reflects a teammate's comment before
  yours, your credit absorbs the teammate's rise this tick and your own rise banners next
  tick. The arithmetic conserves: exactly one banner for the one external comment, the
  teammate's comment revealed on the reload it prompts, announced ≤1 tick (~30s) late. **No
  comment is lost.**
- *Deletion-in-window (rare).* If a review comment is deleted in the same window as your
  post — masking your +1 — the credit can absorb a teammate's rise with no compensating rise
  to re-announce it. The banner **nudge** for that teammate's comment is then missed for that
  window.
- *Never-landing self-post (rare).* If your post's count-rise never surfaces (the count is
  blind to it — e.g. a comment beyond `reviewThreads(first:100)`), the credit can absorb a
  foreign rise inside its live window.

In the two rare cases the foreign comment is **not lost** — it is in the PR, appears on any
Reload, and is re-rendered by any later frame; what is missed is the proactive banner
*nudge* for it, in that window. This is the same risk class as the pre-existing
`first:100`-thread blind spot the banner already carries (§8). The claim is therefore not
"no external change is ever swallowed" but **"the banner nudge for a foreign comment can be
missed only in a rare interleaving (a deletion or a never-landing self-post coinciding with a
foreign comment in one poll window), the comment itself is never lost, and the exposure is
bounded by expiry."** The complete, nudge-safe fix is id-based netting (§8), declined here
for its GraphQL + DTO cost.

**Expiry bounds — not eliminates — the exposure.** A credit whose matching rise never lands
must not linger and consume a *much later* foreign rise. Each credit ages by poll tick; after
**N = 2 ticks** unconsumed it is dropped. This bounds an unconsumed orphan credit's life to
≤2 ticks (~60s) — long enough for GitHub's count to reflect your post on the normal path,
short enough to bound the window in which a stale credit could absorb a foreign rise. Expiry
does **not** eliminate that ≤N-tick window: a credit consumed by a foreign rise *before* it
ages out is the deletion/never-landing case above, which expiry cannot prevent (only id-based
netting can). Expiry's failure direction is safe: it drops a credit, at worst leaking a
recoverable self-banner, never hiding a foreign one.

### A — Poller-local counter (as originally sketched)

G's idea without its corrections: no firstPoll credit-clear, no expiry, no honest residual
accounting, and it reached for the batch path (§8) without a correct K. Superseded by G.

### B — Absolute-count reconciliation across two readers

Ship the absolute inline-comment count; banner iff `serverCount > lastRenderedCount`.
Implements the **seen/unseen** reading (rejected by §3). Also: both readers select
`reviewThreads(first:100)` with no `orderBy`; above 100 threads nothing proves the two
queries return the same 100 threads, so `serverCount != detailCount` can become permanent →
a banner Reload cannot clear.

### C — Client-side blind delta absorption

Hold the pending credit *client-side*, net it against the incoming delta. Origin-faithful in
spirit, but the credit must survive ~30s across reload, unmount, and keep-alive tab switches,
and it sits on top of `useActivePrUpdates`' accumulating (and signed — negative on deletion)
`commentCountDelta`. G moves the identical netting to the server, where the state is
long-lived by construction and the accumulator is not in the path.

### D — Retire the comment arm; auto-apply inbound comments

Banner renders only for head-/base-SHA changes; comment-only frames silently `reload()`.
Implements the **seen/unseen** reading, maximally. Contradicts the #450 principle cited to
justify it (§2.1 — needs an explicit composer gate whose state lives in
`useInlineComposer`/`useDraftSession`); overrides #740's explicit *"the banner remains for
genuinely external changes"*; makes awareness *missable* with no per-row fallback; and names
the wrong primitive (`Snackbar` persists; `Toast` auto-dismisses) and `aria-live` region.

### E — Client-side identity diff (single-reader)

On a comment-only frame, re-fetch the PR detail and count review-comment ids **absent from
what the client has already rendered**; that count drives the banner. Implements the
**seen/unseen** reading via a rendered-set proxy. It only *coincides* with origin because
#450 has already auto-reloaded PRism's own post into the rendered set by the time the frame
lands; it diverges when an external comment is pulled in by a manual Refresh (it then
suppresses a genuinely external comment). It reconstructs on the client, per PR-detail tab, a
fact the server holds once, and pays ≤1 extra detail GET per comment-change tick. **This was
the previously-locked choice; it is withdrawn** in favor of G (source-side suppression, no
frontend change).

*One honest note in E's favor.* Because E diffs comment **ids**, it does not carry G's
count-based residual — E would banner the teammate's comment in the deletion/never-landing
cases. That id-safety is the property G trades away for landing at the source with no
frontend change; the equivalent server-side id-safe design is the §8 follow-up.

## 5. DECISION 2 — the option → **G**, single-comment path (locked 2026-07-13, owner in-session)

Follows from §3's origin reading. Origin is cheapest at the write path (§3), so the fix
belongs where the write path already speaks — the bus — and G is the option that listens
there. It satisfies #740's core cases (a browser-authored comment still banners; a teammate
in the same window still banners), preserves consent (nothing auto-applies), and lands
entirely in the backend: no frontend edit, no SSE wire change, no bus-record change, no
GraphQL / DTO / batch-reader change.

**Why not do nothing, and why not more.** The null option — accept the cosmetic self-banner —
was weighed: the defect has no measured harm (§1), but a banner that cries wolf on the
reviewer's own routine action is a coherence defect worth the small, contained fix. The
*minimal* fix — net only the single inline comment/reply path — is what is chosen; the
review-submit (batch) path is **deferred** (below), keeping this PR to the literally verified
#740 repro and off the K-computation hazard that path carries.

**Scope boundary.** G fixes the self-post banner for the **single inline comment/reply** path
(`SingleCommentPostedBusEvent`) only. It does **not** cover review submit (§8 — its correct K
is the count of comments the submit *newly posted*, not the pre-submit draft count, which
over-counts on resume/adopt/stale and would risk missing a foreign nudge). It does **not**
fix the `reviewThreads(first:100)` blind spot, does **not** net by comment id (the bounded
residual, §4-G / §8), does **not** fix #437's boolean latch, and does **not** touch the
root-comment path (§1.2). Each is tracked separately (§8).

**Rejected, and why.**

- **E** (client-side identity diff) — the prior choice, withdrawn. Implements seen-ness, not
  origin (§3/§4-E); diverges from #740's ask when an external comment was manually Refreshed
  in; reconstructs on every PR-detail tab a fact the server holds once. Its one advantage
  (id-safety) is the §8 follow-up's target.
- **A** — G's idea without firstPoll-clear, expiry, or honest residual accounting.
- **B** (absolute-count reconciliation) — wrong reading (seen-ness), and two unordered
  `first:100` readers can permanently disagree above 100 threads.
- **C** (client-side blind absorption) — G's netting without the server's durable state, sat
  on top of the signed client accumulator.
- **D** (retire the comment arm; auto-apply) — contradicts the #450 principle cited to
  justify it (§2.1) and overrides #740's explicit *"the banner remains for genuinely external
  changes."*

## 6. Testing strategy

The fix is in the poller, so the regression gate is in the poller — **`PRism.Core.Tests`
(xUnit) is the primary layer**. `TickAsync` is `internal`, reachable via `InternalsVisibleTo`
(`PRism.Core.csproj`), and takes an explicit `now`. **Do not use `FakeReviewEventBus`** for
any subscription path — its `Subscribe` returns `NullDisposable` and never invokes handlers;
use the real `ReviewEventBus`, with a recording handler subscribed to it to capture published
`ActivePrUpdated`s (the poller's existing tests assert via the fake bus's `Published` list,
which the real bus does not expose).

**The red-on-main scenario test.** Baseline tick with `CommentCount: 2`. Publish a
`SingleCommentPostedBusEvent` for the PR on the real bus. Second tick with `CommentCount: 3`.
Assert **no `ActivePrUpdated` with `CommentCountChanged: true`** is published. This is **RED
on `main`** — today the poller does not subscribe, so the second tick publishes
`CommentCountChanged: true, CommentCountDelta: 1`.

Companions, same layer:
- **Teammate in the same window** — one `SingleCommentPostedBusEvent`, count rises by 2 →
  one frame with `CommentCountDelta: 1` (the teammate is announced; the self-post is netted).
- **Expiry / fail-open** — one credit, then N+1 ticks with no reconciling rise; on the next
  real rise the frame publishes `CommentCountDelta: 1` (the stale credit did not swallow it).
- **firstPoll clears credits** — publish a credit for a PR with no state, then run its first
  poll at a count that already includes the self-post, then a foreign rise → the foreign rise
  banners (the orphan credit was cleared at baseline).
- **Deletion untouched** — no credit, count *drops* → `commentChanged` still fires with a
  negative delta (G nets only positive rises; existing behavior preserved).

**The bounded residual is documented, not tested green.** The deletion-in-window and
never-landing cases (§4-G) are known limitations of count-based netting, not behaviors to
assert; id-based netting (§8) is where they close.

**Frontend — unchanged.** G touches no frontend file. The existing banner behavior (render
iff `commentCountDelta > 0`) is correct once the poller stops emitting the self-caused frame;
no vitest change, and `frontend/e2e` mock bodies are untouched. The "2 new comments"
over-count (`useActivePrUpdates` accumulating self + teammate) is fixed as a side effect — the
self frame is never emitted, so the accumulator only ever sees external deltas.

## 7. Why no end-to-end test for this bug

Under `PRISM_E2E_FAKE_REVIEW=1`, `Program.cs` swaps ten seams but **not**
`IActivePrBatchReader` — the poller keeps the real `GitHubActivePrBatchReader`, which needs a
token; without one the read yields nothing and the tick's catch-all publishes nothing.
`FakeReviewSubmitter` records created comments only into an introspection list; nothing
connects it to any count the poller reads, so the fake's inline-comment count can never rise.
`/test/emit-pr-updated` publishes `ActivePrUpdated` straight onto the bus, bypassing the
poller *and its netting*, so it cannot exercise G. An e2e would require a fake
`IActivePrBatchReader` in the e2e DI swap whose `CommentCount` rises with the fake submitter
*and* whose ticks run the real netting. Net-new infrastructure; filed as a follow-up (§8).

## 8. Follow-ups (not this PR)

- **Review-submit (batch) self-banner.** The same defect on the submit path
  (`DraftSubmitted`). Deferred because its correct credit is the number of inline comments the
  submit *newly posted* — not the pre-submit draft count, which over-counts when the pipeline
  adopts an already-posted thread (resume) or excludes stale drafts, risking a missed foreign
  nudge (the forbidden direction). Do it by threading an actual-posted count through
  `SubmitOutcome.Success`, not from the session snapshot.
- **Net by comment id** — the complete, nudge-safe replacement for G's count-based netting,
  closing the deletion-in-window and never-landing residuals (§4-G). Needs the batch reader to
  return per-comment ids (GraphQL + DTO change); would *replace* G's count arithmetic, not
  augment it.
- **#279** — this closes one member of the banner family; the umbrella's baseline ACs remain.
- **#437** — `useActivePrUpdates` boolean-latches `headShaChanged`/`baseShaChanged`
  (`s.x || event.x`). Same bug class as the comment-delta accumulation. Untouched here.
- New: **fake `IActivePrBatchReader` for the e2e DI swap** (§7), which would make this bug
  e2e-reproducible.
- New: `reviewThreads(first:100)` is unpaginated in both readers; comments past the window are
  invisible to the banner. Pre-existing, unchanged by G.

## 9. Review record

**Semantics + first option pass (2026-07-10).** A 6-persona `ce-doc-review` on the original
draft rewrote the semantics analysis: the #450 principle inheritance was backwards (§2.1), the
option space omitted the origin-keyed class, and the semantics question (§3) was assumed
rather than asked. `ce-feasibility-reviewer` returned zero findings against ten falsifiable
claims. That pass locked DECISION 1 (origin) and, at the time, DECISION 2 (option E).

**Option re-decision (2026-07-13).** Reviewing E for implementation, the owner challenged the
"frontend-only" premise. It does not survive: origin is cheapest at the write path (§3), so a
frontend-confined fix must reconstruct origin on the client from the rendered set — the
seen/unseen proxy — which diverges from #740's ask on a manually-Refreshed external comment.
DECISION 2 was re-opened and re-answered **G** (net at the poller).

**Second machine pass (2026-07-13) — 5 personas on the G rewrite.** coherence and feasibility
returned zero findings; feasibility verified all six falsifiable code claims (unconditional
`LastCommentCount` advance at `:342`; wire-invisible via `SseEventProjection.cs:111`; K
discriminator `DraftComment.IsPrRoot => FilePath is null` at `AppState.cs:106`; synchronous
`Publish` + `IDisposable Subscribe`; `InternalsVisibleTo` test seam; netting invariant safe
across tick edges). The adversarial and scope-guardian passes drove three material changes,
all applied here:

- **Scope narrowed to the single-comment path.** The batch (review-submit) K, defined from the
  pre-submit session, *over-counts* on resume/adopt/stale (`SubmitPipeline.cs:294-302`) — the
  forbidden direction (a foreign nudge missed). Deferred to §8 with the correct definition.
- **The "never swallow" guarantee was overstated.** Count-based netting can miss the banner
  nudge for a foreign comment in a deletion-in-window or never-landing interleaving; §4-G now
  states this honestly (bounded, comment not lost, id-based netting is the complete fix) and
  §4-E credits E's id-safety as the property G trades away. The owner accepted the bounded
  residual (2026-07-13, in-session) over escalating to id-based netting now.
- **A firstPoll credit-clear guard and an honest expiry statement** were added (§4-G): expiry
  *bounds* the ≤N-tick exposure rather than eliminating it, with the N=2 rationale stated.

Product-lens's advisory (cost the null/minimal option) is addressed in §5; the batch-defer
also answers its "batch path not independently reproduced" note. Full dispositions ride in the
PR's `## Proof`.
