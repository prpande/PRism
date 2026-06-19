# Hotspots Tab Redesign — Design

**Issue:** #520 · **Epic:** #423 (v2 AI augmentation) · **Evolves:** shipped #465 + #488 · **Base branch:** V2

One-line: rebuild the Hotspots tab around a **headline-led row** — each hotspot leads with a short
synopsis (authored by the ranker as the first line of its rationale, derived client-side), carries its
severity in a **signal-bars glyph**, and exposes a clear **jump-to-code** affordance — inside a single
container with whitespace-separated severity sections and a muted Low count-footer.

## Context

#488 shipped the Hotspots tab as a multi-open accordion: per-row monochrome severity **dot**, file **path**
as the only identifier, a stripped one-line preview, and a markdown **rationale** panel on expand. During
owner B1 live-validation the redesign below was scoped into its own slice. The complaint with the shipped
version: a hotspot is identified only by its path, so the reviewer must open every row to learn *why* it is
a hotspot; severity is carried by a subtle dot; and the jump-to-diff affordance is a cramped arrow crammed
next to the chevron.

The wire contract `FileFocus(Path, Level, Rationale)` and the whole ranking pipeline
(`ClaudeCodeFileFocusRanker` → `FileFocusParser` → backfill/fallback) already exist and are **not changing
shape**. `rationale` is today consumed by exactly one surface — the Hotspots tab (the FileTree AI dot uses
only `FocusLevel`, never the rationale text), so reshaping the rationale is fully contained.

## Goals

- Each hotspot leads with a short **synopsis headline** so the reviewer learns *what/why* without expanding.
- Severity is shown by a **level glyph** (signal bars) that also extends to a Low symbol and does not rely
  on color alone.
- A **clear, uncramped jump-to-code** affordance, visibly distinct from the expand control.
- A single container, severity-sorted (High → Medium), sections separated by **whitespace** (no headings,
  no separator line).
- **Low** files are **acknowledged without being listed as rows** (a muted count + a one-click hop to the
  Files tab) so the triage surface stays focused on what needs attention.
- **No `FileFocus` wire/DTO shape change**; the only backend changes are the ranker's system prompt, the
  stale DTO doc-comment, and sample data.

## Non-goals

- **Per-hotspot line numbers** — deferred entirely (not in this slice).
- **AI Summary polish** (configurable length budget, prompt rewrite, skeleton glow) — separate deferred slice.
- **`FileFocus` wire/DTO shape change** — explicitly avoided; the headline rides inside `rationale`.
- **FileTree AI dot changes** (#492/#509) — untouched. (If the future #509 styled tooltip is built, it
  should surface the new synopsis line; that is its slice's concern, not this one.)
- Changing the ranking model, selectivity, caching, eviction, single-flight, or audit behavior.
- A new cross-tab navigation primitive — the existing `onSelectSubTab(tab)` on the PR-detail context
  (already used by OverviewTab/DraftsTab) is reused; no context API addition.

## Design decisions

- **D1 — Headline source: derived client-side from `rationale`.** No new contract field, no extra output
  tokens beyond the synopsis text, no new sanitization path. (Rejected: a dedicated LLM `title` field —
  it would force a contract change and can drift from the rationale below it.)
- **D2 — Synopsis is the rationale's first content line; the split must not lose content.** The ranker
  prompt is changed so the rationale **leads with a ≤ ~8-word synopsis on its own first line** (no bullet,
  no markdown heading), followed by the existing concise bullets. `splitRationale` (see Architecture) then:
  - **Conforming case** (first content line is plain prose, not a list item): `headline` = that first line
    (markdown-stripped); `body` = the rationale text **after that same line**. No duplication.
  - **Non-conforming case** (the model ignored the instruction and the first content line is itself a
    bullet/list item, the pre-#465 shape): `headline` = `stripMarkdown(rationale)` as a preview, and
    `body` = the **full rationale** (the first bullet is **not** removed). This guarantees no bullet's
    detail is ever silently dropped from the panel — only a non-duplicating split is suppressed.
  (Rejected: blindly splitting on the first newline and always removing line 1 — it deletes a real first
  bullet's content when the model is non-conforming.)
- **D3 — Layout: headline-led, path beneath.** Row = level glyph · two-line stack (bold headline /
  muted mono path) · jump-to-code · expand chevron. Path stays visible but secondary.
- **D4 — Single container, no per-severity heading boxes, deterministic order.** One outer card holds all
  rows, sorted High → Medium; **within a level, rows are ordered by path ascending** so the order is stable
  across refetches/re-ranks (the parser's insertion order is not meaningful). Severity is read from the
  glyph alone. (Drops the "segment containers / group headings" item from the original issue scope — the
  glyph makes headings redundant chrome. This is the owner's explicit brainstorm decision; the glyph plus
  the `sr-only` level text carry severity.)
- **D4a — Container width: capped and centered, matching the Overview tab (B1).** The outer container caps
  at `max-width: 920px` with `margin: 0 auto`, matching `.overviewGrid`'s current width so the triage surface
  reads as a centered column rather than sprawling edge-to-edge. This deliberately mirrors Overview's flat
  920px rather than adopting #470's proposed fluid `min(80%, 1200px)` — the fluid-width judgment stays with
  #470 (still open). Added during owner B1 live-validation.
- **D5 — Section divider: whitespace only.** A vertical gap (a spacing token, pinned in the plan) between
  the High block and the Medium block, and before the Low footer. No rule, no accent line.
- **D6 — Level glyph: signal bars, hue + shape coded, via design tokens.** Ascending bars; active-bar count
  AND hue encode level (High = 3 bars, Medium = 2 bars, Low = 1 bar). Hues use existing design-system color
  **tokens** (warning-family for High, info-family for Medium, a muted/neutral token for Low) — not
  hardcoded hex — and **must be verified in both light and dark themes** before the visual-baseline run.
  Level is therefore **not conveyed by color alone** (WCAG 1.4.1). Replaces the monochrome dot. **Accepted
  divergence:** the FileTree AI dot (#492/#489) stays monochrome-accent; the Hotspots glyph is hued.
  Hotspots is the dedicated triage surface and can be richer; the hue lives only in a small glyph.
- **D7 — Low handling: muted count-footer, not rows.** Low entries are not listed (a "low hotspot" is a
  contradiction, and the Files tab already shows all files with AI dots). A muted footer inside the card
  reads "N low-priority files — skim them in the Files tab," with a faint 1-bar glyph. The link is a
  `<button>` calling the existing `onSelectSubTab('files')`. **`N` counts only model-scored Low entries;
  low-by-rule entries** (empty-body renames/deletes, rationale `"No changes to review in this file."`) **are
  excluded** so the count reflects files actually worth a skim. The footer is omitted when that count is 0.
  *(The footer delivers acknowledgement, not a filtered landing — applying an AI/Low filter on the Files tab
  arrival is a possible future enhancement, out of scope here.)*
- **D8 — Jump-to-code: a labeled "Diff" pill.** A small `</> Diff` pill (code-brackets icon + label) on the
  row's trailing edge, visually separate from the expand chevron, always visible. Clicking it calls the
  existing `requestFileView(path)`. (Rejected: path-as-link — hides a primary action behind hover
  discoverability and nests interactive elements; panel-footer-only — forces an expand before you can jump.)
- **D9 — Expand affordance, synopsis-only and boilerplate rows.** The row body (glyph + stack) + chevron
  toggle the rationale panel; the pill is a sibling control. A row whose `body` is empty renders **without**
  a chevron and **without** a row-hover/pointer affordance (so a no-op hover never implies clickability);
  the trailing chevron slot is reserved/omitted consistently so rows stay grid-aligned. This is acceptable
  at any level — a synopsis-only rationale has no further detail to show. **Boilerplate backfill rows**
  (rationale `"Not individually ranked."`) use the **path as the headline** (keeping the real identifier
  primary), not the boilerplate sentence.
- **D10 — Expand state persists by path across re-rank.** Expanded state is keyed by file path (a
  `Set<string>` of open paths, as shipped), not by array index, so a re-rank/refetch keeps the reviewer's
  reading position on the right entry; paths absent from a new result drop out of the set.
- **D11 — Long headline: two-line clamp.** The headline clamps to at most two lines
  (`-webkit-line-clamp: 2`); the glyph, pill, and chevron align to the first text line. Path stays
  single-line ellipsis as today. (Resolves the build-time ambiguity in favor of a two-line clamp: a
  conforming ≤8-word synopsis fits one line, a non-conforming long line caps at two.)

## Architecture

### Backend (prompt edit + doc comment + sample data — no shape change)

- **`PRism.Web/Ai/ClaudeCodeFileFocusRanker.cs` — `SystemPromptV1`.** Change the `rationale` instruction
  from "concise bulleted markdown" to: *the first line is a short synopsis (a headline of at most ~8 words,
  no bullet, no markdown heading) shown as the hotspot's title; then concise bullets explaining the
  specific risk/change.* All other prompt rules (selectivity, ≤10 high/medium cap, untrusted-data framing)
  are unchanged. `RetryReminder` is unchanged.
- **No parser/contract-shape change.** `FileFocusParser` still parses `{path, score, rationale}`, still
  sanitizes via `AiTextSanitizer` (preserving `\n`), still caps at `RationaleCap`. The synopsis-first text
  is just a rationale whose first line happens to be short — the parser is agnostic. Existing
  `FileFocusParserTests` stand unchanged.
- **`PRism.AI.Contracts/Dtos/FileFocus.cs` — update the stale `Rationale` doc comment.** It currently reads
  "one-sentence, plain-text … render as a text node only; never as HTML/markdown," which is already stale
  since #465 (the rationale renders as markdown) and is further contradicted by the synopsis-first
  multi-line shape. Update it to: *multi-line markdown — the first line is a short headline (≤ ~8 words),
  followed by a newline-separated bulleted explanation; the first line is rendered as a plain-text headline,
  the remainder as markdown in the expanded panel.*
- **`PRism.AI.Placeholder/PlaceholderData.cs`.** Update the two sample `FileFocus` rationales to the
  synopsis-first shape so sample mode shows the new design, e.g.
  `"Boundary handling in core calc\n- Review the new clamp on the upper bound…"`. (If missed, sample mode
  would demonstrate exactly the non-conforming bullet-first case — so this update is part of the slice.)

### Frontend

- **`splitRationale(rationale: string): { headline: string; body: string }`** — new helper in the
  HotspotsTab folder (co-located, unit-tested), implementing D2 precisely. It is **not** a blind
  first-newline split: it finds the first non-empty content line (reusing `stripMarkdown`'s line handling),
  and decides conforming vs non-conforming per D2. `stripMarkdown` is retained and reused (not duplicated).
- **`HotspotsTab.tsx`** — restructured:
  - Compute `high`/`medium` as today, each **sorted by path ascending** (D4); compute the Low count per D7
    (model-scored Low only, excluding low-by-rule).
  - Render one container (`.card`) holding `high` rows, a gap, `medium` rows, a gap, then the Low footer
    (when the Low count `> 0`). **When both `high` and `medium` are empty** (all-low or empty), render the
    existing positive "nothing needs attention" message instead of an otherwise-empty card — same condition
    as shipped (`status === 'empty' || (high.length === 0 && medium.length === 0)`).
  - Each row: `<LevelGlyph level=… />` · two-line stack (headline / mono path) · `Diff` pill button ·
    chevron. The toggle button (stack + chevron) carries `aria-expanded` / `aria-controls`; the `Diff` pill
    and the toggle are **sibling** buttons (no nesting), with the toggle region **first in DOM/tab order**
    and the pill second (matching visual left-to-right). When `body === ''` the row renders no toggle
    (static, non-hover headline) and no panel (D9).
  - Expanded state keyed by path (`Set<string>`, D10). Expanded panel renders
    `<MarkdownRenderer source={body} className="ai-markdown" />` (unchanged renderer; never
    `dangerouslySetInnerHTML`).
  - The `no-changes`/`not-subscribed`/`fallback`/`error` states are **preserved verbatim** from the shipped
    component (fallback still shows the message, not rows). The **loading skeleton** is updated to match the
    new row shape (glyph slot + two-line text stack), retaining the current row height.
- **`LevelGlyph`** — small presentational component rendering the signal-bars SVG for `high|medium|low`,
  `aria-hidden`. In a row the level is announced via an `sr-only` "AI focus: high/medium" text on the row
  (see Accessibility); in the footer the glyph is decorative only with no `sr-only` level text (its meaning
  comes from the footer copy, not a per-entry severity).
- **`HotspotsTab.module.css`** — replace `.dot`/`.dotMed`/`.dotHigh` and the group/heading styles with
  `.card`, `.row` (two-line stack), `.headline` (two-line clamp), `.path`, `.glyph`, `.diffPill`,
  `.chevron`, `.gap`, `.lowFooter`. **Interaction states** (hover / focus-visible / active for the pill and
  chevron, and the chevron's rotate-on-expand) are specified in the implementation plan using the existing
  design-system focus-ring token — the plan pins exact values; the design contract is only that all three
  states exist and the focus ring matches the rest of the app.

### Data flow

Unchanged wire: `GET …/ai/file-focus` → `FileFocusResult { entries: FileFocus[], fallback }`. The FE derives
the headline from `entries[i].rationale` at render time. No new fetch, no envelope change.

## Accessibility

- Each expandable row's toggle is a `<button aria-expanded aria-controls={panelId}>`; the panel `id` is
  path-stable (reuse the shipped `PANEL_ID_UNSAFE_CHARS` scheme — correctness relies on the parser's
  last-wins dedup so a path appears at exactly one level). Enter/Space toggle.
- The `Diff` pill is a separate `<button aria-label={`Open ${path} in the diff`}>` — a sibling, not nested —
  and comes **after** the toggle in tab order.
- Severity is conveyed by the glyph **and** a **net-new** `sr-only` "AI focus: high/medium" text on each row
  (this is new work for HotspotsTab — the shipped component had no `sr-only` level text; the pattern is
  borrowed from `FileTree.tsx`). The glyph itself is `aria-hidden`. This keeps level non-color-only
  (WCAG 1.4.1), which matters now that hue is introduced.
- The Low footer is a `<button>` whose label includes the count (e.g. "3 low-priority files — switch to the
  Files tab") and which calls `onSelectSubTab('files')`; Enter/Space activate it.
- Rows are a `<ul role="list">` of `<li>` (preserve the shipped list semantics).

## Edge cases

- **Synopsis-only rationale (no body):** row shows headline + path + pill, no chevron, no row hover, not
  expandable (D9) — acceptable at any level, since there is no further detail to show. (Content is never
  *lost* this way; D2's non-conforming branch guarantees a bullet-first response keeps its full body.)
- **Boilerplate backfill rationale** (`"Not individually ranked."`): a Medium row that uses the **path as
  the headline** (D9), non-expandable. Rare (only files the model omitted).
- **All-medium fallback** (provider failed): handled upstream — status is `fallback`, the tab shows the
  "Couldn't rank this PR automatically" message, never rows. Unaffected by this redesign.
- **All entries Low / empty:** the positive "nothing needs attention" message renders; no card, no footer.
- **Long headline / long path:** headline two-line clamp (D11); path single-line ellipsis as today.

## Testing

- **vitest — `splitRationale`:** conforming case (first prose line → headline, remainder → body, no
  duplication); **non-conforming bullet-first rationale does not lose the first bullet from `body`**
  (D2 regression); synopsis-only → `body === ''`; CRLF/blank-leading-lines handled.
- **vitest — `HotspotsTab`:** High-before-Medium order with a **stable intra-level path sort**; Low footer
  shows the count, omits low-by-rule, and is absent at 0; expand toggles only the body (synopsis not
  duplicated); the `Diff` pill calls `requestFileView` and does **not** toggle expand; a **synopsis-only
  High** row renders without a toggle; a backfill row uses the path as headline; expand state survives a
  re-render keyed by path; preserved empty/error/fallback/not-subscribed states still render their messages.
- **vitest — a11y:** toggle has `aria-expanded`/`aria-controls`; pill has its own `aria-label` and follows
  the toggle in DOM order; `sr-only` level text present; Low footer button label includes the count.
- **e2e — `frontend/e2e/hotspots.spec.ts`:** update DOM expectations (headline, glyph, `Diff` pill, Low
  footer) for the new structure; AI is mocked as today.
- **backend:** existing `FileFocusParserTests` and ranker tests stand (no contract/parse change). No new
  backend test is required for a prompt-string edit; the sample-data change is covered by existing
  placeholder/sample-mode coverage.
- **Visual baselines:** the Hotspots tab is AI-gated **off** in the visual e2e suite (consistent with
  #489), so no screenshot baseline is expected to change; verify during the run and regenerate only if a
  baseline actually renders the tab.

## Acceptance / validation

- **Headline quality is validated empirically, not assumed.** Before the PR, run the new prompt against the
  live sample PR(s) and confirm the first line reads as a *title* (short, no leading bullet) for real
  High/Medium files. Record the observed failure mode and the concrete fallback rendering (D2's
  non-conforming branch) if it does not — the headline is the load-bearing element of the redesign, so
  "usable" is demonstrated, not claimed. There is no server-side guarantee the first line is a synopsis;
  quality depends on model compliance, which this check exercises.

## Risks

- **Prompt-shaped headline quality.** The synopsis is only as good as the model's first line. Mitigation:
  the prompt is explicit; `splitRationale`'s non-conforming branch always yields a usable headline **without
  losing body content** (D2); and the acceptance check above exercises real output.
- **Hue divergence from FileTree dots.** A deliberate, documented choice (D6). If it reads inconsistent at
  B1, the fallback is monochrome bars (hue is a token-only change).
- **Backfilled-Medium rows.** Low-value but rare; mitigated by using the path as the headline (D9).

## Self-review

- *Placeholders:* none — all components, helpers, prompt edits, doc-comment edit, and tests are named with
  concrete behavior.
- *Consistency:* "no contract-shape change" holds throughout — the headline is derived; the backend changes
  are the prompt, the (already-stale) DTO doc comment, and sample data, none of which alter the wire shape.
  Severity is glyph + `sr-only` text (D4/D6) — consistent with the dropped group headings. The all-low
  render condition is stated in both Architecture and Edge cases.
- *Scope:* one implementation plan's worth — prompt edit + DTO comment + sample data + one FE component
  restructure + `splitRationale` + `LevelGlyph` + CSS + tests. Line numbers and AI Summary polish excluded.
- *Ambiguity:* the split is pinned (D2, conforming/non-conforming); Low handling is pinned (D7, count
  composition + reused `onSelectSubTab`); long-headline wrap is resolved (D11, two-line clamp); expand
  persistence is pinned (D10, path-keyed). Exact CSS state values are intentionally deferred to the plan
  (the design contract is that the states exist and match the app's focus-ring token).
