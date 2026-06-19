# AI output formatting: markdown rendering + concise bulleted output across all AI surfaces

- **Date:** 2026-06-18
- **Branch:** V2
- **Issues:** #465 (markdown + bulleted output across all AI text surfaces) clubbed with #488 (Hotspots tab accordion + chrome polish)
- **Epic:** #423 (v2 AI augmentation roadmap)
- **Status:** design approved; ready for implementation planning

## Problem

LLM-generated text in PRism is returned with markdown structure — bullets, inline
code, fenced code snippets, emphasis, links — but three AI surfaces render it as a
single plain-text blob:

- **AI Summary** (`AiSummaryCard`) renders `{summary.body}` in a plain `<div>`.
- **Hotspots rationale** (`HotspotsTab`) renders `{r.rationale}` as a plain `<span>` with a `title` tooltip.
- **Hunk annotation** (`AiHunkAnnotation`) renders `{annotation.body}` in a plain `<div>`.

A wall of prose is hard to scan and mangles code. The pre-submit validator card
(`SubmitDialog/PreSubmitValidatorCard.tsx`) already renders AI text through the shared
`MarkdownRenderer` — it is the reference pattern; these three surfaces should match it,
and the generators should be *prompted* to emit concise bulleted markdown so the output
is scannable rather than a paragraph.

The Hotspots rationale specifically cannot just be "rendered as markdown inline": since
#414 the rationale wraps in full, so a populated Hotspots tab is already a tall wall of
always-expanded text. Markdown there only makes sense once the rows have an
**expand/collapse** container — which is exactly the #488 accordion redesign. That seam
is why the two issues are clubbed: one coherent treatment of all AI-generated text, with
the Hotspots accordion as the container its markdown rationale lands in.

## Goals

- Every AI-generated text surface renders GFM markdown via the existing `MarkdownRenderer`
  (bullets, links, inline code, fenced code), with a **consistent** compact treatment.
- The summarizer, file-focus ranker, and hunk annotator are prompted to **prefer concise,
  bulleted, human-readable markdown**; the `PRism.AI.Placeholder` generators emit the same
  shape so Preview/Sample mode demonstrates it.
- **Render faithfully, never fabricate structure.** Bullets are *requested* in the prompt, not
  enforced. `MarkdownRenderer` renders exactly what the model returns — a bullet list as `<ul>`,
  prose as `<p>`. No surface synthesizes bullets from prose or strips them; if the model answers
  in sentences, the summary reads as sentences. This is why no surface needs a prose-vs-bullets
  mode switch.
- The Hotspots tab becomes a collapsible accordion (per #488) whose **expanded** panel is
  where the markdown rationale renders; the **collapsed** preview stays a plain truncated
  one-liner.

## Non-goals

- No new **render-side** sanitization surface. `MarkdownRenderer` is used **as-is** — it
  already renders untrusted PR descriptions/comments and is NOT configured with
  `rehype-raw`/raw-HTML passthrough. (See Constraints. The one pre-existing HTML-injection
  path — ` ```mermaid ` fences routed to `MermaidBlock`'s `dangerouslySetInnerHTML` — is
  unchanged by this work and is gated by mermaid's own sanitizer; these AI surfaces add no new
  path.) **Implementation note (owner-directed):** preflight review found the *backend*
  ingestion-side strip was applied inconsistently — only `HunkAnnotationParser` removed bidi /
  control characters, while `FileFocusParser` (hotspot rationale) and `PrCategoryParser`
  (summary body) fed the same renderer unsanitized, leaving a bidi text-spoofing gap on those
  surfaces. The fix extracts a shared `AiTextSanitizer` and routes all three parsers through it
  (see Architecture). This is backend normalization on ingestion, not a new render-side path,
  so it does not weaken the render-side non-goal above.
- No nested per-hunk detail in the accordion — that is #468/#487. This design only builds
  the accordion as the container they will later nest into.
- No chunked summarization, no change to the `CATEGORY:` first-line contract, no change to
  the ranker/annotator JSON wire shapes or caps.

## Constraints

- **XSS safety.** The Hotspots rationale is currently a deliberate plain-text node. The
  replacement must route through the existing `MarkdownRenderer` (GFM + `remark-gfm`,
  `urlTransform` scheme allowlist, no `rehype-raw`). This work introduces **no new** raw-HTML
  passthrough; the renderer's only HTML-injection path — ` ```mermaid ` → `MermaidBlock`
  (`dangerouslySetInnerHTML`, gated by mermaid's own sanitizer) — is pre-existing and shared
  with comment/description rendering, not added here. A regression test asserts an inline
  `<script>`/raw-HTML string is not rendered as live HTML, and includes a ` ```mermaid ` case
  to pin that an AI body cannot smuggle live markup through the mermaid path.
- **Compact surfaces stay compact.** Markdown must render compactly in the tight chrome of
  the annotation popover and the hotspot rows. The collapsed hotspot preview stays a single
  truncated line (preview-only truncation — does not re-introduce the #414 truncation bug,
  which was about truncating the *only* copy of the text).
- **Both themes.** Light and dark. Any surface whose layout changes gets a B1 visual gate,
  mocked/validated from real tokens live (not mocks), per the repo's standing rule.

## Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Shared markdown treatment | **Approach A** — render each surface through `MarkdownRenderer` directly with a shared `.ai-markdown` CSS class. No wrapper component, no prop on the generic renderer. Matches the existing validator-card pattern. |
| D2 | Accordion expand model | **Multi-open** — any number of rows open at once (compare rationales). |
| D3 | Accordion default state | **All collapsed** — scan-first, drill on demand. |
| D4 | Accordion layout | **Keep High/Medium sections** with a per-row level dot (monochrome accent, reusing the Files-tree convention — see Slice 2) inside each section. |
| D5 | Collapsed row content | **Path + level dot + one-line rationale preview** (markdown stripped to plain text, first non-empty line, CSS-ellipsis truncated). |
| D6 | Annotation popover markdown | **Full markdown incl. fenced code**, with an extra-tight `.ai-markdown--popover` modifier so it does not bloat the popover. |
| D7 | Delivery | **Two slices / two PRs.** Slice 1 = shared treatment + summary + annotation + all prompt/placeholder changes (low-risk, no layout shift). Slice 2 = #488 Hotspots accordion + its markdown rationale (carries the B1 visual gate). |

Note: the **"AI Summary" header acceptance-criterion is already satisfied** — #489 added
`<AiMarker variant="lead" /> AI Summary` to `AiSummaryCard` (the dormant `.aiSummaryHead`
slot the issue mentions is now live). #465's summary work reduces to routing the body
through `MarkdownRenderer`.

## Architecture — the shared treatment (D1)

`MarkdownRenderer` stays the single rendering component for all markdown in the app
(comments, descriptions, drafts, validator, and now the three AI surfaces). The consistent
*AI-text* treatment is one new CSS class, `.ai-markdown`, defined next to `.markdown-body`
in `frontend/src/styles/tokens.css`:

- compact vertical rhythm: tight top/bottom margins on `p`, `ul`/`ol`, and list items so a
  short bulleted answer reads as a tidy block, not double-spaced prose;
- de-emphasized headings (AI bodies rarely need `<h1>`; cap visual size) so a stray heading
  in model output does not blow out the card;
- inherits `.markdown-body`'s overflow-wrap + `pre` wrapping (so long tokens/code wrap, no
  page-level horizontal scrollbar) and the `--content-scale` font multiplier.

A `.ai-markdown--popover` modifier tightens it further for the hunk-annotation popover
(smaller list indent, smaller fenced-code font).

Every AI surface renders `<MarkdownRenderer source={…} className="ai-markdown …" />`.
`MarkdownRenderer` applies `markdown-body <className>`, so each surface gets
`.markdown-body.ai-markdown` and the compact rules layer on the global base.

`.ai-markdown` also styles code: `code:not(pre code)` renders an inline-code chip
(surface-3 background, small radius) and `pre` recesses fenced blocks on `surface-2`. These
are needed because the existing inline-code chip lives on `CommentCard`'s `.body code` /
`PrDescription`'s scoped rules — AI surfaces have no `.body` ancestor, so without these
selectors AI code rendered as unstyled text. (Added during implementation; the prompts now
ask the model for language-tagged fenced blocks so Shiki highlights them.)

**Backend ingestion sanitizer (`AiTextSanitizer`).** All three parsers that feed
`MarkdownRenderer` — `FileFocusParser`, `HunkAnnotationParser`, `PrCategoryParser` — route
their free-text fields through one shared `AiTextSanitizer.StripDangerous`. It strips
category-Cc control characters and the Cf bidi / directional-formatting characters (U+061C,
U+200E/F, U+202A–E, U+2066–9) **except** `\n`/`\r`/`\t`, which carry the markdown structure
(bullet lists, fenced code). Preserving those whitespace controls also fixes a live-mode bug
where the old per-parser strip collapsed a multi-bullet annotation into one paragraph (the
placeholder bypasses the parser, so sample mode looked fine). Code points are compared as
hex so the source stays pure ASCII and the filter can't be silently disarmed by an editor.

Rejected alternatives: a new `<AiMarkdown>` wrapper component (thin wrapper over a
className, abstraction with no behavior — YAGNI); a `compact`/`variant` prop on
`MarkdownRenderer` (couples the generic renderer to AI-surface concerns).

## Slice 1 — markdown rendering + prompts + placeholders (PR1)

### Frontend

**`AiSummaryCard.tsx`**
- Replace `<div className={styles.aiSummaryBody}>{summary.body}</div>` with
  `<MarkdownRenderer source={summary.body} className={`ai-markdown ${styles.aiSummaryBody}`} />`
  (keep the module class for the `[data-sample-badge] + *` margin and body color/line-height;
  the markdown spacing comes from `.ai-markdown`).
- Remove the dormant, now-unreachable `.aiSummaryBullets` / `.aiRisk` classes from
  `AiSummaryCard.module.css` — markdown supplies its own `<ul>`; these are leftovers from an
  earlier non-shipped bulleted-summary concept. (Confirm no other consumer references them
  before deleting.)

**`AiHunkAnnotation.tsx`**
- Replace `<div>{annotation.body}</div>` with
  `<MarkdownRenderer source={annotation.body} className="ai-markdown ai-markdown--popover" />`.
- Tone chip, AI marker, SampleBadge unchanged.

### Backend prompts (text-only edits, no control-flow change)

- **`ClaudeCodeSummarizer.SystemPromptV1`** — change item 2 from "A concise plain-text
  summary (3–6 sentences)…" to "A concise, scannable summary in markdown — **prefer** a short
  bullet list for intent / risk areas / notable specifics when the content suits it; use fenced
  code blocks for code and inline code for symbols; do not pad." (Prefer, not mandate — per the
  render-faithfully principle, prose answers render as prose.) Item 1 (`CATEGORY: <x>` first
  line) is unchanged; `PrCategoryParser.Parse` still splits the first line, so the body simply
  becomes markdown. Keep the untrusted-content instruction.
- **`ClaudeCodeFileFocusRanker.SystemPromptV1`** — change the `rationale` instruction to
  "concise bulleted markdown explaining WHY this file needs review (the specific risk or
  change), scannable, not a paragraph." JSON array shape and the at-most-10 selectivity rule
  unchanged.
- **`ClaudeCodeHunkAnnotator.BuildSystemPrompt`** — change the `body` instruction to
  "concise bulleted markdown (use a fenced code block when referencing code); keep it short
  and under the character cap." The `{cap}` upper-bound rule and `BodyCap` (600) are unchanged;
  `HunkAnnotationParser` still enforces `BodyCap` as a defensive backstop.

**Cap × markdown note (no code change, but keep in view).** The two caps behave differently and
markdown is denser per line, so the "keep it under the cap" prompt instruction matters more now:
- `FileFocusParser.CapRationale` truncates **mid-character** (`s[..599] + "…"`). On a compliant
  short rationale this never fires (600 ≈ 3–4 sentences), but if it ever does on bulleted markdown
  it could sever a fenced block, so the *expanded* panel renders oddly. Acceptable as a backstop;
  do **not** silently inflate output past it.
- `HunkAnnotationParser` **drops** the whole over-cap body (the annotation vanishes), not truncates.
  Bulleted markdown + a fenced snippet is denser, so an undisciplined model is marginally likelier
  to blow the cap and lose the note entirely — another reason the prompt's "keep it short, under
  the cap" line stays firm. Neither cap value changes here.

### Design-doc prompt text (`docs/backlog/02-P1-core-ai.md`)

Update the illustrative prompt wording for the summarizer (P1-1, currently "Be concise
(3–5 sentences)…") — and the ranker/annotator references where present — to describe
concise bulleted-markdown output, so the design doc and the Live `SystemPromptV1`/
`BuildSystemPrompt` text agree (#465 AC: "design docs updated; Live implementations honor it").

### Placeholders (`PRism.AI.Placeholder/PlaceholderData.cs`)

Rewrite the canned strings as the real bulleted-markdown shape so Preview demonstrates it:
- `SummaryBody` → a short markdown bullet list (intent / behavior preserved / tests added),
  with an inline-code symbol and optionally a one-line fenced snippet.
- `FileFocus[*].Rationale` → one or two markdown bullets each (kept short — these feed the
  collapsed preview's first line in Slice 2).
- `HunkAnnotations[*].Body` → concise bulleted markdown, one with a tiny fenced snippet to
  exercise the popover code path.

`PlaceholderPrSummarizer` still prefixes `"Sample AI summary for {pr.PrId}. "` (#464) — that
prefix becomes the lead text before the bullets; confirm it reads sensibly above a bullet list
(may move it onto its own line / first bullet).

### Slice 1 tests
- FE unit (per surface): asserts markdown structure renders — a `<li>` for a bullet, a
  `<code>` for a fenced block — and an **XSS regression**: a raw `<script>`/`<img onerror>`
  string in the body does not produce a live element, plus a ` ```mermaid ` case asserting an
  AI body cannot smuggle live markup through the pre-existing mermaid render path.
- FE: `.ai-markdown` class is applied on each surface (guards the shared treatment wiring).
- Backend: pin placeholder **shape** (e.g. `SummaryBody` contains a markdown bullet marker),
  not prompt prose (prompt text is brittle to assert; leave to review). Existing summarizer /
  ranker / annotator parser tests must stay green (no wire-shape change).
- Visual: `pr-detail-overview.png` baseline — AI is gated off in visual e2e by default, so the
  AI Summary card likely does not appear; **verify**, regen only if it actually renders.

## Slice 2 — #488 Hotspots accordion + markdown rationale (PR2)

### `HotspotsTab.tsx`
- Keep the High/Medium two-section structure (D4). Within each section, render rows as
  accordion items.
- **Collapsed row (button):** level dot + file path + one-line rationale preview.
  - preview = `stripMarkdown(rationale)` → first non-empty line → CSS `text-overflow: ellipsis`
    single-line clamp. `stripMarkdown` is a small local util (strip bullet markers, headings,
    emphasis/inline-code backticks, links→text); preview-only, so full text is never lost.
  - the level dot reuses the Files-tree wayfinding convention **verbatim** (monochrome accent,
    not per-level hue): High = `--accent` with the 2px halo (`.fileTreeAiHigh`), Medium =
    `--accent` at `opacity: 0.6` (`.fileTreeAiMed`). There is no per-level color token to share
    — the Files-tree distinguishes level by halo/opacity, not hue — so the accordion matches
    that exact treatment rather than introducing a second color vocabulary for the same concept.
    (Per-level hues were considered and deferred; revisit only if the monochrome signal proves
    too subtle at the B1 mockup.)
- **Expanded panel:** `<MarkdownRenderer source={r.rationale} className="ai-markdown" />`.
- a11y: each row header is a `<button aria-expanded aria-controls>`, keyboard toggle
  (Enter/Space), panel `id` referenced by `aria-controls`. Multi-open (D2): independent
  per-row open state (e.g. a `Set<path>` or per-row state), all start closed (D3).
- **Deep-link to diff preserved.** Current behavior: the whole row is a button calling
  `onOpen(path)`. The accordion header now owns expand/collapse, so the deep-link action needs
  its own affordance — a dedicated "open in diff" control in the row header (icon button) that
  calls `requestFileView(path)` without toggling, OR expand-on-header + a distinct open-button.
  Chosen: header toggles expand; a separate open-in-diff icon button in the header row triggers
  `requestFileView`. (This avoids the suppress-click-leak class of bug; resolve precise layout
  at the B1 mockup.)
- All seven `fileFocus.status` branches (loading/fallback/error/not-subscribed/no-changes/
  empty/ready) preserved.

### CSS (`HotspotsTab.module.css`)
- accordion item chrome (border/surface/hover/focus-visible) matching the rest of PR detail,
  both themes; level badge/dot; collapsed-row single-line ellipsis; expanded-panel padding on
  the `--s-*` scale.

### Slice 2 tests
- FE interaction: expand/collapse toggles panel; multi-open (open two, both stay open);
  default all-collapsed; keyboard toggle; `aria-expanded`/`aria-controls` wiring; collapsed
  preview is single-line stripped text; expanded renders markdown; deep-link still calls
  `requestFileView`.
- `stripMarkdown` unit tests (bullets/headings/emphasis/code/links → plain first line).
- **B1 visual gate**: Hotspots tab both themes, real tokens, live; regen the Hotspots
  baseline(s). Expect the two-cycle baseline tax (Windows-dev render, Linux-CI render).

## Risks & mitigations

- **Baseline tax (Slice 2):** layout change → Hotspots baseline regen across win32 + linux.
  Expected; follow the established regen flow (delete linux baseline → CI writes exact render →
  download artifact → commit; win32 local `--update-snapshots`).
- **Over-bulleting short PRs:** prompt says "concise, do not pad"; card chrome stays small;
  acceptable.
- **Deep-link affordance regression:** the row was a single button; splitting toggle vs open
  is the one real interaction-design risk — pin it at the B1 mockup and cover with an
  interaction test.
- **Live summary shape lag:** the full bulleted Live summary depends on the P0-1 Live
  summarizer, which now exists (`ClaudeCodeSummarizer`); the prompt edit lands its half now.

## Acceptance criteria (from #465 + #488)

- [ ] AI summary body renders GFM markdown via `MarkdownRenderer` with the (already-present)
      "AI Summary" header.
- [ ] Hunk annotation body renders markdown via `MarkdownRenderer` (compact popover).
- [ ] Hotspot rationale renders markdown in the **expanded** accordion view; collapsed preview
      is an unchanged-in-spirit plain truncated one-liner.
- [ ] Hotspots tab is a multi-open, default-collapsed accordion keeping High/Medium sections,
      with per-row level dot reusing the Files-tree monochrome-accent convention verbatim
      (High = accent + halo, Medium = accent at 0.6 opacity); deep-link-to-diff preserved.
- [ ] Summarizer, ranker, and annotator prompts instruct concise bulleted markdown.
- [ ] `Placeholder` summarizer/ranker/annotator emit bulleted markdown so Preview shows the shape.
- [ ] No raw-HTML/XSS regression; compact surfaces stay compact; both themes verified (B1 on
      the Hotspots layout change).
