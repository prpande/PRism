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

**Extract shared primitives used by *both* Overview and the diff** (single source of truth — they can't drift), adapted to the diff's denser/narrower context:

- **`CommentCard`** — the inner comment card: `--surface-1` body, 1px `--border-1`, `--radius-3`, `--shadow-1`, with a header **band** (`--surface-2` fill + border-bottom holding avatar + author + time) and a padded markdown body. A `density` prop: `comfortable` (Overview) and `compact` (diff — tighter padding, `--text-xs`/`--text-sm` scale). Overview's existing card *is* this component's `comfortable` form — its rendered appearance must not change.
- **Composer shell** — the collapsed **input-placeholder affordance** and the expanded **framed composer** (textarea container + action bar), shared by the inline composer, the reply composer, and the PR-root reply composer. Behavior (auto-save, draft id, cross-tab gating) stays in each composer; only the visual frame is shared.

Each context owns its *layout*: Overview keeps its vertical **timeline rail**; the diff **omits the rail** (visual overhead in a 2–3-comment thread) and anchors the thread via the highlighted line instead.

### Rejected alternatives
- **Shared CSS/classes only, separate components (B)** — drifts over time; one surface gets a tweak the other misses. The owner explicitly wants a single source of truth.
- **Reimplement the look in the diff (C)** — most drift, least consistency.
- **Bring the timeline rail into the diff** — overhead in short, narrow inline threads; the line highlight is the better anchor.

## Design

### 1. Composer (priority)
- **Collapsed:** an input-placeholder affordance ("Add a comment…" / "Reply…") styled like Overview's reply button — `--surface-2`, 1px `--border-1`, `--radius-2`, `cursor: text`, hover → `--border-strong`. Replaces today's bare button.
- **Expanded:** a **framed shell** — `--surface-1`, 1px `--border-2`, `--radius-3`, `--shadow-1`; on focus the frame takes the accent border + `--accent-ring` glow (matching the app's `.input`/`.textarea` focus). The textarea is borderless *inside* the frame (the frame owns the border) so it reads as one control, not a textarea floating in a band.
- **Action bar:** a `--surface-2` footer strip with a top border. Left→right: **Preview** toggle (ghost), a quiet **save-state pill** (`saved`/`saving`/`unsaved`/`rejected` — reuses the existing `composer-badge--*` color map), the **AI** preview chip (kept, restyled small), a spacer, **Discard** (ghost), **Save** (primary). All using the app's `.btn` styles.
- The `prState !== 'open'` closed-banner path is unchanged (its behavior is owned by #302).

### 2. Commented-line highlight + anchoring
- The anchored diff row gets a faint `--accent` wash (`color-mix(in oklch, var(--accent-soft) 70%, var(--surface-1))`) + a 2px `--accent` inset left edge (`box-shadow: inset 2px 0 0 var(--accent)`), composing over the existing add/remove tints.
- Scope: **just the anchored line** (precise, low noise), not the whole hunk.
- The thread renders **directly under** the anchored line with **no outer `--surface-2` wrapper** — removing the nested-surface band that drives the bolted-on read.

### 3. Thread = stacked `CommentCard`s
- Each comment is its own compact `CommentCard`, stacked with an `--s-2` gap → clear per-comment demarcation. Replaces the single-card/hairline-entries model.
- **Resolved threads:** quietly differentiated — `opacity: ~0.72` + a small "Resolved" tag in the band (pill, `--surface-3`/`--text-3`). Not the current heavy dashed treatment; not collapsed-by-default.

### 4. Meta line / band
- Adopts the Overview band: avatar (compact size) + author at 600 weight (`--text-1`) + timestamp (`--text-3`), bound into the card header with a border-bottom. Consistent across Overview and the diff via the shared band.

## Components touched

| File | Change |
|---|---|
| **`CommentCard`** (new, shared — likely `components/PrDetail/Comment/`) | Card + band + body + `density` prop. |
| Composer shell (new shared CSS/primitive + tokens) | Collapsed affordance + framed shell + action bar. Extends the existing `composer-*` globals in `tokens.css`. |
| `FilesTab/DiffPane/ExistingCommentWidget.tsx` (+ `.module.css`) | Render stacked `CommentCard`s; drop the `--surface-2` wrapper; resolved tag. |
| `FilesTab/DiffPane/DiffPane.tsx` (+ CSS) | Apply the commented-line highlight to the anchored row. |
| `Composer/InlineCommentComposer.tsx` / `ReplyComposer.tsx` / `ComposerMarkdownPreview` (+ CSS) | Use the framed shell + action bar + collapsed affordance. Behavior unchanged. |
| `OverviewTab/PrRootConversation.tsx` (+ CSS) | Refactor its card markup to render through `CommentCard` (`comfortable`); keep the timeline rail wrapping it. **Appearance must not change** (verified at B1). |
| `Composer/PrRootReplyComposer.tsx` (+ CSS) | Adopt the shared framed shell (its reply-button affordance is already the model). |

## Testing & verification
- **Component tests (vitest):** `CommentCard` renders band/body/density + resolved state; `ExistingCommentWidget` renders one card per comment; composer renders collapsed affordance → expands → action bar. Existing inline-composer/reply behavior tests stay green (behavior is untouched).
- **B1 visual proof (Playwright, light + dark):** before/after for — single comment, multi-comment thread, resolved thread, composer collapsed, composer open, reply open, markdown-rich body — plus an **Overview before/after** to confirm the shared-primitive refactor left it visually identical.

## Out of scope / deferred
- **Disable add/reply on merged (and closed-unmerged) PRs** → [#302](https://github.com/prpande/PRism/issues/302) (depends on the comment/review decoupling: a merged PR can still take a single comment).
- **Reply drafts appearing live in the Drafts tab** — the [#299](https://github.com/prpande/PRism/issues/299) boundary; not part of this visual pass.

## Risk
Gated **B1 (UI)** — correctness is human-eyeball. The one substantive risk is the `CommentCard` extraction regressing Overview's appearance; mitigated by the Overview before/after B1 check. No backend, no submit-pipeline, no draft-session changes.
