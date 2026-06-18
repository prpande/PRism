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
- **Low** files are acknowledged for closure (a muted count) without listing them as rows.
- **No `FileFocus` contract change**; the only backend change is the ranker's system prompt.

## Non-goals

- **Per-hotspot line numbers** — deferred entirely (not in this slice).
- **AI Summary polish** (configurable length budget, prompt rewrite, skeleton glow) — separate deferred slice.
- **`FileFocus` wire/DTO contract change** — explicitly avoided; the headline rides inside `rationale`.
- **FileTree AI dot changes** (#492/#509) — untouched. (If the future #509 styled tooltip is built, it
  should surface the new synopsis line; that is its slice's concern, not this one.)
- Changing the ranking model, selectivity, caching, eviction, single-flight, or audit behavior.

## Design decisions

- **D1 — Headline source: derived client-side from `rationale`.** No new contract field, no extra output
  tokens beyond the synopsis text, no new sanitization path. (Rejected: a dedicated LLM `title` field —
  it would force a contract change and can drift from the rationale below it.)
- **D2 — Synopsis is the rationale's first line.** The ranker prompt is changed so the rationale **leads
  with a ≤ ~8-word synopsis on its own first line** (no bullet, no markdown heading), followed by the
  existing concise bullets. The FE splits on the first newline: first line → headline, remainder → the
  expanded markdown body. **No duplication** (the synopsis is not repeated in the body). (Rejected:
  synopsis-as-first-bullet — stripping list item #1 from rendered markdown is more brittle than a
  first-line split.)
- **D3 — Layout: headline-led, path beneath.** Row = level glyph · two-line stack (bold headline /
  muted mono path) · jump-to-code · expand chevron. Path stays visible but secondary.
- **D4 — Single container, no per-severity heading boxes.** One outer card holds all rows, sorted
  High → Medium. Severity is read from the glyph alone. (Drops the "segment containers / group headings"
  item from the original issue scope — the glyph makes headings redundant chrome.)
- **D5 — Section divider: whitespace only.** ~`--s-4` vertical gap between the High block and the Medium
  block (and before the Low footer). No rule, no accent line.
- **D6 — Level glyph: signal bars, hue + shape coded.** Ascending bars; active-bar count AND hue encode
  level (High = 3 bars amber, Medium = 2 bars blue, Low = 1 bar muted). Level is therefore **not conveyed
  by color alone** (WCAG 1.4.1). Replaces the monochrome dot. **Accepted divergence:** the FileTree AI dot
  (#492/#489) stays monochrome-accent; the Hotspots glyph is hued. Hotspots is the dedicated triage
  surface and can be richer; the hue lives only in a small glyph, not a whole container.
- **D7 — Low handling: muted count-footer, not rows.** Low entries are not listed (a "low hotspot" is a
  contradiction, and the Files tab already shows all files with AI dots). A muted footer inside the card
  reads "N low-priority files — skim them in the Files tab," with a faint 1-bar glyph; the link switches to
  the Files tab. The footer is omitted when the Low count is 0.
- **D8 — Jump-to-code: a labeled "Diff" pill.** A small `</> Diff` pill (code-brackets icon + label) on the
  row's trailing edge, visually separate from the expand chevron, always visible. Clicking it calls the
  existing `requestFileView(path)`. (Rejected: path-as-link — hides a primary action behind hover
  discoverability and nests interactive elements; panel-footer-only — forces an expand before you can jump.)
- **D9 — Expand affordance unchanged in spirit.** The row body (glyph + stack) + chevron toggle the
  rationale panel; the pill is a sibling control. Rows whose rationale has **no body** (synopsis-only, or a
  boilerplate backfill rationale) render **without** an expand affordance.

## Architecture

### Backend (one prompt edit + sample data)

- **`PRism.Web/Ai/ClaudeCodeFileFocusRanker.cs` — `SystemPromptV1`.** Change the `rationale` instruction
  from "concise bulleted markdown" to: *the first line is a short synopsis (a headline of at most ~8 words,
  no bullet, no markdown heading) shown as the hotspot's title; then concise bullets explaining the
  specific risk/change.* All other prompt rules (selectivity, ≤10 high/medium cap, untrusted-data framing)
  are unchanged. The `RetryReminder` is unchanged.
- **No parser/contract change.** `FileFocusParser` still parses `{path, score, rationale}`, still sanitizes
  via `AiTextSanitizer` (preserving `\n`), still caps at `RationaleCap`. The synopsis-first text is just a
  rationale whose first line happens to be short — the parser is agnostic. Existing `FileFocusParserTests`
  stand unchanged.
- **`PRism.AI.Placeholder/PlaceholderData.cs`.** Update the two sample `FileFocus` rationales to the
  synopsis-first shape so sample mode shows the new design, e.g.
  `"Boundary handling in core calc\n- Review the new clamp on the upper bound…"`.

### Frontend

- **`splitRationale(rationale: string): { headline: string; body: string }`** — new helper in the
  HotspotsTab folder (co-located, unit-tested). `headline` = `stripMarkdown` applied to the first non-empty
  line (reusing the existing `stripMarkdown` line-stripping, which already drops bullet/heading/emphasis
  leaders); `body` = the remaining lines, trimmed (raw markdown for the renderer). If there is no remaining
  non-empty content, `body` is `''`. `stripMarkdown` is retained and reused (not duplicated).
- **`HotspotsTab.tsx`** — restructured:
  - Compute `high`/`medium` as today; additionally `lowCount = entries.filter(e => e.level === 'low').length`.
  - Render one container (`.card`) holding `high` rows, a gap, `medium` rows, a gap, then the Low footer
    (when `lowCount > 0`).
  - Each row: `<LevelGlyph level=… />` · two-line stack (headline button / mono path) · `Diff` pill button
    · chevron. The toggle button (stack + chevron) carries `aria-expanded` / `aria-controls`; the `Diff`
    pill and the toggle are **sibling** buttons (no nesting). When `body === ''` the row renders no toggle
    (static headline) and no panel.
  - Expanded panel renders `<MarkdownRenderer source={body} className="ai-markdown" />` (unchanged
    renderer; never `dangerouslySetInnerHTML`).
  - The empty/`no-changes`/`not-subscribed`/`fallback`/`error`/loading-skeleton states are **preserved
    verbatim** from the shipped component (fallback still shows the message, not rows).
- **`LevelGlyph`** — small presentational component rendering the signal-bars SVG for `high|medium|low`,
  `aria-hidden` (the level is already announced via the existing `sr-only` text / row label). Hue + bar
  count per D6.
- **`HotspotsTab.module.css`** — replace `.dot`/`.dotMed`/`.dotHigh` and the group/heading styles with:
  `.card`, `.row` (two-line stack), `.headline`, `.path`, `.glyph`, `.diffPill`, `.chevron`, `.gap`,
  `.lowFooter`. Path keeps the truncation rules already in place (`min-width:0; overflow:hidden;
  text-overflow:ellipsis`).

### Data flow

Unchanged wire: `GET …/ai/file-focus` → `FileFocusResult { entries: FileFocus[], fallback }`. The FE derives
the headline from `entries[i].rationale` at render time. No new fetch, no envelope change.

## Accessibility

- Each expandable row's toggle is a `<button aria-expanded aria-controls={panelId}>`; the panel `id` is
  path-stable (reuse the shipped `PANEL_ID_UNSAFE_CHARS` scheme). Enter/Space toggle.
- The `Diff` pill is a separate `<button aria-label={`Open ${path} in the diff`}>` — a sibling, not nested.
- Severity is conveyed by the glyph **and** an `sr-only` "AI focus: high/medium" text, so it is not
  color-only (WCAG 1.4.1). The glyph itself is `aria-hidden`.
- The Low footer link is a `<button>`/link with an explicit label that switches to the Files tab.
- Rows are an `<ul role="list">` of `<li>` (preserve the shipped list semantics).

## Edge cases

- **Synopsis-only rationale (no body):** row shows headline + path + pill, no chevron, not expandable (D9).
- **Boilerplate backfill rationale** (`"Not individually ranked."`): a Medium row with that text as the
  (non-expandable) headline. Rare in practice (only files the model omitted); acceptable.
- **All-medium fallback** (provider failed): handled upstream — status is `fallback`, the tab shows the
  "Couldn't rank this PR automatically" message, never rows. Unaffected by this redesign.
- **Long headline / long path:** headline wraps to at most two lines (or single-line ellipsis — confirm in
  build); path single-line ellipsis as today.
- **Zero High and zero Medium (all low / empty):** the existing positive-empty message renders; the Low
  footer alone is not shown as the whole tab (keep the "nothing needs attention" message).

## Testing

- **vitest — `splitRationale`:** first-line → headline (markdown stripped); body = remainder; synopsis-only
  → `body === ''`; CRLF/blank-leading-lines handled; a bullet-only rationale (no distinct first line) still
  yields a sensible headline.
- **vitest — `HotspotsTab`:** High-before-Medium order in one container; Low footer shows the count and is
  omitted at 0; expand toggles only the rationale body (synopsis not duplicated); the `Diff` pill calls
  `requestFileView` and does **not** toggle expand; synopsis-only row has no toggle; preserved
  empty/error/fallback/not-subscribed states still render their messages.
- **vitest — a11y:** toggle has `aria-expanded`/`aria-controls`; pill has its own `aria-label`; `sr-only`
  level text present.
- **e2e — `frontend/e2e/hotspots.spec.ts`:** update DOM expectations (headline text, glyph, `Diff` pill,
  Low footer) for the new structure; AI is mocked as today.
- **backend:** existing `FileFocusParserTests` and ranker tests stand (no contract/parse change). No new
  backend test is required for a prompt-string edit; the sample-data change is covered by existing
  placeholder/sample-mode coverage.
- **Visual baselines:** the Hotspots tab is AI-gated **off** in the visual e2e suite (consistent with
  #489), so no screenshot baseline is expected to change; verify during the run and regenerate only if a
  baseline actually renders the tab.

## Risks

- **Prompt-shaped headline quality.** The synopsis is only as good as the model's first line. Mitigation:
  the prompt is explicit ("≤8 words, no bullet, shown as the title"); `splitRationale` always falls back to
  the first content line, so a non-conforming response still yields a usable headline.
- **Hue divergence from FileTree dots.** A deliberate, documented choice (D6). If it later reads
  inconsistent at B1, the fallback is monochrome bars (hue is a CSS-only change).
- **Backfilled-Medium boilerplate rows.** Low-value but rare; not worth special-casing in this slice
  (noted in edge cases).

## Self-review

- *Placeholders:* none — all components, helpers, prompt edits, and tests are named with concrete behavior.
- *Consistency:* the "no contract change" claim holds throughout (headline is derived; only the prompt and
  sample data change on the backend). Severity is glyph-driven (D4/D6) — no contradiction with the dropped
  group headings.
- *Scope:* single implementation plan's worth — one prompt edit + sample data + one FE component restructure
  + one helper + CSS + tests. Line numbers and AI Summary polish explicitly excluded.
- *Ambiguity:* the synopsis-vs-body split is pinned to "first line" (D2); the Low handling is pinned to a
  count-footer (D7); jump-to-code is pinned to the pill (D8). Long-headline wrap is the one item left to
  confirm at build (noted).
