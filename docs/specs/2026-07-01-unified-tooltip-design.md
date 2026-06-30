# Unified Tooltip — design spec

**Issue:** [#509](https://github.com/prpande/PRism/issues/509) (originally "File-ranker dot tooltip"; owner expanded the *motivation* to app-wide tooltip unification, then — after a 6-persona `ce-doc-review` surfaced verified mechanical/a11y traps — scoped **this** deliverable down to the reusable primitive + its first consumers, with the broad migration deferred to a follow-up).
**Date:** 2026-07-01
**Tier / Risk:** T2 (this PR is a bounded primitive + two consumers) / B1 UI-visual. The small surface (the AI dot + the minimap, two themes) is **self-validated via Playwright** by the implementer; no human visual gate for this PR (owner-authorized). The deferred broad migration (separate issue) is where a per-batch human glance returns.

## Problem

PRism surfaces hover tooltips two inconsistent ways:

1. **Native browser `title`** on ~85 elements across ~53 files. OS-rendered: no design-system chrome, OS-controlled appearance/delay, no theme awareness, no keyboard/focus support. They look unfinished next to the rest of the UI.
2. **Bespoke styled tooltips** — `ChangeMinimap` has its own `.tooltip` CSS; `ReadinessBadge` has a rich portal popover. Each is a one-off.

There is no shared tooltip primitive, so the styled hover affordances are fragmented and most hover hints fall back to the OS look.

## Goal & scope

Build **one reusable design-system `Tooltip`** primitive in the app's visual language, and prove it on its first two consumers: the **AI focus dot** (#509's literal target) and the **`ChangeMinimap`** tooltip (consolidating its bespoke chrome). This is **look-and-feel unification, not a copy rewrite** — existing tooltip *text* is preserved (this supersedes the issue's original "improve the copy" criterion).

Behaviour additions over native `title` (keyboard/focus open, Escape-dismiss — WCAG 1.4.13) are **intentional**, not scope creep: they are the point of a real component and are required by the deferred migration's icon-button consumers.

### In scope (this PR)

- The `Tooltip` component + its tests.
- `ChangeMinimap` adopts the shared chrome (CSS-module class), positioning unchanged.
- The AI focus dot (`FileTree` `AiSlot`) uses `Tooltip` instead of native `title`.

### Explicitly deferred (follow-up issue) and NOT done here

- **Broad migration** of the other *visible-chrome* hover hints to `Tooltip` (icon buttons — `RefreshButton`, `FilterBar` refresh, `OpenInGitHubButton`, `WindowControls`, `Header` search, `AiSummaryCard`, `DiffSettingsMenu`, `PrHeader`, `MarkAllReadButton`; plus `Avatar`, `DiffBar`, `ActivityRail`, `AiMarker`, `ComposerStatusBadge`, `AiUsagePane` bars). These are real wins (the `aria-label` upgrade is visible there) but they are repetition with no new design decisions, so they ship separately with their own per-batch validation.

### Kept on native `title` deliberately (NOT migrated, here or in the follow-up)

Decided after review — these are cases where native `title` is both **safer and more accessible** than a JS tooltip:

- **Disabled-control hints** — `title={reason ?? undefined}` on a control that has the title *only when disabled* (`SubmitButton`, `ReviewActionButton`, `ComposerActionsBar` post, `PrRootReplyComposer`, `SubmitDialog` confirm, `StaleCommitOidBanner`, `UnresolvedPanel`, …). **Disabled elements emit no pointer/focus events in Chromium**, so a JS hover tooltip cannot reliably appear — exactly when the user needs the "why is this disabled?" explanation. Native `title` renders on disabled controls; keep it. (Cases where the title sits on an *enabled* wrapper/label, e.g. `DiffViewToggle`, may migrate in the follow-up since they do receive hover.)
- **Pure truncation hints** — full file/dir name, check name, inbox/PR title, thread snippet (`FileTree` names, `ChecksTab`, `InboxRow`, `HotspotsTab` paths, `ThreadDisclosureHeader`). Native `title` here is accessible to the screen-reader virtual cursor without focus, is zero-maintenance, and can't visually break. Converting them would fire a styled bubble on every hover (even when the text isn't actually clipped — noise on the app's densest surfaces) and would *downgrade* a11y for non-focusable `<span>`s. Keep native `title`.

### Excluded (not OS tooltips at all)

`title` **props** on `Modal`, `ErrorModal`, `PrDescription` (headings/labels), and the markdown-link `title` in `MarkdownRenderer` (standard author-controlled `<a title>`). `*.test.tsx` `title` props are out of scope. `ReadinessBadge` stays as-is (rich popover, not a plain tooltip).

## The `Tooltip` component

New: `frontend/src/components/shared/Tooltip/Tooltip.tsx` (+ `Tooltip.module.css`, `Tooltip.test.tsx`) and `tooltipChrome.module.css` (shared chrome class, imported by both `Tooltip` and `ChangeMinimap`).

**Hand-rolled, no library.** The repo already hand-rolls portal-positioned hover popovers (`ReadinessBadge`, `ChangeMinimap`) with `getBoundingClientRect`. At this PR's scale (two consumers, top/bottom placement) a positioning library earns nothing; the deferred broad-migration issue may revisit `@floating-ui/dom` if a future consumer needs 4-way collision math, but nothing here does.

### API (wrapper form)

```tsx
<Tooltip content="…" placement="top">
  <button aria-label="…" onClick={…}>…</button>
</Tooltip>
```

- `content: React.ReactNode` — tooltip body (string in the common case).
- `placement?: 'top' | 'bottom'` — preferred side; default `'top'`. Flips to the opposite side when there isn't room. **`left`/`right` are intentionally omitted** — no consumer (this PR or the deferred set) needs horizontal placement; the cross-axis clamp already covers edge triggers. Add later only against a concrete need (YAGNI).
- `wrap?: boolean` — `false` (default) → single-line `nowrap`; `true` → `max-width: 280px` + wrapping (for long content; not needed by this PR's two consumers but part of the primitive's contract).
- `disabled?: boolean` — render the child untouched, with no tooltip and no listeners. Also the behaviour when `content` is empty/falsy: **no tooltip node renders, no `aria-describedby` is set.**
- `children: React.ReactElement` — exactly one element that renders a **host DOM element** (button/span/svg/…). The component injects a ref + handlers onto that element via `cloneElement` (see Mechanics). It does not support a child that is a custom component not forwarding ref/props to a DOM node; such a call site wraps its inner DOM node instead.

A `useTooltip` hook and a singleton "only one open" context are **not built** (YAGNI — hover-intent + one pointer ⇒ at most one open in practice).

### Behaviour

- **Portal** to `document.body` via `createPortal`, escaping `overflow:hidden`/clipping in the file-tree and diff scroll panes.
- **Hover-intent open:** open after `HOVER_OPEN_MS = 300` (matching `ReadinessBadge`); cancel the timer on early leave. Close on pointer-leave after `HOVER_CLOSE_MS = 200` grace so it doesn't snap shut crossing a narrow target.
- **Keyboard/focus:** open on `focus`, close on `blur` and `Escape` (WCAG 1.4.13). (No effect on the AI dot, which is a non-focusable `aria-hidden` span — its tooltip is pointer/visual only; the dot's spoken signal remains the existing `sr-only` "AI focus: \<level\>" span in the file row. The focus path exists for the deferred icon-button consumers.)
- **Dismiss on scroll/resize** while open, except when the trigger holds keyboard focus (mirrors `ReadinessBadge`).
- **`pointer-events: none`** on the tooltip node (non-interactive; no trigger→tooltip pointer traversal to protect).

### Positioning (specified concretely — this is net-new, not a `place()` reuse)

`ReadinessBadge.place()` only does above/below for a **fixed-size** popover (`POPOVER_W`/`POPOVER_MAX_H` constants). A content-sized tooltip needs its **own measured rect**, so:

1. Mount the tooltip node with `visibility: hidden` (no flash) on first paint.
2. In a layout effect, measure the tooltip via a ref and the trigger via `getBoundingClientRect()`.
3. Place on the preferred side with a `GAP = 6px`; **flip** to the opposite side when the preferred side lacks room.
4. **Clamp** the cross-axis (horizontal, for top/bottom) to stay within an 8px viewport gutter.
5. Reveal (`visibility: visible`).

Re-measure on the open transition; while open, scroll/resize dismisses (above), so no continuous reposition loop is needed.

### Chrome (the design language)

A shared `tooltipChrome.module.css` class carrying the `ChangeMinimap` `.tooltip` token set (now the single source of truth, imported by both `Tooltip` and `ChangeMinimap`):

```
background: var(--surface-1);
color: var(--text-1);
border: 1px solid var(--border-2);
border-radius: var(--radius-2);
box-shadow: var(--shadow-3);
font-family: var(--font-sans);
font-size: var(--text-2xs);
padding: 4px 9px;
pointer-events: none;
```

- **z-index:** above the modal backdrop (`--z-modal` is `1000` in `tokens.css`) so a tooltip triggered from inside a modal is visible. Use a dedicated `--z-tooltip: 1100` token. (No in-modal trigger ships in *this* PR, but the primitive must be correct for the deferred consumers; setting it now avoids a `ReadinessBadge`-style `z-index:50` that would render under modals.)
- **No arrow** (matches `ChangeMinimap`/`ReadinessBadge`; simpler, nothing depends on a pointer).
- **Motion:** instant appear/disappear (no transition), matching `ReadinessBadge`. Because there is no animation, **no `prefers-reduced-motion` handling is required** — stated explicitly to close the question.
- **Forced-colors:** add a `@media (forced-colors: active)` rule giving the tooltip an explicit `border` from a system color (the token border/shadow are stripped in forced-colors), consistent with the app's existing forced-colors handling.
- **Touch / no-hover:** out of scope — PRism is a desktop/Electron + desktop-browser app; pointer-coarse devices are not a target. No tap/long-press affordance; the native-`title` fallback is retained precisely on the high-value text (truncation), so nothing becomes unreachable on touch.
- Single-line by default; `wrap` adds `max-width` + `white-space: normal`. Both themes inherit from tokens — **verify ΔL live in both themes** (the repo's oklch surface scales are theme-asymmetric) rather than asserting parity up front.

### Accessibility

- The tooltip is a **description**, not a name: portal node has `role="tooltip"` + a generated `id`; the trigger gets `aria-describedby={id}` **only while open** (and only when the trigger is not `aria-hidden`).
- **Name preservation** (for the deferred icon-button migration, documented here so the contract is set): where a native `title` was an icon-only control's accessible *name*, that migration adds an explicit `aria-label`; the tooltip text and `aria-label` are wired separately.
- This PR's dot keeps the `FileTree` `sr-only` "AI focus: \<level\>" span verbatim; the AI dot column stays `aria-hidden`. No a11y change to the dot.

## Mechanics: attaching to the child (`cloneElement`, no wrapper)

Attach via `cloneElement` onto the single host-element child — inject the merged `ref`, `onPointerEnter`/`onPointerLeave`, `onFocus`/`onBlur`, `onKeyDown` (Escape), and `aria-describedby`. **No `display:contents` wrapper span** — once we `cloneElement` for the ref, the same clone carries the handlers, and a `display:contents` span has a 0×0 rect so it could never serve as a measurement fallback anyway. All real targets render host elements directly (the AI dot is a `<span>`), so this is clean and disturbs no layout.

**Ref-merge contract** (no `mergeRefs`/`forwardRef` util exists in the repo — build one, React-19-aware):
- Read the child's existing ref from `child.props.ref` (React 19 made `ref` a regular prop; reading `element.ref` is deprecated).
- Support both object refs (`.current =`) and callback refs.
- Thread through a callback ref's **cleanup return** (React 19 callback-ref cleanup semantics).
- Merge, never overwrite, the child's existing handlers (call the child's first, then ours).

This is the one genuinely fiddly part; it gets dedicated unit tests (object ref, callback ref, callback-ref cleanup, handler merge).

## Testing

- **Primitive unit tests** (`Tooltip.test.tsx`, vitest + jsdom, fake timers): open-after-300ms, cancel-on-early-leave, close-after-200ms grace, open-on-focus, close-on-blur/Escape, `aria-describedby` wired only while open, portal renders into `document.body`, `disabled`/empty `content` renders no tooltip and no listeners, **ref-merge** (object ref + callback ref + cleanup), child handler merge (child's own `onPointerEnter` still fires). Placement/flip math asserted with mocked rects where jsdom allows; pixel-accurate flip covered by Playwright.
- **Consumer tests:** `ChangeMinimap` tooltip still renders its existing content (now via the shared chrome class) — existing tests stay green. `FileTree`: the AI dot renders a `Tooltip` (assert `role="tooltip"` appears after hover) and the `sr-only` "AI focus" span is preserved.
- **Playwright self-validation** (replaces the human B1 gate for this small surface): drive the running app; hover the AI focus dot (high + medium) and a `ChangeMinimap` tick; assert **positively** that a `role="tooltip"` node appears (not just a screenshot — the verified failure mode is *silent absence*); capture screenshots in **light and dark**; confirm chrome renders, content unchanged, on-screen near edges (flip), both themes read correctly. Screenshots → PR `## Proof`. For `ChangeMinimap`, validate its tick-relative tooltip stays on-screen (its bespoke positioning has no flip — the flip assertion applies to `Tooltip`-positioned surfaces only).

## Rollout (one PR, bisectable commits)

1. `Tooltip` primitive + `tooltipChrome.module.css` + unit tests.
2. `ChangeMinimap` adopts the shared chrome class.
3. AI focus dot (`FileTree` `AiSlot`) → `Tooltip`.
4. Playwright self-validation pass.

Each as its own commit so a post-merge regression is bisectable. File the **follow-up issue** for the deferred broad chrome-tooltip migration (with the kept-native-`title` rationale recorded), cross-linked from #509.

## Risks / open points

- **Ref-merge under React 19** is the main implementation risk — covered by dedicated tests above.
- **Hover-intent timing** (`300/200ms`) inherited from `ReadinessBadge`; final feel confirmed in the Playwright pass, adjustable.
- **Forced-colors** rule needs a live check (Windows High Contrast) in the validation pass.
