# PR4 — design-parity-recovery: Files tab (CSS)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 13 spec §4.4-enumerated FilesTab + DiffPane + Composer component specifications (15 distinct JSX files; some specifications cover sub-components like DiffTruncationBanner under DiffPane) into visual parity with `design/handoff/screens.css`. Per spec §4.4 PR4 is the largest CSS slice of the design-parity-recovery roadmap (~13 components, ~600 LOC of handoff CSS to port, the most cross-component CSS in the roadmap per §6.6) and the natural slice to fulfil PR3's deferred D15 (composer-primitive lift to `tokens.css`) and D21 (open-composer baseline) plus PR1's deferred D4 (`Calc.cs` per-file selector tightening).

**Architecture:** Port the relevant rules from `design/handoff/screens.css` (`.iter-*` block L129-209, `.tree-*` block L523-585, `.diff-*` block L591-679, `.diff-add-comment-bar` L697-701, `.comment-*` block L728-732, `.composer-*` block L760-776, `.ai-hunk*` block L824-837) into per-component CSS modules colocated with each `.tsx`, AND lift the 7 shared composer-inner classes to `tokens.css` per §3.1 lift-on-second-use rule (used by all 3 composers — Inline + Reply + PrRootReply). Composes with existing global primitives from `tokens.css` (`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-icon`, `.btn-link`, `.muted`, `.tnum`, `.ai-tint`, `.ai-icon`, `.chip`, `.chip-status-*`, `.kbd`, `.banner`, `.banner-warning`). Production JSX class names diverge from handoff naming in **every** PR4 component (production uses `iteration-tab*` / `file-tree*` / `diff-pane*` / `diff-gutter*` / `compare-picker*` / `commit-multi-select-picker*` while handoff uses `iter-chip*` / `tree-*` / `diff-area*` / `diff-line*` / `iter-compare` / no equivalent) — far heavier divergence than PR3. Per the D12 precedent, per-component module CSS uses production class names as the source of truth and ports the handoff *visual treatment* rather than rename-to-match. Vitest unit-test queries migrate from `.querySelector('.x')` to `getByTestId(...)` or to module-imported `styles.x` assertions (D16 precedent).

**Tech Stack:** React 19 + Vite + TypeScript + CSS Modules + Vitest + Playwright (parity baselines).

---

## Deviations from spec §4.4 (working assumptions — entered as D25-D42 in deferrals at Task 23)

These are PR4-discovered gaps. Each is a deliberate choice surfaced during plan-writing pre-flight; full rationale lands in the deferrals sidecar at Task 23. If Task 1 pre-flight surfaces a contradicting signal, the implementer stops and reports.

| # | Topic | Working assumption | Why it's a deviation |
|---|-------|---------------------|----------------------|
| **D25** | Production-vs-handoff naming divergence is total in PR4 | Author module CSS under PRODUCTION class names; port handoff *visual treatments* into them. Do NOT rename JSX to match handoff selectors. Apply per-component: `iteration-tab*` (production) gets the visual treatment of `iter-chip*` (handoff); `file-tree*` gets `tree-*`'s treatment; `diff-pane*` + `diff-gutter*` + `diff-content` gets `diff-area*` + `diff-body*` + `diff-line*`'s treatment; etc. | D12 (PR3) established this. PR4 magnifies the divergence: 5 of the 13 components have ZERO direct handoff naming overlap, and 3 of those (`CommitMultiSelectPicker`, `ComparePicker`, `MarkdownFileView`) have no handoff equivalent at all — production-only conventions PR4 must style without a handoff source. JSX rename is a logic-shaped change per §2.2; it would break ~25 vitest test selectors and force a JSX-restructure on every PR4 component for no design benefit. |
| **D26** | 6 composer-inner classes lifted to `tokens.css` (D15 fulfillment); badge variants align with production `ComposerSaveBadge` union | Append 6 global rules to `tokens.css` (`.composer-textarea`, `.composer-preview-toggle`, `.composer-badge` + `.composer-badge--{saved,saving,unsaved,rejected}` modifiers, `.composer-discard`, `.composer-closed-banner`, `.composer-actions`) sourced from `screens.css` lines 760-776 plus production extensions. Badge state union is `'saved' \| 'saving' \| 'unsaved' \| 'rejected'` (verified at `frontend/src/hooks/useComposerAutoSave.ts:5`); the original-plan-draft `--error` variant DOES NOT EXIST in production and is dropped. The `.composer-save` literal-class is NOT lifted — production JSX composes `composer-save btn btn-primary btn-sm` and the `.btn .btn-primary .btn-sm` globals supply all visual treatment; an empty `.composer-save` stub rule would be speculative future-anchor with no current consumer (scope-guardian #1). All 3 composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`) consume the lifted 6 — unambiguously qualifies for §3.1 lift-on-second-use. | D15 (PR3) deferred these classes from PR3's `PrRootReplyComposer` work explicitly to PR4. Aligning the badge variants with the production union prevents the dormant `--error` rule from shipping AND prevents the missing `--unsaved`/`--rejected` from going unstyled. Note: PR3's existing `.composer-actions` rule in `PrRootReplyComposer.module.css` is hash-scoped — PR4 REPLACES it with a `tokens.css` global so InlineCommentComposer + ReplyComposer consume it via the literal class. |
| **D27** | Drop `.composer-actions` `margin-top: var(--s-2)` per PR3's D15 annotation | When lifting `.composer-actions` to `tokens.css` at Task 4, port `display: flex; justify-content: space-between; align-items: center; gap: var(--s-2);` — but DROP the `margin-top: var(--s-2)` token. PR3's b4a916b annotation: parent already provides `gap: var(--s-2)` between `.composer-textarea` and `.composer-actions`, so `margin-top` doubles the visual gap on the open-composer state. | PR3 b4a916b documents the gotcha. Closing it in PR4 is the natural moment — the global rule replaces PR3's `PrRootReplyComposer.module.css` `.composerActions` rule, so dropping `margin-top` from the global rule also retroactively fixes PR3's open-composer Overview state. |
| **D28** | IterationTabStrip — chip-num + chip-meta inner spans only; iter-new-dot DEFERRED (no production data source) | The handoff chip renders chip-num + chip-label + chip-meta (`+adds`/`-rems`) + iter-new-dot. Production `IterationDto` (`frontend/src/api/types.ts:162-168`) carries only `{ number, beforeSha, afterSha, commits: CommitDto[], hasResolvableRange }` — there are NO `additions`/`deletions`/`isNew` fields. PR4 ships: (a) chip-num span rendering `{iteration.number}`; (b) chip-label span rendering the existing `Iter ${iteration.number}` computed string the production JSX already constructs (`IterationTabStrip.tsx:84`); (c) chip-meta with `+adds`/`-rems` spans where adds/rems are **client-side derived** by summing `iteration.commits[].additions` + `commits[].deletions` (CommitDto already exposes additions/deletions per types.ts:158-159). iter-new-dot is NOT rendered — there is no "new iteration" flag in production state, and synthesizing one requires new state (out of §2.2 scope). The omission is documented in the sidecar; PR9 revisit can decide whether to wire it via a state hook. Accessible name preserved: chip button keeps the visible label "Iter N"; existing tests using `getByText('Iter N')` continue to match because the literal `"Iter "` text + `"{number}"` text remain in the chip's accessible name (chip-num span carries the number as visible text, NOT `aria-hidden`). | §4.4 explicitly lists "chip cards with +/− counts, new-iteration dot" as restored visuals (line 249). §2.2 permits "small JSX restructuring" alongside class-name changes. The +/- counts are derivable from existing data; iter-new-dot is not. Splitting the deviation between "added" and "deferred" portions is honest about what production currently supports. |
| **D29** | Production `iteration-tab--more` chip is the handoff "All iterations" entry-point | Style `iteration-tab--more` (the overflow trigger) per handoff `iter-chip-more` (dashed border-style + `--text-3` color). The dropdown panel uses production `iteration-dropdown` + `iteration-option` shape; author it from scratch — the handoff prototype renders the overflow inline rather than as a dropdown, no direct handoff source. | Production renders an actual dropdown listbox (~30 lines of structured JSX in `IterationTabStrip.tsx:39-64`); handoff just renders the overflow chip inline. The dropdown wiring is existing logic; PR4 styles it without a handoff reference (`iteration-dropdown` shell + `iteration-option` rows + `iteration-option--disabled` modifier). New production-only rules; flagged for PR9 visual-coherence review. |
| **D30** | CommitMultiSelectPicker — no handoff equivalent; production-only styling | Author `CommitMultiSelectPicker.module.css` from scratch. Trigger button reuses `.btn .btn-ghost .btn-sm` globals + a minimal module class for the listbox shell (border + box-shadow + max-height + overflow-y). Per-option row uses module `.commitPickerOption` + `--focused` modifier. SHA prefix uses `.tnum` global. The whole picker shows only on the low-quality clustering path (capability-gated). | The picker is a S3-era production affordance that the handoff prototype never demoed. No design source. Style for keyboard-affordance clarity (visible focused state) and consistency with the iteration strip surface. Flagged for PR9 visual-coherence review. |
| **D31** | ComparePicker — handoff `iter-compare` is a single chip; production is a 2-select + arrow | Author `ComparePicker.module.css` from scratch. Container is `display: inline-flex; gap: var(--s-2); align-items: center;`. Each `<label>` stacks label-text + `<select>`. The `⇄` arrow gets `color: var(--text-3); font-size: var(--text-sm);`. The `compare-picker-empty` status fallback uses `.muted` global + small font-size. | Handoff `iter-compare` (L199-209) is one chip that opens a comparison flyout. Production renders two side-by-side `<select>`s with an arrow between — different interaction model (a S3-era decision). Visual treatment derived from the surrounding chip-card surface tokens; flagged for PR9 visual-coherence review. |
| **D32** | FileTree — port handoff `.tree-*` visuals under production `file-tree*` names; file-status enum is `'added' \| 'modified' \| 'deleted' \| 'renamed'` (verified at `frontend/src/api/types.ts:209`) | The production family is wider than the handoff family: `file-tree`, `file-tree-header`, `file-tree-empty`, `file-tree-list`, `file-tree-file`, `file-tree-file--selected`, `file-status`, `file-status--{added,modified,deleted,renamed}` (4-value enum — NO `removed`, NO `copied`), `file-tree-file-name`, `file-tree-spacer`, `file-tree-viewed-checkbox`, `file-tree-dir`, `file-tree-dir-header`, `file-tree-dir-toggle`, `file-tree-chevron`, `file-tree-chevron--open`, `file-tree-dir-name`. Map handoff treatments: `tree-row` → `.fileTreeFile`; `tree-row.is-selected` → `.fileTreeFileSelected`; `tree-row.is-viewed` → no production class today (the viewed state is in the checkbox `<input>` only — flagged in D33); `tree-status-success/warning/danger/info` → `.fileStatusAdded/Modified/Deleted/Renamed`; `tree-name` → `.fileTreeFileName` + `.muted`-ish color; `tree-counts` / `tree-add` / `tree-rem` → small module rules with `.tnum`; `tree-ai` AI focus dot → DORMANT module rule `.fileTreeAi` (the JSX wiring for the dot does not exist in production today; rule is dormant per §6.2 dormant-CSS policy, matching PR3 D17 precedent — see D32a). | Naming asymmetry per D25. The directory-tree shape (`file-tree-dir` + `file-tree-dir-header` + chevron) has no handoff equivalent because the handoff prototype renders a flat file list — production added directory grouping as a usability win. Style the directory shell from production conventions. File-status enum is the FileChangeStatus union, not the handoff's semantic labels — verified against source. |
| **D32a** | `.fileTreeAi` dormant rule ships in PR4; JSX wiring deferred to PR9 | Author `.fileTreeAi { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }` as a module rule in `FileTree.module.css`. JSX does NOT render `<span class="file-tree-ai">` today (no `aiPreview` consumption in `FileTree.tsx`; no `aiFocus` field on `FileChange`). The dormant rule is ready for PR9 to wire (e.g., conditionally render the dot when `aiPreview && (file as any).aiFocus`). | Spec §4.4 line 249 calls out "AI focus dot when `aiPreview` is on" as a restored visual. Production lacks the data path. Per PR3 D17 dormant-CSS precedent (coherent design intent, single component scope), ship the rule + defer wiring. Reviewer concern that this is YAGNI is acknowledged; same trade as D17 — "1 dormant rule now" vs "second CSS pass when wiring lands." |
| **D33** | FileTree viewed-state is on the checkbox, not the row | The handoff strikes through the file basename via `.tree-row.is-viewed .tree-name .tree-base`. Production has no `is-viewed` row modifier; the viewed-state is on the `<input type="checkbox">` (`file-tree-viewed-checkbox`). PR4 ports the handoff treatment via a sibling-selector trick: `.fileTreeFile:has(input.fileTreeViewedCheckbox:checked) .fileTreeFileName { color: var(--text-3); text-decoration: line-through; ... }`. If `:has()` support is uncertain, fall back to wiring an `aria-checked` modifier on the row (small JSX touch, §2.2 permits). | The handoff DOM has a state class on the row; production DOM has the state in the checkbox. The CSS `:has()` selector (Baseline 2023, supported in all modern Chromium/Safari/Firefox per Vite's targeted browsers) bridges them without a JSX change. Document the `:has()` choice in the deferrals sidecar for the future-coverage audit. |
| **D34** | DiffPane diff-line tinting — production class is `.diff-line .diff-line--{insert,delete,context,hunk-header}` (verified at `DiffPane.tsx:193`); lift to `tokens.css` globals | Port handoff diff-line visual treatments onto production's existing literal BEM classes. The class `.diff-line` + modifiers `.diff-line--insert`/`.diff-line--delete`/`.diff-line--context`/`.diff-line--hunk-header` are emitted by the rowClass template literal in `DiffPane.tsx:193` — these are bare global strings with no rules today, exactly matching the §3.1 lift-on-second-use case for any class string used across the diff-pane. PR4 **lifts to `tokens.css`** at Task 10 Step 10.2: `.diff-line` (font-mono base), `.diff-line--insert` (background: `var(--diff-add-bg)`), `.diff-line--delete` (background: `var(--diff-rem-bg)`). DiffPane.module.css supplies the gutter, content, hunk-header, and composer/comment-row classes. The colspan-3 rendering of `ExistingCommentWidget` and `InlineCommentComposer` under `<tr class="diff-comment-row">` / `<tr class="diff-composer-row">` stays as-is — no JSX scaffold change. The handoff `.diff-line-sbs` side-by-side split is **NOT** ported in PR4 (production is unified-only today; SBS is a S3 deferral). | The DOM scaffold shape difference (`<table>` vs `<div>`) is irrelevant to the CSS color treatments. Using the existing literal BEM classes (vs adding `data-kind` attributes) means no JSX touch on the per-row render — the rule fires off the existing class string. Lifting to `tokens.css` instead of module-scoping avoids hashing the rule (the literal class is what JSX emits; the literal is the styling hook). |
| **D35** | `.diff-pane--empty` no-file-selected rule is new production-only design | Author `.diffPane--empty` in `DiffPane.module.css` (`display: flex; align-items: center; justify-content: center; padding: var(--s-5); min-height: 200px;` plus `.muted` global on the inner `<p>`). The handoff prototype always pre-selects a file, so the empty-state surface doesn't exist there. | Spec §4.4 explicitly calls this out ("the handoff has no `.diff-pane-empty` rule, and this surface is unavoidable in production"). The visual treatment derives from "centered muted text on the surface" — consistent with `DraftListEmpty` and `compare-picker-empty` empty-state precedents. Logged for PR9 to compare against the restored Files-tab visual language. |
| **D36** | Loading-state Loading… overlay — JSX-driven (`<span>Loading…</span>`); requires threading `isLoading` prop through `DiffPaneProps` | Spec §4.4 line 253 describes a `var(--text-3)` Loading… overlay in the diff toolbar area during in-flight diff fetches. `DiffPane.tsx:12-33` `DiffPaneProps` does NOT carry `isLoading` today (it's on `FileTree`, not `DiffPane`). PR4 threads it: add `isLoading?: boolean` to `DiffPaneProps`; `FilesTab.tsx` passes `isLoading={diff.isLoading}` on the existing `<DiffPane>` mount (`FilesTab.tsx:378-385` region — verify exact line). DiffPane renders a JSX `<span className="diff-pane-loading muted">Loading…</span>` conditional on `isLoading` (B-style, JSX-driven). CSS-only `::after { content: "Loading…" }` (the previous Option A) is **rejected** because CSS-generated content is not announced by screen readers (WCAG 2.1 F87 failure). The JSX `<span>` is naturally in the a11y tree and consumable by screen readers. | Closes the prop-threading gap that would have silently no-op'd a CSS-only attribute-driven approach. JSX rendering also avoids the F87 accessibility hit. Prop threading is a small §2.2-compliant additive prop, not a logic restructure. |
| **D37** | WordDiffOverlay — production-only; no handoff source | Author `WordDiffOverlay.module.css` from scratch. `.wordDiffOverlay` wraps a span; `.wordDiffInsert` gets `background: var(--diff-add-bg); color: var(--success-fg);`; `.wordDiffDelete` gets `background: var(--diff-rem-bg); color: var(--danger-fg); text-decoration: line-through;`. | The handoff renders no word-level diff overlay (production was authored to surface a finer-grained diff for visual scanning — a S3-era win). No direct source; treatment matches the surrounding diff-add/diff-rem color tokens. Flagged for PR9 visual-coherence review. |
| **D38** | MarkdownFileView — production-only; no handoff source | Author `MarkdownFileView.module.css` from scratch. `.markdownFileView` = `padding: var(--s-4); background: var(--surface-1);`. `.markdownFileViewToolbar` = horizontal flex with `.toggleBtn` `<button>` siblings; `.toggleBtn--active` = filled accent treatment matching `.iterChip.is-active`. `.markdownFileViewContent` = vertical column. `.markdownRaw` = `font-family: var(--font-mono); font-size: var(--text-sm); white-space: pre; overflow-x: auto;`. Rendered Markdown uses the existing global Markdown styling (presumably via `tokens.css`'s document defaults or a shared MarkdownRenderer component). | Production-only affordance for `.md`/`.markdown` file paths. Treatment matches the surrounding diff-pane surface. Logged for PR9. |
| **D39** | Composer outer-classes are 3 modules; inner-classes are 7 globals in `tokens.css` | Three composer-outer classes (`inline-comment-composer`, `reply-composer`, the PrRootReplyComposer outer already ported in PR3) each get their own `.module.css` for the outer container only — flex layout, padding, surface, border. The 7 inner classes (D26) all live globally in `tokens.css` post-Task 4. JSX consumes the outer as `${styles.x}` and the inner classes as literal global strings. PR3's `PrRootReplyComposer.module.css` keeps its outer rule (already correct); the local `.composerActions` rule is REMOVED at Task 4 because the global takes over. | Mirrors PR3's test-seam-and-styling-hook unification (D16). Outer is unique per composer (different padding/background — e.g., InlineCommentComposer is mounted inside a `<table>` colspan-3 cell with no surface; ReplyComposer is mounted inside `ExistingCommentWidget` with no surface; PrRootReplyComposer sits on Overview with a `var(--surface-2)` surface). Inner classes are shared treatment — the lift consolidates them. |
| **D40** | D21 fulfillment is implicit (no new baseline zone) | PR3 D21 deferred the open-composer baseline to PR4. PR4 does NOT add a new `pr-detail-overview-composer-open.png` zone to `parity-baselines.spec.ts`. After the composer-primitive lift at Task 4, the open-composer state on Overview is styled by the global rules in `tokens.css` — the regression gate for that state is implicit (any future regression in the lifted globals will be caught by every PR detail baseline that captures a composer-open state, none of which exist today, so the implicit gate is "the lifted globals don't change without authoring intent"). | Spec §4.4 line 257 enumerates two PR4 baselines: file tree zone, diff pane zone. Adding a third zone for the open-composer state would be brittle (the composer mount is a click-interaction state) and is not in §4.4 scope. D21 is reframed: "PR4 makes the open-composer state visually correct; the test-coverage of that state is left to the natural growth of vitest unit tests on the composers." Logged for PR9 to audit. |
| **D41** | D4 selector tightening — landed at Task 20 alongside un-fixme | The Calc.cs file-row selector (`page.locator('[data-testid="files-tab-tree"]').getByText('Calc.cs').click()`) is tightened to `page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click()` at Task 20 Step 20.2, alongside the un-fixme + baseline capture for `pr-detail-files-diff`. JSX adds `data-testid="files-tab-tree-row"` + `data-path={node.file.path}` to the `FileTreeFileNode` row. | D4 was a hand-off note from PR1 to PR4. PR4 owns the FileTree DOM and is the natural moment to ship the stable per-file selector. Adding both attributes is a §2.2-compliant small JSX restructure (additive attributes; no state or routing change). |
| **D42** | Split-checkpoint between Task 9 and Task 10 | If by Task 9 (FilesTab outer shell) the diff count crosses ~600 LOC of CSS OR ~8 review-meaningful changes, the implementer commits PR4 as PR4a (Tasks 1-9 + 20-24 left-half slice) and starts PR4b in a separate worktree with Tasks 10-19. Default is single-PR4: no split unless the threshold is empirically crossed. Per spec §4.4 line 255 / §6.6 implementer authority. | The natural left/right split is between FileTree (Task 8) + FilesTab shell (Task 9) and DiffPane + sub-components (Tasks 10-19). Pre-committing the split would force a coordination tax on cross-pane CSS (DiffPane references comment widget + composer primitives — Task 4's lift covers most of it, but per-component module CSS still composes across the boundary). Default to single-PR4 and let the implementer judge from actual measurements. |

---

## File structure

**New module CSS files (14):**

- Create: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.module.css`
- Create: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.module.css`
- Create: `frontend/src/components/PrDetail/Composer/ReplyComposer.module.css`
- Create: `frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.module.css`

(That's 14 new files. PR3's `PrRootReplyComposer.module.css` already exists and gets a one-rule trim — see Task 18.)

**Modified JSX files (16):**

- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.tsx` (small additive JSX per D28)
- Modify: `frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (small additive JSX per D41 — `data-testid="files-tab-tree-row"` + `data-path` on each file row)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx` (drop local `.composerActions` reference; literal global takes over)
- Modify: `frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.tsx`

(That's 15 — `PrRootReplyComposer.tsx` and its module both touched. PrRootReplyComposer.module.css is the 16th file in the modified set — see "Modified shared CSS" below.)

**Modified test files:**

Vitest selectors that currently use `.querySelector('.file-tree-file')`, `.querySelector('.iteration-tab')`, `.querySelector('.diff-pane')`, etc. migrate to `getByTestId(...)` or module-imported `styles.x`. Exact file list determined by Task 1 Step 1.2 grep.

**Modified shared CSS (D26 + D27 + D34 + D39 lifts):**

- Modify: `frontend/src/styles/tokens.css` — append 6 composer-inner global rules at Task 4 Step 4.2 (`.composer-textarea`, `.composer-preview-toggle`, `.composer-badge` + 4 variant modifiers, `.composer-discard`, `.composer-closed-banner`, `.composer-actions` with `margin-top` dropped per D27); append 4 diff-line global rules at Task 10 Step 10.4 (`.diff-line`, `.diff-line--insert`, `.diff-line--delete`, `.diff-line--hunk-header`); replace PR3's `PrRootReplyComposer.module.css` `.composerActions` rule by lifting it as `.composer-actions`.
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css` — drop the local `.composerActions` rule (Task 4 Step 4.3); keep the `.prRootReplyComposer` outer rule untouched.

**Playwright spec un-fixme + baseline captures (Tasks 20-21):**

- Modify: `frontend/e2e/parity-baselines.spec.ts` (remove `.fixme` on `pr-detail-files-tree` and `pr-detail-files-diff`; update D4 `Calc.cs` selector per D41)
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png` (first capture)
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png` (first capture)

**Deferrals sidecar (append D25-D42 + D32a):**

- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

---

## Task 1: Pre-flight survey — confirm scope and surface any missing consumers

**Files:**
- Read-only scans across `frontend/src/` and `frontend/__tests__/` and `frontend/e2e/`.

- [ ] **Step 1.1: Verify the production class strings PR4 will rewrite are limited to the 15 JSX files this plan lists**

Run from worktree root:

```bash
grep -rn --include="*.tsx" --include="*.ts" \
  -e "iteration-tab" -e "iteration-dropdown" -e "iteration-option" \
  -e "commit-multi-select-picker" -e "commit-picker-" \
  -e "compare-picker" \
  -e "file-tree" -e "file-status" -e "skeleton-row" \
  -e "files-tab" \
  -e "diff-pane" -e "diff-gutter" -e "diff-table" -e "diff-content" -e "diff-hunk-header" -e "diff-comment-affordance" -e "diff-comment-row" -e "diff-composer-row" -e "diff-line" \
  -e "ai-hunk" \
  -e "comment-widget" -e "comment-thread" -e "comment-entry" -e "comment-meta" -e "comment-author" -e "comment-time" -e "comment-body" \
  -e "diff-truncation-banner" \
  -e "markdown-file-view" -e "markdown-raw" -e "toggle-btn" \
  -e "word-diff-overlay" -e "word-diff-insert" -e "word-diff-delete" \
  -e "inline-comment-composer" -e "reply-composer" -e "composer-markdown-preview" \
  -e "composer-textarea" -e "composer-preview-toggle" -e "composer-badge" -e "composer-discard" -e "composer-save" -e "composer-closed-banner" -e "composer-actions" \
  frontend/src/
```

Expected output: the 16 files listed in the "Modified JSX files" section above, plus any expected-out-of-scope match the implementer surfaces while reading.

Treat these as expected-out-of-scope (mirror of PR3's `AiComposerAssistant` carve-out):

- `frontend/src/components/Ai/AiComposerAssistant.tsx` — already noted in PR3 D12 as a separate AI placeholder, capability-gated false. May still use `composer-*` bare literals; not in PR4 scope unless the grep shows it referencing the composer-inner classes PR4 lifts. If it does, **stop and report** — the lifted-global path likely just works for AiComposerAssistant too (no module wiring needed), but the implication needs surfacing.

If the grep returns a file outside the planned 16, **stop and report**. Apply the plan-amendment pattern (`feedback_document_plan_deviations.md`) — extend the relevant task to cover the extra file, or escalate if it indicates scope drift.

- [ ] **Step 1.2: Identify Vitest test files querying PR4 classnames**

```bash
grep -rln --include="*.test.tsx" --include="*.test.ts" \
  -e "\.iteration-tab" -e "\.commit-picker" -e "\.compare-picker" \
  -e "\.file-tree" -e "\.file-status" -e "\.files-tab" \
  -e "\.diff-pane" -e "\.diff-gutter" -e "\.diff-table" -e "\.diff-content" \
  -e "\.ai-hunk" -e "\.comment-widget" -e "\.comment-thread" \
  -e "\.diff-truncation" -e "\.markdown-file-view" -e "\.word-diff" \
  -e "\.inline-comment-composer" -e "\.reply-composer" -e "\.composer-" \
  frontend/__tests__/ frontend/src/
```

Record the file list. Each surfaced file is migrated at Task 3. **Note** the count for budget tracking (Task 21 split-checkpoint decision uses it).

If the grep returns more than ~10 files, the migration is larger than PR3's 5 and the split-checkpoint at Task 21 should weight it. Do not stop; record and continue.

- [ ] **Step 1.3: Confirm Playwright specs DO NOT use PR4 classnames as selectors**

```bash
grep -rln --include="*.spec.ts" \
  -e "\.iteration-tab" -e "\.file-tree" -e "\.file-status" -e "\.files-tab" \
  -e "\.diff-pane" -e "\.diff-gutter" -e "\.diff-table" -e "\.diff-content" \
  -e "\.ai-hunk" -e "\.comment-widget" -e "\.comment-thread" \
  -e "\.composer-" -e "\.markdown-file-view" \
  frontend/e2e/
```

Expected output: empty (no matches). Playwright uses `data-testid` + role/text selectors.

If matches surface, **stop and report**.

- [ ] **Step 1.4: Establish vitest + dotnet + Playwright pre-change baselines**

```bash
cd frontend && npm run test -- --run 2>&1 | tail -20
cd .. && dotnet test --no-restore 2>&1 | tail -20
```

Record the pass count. PR4 will run these again at Task 24 — pass-count parity is the gate. If either suite is RED at baseline, **stop and report** — PR4 must start from a green baseline.

Playwright runs at Task 20-21 + Task 24, not at Task 1 (too expensive for a baseline read).

- [ ] **Step 1.5: Commit pre-flight notes (or proceed if nothing changed)**

No code changes from Task 1. If steps 1.1-1.4 all match expectations, proceed to Task 2 with no commit. If a discrepancy was reported and the plan was amended in conversation, commit the plan amendment before proceeding:

```bash
git add docs/plans/2026-05-30-design-parity-recovery-pr4-files-tab.md
git commit -m "docs(pr4): amend plan after Task 1 pre-flight surfaced <discrepancy>"
```

---

## Task 2: Add `data-testid` attributes to PR4 components

**Files:**
- Modify each of the 15 JSX files listed in the "Modified JSX files" section as needed.

`data-testid` attributes are the selectors PR4's vitest migration (Task 3) and the parity-baselines `pr-detail-files-tree` + `pr-detail-files-diff` zones (Tasks 20-21) consume. Add them in one focused pass before any styling work.

- [ ] **Step 2.1: Add `data-testid="files-tab"` to FilesTab root**

In `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:336`, change:

```tsx
<div className="files-tab">
```

to:

```tsx
<div className="files-tab" data-testid="files-tab">
```

- [ ] **Step 2.2: Add `data-testid="files-tab-tree"` + `data-testid="files-tab-diff"` to the two-pane shells**

In `FilesTab.tsx:360`:

```tsx
<div className="files-tab-tree" data-testid="files-tab-tree">
```

In `FilesTab.tsx:378`:

```tsx
<div className="files-tab-diff" data-testid="files-tab-diff">
```

- [ ] **Step 2.3: Add `data-testid="iteration-tab-strip"` to IterationTabStrip root**

In `IterationTabStrip.tsx:28`:

```tsx
<div className="iteration-tab-strip" role="tablist" aria-label="Iteration selector" data-testid="iteration-tab-strip">
```

- [ ] **Step 2.4: Add `data-testid="commit-multi-select-picker"` + `data-testid="compare-picker"` to picker roots**

In `CommitMultiSelectPicker.tsx:101`:

```tsx
<div className="commit-multi-select-picker" data-testid="commit-multi-select-picker">
```

In `ComparePicker.tsx:38`:

```tsx
<div className="compare-picker" data-testid="compare-picker">
```

- [ ] **Step 2.5: Add `data-testid="file-tree"` to FileTree root + per-row `data-testid="files-tab-tree-row"` (D41 — `data-path` already exists)**

In `FileTree.tsx:43`:

```tsx
<div className="file-tree" role="tree" aria-label="File tree" data-testid="file-tree">
```

In `FileTree.tsx:135` (the `FileTreeFileNode`): production already emits `data-path={node.path}` on this row (verified at `FileTree.tsx:138`). PR4 adds only `data-testid="files-tab-tree-row"`:

```tsx
className={`file-tree-file${isSelected ? ' file-tree-file--selected' : ''}`}
data-testid="files-tab-tree-row"
data-path={node.path}  // pre-existing — verify it's already on the line
```

The combined selector `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` consumes both attributes; D41 tightens the test at Task 20 Step 20.2.

Also in the empty-state branch (`FileTree.tsx:35`):

```tsx
<div className="file-tree" data-testid="file-tree">
```

- [ ] **Step 2.6: Add `data-testid="diff-pane"` to DiffPane root (all 3 render branches)**

In `DiffPane.tsx:103` (the no-file-selected branch):

```tsx
<div className="diff-pane diff-pane--empty" data-testid="diff-pane">
```

In `DiffPane.tsx:111` (the empty-file branch):

```tsx
<div className="diff-pane" data-testid="diff-pane">
```

In `DiffPane.tsx:137` (the main branch):

```tsx
<div className={`diff-pane ${modeClass}`} data-testid="diff-pane">
```

- [ ] **Step 2.7: Add `data-testid="comment-widget"` + `data-testid="diff-truncation-banner"` + `data-testid="ai-hunk-annotation"` + `data-testid="word-diff-overlay"` + `data-testid="markdown-file-view"`**

One attribute per component root, mirroring the pattern above. Exact line numbers from Task 1 grep output.

- [ ] **Step 2.8: Add `data-testid="inline-comment-composer"` + `data-testid="reply-composer"` to the two new composer outers**

`InlineCommentComposer.tsx:222`:

```tsx
className="inline-comment-composer"
data-testid="inline-comment-composer"
```

`ReplyComposer.tsx:186`:

```tsx
className="reply-composer"
data-testid="reply-composer"
```

(`PrRootReplyComposer` already has its outer module-CSS class hooked up from PR3; no `data-testid` was added there — PR4 leaves it as-is unless Task 3 surfaces a vitest test that needs it. If so, add `data-testid="pr-root-reply-composer"` at that time.)

- [ ] **Step 2.9: Run vitest after the additive JSX changes**

```bash
cd frontend && npm run test -- --run 2>&1 | tail -20
```

Expected: same pass count as Task 1 Step 1.4. `data-testid` additions are non-breaking; existing tests still query the JSX class strings.

- [ ] **Step 2.10: Commit the `data-testid` pass**

```bash
git add frontend/src/components/PrDetail/FilesTab/ frontend/src/components/PrDetail/Composer/
git commit -m "feat(pr4): add data-testid hooks to FilesTab + DiffPane + Composer components"
```

---

## Task 3: Migrate PR4-affected vitest tests to `data-testid` selectors

**Files:** Per Task 1 Step 1.2 grep output.

For each surfaced test file, replace `.querySelector('.x')` with `screen.getByTestId('x')` (or `queryAllByTestId`/`getAllByTestId` for collections). For per-element nested queries inside a parent, use `within(parent).getByTestId(...)`. Class-presence assertions (`toHaveClass('iteration-tab--active')`) stay as-is — those classes remain in JSX and serve as the styling hook + state hook (D16 precedent: literal class as the test seam AND the styling hook is one mechanism, not two).

- [ ] **Step 3.1: Migrate the first file from Task 1 Step 1.2's list**

(Detailed migration patterns per file are surfaced during execution. The shape mirrors PR3 Task 3's per-test rewrites: container selectors → `getByTestId`, per-row selectors → `queryAllByTestId` or `within(...).getByText(...)`. Class-presence assertions stay.)

- [ ] **Step 3.2-3.N: Migrate the remaining files**

One commit per file:

```bash
git add frontend/__tests__/<file>.test.tsx
git commit -m "test(pr4): migrate <Component>.test.tsx to data-testid selectors"
```

- [ ] **Step 3.X: Run vitest**

```bash
cd frontend && npm run test -- --run 2>&1 | tail -20
```

Expected: same pass count as Task 1 Step 1.4. If lower, the migration broke an existing assertion — fix before proceeding.

---

## Task 4: Lift 7 composer-inner classes to `tokens.css` (D26 + D27 + D39)

This is the §3.1 lift-on-second-use fulfillment for all 3 composers. After Task 4, the 7 composer-inner classes are global rules; Tasks 16-18 (composer outers) are mechanical because the JSX literals (`composer-textarea`, `composer-actions`, etc.) already exist and just newly fire global rules.

**Files:**
- Modify: `frontend/src/styles/tokens.css` (append 7 rules after the existing `.ai-validator-card__*` block at line 674)
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css` (drop the local `.composerActions` rule)

- [ ] **Step 4.1: Write the failing vitest test** (smoke that the global rules are present)

The composer global classes are CSS-only — no JSX wiring to test directly. The acceptance gate is the open-composer visual on Overview at Task 24's Playwright re-run. Skip a vitest write here.

(Alternative: a CSS regression spec that asserts `getComputedStyle` matches expected token values. Too brittle for the cost; skip.)

- [ ] **Step 4.2: Append the 7 composer-inner global rules to `tokens.css`**

After the `.ai-validator-card__show-me:disabled` rule on line 673, append:

```css

/* Composer-inner primitives (spec §4.4 + D26). Shared across InlineCommentComposer,
   ReplyComposer, and PrRootReplyComposer. Lifted to tokens.css per §3.1
   lift-on-second-use rule. Sourced from screens.css L760-776 plus production
   extensions for badge state variants. */
.composer-textarea {
  width: 100%;
  min-height: 80px;
  resize: vertical;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  padding: var(--s-2);
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  color: var(--text-1);
}
.composer-textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.composer-preview-toggle {
  font-size: var(--text-sm);
  color: var(--text-2);
  background: transparent;
  border: none;
  padding: var(--s-1) var(--s-2);
  cursor: pointer;
}
.composer-preview-toggle:hover {
  color: var(--text-1);
}
.composer-badge {
  font-size: var(--text-xs);
  padding: 2px var(--s-2);
  border-radius: var(--radius-1);
  background: var(--surface-3);
  color: var(--text-2);
}
.composer-badge--saved {
  background: var(--success-soft);
  color: var(--success-fg);
}
.composer-badge--saving {
  background: var(--info-soft);
  color: var(--info-fg);
}
.composer-badge--unsaved {
  background: var(--warning-soft);
  color: var(--warning-fg);
}
.composer-badge--rejected {
  background: var(--danger-soft);
  color: var(--danger-fg);
}
.composer-discard {
  font-size: var(--text-sm);
  color: var(--danger-fg);
  background: transparent;
  border: none;
  padding: var(--s-1) var(--s-2);
  cursor: pointer;
}
.composer-discard:hover {
  text-decoration: underline;
}
/* `.composer-save` is NOT defined here — production JSX (`InlineCommentComposer.tsx:274`,
   etc.) composes `composer-save btn btn-primary btn-sm`, and the .btn / .btn-primary /
   .btn-sm globals supply the full visual treatment. An empty `.composer-save` stub
   would be a speculative future-anchor with no current consumer. */
.composer-closed-banner {
  font-size: var(--text-sm);
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border-radius: var(--radius-2);
}
.composer-actions {
  /* Sourced from screens.css L776 minus the margin-top: 8px token. The parent
     composer outer provides gap: var(--s-2) via flex-direction: column, so
     margin-top here doubles the visual gap on the open-composer state. PR3
     b4a916b documented this gotcha; PR4 closes it via the lift. (See D27.) */
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s-2);
}
```

The 4 badge variants align with production `ComposerSaveBadge = 'saved' | 'saving' | 'unsaved' | 'rejected'` (verified at `frontend/src/hooks/useComposerAutoSave.ts:5`). No dormant selectors; all four match real production states. Document under D26.

- [ ] **Step 4.3: Drop the local `.composerActions` rule from `PrRootReplyComposer.module.css`**

The file becomes (only the outer rule remains):

```css
.prRootReplyComposer {
  padding: var(--s-2);
  background: var(--surface-2);
  border-radius: var(--radius-2);
  border: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
```

- [ ] **Step 4.4: Update `PrRootReplyComposer.tsx` to use the literal global class instead of `styles.composerActions`**

Find the `<div className={styles.composerActions}>` line (PrRootReplyComposer.tsx:188):

```tsx
<div className="composer-actions">
```

`styles.composerActions` is no longer exported; the literal global class fires the lifted `tokens.css` rule.

- [ ] **Step 4.5: Run vitest**

```bash
cd frontend && npm run test -- --run 2>&1 | tail -20
```

Expected: same pass count. The lift is CSS-only + a JSX literal-class swap on one component; no test should regress.

- [ ] **Step 4.6: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx
git commit -m "feat(pr4): lift 7 composer-inner classes to tokens.css (D15 fulfillment)"
```

---

## Task 5: IterationTabStrip module CSS + chip-anatomy additive JSX (D28 + D29)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.tsx` (additive JSX: chip-num / chip-label / chip-meta inner `<span>`s per D28; iter-new-dot deferred to PR9)

Source the visual treatment from `screens.css:129-209` (the `.iter-*` block).

- [ ] **Step 5.1: Read `IterationTabStrip.tsx` to confirm available data on the iteration prop**

Production `IterationDto` (`frontend/src/api/types.ts:162-168`) carries `{ number, beforeSha, afterSha, commits: CommitDto[], hasResolvableRange }`. No `additions`/`deletions`/`isNew`/`label`/`index` fields. PR4 derives:

- `chip-num` text: `iteration.number` directly.
- `chip-label` text: keep the existing `Iter ${iter.number}` computed string the production renders today (see `IterationTabStrip.tsx:84`).
- `chip-meta` adds/rems: client-side sum across `iteration.commits[].additions` and `iteration.commits[].deletions` (CommitDto exposes these per `types.ts:158-159`). Inline the sum at render time — no new helper unless the same sum lands in more than one place.
- `iter-new-dot`: NOT rendered. No production "this iteration is new" flag exists; synthesizing one needs new state. Logged under D28 as PR9 deferral.

This step is read-only confirmation. No code change yet.

- [ ] **Step 5.2: Write the failing vitest test for chip-meta rendering**

In `frontend/__tests__/IterationTabStrip.test.tsx` (existing — augment alongside the existing `getByText('Iter 3')`-style tests; do NOT delete them, the chip-label visible text stays so the existing assertions keep passing):

```tsx
import { render, screen } from '@testing-library/react';
import { IterationTabStrip } from '../src/components/PrDetail/FilesTab/IterationTabStrip';
import type { IterationDto, CommitDto } from '../src/api/types';

function makeCommit(additions: number, deletions: number): CommitDto {
  return {
    sha: 'abc',
    shortSha: 'abc',
    message: 'msg',
    additions,
    deletions,
    authoredAt: '2026-05-30T00:00:00Z',
  };
}

test('renders chip-meta +adds/-rems summed from iteration.commits', () => {
  const iterations: IterationDto[] = [
    {
      number: 1,
      beforeSha: 'x',
      afterSha: 'y',
      commits: [makeCommit(10, 2), makeCommit(2, 1)],
      hasResolvableRange: true,
    },
    {
      number: 2,
      beforeSha: 'y',
      afterSha: 'z',
      commits: [makeCommit(5, 18)],
      hasResolvableRange: true,
    },
  ];
  // Pass remaining required props per the actual IterationTabStripProps shape;
  // verify against the IterationTabStrip.tsx export at Step 5.1.
  render(<IterationTabStrip iterations={iterations} /* + other required props */ />);
  expect(screen.getByText('+12')).toBeInTheDocument();
  expect(screen.getByText('-3')).toBeInTheDocument();
  expect(screen.getByText('+5')).toBeInTheDocument();
  expect(screen.getByText('-18')).toBeInTheDocument();
});
```

The pre-existing `getByText('Iter 3')` assertions in `IterationTabStrip.test.tsx` continue to match because the chip-label `<span>` still contains the literal text `"Iter 3"` — D28 keeps the visible label string intact. The chip-num `<span>` (`{iteration.number}`) sits BESIDE the chip-label span, not inside it, so it's not part of the `Iter 3` accessible-name token.

Run to verify failure of the new test:

```bash
cd frontend && npm run test -- --run IterationTabStrip 2>&1 | tail -10
```

Expected: FAIL on the new chip-meta assertions; existing assertions still PASS.

- [ ] **Step 5.3: Author `IterationTabStrip.module.css`**

```css
.iterationTabStrip {
  /* Composes with handoff `iter-tabs` shell layout */
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
  padding: var(--s-2) 0;
}

.iterationTab {
  /* Composes with handoff `iter-chip` visual treatment */
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
  transition: background var(--t-fast), border-color var(--t-fast);
}
.iterationTab:hover {
  background: var(--surface-3);
}
.iterationTabActive {
  background: color-mix(in oklch, var(--accent-soft) 60%, var(--surface-2));
  border-color: color-mix(in oklch, var(--accent) 40%, var(--border-1));
  color: var(--text-1);
}
.iterationTabDisabled {
  opacity: 0.55;
  pointer-events: none;
}
.iterationTabMore {
  /* Handoff iter-chip-more — dashed outline + muted color */
  border-style: dashed;
  color: var(--text-3);
}

.iterationChipNum {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5em;
  height: 1.5em;
  padding: 0 4px;
  background: var(--surface-3);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-2);
}
.iterationTabActive .iterationChipNum {
  background: var(--accent);
  color: var(--accent-text);
}

.iterationChipLabel {
  font-weight: 500;
}

.iterationChipMeta {
  display: inline-flex;
  gap: 4px;
  padding-left: var(--s-2);
  border-left: 1px solid var(--border-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.iterationTabActive .iterationChipMeta {
  border-left-color: color-mix(in oklch, var(--accent) 30%, transparent);
}
.iterationChipAdd { color: var(--success-fg); }
.iterationChipRem { color: var(--danger-fg); }

/* .iterationNewDot — dormant. No production data path for "new iteration"
   flag (IterationDto has no isNew field). Authoring a rule speculatively was
   considered and rejected per D28 — wire the flag in PR9 and add the rule
   then. */

.iterationTabOverflow {
  position: relative;
}
.iterationDropdown {
  position: absolute;
  top: calc(100% + var(--s-2));
  left: 0;
  z-index: 10;
  min-width: 240px;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-2);
  padding: var(--s-2);
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.iterationOption {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-1);
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
  text-align: left;
}
.iterationOption:hover {
  background: var(--surface-2);
}
.iterationOptionDisabled {
  opacity: 0.55;
  pointer-events: none;
}
```

- [ ] **Step 5.4: Wire the module + additive JSX into `IterationTabStrip.tsx`**

Top of file:

```tsx
import styles from './IterationTabStrip.module.css';
```

Replace each chip render block with the structured contents. Note the cascade-order pattern: literal BEM kebab classes (`iteration-tab iteration-tab--active`) stay in JSX as the test seam + future migration hook, while the hashed module classes (`styles.iterationTabActive`) supply the paint. Vite's default `localsConvention: 'camelCaseOnly'` converts CSS module class names to camelCase only (the kebab original is dropped); CSS rules are authored in camelCase from the start.

Example for the per-iteration chip (`IterationTabStrip.tsx:74`):

```tsx
<button
  type="button"
  role="tab"
  aria-selected={isActive}
  className={`iteration-tab${isActive ? ' iteration-tab--active' : ''}${disabled ? ' iteration-tab--disabled' : ''} ${styles.iterationTab}${isActive ? ` ${styles.iterationTabActive}` : ''}${disabled ? ` ${styles.iterationTabDisabled}` : ''}`}
  onClick={() => onSelect(iteration.number)}
  disabled={disabled}
>
  <span className={`iteration-chip-num ${styles.iterationChipNum}`}>{iteration.number}</span>
  <span className={`iteration-chip-label ${styles.iterationChipLabel}`}>{`Iter ${iteration.number}`}</span>
  <span className={`iteration-chip-meta ${styles.iterationChipMeta}`}>
    <span className={`iteration-chip-add ${styles.iterationChipAdd}`}>+{iteration.commits.reduce((sum, c) => sum + c.additions, 0)}</span>
    <span className={`iteration-chip-rem ${styles.iterationChipRem}`}>-{iteration.commits.reduce((sum, c) => sum + c.deletions, 0)}</span>
  </span>
  {/* iter-new-dot omitted — no production data path; PR9 deferral per D28 */}
</button>
```

Apply the same structured-contents pattern to the "All" chip (`activeRange === 'all'` case) and the `iteration-tab--more` overflow chip. For "All", the chip-num is omitted; chip-meta sums all iterations' commits' adds/rems (`iterations.flatMap(i => i.commits).reduce(...)`). For "more", chip-num is "+N" (N being the count of overflowed iterations) and chip-meta is omitted.

Apply the literal-class-and-module pattern (D16) consistently: keep the bare `iteration-tab` etc. literals AND add the `${styles.iterationTab}` hashed class. The hashed class supplies the paint; the literal is the test seam.

- [ ] **Step 5.5: Run the vitest test to verify it passes**

```bash
cd frontend && npm run test -- --run IterationTabStrip 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/IterationTabStrip.tsx frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css frontend/__tests__/IterationTabStrip.test.tsx
git commit -m "feat(pr4): port IterationTabStrip CSS + add chip-num/label/meta inner spans"
```

---

## Task 6: CommitMultiSelectPicker module CSS (D30 — production-only, no handoff source)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.tsx`

- [ ] **Step 6.1: Write the failing vitest test** (skip if no existing test queries class-based selectors; otherwise migrate per Task 3 pattern)

- [ ] **Step 6.2: Author `CommitMultiSelectPicker.module.css`**

```css
.commitMultiSelectPicker {
  position: relative;
  display: inline-block;
}
.commitPickerTrigger {
  /* Composes with .btn .btn-ghost .btn-sm globals */
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.commitPickerListbox {
  position: absolute;
  top: calc(100% + var(--s-2));
  left: 0;
  z-index: 10;
  min-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-2);
  padding: var(--s-2);
  display: flex;
  flex-direction: column;
  gap: 0;
}
.commitPickerOption {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-1);
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
  text-align: left;
}
.commitPickerOption:hover {
  background: var(--surface-2);
}
.commitPickerOptionFocused {
  background: var(--surface-2);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.commitPickerMessage {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6.3: Wire the module into `CommitMultiSelectPicker.tsx`**

Apply the literal-class-and-module pattern. Top of file:

```tsx
import styles from './CommitMultiSelectPicker.module.css';
```

Replace each `className="commit-multi-select-picker"` (and friends) with:

```tsx
className={`commit-multi-select-picker ${styles.commitMultiSelectPicker}`}
```

(And similarly for `commit-picker-trigger`, `commit-picker-listbox`, `commit-picker-option`, `commit-picker-option--focused`, `commit-picker-message`.)

- [ ] **Step 6.4: Run vitest**

```bash
cd frontend && npm run test -- --run CommitMultiSelectPicker 2>&1 | tail -10
```

- [ ] **Step 6.5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.tsx frontend/src/components/PrDetail/FilesTab/CommitMultiSelectPicker.module.css
git commit -m "feat(pr4): port CommitMultiSelectPicker CSS to module (no handoff source — D30)"
```

---

## Task 7: ComparePicker module CSS (D31 — production-only with handoff `iter-compare` reference)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx`

- [ ] **Step 7.1: Author `ComparePicker.module.css`**

```css
.comparePicker {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) 0;
}
.comparePickerLabel {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--text-xs);
  color: var(--text-3);
}
.comparePickerLabelText {
  /* Composes with handoff `iter-compare` muted label tone */
  color: var(--text-3);
}
.comparePickerSelect {
  /* Composes with surface tokens; matches the iter-chip-card aesthetic */
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: var(--s-1) var(--s-2);
  font-size: var(--text-sm);
  color: var(--text-1);
  font-family: var(--font-mono);
  min-width: 8em;
}
.comparePickerArrow {
  color: var(--text-3);
  font-size: var(--text-sm);
  padding: 0 var(--s-1);
}
.comparePickerEmpty {
  /* Composes with .muted global */
  font-size: var(--text-sm);
}
```

- [ ] **Step 7.2: Wire the module into `ComparePicker.tsx` using the literal-class-and-module pattern + mark `⇄` arrow decorative.**

The `<span className="compare-picker-arrow">⇄</span>` at `ComparePicker.tsx:57` gets `aria-hidden="true"` — the two labeled `<select>` elements already communicate the comparison direction; the arrow is decorative.

```tsx
<span className={`compare-picker-arrow ${styles.comparePickerArrow}`} aria-hidden="true">⇄</span>
```

- [ ] **Step 7.3: Run vitest + commit**

```bash
cd frontend && npm run test -- --run ComparePicker 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css
git commit -m "feat(pr4): port ComparePicker CSS to module (D31)"
```

---

## Task 8: FileTree module CSS — port handoff `.tree-*` treatments + new directory-tree styling (D32 + D33)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`

Source visual treatment from `screens.css:523-585` (the `.tree-*` block).

- [ ] **Step 8.1: Author `FileTree.module.css`**

```css
.fileTree {
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-right: 1px solid var(--border-1);
  min-width: 240px;
  max-width: 360px;
  overflow-y: auto;
}
.fileTreeHeader {
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-1);
}
.fileTreeEmpty {
  /* Composes with .muted global */
  padding: var(--s-4);
  font-size: var(--text-sm);
}
.fileTreeList {
  display: flex;
  flex-direction: column;
}

/* File rows — handoff `tree-row` treatment */
.fileTreeFile {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: 6px var(--s-3);
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
  transition: background var(--t-fast);
}
.fileTreeFile:hover {
  background: var(--surface-3);
}
.fileTreeFileSelected {
  background: color-mix(in oklch, var(--accent-soft) 40%, var(--surface-2));
  color: var(--text-1);
}

/* Viewed-state — handoff strikethrough via :has() sibling selector (D33) */
.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeFileName {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 1px;
}

/* File-status badges — handoff `tree-status-*` treatment */
.fileStatus {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5em;
  height: 1.5em;
  border-radius: var(--radius-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
}
/* FileChangeStatus union per frontend/src/api/types.ts:209 — 4 values only.
   No `removed`, no `copied`. */
.fileStatusAdded { background: var(--success-soft); color: var(--success-fg); }
.fileStatusModified { background: var(--warning-soft); color: var(--warning-fg); }
.fileStatusDeleted { background: var(--danger-soft); color: var(--danger-fg); }
.fileStatusRenamed { background: var(--info-soft); color: var(--info-fg); }

/* Dormant per D32a — production JSX has no AI-focus-dot wiring today.
   Rule is ready for PR9 to enable via a small JSX conditional render. */
.fileTreeAi {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}

.fileTreeFileName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fileTreeSpacer {
  flex: 1;
}
.fileTreeViewedCheckbox {
  flex: none;
  width: 14px;
  height: 14px;
  cursor: pointer;
}
.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeViewedCheckbox {
  /* Match handoff `tree-row.is-viewed .tree-viewed` filled-accent treatment */
  accent-color: var(--accent);
}

/* Directory rows — production-only structure; no handoff source */
.fileTreeDir {
  display: flex;
  flex-direction: column;
}
.fileTreeDirHeader {
  display: flex;
  align-items: center;
  padding: 6px var(--s-3);
}
.fileTreeDirToggle {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  background: transparent;
  border: none;
  padding: 0;
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
}
.fileTreeChevron {
  display: inline-block;
  width: 1em;
  text-align: center;
  color: var(--text-3);
  transition: transform var(--t-fast);
}
.fileTreeChevronOpen {
  transform: rotate(90deg);
}
.fileTreeDirName {
  font-weight: 500;
}
```

- [ ] **Step 8.2: Wire the module into `FileTree.tsx`**

Apply the literal-class-and-module pattern across all rendered classes. Pay special attention to `file-tree-file--selected` (template literal in the JSX); the same template literal pattern carries through with the module class appended.

Also confirm Task 2 Step 2.5's `data-testid="files-tab-tree-row"` + `data-path={node.file.path}` are present on each `FileTreeFileNode` — D41 selector tightening at Task 20 depends on them.

- [ ] **Step 8.3: Run vitest + commit**

```bash
cd frontend && npm run test -- --run FileTree 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css
git commit -m "feat(pr4): port FileTree CSS (handoff tree-* + production directory shape — D32/D33)"
```

---

## Task 9: FilesTab outer shell module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`

The outer shell carries the toolbar surface + two-pane content area + tree pane + diff pane containers + skeleton/error placeholders. No direct handoff source for the production shell — derive treatment from the diff-area + tree pane layout in `screens.css:591-600`.

- [ ] **Step 9.1: Author `FilesTab.module.css`**

```css
.filesTab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.filesTabToolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-1);
  flex-wrap: wrap;
}
.filesTabError {
  /* Composes with .banner global; error tint applied by container or banner-warning */
  padding: var(--s-3) var(--s-4);
  color: var(--danger-fg);
  background: var(--danger-soft);
}
.filesTabContent {
  display: grid;
  grid-template-columns: minmax(240px, 320px) 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.filesTabTree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--surface-1);
  border-right: 1px solid var(--border-1);
}
.filesTabDiff {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-1);
}

/* Skeleton placeholder rows for the file-tree-loading state */
.fileTreeSkeleton {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
}
.skeletonRow {
  height: 1.5em;
  background: var(--surface-2);
  border-radius: var(--radius-1);
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.85; }
}
```

- [ ] **Step 9.2: Wire the module into `FilesTab.tsx`** with the literal-class-and-module pattern.

- [ ] **Step 9.3: Run vitest + commit**

```bash
cd frontend && npm run test -- --run FilesTab 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.module.css
git commit -m "feat(pr4): port FilesTab outer shell CSS to module (no handoff source — derived)"
```

---

## Task 9.5: Split checkpoint (D42 — re-evaluate single-PR4 vs PR4a/PR4b)

Per spec §4.4 line 255 and §6.6, the implementer measures the diff at this point and decides whether to ship PR4 as PR4a (Tasks 1-9 left half) and start PR4b (Tasks 10-19 right half) in a separate worktree, or continue with single-PR4.

- [ ] **Step 9.5.1: Measure the CSS-LOC count of Tasks 1-9 committed so far**

```bash
git diff --stat main...HEAD -- 'frontend/src/**/*.module.css' frontend/src/styles/tokens.css
```

Record the additions count. If >~600 LOC of new CSS, that's a split-tripper.

- [ ] **Step 9.5.2: Measure review-meaningful changes**

Count the components touched (each new module CSS + each modified JSX with structural additive change). >~8 distinct components is the second split-tripper.

- [ ] **Step 9.5.3: Decide**

| Both thresholds crossed | At least one crossed | Neither crossed |
|---|---|---|
| **Split PR4a / PR4b.** Run Tasks 20a (PR4a-scoped baseline cap + selector tighten), 22a (deferrals append for PR4a), 23a (pre-push checklist), open PR4a; defer Tasks 10-19 + 20b/22b/23b to PR4b plan in a separate worktree + branch. | **Implementer judgment.** Default to continue single-PR4 unless the implementer judges the next 10 tasks will materially compound the review weight. Document the judgment call in the next commit message. | **Continue single-PR4** with Tasks 10-19. |

If splitting, draft `docs/plans/2026-05-30-design-parity-recovery-pr4b-diff-pane.md` cloning the relevant Task 10-19 sections of this plan and commit it before opening PR4a. If continuing, proceed directly to Task 10.

(No commit from Task 9.5 in the continue-single branch; this is a decision step.)

---

## Task 10: DiffPane module CSS (D34 + D35 + D36)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`

Source visual treatment from `screens.css:591-679` (`.diff-area`, `.diff-toolbar`, `.diff-body`, `.diff-headers`, `.diff-hunk`, `.diff-line`, `.diff-line-sbs`) but apply to production's `<table>`-based DOM (D34).

- [ ] **Step 10.1: Thread `isLoading` prop through `DiffPaneProps` (D36)**

Production `DiffPaneProps` (`DiffPane.tsx:12-33`) does NOT carry `isLoading`. PR4 adds it as an optional `isLoading?: boolean` prop and threads from `FilesTab.tsx` (the parent owns the diff-fetch state — `diff.isLoading` on the `useFileDiff` hook). Verify the exact `FilesTab.tsx` mount line (around `:378-385`) before editing.

```tsx
// In DiffPane.tsx — extend the props interface
export interface DiffPaneProps {
  // ...existing fields
  isLoading?: boolean;
}

// In FilesTab.tsx — pass on the existing <DiffPane> mount
<DiffPane
  // ...existing props
  isLoading={diff.isLoading}
/>
```

The Loading… overlay is then rendered as a JSX `<span>` inside the diff-pane header (see Step 10.3). The CSS-only `::after { content: "Loading…" }` approach is **rejected** because CSS-generated content is not announced by screen readers (WCAG 2.1 F87 failure). JSX rendering puts the text in the accessibility tree.

- [ ] **Step 10.2: Author `DiffPane.module.css`**

```css
.diffPane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--surface-1);
  overflow: hidden;
}
.diffPaneEmpty {
  /* D35 — no-file-selected state */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--s-5);
  min-height: 200px;
}
.diffPaneHeader {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 6px var(--s-4);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-1);
  font-size: var(--text-xs);
  color: var(--text-1);
}
.diffPaneLoading {
  /* D36 — JSX `<span className={`diff-pane-loading muted ${styles.diffPaneLoading}`}>Loading…</span>`
     conditionally rendered when isLoading is true. CSS-generated content via
     ::after was rejected for WCAG 2.1 F87 (CSS content not announced). */
  margin-left: auto;
  font-size: var(--text-xs);
}
.diffPanePath {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-1);
}
.diffPaneBody {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* Diff table — handoff `.diff-body` / `.diff-line` treatment on production <table> scaffold */
.diffTable {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.55;
}
.diffHunkHeader {
  display: block;
  padding: 4px var(--s-4);
  background: var(--surface-2);
  color: var(--accent);
  font-size: var(--text-xs);
}
.diffGutter {
  padding: 0 var(--s-2);
  text-align: right;
  color: var(--text-3);
  user-select: none;
  width: 1%;
  white-space: nowrap;
  min-width: 3em;
}
.diffGutterOld {
  border-right: 1px solid var(--border-1);
}
.diffGutterNew {
  position: relative;
}
.diffContent {
  padding: 0 var(--s-2);
  white-space: pre;
  overflow: visible;
}

/* Add/Remove row tinting lives in tokens.css as GLOBAL rules on the literal
   class strings production already emits (`diff-line diff-line--insert` /
   `diff-line diff-line--delete`, see DiffPane.tsx:193). See Task 10 Step 10.2
   "Append to tokens.css" below for the lifted rules. The module CSS scopes only
   the diff-pane-specific surfaces (header, gutter, content, hunk-header, etc.)
   that don't share styling with other components. */

/* Comment-affordance gutter button */
.diffCommentAffordance {
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  border-radius: 3px;
  font-size: 10px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--t-fast);
}
.diffPane tr:hover .diffCommentAffordance,
.diffCommentAffordance:focus-visible {
  opacity: 1;
}

/* Embedded comment + composer rows live as colspan-3 <tr>s */
.diffCommentRow {
  background: var(--surface-2);
}
.diffComposerRow {
  background: var(--surface-2);
}
```

Diff-line add/remove tinting is NOT in this module file — it lives as global rules on the literal `diff-line diff-line--insert/--delete` BEM classes that production already emits at `DiffPane.tsx:193`. See Step 10.4 below for the `tokens.css` lift.

- [ ] **Step 10.3: Wire the module into `DiffPane.tsx`** with the literal-class-and-module pattern. Render the JSX Loading… span conditional on `isLoading` inside the diff-pane header:

```tsx
<div className={`diff-pane-header ${styles.diffPaneHeader}`}>
  <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
  {isLoading && (
    <span className={`diff-pane-loading muted ${styles.diffPaneLoading}`}>Loading…</span>
  )}
</div>
```

- [ ] **Step 10.4: Append diff-line tint globals to `tokens.css`**

After the composer-inner globals appended in Task 4 Step 4.2, append the diff-line tints. These match production's literal `diff-line diff-line--{insert,delete,context,hunk-header}` class strings (verified at `DiffPane.tsx:193`):

```css

/* Diff-line tints (spec §4.4, D34). Lifted from the per-row literal class
   strings DiffPane emits — `.diff-line diff-line--insert` / `--delete` /
   `--context` / `--hunk-header`. Global because the literal is what JSX emits
   and no scoping is gained by hashing. Sourced from screens.css L637-678
   (`.diff-line.diff-add` / `.diff-line.diff-rem` equivalents). */
.diff-line {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.diff-line--insert {
  background: var(--diff-add-bg);
}
.diff-line--delete {
  background: var(--diff-rem-bg);
}
.diff-line--hunk-header {
  background: var(--surface-2);
  color: var(--accent);
  font-size: var(--text-xs);
}
```

- [ ] **Step 10.5: Run vitest + commit**

```bash
cd frontend && npm run test -- --run DiffPane 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/styles/tokens.css
git commit -m "feat(pr4): port DiffPane CSS incl. empty-state + Loading overlay (D34/D35/D36)"
```

---

## Task 11: DiffTruncationBanner module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx`

The component composes with the global `.banner banner-warning` (per S6 D8 → tokens.css). Module supplies only the diff-pane-specific positioning.

- [ ] **Step 11.1: Author `DiffTruncationBanner.module.css`**

```css
.diffTruncationBanner {
  /* Composes with .banner .banner-warning globals; module supplies positioning */
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0;
}
```

- [ ] **Step 11.2: Wire + commit**

```tsx
import styles from './DiffTruncationBanner.module.css';

<div className={`diff-truncation-banner banner banner-warning ${styles.diffTruncationBanner}`} role="status" data-testid="diff-truncation-banner">
```

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.module.css
git commit -m "feat(pr4): port DiffTruncationBanner CSS to module (composes with .banner-warning)"
```

---

## Task 12: AiHunkAnnotation module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx`

Source visual treatment from `screens.css:824-837` (`.ai-hunk`, `.ai-hunk-meta`, `.ai-hunk-actions`).

- [ ] **Step 12.1: Author `AiHunkAnnotation.module.css`**

```css
.aiHunk {
  /* Composes with .ai-tint global for surface tint */
  margin: var(--s-2) var(--s-4);
  padding: var(--s-3);
  border-radius: var(--radius-3);
  font-size: var(--text-sm);
  color: var(--text-1);
}
.aiHunkMeta {
  display: flex;
  gap: var(--s-2);
  align-items: center;
  margin-bottom: 4px;
  font-weight: 600;
  color: var(--accent);
}
.aiHunkActions {
  margin-top: 6px;
  display: flex;
  gap: var(--s-1);
}
```

- [ ] **Step 12.2: Wire + commit**

```bash
cd frontend && npm run test -- --run AiHunkAnnotation 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css
git commit -m "feat(pr4): port AiHunkAnnotation CSS to module"
```

---

## Task 13: ExistingCommentWidget module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx`

Source visual treatment from `screens.css:728-732` (`.comment-meta`, `.comment-author`, `.comment-time`, `.comment-body`). Production also renders `comment-widget`, `comment-thread`, `comment-thread--resolved`, `comment-entry`, `comment-thread-actions`, `comment-thread-reply` — production-only shells around the handoff treatments.

- [ ] **Step 13.1: Author `ExistingCommentWidget.module.css`**

```css
.commentWidget {
  padding: var(--s-3) var(--s-4);
  background: var(--surface-2);
}
.commentThread {
  /* Handoff `.thread-widget` border-left accent rail (screens.css L708-715) */
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-2);
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-3);
  overflow: hidden;
}
.commentThreadResolved {
  opacity: 0.7;
  border-style: dashed;
}
.commentEntry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: var(--s-2);
}
.commentEntry + .commentEntry {
  border-top: 1px solid var(--border-1);
  padding-top: var(--s-2);
}
.commentMeta {
  display: flex;
  gap: var(--s-2);
  align-items: baseline;
  font-size: var(--text-xs);
}
.commentAuthor {
  font-weight: 600;
  color: var(--text-1);
}
.commentTime {
  color: var(--text-3);
}
.commentBody {
  font-size: var(--text-sm);
  color: var(--text-1);
  margin-top: 2px;
  line-height: 1.55;
}
.commentThreadActions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}
.commentThreadReply {
  /* Composes with .btn .btn-ghost .btn-sm globals */
}
```

- [ ] **Step 13.2: Wire + commit**

```bash
cd frontend && npm run test -- --run ExistingCommentWidget 2>&1 | tail -10
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css
git commit -m "feat(pr4): port ExistingCommentWidget CSS to module (handoff comment-* + production thread shell)"
```

---

## Task 14: WordDiffOverlay module CSS (D37 — production-only)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx`

- [ ] **Step 14.1: Author `WordDiffOverlay.module.css`**

```css
.wordDiffOverlay {
  display: inline;
}
.wordDiffInsert {
  background: var(--diff-add-bg);
  color: var(--success-fg);
  padding: 1px 2px;
  border-radius: 2px;
}
.wordDiffDelete {
  background: var(--diff-rem-bg);
  color: var(--danger-fg);
  text-decoration: line-through;
  padding: 1px 2px;
  border-radius: 2px;
}
```

- [ ] **Step 14.2: Wire + commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.module.css
git commit -m "feat(pr4): port WordDiffOverlay CSS (production-only — D37)"
```

---

## Task 15: MarkdownFileView module CSS (D38 — production-only)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx`

- [ ] **Step 15.1: Author `MarkdownFileView.module.css`**

```css
.markdownFileView {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  background: var(--surface-1);
}
.markdownFileViewToolbar {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.toggleBtn {
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: var(--s-1) var(--s-3);
  font-size: var(--text-sm);
  color: var(--text-2);
  cursor: pointer;
}
.toggleBtnActive {
  background: var(--surface-3);
  color: var(--text-1);
  border-color: var(--border-strong);
}
.markdownFileViewContent {
  display: flex;
  flex-direction: column;
}
.markdownRaw {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  white-space: pre;
  overflow-x: auto;
  padding: var(--s-3);
  background: var(--surface-2);
  border-radius: var(--radius-2);
}
```

- [ ] **Step 15.2: Wire + commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.module.css
git commit -m "feat(pr4): port MarkdownFileView CSS (production-only — D38)"
```

---

## Task 16: InlineCommentComposer outer module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.module.css`
- Modify: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx`

The 7 inner classes are already global rules in `tokens.css` after Task 4. PR4 authors only the outer shell.

- [ ] **Step 16.1: Author `InlineCommentComposer.module.css`**

```css
.inlineCommentComposer {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  margin: var(--s-2) 0;
}
```

- [ ] **Step 16.2: Wire + commit**

```tsx
import styles from './InlineCommentComposer.module.css';

className={`inline-comment-composer ${styles.inlineCommentComposer}`}
```

```bash
cd frontend && npm run test -- --run InlineCommentComposer 2>&1 | tail -10
git add frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx frontend/src/components/PrDetail/Composer/InlineCommentComposer.module.css
git commit -m "feat(pr4): port InlineCommentComposer outer CSS to module (inner classes from Task 4 lift)"
```

---

## Task 17: ReplyComposer outer module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/ReplyComposer.module.css`
- Modify: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx`

Same pattern as InlineCommentComposer, slightly different outer surface (mounted inside `ExistingCommentWidget`, so surface tint may differ).

- [ ] **Step 17.1: Author `ReplyComposer.module.css`**

```css
.replyComposer {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--surface-1);
  border-top: 1px solid var(--border-1);
  margin-top: var(--s-2);
}
```

- [ ] **Step 17.2: Wire + commit**

```bash
cd frontend && npm run test -- --run ReplyComposer 2>&1 | tail -10
git add frontend/src/components/PrDetail/Composer/ReplyComposer.tsx frontend/src/components/PrDetail/Composer/ReplyComposer.module.css
git commit -m "feat(pr4): port ReplyComposer outer CSS to module"
```

---

## Task 18: PrRootReplyComposer module CSS — already correct after Task 4

PR3 authored the outer rule and a local `.composerActions`. Task 4 dropped the local `.composerActions` and lifted the global. No further changes required at Task 18; this task is a no-op verification.

- [ ] **Step 18.1: Verify `PrRootReplyComposer.module.css` is one rule only (outer)**

```bash
cat frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css
```

Expected output: only the `.prRootReplyComposer` outer rule. No `.composerActions`.

If the local rule is still present, Task 4 Step 4.3 was missed — return to Task 4.

(No commit from Task 18.)

---

## Task 19: ComposerMarkdownPreview module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.module.css`
- Modify: `frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.tsx`

Source visual treatment from `screens.css:768-774` (`.composer-preview`).

- [ ] **Step 19.1: Author `ComposerMarkdownPreview.module.css`**

```css
.composerMarkdownPreview {
  min-height: 80px;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  font-size: var(--text-sm);
  color: var(--text-1);
  overflow-y: auto;
}
```

- [ ] **Step 19.2: Wire + commit**

```bash
git add frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.tsx frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.module.css
git commit -m "feat(pr4): port ComposerMarkdownPreview CSS to module"
```

---

## Task 20: Un-fixme + capture `pr-detail-files-tree.png` baseline + D4 selector tighten (D41)

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png`

- [ ] **Step 20.1: Remove `.fixme` on `pr-detail-files-tree` test**

In `parity-baselines.spec.ts:146`, change `test.fixme('pr-detail-files-tree', ...)` to `test('pr-detail-files-tree', ...)`.

- [ ] **Step 20.2: Tighten the `pr-detail-files-diff` Calc.cs selector (D41)**

In `parity-baselines.spec.ts:162`, change:

```ts
await page.locator('[data-testid="files-tab-tree"]').getByText('Calc.cs').click();
```

to:

```ts
await page
  .locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]')
  .click();
```

(Task 2 Step 2.5 + Task 8 Step 8.2 added the `data-testid` + `data-path` to each FileTree row.)

- [ ] **Step 20.3: Capture the `pr-detail-files-tree.png` baseline**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-files-tree" --update-snapshots
```

Verify the captured `__screenshots__/win32/pr-detail-files-tree.png` is a coherent file-tree zone (tree header + file rows with status badges + viewed checkboxes). If the screenshot is empty / unstyled, **stop and report** — a CSS rule was missed.

Inspect the diff:

```bash
git diff frontend/e2e/parity-baselines.spec.ts
ls -la frontend/e2e/__screenshots__/win32/
```

- [ ] **Step 20.4: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png
git commit -m "test(pr4): un-fixme + capture pr-detail-files-tree baseline + tighten D4 selector (D41)"
```

---

## Task 21: Un-fixme + capture `pr-detail-files-diff.png` baseline

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png`

- [ ] **Step 21.1: Remove `.fixme` on `pr-detail-files-diff` test**

In `parity-baselines.spec.ts:156`, change `test.fixme('pr-detail-files-diff', ...)` to `test('pr-detail-files-diff', ...)`.

- [ ] **Step 21.2: Capture baseline**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-files-diff" --update-snapshots
```

Verify the captured `__screenshots__/win32/pr-detail-files-diff.png` is a coherent diff-pane zone (filepath header + add/rem-tinted code lines + gutter line numbers). If empty / unstyled, **stop and report**.

- [ ] **Step 21.3: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png
git commit -m "test(pr4): un-fixme + capture pr-detail-files-diff baseline"
```

---

## Task 22: Side-by-side parity comparison against handoff prototype (PR4 scope)

Open the handoff prototype + the PRism dev server. Compare side-by-side on the file tree zone and diff pane zone. Flag any visual deltas to the deferrals sidecar at Task 23 with the originating handoff source line + the production deviation.

- [ ] **Step 22.1: Start the handoff prototype server** (typically `python -m http.server` in `design/handoff/`)

- [ ] **Step 22.2: Start the PRism dev backend + frontend on the handoff fixture**

PowerShell:

```powershell
$env:PRISM_E2E_FAKE_REVIEW = '1'
dotnet run --project PRism.Web
```

In a separate terminal:

```bash
cd frontend && npm run dev
```

Then POST `/test/load-handoff-parity-fixture` to load the fixture, and navigate to `/pr/handoff-parity/sample/1842` in a browser.

- [ ] **Step 22.3: Compare file tree zone**

Side-by-side: handoff prototype vs PRism dev. Note any deltas:
- File-status badge color tints
- Viewed-state strikethrough on basename
- Row selection accent treatment
- Counts column font / color
- AI focus dot (if `aiPreview` is on)
- Directory expand/collapse chevron

For each delta, decide: (a) ports cleanly with a one-line CSS adjustment — apply now in a follow-up commit before opening PR; (b) intentional production divergence — log to deferrals D25 at Task 23; (c) deferred to PR9 visual-coherence pass.

- [ ] **Step 22.4: Compare diff pane zone**

Same exercise for the diff-pane / hunk-header / diff-line / comment-thread / composer surfaces.

(No commit from Task 22 itself — any follow-up CSS adjustments commit in Task 22 as feat(pr4) follow-ups.)

**Out-of-scope note on PR3 D24:** the side-by-side review may surface an opinion on whether the AiSummaryCard hero-shape adjudication from PR3 D24 should flip. PR4 does NOT modify `AiSummaryCard.module.css` — that's a PR3 file and the D24 verdict was deferred to PR9 (the audit pass). If side-by-side review surfaces a confident verdict, log it as a one-line update to D24 in the deferrals sidecar with the implementer's name + reasoning so PR9 has fresh signal. Do not edit the AiSummaryCard rule in this PR.

---

## Task 23: Append D25-D42 entries to deferrals sidecar

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

Author one entry per D-number from this plan's deviation table, using the same shape PR3 D12-D24 used:

```markdown
### D25 — Production-vs-handoff naming divergence is total in PR4

**Date:** 2026-05-30 (PR4 plan-writing pre-flight).

**Spec position:** §3.1 + §4.4 imply 1:1 kebab→camelCase mapping for module CSS class names. PR4 extends D12 (PR3) — naming divergence is the norm, not the exception, for PR Detail components below the Overview level.

**Reality:** 5 of the 13 PR4 components have ZERO direct handoff naming overlap (`FilesTab` outer shell, `CommitMultiSelectPicker`, `ComparePicker`, `MarkdownFileView`, `WordDiffOverlay`); 3 of those (`CommitMultiSelectPicker`, `MarkdownFileView`, `WordDiffOverlay`) have no handoff equivalent at all. The remaining 8 use production names like `iteration-tab*` / `file-tree*` / `diff-pane*` against handoff `iter-chip*` / `tree-*` / `diff-area*`.

**Plan resolution:** Module CSS authored under production class names. Where a handoff visual treatment exists, port it; where it doesn't, derive treatment from surrounding visual language and flag for PR9 visual-coherence review.

**Status:** Applied in PR4.

### D26 — 6 composer-inner classes lifted to `tokens.css` (PR3 D15 fulfillment); badge variants aligned with production union

**Date:** 2026-05-30 (PR4 Task 4).
**Spec position:** §3.1 lift-on-second-use rule; §4.4 lists all 3 composers; D15 (PR3) explicitly deferred the lift to PR4.
**Reality:** Three composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`) all consume the same 6 inner classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge` + `composer-badge--{saved,saving,unsaved,rejected}` modifiers, `composer-discard`, `composer-closed-banner`, `composer-actions`). The badge state union is `'saved' | 'saving' | 'unsaved' | 'rejected'` (verified at `frontend/src/hooks/useComposerAutoSave.ts:5`). Lift-on-third-use unambiguously qualifies for `tokens.css`. `.composer-save` is NOT lifted — the `.btn .btn-primary .btn-sm` globals supply the full visual treatment in production JSX; an empty stub would be speculative.
**Plan resolution:** Append 6 global rules to `tokens.css` at Task 4 Step 4.2. PrRootReplyComposer's local `.composerActions` rule (PR3) is dropped and replaced by the global `.composer-actions` consumed via literal class.
**Status:** Applied in PR4.
**Cross-refs:** PR3 D15.

### D27 — `.composer-actions` `margin-top` dropped at lift

**Date:** 2026-05-30 (PR4 Task 4 Step 4.2).
**Spec position:** Handoff source `screens.css:776` includes `margin-top: 8px`.
**Reality:** PR3's `b4a916b` annotation: the parent composer-outer already provides `gap: var(--s-2)` via `flex-direction: column`, so the inner `margin-top` doubles the visual gap on the open-composer state. PR3 captured the closed-state baseline (per D21) and deferred the open-state defect to PR4.
**Plan resolution:** Lift `.composer-actions` to `tokens.css` with `display: flex; justify-content: space-between; align-items: center; gap: var(--s-2);` only — drop `margin-top` entirely.
**Status:** Applied in PR4.
**Cross-refs:** PR3 b4a916b annotation; PR3 D15; PR3 D21.

### D28 — IterationTabStrip chip-num + chip-meta inner spans only; iter-new-dot DEFERRED (no production data source)

**Date:** 2026-05-30 (PR4 Task 5).
**Spec position:** §4.4 line 249 — "iteration tab strip (chip cards with +/− counts, new-iteration dot)". §2.2 permits "small JSX restructuring".
**Reality:** Production `IterationDto` (`frontend/src/api/types.ts:162-168`) carries `{ number, beforeSha, afterSha, commits: CommitDto[], hasResolvableRange }` — there are NO `additions`/`deletions`/`isNew`/`label`/`index` fields. The chip-num + chip-label + chip-meta DOM is constructable from existing data; iter-new-dot is not.
**Plan resolution:** Ship 3 of the 4 inner spans: (a) chip-num renders `{iteration.number}`; (b) chip-label preserves the existing visible "Iter N" computed text so pre-existing `getByText('Iter 3')` tests still match; (c) chip-meta with `+adds`/`-rems` computed inline as `iteration.commits.reduce((s, c) => s + c.additions, 0)`. iter-new-dot is NOT rendered; the omission is documented for PR9 to wire via a state hook if needed.
**Status:** Applied in PR4 (chip-num + chip-meta); iter-new-dot deferred to PR9.
**Cross-refs:** Spec §4.4; §2.2 small-JSX-restructuring carve-out.

### D29 — IterationTabStrip overflow chip + dropdown styled production-only

**Date:** 2026-05-30 (PR4 Task 5).
**Spec position:** Handoff renders overflow inline; production renders a listbox dropdown.
**Reality:** No direct handoff source for `.iteration-dropdown` + `.iteration-option` structure (~30 lines of structured JSX in `IterationTabStrip.tsx:39-64`).
**Plan resolution:** Author dropdown rules from scratch using surface tokens + box-shadow + max-height. `iteration-tab--more` ports handoff `iter-chip-more` (dashed border + muted color).
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D30 — CommitMultiSelectPicker — no handoff source

**Date:** 2026-05-30 (PR4 Task 6).
**Spec position:** §4.4 lists the component; handoff prototype has no equivalent (the picker is a S3-era production-only affordance for the low-quality clustering path).
**Reality:** Production-only conventions; no design source.
**Plan resolution:** Style for keyboard-affordance clarity (visible focused state) and consistency with the iteration strip surface tokens.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D31 — ComparePicker — production-only interaction shape; component is currently dead code (no production import)

**Date:** 2026-05-30 (PR4 Task 7).
**Spec position:** Handoff `iter-compare` is one chip that opens a comparison flyout; production renders two side-by-side `<select>`s with an arrow between.
**Reality:** S3-era decision to use native `<select>` controls instead of a flyout — different interaction model than the handoff prototype. ADDITIONALLY: grep for `import.*ComparePicker` and `<ComparePicker` across `frontend/src/` returns zero matches (verified 2026-05-30). The component file + its vitest test exist, but nothing mounts it in the running app — `FilesTab.tsx` renders only `IterationTabStrip` or `CommitMultiSelectPicker` depending on the clustering path. PR4's CSS work for ComparePicker is forward-compat only; the parity-baseline `pr-detail-files-tree` zone does NOT capture ComparePicker because it doesn't render.
**Plan resolution:** Style derived from surrounding chip-card surface tokens (`var(--surface-2)` background + `var(--border-1)` border). Arrow uses `var(--text-3)`. Arrow `⇄` carries `aria-hidden="true"` since the two labeled selects already communicate direction. Ship the CSS even though the component is dormant — keeping styling current avoids a later re-port pass when ComparePicker mounts.
**Status:** Applied in PR4 (CSS shipped; mount path is a separate slice's concern). Flagged for PR9 visual-coherence review on whether the styled-but-dormant component should be removed or wired.

### D32 — FileTree — port handoff `tree-*` under production `file-tree*` names; file-status enum is `'added' | 'modified' | 'deleted' | 'renamed'`

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** Production family is wider than handoff (directory grouping + dir chevron + dir toggle have no handoff equivalent — production added directory grouping as a usability win).
**Reality:** Mapping: `tree-row` → `.fileTreeFile`; `tree-row.is-selected` → `.fileTreeFileSelected`; `tree-status-success/warning/danger/info` → `.fileStatusAdded` / `.fileStatusModified` / `.fileStatusDeleted` / `.fileStatusRenamed` (verified against `FileChangeStatus` union at `frontend/src/api/types.ts:209` — 4 values, no `removed`, no `copied`); `tree-name` → `.fileTreeFileName`; `tree-counts` + `tree-add` + `tree-rem` → small module rules with `.tnum`.
**Plan resolution:** Module CSS authored under production class names; handoff visual treatment ported.
**Status:** Applied in PR4.

### D32a — `.fileTreeAi` ships as a dormant rule; JSX wiring deferred to PR9

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** §4.4 line 249 names "AI focus dot when `aiPreview` is on" as a restored visual; production has no data path for it today.
**Reality:** `FileTree.tsx` has no `aiPreview` consumption, no `aiFocus`-shaped prop on `FileChange`, no `<span class="file-tree-ai">` render. Adding the JSX wiring requires both a new state hook AND a data extension on `FileChange` — out of §2.2 scope for a CSS-only slice.
**Plan resolution:** `.fileTreeAi` rule (`6px × 6px` accent dot) lands in `FileTree.module.css` as a dormant module rule. PR9 can wire the JSX conditional render alongside other AI-surface decisions.
**Status:** Dormant rule applied in PR4; wiring deferred to PR9.
**Cross-refs:** PR3 D17 dormant-CSS precedent; §6.2 dormant-CSS policy.

### D33 — FileTree viewed-state is on the checkbox; CSS `:has()` selector bridges it

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** Handoff strikes through the file basename via `.tree-row.is-viewed .tree-name .tree-base`.
**Reality:** Production has no `is-viewed` row modifier — the viewed-state is on the `<input type="checkbox">` (`.file-tree-viewed-checkbox`) directly.
**Plan resolution:** Bridge via the CSS `:has()` selector (`.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeFileName { ... }`). Baseline 2023; supported in all current Chromium, Safari, Firefox. PRism's targeted browsers (per `package.json` browserslist or default Vite) include these. Fallback if a future browser context lacks `:has()`: wire `aria-checked` on the row and a sibling state class via small JSX touch.
**Status:** Applied in PR4. Documented for future-coverage audit.

### D34 — DiffPane diff-line tinting uses production literal BEM classes lifted to `tokens.css`

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 names DiffPane as scope.
**Reality:** Production `DiffPane.tsx:193` emits `rowClass = \`diff-line diff-line--${line.type}\`` where `line.type` is `'context' | 'insert' | 'delete' | 'hunk-header'`. The literal classes are bare strings with no rules today — exactly the §3.1 lift-on-second-use case (every diff row IS a consumer). The handoff prototype uses different rule names but the visual treatments map cleanly.
**Plan resolution:** Lift 4 global rules to `tokens.css` at Task 10 Step 10.4: `.diff-line` (font-mono base), `.diff-line--insert` (add tint), `.diff-line--delete` (rem tint), `.diff-line--hunk-header` (header surface). DiffPane.module.css supplies the gutter, content, comment-row, composer-row, header surfaces that are diff-pane-specific. Side-by-side diff (`.diff-line-sbs`) is NOT ported in PR4 — production is unified-only today.
**Status:** Applied in PR4. The CSS-only-data-attribute approach considered in the original plan draft (`tr[data-kind='add']`) was rejected because production already emits the literal BEM class strings; adding `data-kind` would have been a JSX touch with no payoff.

### D35 — `.diff-pane--empty` no-file-selected rule is new production-only design

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 line 251 explicitly calls this out ("the handoff has no `.diff-pane-empty` rule, and this surface is unavoidable in production").
**Reality:** The handoff prototype always pre-selects a file. Production must handle the no-file-selected state.
**Plan resolution:** `.diffPaneEmpty` rule = centered muted text + min-height. Visual derivation matches `DraftListEmpty` and `compare-picker-empty` precedents.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D36 — Loading… overlay is JSX-driven `<span>`; `isLoading` prop threaded through `DiffPaneProps`

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 line 253 describes a `var(--text-3)` Loading… overlay in the diff toolbar area during in-flight diff fetches.
**Reality:** `DiffPane.tsx:12-33` `DiffPaneProps` does NOT carry `isLoading` (the prop lives on `FileTree`, not `DiffPane`). PR4 adds `isLoading?: boolean` to `DiffPaneProps` and threads `isLoading={diff.isLoading}` on the `<DiffPane>` mount in `FilesTab.tsx`.
**Plan resolution:** JSX `<span className="diff-pane-loading muted">Loading…</span>` rendered conditionally inside the diff-pane header when `isLoading` is true. The CSS-only `::after { content: "Loading…" }` approach was rejected per WCAG 2.1 F87 — CSS-generated content is not in the accessibility tree. JSX rendering puts the text in the a11y tree where screen readers can find it.
**Status:** Applied in PR4.

### D37 — WordDiffOverlay — production-only; no handoff source

**Date:** 2026-05-30 (PR4 Task 14).
**Spec position:** §4.4 lists the component; handoff has no word-level overlay (production was authored to surface finer-grained diff for visual scanning — a S3-era win).
**Reality:** No direct source; treatment matches surrounding diff-add/diff-rem color tokens.
**Plan resolution:** `.wordDiffInsert` = `var(--diff-add-bg)` + `var(--success-fg)`; `.wordDiffDelete` = `var(--diff-rem-bg)` + `var(--danger-fg)` + line-through.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D38 — MarkdownFileView — production-only; no handoff source

**Date:** 2026-05-30 (PR4 Task 15).
**Spec position:** §4.4 lists the component; handoff has no equivalent (production-only affordance for `.md`/`.markdown` file paths).
**Reality:** No direct source; treatment matches surrounding diff-pane surface tokens.
**Plan resolution:** `.markdownFileView` = padded surface-1 container; toolbar with toggle buttons (`.toggleBtn` + `.toggleBtnActive` matching `.iterationTabActive` filled-accent style); raw mode = font-mono pre on surface-2.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D39 — Composer outer-classes are 3 modules; inner-classes are 7 globals

**Date:** 2026-05-30 (PR4 Task 4 + Tasks 16-18).
**Spec position:** §3.1 lift-on-second-use; D15 (PR3) called out the inner-vs-outer split.
**Reality:** Outer is unique per composer (different padding/background by mounting context — Inline inside `<table>` colspan-3, Reply inside `ExistingCommentWidget`, PrRootReply on Overview). Inner is shared.
**Plan resolution:** 3 outer-only module CSS files + 7 inner global rules in `tokens.css`. JSX consumes outer via `${styles.x}` and inner via literal global strings.
**Status:** Applied in PR4.

### D40 — D21 fulfillment is implicit; no new baseline zone

**Date:** 2026-05-30 (PR4 plan-writing pre-flight; reframes PR3 D21).
**Spec position:** Spec §4.4 line 257 enumerates two PR4 baselines: file tree zone, diff pane zone. PR3 D21 mentioned "open-composer baseline" but did not pre-commit to a new zone in `parity-baselines.spec.ts`.
**Reality:** Adding a `pr-detail-overview-composer-open.png` zone would be brittle (mount is a click-interaction state) and not in §4.4 scope.
**Plan resolution:** Reframe D21 as "PR4 makes the open-composer state visually correct via the composer-primitive lift; test coverage of that state is left to natural growth of vitest unit tests on the composers." No new Playwright zone.
**Status:** Reframed in PR4. Logged for PR9 to audit if open-composer regression coverage is later judged insufficient.
**Cross-refs:** PR3 D21.

### D41 — D4 selector tightening (Calc.cs file row) — landed in PR4

**Date:** 2026-05-30 (PR4 Task 8 + Task 20 Step 20.2).
**Spec position:** PR1 D4 hand-off note to PR4.
**Reality:** PR4 owns the FileTree DOM. JSX adds `data-testid="files-tab-tree-row"` + `data-path={node.file.path}` to each file row at Task 2 Step 2.5 + Task 8 Step 8.2. Test selector tightens to `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` at Task 20 Step 20.2.
**Plan resolution:** Additive JSX attributes (§2.2-compliant); selector tightened in same PR.
**Status:** Applied in PR4.
**Cross-refs:** PR1 D4.

### D42 — PR4 split-checkpoint at Task 9.5 — decision recorded here

**Date:** 2026-05-30 (PR4 Task 9.5).
**Spec position:** §4.4 line 255 + §6.6 — implementer judges single-PR4 vs PR4a/PR4b split based on measured LOC + review-meaningful-change count.
**Reality:** Threshold tripping decided at Task 9.5 with two metric reads.
**Plan resolution:** Default is single-PR4. Split into PR4a (Tasks 1-9 + tail) / PR4b (Tasks 10-19 + tail) if BOTH thresholds tripped, or implementer judgment if only one. Decision recorded in this entry at Task 9.5 commit.
**Status:** Applied in PR4 (record final single/split decision + measurement here at Task 9.5 commit time).
**Cross-refs:** Spec §6.6.
```

- [ ] **Step 23.1: Read the existing deferrals sidecar to locate the append position**

The PR3 section ends with D24. PR4 entries D25-D42 append below the PR3 block.

- [ ] **Step 23.2: Author all 18 entries**

Write them in order. Each entry has Date / Spec position / Reality / Plan resolution / Status fields per PR2/PR3 precedent. Cross-refs to PR3 D-numbers where relevant (D15 ↔ D26, D21 ↔ D40, D4 ↔ D41).

- [ ] **Step 23.3: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr4): append PR4 deferrals (D25-D42)"
```

---

## Task 24: Pre-push checklist + ce-doc-review on changes (if applicable)

Per `.ai/docs/development-process.md`. Every step.

- [ ] **Step 24.1: Run `npm run lint`**

```bash
cd frontend && npm run lint 2>&1 | tail -30
```

Expected: zero errors. Prettier --check is part of lint — if it surfaces unformatted files, run `npm run prettier -- --write <files>` and re-stage.

- [ ] **Step 24.2: Run `npm run build`**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: success.

- [ ] **Step 24.3: Run vitest**

```bash
cd frontend && npm run test -- --run 2>&1 | tail -20
```

Expected: pass count matches Task 1 Step 1.4 baseline (plus any new tests added in this PR).

- [ ] **Step 24.4: Run dotnet test**

```bash
dotnet test --no-restore --logger "console;verbosity=normal" 2>&1 | tail -20
```

Expected: pass count matches Task 1 Step 1.4 baseline. (No backend changes expected in PR4 — count should be identical.)

- [ ] **Step 24.5: Run Playwright (parity-baselines + the touched spec range)**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts 2>&1 | tail -20
```

Expected: all un-fixmed zones pass against the captured baselines. If a zone fails, the captured baseline is stale — investigate (likely a follow-up CSS edit after Task 22 changed the rendered output; re-capture with `--update-snapshots`).

- [ ] **Step 24.6: Sanity-check the full Playwright suite is green or expected-fixmed**

```bash
cd frontend && npx playwright test 2>&1 | tail -30
```

- [ ] **Step 24.7: Final commit (if any post-checklist tweaks landed)**

If any of the above checks required a fix, commit it before push:

```bash
git add <files>
git commit -m "fix(pr4): address <issue> from pre-push checklist"
```

- [ ] **Step 24.8: Hand off to pr-autopilot**

Invoke `pr-autopilot` to handle preflight + open + comment-loop + CI gate + final report per `feedback_use_pr_autopilot.md`.

---

## Acceptance criteria

- All 14 module CSS files exist and import cleanly.
- The 7 composer-inner classes are global rules in `tokens.css`.
- `PrRootReplyComposer.module.css` contains exactly one rule (`.prRootReplyComposer` outer).
- `parity-baselines.spec.ts` has un-fixmed `pr-detail-files-tree` and `pr-detail-files-diff` zones; both screenshot files exist.
- `data-testid` hooks present on the 13 component roots + per-row `data-testid="files-tab-tree-row"` + `data-path` on file rows.
- D25-D42 entries appended to `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`.
- `npm run lint`, `npm run build`, `npm run test`, `dotnet test`, and `npx playwright test parity-baselines.spec.ts` all green.
- Side-by-side review against the handoff prototype on the file tree + diff pane zones surfaces no unexplained visual deltas; any acknowledged deviations live in the deferrals sidecar.

If splitting into PR4a/PR4b at Task 9.5, the acceptance criteria scope to the slice's task range; the PR4b plan inherits the remaining criteria.
