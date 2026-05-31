---
title: Deferrals sidecar — real two-pane side-by-side diff rendering (slice 1)
date: 2026-06-01
parent_spec: docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md
---

# Deferrals sidecar — real side-by-side diff (slice 1)

Each entry below is something slice 1 deliberately does NOT do. Numbering uses the `DSx` prefix (Diff Side-by-side, slice 1) to avoid collision with the design-parity-recovery `D*` series.

## DSx1 — Whole-file context expansion

**Status:** Deferred to slice 2 (separate brainstorm after slice 1 lands).

**What:** ADO-style "show whole file" mode where every line of the file renders with unchanged context filled in between hunks. Layered on top of slice 1's two-pane renderer.

**Why slice 1 doesn't do it:** Slice 1 is a renderer-architecture slice. Bundling whole-file context in adds (a) file-blob fetching at base SHA, (b) hunk-to-blob interleaving algorithm, (c) `TooLarge 413` / `Binary 415` fallback UX, and (d) the question of whether toggling whole-file should be per-file or PR-wide. Each is a substantive design decision worth its own brainstorm.

**Backend dependency status:** `GET /api/pr/{owner}/{repo}/{number}/file?path=&sha=` already exists at `PRism.Web/Endpoints/PrDetailEndpoints.cs:45`. No backend work needed for slice 2.

## DSx2 — Left-side comment anchoring

**Status:** Preserved deferral.

**What:** Allowing reviewers to click a left-pane (deleted) line and open an inline-comment composer anchored to the iteration's `beforeSha`.

**Why slice 1 doesn't do it:** The deferral was set at S4 (see `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:297-302`):

> PoC scope: only right-side (insert/context) clicks open the composer. Left-side (deleted-line) commenting is deferred — its anchoredSha would need to be the iteration's beforeSha, but FilesTab currently uses prDetail.pr.headSha as the anchor (see deferrals doc). Once the anchoredSha-by-iteration plumbing lands, this gate can flip to allow line.type === 'delete' as well.

Slice 1 makes left-pane content visible (you can now SEE the deleted lines on the left), but you still can't click them to comment. Bundling the per-iteration `beforeSha` plumbing into slice 1 would drag in the iteration-aware anchor work that S4 deliberately deferred.

**Future trigger:** When per-iteration `anchoredSha` plumbing lands (the deferred S4 work), slice 1's `SplitDiffLineRow` gains a left-side affordance with one-line wiring.

## DSx3 — Multi-line modification block alignment

**Status:** Out of slice 1 scope. Not on the P4 backlog today.

**What:** Hunt–McIlroy-style line-level LCS to align runs of mixed deletes and inserts onto paired rows. ADO uses a heuristic variant of this; the result is that a 3-delete + 3-insert block renders as three paired rows rather than one paired row + two solo rows.

**Why slice 1 doesn't do it:** The existing `findAdjacentPair` at `DiffPane.tsx:92-103` only pairs boundary delete + boundary insert. Slice 1 matches this algorithm to preserve "every line that's word-diffed in unified mode is word-diffed in split mode" — changing the pairing changes BOTH modes' output, which is its own design decision.

**Future trigger:** Reviewer feedback that multi-line modification blocks look fragmented in split mode. Would be its own brainstorm slice; estimated effort medium.

## DSx4 — Per-pane scroll sync

**Status:** Architecturally not needed at slice 1.

**What:** Synchronizing horizontal (and possibly vertical) scrolling between the two content panes.

**Why slice 1 doesn't do it:** Slice 1 uses a single `<table>` with one shared horizontal scrollbar. The two content cells are columns in the same row, so they always scroll together. No sync logic needed.

**Future trigger:** If slice 2 (whole-file mode) or a later slice splits into two independently-scrollable `<div>`s — e.g., for column-resize handles or per-pane overflow — scroll sync becomes a real concern.

## DSx5 — `diffMode` cross-session / cross-mount persistence

**Status:** Preserved (out of scope).

**What:** Persisting the `diffMode` selection across PR-detail page mounts, browser sessions, or via `usePreferences` (similar to the theme/accent/density precedent in PR9b-density-and-search, `docs/specs/2026-05-29-design-parity-recovery-design.md § 4.9.2`).

**Why slice 1 doesn't do it:** Today's `useState<DiffMode>('side-by-side')` at `FilesTab.tsx:61` resets per mount. Slice 1 preserves this. Persistence is a separate user-preference design (does it become a `UiPreferences` field? per-PR or global? UI for changing it from Settings?), worth its own slice if reviewer feedback surfaces.

**Future trigger:** Reviewer feedback that "I want split mode by default" or "I want unified by default and the default keeps switching back." Would extend `UiPreferences` (backend + frontend allowlist update + AppearanceSection control) following the theme/accent/density precedent.

## DSx6 — Parity baseline recapture for `pr-detail-files-diff.png`

**Status:** Intentional visual change, baseline recapture is part of slice 1's plan.

**What:** The Playwright parity baseline at `frontend/e2e/parity-baselines.spec.ts` (the `pr-detail-files-diff.png` snapshot, 4 KB, captured PR #90) was taken against the stubbed split mode. After slice 1 ships, it will look different (true two-pane). Slice 1's plan includes a baseline recapture step.

**Why this is a deferral entry:** Spec-readers checking baseline-stability invariants should see this is intentional, not a regression to investigate.

**Action:** Recapture during slice 1 implementation; commit the new baseline alongside the renderer change.

## DSx7 — Toolbar `<button>` for the diff-mode toggle

**Status:** Conditional — slice 1 ADDS this only if no production toolbar button exists today.

**What:** A `<button aria-pressed={diffMode === 'side-by-side'}>` in the FilesTab toolbar that toggles `diffMode`. Sits next to the iteration / commit-multiselect controls.

**Why this is conditional:** The brainstorm verified that the `d` keyboard shortcut exists (`useFilesTabShortcuts` → `onToggleDiffMode`) but did NOT verify whether a clickable button exists today. If one is already present, slice 1 changes nothing; if it's missing, slice 1 adds one. The implementation plan resolves this with a single grep in step 1.

**Future trigger:** N/A — resolved during slice 1 plan/implementation.

## DSx8 — `MarkdownFileView.tsx` dead-code cleanup

**Status:** Out of slice 1 scope; flagged for visibility.

**What:** `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx` is defined but never imported in production (verified via grep 2026-06-01: only self-references). Reviewers will see the file during slice 1 review and may ask whether it's used.

**Why slice 1 doesn't do it:** Removing a file is its own decision (was it ever planned to wire up? what about its tests, if any?). Cleanup is a one-line commit that doesn't belong inside slice 1's scope.

**Future trigger:** A small dead-code-cleanup slice, or fold-in to any future spec that touches DiffPane's file dispatch logic.
