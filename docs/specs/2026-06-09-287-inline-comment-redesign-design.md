# #287 — Files-tab inline comment redesign (visual)

**Issue:** [#287](https://github.com/prpande/PRism/issues/287) · **Tier:** T3 · **Risk:** gated B1 (UI). `design` + `needs-design`.
**Scope:** **visual / presentation only.** The behavior half originally bundled in #287 (disable add/reply on merged PRs) is split to [#302](https://github.com/prpande/PRism/issues/302).

## Problem

The Files-tab inline comments read as bolted-on. Concretely (owner, ranked):

1. **The composer form is the worst offender** — a bare textarea + a loose row of buttons that doesn't match the app's form controls. Highest-priority refinement.
2. **The commented diff line is not highlighted** — there's no visual link between a thread and the line it anchors to.
3. **Comments in a thread blur together** — multiple comments separated only by a hairline read as one comment; no clear demarcation.
4. **The meta line** (avatar/author/time) could be stronger.

Root cause of the "bolted-on" read: a `--surface-2` band wraps a single `--surface-1` thread card (nested surfaces fighting the diff rows), comments are stacked entries with one hairline between them, and the composer uses unstyled global primitives.

## Goal

Make the inline comments feel native to the diff by **mirroring the Overview tab's comment formatting** (the #129 comment-card treatment), so the two surfaces share one visual language — and overhaul the composer so it reads as part of the thread.

## Approach (locked in brainstorm)

Extract shared primitives used by **both** Overview and the diff, adapted to the diff's denser/narrower context.

**What is actually shared** (scoped honestly — not "they can never drift"): the **comment band + body** formatting and the **collapsed composer affordance**. A change to the band or body lands on both surfaces from one place. Per-context layout — Overview's timeline rail, the diff's line highlight, the resolved tag, card stacking/gaps — is **not** shared and lives in each caller; those can still diverge by design.

- **`CommentCard`** — the inner comment card: `--surface-1` body, 1px `--border-1`, `--radius-3`, **`--shadow-2`**, a header **band** (`--surface-2` fill + border-bottom: avatar + author + time) and a padded markdown body. **Constraint:** `CommentCard` owns band + body + the `density` prop *only*. Resolved-state, the rail, and stacking are the **caller's** composition (children/slots), never a `density`-keyed branch inside the card — this keeps the component from accreting `if (compact)` conditionals.
- **`CollapsedComposerAffordance`** — the input-placeholder button ("Reply…") shared by the diff's reply affordance and Overview's reply button (which is already this exact treatment).
- **`composer-frame` (new CSS classes)** — the expanded framed shell (outer wrapper + action-bar footer). **Do NOT restyle the bare `composer-*` globals** (see Implementation constraints): they are consumed by `PrRootBodyEditor` and `SubmitDialog`, which have no frame and would break.

Each context owns its layout: Overview keeps its vertical **timeline rail**; the diff **omits the rail** (overhead in a 2–3-comment thread) and anchors via the highlighted line.

### Rejected alternatives
- **Shared CSS/classes only, separate components (B)** — the band/body would drift; the owner wants a single component for the card so a band tweak lands both places.
- **Reimplement the look in the diff (C)** — most drift.
- **Bring the timeline rail into the diff** — overhead in short, narrow inline threads; the line highlight is the better anchor.

## Design

### 1. Composer (priority)

**Important scope clarification:** the **new-comment** composer (`InlineCommentComposer`) is mounted **already-expanded** when the user clicks a diff line (today's behavior — unchanged). There is **no** new always-visible "Add a comment…" affordance on blank diff lines. The **collapsed input-placeholder** applies to the **reply** affordance only (the per-thread "Reply" button in `ExistingCommentWidget`, mirroring Overview's existing reply button). This keeps the change visual-only.

- **Collapsed reply affordance:** an input-placeholder ("Reply…") styled like Overview's reply button — `--surface-2`, 1px `--border-1`, `--radius-2`, `cursor: text`, hover → `--border-strong`. It is a **`<button>`** element (matching `prRootReplyButton`), `aria-label="Reply to thread on <file> line <N>"`; Enter/Space expand it.
  - **Existing-draft state:** when a saved reply draft exists for the thread but the composer is not yet open (cross-tab arrival; today the composer auto-opens — that path is unchanged), the collapsed affordance reads **"Continue draft…"** with the `composer-badge--saved` pill inline.
  - **`readOnly` (cross-tab ownership):** the collapsed affordance is rendered **non-interactive** — `--text-3`, no pointer, no hover, click does not expand. (Distinct from `prState !== 'open'`, which is #302's concern.)
- **Expanded:** a **framed shell** (new `composer-frame` class) — `--surface-1`, 1px `--border-2`, `--radius-3`, `--shadow-1`; on focus the **frame** takes the accent border + `--accent-ring` glow (matching `.input`/`.textarea`). The textarea is borderless *inside* the frame so the whole reads as one control. The `composer-frame`-scoped override suppresses **both** the inner textarea's border **and** its `:focus-visible` accent ring, so the frame is the **sole** focus indicator (no double ring); the bare `.composer-textarea` global keeps its own border + ring for its other consumers. **Both expanded composers — `InlineCommentComposer` (new comment) and `ReplyComposer` (reply) — render the identical `composer-frame` shell** (same frame, same action bar incl. the AI chip); only the *collapsed* affordance is reply-exclusive. This is what makes "consistent composer" true for the most-clicked (new-comment) path, not just replies.
- **Action bar:** a `--surface-2` footer strip with a top border. Left→right: **Preview** toggle (ghost), a quiet **save-state pill** (reuses `composer-badge--saved/saving/unsaved/rejected`), the **AI** preview chip (kept, restyled small), spacer, **Discard** (ghost), **Save** (primary, `composer-save btn btn-primary btn-sm` — no new `.composer-save` rule). The existing expanded-composer `readOnly` behavior (disabled textarea + buttons) is unchanged.

### 2. Commented-line highlight + anchoring
- The anchored diff row is marked and given a faint `--accent` wash (`color-mix(in oklch, var(--accent-soft) 70%, var(--surface-1))`) + a 2px `--accent` inset edge, composing over the existing add/remove tints. Scope: **just the anchored line**, not the hunk. The thread renders directly under it with **no outer `--surface-2` wrapper**.
- **Two recipes are required** (the diff renders unified *and* split differently):
  - **Unified:** row-level `background` on the anchored `<tr>` + `box-shadow: inset 2px 0 0 var(--accent)` on the new-side gutter cell.
  - **Split:** the wash + inset edge go on the **content `<td>` with `data-side="new"`**, mirroring the existing split-mode add/remove tint isolation — *not* the `<tr>` (a row shadow would land on the wrong column and wash the empty half-cell). Threads always anchor new-side (`threadsByLine` keys off the new-side line number; delete lines carry no thread, and click handlers stamp `side: 'right'`), so there is no old-side case to handle.
- **Anchor marker:** today nothing classes the commented code row (`threadsAtLine` only drives the follow-up comment row). A `hasThread`/`isAnchored` boolean must be threaded into `DiffLineRow` and the `SplitDiffLineRow` variants, keyed off `threadsAtLine?.length`, to emit the marker class.

### 3. Thread = stacked `CommentCard`s
- Each comment is its own compact `CommentCard`, stacked with an `--s-2` gap → clear demarcation. Replaces the single-card/hairline-entries model.
- **Resolved threads:** quietly differentiated — `opacity: ~0.72` + a small "Resolved" tag in the band (pill, `--surface-3`/`--text-3`). **Hovering** a resolved thread restores opacity to 1 so the reply affordance reads clearly; **reply remains available** on resolved threads (valid per GitHub's model). Not the heavy dashed treatment; not collapsed-by-default.

### 4. Meta line / band
Adopts the Overview band: avatar (compact `sm` size in the diff) + author at 600 weight (`--text-1`) + timestamp (`--text-3`), bound into the card header with a border-bottom. Shared via `CommentCard`.

## Interaction & accessibility states

| State | Behavior |
|---|---|
| Collapsed reply, no draft | `<button>` "Reply…", `cursor: text`, Enter/Space → expand. |
| Collapsed reply, saved draft exists | "Continue draft…" + `composer-badge--saved` pill. |
| Collapsed reply, `readOnly` | Non-interactive, dimmed (`--text-3`), no expand. |
| Expanded composer focus | Accent border + `--accent-ring` on the **frame**. |
| Markdown body, wide content | Compact card body `overflow-x: auto` (scroll code blocks/tables, don't clip into the gutter); `img { max-width: 100% }`. |
| Content scale (#135) | `.markdown-body` inside compact cards inherits `--content-scale` normally — the user's chosen scale applies to inline comments as it does to Overview. |
| Resolved thread | Dimmed + "Resolved" `<span aria-label="Resolved thread">`; restores opacity on hover; reply available. |
| Commented line SR | The thread container carries `aria-label="Comment thread on <file> line <N>"` (preserve the existing reply-button label); the line wash is decorative (no SR text). |

## Components touched

| File | Change |
|---|---|
| **`CommentCard`** (new, shared — `components/PrDetail/Comment/`) | Band + body + `density` prop; forwards `data-testid` + `aria-label` so Overview's tests (`pr-root-comment`, `pr-comment-meta`) stay green. |
| **`CollapsedComposerAffordance`** (new, shared) | Input-placeholder reply button (2 consumers). |
| `composer-frame` CSS (new classes in `tokens.css`, **additive**) | Framed shell + action-bar footer + borderless-textarea-within-frame override. |
| `FilesTab/DiffPane/ExistingCommentWidget.tsx` (+ `.module.css`) | Stacked `CommentCard`s; drop the `--surface-2` wrapper; resolved tag; reply affordance via `CollapsedComposerAffordance`. |
| `FilesTab/DiffPane/DiffPane.tsx` (+ `.module.css`) | Anchor-marker plumbing + the two highlight recipes (unified/split). |
| `Composer/InlineCommentComposer.tsx` / `ReplyComposer.tsx` / `ComposerMarkdownPreview` (+ CSS) | Adopt `composer-frame` + action bar. **Behavior unchanged** — do not touch the #299 `onSaved`/`flushRef` props or the auto-save wiring. |
| `OverviewTab/PrRootConversation.tsx` (+ CSS) | Render its card through `CommentCard` (`comfortable`); keep the timeline rail wrapping it. **Appearance must not change.** |
| `Composer/PrRootReplyComposer.tsx` (+ CSS) | Adopt the shared collapsed affordance / frame around its **outer** container only. |
| `Composer/PrRootBodyEditor.tsx` | **CSS wrapper boundary only** — its internal textarea + autosave wiring are unchanged; it must NOT be forced into the frame model. |

**Explicitly untouched (but verified):** `PrRootBodyEditor` and `SubmitDialog` consume the bare `composer-*` globals; since we add `composer-frame` rather than restyle the globals, they are unchanged — confirmed in the B1 matrix.

## Implementation constraints (regression surface — for the plan)

1. **Don't restyle the bare `composer-*` globals** (`.composer-textarea`, `.composer-badge`, `.composer-preview-toggle`). Add `composer-frame`-scoped rules. Bare-global consumers: `PrRootBodyEditor`, `SubmitDialog`.
2. **`comfortable` density must reproduce today's Overview card byte-for-byte** across four axes: **avatar size** (`md`), **band padding** (`var(--s-2) var(--s-4)`), **body padding** (`var(--s-3) var(--s-4)`), **font scale**. Use `--shadow-2` (not `--shadow-1`). The shared body must carry Overview's `.body p` / `.body code` prose rules verbatim (the diff body gains them — an intended improvement).
3. **`compact` density** (diff): avatar `sm`, band padding `var(--s-1) var(--s-3)`, body padding `var(--s-2) var(--s-3)`, `--text-xs`/`--text-sm` scale, card `--shadow-1`.
4. **Timeline rail coupling:** `--rail-node-y` in `PrRootConversation.module.css` is hand-tuned to the band's `padding-top` (`--s-2`) + the `md` avatar. The `comfortable` card must preserve those, or `--rail-node-y` is re-derived (verify at B1).
5. **Test selectors:** before refactoring `ExistingCommentWidget`, inventory the literal global classes it emits (`comment-thread`, `comment-thread--resolved`, `comment-entry`, `comment-meta`, `comment-author`, `comment-body`) and `data-testid` to find pinned tests; the plan lists which migrate vs. survive.

## Testing & verification
- **Component tests (vitest):** `CommentCard` renders band/body/density + resolved + forwards testid; `ExistingCommentWidget` renders one card per comment; the collapsed affordance expands on click/Enter and is inert under `readOnly`. Existing composer/reply behavior tests stay green (behavior untouched).
- **B1 visual proof — two tiers** (so the regression cells can't slip under matrix fatigue):
  - **Design-review cells (human judgment, light + dark):** the expanded composer frame (new-comment *and* reply — they must look identical), the line highlight (**unified and split**), the stacked-card multi-comment thread, and the resolved thread. These need a human eyeball on the new look.
  - **Regression-assertion cells (pixel-diff == 0, automated where possible — not human-ranked):** **Overview** card identity (the `CommentCard` extraction changed nothing), and **`PrRootBodyEditor` / `SubmitDialog`** (the bare-global composers are untouched). These are equality checks, not design reviews — a moved pixel is a failure, which protects the two named risks far better than eyeballing a "same-looking" screenshot.

## Out of scope / deferred
- **Disable add/reply on merged (and closed-unmerged) PRs** → [#302](https://github.com/prpande/PRism/issues/302).
- **Reply drafts appearing live in the Drafts tab** — the [#299](https://github.com/prpande/PRism/issues/299) boundary.

## Risk
Gated **B1 (UI)**. Substantive risks: (a) the global-vs-`composer-frame` decision leaking into `PrRootBodyEditor`/`SubmitDialog`; (b) the `CommentCard` extraction regressing Overview (shadow/padding/avatar/prose-rule fidelity + the rail node). Both are covered by an expanded B1 before/after matrix. No backend, submit-pipeline, or draft-session changes.
