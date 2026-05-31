---
title: Deferrals sidecar — real two-pane side-by-side diff rendering (slice 1)
date: 2026-06-01
parent_spec: docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md
---

# Deferrals sidecar — real side-by-side diff (slice 1)

Each entry below is something slice 1 deliberately does NOT do. Numbering uses the `DSx` prefix (Diff Side-by-side, slice 1) to avoid collision with the design-parity-recovery `D*` series.

## DSx1 — Whole-file context expansion

**Status:** Deferred to slice 2 (separate brainstorm after slice 1 lands). This is the actual P4-B8 backlog deliverable; slice 1 is the renderer prerequisite.

**What:** ADO-style "show whole file" mode where every line of the file renders with unchanged context filled in between hunks. Layered on top of slice 1's two-pane renderer.

**Why slice 1 doesn't do it:** Slice 1 is the renderer-architecture prerequisite. Bundling whole-file context in adds (a) file-blob fetching at base SHA, (b) hunk-to-blob interleaving algorithm, (c) `TooLarge 413` / `Binary 415` fallback UX, and (d) the question of whether toggling whole-file should be per-file or PR-wide. Each is a substantive design decision worth its own brainstorm.

**Backend dependency status:** `GET /api/pr/{owner}/{repo}/{number}/file?path=&sha=` already exists at `PRism.Web/Endpoints/PrDetailEndpoints.cs:45`. No backend work needed for slice 2.

## DSx2 — Left-side comment anchoring

**Status:** Preserved deferral.

**What:** Allowing reviewers to click a left-pane (deleted) line and open an inline-comment composer anchored to the iteration's `beforeSha`.

**Why slice 1 doesn't do it:** The deferral was set at S4 (see `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:297-302`):

> PoC scope: only right-side (insert/context) clicks open the composer. Left-side (deleted-line) commenting is deferred — its anchoredSha would need to be the iteration's beforeSha, but FilesTab currently uses prDetail.pr.headSha as the anchor (see deferrals doc). Once the anchoredSha-by-iteration plumbing lands, this gate can flip to allow line.type === 'delete' as well.

Slice 1 makes left-pane content visible (you can now SEE the deleted lines on the left), but you still can't click them to comment. Bundling the per-iteration `beforeSha` plumbing into slice 1 would drag in the iteration-aware anchor work that S4 deliberately deferred.

**Future trigger:** When per-iteration `anchoredSha` plumbing lands (the deferred S4 work), slice 1's `SplitDiffLineRow` gains a left-side affordance with one-line wiring. Also adds `position: relative` to `.diffGutterOld` for the affordance's positioning context.

## DSx3 — Multi-line modification block alignment

**Status:** Out of slice 1 scope. Visual implication documented in spec § 5.4.

**What:** Hunt–McIlroy / patience-diff-style line-level LCS to align runs of mixed deletes and inserts onto paired rows. ADO uses a heuristic variant of this; the result is that a 3-delete + 3-insert block renders as three paired rows rather than one paired row + two solo rows.

**Why slice 1 doesn't do it:** The existing `findAdjacentPair` at `DiffPane.tsx:92-103` only pairs boundary delete + boundary insert. Slice 1 matches this algorithm to preserve "every line that's word-diffed in unified mode is word-diffed in split mode" — changing the pairing changes BOTH modes' output, which is its own design decision.

**Visual implication:** For `[D,D,D,I]` patterns, slice 1's split rendering shows two solo-delete rows (left filled, right empty) then one paired-modification row. The orphan-cell pattern is the fragmentation Spec § 5.4 acknowledges; the `d` shortcut / toolbar button is the escape valve.

**Future trigger:** Reviewer feedback that multi-line modification blocks look fragmented in split mode — concretely, the lead engineer reaches for the `d` fallback on 3+ consecutive PRs and reports the reason. Closing path: either ship alignment, or flip the default to `'unified'` per spec § 7.1.

## DSx4 — Per-pane scroll sync / single-`<table>` horizontal-scroll trade-off

**Status:** Architecturally accepted at slice 1.

**What:** Slice 1 uses a single `<table>` with one shared horizontal scrollbar. The two content cells are columns in the same row, so they always scroll together. No sync logic is needed — but the trade-off is that scrolling horizontally on a solo-delete row (left filled, right empty) reveals empty cells on the short side. The scrollbar position is a function of the WIDEST cell in the table, not per-side.

**Why slice 1 accepts the trade-off:** Independent overflow per pane would require either (a) two parallel `<div>` panes with `overflow-x: auto` each + JS scroll-sync to keep them aligned vertically, or (b) a `colgroup` with `width: 50%` content columns + per-cell `overflow-x: auto` (which produces per-cell horizontal scrollbars — visually noisier). Either path adds layout complexity disproportionate to slice 1's scope.

**Future trigger:** Slice 2's whole-file mode renders 2000-line files where one side has +500 inserts and the other -200 deletes, so vertical extents diverge significantly. If slice 2's brainstorm concludes independent vertical scroll is needed, slice 1's single-`<table>` architecture becomes a refactor target — at which point scroll sync becomes a new concern. Slice 2 should treat the renderer as a candidate for restructuring rather than a constraint.

## DSx5 — `diffMode` cross-session / cross-mount persistence

**Status:** Preserved (out of scope).

**What:** Persisting the `diffMode` selection across PR-detail page mounts, browser sessions, or via `usePreferences` (similar to the theme/accent/density precedent in PR9b-density-and-search, `docs/specs/2026-05-29-design-parity-recovery-design.md § 4.9.2`).

**Why slice 1 doesn't do it:** Today's `useState<DiffMode>('side-by-side')` at `FilesTab.tsx:61` resets per mount. Slice 1 preserves this. Persistence is a separate user-preference design (does it become a `UiPreferences` field? per-PR or global? UI for changing it from Settings?), worth its own slice if reviewer feedback surfaces.

**Future trigger:** Reviewer feedback that "I want a different default" or "the default keeps switching back when I navigate PRs". Would extend `UiPreferences` (backend + frontend allowlist update + AppearanceSection control) following the theme/accent/density precedent.
