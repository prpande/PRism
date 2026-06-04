# PR-detail syntax highlighting: IDE-like code coloring in Overview and Files

**Topic:** Full-context syntax highlighting for all code surfaces in PR detail
**Tier:** T3 (multi-file frontend feature, several real design choices, net-new rendering path)
**Risk:** B1 UI-visual (`design` label) — pauses for a human visual assert after green-and-ready.

## Problem

Code in the PR-detail view renders as flat, uncolored monospace text:

- **Overview tab** — PR description, comments, and AI summary render through
  `MarkdownRenderer.tsx`. Fenced code blocks emit a bare `<code class="language-x">`
  with no token coloring.
- **Files tab diff** — `DiffPane.tsx` renders every code line as a raw
  `<span>{line.content}</span>`. `WordDiffOverlay` colors *changed words* (insert
  green / delete red) on paired lines, but nothing is syntax-aware.

Reviewers read code with none of the lexical cues an IDE provides (keywords,
strings, comments, types). This is a readability gap on the surface where the
product's whole value — reviewing code — actually happens.

Shiki (`^1.29.2`) is **already a dependency**, and `shikiInstance.ts` already
configures a highlighter with `github-dark` / `github-light` themes and a 14-language
list. It was scaffolded in S3 PR8 alongside the MarkdownRenderer and left dormant —
nothing consumes it today. This work activates and extends that scaffolding.

## Goal

IDE-like token coloring everywhere code appears in PR detail — Overview markdown
fences and the Files-tab diff (both unified and side-by-side) — with **proper
grammar context**, dual-theme (dark/light) support, and the existing word-diff
emphasis preserved.

## Non-goals

- No backend or API changes. Shiki runs client-side; the diff and whole-file
  content endpoints already supply everything tokenization needs.
- No new diff data shapes, no change to `DiffLine` parsing or hunk interleaving.
- No theme picker beyond the app's existing dark/light toggle.
- No highlighting of non-code surfaces (commit messages, plain comment prose).
- **WCAG 1.4.3 AA contrast of token colors *against diff-line backgrounds* is not
  guaranteed.** See "Contrast decision" below — this is an explicit, called-out
  limitation for the PoC, not an oversight.

## Key decisions (settled in brainstorming)

The brainstorm weighed alternatives at three forks; the chosen branch and the
alternatives it beat are recorded here so the spec is self-contained.

1. **Ambition: full-context highlighting on both surfaces.** Alternatives rejected:
   markdown-only (leaves the diff — the high-value surface — uncolored); a
   lightweight per-line diff pass (mis-colors multi-line constructs). Chosen: the
   IDE-like target on both surfaces.
2. **Diff context model: adaptive.** Alternatives rejected: *always-whole-file*
   (an extra content fetch on every file open, even in hunk mode); *hunk-only-always*
   (throws away whole-file context we already fetched). Chosen: **perfect context
   when the user has loaded whole-file mode; hunk-block context otherwise** — no new
   always-on fetches, and crucially highlighting works in the *default* hunk-only
   view rather than only after the user toggles whole-file.
3. **Word-diff composition: layer both.** Alternatives rejected: *syntax everywhere
   except changed lines* (changed lines — the review focus — would be the only
   uncolored code); *syntax on changed lines, drop word-diff* (loses word-level
   precision). Chosen: **token color = foreground, word-diff = background +
   line-through.** The two signals live on orthogonal CSS channels (see § Architecture
   §3 for the foreground-collision resolution this forces).
4. **Theming: Shiki dual-theme CSS variables**, keyed on the app's existing
   `html[data-theme="dark|light"]` (set by `applyTheme.ts`). Tokenize once; the theme
   toggle is pure CSS.

## Architecture

Frontend-only. Five units, each independently testable.

### 1. Highlighter core — extend `frontend/src/components/Markdown/shikiInstance.ts`

The async singleton highlighter stays. Add:

- **Lang list** — keep the existing 14 grammars and add exactly four more loaded
  **eagerly**: `sql`, `xml`, `dockerfile`, `toml`. No lazy `loadLanguage()` path
  (it would change `tokenizeLines` to async and complicate the fallback-until-ready
  pattern). The set is a static, compile-time list; the bundle delta is measured in
  PR1 and the four additions kept only if the added Shiki chunk stays within budget
  (recorded in the plan).
- **`pathToLang(path): ShikiLang | null`** — a pure lookup against a **static
  whitelist** (extension → grammar map, plus basename specials like `Dockerfile`).
  The input is trimmed and lowercased before lookup. Unknown/unsupported → `null` →
  plaintext. The same static map backs markdown fence-tag resolution (§5); a raw
  fence string is **never** passed to Shiki's API — only a whitelisted member or
  `null`.
- **`tokenizeLines(code, lang): LineToken[][]`** — wraps Shiki's **dual-theme**
  `codeToTokens` with **`defaultColor: false`** and `{ themes: { light:
  'github-light', dark: 'github-dark' } }`. With `defaultColor: false`, Shiki emits
  **no bare `color`** on each token and instead sets `--shiki-light` *and*
  `--shiki-dark` CSS custom properties — which is what makes the §4 class-level theme
  override work (an inline `color` would beat any class rule in the cascade). Each
  `LineToken` is `{ text: string, style: CSSProperties }`, where `style` is Shiki's
  `htmlStyle` **object** (e.g. `{ '--shiki-light': '#…', '--shiki-dark': '#…' }`) —
  **not** a string. Token offsets are **per-line** (Shiki tokenizes line-by-line; the
  merge in §3 relies on this). `lang === null` → one plaintext token per line (no
  color). As a defensive measure, `tokenizeLines` validates each emitted color value
  against a **strict hex allowlist** (`/^#[0-9a-fA-F]{3,8}$/` — the format the github
  themes actually emit) before placing it in the style object; a value that fails is
  dropped (that token renders with no color override). Functional notations, `url(...)`,
  and named keywords are rejected. Shiki output is trusted, but this closes a
  grammar-supply-chain edge cheaply.

### 2. Tokenization hook — `frontend/src/hooks/useSyntaxTokens.ts` (new)

Turns a file's content into two lookup maps:

```
oldLineTokens: Map<lineNumber, LineToken[]>
newLineTokens: Map<lineNumber, LineToken[]>
```

Adaptive context per decision 2:

- **Whole-file mode** (`wholeFileEnabled` and `useWholeFileContent` returned `ok`):
  tokenize `headContent` → `newLineTokens` indexed by line.
  - **Side-by-side:** `useWholeFileContent` also returns `baseContent`; tokenize it →
    `oldLineTokens`.
  - **Unified:** `useWholeFileContent` does **not** fetch `baseContent` when
    `!isSplit` (it returns empty). Delete (old-side) lines still render in unified
    whole-file mode via `interleaveWholeFile`/`parseHunkLines`, so `oldLineTokens`
    for those lines is built by the **hunk-block path below** (reconstruct the
    old-side text from the hunk body), not from `baseContent`. This is the one place
    the two modes interleave; without it, deleted lines in unified whole-file mode
    would fall back to plain while everything around them is colored.
- **Hunk-only mode**: for each hunk, reconstruct the old-side text (context + delete
  lines) and new-side text (context + insert lines) from the hunk body, tokenize each
  block, and write the per-line results back at the hunk's `oldStart` / `newStart`
  offsets. Diff line content is already `+`/`-`-prefix-stripped by `parseHunkLines`.
  Line endings are normalized to `\n` before tokenizing so CRLF-authored files
  (common in the .NET side of this repo) keep character indices aligned with the
  rendered line content.

**Inputs & memoization.** `path` (for `pathToLang`), the rendered `file`/hunks, and
the whole-file content + status. The memo key is `(path, side, sourceHash, mode,
headSha, baseSha)` where **`sourceHash` is a hash of the exact source string handed
to `tokenizeLines`** (the reconstructed block in hunk mode; the fetched
`headContent`/`baseContent` in whole-file mode) — not a hash of `file.hunks`. The
SHAs are included so a snapshot/force-push that swaps whole-file content at constant
`(path, side, mode)` invalidates the cache. Memoization prevents re-tokenizing on
scroll, comment-composer open, or unrelated re-render. Returns empty maps (→ fallback
rendering) until the async highlighter resolves, then re-renders with tokens.

**Boundary edge case (documented, accepted).** In hunk-only mode, a hunk that
*begins* inside an **open multi-line lexical construct** — a block comment, template
literal, multi-line/here-string — mis-colors its leading lines until the construct
closes, because the hunk body is tokenized as a standalone fragment without the lines
above it. This is specific to *multi-line lexical* constructs; ordinary
brace/paren/bracket imbalance does **not** mis-color for the common grammars (TextMate
grammars are stack/regex-based and mostly don't carry bracket nesting as multi-line
state; a few — e.g. Python bracket-continuation — carry limited extra state, still
uncommon and cosmetic). It is self-correcting and cosmetic. **Split** whole-file mode
has no such case (both sides have real whole-file context). The one exception is
**unified** whole-file mode's **delete (old-side)** lines: because `useWholeFileContent`
fetches no `baseContent` when `!isSplit`, those lines are tokenized via the hunk-block
path and therefore inherit the same bounded mis-color. This is the explicit, bounded
cost of decision 2, and is exercised by named visual tests (§Testing), including a
unified-whole-file delete line at a construct boundary.

### 3. Line rendering — `HighlightedLine` (new) + token-aware diff content

Replace the raw content spans in `DiffPane.tsx`:

- **Component contract.** `HighlightedLine({ tokens: LineToken[], fallback: string })`
  renders **a single wrapping `<span class="codeLine">`** containing one
  `<span class="codeToken" style={token.style}>` per token, each with the token text
  as a **React text child** (no `dangerouslySetInnerHTML` — the existing XSS-safe path
  is preserved). Empty `tokens` (highlighter not ready, or large-file guard tripped)
  → render `fallback` as a single plain `<span>` inside the wrapper.
  - **Single-child requirement (load-bearing).** The wrapper is mandatory because the
    split-mode locked horizontal scroll applies
    `transform: translateX(…)` to `.diffContent > *` (every *direct* child of the
    content cell). Today each line is one span, so the shift moves the line as a unit.
    Multiple bare token spans as direct children would each shift independently and
    desync the columns. The single `.codeLine` wrapper keeps exactly one direct child.
    **It must NOT be `display: contents`** — that dissolves the wrapper out of the box
    tree (no box → `translateX` no-ops *and* the token spans re-become the effective
    direct children, reintroducing the desync). In split scroll-mode the existing
    `.diffContent > *` rule already forces `display: inline-block` + `white-space: pre`
    + the transform onto whatever the single direct child is, so the wrapper inherits
    the unit-shift automatically; the new CSS must not override `display` on `.codeLine`.
    The inner `.codeToken` spans are *not* direct children of `.diffContent`, so they do
    not get that rule — they must inherit `white-space: pre` from the wrapper/cell and
    must not set `white-space` themselves (leading tabs / runs of spaces must survive in
    both render and clipboard copy).

- **Context / solo-insert / solo-delete lines** → `<HighlightedLine>` directly.

- **Paired lines → the merge (decision 3).** This is the one place syntax and
  word-diff collide, and there are two collisions to resolve:
  1. **Same-string alignment.** The merge must walk a *single authoritative
     index space*: `sideText` — the exact raw line string `tokenizeLines` tokenized for
     that side (old line content for the delete side, new for the insert side). Two
     hazards make the naïve approach wrong:
     - `diffWords(oldText, newText)` returns segments that **interleave both sides**
       (removed-only, added-only, unchanged), so its indices do not map to one side.
     - Worse, the `diff` package's `diffWords` **ignores/normalizes whitespace** — the
       concatenation of a side's `removed+unchanged` (or `added+unchanged`) segment
       *values* is **not byte-identical** to the raw line (a leading tab may render as
       spaces, internal runs collapse, trailing spaces drop), so reconstructing the
       side-string from `diffWords` output desyncs against the token offsets.

     Therefore the merged path uses **`diffWordsWithSpace(oldText, newText)`** (whitespace
     significant), for which the per-side `removed+unchanged` / `added+unchanged`
     concatenation **equals `sideText` exactly**. `mergeWordDiffWithTokens(sideText:
     string, tokens: LineToken[], wordDiffParts: Change[], side: 'old' | 'new'):
     MergedSpan[]` walks character indices over `sideText`, deriving each word-diff
     change range from the positional length of the side-relevant parts, splitting at
     the union of token and change boundaries, emitting `MergedSpan = { text, style,
     change?: 'insert' | 'delete' }`. (Consequence: whitespace-only reindents now
     register as word-diff changes on the highlighted path — acceptable, arguably more
     honest for code. The unhighlighted `WordDiffOverlay` fallback keeps `diffWords`
     unchanged.)
  2. **Foreground ownership.** `WordDiffOverlay.module.css`'s `.wordDiffInsert` /
     `.wordDiffDelete` set **both** a background **and** a foreground color
     (`--success-fg` / `--danger-fg`). On the merged path the **token color owns the
     foreground** (that is the whole point of syntax highlighting), so the merge uses
     **background-only** change classes — new `.wordDiffInsertBg` / `.wordDiffDeleteBg`
     (added to `WordDiffOverlay.module.css` alongside the existing classes and imported
     by the merged renderer) carrying only `background` + `border-radius`, plus
     `text-decoration: line-through` on the delete variant. The original full classes
     are retained unchanged for the **non-highlighted fallback path** (`WordDiffOverlay`
     when no tokens). So a changed
     keyword keeps its syntax color *and* gets the change background; the delete still
     reads as struck-through.

`WordDiffOverlay`'s fate is **decided, not open**: it is retained as the no-tokens
fallback for paired lines (highlighter not ready / large-file guard / `lang === null`)
and is **superseded by `mergeWordDiffWithTokens` at all paired-line call sites when
tokens are available** — both the unified `DiffLineRow` path and the split
`SplitDiffLineRow kind='paired'` path. It is not deleted.

### 4. Theming — dual-theme CSS variables

With `defaultColor: false` (§1), each `.codeToken` span carries only
`--shiki-light` and `--shiki-dark` custom properties and **no inline `color`**, so a
class rule wins the cascade:

```css
.codeToken { color: var(--shiki-light); }                  /* light is the default */
html[data-theme='dark'] .codeToken { color: var(--shiki-dark); }
```

One tokenization serves both themes; the toggle is pure CSS, no re-tokenization. The
`.codeToken` class is mandatory on every token span for this selector to match.

**Contrast decision (called out).** GitHub's `github-light`/`github-dark` palettes
are deliberately muted, but token colors are tuned for GitHub's neutral code
background, not for this app's **saturated** diff-line backgrounds (post-#124,
`--diff-add-bg` / `--diff-rem-bg` are saturated at light-L≈0.96). A low-chroma token
(e.g. the comment gray) on a saturated insert background can fall **below WCAG 1.4.3
AA** for small text. For the PoC we **accept the stock palettes as-is** and treat
AA-on-diff-background as a non-goal (above), rather than build a post-tokenize
color-clipping pass (gold-plating for a single-user PoC). The B1 human visual-assert
gate evaluates whether this is acceptable in practice; if it is not, the documented
follow-up is a comment-token contrast clip, tracked separately. This decision is
revisitable but is made *now* so PR1/PR2 don't ship an unbounded surprise.

### 5. Overview markdown — wire the highlighter into `MarkdownRenderer.tsx`

The `code` component's fenced-block branch (currently emits bare
`<code class="language-x">`) resolves the fence info string through the **same static
whitelist** as `pathToLang` (§1), then renders via `tokenizeLines` + `HighlightedLine`
— **the same token render path as the diff**, not Shiki's `codeToHtml`, so there is
exactly one sanitization-safe rendering path to reason about. Before the highlighter
resolves, the `code` component returns the **existing bare `<code class="language-x">`
node unchanged** (current production behavior); on resolve it re-renders via
`HighlightedLine`. This preserves the current DOM during the async window with no
loading flash and keeps the security test's pre-resolve shape stable. `mermaid` fences
keep their existing `MermaidBlock` branch.

White-space is supplied by each container, not by `HighlightedLine`: the diff cell uses
`white-space: pre` (h-scroll), `.markdown-body pre` uses `pre-wrap` (wrap) — **both
preserve** tabs and space-runs, so the shared `HighlightedLine` renders correctly in
both as long as `.codeToken` never sets `white-space`. No reset is needed.

The markdown change touches **every** `MarkdownRenderer` consumer
(`ComposerMarkdownPreview`, `MarkdownFileView`, conversation/description), not only the
Overview tab. **All consumers receive highlighting; there is no per-consumer opt-out**
(none is anticipated). The plan enumerates them so the visual pass covers each surface.

### Guards

- **Large-file cap**: **2,000 lines or 200 KB** of source for a side (fixed
  constants, not "approximately" — these gate PR2's shippable visual state and must
  not drift between PRs). Above either, skip tokenization and render plain. The guard
  lives in `useSyntaxTokens` (it owns the source string). When tripped, the DiffPane
  header shows a muted "Syntax highlighting off (large file)" indicator in the **single
  right-aligned status slot** the header already uses for `.diffPaneLoading` (the two
  are mutually exclusive — one `margin-left:auto` status element, conditional text — so
  they never fight for layout) so plain rendering reads as intentional, not broken.
- **Per-line length cap**: any single line over **2,000 characters** is emitted as
  one plaintext token rather than tokenized, bounding worst-case grammar backtracking
  on pathological attacker-controlled lines (the file-level cap alone does not catch a
  within-limits file made of a few very long lines). A capped line that is also a
  *paired* line still passes through `mergeWordDiffWithTokens` for its word-diff
  background — it simply carries one plaintext token instead of colored ones.
- **Tokenization time**: the input-size caps above (200 KB / 2,000 lines / 2,000
  chars-per-line) are the **sole** bound on tokenization cost. No wall-clock budget is
  added: `codeToTokens` is synchronous and cannot be interrupted without moving Shiki
  to a Web Worker, which is out of scope for the PoC. This is an explicit, accepted
  decision — the single-user threat model (reviewing one's own fetched PRs) makes the
  size caps adequate; a Worker-based time budget is the documented escalation if real
  hangs appear.
- **Unknown / unsupported language** → plaintext fallback (no error, no color).
- **Highlighter not yet loaded** → plain fallback, then upgrade on resolve. The
  plain→highlighted upgrade flash is **accepted**: Shiki is already a dependency and
  the highlighter is warm after first use within a session, so the window is a brief
  first-load recolor, not a per-navigation flash. No masking/hold is added.

## Data flow

```
path ─► pathToLang ─► lang
file/hunks + useWholeFileContent ─► useSyntaxTokens ─► {oldLineTokens, newLineTokens}
                                                              │
DiffPane row (side, lineNumber) ──────────────────────────────┤
   context/solo ─► HighlightedLine(tokens)                     │
   paired ─► mergeWordDiffWithTokens(sideText, tokens, filtered diffWords, side) ─► spans
                 (no tokens → WordDiffOverlay fallback)

Markdown:  fence(info) ─► whitelist lang resolution ─► tokenizeLines ─► HighlightedLine
```

## Testing

- **Unit**
  - `pathToLang`: representative extensions + basename specials + unknown → null;
    trim/lowercase normalization.
  - `tokenizeLines`: dual-theme token shape (object `style` with `--shiki-light` /
    `--shiki-dark`, no bare `color`); plaintext fallback for `null` lang; per-line
    length cap emits a single token; color-value validation.
  - `useSyntaxTokens`: correct line→token maps in whole-file split, whole-file
    unified (old-side via hunk reconstruction), and hunk-only modes; hunk-offset
    mapping; CRLF normalization; SHA-keyed cache invalidation; empty maps before
    highlighter resolves; large-file guard returns fallback at the fixed thresholds.
  - **`mergeWordDiffWithTokens` (critical)**: `sideText` is the index authority via
    `diffWordsWithSpace`; per-side derivation (removed+unchanged vs added+unchanged);
    token and word-diff boundaries that are adjacent, overlapping, coincident, disjoint;
    a changed word spanning two tokens; a token spanning two change ranges; full-line
    change; no change; **old/new sides differing in whitespace** (leading tab vs spaces,
    collapsed internal runs, trailing spaces) with token offsets asserted still aligned
    — the case the round-1 reconstruction approach silently broke; a capped paired line
    (one plaintext token) still gets word-diff background.
- **Component**
  - DiffPane renders highlighted token spans wrapped in a single `.codeLine` child
    for context/solo lines (asserts the single-child invariant the locked scroll
    depends on).
  - Paired line shows a token color **and** a background-only change class (no
    foreground override); delete keeps line-through.
  - Unknown-extension file falls back to plain, no crash.
  - Markdown fenced block highlights; unknown fence lang falls back; mermaid
    unaffected.
- **Security**: **create** `MarkdownRenderer` sanitization tests (the
  `MarkdownRendererSecurity.test.tsx` the prior testing note assumed does **not**
  exist) in **PR1** — confirm the token path renders text nodes only and a malicious
  code payload (script tags, entity sequences) in a fenced block or a diff line cannot
  inject markup. Include a hunk-reconstruction case with adversarial line content.
- **Accessibility**: an axe-core check that a highlighted diff line and a highlighted
  markdown block introduce no new ARIA violations (the multi-span line must still
  expose its text cleanly to AT).
- **Visual (Playwright, real app — BFF repo PR per the real-data convention)**:
  dark + light; a paired changed line (syntax + background-only word-diff layered); a
  multi-line construct crossing a hunk edge (documents the decision-2 edge case); a
  **unified whole-file delete line at a construct boundary** (documents the old-side
  exception); an unknown-extension file (clean fallback); a large file (guard indicator
  visible).
  Screenshots embedded in the PR per the B1 visual-verification convention.

## PR decomposition

Two PRs. The earlier draft's three-way split was reseamed: splitting the diff work at
"context/solo lines first, paired lines later" would ship an intermediate state where
the *changed* lines — the review focus — render **less** colored than the context
around them, a visible regression. So the diff surface lands as one PR covering all
line types; the merge function is unit-tested independently before its integration.

- **PR1 — Highlighter core + Overview markdown + security baseline.** `pathToLang`
  (static whitelist), `tokenizeLines` (`defaultColor: false`), `HighlightedLine`,
  dual-theme CSS, `MarkdownRenderer` wiring, and the created `MarkdownRendererSecurity`
  tests. Ships visible value immediately, proves the whole core on the simpler surface,
  and establishes the security baseline before any untrusted-content path goes live.
  *(PR1 optimizes for risk-retirement, not value-ordering — the higher-value diff
  surface lands in PR2. Acceptable because both PRs are committed; called out so the
  ordering is a choice, not an accident.)*
- **PR2 — Diff highlighting, all line types.** `useSyntaxTokens` (adaptive whole-file
  split / whole-file unified / hunk-block), `DiffPane` integration for context, solo,
  **and paired** lines via `mergeWordDiffWithTokens`, the large-file + per-line guards
  and the header indicator. If PR2 is too large to review, sub-split on a file
  boundary — PR2a = `useSyntaxTokens` + `HighlightedLine` + `mergeWordDiffWithTokens`
  (unit-tested, no DiffPane wiring); PR2b = DiffPane integration for all line types at
  once — never along the context-vs-paired seam.

## Open questions for the plan

- Measured Shiki bundle delta from the four added grammars vs budget (decides whether
  all four stay eager). If over budget, drop order is `xml` → `toml` → `sql` →
  `dockerfile` (least-to-most likely in this repo's reviews).
- Exact `sourceHash` function — must be **synchronous** (so `useSyntaxTokens` stays
  synchronous; rules out `SubtleCrypto`) and a cheap non-cryptographic stable hash
  (e.g. FNV-1a / djb2 over the source string). Collision resistance is a non-issue: the
  key also carries `path` + `headSha` + `baseSha`, which already content-address the
  source.
