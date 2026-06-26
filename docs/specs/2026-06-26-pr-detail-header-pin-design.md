# PR-detail header pin — only tab content scrolls (#640)

**Status:** design · **Tier:** T2 · **Risk:** B1 (UI-visual, human visual gate)
**Issue:** [#640](https://github.com/prpande/PRism/issues/640)

## Problem

On the PR-detail page, scrolling inside the **Overview**, **Hotspots**, or
**Checks** tab scrolls the *whole document*, so the PR header (title/metadata)
and the sub-tab strip scroll off the top of the screen. The **Files** tab does
not have this problem — its header stays pinned and only the diff scrolls.

Expected (master-detail / app-shell behavior): the header + sub-tab strip stay
fixed; only the active tab's content scrolls.

## Root cause

`PrDetailView` renders `[data-app-scroll] → .pr-detail-page → PrHeader → banners
→ <div data-subtab="…">{tab}</div>`. In the browser, `[data-app-shell]` and
`[data-app-scroll]` are unstyled passthrough divs and the **document** scrolls.

The Files tab pins its header through a viewport-binding chain in `tokens.css`,
gated on a `data-files-active` marker that `PrDetailView` stamps on
`[data-app-scroll]` only while it is the *active* view showing Files:

```
[data-app-shell]:has([data-app-scroll][data-files-active]) { height:100dvh; display:flex; flex-direction:column; overflow:hidden; }
[data-app-shell]:has([data-app-scroll][data-files-active]) > * { flex-shrink:0; }
[data-app-scroll][data-files-active]                       { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; }
[data-files-active] .pr-detail-page:not([hidden])          { min-height:100%; display:flex; flex-direction:column; }
[data-files-active] .pr-detail-page:not([hidden]) > *      { flex-shrink:0; }
[data-files-active] [data-subtab='files']:not([hidden])    { flex:1 1 0; min-height:360px; display:flex; flex-direction:column; }
[data-files-active] [data-subtab='files']:not([hidden]) > .files-tab { flex:1 1 0; min-height:0; }
```

That chain binds the shell to the viewport (`height:100dvh; overflow:hidden`),
makes `[data-app-scroll]` the bounded scroll region, makes `.pr-detail-page` a
flex column whose rigid children (header + banners) never shrink, and makes the
Files slot the flex child that fills the remaining space and scrolls internally.

For the other tabs **no marker is set**, so none of this applies: the document
scrolls and the un-`sticky` `.prHeader` scrolls away. (Note: `.overviewTab`
already declares `overflow:auto` — it never engages only because its ancestors
are unbounded, so it grows to content height instead of scrolling.)

## Goal / acceptance criteria

- On **Overview, Hotspots, Checks**: the PR header + sub-tab strip stay pinned;
  only the tab content scrolls (the document itself does not scroll).
- **Files unchanged** — its `#191/#156/#155/#590` internal-diff-scroll and
  inner-scroll-restore contracts must not regress.
- One consistent scroll model across all four tabs (not a second, divergent one).

## Decision: generalize the marker (parallel `data-detail-active`)

`PrDetailView`'s marker effect stamps **one** marker on `[data-app-scroll]`,
gating `data-detail-active` to exactly the three in-scope sub-tabs:

```ts
const isPinned = subTab === 'overview' || subTab === 'hotspots' || subTab === 'checks';
slot.toggleAttribute('data-files-active', subTab === 'files');
slot.toggleAttribute('data-detail-active', isPinned);
// cleanup — BOTH markers removed (load-bearing: a leaked data-detail-active
// binds the inbox/other views' shell to 100dvh/overflow:hidden):
return () => {
  slot.removeAttribute('data-files-active');
  slot.removeAttribute('data-detail-active');
};
```

The markers are **mutually exclusive** (a view shows exactly one sub-tab), so the
Files rules and the new rules never apply to the same element at the same time.
**Drafts — and any sub-tab added later — get NO marker**, so they keep today's
behavior unchanged until a deliberate decision adds them to `isPinned`. That is
why the marker is an explicit allow-list rather than `subTab !== 'files'`:
`DraftsTab` may host its own internal-scroll composer regions whose interaction
with a slot-level `overflow-y:auto` is unanalyzed, and the issue's scope is
Overview/Hotspots/Checks only.

`tokens.css` gets a parallel block that reuses the *same* shell/scroll/page
chain but, for the visible non-Files slot, makes the **slot itself** the bounded
internal scroller:

```
[data-app-shell]:has([data-app-scroll][data-detail-active]) { height:100dvh; display:flex; flex-direction:column; overflow:hidden; }
[data-app-shell]:has([data-app-scroll][data-detail-active]) > * { flex-shrink:0; }
[data-app-scroll][data-detail-active]                      { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; }
[data-detail-active] .pr-detail-page:not([hidden])         { min-height:100%; display:flex; flex-direction:column; }
[data-detail-active] .pr-detail-page:not([hidden]) > *     { flex-shrink:0; }
[data-detail-active] [data-subtab]:not([hidden])           { flex:1 1 0; min-height:360px; overflow-y:auto; overflow-x:hidden; }
```

`min-height:360px` (not `0`) is a deliberate floor mirroring the Files slot: when
the pinned header stack (PrHeader + banners + a tall `UnresolvedPanel`) exceeds
the viewport, a `min-height:0` slot would flex-collapse to zero and the
`[data-app-scroll]` escape-hatch would scroll only to the header, leaving the
content slot unreachable. The floor keeps the slot a non-zero internal scroller,
so the page scrolls (via the escape hatch) to reveal a tall header *and* the
content stays reachable below it. `overflow-x:hidden` is on the **slot** (the
actual scroller) — not only on `[data-app-scroll]` — because setting
`overflow-y` non-visible forces the UA to compute `overflow-x:auto` (CSS Overflow
§3), which a wide code block / table in tab content would otherwise surface as a
spurious horizontal scrollbar.

Because the marker is set only for the three tabs, the rule matches exactly the
visible in-scope slot — no need to enumerate tab ids in the selector. The
centered content columns
(`.overviewTab`, `.hotspots`, `.checks`) sit at natural height inside the
full-width slot, so the scrollbar lands at the **viewport edge** (matching the
Files model), not at the inner column edge.

### Why this mechanism

- **Files stays byte-identical.** The Files rules and marker are untouched, so
  the diff-scroll / inner-scroll-restore contracts carry zero risk. The
  `useLayoutEffect` ordering note and `useTabScrollMemory` / `useDiffScrollRestore`
  continue to key off `[data-app-scroll]` and `data-files-active`. Note this does
  **not** mean non-Files scroll-position memory keeps working — see "Scroll-
  position memory" under Risks. It means the Files path is undisturbed.
- **One scroll model.** Every tab now pins the header via the same shell-binding
  chain; the only per-tab difference is *what* scrolls internally (the diff for
  Files, the slot for the rest).
- **Smaller diff than the issue's literal suggestion.** Making the *slot* the
  scroller (one rule) avoids editing each tab's module CSS to add
  `flex:1 1 0; min-height:0; overflow-y:auto`. The three module CSS files need
  **no change**; `.overviewTab`'s existing `overflow:auto`/`flex:1` become inert
  no-ops (block parent, content-height child) — left as-is to minimize churn.

### Rejected alternatives

1. **`position: sticky; top:0` on `.prHeader`.** Simpler, but: (a) leaves two
   scroll models on the page (document-scroll for non-Files vs viewport-bound
   for Files); (b) the banners between header and content would still scroll
   away unless also made sticky; (c) the document keeps growing, which fights the
   Files viewport-binding when switching tabs. The issue explicitly prefers the
   flex approach for consistency.
2. **Rename `data-files-active` → one unified `data-detail-active` for all tabs
   (including Files).** Fewer selectors, but it touches the Files contract: the
   marker name is referenced by code comments, the `useLayoutEffect` ordering
   note, and the `diff-scroll-keepalive` e2e. A rename spreads blast radius into
   `#191/#156/#590` for no functional gain. Parallel markers keep Files inert.
3. **Per-tab-root scroller (the issue's literal suggestion: add
   `flex:1 1 0; min-height:0; overflow-y:auto` to each `.overviewTab/.hotspots/
   .checks`).** Works, but puts the scrollbar at the *inner centered-column*
   edge (the columns are `min(80%, cap)` wide), which reads oddly and diverges
   from Files (scrollbar at screen edge). It also needs three module-CSS edits.
   Slot-as-scroller is more minimal and more consistent.

## Scope of change

- `frontend/src/components/PrDetail/PrDetailView.tsx` — add the parallel
  `data-detail-active` toggle in the existing marker `useLayoutEffect`.
- `frontend/src/styles/tokens.css` — add the `data-detail-active` chain beside
  the `data-files-active` block.
- No change to the three tab module CSS files (deviation from the issue's
  "files likely involved" list, justified above).

## Test plan

- **Red-on-main (captured):** `frontend/e2e/pr-detail-header-pinned.spec.ts` —
  opens the scenario PR, switches to Overview / Checks, injects a tall filler
  into the visible `[data-subtab]` slot, and asserts (a) the document does not
  scroll (`scrollHeight − clientHeight ≤ 1`), (b) the header stays at the top
  after a scroll attempt, and (c) the **slot itself** is the scroller that
  absorbed the overflow (`slot.scrollHeight > slot.clientHeight`). Assertion (c)
  ties the test to the slot-as-scroller mechanism — guarding against a future
  change that makes a *nested* element (`.overviewTab`/`.checks`) scroll instead
  (the rejected per-tab-root model). On `main` (a)/(b) red (document overflow
  ~2.8k–3k px).
- **Hotspots** rides the same tab-agnostic slot rule (it needs AI-on mock
  plumbing to mount); covered by the live visual gate rather than a third e2e
  case, to avoid duplicating the hotspots capability/route-mock harness.
- **Files regression:** existing `diff-scroll-keepalive.spec.ts` /
  `diff-scroll-regression.spec.ts` must stay green (Files rules untouched).
- **Visual gate (B1):** before/after screenshots of Overview, Hotspots, Checks
  in the running app, attached to the PR for the human eyeball-assert.

## Risks / open questions

- **Scroll-position memory (non-Files) — out of scope, no regression.** Making
  the slot the scroller means `useTabScrollMemory` (which tracks
  `[data-app-scroll].scrollTop`) no longer captures Overview/Checks/Hotspots
  scroll, so these tabs land at the top when you switch away and back. This is
  **not a browser-mode regression**: in the browser `[data-app-scroll]` is an
  unstyled passthrough that never scrolls for non-Files today (the document
  scrolls, and nothing restores the document offset), so non-Files scroll memory
  is already non-functional there. The slot *must* be the scroller for the header
  to pin (mirroring how `.files-tab`, not `[data-app-scroll]`, absorbs the diff
  overflow), so this trade-off is intrinsic. Achieving Files-parity slot-scroll
  restore needs a `useDiffScrollRestore`-style hook sequenced after the marker
  effect (the marker-removal-clamps-to-0 problem is the #590 failure mode) — that
  is **deferred to a follow-up issue**, not this slice. In the in-progress
  desktop shell, `[data-app-scroll]` scrolls today and *does* remember a
  position — but that remembered position is of the buggy header-scrolls-away
  state, so trading it for correct pinning is the right call.
- **Drafts tab** is **not** included (no marker), so it keeps today's behavior
  unchanged — `DraftsTab`'s internal composer/scroll regions vs a slot-level
  `overflow-y:auto` are unanalyzed, and Drafts is outside the issue's scope. A
  future tab is likewise opt-in (must be added to `isPinned`), so no sub-tab
  silently inherits pinned-scroll without a deliberate decision.
- **Keyboard scroll when focus is outside the slot** — Space/PageDown/arrows
  scroll the slot only when focus is inside it; with focus on the sub-tab strip
  or header controls, the nearest scrollable ancestor is `[data-app-scroll]`,
  which is empty in the common case, so those keys no-op. This is **identical to
  the shipped Files tab** (same app-shell internal-scroller model), not a new
  divergence — accepted for consistency. Wheel/trackpad scroll over the content
  is unaffected. (A roving-focus / `tabIndex` treatment, if ever wanted, should
  be applied to Files and the new tabs together, not one-off here.)
- **Short content + tall header:** with the `min-height:360px` slot floor, the
  slot stays a non-zero internal scroller and the `[data-app-scroll]` escape-
  hatch (`overflow-y:auto`, mirroring the Files block's Copilot-#155 rationale)
  scrolls the page to reveal a header stack taller than the viewport — content
  stays reachable below it. In the common case the page fits and only the slot
  scrollbar appears.
- **`overflow-x`** is pinned `hidden` on **both** `[data-app-scroll][data-detail-active]`
  and the `[data-subtab]` slot (the actual scroller), so neither can surface a
  spurious horizontal scrollbar.
