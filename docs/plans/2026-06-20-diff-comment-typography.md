# Diff-view Comment Typography Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Files-tab inline review comments render with the same sans typography, comfortable density, and bounded reading-width as Overview comments — resolving #522's early-wrap / wasted-space without losing GitHub-parity on authored line breaks.

**Architecture:** Three surgical edits to existing CSS + one prop flip. (1) Flip both inline `CommentCard`s from `compact` to `comfortable` density and re-home the two compact-only behaviors (`overflow-x`, image cap) that the flip would otherwise drop. (2) Add a diff-context sans-font reset + a `calc(70ch * var(--content-scale))` measure on the existing `.commentWidget` wrapper, escaping `.diffTable`'s mono cascade and bounding the column. No backend, no wire change.

**Tech Stack:** React + TypeScript + Vite, CSS Modules, vitest + @testing-library/react, Playwright (e2e/live validation).

## Global Constraints

- **Preserve authored line breaks.** `white-space: pre-wrap` on `.body p` stays (GitHub-parity); the fix bounds the measure, it does not reflow prose. (Spec § Non-goals)
- **Overview must stay byte-identical.** The sans reset and the measure live ONLY on the diff-context `.commentWidget` wrapper — never on bare `.card`. (Spec § Design change 1)
- **Code stays monospace.** Inline/fenced code keeps `var(--font-mono)` via the global `code, pre, .mono` rule (`tokens.css:393`) + `.body code` (`CommentCard.module.css:78`). Do not touch those. (Spec § Design change 1)
- **Measure tracks content-scale.** The width cap is `calc(70ch * var(--content-scale))`, not a bare `ch` literal — the markdown text is `--content-scale`-scaled (`tokens.css:420`). (Spec § Design change 3)
- **Reuse the existing 70ch prose measure** from `PrHeader.module.css:27` — do not invent a new literal. (Spec § Design change 3)
- Frontend pre-push checklist is mandatory before any push: `npm run lint` (prettier `--check` + eslint), `tsc -b` (NOT `tsc --noEmit`), `npm test`, build. Run via the local binaries, never `npx`.

---

### Task 1: Comfortable-density inline comments + re-home dropped compact behaviors

Flip both inline `CommentCard`s (real + optimistic) to `density="comfortable"` so padding, band padding, shadow, and avatar size match Overview. The flip drops two behaviors that were gated on `[data-density='compact']` — make them density-independent so comfortable cards keep them: `overflow-x: auto` on `.body` (wide code/tables scroll in-card instead of clipping into the diff gutter) and the `max-width: 100%` image cap (promoted to a global `.markdown-body img` rule).

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx:118` and `:134` (`density="compact"` → `density="comfortable"`)
- Modify: `frontend/src/components/PrDetail/Comment/CommentCard.module.css:58-66` (make `overflow-x` unconditional, delete compact-only img rule)
- Modify: `frontend/src/styles/tokens.css` (add global `.markdown-body img` cap)
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`

**Interfaces:**
- Consumes: `CommentCard` `density?: 'comfortable' | 'compact'` prop (default `comfortable`); renders `data-density={density}` on the card `<article>` (`CommentCard.tsx:39`).
- Produces: inline comment cards carry `data-density="comfortable"`. No new exports.

- [ ] **Step 1: Update the unit test to expect comfortable density**

In `ExistingCommentWidget.test.tsx`, add this test inside the existing `describe('ExistingCommentWidget', …)` block (after the "renders one CommentCard per comment" test):

```tsx
  it('renders inline comment cards at comfortable density (Overview parity)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    const cards = screen.getAllByTestId('inline-comment-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveAttribute('data-density', 'comfortable');
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend`): `.\node_modules\.bin\vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: FAIL — the new test reports `data-density` is `"compact"`, not `"comfortable"`.

- [ ] **Step 3: Flip both inline CommentCards to comfortable density**

In `ExistingCommentWidget.tsx`, change the real-comment card (currently line 118):

```tsx
          density="comfortable"
```

…and the optimistic-comment card (currently line 134):

```tsx
          density="comfortable"
```

Both `density="compact"` literals become `density="comfortable"`. No other props change.

- [ ] **Step 4: Run the test to verify it passes**

Run (from `frontend`): `.\node_modules\.bin\vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: PASS — all tests in the file green, including "renders one CommentCard per comment" and the resolved-tag test (unchanged behavior).

- [ ] **Step 5: Make `overflow-x` unconditional and drop the compact-only image rule in CommentCard.module.css**

The current text spans **two separate rules** (lines 58-66) — the compact `.body` padding rule and the compact `.body img` rule:

```css
.card[data-density='compact'] .body {
  padding: var(--s-2) var(--s-3);
  /* Wide content (code blocks, tables) scrolls inside the card instead of
     clipping into the fixed-width diff gutter. */
  overflow-x: auto;
}
.card[data-density='compact'] .body img {
  max-width: 100%;
}
```

Replace **both** rules with the compact-padding rule alone — i.e. drop `overflow-x` from the first rule (it moves to base `.body` below) and delete the second rule entirely (the img cap moves to `tokens.css` in Step 6):

```css
.card[data-density='compact'] .body {
  padding: var(--s-2) var(--s-3);
}
```

Then add `overflow-x: auto` to the base `.body` rule. Change the existing base `.body` block (lines 51-57) from:

```css
.body {
  min-width: 0;
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
}
```

to:

```css
.body {
  min-width: 0;
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
  /* Wide content (code blocks, tables) scrolls inside the card rather than
     clipping into the fixed-width diff gutter. `auto` only shows a scrollbar
     on actual overflow, so it is inert on Overview when content fits. */
  overflow-x: auto;
}
```

- [ ] **Step 6: Add a density-independent image cap in tokens.css**

In `frontend/src/styles/tokens.css`, immediately after the `.markdown-body pre { … }` rule (currently ending at line 426), add:

```css
.markdown-body img {
  max-width: 100%;
}
```

This replaces the compact-only image cap removed in Step 5 with a global one, so wide images cannot blow out the card column in any context (Overview, diff, AI surfaces).

- [ ] **Step 7: prettier-format the touched files**

Run (from `frontend`): `.\node_modules\.bin\prettier --write src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx src/components/PrDetail/Comment/CommentCard.module.css src/styles/tokens.css`
Expected: files reported as formatted/unchanged; no diff noise from prettier in the commit.

- [ ] **Step 8: Run the full frontend unit suite + typecheck**

Run (from `frontend`): `.\node_modules\.bin\vitest run` then `.\node_modules\.bin\tsc -b`
Expected: all tests pass; `tsc -b` clean. (Run vitest and tsc one at a time, never concurrently with another long command.)

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx \
        frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx \
        frontend/src/components/PrDetail/Comment/CommentCard.module.css \
        frontend/src/styles/tokens.css
git commit -m "feat(diff): comfortable-density inline comments (#522)

Flip both inline CommentCards to comfortable density for Overview parity;
re-home the two compact-only behaviors the flip drops — overflow-x:auto
becomes unconditional on .body and the image cap moves to a global
.markdown-body img rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T1WfzpE9ABLdNWzSzq515v"
```

---

### Task 2: Diff-context sans reset + bounded reading-width measure

Add two declarations to the existing `.commentWidget` wrapper (the diff-only container around all inline threads): a sans-font reset that escapes `.diffTable`'s `var(--font-mono)` cascade, and a `max-width: calc(70ch * var(--content-scale))` reading measure. Scoping both to the wrapper (not each card) means the stacked cards, the reply affordance, and the composer all share one bounded, left-anchored column. This is the dominant "prettier" fix plus the #522 width fix.

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css:1-3` (the `.commentWidget` rule)

**Interfaces:**
- Consumes: `--font-sans` (`tokens.css:10`), `--content-scale` (`tokens.css:415-416`, default `1`). The wrapper is rendered by `ExistingCommentWidget` as `<div className={`comment-widget ${styles.commentWidget}`} …>` (`ExistingCommentWidget.tsx:60`).
- Produces: no new exports; CSS-only. Code descendants still resolve mono via the global `code, pre, .mono` direct-element rule (`tokens.css:393`), which beats inherited sans.

- [ ] **Step 1: Add the sans reset + bounded measure to `.commentWidget`**

In `ExistingCommentWidget.module.css`, change the `.commentWidget` rule (lines 1-3) from:

```css
.commentWidget {
  padding: var(--s-3) var(--s-4) var(--s-4);
}
```

to:

```css
.commentWidget {
  padding: var(--s-3) var(--s-4) var(--s-4);
  /* Escape .diffTable's var(--font-mono) cascade so comment prose renders in
     the sans body font (Overview parity). Code descendants stay mono via the
     global `code, pre, .mono` rule. This also gives the `ch` measure below a
     sans context. */
  font-family: var(--font-sans);
  /* #522 — bound the inline-comment column to a readable measure, left-anchored.
     70ch reuses PrHeader's prose measure; scaling by --content-scale keeps the
     character measure constant as the #135 content-scale control changes text
     size (the markdown body is content-scale-scaled). Upper bound only — a
     narrow split pane simply takes the available width. */
  max-width: calc(70ch * var(--content-scale));
}
```

- [ ] **Step 2: prettier-format the touched file**

Run (from `frontend`): `.\node_modules\.bin\prettier --write src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css`
Expected: formatted/unchanged.

- [ ] **Step 3: Run the unit suite + typecheck (no regression)**

Run (from `frontend`): `.\node_modules\.bin\vitest run src/components/PrDetail/FilesTab/DiffPane/` then `.\node_modules\.bin\tsc -b`
Expected: PASS / clean. (CSS-only change — jsdom can't assert font-family/layout; the visual effect is verified in Task 3's live pass. The unit run confirms nothing broke.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css
git commit -m "feat(diff): sans typography + bounded measure for inline comments (#522)

Reset font-family to var(--font-sans) on the diff-context comment wrapper to
escape .diffTable's mono cascade, and cap the column at calc(70ch *
var(--content-scale)) so prose reads at a bounded, left-anchored measure.
Code descendants stay mono via the global code/pre/.mono rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T1WfzpE9ABLdNWzSzq515v"
```

---

### Task 3: Live validation, e2e baseline check, and pre-push verify

CSS/layout changes are not unit-testable in jsdom — this task is the real verification gate (Spec § Testing "Live validation (required before done)"). Capture before/after in both themes and both Unified + Split modes, confirm the spec's acceptance points, sweep e2e baselines, and run the full pre-push checklist.

**Files:**
- No source changes (verification only). Possible: regenerate a Linux e2e visual baseline via the CI-artifact path if the typography shift moves a snapshot.

**Interfaces:**
- Consumes: the running app against the real token store (per project memory — serve detached with `-DataDir` the real store; NEVER `-Reset` it), Playwright for screenshots.
- Produces: before/after screenshots posted to the PR; green pre-push checklist.

- [ ] **Step 1: Launch the app against the real token store (detached)**

Serve the app detached against the real token store on port 5180, started so it survives the harness's job-object cleanup. The recipe: build the SPA, then launch `run.ps1 -Reset None --no-browser` via `Win32_Process.Create` (WMI) rather than a backgrounded child — a harness-reaped child dies between tool calls. (Full recipe in project memory `reference_windows_detached_server_win32_process_create`.) Do NOT pass `-Reset Token` / `-Reset Full` — that would wipe the real PRism PAT. Open a PR that has inline review comments including (a) a fixed-column-wrapped prose comment and (b) a comment with inline code and a code fence.

- [ ] **Step 2: Capture before/after screenshots — both themes × {Unified, Split}**

With Playwright, capture the Files-tab diff with an open inline comment thread in: light+Unified, light+Split, dark+Unified, dark+Split. (For "before", git stash or compare against `main`'s rendering.) Confirm each acceptance point below — **each bullet must hold in both themes independently; do not accept dark as passing on visual resemblance to light alone** (the oklch surface scales and the `--shadow-2` token are theme-asymmetric, so the comfortable shadow and the column's left-edge alignment against the gutter can diverge between themes):

- Prose renders in **sans**; inline + fenced code stays **mono**.
- **No empty right band** on the fixed-column comment; **no page-level horizontal scrollbar** (coordinate with #514).
- Wide code/tables/images still **scroll/cap inside the card**; confirm the narrower 70ch column doesn't make common code fences scroll that previously fit (Spec open question O3 — finalize the `ch` value here if 70 reads too tight/loose). **Keep any adjustment inside the 45–90ch readable band**; a value outside that band changes the design intent (effectively removing the measure) and needs a fresh design sign-off, not an in-band implementer call.
- **Left-anchor:** the bounded card's left edge aligns with the code column, not pinned to the sticky-viewport left edge — check wide Unified (where `.diffStickyViewport` is active) and Split.
- **Composer/affordance alignment:** the reply affordance and `ReplyComposer` share the bounded column width with the cards (no wider-than-cards row). Then **focus** the composer textarea and the reply-affordance button and confirm the focus ring renders fully inside the `.commentWidget` column — it must not clip against the diff gutter or trigger a horizontal scrollbar — in both Split and Unified.
- **Resolved thread:** the dimming lives on the thread container, not the card — `.commentThreadResolved { opacity: 0.72 }` with `:hover { opacity: 1 }` (`ExistingCommentWidget.module.css:9-15`), unchanged by the density flip. Confirm the `0.72` dim still reads as "resolved" at the now-heavier comfortable density (larger avatar, `--shadow-2`) in both themes, and that hovering anywhere on the thread restores it to full opacity. (Keyboard-focus restore is **out of scope** — the existing rule is `:hover`-only; do not add `:focus-within` here. If it reads as a gap, file it separately, don't fold it in.)
- **Content-scale:** check **both ends** of the #135 control — `xl` (1.4 → `98ch` cap, largest) and `xs` (0.8 → `56ch` cap, smallest) — and confirm the measure scales with the text so prose is neither over-tight at `xl` nor under-bounded at `xs`. (Both stay inside the 45–90ch… note `xl`'s 98ch slightly exceeds 90ch — acceptable, it tracks the enlarged glyph; flag only if it reads too wide.)
- **Overview unchanged — concrete scenario:** open a PR comment **containing a wide code fence that still fits within Overview's 920px column** on the Overview tab, and confirm NO horizontal scrollbar appears inside or outside the card (proves the now-unconditional `overflow-x: auto` is genuinely inert when content fits, not merely absent because the test comment happened to be narrow). Then confirm Overview typography and width are otherwise identical to `main`.

- [ ] **Step 3: Sweep e2e visual/parity baselines**

Check `frontend/e2e` for any visual/parity spec that snapshots an inline comment card or the Files-tab diff with comments. If the typography change shifts a baseline, regenerate the **Linux** baseline via the CI-artifact path (project memory `reference_regen_linux_parity_baseline_via_ci_artifact`) — do not commit a win32-generated baseline.

Run (from `frontend`): `.\node_modules\.bin\playwright test` (or the diff/comment-scoped spec) and review any visual diff before accepting.

- [ ] **Step 4: Run the full frontend pre-push checklist**

From `frontend`, one at a time (kill any prior long-running command first):
1. `.\node_modules\.bin\prettier --check .`  → clean
2. `npm run lint`  → eslint clean (prettier `--check` is inside this too)
3. `.\node_modules\.bin\tsc -b`  → clean
4. `.\node_modules\.bin\vitest run`  → all pass
5. `npm run build`  → succeeds

Expected: every step green. (This mirrors CI — run it verbatim, not a self-curated subset.)

- [ ] **Step 5: Open the PR**

Use the pr-autopilot skill (default per project workflow). PR body must include a `## Proof` section with the before/after screenshots, the ce-doc-review disposition table, and the live-validation checklist results. Link `#522`; note `#564` as the systemic follow-up and `#514` as the coordinated overflow issue. (#522 is a normal `main` issue — the conventional `fix(#522):` auto-close caveat applies only if you want it kept open; use bare `#522` per the spec if so.) Then trigger the bot review with `@claude review`.

---

## Self-Review

**Spec coverage:**
- Design change 1 (sans reset) → Task 2 ✓
- Design change 2 (comfortable density + handle 3 dropped behaviors: avatar sm→md is automatic via the prop; overflow-x → Task 1 Step 5; img cap → Task 1 Step 6) ✓
- Design change 3 (bounded `calc(70ch * var(--content-scale))` measure, wrapper-level, left-anchored) → Task 2 ✓
- Components & boundaries table (ExistingCommentWidget.module.css, .tsx, CommentCard.module.css, tokens.css; no CommentCard.tsx logic change; no backend) → Tasks 1-2 cover exactly those files ✓
- Open question O3 (exact ch value) → Task 3 Step 2 (finalize in live pass) ✓
- Testing § (unit comfortable-density, Overview regression, live validation both themes/modes, e2e baseline) → Task 1 unit test + Task 3 ✓
- Coordination: #514 (page-scrollbar interaction check) → Task 3 Step 2; #564 (root-cause follow-up, documented in the PR) → Task 3 Step 5 ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"add validation". Every CSS/TSX step shows the full before+after text. The only deferred decision is O3's exact `ch` value, which the spec explicitly scopes to live validation — flagged, not hand-waved.

**Type consistency:** `density` values (`'comfortable'`/`'compact'`) match `CommentCard.tsx:6`. `data-density` attribute name matches `CommentCard.tsx:39`. `data-testid="inline-comment-card"` matches `ExistingCommentWidget.tsx:119`. Token names `--font-sans`, `--content-scale` verified against `tokens.css:10,415-416`. Line numbers verified against current file contents.
