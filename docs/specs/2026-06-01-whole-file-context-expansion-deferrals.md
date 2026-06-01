---
title: Deferrals sidecar — whole-file context expansion (slice 2)
date: 2026-06-01
parent_spec: docs/specs/2026-06-01-whole-file-context-expansion-design.md
---

# Deferrals sidecar — whole-file context expansion (slice 2)

Each entry below is something slice 2 deliberately does NOT do. Numbering continues the `DSx` series from slice 1 (DSx1–DSx5).

## DSx6 — Renamed-file whole-file mode

**Status:** Deferred. Toggle is disabled for `status === 'renamed'` files with a tooltip explaining the limitation.

**What:** Whole-file expansion for files renamed in the PR. The base-side file lives at one path; the head-side file lives at another. Fetching both requires knowing both paths.

**Why slice 2 doesn't do it:** `FileChange` wire shape (`PRism.Web/Endpoints/PrDetailDtos.cs` + `frontend/src/api/types.ts`) carries only `path: string`. There's no `previousFilename` field. GitHub's diff API does return the previous filename for renamed files (it's the source of the `R100 path/old.cs path/new.cs` header in raw diffs and is parsed inside PRism's diff path), but it isn't surfaced through the wire DTO today.

Adding `previousFilename?: string` to `FileChange` is a backend + frontend DTO change with no other consumer in slice 2. Out of scope to keep slice 2 at Effort: S.

**Future trigger:** Lead engineer hits a renamed file during whole-file usage and wants the toggle to work. Closing path: add `previousFilename?: string` to `FileChange` on both sides; update `useWholeFileContent` to use it for the base-side fetch when `status === 'renamed'`; flip the disabled gate to enable for renamed files.

## DSx7 — Hunk-locator ruler / minimap

**Status:** Deferred. Surfaced during this brainstorm; promoted to its own backlog entry **P4-B11** in `docs/backlog/05-P4-polish.md`.

**What:** An IDE-style thin vertical bar to the right of the diff body showing scaled-down representation of the file with colored regions for hunks. Click → jump-to-hunk. Variants discussed in the brainstorm: scaled-text minimap (like VS Code) vs. tick-mark ruler (like Chrome's find-in-page yellow marks).

**Why slice 2 doesn't do it:** Slice 2's whole-file mode and the minimap UX don't share primitives. Whole-file is a renderer-content concern (interleave + fetch); the minimap is a new sibling component with its own scroll/click/sticky/resize logic. Bundling them would push slice 2 from Effort: S to Effort: M+ and would couple unrelated complexity. Additionally, the minimap is useful in hunks-only mode too — gating it on slice 2 delays its value.

**Future trigger:** Lead engineer reports either (a) "I can't find the hunks in a 2000-line file when whole-file is on" or (b) "I'd love a quick visual locator even without whole-file mode". Closing path: P4-B11 brainstorm followed by its own implementation slice.

## DSx8 — Whole-file mode for truncated added/deleted files

**Status:** Deferred. Toggle is disabled for `status === 'added'` and `status === 'deleted'` files.

**What:** Whole-file expansion for added or deleted files whose hunk payload was truncated by GitHub's diff window (`truncated: true` on the parent `DiffDto`). Normally GitHub returns the full content for added/deleted files; truncation only kicks in for very large files.

**Why slice 2 doesn't do it:** Added/deleted files almost always render their full content already (the hunks ARE the file). Toggling whole-file would be a no-op visually. The corner case is the truncated one, where the toggle would be useful — but that's a rare edge case and reaches for the `/file?path=&sha=` endpoint with the file's status taken into account (added → headSha only; deleted → baseSha only). Out of scope to keep slice 2 at Effort: S and focused on the modified-file case.

**Future trigger:** Lead engineer hits a truncated added or deleted file and needs whole-file. Closing path: extend the disabled gate to enable for added/deleted when `truncated === true` on the parent diff; teach `useWholeFileContent` to fetch only the relevant side.

## DSx9 — Cross-session / cross-mount persistence of `wholeFilePaths`

**Status:** Deferred. `wholeFilePaths` resets per FilesTab mount. Same posture as slice 1's DSx5 for `diffMode`.

**What:** Persisting the set of paths in whole-file mode across PR-detail page mounts, browser sessions, or via `usePreferences` (e.g., as a Settings option "Default new files to whole-file view" similar to the theme/density precedent).

**Why slice 2 doesn't do it:** Whole-file mode is a reading-session action, not a stored preference. Mirrors slice 1's DSx5 rationale exactly. A Settings entry to default the toggle is over-engineered for a single sole-owner audience.

**Future trigger:** Lead engineer reports "I always want whole-file on by default" OR "I want my whole-file state to persist when I navigate away and come back to a PR mid-review". Closing path: extend `UiPreferences` with a new field; honor it at FilesTab mount.

## DSx10 — `f` keyboard shortcut for whole-file toggle

**Status:** Deferred. The toggle is button-only in slice 2.

**What:** A keyboard shortcut (e.g., `f` for "full") that toggles whole-file mode for the currently selected file, mirroring slice 1's `d` shortcut for diff-mode.

**Why slice 2 doesn't do it:** Trivial follow-up but deserves its own small-PR consideration. The shortcut key (`f`? `e` for expand? `w` for whole?) is a coupling decision that overlaps with the existing `useFilesTabShortcuts` registrations (`j`, `k`, `n`, `p`, `c`, `Esc`, `Cmd/Ctrl+Enter`, `Cmd/Ctrl+R`, `?`, `d`). Bundling the choice into slice 2 risks picking a clashing key.

**Future trigger:** Lead engineer uses the button enough to feel friction. Closing path: pick a key, add a registration to `useFilesTabShortcuts`, add a row to the cheatsheet overlay (PR #73), update the keyboard-shortcut Playwright spec.

## DSx11 — Whole-file mode in non-`all` iteration / commit-multi-select views

**Status:** Deferred. Toggle is disabled when `activeRange !== 'all'` OR `selectedCommits !== null`. Tooltip explains the limitation.

**What:** Whole-file expansion when the user has drilled into a specific iteration range or a commit-multi-select view. In those views, `file.hunks` are anchored to range-specific SHAs (e.g., iteration-2-beforeSha / iteration-2-afterSha) rather than the PR-level `headSha` / `baseSha`.

**Why slice 2 doesn't do it:** Slice 2's `useWholeFileContent` hook fetches at `prDetail.pr.headSha` and `prDetail.pr.baseSha`. For an iteration-2-only view, the hunks anchor to iteration 2's SHAs — `hunk.newStart` indexes lines in the iteration's afterSha file, not the PR head's file. Fetching whole-file content at PR-level SHAs would produce filled-context lines whose `newLineNum` indexes into the wrong file, mis-aligning the rendered context.

The correct fix is to thread the active range's `(beforeSha, afterSha)` through to DiffPane (probably via `prSnapshot.range` or a new prop), and use those in the hook. The work touches FilesTab's range selection logic + DiffPane prop shape + hook signature + tests. Larger than slice 2's S sizing absorbs; disable gating is the right slice-2 trade-off.

**Future trigger:** Lead engineer reviews a PR with multiple iterations, drills into iteration-N-only view, and wants whole-file context for a file changed in that iteration. Closing path: thread per-range SHAs through to the hook; update FilesTab to source `headSha`/`baseSha` from `activeRange` rather than `prDetail.pr`; flip the disabled gate.
