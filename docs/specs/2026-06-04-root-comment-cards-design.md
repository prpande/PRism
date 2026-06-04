---
title: Root-comment timeline → standalone cards with a connecting rail
issue: 129
tier: T2
risk: B1 (UI-visual, gated)
status: draft
date: 2026-06-04
---

# PR Overview: root-comment timeline → standalone cards (#129)

## Problem

In the PR-detail **Overview** tab, the PR-level (root) comment timeline reads as
cramped and hard to scan. The current markup
(`PrRootConversation.tsx` → `.prRootComment`) gives only the **body** card chrome
while the author/time meta floats *above* it, and the rail is faked per-comment:

- The body box is `--surface-2`. The conversation section (`.overview-card`) is
  `--surface-1` (L≈0.99), so the body box (L≈0.925) is **darker than its host** —
  each comment reads as a **sunken inset**, not a raised standalone card.
  (`PrRootConversation.module.css:67`; `tokens.css:69,70,626`.)
- The author/time meta sits *outside* that box, so a comment does not read as one
  cohesive unit. This — incoherence, not "too much chrome" — is the core of the
  issue's complaint.
- The rail is drawn with per-article pseudo-elements
  (`.prRootComment::before` + a `:last-of-type { bottom: 50% }` hack and a
  `::after` dot) (`PrRootConversation.module.css:24-47`), which is brittle and not
  a single continuous line.
- The body has no `min-width: 0`, so on a CSS grid track it can be stretched by
  intrinsically-min-content children.

## Goal / acceptance criteria

Redesign each comment into a distinct **standalone card** anchored to a single
**continuous left thread rail**, keeping markdown rendering and all existing
behavior (Reply / Mark-all-read / read-only fallback). From issue #129:

1. Each comment is a clearly delineated standalone card.
2. A continuous left thread rail connects the comment flow.
3. Individual comments are easy to scan and separate.
4. Markdown bodies still render correctly (long code/text already wraps at the
   container — see Overflow).

### Scoping principle

This slice restyles the existing `PrRootConversation` root-comment list and its
rail. It does **not** change the data model, the composer, Mark-all-read, or the
inline file-diff comment threads. See **Out of scope**.

## Design — "raised card + header band on a continuous rail"

Chosen from a 3-option visual brainstorm (raised-cards A / banded-flat B /
airy-borderless C) and confirmed via the visual companion as a **hybrid of A and
B**: A's raised-card elevation plus B's header band that binds author/time into
the card.

> **Elevation mechanism — important correction from the mockup.** The brainstorm
> mockup showed the cards lifted off a *darker recessed backdrop*. That does not
> reproduce in the real app: the Overview tab page is **already** `--surface-0`
> (`OverviewTab.module.css:4`), and in light mode `--surface-0` (L≈0.96) is the
> darkest surface in the ladder — there is no surface meaningfully darker than the
> page to recess into (`--surface-inset` is only 0.01 darker). So elevation here
> comes from the **card's own border + shadow**, not from a recessed field. The
> section stays a standard `.overview-card` (`--surface-1`), consistent with its
> sibling Overview cards (AiSummaryCard, StatsTiles, PrDescription). The fix to
> the real bug is that the comment card is **no longer darker than its host**
> (`--surface-1` card on a `--surface-1` section, lifted by `--shadow-2` +
> `--border-1`), inverting today's sunken `--surface-2` inset.

### Structure (per comment)

A two-column grid — a fixed rail gutter and a flexible card column:

```css
grid-template-columns: 24px minmax(0, 1fr);   /* minmax(0,…) lets the card track
                                                  shrink so wrapped content (below)
                                                  cannot stretch the grid */
column-gap: var(--s-3);
```

- **Rail column** (`aria-hidden`):
  - A **continuous vertical line** drawn by a pseudo-element on the rail span. To
    survive the inter-card gap (see Spacing), on every comment *except the last*
    the line runs from the node down past the card and across the gap:
    `top: <node-center>; bottom: calc(-1 * var(--s-3));` (the negative offset
    equals the inter-card `margin-top`, so the line bridges the gap into the next
    card). On the **last** comment the line is omitted.
  - An **accent node dot** vertically centered on the card's header band. The rail
    span is a fl/ex column; the node is offset from the top by the band's optical
    center (`padding-top` ≈ band vertical-padding + half the band line-box,
    ~`var(--s-3)` with the band padding below — tuned at the visual gate). The
    node carries a ring in the section color (`box-shadow: 0 0 0 3px
    var(--surface-1)`) so the line appears to pass *behind* it.
  - **Single-comment case:** with one comment the line is omitted (last == first)
    and only the node remains. This is acceptable — the card chrome alone
    delineates a lone comment; the rail is a multi-comment affordance.
- **Card column** — the standalone comment card:
  - `background: var(--surface-1)`, `border: 1px solid var(--border-1)`,
    `border-radius: var(--radius-3)`, `box-shadow: var(--shadow-2)`,
    `overflow: hidden` (clips the band's top corners), `min-width: 0`.
  - **Header band** — `background: var(--surface-2)`,
    `border-bottom: 1px solid var(--border-1)`, `padding: var(--s-2) var(--s-4)`,
    `font-size: var(--text-xs)`; a baseline-aligned flex row holding the author
    (`font-weight: 600`, `--text-1`) and the `<time>` (`--text-3`). The author
    gets `min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap` and the time `flex: none; white-space: nowrap`, so a long
    GitHub username truncates rather than wrapping the band or pushing the
    timestamp out. **In dark mode** the band fill delta is tiny (`--surface-2`
    0.235 vs card `--surface-1` 0.21 ≈ 0.025 L); the `border-bottom`
    (`--border-1`) is the real separator there, with the fill carrying it in
    light. The band's contained corners come from the card's `overflow: hidden`.
  - **Body** — `padding: var(--s-3) var(--s-4)`, `min-width: 0`; renders the
    existing `<MarkdownRenderer>` (`.markdown-body`). Inline `code` keeps the
    existing styling.

### Backdrop & elevation summary

| Theme | page / section (`--surface-1`*) | card (`--surface-1`) | reads via |
|-------|------------|------|-----------|
| light | section L≈0.99 | L≈0.99 | `--shadow-2` (subtle) + `--border-1` hairline + band |
| dark  | section L≈0.21 | L≈0.21 | `--shadow-2` (alpha 0.40, strong) + `--border-1` + band |

\* The section keeps `.overview-card` (`--surface-1`); it sits on the
`--surface-0` page like every sibling card. Card and section are the same surface
— elevation is carried by shadow + border (heavier shadow does the work in dark;
the border + band do more of it in light). No same-or-darker-than-host inset, so
the original sunken read is gone.

### Overflow (already handled globally)

The issue's "coordinate with the Overview overflow fix" note refers to an
**already-shipped** global: `.markdown-body pre { max-width: 100%;
white-space: pre-wrap; overflow-wrap: anywhere }` and `.markdown-body {
overflow-wrap: anywhere }` (`tokens.css:347-362`, added for #117/#149, explicitly
covering "PR Overview … root comments"). So long code lines and inline tokens
**wrap at the card width** — they do **not** scroll horizontally. This slice's
only obligation is the `min-width: 0` (card + body) and `minmax(0,1fr)` grid track
so the card cannot be stretched wider than its column; the global pre-wrap then
wraps content to that width. (Residual, pre-existing and out of scope: GFM
tables/images are intrinsically wide and can still overflow — they would need
their own `overflow-x` wrapper, per the global's own note.)

### Spacing & motion

- Inter-card spacing: `.item + .item { margin-top: var(--s-3); }`; the rail line
  bridges this gap via the negative `bottom` offset above.
- No new animation is introduced — nothing to gate against
  `prefers-reduced-motion`; the surface stays static, like the rest of Overview.

### JSX changes (`PrRootConversation.tsx`)

Restructure each comment from `header(meta) + div(body)` to
`grid( rail + card(band + body) )`, **preserving every existing hook**:

- `data-testid="pr-root-comment"` stays on the comment's outer `<article>`.
- Author text, `<time dateTime={createdAt}>`, and the `<MarkdownRenderer>` body
  are unchanged in content — only their wrappers/classes change.
- The rail line + node are decorative (`aria-hidden`).
- The actions row (Reply / Mark-all-read) and the read-only fallback footer are
  **unchanged**.
- **Empty state** (`comments.length === 0`): no rail/cards render; the section
  still shows the actions row (or the read-only footer). The `.overview-card`
  section styling is unchanged, so an empty conversation is a normal card with
  just the Reply affordance — same as today.

## Accessibility

- Each comment remains an `<article>`; reading order is band (author, time) then
  body — matches visual order. No focusable elements are added; tab order is
  unchanged. Rail/node are decorative and `aria-hidden`.
- **Text contrast (WCAG 1.4.3):**
  - Author `--text-1` (L≈0.20) on the band `--surface-2` — very high contrast.
  - Time `--text-3` on the band `--surface-2`. #124 measured `--text-3` on
    `--surface-3` (L 0.90) at **4.85:1**. `--surface-2` (L 0.925) has strictly
    higher relative luminance than `--surface-3` (both near-neutral, chroma
    ≤0.005), and the foreground is the *same* darker `--text-3`. Since the WCAG
    ratio `(L_bg+0.05)/(L_text+0.05)` increases monotonically with `L_bg` for
    fixed darker text, `--text-3`-on-`--surface-2` is **> 4.85:1** — clearing AA
    4.5:1 even at the band's 12px (`--text-xs`) size. axe confirms in the a11y
    e2e.
  - Body `--text-1` on the card `--surface-1` — high contrast.
- **Non-text contrast (1.4.11):** the rail/node are decorative, so 3:1 is not
  required; the accent node clears it regardless.

## Testing

- **`PrRootConversation.test.tsx` (existing — stays green, verified):** the suite
  is fully behavioral — it queries only `data-testid="pr-root-comment"`, visible
  text, `role`, `<time>` tag-name/`dateTime`, and `strong` (lines 33-94); **no
  query couples to a CSS-module class**, and `within()` walks the full subtree, so
  the header→band restructure cannot break it provided the testid stays on the
  `<article>`. (If any future query did couple to a class, migrate it to
  `data-testid`/role, not to a new class name.)
- **`OverviewTab.test.tsx` (existing):** asserts `PrRootConversation` mounts with
  `rootComments` + the PR5 actions — unaffected; confirm green.
- **New coverage:** assert each rendered comment exposes its author **and** time
  **and** body *within a single* `pr-root-comment` entry — guards the "one
  cohesive card" goal (today the meta is a sibling of the body; after this it is
  the band inside the card). jsdom cannot assert CSS elevation/rail; that is
  covered visually at the B1 gate.
- **Parity baseline:** `frontend/e2e/__screenshots__/win32/pr-detail-overview.png`
  **will change** (the conversation is in this baseline). Re-capture it in the
  same closed-composer state the existing parity spec uses
  (`parity-baselines.spec.ts:179-186`, D21), and call the intentional baseline
  update out in the PR `## Proof`.
- **a11y e2e (`a11y-audit.spec.ts`):** confirm no new axe serious/critical on the
  Overview route (covers the band contrast).

## Out of scope (deferred)

- **Current-user ("is-you") highlight** — the handoff prototype tints the viewer's
  own comments (`.pr-conv-item.is-you`). Current-user identity *exists*
  system-wide via `useAuth()` (S6), but `IssueCommentDto` carries no
  `isCurrentUser`/`currentUserId` flag, so wiring the highlight needs either a new
  DTO field or a client-side identity comparison. Deferred as its own change.
- **Iteration chips** (handoff `.pr-conv-iter`) — not present in PRism's comment
  data. Out of scope.
- **Wide-GFM overflow** (tables/images) — pre-existing global limitation
  (`tokens.css:354-356`); not introduced or addressed here.

## Risks

- **Card/section same-surface elevation reading too flat in light** — light
  `--shadow-2` is intentionally subtle (alpha 0.06); the `--border-1` hairline +
  the band carry delineation. This is the deliberate tradeoff for staying
  consistent with sibling Overview cards (no recessed field is available on a
  `--surface-0` page). Confirm legibility at the B1 gate in **both** themes.
- **Continuous-rail gap bridging** — without the `bottom: calc(-1 * var(--s-3))`
  extension, the line breaks at every inter-card gap; explicitly specified above.
- **`minmax(0,1fr)` / `min-width:0` omission** would let wrapped content's
  intrinsic width stretch the card; both are specified. (Containment is *wrapping*
  via the global pre-wrap, not scrolling.)
- **`overflow: hidden` on the card** only clips the band's rounded top corners;
  body content wraps within the card, so nothing is clipped.
- **Parity baseline drift** — expected and intentional; re-captured in this PR.
