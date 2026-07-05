---
title: "#586 — GitHub-style markdown formatting toolbar for PR-detail comment composers"
type: feat
origin: none
issue: 586
tier: T3
risk: UI-visual (B1 gated)
date: 2026-07-05
---

# #586 — Markdown formatting toolbar for the comment composers

- **Issue:** [#586](https://github.com/prpande/PRism/issues/586) — `enhancement`, `needs-design`, `area:pr-detail`, `area:frontend`, `priority:p2`
- **Tier / Risk:** **T3** (cross-cutting: one shared toolbar + a pure transform engine wired into three composer surfaces, plus edits to the shared `ComposerActionsBar` and `PrRootBodyEditor`). **B1 — UI-visual gated**: a new visible control set whose "looks right / behaves right" (caret restore, undo, focus flow, both themes, narrow-width) can only be asserted by a human in the running app; CI cannot eyeball it.
- **Ships as:** one frontend PR. No backend, no wire/DTO/schema change.

## Problem

The three PR-detail comment composers already support markdown — a footer **Preview** toggle
renders the typed body through the shared `MarkdownRenderer` (`ComposerMarkdownPreview`). But to
apply any formatting the user must hand-type raw markdown syntax. GitHub's composer offers a
formatting toolbar (bold, italic, headings, quote, code, lists, link, …) plus a `Write | Preview`
tab pair; matching it lowers friction and meets the parity expectation users carry over from
GitHub.

> **Scope bet (recorded for sign-off):** the issue's cited friction is "must hand-type raw markdown
> syntax," which is concentrated in a handful of high-frequency actions (bold, code, link, quote,
> list). The full button set below is chosen for **GitHub-parity completeness**, not per-action
> measured demand — the low-frequency tail (strikethrough, task list, numbered list) is included so
> the toolbar reads as complete rather than partial. This is a deliberate depth bet, flagged so the
> reviewer signs off on it knowingly.

## Scope: the three composer surfaces (and the one that stays out)

Recon (see *Architecture map*, below; every claim independently re-verified against the code by the
feasibility review) established that the composers are **not** two interchangeable things as the
issue's "`PrRootReplyComposer` / `ReplyComposer`" phrasing implies — they are three distinct React
surfaces with two different editor substrates:

| # | Component | Where | Editor substrate | In scope |
|---|-----------|-------|------------------|----------|
| 1 | `InlineCommentComposer` | Files tab, line comment | shared `useDraftComposer` (`editor.textareaRef`/`body`/`setBody`/`previewMode`) | **yes** |
| 2 | `ReplyComposer` | reply to an existing comment **thread** | same shared `useDraftComposer` | **yes** |
| 3 | `PrRootReplyComposer` | Overview tab, "Reply to this PR" | **bespoke** — owns its own state, wraps `PrRootBodyEditor` (which owns the textarea) | **yes** |
| — | `PrRootBodyEditor` **as mounted by `SubmitDialog`** | review-submit dialog, root body | same `PrRootBodyEditor` component, different mount | **no** (out of scope) |

`PrRootBodyEditor` is a reusable textarea+autosave primitive mounted in **both** the in-scope
Overview reply (#3) and the out-of-scope SubmitDialog root-body editor. The in/out boundary is
therefore about **which mount renders a toolbar**, not about the component: the Overview parent
renders a toolbar and passes a ref; SubmitDialog does neither, so its editor is untouched.
(Verified: the only `ComposerActionsBar` consumers are `InlineCommentComposer` and `ReplyComposer`,
both in scope; `SubmitDialog` uses its own hand-rolled preview toggle — no silent fourth consumer of
the relocated control.)

## Goals

1. **One shared `<FormattingToolbar>`** component, driven by a minimal surface-agnostic handle,
   reused across all three in-scope composers — no per-composer duplication (issue AC).
2. Each action **wraps/inserts** the correct markdown around the current textarea selection and
   **restores the caret/selection AND returns focus to the textarea** so the user keeps typing; wrap
   and line-prefix actions **toggle** (a second click on an already-formatted selection removes the
   formatting).
3. **Native undo/redo survives** a toolbar edit (Ctrl/Cmd+Z reverts it) in the Chromium/Electron
   runtime, matching GitHub.
4. Common actions have **GitHub-consistent keyboard shortcuts**, and those shortcuts honor the exact
   same lock gates as the buttons (no bypass — see §Autosave-race safety).
5. The toolbar is **accessible** (a `Write | Preview` segmented control + a WAI-ARIA `toolbar`, each
   a single tab stop; labels; keyboard-operable; defined focus flow) and **degrades sensibly** in
   preview / read-only / posting states.
6. The existing footer **Preview** toggle is **relocated into the toolbar** as a `Write | Preview`
   segmented control (GitHub's top-bar model) — one control, no duplication. *(Decided in the #586
   brainstorming pass at the user's explicit request; it resolves the issue's own placement
   ambiguity — "pairs naturally with [the actions bar] or sits as a strip above the textarea" — in
   favor of a single control over a duplicated one.)*
7. Reuse the existing `MarkdownRenderer` for preview (no second markdown pipeline).

## Non-goals / explicitly deferred

- **SubmitDialog root-body / PR-description editor** — out of scope (issue). No toolbar; no ref
  passed. Could adopt the same toolbar later.
- **Real `@`-mention / `#`-reference autocomplete** (fuzzy-search of PR participants / referenced
  PRs). See §Open decision — the `@`/`#` buttons are the one place two reviewers flagged a
  parity-premise risk; the interim-vs-cut call is recorded there. **A follow-up issue will be filed**
  for the autocomplete feature regardless, cross-linked from #586.
- **No persistent `aria-pressed` toggle state** on the format buttons (no live "is the selection
  currently bold" detection). Toggle is behavioral on click, as on GitHub. (`aria-pressed` is used
  only on the separate `Write | Preview` segmented control, reflecting the active view.)
- **No new markdown sanitization / render path.** `MarkdownRenderer` is reused as-is (GFM,
  no `rehype-raw`); it already renders untrusted comment bodies.
- **List shortcuts** (`Ctrl/Cmd+Shift+7/8`) are **not** bound (obscure; the buttons cover them).
  Only Bold/Italic/Link/Code get shortcuts (§ Keyboard shortcuts).
- No autosize / textarea-component refactor; the plain `.composer-textarea` stays.

## Architecture map (recon findings the design rests on)

- **`useDraftComposer` editor surface** (`useDraftComposer.ts:376`) is narrow:
  `{ body, setBody, previewMode, textareaRef, handleKeyDown, readOnly }`; `actions.onTogglePreview`
  and `actions.posting` exist. **No selection/caret is exposed today**, and there is **no** existing
  selection/insertion helper anywhere in `frontend/src` — the transform engine is built from
  scratch.
- **Preview replaces the textarea**: composers render `{previewMode ? <ComposerMarkdownPreview/> :
  <textarea/>}`, i.e. the textarea **unmounts** in preview, so `textareaRef.current` is `null`
  there.
- **`ComposerActionsBar`** receives only the `actions` slice (not `editor`); it currently hosts the
  Preview toggle in its left group (`ComposerActionsBar.tsx:64-71`). Removing the button while
  keeping the `previewMode`/`onTogglePreview` props does not break the prop contract.
- **`PrRootReplyComposer`** is bespoke: owns its own `body`/`previewMode`/`postInFlight`, hand-rolls
  its action row (does **not** use `ComposerActionsBar`), and delegates the textarea to
  `PrRootBodyEditor`, which **does not surface its textarea ref** to the parent today.
- **`PrRootBodyEditor`** owns its textarea via one internal `useRef`; the only internal consumer is
  the on-mount focus effect, so a **merged callback-ref** that attaches both the internal ref and an
  optional external ref coexists cleanly.
- **Shortcut matcher** `matchComposerKey.ts` is element-agnostic (returns a string, no caret).
  Reserved combos: `Ctrl/Cmd+Enter` (submit), `Ctrl/Cmd+Shift+P` (preview), `Escape`.
  `Ctrl/Cmd+B/I/K/E` are **free**. Note: `editor.handleKeyDown` fires even on a `readOnly` textarea
  (native `readOnly` blocks character input, not JS keydown handlers) — this is load-bearing for
  §Autosave-race safety.
- **No shared `Button`/`IconButton`**; buttons compose `.btn .btn-sm` + a semantic class. Icons are
  inline 16×16 `currentColor` SVGs (convention: `FilesTab/diffIcons.tsx`). `.sr-only` is the
  visually-hidden utility.
- **`MarkdownRenderer`** (`components/Markdown/MarkdownRenderer.tsx`) props:
  `{ source: string; className?: string; dataTestId?: string }` — GFM enabled; preview reuse is
  passing the body as `source`.

## Module layout

All new files under `frontend/src/components/PrDetail/Composer/`.

| File | Responsibility |
|------|----------------|
| `markdownFormatting.ts` | **Pure, DOM-free** transform engine. One function per action: `(text, selStart, selEnd) => { value, selectionStart, selectionEnd }`. All string math + toggle/edge-case logic (§Toggle contract); no React, no DOM. The exhaustively-tested core. |
| `applyFormatting.ts` | Thin **application** layer. Given a `textareaRef` + a transform, reads caret, computes via the engine, applies via `document.execCommand('insertText', …)` (undo-preserving) with a `setRangeText` fallback, syncs React state via `onChange`, restores selection + focus (§Application vector). |
| `FormattingToolbar.tsx` | Presentational strip: a `Write \| Preview` segmented control **plus** a sibling `role="toolbar"` holding the format buttons (two adjacent widgets — §Accessibility). Consumes the handle. |
| `formattingIcons.tsx` | Inline 16×16 `currentColor` SVG icon components (Bold/Italic/Strikethrough/Heading/Quote/Code/Link/BulletList/NumberedList/TaskList[/Mention/Reference]), matching `diffIcons.tsx`. |
| `useFormattingShortcuts.ts` | Maps `Ctrl/Cmd+B/I/K/E` to the same transforms; **early-returns when the handle is disabled** (§Autosave-race safety); used by all three surfaces. |

New styling: a `.formatting-toolbar` block in `styles/tokens.css` (see §Styling & theming).

## The handle (the single interface all three surfaces satisfy)

```ts
export interface FormattingHandle {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  previewMode: boolean;
  onTogglePreview: () => void;
  disabled: boolean; // format-action gate: readOnly || posting (NOT previewMode — see Degradation)
}
```

The toolbar depends only on this handle, never on `useDraftComposer`. That is what lets the
bespoke surface #3 reuse the identical component. **`disabled` gates both the format buttons AND the
keyboard-shortcut path** (§Autosave-race safety); it does **not** gate the `Write | Preview` control.

## Application vector — undo, sync, caret, focus

Approach: **compute the edit with the pure engine, apply it as a native range edit so the textarea's
undo stack survives.** In Chromium/Electron (PRism's runtime, and any Chromium browser used for
Vite-dev) the reliably-undoable primitive is `document.execCommand('insertText', false, replacement)`
after selecting the span to replace; `setRangeText` does **not** push an undo entry in Chromium. So
`applyFormatting`:

1. `textarea.focus()` — ensure the textarea is the active element (a mouse click on a toolbar button
   would otherwise blur it; see also the mousedown-preventDefault note in §Accessibility).
2. `textarea.setSelectionRange(replaceStart, replaceEnd)` — the span the engine says to replace.
3. `const ok = document.execCommand('insertText', false, replacement)`.
4. If `!ok` (or it throws) — notably **jsdom**, which implements neither `execCommand`
   meaningfully — **`console.warn` once (dev-only) that the undo-preserving path was unavailable**,
   then fall back to `textarea.setRangeText(replacement, replaceStart, replaceEnd)`. The warn makes a
   silent undo-degrade observable in any real runtime where `execCommand` unexpectedly returns false
   (not just jsdom), instead of passing tests while regressing undo invisibly.
5. `onChange(textarea.value)` to sync React state (controlled textarea: because the DOM value now
   equals the next state value, React's commit does not rewrite the `value` property, so it does not
   reset selection).
6. Restore/park the caret with `textarea.setSelectionRange(engine.selectionStart, engine.selectionEnd)`.
   **Mechanism is pinned, not "microtask-or-rAF":** set the selection **synchronously** right after
   step 5 (the DOM already holds the final value), and additionally re-assert it in a
   **`useLayoutEffect`** keyed on a per-edit token so that if a controlled re-render moves the caret,
   the layout effect (which runs after React commit, before paint) restores it deterministically. No
   `requestAnimationFrame`, no microtask race with the user's next keystroke.

**Undo runtime support:** `execCommand('insertText')` is undoable in all Chromium-based runtimes
(Electron **and** Chrome/Edge dev). Firefox/Safari are not a shipping target and fall to the
value-correct-but-undo-lossy `setRangeText` path; the dev-only warn surfaces this if it ever occurs.

Consequence for testing: the **pure engine** is fully unit-testable with zero DOM; the
**application layer** is exercised in jsdom via the `setRangeText` fallback (asserting resulting
`value`, selection, and `onChange` payload); **real undo** is confirmed only in the live-app pass
(which the AC already requires). This split is deliberate — jsdom cannot validate `execCommand` undo.

## The actions (exact markdown; all toggle-aware)

**Wrap actions** — wrap the selection in markers; toggle-off if already wrapped (§Toggle contract).
Empty selection inserts the marker pair with the caret parked between.

| Button | Markers | Empty-selection result | Shortcut |
|--------|---------|------------------------|----------|
| Bold | `**…**` | `**‸**` | `Ctrl/Cmd+B` |
| Italic | `_…_` | `_‸_` | `Ctrl/Cmd+I` |
| Strikethrough | `~~…~~` | `~~‸~~` | — |
| Code | single-line/empty → inline `` `…` ``; multi-line → fenced ```` ```\n…\n``` ```` | `` `‸` `` | `Ctrl/Cmd+E` |

**Link** — selection → `[selection](url)` with the literal `url` placeholder selected for immediate
typing; empty → `[text](url)` with `text` selected. `Ctrl/Cmd+K`.

**Line-prefix actions** — apply to every line the selection spans (or the caret's line). Toggle-off
if **all** selected non-empty lines already carry the prefix (§Toggle contract).

| Button | Per-line prefix |
|--------|-----------------|
| Heading | `### ` — **cycle on repeat**: `### ` → `## ` → `# ` → (strip). H3 is the default because H1/H2 render loud in a comment thread; cycling gives a keyboard/click path to the other levels without a dropdown, preserving GitHub-ish parity without a level menu. |
| Quote | `> ` |
| Bulleted list | `- ` |
| Numbered list | `1. `, `2. `, … (renumbered sequentially across the block) |
| Task list | `- [ ] ` |

**Insert actions** *(pending §Open decision)* — insert a single character at the caret (no toggle):
`@`, `#`.

## Toggle & edge-case contract (engine)

These are decided **now** so the engine is specified, not left to implementer guesswork:

- **Marker location on toggle-off.** A wrap toggles off when the markers are immediately adjacent to
  the selection on **either** side — i.e. both when the selection *includes* the markers
  (`|**foo**|`) and when it sits *inside* an existing pair (`**|foo|**`, the bold-inside-bold case).
  The engine checks the characters just outside the selection as well as the selection edges.
- **Whitespace-tolerant matching.** Before matching for toggle-off, trailing/leading whitespace and
  newlines inside the selection are excluded from the marker comparison (so selecting `foo ` with a
  trailing space still toggles `**foo** ` correctly rather than producing `**foo **`).
- **Italic vs. bold/underscore adjacency.** Italic uses `_…_`; the engine does not treat an existing
  `**bold**` boundary or an intra-word underscore as an italic marker (it matches only a balanced
  `_…_` pair bounding the trimmed selection).
- **Code inside a fence / already-inline.** Toggling Code on a selection already wrapped in inline
  backticks, or fully inside a fenced block, strips that wrapping rather than nesting.
- **Numbered-list renumber semantics.** Applying renumbers the block sequentially from `1.`;
  toggling off removes the prefixes. A toggle-off-then-on does **not** preserve any hand-authored
  original numbers (documented, accepted).

Every bullet above is a row in the engine test matrix (§Testing).

## Wiring per surface

**#1/#2 — `InlineCommentComposer` / `ReplyComposer`** (share `useDraftComposer`):
render `<FormattingToolbar>` unconditionally at the **top of the composer body**, above the
`{previewMode ? <preview/> : <textarea/>}` swap. Handle:

```ts
{
  textareaRef: editor.textareaRef,
  value: editor.body,
  onChange: editor.setBody,
  previewMode: editor.previewMode,
  onTogglePreview: actions.onTogglePreview,
  disabled: editor.readOnly || actions.posting,
}
```

`useFormattingShortcuts(handle)` runs on the same textarea for B/I/K/E while `editor.handleKeyDown`
keeps owning submit/preview/escape via `matchComposerKey`.

**#3 — `PrRootReplyComposer`** (bespoke; already owns `previewMode` + preview rendering): render
`<FormattingToolbar>` **in the parent**, at the top of its body, above `PrRootBodyEditor` and its
preview region. `PrRootBodyEditor` gains an **optional external textarea-ref prop** (e.g.
`textAreaRef?: React.RefObject<HTMLTextAreaElement | null>`) attached via a merged callback-ref
alongside its internal ref; the parent passes a ref it also hands to the toolbar handle. Handle
draws `previewMode`/`onTogglePreview` from `PrRootReplyComposer`'s existing state, and
`disabled: readOnly || postInFlight`.

**Preview relocation (both substrates):**
- Remove the Preview toggle button from `ComposerActionsBar`'s left group (left group becomes AI
  assistant + status badge). `previewMode`/`onTogglePreview` continue to originate in
  `useDraftComposer` and now feed the toolbar's `Write | Preview` control.
- Remove the Preview toggle from `PrRootReplyComposer`'s hand-rolled footer; its `previewMode` state
  now drives the toolbar control.

**Out of scope:** `SubmitDialog` mounts `PrRootBodyEditor` **without** the ref prop and renders no
`FormattingToolbar` → the root-description editor is behavior- and pixel-identical to today.

## Autosave-race safety (the shortcut path must honor the same gate as the buttons)

`editor.handleKeyDown` — and therefore any keydown listener on the textarea — fires even when the
textarea is `readOnly`, and the `setRangeText` fallback ignores `readOnly`. During an in-flight post
the autosave debounce is **deliberately live** (#601 Fix A keeps the 404-detection path armed). So a
`Ctrl/Cmd+B` pressed mid-post would mutate the body and fire `onChange`→`setBody`, scheduling a
draft PUT that **races the in-flight post** — precisely the orphaned-update-races-post defect
#601/#644 closed for the buttons and `Ctrl/Cmd+Enter`.

**Requirement:** `useFormattingShortcuts` **early-returns when `handle.disabled` is true**, mirroring
the existing `if (posting) return` guards, so the shortcut path is inert under posting/read-only
exactly like the buttons. A test asserts `Ctrl/Cmd+B` fires **no** transform and **no** `onChange`
while `disabled`.

## Keyboard shortcuts

`Ctrl/Cmd+B` (bold), `Ctrl/Cmd+I` (italic), `Ctrl/Cmd+K` (link), `Ctrl/Cmd+E` (code) — dispatched by
`useFormattingShortcuts`, operating directly on the textarea. **No collision**: only
`Ctrl/Cmd+Enter`, `Ctrl/Cmd+Shift+P`, `Escape` are taken. Shortcuts run the same transforms and the
same `applyFormatting` path as the buttons (so they are undoable too) and honor the same disable
gate (§Autosave-race safety).

## Accessibility

The strip is **two adjacent widgets, each a single tab stop** (not one mixed roving group — matching
GitHub's own DOM, which separates the view switch from the formatting commands):

1. **`Write | Preview` segmented control.** A 2-option control (two `<button type="button">`s with
   `aria-pressed` reflecting the active view; it preserves the existing Preview toggle's semantics).
   Its own single tab stop.
2. **`role="toolbar"` `aria-label="Formatting"`** holding only the format buttons, with **roving
   tabindex** — one tab stop; `ArrowLeft/ArrowRight` move between buttons, `Home`/`End` jump to the
   ends.

- Each format button is `<button type="button">` with an `aria-label` **and a visible tooltip**
  (native `title=` for now — the unified `<Tooltip>` from #509 is parked; when it lands the toolbar
  can adopt it) showing the label + shortcut, e.g. "Bold (Ctrl+B)". Its SVG icon is `aria-hidden` +
  `focusable="false"`. This matters because Strikethrough/Task-list/Numbered-list/Mention/Reference
  are not self-evident glyphs.
- **Grouping:** the format buttons are visually clustered (thin divider / spacing) into
  **wrap · link · line-prefix · insert** groups matching the actions taxonomy, with a
  `role="separator"` between groups, to keep a 10–12-button row scannable.
- **Buttons keep focus on the textarea:** each button applies on `onMouseDown` with
  `preventDefault()` (so a mouse click never blurs the textarea → no caret flash), and after any
  activation focus is on the textarea (§Application vector step 1) so the user resumes typing
  immediately.
- **Focus flow across the preview toggle:** when the user switches to **Preview** via keyboard, move
  focus to the `Write | Preview` control itself *before* the format buttons unmount (so focus is
  never orphaned to `<body>`). When switching back to **Write**, return focus to the **textarea**
  (resume typing), not to a button.
- Disabled format buttons set `disabled` + `aria-disabled`; hidden-in-preview buttons are removed
  from the a11y tree.

## Degradation (preview / read-only / posting)

The **strip is always mounted** (edit *and* preview), rendered unconditionally at the top of each
composer body above the `{previewMode ? <preview/> : <textarea/>}` swap. The two widgets gate
independently:

| State | `Write \| Preview` control | Format toolbar (buttons) |
|-------|----------------------------|--------------------------|
| Edit, active | enabled | enabled |
| **Preview mode** | enabled (so you can switch back) | **hidden** (textarea unmounted → nothing to act on) |
| **read-only** (cross-tab take-over) | enabled (can still preview) | **disabled** (visible, greyed) |
| **posting** (in-flight) | enabled | **disabled** |

**No layout shift:** the strip reserves a **stable row height**; when the format toolbar is hidden
in preview, the `Write | Preview` control alone occupies that fixed-height row, so toggling
Write↔Preview does **not** reflow the composer's vertical layout. (A B1 "looks-right" item.)

## Styling & theming

The strip is a new visual surface and will **not** inherit the `.composer-frame .composer-actions
button` footer normalization, so it defines its own styling:

- A `.formatting-toolbar` container (flex row, stable height per §Degradation, `overflow-x` per
  §Responsive) and a `.formatting-toolbar-btn` class for the icon buttons, **keyed to the same color
  tokens** as the removed `.composer-preview-toggle` (so light/dark parity matches the control it
  replaces). Icon buttons are `currentColor` so they theme automatically.
- The `Write | Preview` segmented control reuses the `.composer-preview-toggle` visual language
  (moved, not restyled) so the affordance users know is preserved.
- **Both-theme parity is an explicit review-checklist item**, not folded silently into the general
  B1 pass.

## Responsive / overflow

`InlineCommentComposer` mounts inside a Files-tab diff row, the **narrowest** of the three surfaces
(split view, narrow windows). 10–12 icon buttons + the segmented control can exceed that width.
**Strategy:** the `role="toolbar"` cluster is a fixed-height single row that **scrolls horizontally
on overflow** (`overflow-x: auto`) with a subtle edge fade affordance — it never wraps to a second
row (roving tabindex assumes a 1-D order) and never pushes the `Write | Preview` control off-screen
(that control sits outside the scrolling region). Narrow-width behavior is added to the B1 live pass.

## Testing

- **`markdownFormatting.test.ts` (pure engine — the bulk):** every action × {empty selection,
  single-line, multi-line, already-applied → toggle-off, caret/selection placement}, **plus every
  §Toggle-contract row**: marker-adjacent-outside (bold-inside-bold), trailing-whitespace match,
  italic/bold adjacency, code-inside-fence, numbered-list renumber, and Heading cycle
  `### → ## → # → strip`. No DOM.
- **`applyFormatting.test.ts` (application layer, jsdom):** the `setRangeText` fallback yields the
  right `value` + selection; `onChange` called with the post-edit value; **typing a character
  immediately after an action lands at the engine's caret** (guards the caret-restore ordering).
- **`FormattingToolbar.test.tsx`:** renders the `Write | Preview` control + the format buttons;
  roving-tabindex arrow/Home/End nav within the toolbar; the segmented control is a **separate** tab
  stop; format buttons **hidden** in preview, **disabled** in readonly/posting, control **persists**;
  a button click invokes the correct transform on a mock handle and leaves focus on the textarea.
- **Shortcuts:** `Ctrl/Cmd+B/I/K/E` fire the transforms; **`Ctrl/Cmd+B` while `disabled` fires no
  transform / no `onChange`** (§Autosave-race safety); no regression to `matchComposerKey`.
- **Preview relocation:** `ComposerActionsBar.test.tsx` — no Preview button in the footer;
  `PrRootReplyComposer` tests — no footer Preview, toolbar drives preview.
- **Live pass (B1 gate, AC):** **all three** composers (Files inline #1, thread reply #2, Overview
  reply #3), **both themes**, **narrow inline width**, in the running Electron app — real
  `Ctrl/Cmd+Z` undo of a toolbar edit, real caret restore + focus-return, roving focus, preview
  round-trip with defined focus flow.

## Acceptance criteria (from #586)

- [ ] Formatting toolbar present in the **Overview** reply composer (#3) and the **Files** inline
  composer (#1) — and, via the shared surface, the thread **reply** composer (#2).
- [ ] Each action wraps/inserts the correct markdown around the selection and restores the
  caret/selection **and focus**; wrap + line-prefix actions toggle off on a second application.
- [ ] Common actions have GitHub-consistent shortcuts (`Ctrl/Cmd+B/I/K/E`) that honor the same lock
  gate as the buttons.
- [ ] Toolbar is accessible (segmented `Write|Preview` + `role="toolbar"` roving tabindex, labelled
  + tooltipped buttons, defined focus flow, keyboard-operable) and degrades sensibly in read-only /
  preview / posting with no layout shift.
- [ ] Implemented as one shared `<FormattingToolbar>` reused across the composers — no per-composer
  duplication.
- [ ] Live-verified in the running app for **all three** composers, both themes, incl. narrow width.

## Open decision — the `@` / `#` buttons

Two independent reviewers (product-lens + adversarial) flagged the same risk and recommended
**cutting** `@`/`#` from this slice: on GitHub they open participant/PR autocomplete popovers, so a
same-looking button in a parity toolbar that only inserts a bare character (which the user can type
directly, saving zero keystrokes) **sets the exact expectation the interim cannot meet** — it reads
as unfinished and lightly trains distrust, while adding 2 of 12 buttons, 2 icons, and 2 roving
stops for zero capability. The counter-argument (and the reason they're currently in the design) is
that the user explicitly requested them as interim placeholders, with autocomplete deferred to the
follow-up issue.

**Resolution is the user's call** (recorded at the review gate): either (a) **keep** them as bare
inserts now, or (b) **cut** them and reintroduce with the autocomplete follow-up. If (b), the button
count drops to 10 and the `Mention`/`Reference` icons + labels are removed. The follow-up autocomplete
issue is filed either way.

## Follow-up

- **File a new issue** for real `@`-mention / `#`-reference autocomplete (participant/PR
  fuzzy-search popovers), cross-linked from #586.
