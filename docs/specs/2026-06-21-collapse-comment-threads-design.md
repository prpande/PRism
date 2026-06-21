# Collapse inline comment threads in the diff view — Design (#569)

**Goal:** Let a reviewer collapse an inline review-comment thread in the Files/diff view to a single summary line to reclaim vertical space, and **auto-collapse resolved threads by default** so attention stays on open threads — keeping any collapsed thread one keystroke from full context via the collapsed line's snippet + comment count.

**On the default (premise, owner-decided):** resolved threads collapse by default because it matches GitHub's resolved-conversation convention and a resolved thread is usually settled. We deliberately do **not** claim "resolved == the current viewer addressed it" — `ReviewThreadDto` carries no resolver identity (see Non-goals), so resolver-aware collapse isn't buildable without a wire change. The justification is the cheaper, honest one: resolved is the available "probably-settled" signal, and the snippet + count + one-keystroke expand make the hidden content one action away. The risk that a first-time reviewer wants to *read* others' resolved threads is mitigated by that one-action expand, not eliminated; the collapsed line must therefore be genuinely informative (Variant A) and visually distinct (so it's noticed while scrolling).

**Architecture:** A per-thread disclosure in `ThreadView` (inside `ExistingCommentWidget`). Collapsed/expanded is derived from a tab-lifetime override map owned by `FilesTab` and threaded down through `DiffPane` as a small controller, alongside the existing `replyContext`. The default is computed from `thread.isResolved`, so the map holds only explicit user toggles and resets to defaults when the PR tab unmounts.

**Tech stack:** React + Vite + TypeScript, CSS Modules. No backend / no wire change (`ReviewThreadDto` is unchanged).

## Global constraints

- Reuse the centered column from #522: the collapsed line and the disclosure header live inside the existing `.commentWidget` wrapper, which is already `width: min(80%, var(--pr-detail-content-max))` + `margin-inline: auto`. The feature adds **no** new width/centering rule.
- Reuse existing primitives rather than re-implementing: the `Avatar` component (`size="sm"`), the `stripMarkdown` helper for the snippet (see §5), and a single shared badge class for the count pill + Resolved badge (see §3 — extract, do not mirror).
- Feature stays in diff scope (`ExistingCommentWidget` / `FilesTab` / `DiffPane`). Overview/Hotspots and the `CommentCard` body are untouched.
- A11y is first-class (§4): a real disclosure `<button>` with `aria-expanded`, keyboard-operable, reduced-motion-aware. This `aria-expanded` disclosure is the **go-forward collapse idiom** for the app; `FileTree`'s existing CSS-only collapse (no `aria-expanded`) is the legacy exception, not a second sanctioned pattern.

## Background / problem

After #522 (PR #568) widened and centered inline comment threads, **threads still consume vertical space even once settled**. A reviewer scanning a diff scrolls past conversations that are resolved. The fix: collapse a whole thread block to one line, defaulting resolved threads to collapsed.

Today (`ExistingCommentWidget.tsx`):
- `ExistingCommentWidget({ threads, replyContext })` → `.comment-widget` wrapper → one `ThreadView` per thread (`key={thread.threadId}`).
- `ThreadView` renders, inside `.comment-thread` (+ `comment-thread--resolved`, `data-thread-id`): the thread's `CommentCard`s (`density="comfortable"`), optimistic placeholder cards, and the reply affordance / `ReplyComposer`. The "Resolved" badge is the first card's `bandEnd` slot (`<span aria-label="Resolved thread">Resolved</span>`).

## Design

### 1. Collapse-state model (tab-lifetime overrides)

State lives in **`FilesTab`** — verified kept-alive: `PrDetailView` mounts `<FilesTab/>` once per PR and only toggles `hidden` on sub-tab switch (`PrDetailView.tsx`), and `FilesTab` keeps `selectedPath` as state across file switches without remounting (`FilesTab.tsx`). So a `useState` map there has true tab-lifetime: survives file switches and sub-tab switches within the open PR tab, and is discarded when the PR tab closes.

```ts
// In FilesTab
const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
// effective state: explicit override wins; otherwise resolved → collapsed, unresolved → expanded
const isThreadCollapsed = useCallback(
  (threadId: string, isResolved: boolean) => collapseOverrides[threadId] ?? isResolved,
  [collapseOverrides],
);
const toggleThreadCollapsed = useCallback(
  (threadId: string, isResolved: boolean) =>
    setCollapseOverrides((m) => ({ ...m, [threadId]: !(m[threadId] ?? isResolved) })),
  [],
);
```

- **Only explicit toggles are stored.** Default derives from `isResolved` at render time, so newly-loaded threads get the right default automatically and an empty map === the documented reset state. No seeding pass, no load effect mutating the map.
- **Key = `threadId`** — the GraphQL relay node id (`PullRequestReviewThread.id`), a durable global id, not a per-fetch ephemeral. Stable as the React key and `data-thread-id`.
- **No GC needed, and that's safe:** the map is bounded by how many threads the user manually toggled in one tab lifetime (tens, not thousands). An entry for a server-deleted thread is simply never re-read and is discarded on unmount.
- **Optimistic new-inline comments don't participate:** a freshly-posted new-inline comment is an optimistic placeholder with `threadId: null`, rendered outside `ThreadView` via `renderComposerForLine` (`FilesTab.tsx`), so it never reaches `isThreadCollapsed`. On refetch it becomes a real, **unresolved** thread → defaults to **expanded** (you just wrote it, you see it). No special-casing.
- **Reset semantics fall out for free:** closing the PR tab unmounts `FilesTab`, discarding the map; reopening starts `{}` → resolved collapsed, unresolved expanded. No `localStorage`.

Override stickiness vs. a moving default, and new-activity-while-collapsed, are specified in **§7 (State interactions)** — they are spec decisions, not implementer discretion.

A small controller is passed down (symmetric with `replyContext`):

```ts
export interface ThreadCollapseControl {
  isCollapsed: (threadId: string, isResolved: boolean) => boolean;
  toggle: (threadId: string, isResolved: boolean) => void;
}
```

`FilesTab` builds it and passes it to `DiffPane`; `DiffPane` forwards it to every `ExistingCommentWidget` (both the unified and split emission paths already forward `replyContext`; add `collapse` beside it). It is **optional** on `ExistingCommentWidget`/`DiffPane`: when absent, threads render fully expanded — preserving current behavior and existing tests.

### 2. `ThreadView` renders a disclosure

`ThreadView` computes `collapsed = collapse?.isCollapsed(thread.threadId, thread.isResolved) ?? false` and renders a persistent `ThreadDisclosureHeader` (the toggle) plus the thread body only when expanded:

```tsx
const collapsed = collapse?.isCollapsed(thread.threadId, thread.isResolved) ?? false;
const bodyId = `thread-body-${thread.threadId}`;
const first = thread.comments[0]; // may be undefined — guard (see below)
return (
  <div className={…} data-thread-id={thread.threadId}>
    <ThreadDisclosureHeader
      collapsed={collapsed}
      bodyId={bodyId}
      onToggle={() => collapse?.toggle(thread.threadId, thread.isResolved)}
      author={first?.author}
      avatarUrl={first?.avatarUrl}
      snippet={collapsed ? snippetFor(first) : undefined}   // computed only when collapsed
      commentCount={thread.comments.length}
      isResolved={thread.isResolved}
      filePath={thread.filePath}
      lineNumber={thread.lineNumber}
    />
    {!collapsed && (
      <div id={bodyId}>{/* existing CommentCards + optimistic cards + reply affordance/composer */}</div>
    )}
  </div>
);
```

- **Collapsed line (Variant A, the approved mockup):** `▸  [Avatar sm]  author · "snippet…" · N comments · ✓ Resolved`.
- **Expanded header (O2 — RESOLVED to the minimal form):** `▾  · ✓ Resolved` only — **no author/snippet/count when expanded**, because the cards below already carry author + bodies and repeating them produces visible duplication and a screen-reader echo (button `aria-label` immediately followed by the first card's author). The chevron + Resolved badge are the consistent toggle affordance. *(If the live pass shows this expanded header reads as too bare, the fallback is to add the count pill back — but not author/snippet.)*
- The **Resolved badge moves** from the first card's `bandEnd` to the disclosure header (it now describes the whole thread). The first `CommentCard` passes `bandEnd={undefined}`. The single `aria-label="Resolved thread"` element is preserved, relocated to the header — update any card-scoped test selector to the header.
- `filePath`/`lineNumber` come from the thread (`ReviewThreadDto.filePath`, `.lineNumber`); `author`/`avatarUrl`/`snippet` derive from `thread.comments[0]` (guarded — see §3 empty case).

### 3. New component: `ThreadDisclosureHeader`

Create `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.tsx` (+ `.module.css`) so `ExistingCommentWidget.tsx` stays focused.

Props: `{ collapsed, onToggle, bodyId, author?, avatarUrl?, snippet?, commentCount, isResolved, filePath, lineNumber }`. (`onToggle` is the header's callback; `ThreadView` wires it to `collapse.toggle` — §2.)

- Renders `<button type="button">` with `aria-expanded={!collapsed}`, `aria-controls={bodyId}`, and `aria-label={`${collapsed ? 'Expand' : 'Collapse'} thread on ${filePath} line ${lineNumber}`}` (self-describing without relying on the truncated snippet).
- **Layout** (flex row, `gap: var(--s-2)`, `font-family: var(--font-sans)`, `font-size: var(--text-sm)`, `cursor: pointer`):
  - chevron (inline SVG) · `<Avatar src={avatarUrl} login={author ?? ''} size="sm" />` · author · snippet · count pill · Resolved badge.
  - **author:** `--text-1`, weight 600, `max-width: 14ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0` (a long display name truncates rather than pushing the snippet off-row).
  - **snippet** (collapsed only): `--text-3`, `flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`, plus `title={fullSnippet}` so mouse users can read the untruncated text without expanding.
  - **count pill:** `1 comment` (singular) / `N comments` (N ≥ 2); **omit entirely when `commentCount === 0`**.
  - **Resolved badge:** shown when `isResolved`; the `aria-label="Resolved thread"` element.
- **Empty / image-only first comment:** if `thread.comments` is empty (`first` undefined) or `snippetFor(first)` strips to empty text (image-only or whitespace body), **omit the snippet slot entirely** — the row reads `▸ avatar? · author? · N comments · Resolved` with no dangling separator. Avatar/author render only when `first` exists.
- **Chevron:** inline SVG (no chevron component exists; matches the inline-SVG pattern at `DiffPane.tsx`). Rotated via CSS `transform: rotate(...)` keyed on `[aria-expanded]`, the rotation behind `@media (prefers-reduced-motion: no-preference)` (instant under reduced-motion).
- **Surface + interaction states:** the header sits on the thread surface `var(--surface-2)` (matching `.comment-thread`/`.diffCommentRow`). Hover: elevate to `var(--surface-3)` — this hover, plus `cursor:pointer`, is the discoverability signal that the whole row is interactive (do not rely on the chevron alone). `:focus-visible`: a 2px accent outline with 2px offset, consistent with other `PrDetail` buttons; confirm the `.commentWidget` wrapper does not clip the ring (no `overflow:hidden` that hides it). No special `active` state.
- **Shared badge styling:** the count pill and Resolved badge currently exist only as `CommentCard.module.css .bandEnd` (CSS-Module-scoped, unreachable from a sibling module). **Extract** that recipe once into a shared class (e.g. a `metaPill` class in a small shared stylesheet, or a tiny `Badge` component) consumed by both `CommentCard` and `ThreadDisclosureHeader`. Do **not** mirror the five declarations.
- `data-testid="thread-disclosure"` on the button; `data-collapsed={collapsed}` for assertions.

### 4. Accessibility

- Disclosure is a `<button>` (focusable, Enter/Space activate), `aria-expanded` reflecting state, `aria-controls` → the body region's `id` (`thread-body-${threadId}`).
- Chevron rotation gated on `prefers-reduced-motion: no-preference`. The thread body mounts/unmounts with **no** CSS height/opacity transition; if a future pass adds one, it must be gated identically.
- Focus stays on the header button across toggles. Body collapse is only ever triggered by the disclosure button itself, so the focused element is the button at the moment of collapse — no focus drop. *(If a future "collapse all" control is added, it must move focus to each disclosure header before unmounting its body.)*

### 5. Snippet derivation

**Reuse the existing `stripMarkdown` helper** — `frontend/src/components/PrDetail/HotspotsTab/stripMarkdown.ts` already does exactly what's needed (first non-empty line; strips leading `#`/`>`/`-`/bullet markers, link/image syntax, emphasis/inline-code; collapses to one line). Do not write a new helper. If importing across feature folders is undesirable, **promote it to a shared location** (e.g. `frontend/src/utils/stripMarkdown.ts`) and update the Hotspots import in the same change. Defensively cap its output (e.g. first ~200 chars) before handing it to the DOM; visual truncation is CSS (ellipsis). The snippet is only computed in the collapsed branch (§2), so there is no eager/expanded-state cost.

If the stripped result is empty (image-only/whitespace first comment), the snippet slot is omitted (§3).

### 6. Default state & scope

- **Default:** unresolved → expanded, resolved → collapsed (from `isResolved`, §1).
- **Scope:** existing comment threads only. The standalone new-comment composer row (a separate `<tr>` in `DiffPane`, not inside `.commentWidget`) is untouched. Overview tab untouched.

## 7. State interactions & edge cases (spec decisions)

The override map is sticky for the tab lifetime; the default underneath it can move (a refetch flips `isResolved`, or new comments arrive). Chosen behavior for each interaction:

- **User expands a resolved thread (`override=false`); it stays resolved.** Stays expanded. Intentional — the user explicitly asked to see it. Overrides are **not** invalidated when `isResolved` changes; there is no effect that clears them on resolution-change.
- **User collapses an unresolved thread (`override=true`); it later resolves.** Stays collapsed (override and default now agree). Fine.
- **User expands a resolved thread; it later un-resolves (a reply reopens it).** Stays expanded (override `false`). Fine — matches the new default anyway.
- **New reply arrives on a collapsed thread (the watch-out).** The thread stays collapsed (we do not yank the user's collapse open). The **count pill is the new-activity signal** (it increments). The snippet remains the **first** comment — deliberately, because the first comment is the thread's subject/identity, not its latest line. **Known v1 limitation:** a new reply to a collapsed thread is not otherwise surfaced. A "+N new since collapsed" marker (which needs per-thread "count at collapse time" state) is a **deferred follow-up**, not v1. Flagged for owner sign-off — if this matters for the common resolved-thread-gets-a-reply case, pull the marker into v1.

## Components & boundaries

- **`FilesTab.tsx`** — owns `collapseOverrides` + `isThreadCollapsed`/`toggleThreadCollapsed`; builds `ThreadCollapseControl`, passes it to `DiffPane` (beside `replyContext`).
- **`DiffPane.tsx`** — accepts optional `collapse?: ThreadCollapseControl`; forwards it to `ExistingCommentWidget` in **both** the unified path (via `DiffLineRow`) and the split path (via `emitWidgetAndComposerRows`).
- **`ExistingCommentWidget.tsx`** — `ExistingCommentWidgetProps` gains `collapse?: ThreadCollapseControl`; `ThreadView` computes `collapsed`, renders `ThreadDisclosureHeader` + conditional body; relocates the Resolved badge.
- **`ThreadDisclosureHeader.tsx` + `.module.css`** *(new)* — §3.
- **Shared badge** — extract the `.bandEnd` recipe to a shared class/component used by `CommentCard` + `ThreadDisclosureHeader` (§3).
- **`stripMarkdown`** — reuse (import or promote to shared, §5).
- **No change** to `ReviewThreadDto`/`ReviewCommentDto`, backend, or wire.

## Non-goals

- **Resolver-aware collapse** ("collapse threads *I* resolved/addressed") — `ReviewThreadDto` has no `resolvedBy`/viewer-relative field; this is a deliberate non-goal gated on a future wire change. The default is `isResolved`, knowingly a proxy.
- Composer collapsing; `localStorage`/cross-session persistence; per-comment (vs per-thread) collapse; a "collapse all / expand all" control; a per-file "N resolved hidden" indicator (see Open questions O3) — all possible follow-ups.

## Open questions (resolve in planning/implementation or live pass)

- **O1 — state home.** `FilesTab` keep-alive verified against the code, so the `FilesTab` home holds and the `PrDetailView`/`prDetailContext` lift is a genuine fallback only. The persistence test (below) is still the gate.
- **O2 — expanded header — RESOLVED.** Expanded header shows `▾ + Resolved badge` only (no author/snippet/count), to avoid duplicating the cards below and the screen-reader echo. Validate in the live pass; fallback is count-pill-back-only.
- **O3 — hidden-resolved discoverability.** Auto-collapsing resolved threads gives no at-load count of how many exist. v1 relies on the collapsed line being visually distinct from diff code rows (the `--surface-2` row + chevron). A per-file "N resolved threads hidden" indicator (GitHub-style) is a deferred follow-up. Live-pass item below.
- **O4 — new-reply-while-collapsed (§7).** v1 = count pill only; "+N new" marker deferred. Owner sign-off requested.

## Testing & verification

- **Unit (vitest), `ExistingCommentWidget.test.tsx` / new `ThreadDisclosureHeader.test.tsx`:**
  - No `collapse` prop → threads render fully expanded (existing tests stay green).
  - `collapse` stub reporting collapsed → renders the summary line, **not** the `inline-comment-card`s / reply affordance; `aria-expanded="false"`.
  - Expanded → cards + header with `aria-expanded="true"`; expanded header shows the Resolved badge but **not** author/snippet/count.
  - Default derivation (real `isThreadCollapsed`): resolved + empty map → collapsed; unresolved + empty map → expanded.
  - Toggle: activating the button calls `collapse.toggle(threadId, isResolved)`.
  - Count pill: 1 comment → "1 comment"; ≥2 → "N comments"; 0 → no pill.
  - Empty/image-only first comment → no snippet slot, no dangling separator; empty `comments` → no avatar/author crash (guarded).
  - `aria-label` includes file path + line number; `aria-controls` === body `id`.
  - "Resolved" tag (`aria-label="Resolved thread"`) present on a resolved thread (selector at the header).
- **Persistence (the O1 gate):** `FilesTab`-level test — collapse a thread, switch `selectedPath` to another file and back, assert still collapsed; a fresh `FilesTab` mount starts from defaults.
- **State interactions (§7):** override stickiness across an `isResolved` flip (collapse unresolved → simulate resolve → still per-override); new comment appended to a collapsed thread → count pill increments, stays collapsed.
- **A11y:** `button` role, `aria-expanded` toggling, `aria-controls`→body id; keyboard Enter/Space toggles; focus stays on the button.
- **Live validation (required before "done"):** real token store, a PR with resolved + unresolved inline threads (e.g. `mindbody/Mindbody.Clients#973`), **both themes × Unified + Split**:
  - Resolved load collapsed, unresolved expanded.
  - Collapsed line matches Variant A within the centered 80% column; the collapsed row is **visually distinct from adjacent diff code rows** in both themes (O3).
  - Count pill + Resolved badge meet WCAG AA contrast on the `--surface-2` row in both themes.
  - Expand → cards; collapse → one line; chevron rotates (instant under reduced-motion); hover highlight + `cursor:pointer` read as interactive; focus-visible ring not clipped.
  - State persists across file switches within the PR tab; resets on close+reopen.
  - Keyboard: tab to the disclosure, Enter/Space toggles.
- **e2e:** check `frontend/e2e` for any visual/parity baseline rendering an inline thread; none expected to change (parity fixtures render no threads — same as #522); regenerate the Linux baseline via the CI-artifact path if one shifts.
