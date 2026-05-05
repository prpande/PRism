# Claude Design Prompt — PRism UI/UX

This is the prompt to feed into Claude Design (or any visual-design AI agent) to generate the visual styling, component design, and interaction polish for PRism's UI. The functional architecture is already spec'd in `docs/spec/`; this prompt is purely about the *look and feel* on top of that architecture.

Copy the section below the `---` divider into Claude Design verbatim. The sections above the divider are notes for the human running the design agent.

---

## Notes for the human running this prompt

- **Read first:** `docs/spec/01-vision-and-acceptance.md` and `docs/spec/03-poc-features.md` give the functional context. The design agent should be able to refer to those if you provide them as attached files.
- **Iteration is expected:** generate, evaluate, refine. Don't take the first output as final. Use the `compound-engineering:design:design-iterator` skill if available.
- **Anchor to a small set of references:** the prompt below names specific products to draw from. Stay anchored to those rather than letting the agent invent unrelated aesthetics.
- **Critical constraints to enforce in every iteration:** AI slots render `null` in PoC and **do not reserve fixed placeholder height** — the slots collapse to 0px when hidden. **Layout will shift on v2 light-up** by the slot's natural rendered height (typically 60–120px for the PR-header summary card; smaller chips for inbox enrichment). Design the layouts assuming **slots are hidden by default**; specify how each slot would render at a sensible height when v2 enables it, but accept that enabling will reflow the page once. The "no layout shift" promise applies only to PoC's banner-arrival path. See `spec/04-ai-seam-architecture.md` § "Honest layout-reservation policy" for the full reasoning. (Earlier wording asked the designer to reserve space and design "with slots visible" — that conflicted with the seam doc; the seam doc wins.) Also: the banner-not-mutation principle; the file-by-file (not continuous-scroll) discipline; the truthful-by-default whitespace handling.

---

# Prompt to Claude Design

**Project:** PRism — a local web application for reviewing GitHub pull requests, designed to be visibly better than GitHub's native review UI for daily reviewer use. It runs on the reviewer's machine and connects to GitHub via the user's own personal access token. v2 will add Claude-powered AI augmentation; the PoC ships with all AI surfaces reserved but hidden.

**Audience:** Senior software engineers reviewing code daily. They are keyboard-first, attention-conscious, and tolerant of small learning curves in exchange for sustained productivity gains.

**Your job:** Design the visual style, component patterns, layout, color system, typography, and interaction details for this tool. Deliver:

1. A coherent visual language (color palette, typography scale, spacing/sizing system, iconography direction).
2. Layouts for the four primary screens (Setup, Inbox, PR Detail, Submit Confirmation) annotated with sizing and spacing.
3. Component-level designs for the recurring atoms (buttons, file rows, comment composer, banner, AI slot scaffolds).
4. Light-mode and dark-mode variants of all of the above.
5. A short style guide document covering "when to use what."

## Tone and aesthetic direction

The product is **calm, precise, deliberate.** Not playful. Not sterile. Code review is a focused-reading task; the UI should feel like a quiet workspace, not a notification stream.

- **Reference points (in order of relevance):**
  - **Linear** — typography, density, focus on the working surface, minimal chrome. The "this app respects my attention" feeling.
  - **Microsoft CodeFlow** (the internal Microsoft review tool) — file-by-file review experience, iteration tabs at the top.
  - **Azure DevOps PR review** — for the iteration tab UX specifically.
  - **GitHub** — only as a thing to *deliberately differ from*. The product is a critique of GitHub's review UI; identify what's wrong with GitHub's review surface and design corrections.
  - **VS Code's PR extension** — file tree + diff layout patterns.
  - **Raycast / Things 3** — for command palette / keyboard-driven feel (relevant for the keyboard shortcuts).

- **Avoid:**
  - Cartoonish illustrations or whimsical empty states.
  - Loud accent colors as default — accents are reserved for state (red for blocking errors, green for approve verdicts).
  - Slack/Discord-style "always-on activity feed" energy. This is a focused tool, not a chat surface.
  - GitHub-like density without GitHub's reasons (GitHub fits a lot of context per page because they have to). PRism can afford more breathing room.

## Functional constraints that shape the design

These are inviolable design constraints. The visual direction must respect all of them:

1. **AI slots are reserved in the component tree but hidden in the PoC** — they render `null` and consume zero pixels. The layout must look right when slots are hidden (the PoC ships with every slot hidden), and *acceptably* right when slots light up in v2 (some reflow at v2 light-up is expected; this is a one-time configuration change the user opts into, not a remote-driven change). The design must not reserve fixed placeholder height for slots — that wastes vertical space for the PoC users who are the only audience until v2 lights up. The slots are:

   | Slot | Surface | v2 component (per `04-ai-seam-architecture.md`) | PoC vs v2 |
   |---|---|---|---|
   | AI summary card | PR header (between title row and iteration tabs) | `<AiSummarySlot>` | **PoC: placeholder, renders 0px.** Design the card shape for v2 light-up. |
   | AI focus dot | File tree, right-aligned column | `<AiFileFocusBadges>` | **PoC: column collapsed.** Design the dot for v2. |
   | AI hunk annotation | Inline widget between code lines (same widget API as comment threads) | `<AiHunkAnnotation>` | **PoC: never inserted.** Design the v2 card style. |
   | AI chat drawer | Right-side drawer of PR view (slides in when activated) | `<AiChatDrawer>` | **v2-only full component.** PoC does not mount; design ships in v2. |
   | Repo-access modal | Top-level full-screen modal | `<RepoAccessRequestModal>` | **v2-only full component.** Surfaces lazily when the chat model calls `request_repo_access` (mid-conversation, not at chat-open). PoC does not mount. |
   | "Refine with AI ✨" button | Inside the comment composer toolbar | `<AiComposerAssistant>` | **PoC: button hidden.** Design the button + result panel for v2. |
   | AI draft suggestions | Collapsible panel above file tree or as a header section | `<AiDraftSuggestionsPanel>` | **PoC: hidden.** Design the panel for v2. |
   | AI suggestion badge | Per-stale-draft row in reconciliation panel | (slot inside reconciliation row) | **PoC: empty.** Design the badge for v2. |
   | AI validator results | Dedicated section inside submit confirmation modal | (slot inside submit modal) | **PoC: empty.** Design the result list + severity icons for v2. |
   | Inbox enrichment | Per-row category chip + hover-preview panel | (slots inside inbox row) | **PoC: empty.** Design the chip + hover preview for v2. |

   **Weight design effort accordingly.** Slots labeled "placeholder" are zero-pixel in PoC's shipped UI; their v2 design lands later (still useful to mock so v2 has a head start). Slots labeled "v2-only full component" (chat drawer + repo-access modal) are real v2 surfaces with no PoC counterpart — design them at v2-quality, but mark them as v2-deliverable in your output. The PoC release UX is fully understandable without any of these slots active.

   **Design the layouts with slots hidden by default** (the PoC shape), and separately mock what each slot looks like at a sensible rendered height when v2 enables it. The "no layout shift" promise applies only to PoC's banner-arrival path (remote state changes never push code under the user's cursor); v2 light-up is a one-time configuration reflow, not a banner event. See `spec/04-ai-seam-architecture.md` § "Honest layout-reservation policy" for the full reasoning.

2. **Banner-not-mutation refresh model.** When the PR or inbox has updates, a non-intrusive banner appears at the top of the relevant view with a Reload button. The view itself never reflows under the user's cursor. Design the banner: should be present and noticeable but not jarring or attention-stealing. Persistent until dismissed or Reload clicked.

3. **File-by-file diff view.** The diff area shows ONE file at a time, selected from an always-visible file tree on the left. No continuous scroll. `j`/`k` keyboard navigation between files. Selected file highlighted in the tree; "Viewed" checkbox per file in the tree.

4. **Iteration tabs at the top.** A horizontal strip just below the PR header: an "All changes" tab on the left, then up to 3 iteration tabs inline ("Iter 1", "Iter 2", "Iter 3"), then an "All iterations ▾" dropdown for older, then a "Compare ⇄" picker that lets the user pick any two iterations.

5. **Truthful diff display.** Whitespace changes are shown as-is — no filtering, no toggle. Side-by-side default, unified toggle. Word-level highlighting within changed lines.

6. **Atomic submit.** All draft state is local until the user clicks Submit Review. The submit confirmation dialog is a substantive moment — list what will be submitted (verdict, summary, count of comments / replies), show any AI validator output (in v2; empty in PoC), and a clear Confirm action.

7. **Stale-draft reconciliation.** When the user clicks Reload after a new commit, draft comments are auto-classified fresh / moved / stale. Stale drafts appear in a panel at the top of the PR view requiring user action before submit. Design this panel — it's a moment of mild stress; the design should reduce friction by making each item's options (Edit / Discard / Keep anyway / Show me) clear and quick to act on.

8. **Comment composer.** Markdown-supported. Per-line anchored. Save Draft / Discard / (in v2) Refine with AI buttons. Live-preview toggle.

9. **Mark-as-viewed per file.** Checkbox on each file row in the tree. When checked, the row is visually muted (still legible, but de-emphasized).

10. **Five inbox sections.** Review-requested, Awaiting-author, Authored-by-me, Mentioned, CI-failing. Each is collapsible with a count. Each section header should be visually distinct enough to scan but not heavy. PRs within a section are listed as rows with title, repo, author, age, comment count, unread badges (if applicable).

## Specific UI surfaces to design

### Surface 1: Setup screen

- One-time first-run.
- Centered card layout (~480px wide).
- Heading: "Connect to GitHub"
- Body: explain that the app needs a GitHub Personal Access Token. Link to GitHub's PAT generation page. List the exact scopes required in a copy-friendly format.
- A textarea for token paste.
- A "Continue" button. Disabled until something is in the textarea; loading state during validation.
- Inline error display below the textarea on failure.
- Background: subtle, not distracting. Brand-defining.

### Surface 2: Inbox

- Top: the "Paste PR URL" text input (full-width, prominent enough to find but not dominant).
- Below: the five sections, each collapsible.
- Each section header: section name, count, expand/collapse chevron.
- Each PR row: title (largest visual weight), repo + author + age (smaller meta), comment count + unread badges (right-aligned), category chip slot (PoC: empty), hover preview slot (PoC: empty).
- Banner appears at the very top when updates are available.
- Bottom: footer text *"Some PRs may be hidden — paste a PR URL above to access ones not in your inbox. [Configure token scope]"* if applicable. **No literal count is shown** — most hidden PRs are in orgs the API never reports, so any count would be a fraction of the actual hidden set and would mislead. Earlier wording promising "N PRs hidden — your token doesn't cover N repos" has been retracted; the design must not surface the count.
- Empty section state: muted single-line placeholder.

### Surface 3: PR Detail

- Top: header bar (sticky)
  - Left: PR title, breadcrumb to repo, author, branch info
  - Right: verdict picker (3 options), Submit button
- Below header: AI summary slot (non-sticky; PoC: hidden, 0px) — sits between the sticky header and the sticky iteration tabs; scrolls away under the iteration tabs when the user scrolls past it
- Below summary slot: iteration tabs strip (sticky)
- Below tabs: banner (appears when PR is updated)
- Main two-pane area:
  - Left pane: file tree (~280px wide, resizable)
  - Right pane: diff for selected file
- Inside the diff: existing comment threads as inline widgets, draft comments inline, AI hunk annotation slots (PoC: empty)
- Right edge: hint of the AI chat drawer (PoC: not mounted; in v2, slides in)

When viewing a `.md` file:
- Two-tab toggle above the diff: "Rendered" (default) | "Diff"
- "Rendered" mode: split pane, old rendered markdown left, new rendered markdown right
- "Diff" mode: standard code diff

### Global app footer

Persistent across the inbox and PR detail surfaces; sits below the main content area. Carries two affordances:

- A **"Replace token"** link that navigates to the Setup screen (re-prompts for a new PAT). This is the only auth-management UI in PoC; all other settings are file-only via `config.json`.
- A muted hint about the data directory: *"Drafts and state under `<dataDir>/`."* with the resolved path shown on hover so users know where their work lives. (Not interactive; informational.)

The footer is small (~28px tall), neutrally styled, and de-emphasized. Distinct from (and above) the inbox-only "Some PRs may be hidden" footer (Surface 2) — the inbox footer can sit just above this global footer when both apply.

### Surface 4: Submit Confirmation Modal

- Triggered by clicking Submit Review.
- Modal overlay with focus trap.
- **The PR-level summary textarea + live preview is the canvas of this dialog**, not a read-only excerpt below a separate composer. The user composes the summary inside the dialog with a markdown live preview alongside the textarea (same `react-markdown` pipeline as elsewhere). **Do not render a separate "summary excerpt with Show all expander"** — earlier wording referenced one, but the spec has retracted the excerpt mechanic now that the textarea lives in the dialog itself. A redundant truncated excerpt below the textarea would be noise.
- Below the textarea: verdict picker (re-confirmable here if not already set in the header, with severity icons), count of new threads (e.g., "3 new threads"), count of replies (e.g., "1 reply").
- AI validator results section (PoC: empty).
- "Cancel" and "Confirm Submit" buttons; Confirm Submit is the primary action.
- Confirm action triggers a brief loading state, then closes with success or shows error inline.

## Component-level design needs

Within the surfaces above, design these recurring components:

- **Buttons** — primary, secondary, destructive, icon-only. With hover, focus, disabled, loading states.
- **Banners** — info, warning, error variants. Dismissible. With actions.
- **Verdict picker** — three-state segmented control: Approve, Request Changes, Comment. Visual weight reflects severity (Approve subtle, Request Changes accent).
- **File row** — file path, status icon, line counts, AI focus slot, viewed checkbox.
- **Comment thread (existing)** — author avatar, body (markdown), timestamp, reply button.
- **Comment composer** — markdown body, preview toggle, action buttons, AI assistant button slot.
- **Stale-draft reconciliation row** — original comment text, severity badge (stale/moved/fresh), actions (Show me, Edit, Discard, Keep anyway), AI suggestion slot.
- **Iteration tab** — active vs inactive states, count of changed files within iteration (subtle).
- **Cheatsheet overlay** — triggered by `?`, lists keyboard shortcuts. Non-modal, dismissible by `?` again or `Esc`.
- **Empty states** — for empty inbox sections, empty PR (no diff yet), token expired.

## Color system

Design both light and dark modes from a single coherent palette. The two modes should feel like the same product, not two different products.

Required color roles:
- Surface (background) — multiple levels for layered UI
- Border (subtle structural)
- Text — primary, secondary, muted, disabled
- Accent — used sparingly, for primary action affordance
- Success (Approve verdict, fresh draft, viewed file)
- Warning (Moved draft, stale CI, "verdict needs reconfirm")
- Danger (Stale draft, blocking validators, Request Changes verdict)
- Info (banners, neutral signals)
- Diff added (a distinct green-ish for added lines)
- Diff removed (a distinct red-ish for removed lines)
- Diff word-level changed (subtle additional emphasis within a line)
- Code syntax highlighting — choose a Shiki-compatible theme for each mode (e.g., a calm light theme like `github-light` and a calm dark theme like `slack-dark` or similar)

Avoid pure black or pure white as the dominant background. Both modes should have a slight color cast that feels considered.

## Typography

- **Body / UI:** A neutral system-readable sans-serif (Inter, SF Pro, system-ui stack). Optimize for legibility at 14-15px.
- **Code / monospace:** A code-optimized monospace (JetBrains Mono, Fira Code, IBM Plex Mono, system-ui-monospace). Mind ligatures (probably default off for code review — exact-character recognition matters).
- **Type scale:** define 4-5 sizes, document each one's usage (e.g., "section header / row title / metadata / code body").
- **Line heights:** generous for body text (1.5-1.6), tighter for code (1.4).

## Spacing and density

The app has dense areas (file tree, diff, comment threads) and breathing areas (PR header, modals). Define a spacing scale (e.g., 4px base, then 8/12/16/24/32/48). Document where dense vs spacious applies.

## Iconography

Suggest an icon library (Lucide, Phosphor, Heroicons). Outlined style preferred for the calm aesthetic. List the specific icons needed for the surfaces above and their usage.

## Motion

Subtle. Deliberate. Avoid bouncy or playful animations.
- Banner slide-in: 150ms ease-out
- Modal entry: 100ms ease-out
- File selection in tree: instant; subtle 80ms color transition for highlight
- Hover state transitions: 80ms
- AI streaming text: token-level cursor blink (when v2 chat ships)

## Accessibility

Design must accommodate:
- Keyboard navigation (focus rings clearly visible)
- Color-blind variants of any color-coded UI (don't rely on color alone for state — pair with iconography or text)
- Screen reader landmarks (the design should make the page structure obvious enough to mark up correctly)
- WCAG AA minimum contrast for all text + state colors

## Deliverables

Please produce:

1. **A figma-style component library** (or its equivalent if you can't render Figma) covering all components listed above, in both light and dark modes.
2. **Annotated layouts** for the four primary surfaces showing component placement, spacing, and behavior at common viewport sizes.
3. **A style guide** (single document) covering: when to use each color role, when to use each type size, how AI slots show/hide, how the banner appears, focus-state conventions.
4. **Specific suggestions for any places where the functional spec leaves UX open** — e.g., where exactly does the "Refine with AI" button sit relative to "Save draft"? How does the chat drawer reveal itself?

Iterate at least twice. After your first pass, critique it against the constraints above and propose changes. Stop when you can't improve it without changing functional spec.

---

End of prompt.
