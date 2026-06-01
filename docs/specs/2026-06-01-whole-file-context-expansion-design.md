---
title: Whole-file context expansion for the diff renderer (slice 2 of 2)
date: 2026-06-01
type: feat
origin: docs/backlog/05-P4-polish.md (P4-B8 — the actual backlog deliverable; slice 1 was the renderer prerequisite)
related:
  - docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md (slice 1 — two-pane renderer)
  - docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md (DSx1 — this spec's parent deferral)
  - docs/backlog/05-P4-polish.md (P4-B8 — per-file expand-context-to-full-file; new P4-B11 — hunk-locator ruler)
  - frontend/src/components/PrDetail/FilesTab/FilesTab.tsx (toolbar host; owns the new toggle state)
  - frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx (renderer; consumes new props + hook)
  - PRism.Web/Endpoints/PrDetailEndpoints.cs:45 (existing `/file?path=&sha=` endpoint — no backend changes needed)
---

# Whole-file context expansion — design (slice 2 of 2)

## 1. Goal

Make the diff renderer show every line of the file, on demand, with the hunks highlighted in place. The actual P4-B8 backlog deliverable. Slice 1 shipped the two-pane renderer prerequisite; slice 2 layers whole-file context on top.

Concretely: a new per-file toolbar toggle. When on, the diff body fetches the file content at the relevant SHA(s), interleaves it with the existing hunks, and renders the resulting full-length file with all unchanged regions filled in. Failure paths (file too large, binary, missing, not in diff) revert the toggle and surface a banner.

## 2. Why now / scoping rationale

P4-B8 was carried into slice 2 the moment slice 1 merged (PR #98 + PR #99). Slice 1's usability gate (acceptance criterion #13 — "lead engineer uses split mode by default for at least 3 consecutive PR reviews") was validated 2026-06-01 against `prpande/Pensieve#3` (10-file real PR) with zero DSx3 multi-line-fragmentation triggers. The renderer architecture is proven; slice 2 is the natural next layer.

Backend already exists. `GET /api/pr/{owner}/{repo}/{number}/file?path=&sha=` returns text/plain content or a problem-details response on failure (404 NotFound, 413 TooLarge, 415 Binary, 422 NotInDiff / Truncation / SnapshotEvicted / InvalidSha / MissingParams). Verified at `PRism.Web/Endpoints/PrDetailEndpoints.cs:45`. No backend work needed for slice 2.

**Effort sizing.** S, matching the backlog entry. The four cost drivers — new hook, new pure interleave function, toolbar button, failure banner — are each small, composable additions on top of the slice-1 renderer. The minimap UX that surfaced during the brainstorm is split into its own backlog item (P4-B11 + DSx7) to keep sizing honest.

## 3. Out of scope (carried + new)

**New to slice 2 (DSx6–DSx11):**

- **Renamed-file whole-file mode** — DSx6. `FileChange` wire shape doesn't carry `previousFilename`; adding that field is a backend DTO change. The toggle is disabled for renamed files with a tooltip explaining the limitation.
- **Hunk-locator ruler / minimap** — DSx7 + new backlog entry **P4-B11**. Surfaced during this brainstorm; deferred to keep slice 2 at Effort: S and because the minimap is useful in hunk-only mode too.
- **Truncated `added`/`deleted` files** — DSx8. GitHub normally shows the full content for added/deleted files; whole-file mode for truncated edge cases is a follow-up.
- **Cross-session / cross-mount persistence of `wholeFilePaths`** — DSx9. Same posture as slice 1's DSx5.
- **`f` keyboard shortcut for the toggle** — DSx10. Trivial follow-up; deferred to avoid bundling the shortcut decision into this slice.
- **Whole-file mode for non-`all` iteration / commit-multi-select views** — DSx11. Hunks in those views are anchored to iteration-specific SHAs, not the PR-level base/head; threading per-range SHAs through to the hook is bigger work than slice 2 absorbs. Toggle is disabled when `activeRange !== 'all'` OR `selectedCommits !== null` (see § 7.2).

**Carried from slice 1 (DSx2–DSx5):**

- **Left-side comment anchoring** — slice 1's DSx2 carries unchanged. Filled-context rows inherit slice 1's right-side-only affordance.
- **Multi-line modification block alignment** — slice 1's DSx3 carries unchanged. Filled context doesn't affect the hunk-internal pairing algorithm.
- **Per-pane scroll sync** — slice 1's DSx4 carries unchanged. Whole-file mode still uses the single-`<table>` architecture.
- **`diffMode` cross-session / cross-mount persistence** — slice 1's DSx5 carries unchanged. (DSx9 above is the slice-2 analog for `wholeFilePaths`.)

Each item above is documented in the deferrals sidecar (see § 11).

## 4. Architecture: orthogonal layer on slice 1's renderer

### 4.1 The composition

Whole-file is a **boolean per file** that composes with `diffMode`. Any of the four cells is reachable:

|                 | Unified                          | Side-by-side                          |
|-----------------|----------------------------------|----------------------------------------|
| Hunks only      | Slice 1 unified mode (today)     | Slice 1 split mode (today)             |
| Whole file      | Slice 1 unified mode + filled gaps | Slice 1 split mode + filled gaps     |

The interleaving algorithm produces a `DiffLine[]` that covers every line 1..M of the head file when whole-file is enabled. Slice 1's existing `renderUnifiedRows()` / `renderSplitRows()` consume that array unchanged — filled-context lines are emitted as `type: 'context'` `DiffLine`s with an optional `isFilled: true` flag.

### 4.2 Responsibility split (mirrors slice 1)

| Owner            | Owns                                                                                              |
|------------------|---------------------------------------------------------------------------------------------------|
| `FilesTab`       | `wholeFilePaths: Set<string>` state; new toolbar button (sibling to slice 1's diff-mode toggle); failure callback that removes the path from the Set. |
| `DiffPane`       | `wholeFileEnabled` prop consumption; fetch via new hook; interleave call; failure banner render + callback dispatch. |
| `useWholeFileContent` (new hook) | Lazy fetch (single SHA in unified, dual SHA in split via `Promise.all`); problem-details parsing; cache by `(path, headSha, baseSha?)` for the session. |
| `interleaveWholeFile` (new pure function) | `DiffLine[]` extension covering every line 1..M of the head file; preserves hunk parsing for the changed regions and computes filled-context `oldLineNum`/`newLineNum` for the gaps. |

The asymmetry — state up, fetch down — matches slice 1's `diffMode` (state on FilesTab) + `useAiHunkAnnotations` (fetch from DiffPane).

### 4.3 Alternatives rejected

- **FilesTab orchestrates fetch + threads content down.** Couples FilesTab to the wire shape (it grows knowledge of headSha/baseSha that today only DiffPane needs). Rejected.
- **DiffPane internalizes the toggle entirely.** Breaks slice 1's "FilesTab owns toolbar chrome, DiffPane renders content" pattern and makes a future `f` shortcut painful (the global keyboard handler is at FilesTab level). Rejected.
- **New third `DiffMode` value (`'whole-file'`).** Forces whole-file to imply a specific layout (split or unified), losing the orthogonal composition the user wants. Rejected.
- **Per-gap chevron buttons (incremental N-line expansion).** Closer to ADO's actual UX but adds per-gap state and multiple fetch round-trips. Backlog wording ("Show full file content … on demand") and slice 1's DSx1 framing both point at the single-toggle model. If real-world usage surfaces a need for fine-grained expansion later, it becomes its own slice 3.

## 5. Interleaving algorithm

### 5.1 Inputs

- `file: FileChange` — `{ path, status, hunks: DiffHunk[] }`. Hunks are in ascending order by `newStart`.
- `headContent: string` — full text of the file at `headSha`.
- `baseContent: string | null` — full text of the file at `baseSha`, or null when not fetched (unified mode) or unavailable (`status === 'added'`).

### 5.2 Output

`DiffLine[]` (extending the existing `DiffLine` shape with an optional `isFilled?: true` flag) covering every line 1..M of the head file when `status === 'modified'`. Hunk regions emit the parsed hunk lines unchanged; gaps between and around hunks emit filled-context lines.

### 5.3 Walk

```ts
function interleaveWholeFile(
  file: FileChange,
  headContent: string,
  baseContent: string | null,
): DiffLine[] {
  const out: DiffLine[] = [];
  const headLines = headContent.split('\n');
  // Trailing-newline policy: a file ending with '\n' splits into N+1 elements
  // with an empty string at the end. interleaveWholeFile emits one filled-context
  // line per element matching M = headLines.length. Tests cover both
  // newline-terminated and no-final-newline files.

  let prevNewEnd = 0; // last newLineNum covered by the previous hunk (0 = none)
  let prevOldEnd = 0; // last oldLineNum covered by the previous hunk

  for (const hunk of file.hunks) {
    // Gap before this hunk: emit filled-context lines from (prevNewEnd+1) to (hunk.newStart-1)
    for (let n = prevNewEnd + 1; n < hunk.newStart; n++) {
      out.push({
        type: 'context',
        content: headLines[n - 1] ?? '',
        oldLineNum: prevOldEnd + (n - prevNewEnd),
        newLineNum: n,
        isFilled: true,
      });
    }
    // Hunk body: parse and emit as today (delete/insert/context + hunk-header)
    out.push(...parseHunkLines(hunk.body));
    prevNewEnd = hunk.newStart + hunk.newLines - 1;
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }

  // Trailing gap: from (prevNewEnd+1) to end of file
  for (let n = prevNewEnd + 1; n <= headLines.length; n++) {
    out.push({
      type: 'context',
      content: headLines[n - 1] ?? '',
      oldLineNum: prevOldEnd + (n - prevNewEnd),
      newLineNum: n,
      isFilled: true,
    });
  }

  return out;
}
```

### 5.4 Correctness of the `oldLineNum` computation

Outside hunks, the file is byte-identical between base and head modulo cumulative shifts introduced by prior hunks. The shift at any point is `(cumulative inserted lines) − (cumulative deleted lines)`, which equals `prevNewEnd − prevOldEnd` after walking past hunk `i`. So for any line `n` in the new file lying in the gap after hunk `i`, the corresponding old line is `prevOldEnd + (n − prevNewEnd)`. This holds by induction across hunks because each hunk advances `prevNewEnd` by `hunk.newLines` and `prevOldEnd` by `hunk.oldLines`, preserving the invariant `oldLineNum(n) = n + (prevOldEnd − prevNewEnd)` in the next gap.

For split mode, `baseContent[oldLineNum − 1]` should equal `headContent[newLineNum − 1]` for any filled-context line — both files agree on unchanged regions. The renderer doesn't verify this (no per-render byte comparison) but it's a contract the interleave algorithm assumes. Test § 9.1 case 5 covers it via a constructed fixture.

### 5.5 Hunk-header rows are skipped during emission in whole-file mode

`parseHunkLines` emits a `'hunk-header'` line for the `@@ ... @@` marker at the start of each hunk body. In whole-file mode, those markers carry no information (no lines were skipped). The DiffPane render loop iterates the FULL `allLines` array (hunk-headers included) but does NOT emit a `<tr>` for them when `wholeFileEnabled === true && fetchStatus === 'ok'`. The iteration still uses hunk-header encounters to advance `hunkCounter` (per § 8.2's AI annotation re-anchoring); the "skip" applies only to the row emission, not the array filtering.

## 6. Component changes

### 6.1 `DiffPane.tsx`

**Prop additions to `DiffPaneProps`:**

- `wholeFileEnabled: boolean`
- `onWholeFileFailed: (reason: string) => void`
- `headSha: string`
- `baseSha: string`

The two SHA props are threaded from FilesTab (which already owns `prDetail` via `useOutletContext`). FilesTab passes `prDetail.pr.headSha` and `prDetail.pr.baseSha` only when the gating in § 7.2 permits whole-file mode (i.e., `activeRange === 'all'` AND `selectedCommits === null`); when gated off, FilesTab still passes the values but `wholeFileEnabled` is false so the hook returns `'idle'` per § 6.3.

**Hook invocation:**

```ts
const { fetchStatus, headContent, baseContent, failureReason } = useWholeFileContent({
  prRef,
  path: selectedPath,
  file,
  headSha,
  baseSha,
  enabled: wholeFileEnabled,
  isSplit,
});
```

The object-argument shape matches the `UseWholeFileContentInput` interface at § 6.3.

**Local failure latch:**

DiffPane holds a local `failureReason` state that latches on the `'idle' → 'failed'` or `'loading' → 'failed'` transition and clears on user dismiss. This decouples the banner's visibility from the hook's `fetchStatus`. After the failure callback removes the path from `wholeFilePaths` (making `wholeFileEnabled === false` and reverting the hook to `'idle'`), the banner remains visible because it renders from `localFailure`, not from `fetchStatus`. Dismiss clears `localFailure` AND calls `onWholeFileFailed` (idempotent — FilesTab handles the second call as a no-op).

```ts
const [localFailure, setLocalFailure] = useState<string | null>(null);
const prevStatus = useRef<typeof fetchStatus>('idle');
useEffect(() => {
  if (prevStatus.current !== 'failed' && fetchStatus === 'failed' && failureReason) {
    setLocalFailure(failureReason);
    onWholeFileFailed(failureReason);
  }
  prevStatus.current = fetchStatus;
}, [fetchStatus, failureReason, onWholeFileFailed]);
```

Dismiss handler clears `localFailure` and calls `onWholeFileFailed` for the idempotent path removal.

**Render-branch behavior:**

| Condition | DiffPane renders |
|---|---|
| `wholeFileEnabled && fetchStatus === 'ok'` | Whole-file body via `interleaveWholeFile(file, headContent, baseContent)`. Hunk-header rows iterate but skip `<tr>` emission per § 5.5. Filled-context rows carry `data-fill="true"` per the row-component threading below. |
| `wholeFileEnabled && fetchStatus === 'loading'` | The previous body (hunks-only via `parseHunkLines`) inside a wrapper with `.diffPaneBodyLoading` applied (dimming) + a sticky-top status overlay. See § 6.5 for the CSS specifics. |
| `localFailure !== null` (regardless of `fetchStatus`) | `<WholeFileFailureBanner reason={localFailure} onDismiss={…} />` rendered as a SIBLING div between `.diffPaneHeader` and `.diffPaneBody` (outside the body's scroll container). |
| Default / `wholeFileEnabled === false` | Hunks-only rendering, unchanged from slice 1. |

**Row component threading for `data-fill`:**

Filled-context rows need a `data-fill="true"` attribute on the rendered `<tr>` so Playwright and vitest can assert presence/absence of the expansion. This requires threading an optional `isFilled?: boolean` prop through both row components:

- `DiffLineRow` (unified): accepts `isFilled?: boolean`; when true, the rendered `<tr>` gets `data-fill="true"`.
- `SplitDiffLineRow` (split): accepts `isFilled?: boolean`; applied to the `context` kind only (the only kind that can be filled — header/paired/solo-delete/solo-insert never originate from filled context). When true, the `<tr>` for the `context` kind gets `data-fill="true"`.

The attribute is the test seam; it has no styling. The new `[data-fill="true"]` selector in `DiffPane.module.css` exists empty (see § 6.5) so the seam is reachable from CSS if future polish ships a visual distinction.

**Other DiffPane edits:**

- Mode-aware `colSpan` (slice 1) stays untouched.
- The `modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified'` (slice 1) stays unchanged.
- The hunk-header row emission gate in `renderUnifiedRows` and `renderSplitRows` adds a `wholeFileEnabled && fetchStatus === 'ok'` clause to skip the `<tr>` push (per § 5.5).

### 6.2 New component: `WholeFileFailureBanner`

Sibling to `DiffTruncationBanner` in the `DiffPane/` folder. Renders a yellow / amber inline banner with the reason text and a dismiss button. Reuses the existing global `.banner-warning` class added in PR #88 (design-parity-recovery PR2 — three banners compose with `.banner`/`.banner-warning` per memory `project_pr88_design_parity_pr2_shipped`).

Props:

```ts
interface WholeFileFailureBannerProps {
  reason: string;
  onDismiss: () => void;
}
```

Reason strings (human-readable mapping from problem types — produced by `useWholeFileContent`):

| Problem type | Reason string |
|---|---|
| `/file/too-large` | `"file is too large to expand"` |
| `/file/binary` | `"file is binary"` |
| `/file/missing` | `"file not present at this revision"` |
| `/file/not-in-diff` | `"file not available in current diff snapshot"` |
| `/file/truncation-window` | `"file not available in current diff snapshot"` |
| `/file/snapshot-evicted` | `"diff snapshot has been evicted — reload the PR"` |
| network / other | `"could not load file"` |

Split-mode partial-failure formatting: the hook concatenates a side prefix into the reason. The user-facing vocabulary is `"old-side"` (= `baseSha` = left pane) and `"new-side"` (= `headSha` = right pane). Examples:

- head 200 + base 413 → `"old-side file is too large to expand"`
- base 200 + head 413 → `"new-side file is too large to expand"`
- head 200 + base 415 → `"old-side file is binary"`
- base 200 + head 404 → `"new-side file not present at this revision"`

The prefix attaches at the front of the reason string the same problem-type mapping would otherwise produce.

### 6.3 New hook: `useWholeFileContent`

`frontend/src/hooks/useWholeFileContent.ts`. Signature:

```ts
interface UseWholeFileContentInput {
  prRef: PrReference;
  path: string | null;
  file: FileChange | null;
  headSha: string;
  baseSha: string;
  enabled: boolean;
  isSplit: boolean;
}

interface UseWholeFileContentResult {
  fetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  headContent: string | null;
  baseContent: string | null;
  failureReason: string | null;
}

function useWholeFileContent(input: UseWholeFileContentInput): UseWholeFileContentResult;
```

Behavior:

- Returns `{ fetchStatus: 'idle', headContent: null, baseContent: null, failureReason: null }` when `enabled === false` OR `path === null` OR `file === null` OR `file.status !== 'modified'` OR `file.hunks.length === 0`. The hunks-length clause covers the iteration-change edge case where `wholeFilePaths` retained a path whose file shape transitioned to zero hunks (e.g., switching iterations that exclude this file's changes).
- When `enabled === true && file.status === 'modified'`, fires the fetch on mount or when `(path, headSha, baseSha, isSplit)` changes. Fetches:
  - Unified (`isSplit === false`): single GET `/api/pr/{owner}/{repo}/{number}/file?path={path}&sha={headSha}`.
  - Split (`isSplit === true`): parallel `Promise.all([head GET, base GET])`.

**Fetch transport.** The existing `apiClient.get` helper at `frontend/src/api/client.ts:88-90` always calls `JSON.parse` on the response body. The `/file` endpoint returns `text/plain` on success (per `PRism.Web/Endpoints/PrDetailEndpoints.cs:80`), so `apiClient.get` would throw `SyntaxError` on the happy path. The hook therefore uses raw `fetch()` directly, mirroring the headers `apiClient` attaches:

```ts
const url = `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/file?path=${encodeURIComponent(path)}&sha=${sha}`;
const resp = await fetch(url, {
  credentials: 'include',
  headers: {
    'X-PRism-Session': sessionId,
    'X-PRism-Tab-Id': tabId,
  },
  signal: abortController.signal,
});
if (resp.ok) {
  return { kind: 'ok', content: await resp.text() };
}
const problem = (await resp.json()) as { type?: string };
return { kind: 'failed', reason: mapProblemType(problem.type) };
```

The hook reads `sessionId` and `tabId` from the same source `apiClient` uses (the auth/identity context). If apiClient gains a `getText` helper in the future, the hook can adopt it then; until that lands, slice 2 ships the raw-fetch path.

**Cache.** A `Map<string, FetchResult>` keyed by `${path}::${headSha}::${baseSha}::${isSplit}` lives in a hook-internal ref. If the key is already resolved, return cached result synchronously. If a fetch is in flight for the key, await it (don't re-fire). Scope: per DiffPane mount — the ref clears when DiffPane unmounts (PR navigation, route change, refresh). Module-level caching is out of scope; sufficient for slice 2's reading-session usage pattern.

**Cancellation.** Use a `cancelled` flag inside the `useEffect`, mirroring `useAiHunkAnnotations.ts:24-26` and `useFileDiff.ts:26,41-43`. When `enabled` flips off or `path` changes, the cleanup function sets `cancelled = true`. The in-flight fetch may still complete and write to the cache (cache lives in a ref outside the closure), but `setState` calls inside the promise chain are gated on `!cancelled` to avoid React's "setState on unmounted component" warning and stale-update races.

```ts
useEffect(() => {
  let cancelled = false;
  // ... fetch promise chain calls `if (!cancelled) setFetchStatus(...)` ...
  return () => { cancelled = true; };
}, [path, headSha, baseSha, isSplit, enabled]);
```

**Problem-details parsing.** 200 → `'ok'` + content. Non-200 → parse the `type` field of the problem details JSON, map to a reason string per § 6.2.

**Split-mode partial failure.** If either side fails, the overall `fetchStatus` is `'failed'`. The `failureReason` includes the `"old-side"` or `"new-side"` prefix per § 6.2. The successful side's content is discarded (we don't render half-expanded files per Q3c).

### 6.4 `FilesTab.tsx`

- New state: `const [wholeFilePaths, setWholeFilePaths] = useState<Set<string>>(new Set());`.
- Derived: `const wholeFileEnabled = selectedPath !== null && wholeFilePaths.has(selectedPath) && iterationGatePermits;` where `iterationGatePermits = activeRange === 'all' && selectedCommits === null` (DSx11; see § 7.2).
- New toolbar button after slice 1's diff-mode toggle. See § 7 for full disabled-gate logic and button styling. Click handler toggles the path's membership in `wholeFilePaths`.
- New callback `handleWholeFileFailed(reason: string)`: idempotently removes the current `selectedPath` from `wholeFilePaths` so the toggle reverts to off. The callback is called by DiffPane in two situations: (a) once per failure transition (via the useEffect in § 6.1) and (b) on banner dismiss (idempotent — if the path was already removed by (a), the Set delete is a no-op). The banner's visibility lifetime is owned by DiffPane's local `failureReason` latch (§ 6.1), not by FilesTab's Set membership.
- Pass `wholeFileEnabled`, `headSha`, `baseSha`, and `onWholeFileFailed={handleWholeFileFailed}` to DiffPane.

### 6.5 `DiffPane.module.css` + `FilesTab.module.css`

**`DiffPane.module.css` — new rules:**

- `[data-fill="true"]` attribute selector exists as a test seam with no declarations at slice-2 ship time. Per Q4a, filled-context lines render visually identical to in-hunk context. Acknowledged tradeoff: with hunk-headers also hidden in whole-file mode (Q4b) and the minimap deferred (DSx7), the user loses the only existing orientation cues. The mitigation lives in DSx7 / P4-B11; slice 2 commits to the no-distinction model the brainstorm chose.
- `.diffPaneBodyLoading` — dimming wrapper applied to the existing diff body when `wholeFileEnabled && fetchStatus === 'loading'`:
  ```css
  .diffPaneBodyLoading {
    position: relative;            /* positioning context for the overlay */
    opacity: 0.5;                  /* dim the underlying diff */
    pointer-events: none;          /* prevent comment-affordance clicks during fetch */
  }
  .diffPaneLoadingOverlay {
    position: sticky;              /* stays visible during scroll inside .diffPaneBody */
    top: var(--s-2);
    z-index: 2;
    align-self: center;
    padding: var(--s-2) var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-2);
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  ```
  `.diffPaneBodyLoading` wraps the existing `.diffPaneBody` content. `.diffPaneLoadingOverlay` is a sticky `<div role="status" aria-live="polite">` that stays visible within the scroll container regardless of scroll position. The dim applies via `opacity` (not `background`) so the underlying rows show through visibly muted.

**`FilesTab.module.css` — toolbar button class isolation:**

Slice 1's `.diffModeToggle` includes `margin-left: auto;` which pushes the button to the right edge of the toolbar. Adding a second button after it would inherit that auto-margin if both buttons `composes:` the same class, producing two independently-right-aligned buttons. Split the responsibilities:

- New `.toolbarToggleButton` carries the SHAPE properties only (surface-2 / border-1 / radius-2 / s-1 s-3 / text-sm / text-2 / cursor + `aria-pressed`/`:disabled` rules). NO `margin-left: auto`.
- Existing `.diffModeToggle` `composes: toolbarToggleButton` and adds `margin-left: auto` (preserves slice-1 positioning).
- New `.wholeFileToggle` `composes: toolbarToggleButton` and adds `margin-left: var(--s-2);` for spacing from the diff-mode toggle.

If the `composes:` approach proves brittle in the CSS-modules runtime, fall back to a global `.btn-toolbar-toggle` class in `tokens.css` (PR-#88 / PR-#89 lift precedent) and use literal classNames in the JSX. The composes-first attempt is the cleaner path.

### 6.6 No backend changes

`PrDetailEndpoints.cs`, `IPrReader.GetFileContentAsync`, `FileContentResult`, `FileContentStatus`, `FileChange`, `DiffHunk` — all unchanged. Renamed-file `previousFilename` deferral is DSx6.

### 6.7 No new API client changes beyond the hook

The hook uses raw `fetch()` with the same `credentials` + `X-PRism-Session` + `X-PRism-Tab-Id` headers `apiClient` attaches (see § 6.3 "Fetch transport"). The existing `apiClient.get` cannot consume the `/file` endpoint's `text/plain` body without throwing on the happy path. Slice 2 ships the raw-fetch path; if a future slice adds `apiClient.getText`, the hook migrates. No changes to `useFileDiff`, `useUnionDiff`, `useAiHunkAnnotations`, `useAiGate`, `useFilesTabShortcuts`.

## 7. Toolbar button placement, default state, and disabled gating

Today's `files-tab-toolbar` (per slice 1 + PR #99) contains, in order:

1. `CommitMultiSelectPicker`
2. `IterationTabStrip`
3. Slice 1's `.diffModeToggle` button

Slice 2 appends the whole-file toggle after position 3. Visual order:

```
[Commit picker]  [Iteration tabs]   ...   [Side-by-side]  [Show full file]
```

The two toggle buttons share the same shape (per § 6.5).

### 7.1 Default state

`wholeFilePaths` starts empty. Whole-file mode is **off by default** for every file. The user opts in per file via the button. This matches DSx1's "on demand" wording.

### 7.2 Disabled gating

Disabled when ANY of:

- `selectedPath === null` (no file picked).
- The selected file's `status !== 'modified'` (per § 3, slice 2 supports modified only). Renamed → DSx6; added/deleted → DSx8.
- The selected file's hunks array is empty (no diff to expand around — though this case usually means the file is in the diff for a non-content reason like a permission change; UI doesn't render the diff pane at all for empty-hunks files).
- **`activeRange !== 'all'` OR `selectedCommits !== null` (DSx11).** Iteration-range and commit-multi-select views produce hunks whose `newStart`/`oldStart` anchor to range-specific SHAs, not the PR-level `headSha`/`baseSha`. Fetching whole-file content at the PR-level SHAs would produce filled-context line numbers indexed into the wrong file. Threading per-range SHAs through the hook is bigger work than slice 2 absorbs; closing DSx11 will do that. Tooltip on this disabled state: `"Whole-file view available only on the 'all' iteration view"`.

Disabled-state mechanism: use the HTML `disabled` attribute (matching slice 1's `.diffModeToggle` `disabled` usage at `FilesTab.tsx:357`). The CSS rule `:disabled` (also from slice 1's `.diffModeToggle:disabled`) applies `opacity: 0.5; cursor: not-allowed;`. Do NOT use `aria-disabled` — it doesn't block click events and would leave the button reachable. Tooltip text varies by disabled reason (modified-only, iteration-range, etc.) via the `title` attribute. Note that `title` is sometimes suppressed by browsers on `:disabled` buttons; an `aria-describedby` pointing to a visually-hidden span is acceptable but not required for slice 2.

### 7.3 Viewport gate

Slice 1's `<900px` viewport gate forces unified mode regardless of stored `diffMode`. The whole-file toggle stays enabled at narrow viewports — the unified-mode whole-file combo is legitimate. Only the slice-1 diff-mode toggle reflects the viewport gate.

## 8. Comment affordance, AI annotations, existing comments, composers

### 8.1 Comment affordance on filled-context lines

Slice 1's right-gutter affordance fires for any `context` row with a `newLineNum`. Filled-context lines are `context` rows with `newLineNum` populated by the interleave algorithm → affordance falls out automatically. No code changes in slice 2.

Anchor SHA: `prDetail.pr.headSha`, same as slice 1 (right-side comments anchored to head). Any line in the head file at any `newLineNum` is a valid GitHub anchor.

### 8.2 AI hunk annotation re-anchoring in whole-file mode

In hunks-only mode (today), annotations render as a full-width row directly after the corresponding hunk-header row. In whole-file mode, hunk-header rows skip `<tr>` emission per § 5.5. The render path uses an explicit "consumed hunk" Set to anchor each hunk's annotations to its first emitted (non-header) line exactly once:

```ts
// Compute once per file at render time:
const annotationsByRowIdx = new Map<number, HunkAnnotation[]>();
const consumedHunks = new Set<number>();
let hunkCounter = -1;
for (let idx = 0; idx < allLines.length; idx++) {
  const line = allLines[idx];
  if (line.type === 'hunk-header') {
    hunkCounter += 1;
    continue;
  }
  // First non-header line of a hunk with annotations claims them.
  if (hunkCounter >= 0 && !consumedHunks.has(hunkCounter)) {
    const ann = annotationsForFile?.get(hunkCounter);
    if (ann) annotationsByRowIdx.set(idx, ann);
    consumedHunks.add(hunkCounter); // even if no annotations, prevents re-checks
  }
}

// During row emission: if annotationsByRowIdx.has(idx), emit annotation row(s)
// BEFORE the row for idx.
```

The `consumedHunks` Set guards against the bug the original draft would have introduced (the `!annotationsByRowIdx.has(idx)` check it used was always false at idx, so every non-header line in a hunk with annotations would re-attach them). The Set tracks per-hunkCounter consumption; once a hunk is claimed (whether or not annotations existed), subsequent lines in the same hunk don't re-attach.

In hunks-only mode, the existing `renderUnifiedRows` / `renderSplitRows` logic stays unchanged — annotations still emit after hunk-header rows because the hunk-header rows are still emitted. The new `annotationsByRowIdx` map is only built and consulted when `wholeFileEnabled && fetchStatus === 'ok'`.

### 8.3 Existing comment widget + composer slot rows

Unchanged from slice 1. Both attach to the right-side line number of a `context` / `insert` / `paired` / `solo-insert` row. Filled-context rows fit this contract → widget + composer rows attach normally.

`ReviewThreadDto.lineNumber` is always a right-side (new-file) line number. The `threadsByLine` map keys on `newLineNum`. A thread anchored to an unchanged line (e.g., a thread filed in a previous review against line 50 of a 200-line file, where line 50 is unchanged in this PR) will now render against a filled-context row when whole-file is enabled. In hunks-only mode, that thread is invisible because line 50 is not in any hunk's context window — which is current PoC behavior preserved. Slice 2 makes such threads visible when whole-file is on. Edge case acknowledged; no regression because the thread was already in the data, just rendered for the first time.

### 8.4 Inline composer slot

Unchanged from slice 1.

## 9. Test plan

### 9.1 Vitest

**New file `frontend/__tests__/useWholeFileContent.test.ts`** (6 cases):

| # | Scenario | Assertion |
|---|---|---|
| 1 | `enabled: false` | `fetchStatus === 'idle'`; no fetch fired |
| 2 | Unified `enabled: true`, 200 head | `fetchStatus === 'ok'`; `headContent` populated; `baseContent === null` |
| 3 | Split `enabled: true`, 200 head + 200 base | `fetchStatus === 'ok'`; both contents populated |
| 4 | `enabled: true`, 413 head | `fetchStatus === 'failed'`; `failureReason === 'file is too large to expand'` |
| 5 | Split `enabled: true`, 200 head + 413 base | `fetchStatus === 'failed'`; `failureReason === 'old-side file is too large to expand'` |
| 6 | Cache reuse: same `(path, headSha, baseSha)` after re-enable | No second fetch fires; returns cached `'ok'` synchronously |

**New file `frontend/__tests__/interleaveWholeFile.test.ts`** (5 cases):

| # | Scenario | Assertion |
|---|---|---|
| 1 | Single hunk, no leading/trailing gap (hunk spans whole file) | Output matches `parseHunkLines(hunk.body)` exactly; no filled lines |
| 2 | Single hunk in the middle | Leading gap has `isFilled: true` rows; trailing gap too; oldLineNum monotonic |
| 3 | Multiple hunks with gaps between | Each gap correctly fills the gap; oldLineNum derivations correct across hunks |
| 4 | Leading gap (hunk doesn't start at line 1) | Lines before first hunk are filled-context with oldLineNum starting at 1 |
| 5 | Trailing gap (file longer than last hunk's range) | Lines after last hunk are filled-context with oldLineNum advancing past hunk |

**Extend `frontend/__tests__/DiffPane.test.tsx`** (4 cases):

| # | Scenario | Assertion |
|---|---|---|
| 1 | `wholeFileEnabled: true`, `fetchStatus: 'ok'`, unified | Diff body contains `[data-fill="true"]` rows; no `[data-type="hunk-header"]` rows |
| 2 | `wholeFileEnabled: true`, `fetchStatus: 'ok'`, split | Same + filled-context rows render in 4-column layout |
| 3 | `wholeFileEnabled: true`, `fetchStatus: 'failed'` | `<WholeFileFailureBanner>` renders with the reason text; `onWholeFileFailed` fires on dismiss |
| 4 | `wholeFileEnabled: true`, `fetchStatus: 'ok'`, AI annotations present | Annotation row renders immediately before the first non-header line of its hunk; not after a (filtered) hunk-header row |

**Extend `frontend/__tests__/FilesTab.test.tsx`** (5 cases):

| # | Scenario | Assertion |
|---|---|---|
| 1 | Click "Show full file" toggle on a `modified` file in `activeRange === 'all'` | `wholeFilePaths` set contains the path; button label flips to "Hunks only"; `aria-pressed="true"` |
| 2 | Toggle disabled on `added` / `deleted` / `renamed` files | Button has HTML `disabled` attribute; click is no-op; tooltip text matches "Whole-file view available for modified files only" |
| 3 | Toggle disabled when `activeRange !== 'all'` (DSx11 gate) | Button has HTML `disabled` attribute; click is no-op; tooltip text matches "Whole-file view available only on the 'all' iteration view" |
| 4 | Toggle disabled when `selectedCommits !== null` (DSx11 gate) | Same as case 3 |
| 5 | `onWholeFileFailed` flow | Failure callback removes path from `wholeFilePaths`; button reverts to "Show full file"; banner remains visible via DiffPane local latch; dismiss clears banner |

### 9.2 Playwright

**Extend `frontend/e2e/parity-baselines.spec.ts`:**

New parity baseline `pr-detail-files-diff-whole-file.png` against `src/Calc.cs` (the fixture file slice 1 already uses) with whole-file enabled in side-by-side mode.

Functional scenario (no screenshot — just DOM assertions):

| Step | Assertion |
|---|---|
| Open `/files`, select `src/Calc.cs` | Side-by-side diff renders; `[data-fill="true"]` count is 0 |
| Click "Show full file" button | Loading state briefly visible (`.diffPaneBodyLoading` class present, `role="status"` overlay visible); then `[data-fill="true"]` count > 0; no `.diff-hunk-header` rows |
| Click "Hunks only" button | Filled rows disappear; hunk-header rows reappear; `.diffPaneBody` `scrollTop` is 0 (scroll-reset assertion per § 10) |
| Click "Show full file" on `added` / `deleted` / `renamed` fixture file | Button has HTML `disabled` attribute; click does nothing |
| Drill into iteration-N-only view, attempt to click "Show full file" | Button has HTML `disabled` attribute (DSx11 gate); tooltip mentions 'all' iteration view |
| Force-failure fixture (a path that returns 413 from the test-hooks backend) | Banner renders with reason; toggle reverts (button label is "Show full file"); banner remains visible until click dismiss → banner gone, button still in "off" state |

The test-hooks backend (`PRism.Web/TestHooks/`) needs a small extension for the force-failure scenario: a new `/test/file/force-failure` POST that registers a path → problem-type mapping the FakePrReader honors on the next `/file?path=&sha=` call. Spec § 9.2 stage adds this; sized at ~30 lines including test endpoint and consumer wiring. This is the only test-hook addition slice 2 makes.

### 9.3 Parity baseline change

`pr-detail-files-diff.png` (slice 1's baseline) does **not** change. Whole-file mode is opt-in; the default state continues to be hunks-only side-by-side. The new baseline `pr-detail-files-diff-whole-file.png` captures the opt-in state.

## 10. Edge cases

| Case | Handling |
|---|---|
| `selectedPath === null` | Toggle disabled, button shows "Show full file" (default label). No fetch. |
| `file === null && isLoading` | Whole-file toggle disabled — there's no file shape to act on yet. Reverts to enabled when file arrives. |
| `file.status === 'modified' && file.hunks.length === 0` | Toggle disabled per § 7.2; this case usually means a non-content change (permission flip). Diff body itself shows the empty-file message. |
| `file.status === 'added'` | Toggle disabled. The file's entire content is already in the single all-insert hunk (DSx8 covers truncated edge cases). |
| `file.status === 'deleted'` | Toggle disabled. Same logic; entire content is in the single all-delete hunk. |
| `file.status === 'renamed'` | Toggle disabled with tooltip. DSx6. |
| Loading state | Diff body stays mounted with previous content dimmed (per § 6.1); status text with `aria-live="polite"` announces the fetch. |
| 413 / 415 / 404 / 422 from `/file` | Banner per § 6.2; toggle reverts via callback. |
| Split mode with `status === 'modified'` but base content fetch fails | Banner with side-qualified reason ("old-side file is …"); toggle reverts. |
| Network error / timeout | Banner with `"could not load file"` reason. |
| User toggles off mid-fetch | Hook's cancelled flag fires on the cleanup; setState calls inside the in-flight promise no-op. The fetch promise still completes and writes to the cache (ref-scoped) for next time. Hook returns `'idle'`. |
| User toggles off after `'ok'`, scrolled deep into whole-file body | DiffPane's `.diffPaneBody` scroll position is reset to `scrollTop = 0` on every `wholeFileEnabled` transition (either direction). Without this, toggling off from line 850 of a 1000-line whole-file view would leave `scrollTop` past the bottom of the now-30-row hunks-only table and the user would see an empty viewport. Resetting to top is simpler than "find nearest hunk header and scroll there"; PoC scope accepts the predictable-but-coarse reset. |
| User switches file while whole-file toggle is on for the previous file | New file uses its own `wholeFilePaths` membership (defaults to off). Previous file's set entry persists for the session. Scroll reset fires on file-switch independently. |
| Viewport resize across 900px threshold mid-render | `effectiveDiffMode` switches; `isSplit` changes; hook re-fetches because `isSplit` is in its key. The brief loading state on resize is acceptable. (Optimization opportunity DSx-out-of-scope: cache by `(path, headSha)` separately from `baseSha` so the unified-mode cache survives a flip to split.) |
| Viewport resize across 900px threshold mid-fetch (in-flight when resize fires) | Cancelled flag fires for the old `isSplit` value; old in-flight fetch's setState calls no-op. New fetch fires for new `isSplit`. The loading overlay re-applies in the new column layout. Acceptable; no special handling. |
| Theme (dark / light) | Banner reuses `.banner-warning` which is theme-aware. |
| AI gating off | Annotation rows not emitted; otherwise unaffected by whole-file. |
| `replyContext === undefined` (test harness) | Existing-comment widgets render read-only as today. |
| Trailing newline in `headContent` | `headContent.split('\n')` produces an extra empty element at the end. The walk loop emits a filled-context row with empty content for that index — harmless visually (renders as an empty line, matching the file). Tests § 9.1 case 5 covers it. |
| `headContent` shorter than the last hunk's `newStart + newLines - 1` | Shouldn't happen if backend returned consistent SHAs, but the walk uses `?? ''` fallback for `headLines[n - 1]` to avoid undefined-content crashes. Logged as a console warning (one-line); no banner — the diff still renders. |

## 11. Deferrals sidecar

Companion file `docs/specs/2026-06-01-whole-file-context-expansion-deferrals.md`. Entries:

- **DSx6** — Renamed-file whole-file mode (wire-shape change needed: `previousFilename` on `FileChange`).
- **DSx7** — Hunk-locator ruler / minimap (also added as backlog entry **P4-B11**).
- **DSx8** — Whole-file mode for truncated `added` / `deleted` files.
- **DSx9** — Cross-session / cross-mount persistence of `wholeFilePaths`.
- **DSx10** — `f` keyboard shortcut for the whole-file toggle.
- **DSx11** — Whole-file mode in non-`all` iteration / commit-multi-select views (per-range SHA threading).

## 12. Acceptance criteria

1. Clicking the new "Show full file" toolbar button on a `modified` file fires the file fetch and renders the whole file with hunks highlighted in place. Filled-context rows render with `[data-fill="true"]`.
2. Toggle disabled when `selectedPath === null`, when `file.status !== 'modified'`, or when `file.hunks.length === 0`. Tooltip explains the disabled state.
3. Failure paths (`/file/too-large`, `/file/binary`, `/file/missing`, `/file/not-in-diff`, `/file/truncation-window`, `/file/snapshot-evicted`, network) render `<WholeFileFailureBanner>` with the mapped reason string and revert the toggle to off via `onWholeFileFailed`.
4. Split-mode dual-SHA fetch with one-side failure surfaces a single banner naming the affected side (`"old-side file is …"` or `"new-side file is …"`).
5. AI annotations remain visible at their hunks' positions in whole-file mode, re-anchored to the first non-header line of each hunk.
6. Comment affordance works on filled-context lines: right-gutter hover reveals the button; click opens a composer anchored to `prDetail.pr.headSha + newLineNum`.
7. Hunk-header rows (`@@ ... @@`) are not emitted as table rows in whole-file mode (the iteration still walks them to advance `hunkCounter` per § 8.2). Hunks-only mode emits them unchanged.
8. Existing slice-1 acceptance criteria all continue to hold; `pr-detail-files-diff.png` parity baseline does not change.
9. New parity baseline `pr-detail-files-diff-whole-file.png` captures the whole-file side-by-side state and is checked in.
10. All new vitest cases per § 9.1 pass: 6 `useWholeFileContent` + 5 `interleaveWholeFile` + 5 `DiffPane` (4 original + 1 latch-survival added during plan's ce-doc-review per DL6) + 5 `FilesTab` = 21 new cases.
11. New Playwright assertions per § 9.2 pass, including the force-failure scenario via the new test-hook endpoint.
12. Empty / loading / truncated / deleted-file / added-file / renamed-file states render per § 10.
13. Pre-push checklist per `.ai/docs/development-process.md` clean: `npm run lint`, `npm run build`, `npm test`, `dotnet test`, `npx playwright test --project=prod`.
14. **Usability gate.** Lead engineer toggles whole-file mode on at least 3 distinct PRs across at least 2 distinct files each without reverting because of a usability issue (slowness, layout bug, comment-affordance regression). If usability issues surface, capture the reason in the deferrals sidecar before the slice-2-aftermath polish PR opens (analogous to PR #99 closing slice-1's gate aftermath).

## 13. References

- Brainstorm transcript: 2026-06-01 session (this spec is the output).
- Parent backlog item: `docs/backlog/05-P4-polish.md` P4-B8 (per-file expand-context-to-full-file).
- New backlog item created by this brainstorm: `docs/backlog/05-P4-polish.md` P4-B11 (hunk-locator ruler / minimap).
- Slice-1 spec: `docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md`.
- Slice-1 deferrals (this slice closes DSx1): `docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md`.
- Backend endpoint (unchanged): `PRism.Web/Endpoints/PrDetailEndpoints.cs:45`.
- Existing renderer extended by slice 2: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`.
- Toolbar host: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`.
- Banner-class precedent (PR #88): memory `project_pr88_design_parity_pr2_shipped`.
- Toggle-button-shape precedent (PR #99): memory `project_pr99_diff_mode_toggle_button_styling_shipped`.
