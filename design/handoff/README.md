# Handoff: PRism

A focused, keyboard-first PR review tool for engineers who want to triage and review pull requests faster than they can in github.com. Local-first (talks to GitHub directly via a personal access token), single-app surface, AI-augmented but AI-optional.

## About these files

The HTML/CSS/JSX bundle in this folder is a **design reference**, not production code. It's an interactive prototype built with React via inline Babel transpilation — perfectly fine for design-review purposes, *not* what you ship.

Your job is to **recreate this UI in the target codebase's existing environment** (React + your component library, SwiftUI, Tauri + Svelte — whatever the real app uses) and lift the visual design / interaction model verbatim. If the project doesn't have a stack picked yet, React + Vite + a CSS-modules or Tailwind setup is a reasonable default for a desktop-leaning web app like this; for a true desktop app, Tauri lets you keep the same web stack while shipping a native binary.

Treat the HTML files as the **source of truth for visuals and behavior**. Treat the JSX as a structural sketch — the component breakdown is meaningful, but rebuild it idiomatically (proper state management, real GitHub API client, tests, etc.).

## Fidelity

**High-fidelity.** Final colors, typography, spacing, and interactions are settled. Tokens are defined in `tokens.css` using oklch — port these exactly. Layouts, hover states, keyboard shortcuts, and density variants are all real and worth matching pixel-for-pixel.

A few details that are intentionally **mocked, not designed**:
- Only PR `#1842` ("Refactor LeaseRenewalProcessor…") is deeply mocked with file tree, diffs, threads, and drafts. Other open PR tabs render a stub. In the real app, every tab gets the full PR Detail view.
- All data is hardcoded in `data.jsx` — no real GitHub fetching.
- The "Ask AI" drawer renders messages but doesn't actually hit a model.
- "AI summary," "AI validator," and "stale draft" features are designed surfaces but assume you'll wire them to whatever model/heuristic stack you choose.

---

## App Architecture

The app is one persistent SPA shell with three top-level views and a tabbed multi-PR system layered on top.

### Top chrome — two rows

**Row 1 — App nav** (always visible, height 56px, `--header-h`):
- Logo (left)
- Inbox tab + Setup tab (with unread count badge on Inbox)
- Spacer
- Global search ("Jump to PR or file… ⌘K") — passive search bar styling, ⌘K kbd hint
- "Ask AI" button (only shown when on a PR view AND `aiOn`)
- Keyboard shortcuts icon button (opens cheatsheet)
- User avatar

**Row 2 — PR tab strip** (only renders when ≥1 PR is open, height 36px, `--tabs-h`):
- Browser-style tabs with `#NNNN` num + truncated title + close `×`
- Active tab has top-edge accent, merges visually with page below (negative margin trick)
- Unread tabs show a small accent dot before the close button + bold title
- ⌘1–9 jumps to nth tab; ⌘W closes active; middle-click closes
- Overflow chevron menu kicks in past 6 tabs

### Three top-level views

1. **Inbox** (`view === "inbox"`) — the queue. Default landing.
2. **Setup** (`view === "setup"`) — first-run PAT entry.
3. **PR Detail** (`view === <prId>`, e.g. `1842`) — the actual review surface.

### State (in `app.jsx`)
- `view` — `"inbox"` | `"setup"` | a numeric PR id
- `openTabs` — array of PR ids currently open in the tab strip
- `unreadTabs` — Set of PR ids with new activity (cleared on focus)
- `overflowOpen` — chevron menu visibility
- Per-PR state: `verdict`, `submitOpen`, `chatOpen`, `activeIter`, `compareOpen`, `prTab`, `selectedFile`, `files`, `hasUpdate`
- `tweaks` — appearance/density/diff-mode/AI/accent settings, persisted to disk via the EDITMODE protocol (replace with localStorage in production)

---

## Screens

### 1. Inbox

Landing page. The queue of PRs sliced into sections.

**Layout:**
- Centered container, `max-width: 1480px`, padding `32px 24px`
- Top toolbar row: paste-PR-URL bar (grows to fill) + Filter button. The paste bar is a full-width input styled like the global search (icon left, `⌘K` kbd right) — this is the primary "open arbitrary PR" affordance.
- Two-column grid below `1180px` breakpoint:
  - **Main column** — sections of PR rows
  - **Right rail** (`280px` fixed, shown only ≥1180px) — Activity feed + Watching list

**Sections** (in order, defined in `data.jsx` `sectionsConfig`):
1. **Review requested** — `emphasized: true` (gets accent-tinted left edge on the section card)
2. **Awaiting author**
3. **Authored by me**
4. **Mentioned** — collapsed by default
5. **CI failing** — collapsed by default

Each section is a card (`--surface-1`, `--border-1`, `--radius-4`, `padding: 28px 24px`) with a collapsible header showing chevron + label + count.

Empty state: `<icon> Nothing here. You're caught up.` in muted text.

**PR row** — the meat. Single button-styled row, hover raises `--surface-2`:
- **Status dot** (8px) — danger red if CI failing; accent if unread > 0; invisible placeholder otherwise (preserves alignment)
- **Main column** — title (15px, weight 500) + meta row underneath (12px, muted): `<branch icon> mono(repo) · <avatar> author · iter N · 12m ago`
- **Tail** (right side, gap 12px):
  - Category chip (only when AI on) — "Refactor" / "Feature" / "Perf" / "Bug" / "Experiment", color-toned, sparkle icon
  - **Diff sparkline** — 60px-wide bar showing total PR size relative to the largest PR in the inbox; split green/red by additions vs deletions ratio. Calm, not loud.
  - +N additions / −N deletions (tabular nums, success/danger tinted)
  - Comments count + **unread badge** (small accent pill with count)

**Freshness accent** — rows where activity is < 30min old get a subtle 2px accent bar on the left edge. Don't animate it.

**Footer** — a calm info banner: "2 PRs hidden — your token doesn't cover platform/secrets or platform/audit. [Configure token scope]".

**Activity rail** (right column, ≥1180px only):
- "Activity" section, "last 24h" subtitle right-aligned
- Vertical timeline: avatar/icon column + connecting line + body column
  - Each item: `<avatar> who <verb> <pr-link> · time ago`
  - System events (`ci-bot`) get an alert icon instead of an avatar
- "Watching" section below: list of repos with unread counts or `idle`

**No hero panel.** Earlier iterations had one with a giant "3 PRs need your eyes" — it was removed. The page opens straight into the toolbar + queue. Don't add it back.

### 2. Setup

First-run PAT connection. Centered card layout on a `--surface-0` page with a faint accent radial-gradient wash behind it.

**Card** (`max-width: 520px`, `--surface-1`, `--radius-4`, padding `40px`):
1. Logo
2. H1 "Connect to GitHub" (24px, weight 600)
3. Sub-copy explaining local-first + token never leaves the machine
4. **Step 1** — numbered circle "1" + "Generate a token on GitHub"
   - External link button "Open the PAT page (fine-grained, repo-scoped)"
   - "Required scopes" row with three mono pills, each with a copy button: `repo`, `read:user`, `read:org`
5. **Step 2** — numbered circle "2" + "Paste it below"
   - Textarea with placeholder `ghp_… or github_pat_…`
   - Eye toggle (top-right of textarea) to mask/unmask
   - Inline error pill if validation fails (`< 10 chars` placeholder check)
6. **Continue** primary button, full-width-ish, with arrow icon. Shows spinner during 700ms validation simulation.
7. Fineprint with lock icon: "Stored in your OS keychain. Revoke anytime from GitHub settings."

### 3. PR Detail

The review surface. Three sub-tabs: **Overview**, **Files**, **Drafts**.

**PR Header** (slim, `--surface-1`, bottom border):
- Left: PR num (mono), title (truncate), branch info, author, iteration count
- Center: Overview / Files (N) / Drafts (N) tab strip
- Right: VerdictPicker (Comment / Approve / Request changes — segmented control with icon) + "Submit review" primary button (`⌘ ⏎` kbd hint inside button)

**Iteration tabs** (`--surface-2` strip below header, only on Files tab): All / iter 1 / iter 2 / iter 3 + Compare button. Active tab gets accent underline.

**Update banner** (when `hasUpdate`): info-tinted strip "amelia.cho pushed iter 3 just now — 2 of your drafts may need attention." with Reload + dismiss buttons.

**Overview tab**:
- AI summary card at top (when `aiOn`) — sparkle icon, label "AI summary", calm prose
- Quick-jump tiles: file count, draft count, thread count
- "Jump into Files" CTA

**Files tab** — the diff workhorse, two columns:

_File tree (left, `--tree-w` = 280px)_:
- Header: "Files · N/M viewed" + filter icon
- Thin progress bar showing viewed-fraction
- List of `FileTreeRow`s:
  - Viewed checkbox (left) — checks file off when clicked, separate from row click
  - Status badge (A/M/D/R, color-tinted)
  - Path: dir/ in muted, basename in `--text-1`
  - +N / −N counts (mono, tnum)
  - AI focus dot (only when `aiOn`) — high (red), med (amber), or absent

_Diff area (right, fills)_:
- Side-by-side OR Unified mode (`tweaks.diffMode`)
- Hunks separated by gray header rows showing `@@ -N,N +N,N @@` style line refs
- Inline syntax highlighting (calm — `--code-keyword`, `--code-string`, etc.)
- Line numbers in a left gutter, with `+` / `−` markers
- **Comment threads** anchor to lines:
  - Avatar, author, time, prose, replies
  - Resolved threads collapse to a single-line summary
  - "Reply" composer expands inline
- **AI hunk annotations** (when `aiOn`) — sparkle-iconed chips above hunks: "Reads cleaner — same behavior", "Heads-up: failure semantics changed"
- **New comment composer** drops in below the line on click

**Drafts tab** (when `tweaks.showStale`): grid of `StaleDraftPanel`s — each shows a draft comment that may have gone stale (the line moved, the file was deleted, etc.) with options to discard, resolve, or re-anchor.

### Submit Modal

Confirmation when user hits "Submit review". Verdict + auto-summary + comment counts. When AI is on, an AI validator card lists "Verdict matches comment severity ✓ / No drafts left in stale state ✓ / heads-up about partial-failure tests".

### Ask AI Drawer

Right-side slide-in panel. Chat surface scoped to the current PR — pre-baked example messages. Don't model it as a separate route; it's an overlay.

### Keyboard Cheatsheet

`?` toggles a centered overlay grouping shortcuts:
- **Navigation**: j/k file nav, gi/gp jump, ⌘K palette
- **Review**: c comment, v viewed, a approve, r request changes, ⌘⏎ submit
- **Diff view**: d toggle sbs/unified, w whitespace, [/] iteration nav
- **Help**: ? toggle, Esc close

---

## Tweaks (Settings)

Floating panel in bottom-right when toggled. Sections:
- **Appearance** — Theme (Light/Dark), Density (Comfortable/Compact), Accent (Indigo/Amber/Teal)
- **View** — Diff mode (Side-by-side/Unified)
- **AI augmentation** — Show v2 AI surfaces toggle, Show stale-draft panel toggle

In production, persist to localStorage. Match the keys defined in `TWEAK_DEFAULTS` (app.jsx).

---

## Design Tokens (from `tokens.css`)

All color values are oklch. **Port them as-is** — don't approximate to hex.

### Type
- Sans: **Geist** (400, 500, 600, 700) — Google Fonts
- Mono: **Geist Mono** (400, 500, 600)
- Sizes: `2xs 11 / xs 12 / sm 13 / base 14 / md 15 / lg 17 / xl 20 / 2xl 24 / 3xl 32`

### Spacing scale (4px base)
`--s-1: 4 · --s-2: 8 · --s-3: 12 · --s-4: 16 · --s-5: 20 · --s-6: 24 · --s-8: 32 · --s-10: 40 · --s-12: 48 · --s-16: 64`

> ⚠️ Note: there is **no `--s-7`**. The scale jumps 6 → 8. Don't reach for it.

In compact density: `--s-3` becomes 10px and `--s-4` becomes 14px.

### Radii
`--radius-1: 4 · --radius-2: 6 · --radius-3: 8 · --radius-4: 12`

### Easing & timing
- `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)`
- `--t-fast: 80ms`, `--t-med: 150ms`

### Density vars
- `--row-h: 32px` (24 in compact)
- `--header-h: 56px` (48 in compact)
- `--tabs-h: 40px` (36 in compact)
- `--tree-w: 280px`

### Color system

Built around the data-theme attribute on `<html>`. Both modes derive from one palette logic; only the surface/text scales flip. Accent is parameterized via `--accent-h` (hue) and `--accent-c` (chroma) so the three accent variants (Indigo h=245 c=0.085 / Amber h=75 c=0.10 / Teal h=195 c=0.075) all read the same generation rules.

**Light theme** uses slate-tinted near-whites, never `#fff`:
- Surfaces: `oklch(0.985 0.003 250)` → `oklch(1 0 0)` → `oklch(0.97 0.004 250)` → `oklch(0.945 0.005 250)`
- Borders: `0.91 / 0.87 / 0.78` lightness, chroma 0.005–0.008 hue 250
- Text: `0.20 / 0.42 / 0.58 / 0.70`

**Dark theme** uses slate-tinted near-blacks:
- See `tokens.css` lines ~120–200. Same shape, inverted lightness ramp.

**Semantic colors** (success/warning/danger/info) — each has a `-soft` background, base mid-tone, and `-fg` foreground for chip text.

**Diff-specific colors**: `--diff-add-bg`, `--diff-add-bg-strong`, `--diff-add-gutter`, `--diff-rem-*`, `--diff-line-num`. Light backgrounds for the line tint, stronger ones for inline word-level highlights, darker gutter pip for the `+`/`−` cell.

**Code colors**: `--code-fg / -keyword / -string / -number / -comment` — calm, never neon.

### Shadows
Defined in tokens but used sparingly — only on the floating Tweaks panel, modals, and the cheatsheet overlay.

---

## Interactions & Behavior

### Tab system
- Open a PR → push id to `openTabs` (if not present), set `view = id`
- Close → splice out, refocus left neighbor or fall back to inbox
- Middle-click closes
- Unread tracking: PRs marked unread on the inbox list also light up their tab if open. Cleared when focused.
- Overflow at >6 tabs spawns chevron `+ N more` menu

### Inbox row click
Opens that PR (creates tab if needed, focuses it). Currently no hover preview, but the diff sparkline + meta give enough at-a-glance info.

### File viewed
Click the checkbox cell → toggles viewed state, persists per-file. Triggers progress bar update. `v` keyboard does the same for the selected file.

### Diff selection → comment
`c` on a selection (or click in margin) opens inline composer. Composer is part of the line stream, not a popover. Submit appends to threads array.

### Verdict + Submit flow
1. Pick verdict (Comment default)
2. `⌘⏎` or click Submit → opens `SubmitModal`
3. Modal shows verdict + auto-summary + counts + (optional) AI validator
4. Confirm → "submits" (no-op in mock)

### Real-time update banner
When `hasUpdate` is true, the banner shows on both inbox and PR detail. Reload clears it. In production, this comes from a background poll or webhook.

---

## File Map

```
PRism.html             Entry — script tags for React/Babel + all .jsx
tokens.css             Design tokens (colors, type, spacing, radii)
screens.css            All component styles
app.jsx                Top-level App component, state, routing, keyboard
components.jsx         Logo, Icon, Avatar, VerdictPicker, kbd, banners
data.jsx               Mocked inbox data, PR files, threads, AI summaries
diff.jsx               DiffRow, hunk rendering, syntax highlighting
pr-detail.jsx          FileTree, PrHeader, IterationTabs, Overview, drafts
screens.jsx            InboxScreen, SetupScreen, SubmitModal, Cheatsheet
tweaks-panel.jsx       Tweaks panel framework (TweaksPanel, TweakRadio, etc.)

PRism canvas.html      Side-by-side variants of accent + type for review
```

`canvas.html` is for the design canvas comparison view — **not part of the app to recreate**, just kept for reference.

---

## Implementation Tips

- **Real GitHub client**: Octokit if web/Node. The PAT scopes the prototype lists (`repo`, `read:user`, `read:org`) are correct.
- **Unread/badge state**: track per-PR `last_read_at` against `updated_at` from the GitHub API. Persist in IndexedDB or local DB.
- **Diff rendering**: don't roll your own. Use `react-diff-view` or `diff2html`, then style the markup to match the design (line gutter, status pip, hunk header).
- **Syntax highlighting**: Shiki gives the best dark+light parity; the calm color choices in `--code-*` are roughly Shiki's "Vitesse" palette.
- **Keyboard system**: `react-hotkeys-hook` or just a `useEffect` like `app.jsx` does. Make sure inputs/textareas eat their own keys (`e.target.tagName === "TEXTAREA"` guard).
- **Tab persistence**: serialize `openTabs` + `view` to URL or localStorage so reload doesn't blow away open tabs.
- **AI surfaces**: every AI feature should be feature-flagged so the UI gracefully drops when off. Don't bake AI assumptions into core layouts.

---

## Don't

- Don't add a hero panel to the inbox. We tried it; it made the page feel empty and ceremonial.
- Don't introduce `--s-7`. Use `--s-6` (24) or `--s-8` (32).
- Don't replace oklch with hex approximations — the accent-rotation system depends on the parameterized hue.
- Don't render the right activity rail below 1180px. It's a luxury, not a load-bearing element.
- Don't use pure white (`#fff`) for surface-1 in light mode. The slate tint matters.
