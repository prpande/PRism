# #327 Decompose DiffPane / FilesTab / PrHeader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behavior-preserving decomposition of the three largest PR-detail components, shipped as three sequential PRs (slice 1 DiffPane, slice 2 FilesTab, slice 3 PrHeader), pixel-identical, per `docs/specs/2026-07-02-327-decompose-pr-detail-design.md` (the spec — read it first; it is authoritative on every "why").

**Architecture:** Sibling-file extraction inside existing directories. Slice 1 splits DiffPane.tsx (1,305 lines) into row components, two memoizable body components, a failure-latch hook, and a shared annotation-row builder. Slice 2 extracts FilesTab's optimistic-comment and inline-composer subsystems into hooks and stabilizes every identity crossing the DiffPane boundary (composite `activeComposerKey` + per-thread data channel). Slice 3 moves PrHeader's error copy to `api/submit.ts` and its submit orchestration into `useSubmitFlow`.

**Tech Stack:** React 19 + TypeScript + Vite; vitest + Testing Library (tests co-located under `src/` AND in `frontend/__tests__/` — check both); CSS modules.

## Global Constraints

- Work ONLY in the worktree `D:\src\PRism\.claude\worktrees\327-decompose-pr-detail` (branch `worktree-327-decompose-pr-detail` for slice 1; slices 2–3 get fresh branches after the prior slice merges). Never touch `D:\src\PRism` directly.
- Pixel-identical rendering; no visual or interaction changes anywhere.
- Vitest via the LOCAL binary only: `cd frontend && ./node_modules/.bin/vitest run <paths>` (never `npx vitest`). Typecheck: `./node_modules/.bin/tsc -b` (never `tsc --noEmit` — vacuous here). Lint (includes prettier --check, gates CI): `npm run lint`.
- All line numbers below are anchored to the slice-1 starting tree (commit `e8965c3a`); if drift is suspected, locate by the quoted symbol, not the number.
- Existing test suites must pass unmodified, EXCEPT the exact carve-outs the spec names: (a) import-path updates, (b) `prUrl:''` → `htmlUrl:''` in the two perf-test fixtures, (c) slice 2's named matchMedia-stub/viewport-test changes.
- Commit messages: conventional, reference `#327` as bare text in the body (never `fix(#327):` — auto-closes). `Closes #327` appears only in PR 3's description. End every commit with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Cz9md9aAqTauY4aotrTLiT`
- Full pre-push checklist (`.ai/docs/development-process.md`) + `/simplify` run before each PR opens (orchestrator's job, not per-task).

---

## SLICE 1 — DiffPane decomposition (PR 1)

All new files live in `frontend/src/components/PrDetail/FilesTab/DiffPane/` and import the existing `DiffPane.module.css` as `styles`. Source file: `DiffPane.tsx` (1,305 lines).

### Task 1: `useWholeFileFailureLatch` hook (test-first — the only new behavior-bearing unit in slice 1)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/useWholeFileFailureLatch.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/useWholeFileFailureLatch.test.tsx`
- Modify: `DiffPane.tsx:283-332` (delete the inlined latch; consume the hook)

**Interfaces (Produces):**

```ts
export interface WholeFileFailureLatch {
  failure: string | null;          // latched failureReason, null = no banner
  dismiss: () => void;             // clears the latch only
  retry: (() => void) | undefined; // defined iff onWholeFileRetry was provided
}
export function useWholeFileFailureLatch(opts: {
  fetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  failureReason: string | null | undefined;
  selectedPath: string | null;
  onWholeFileFailed?: (reason: string) => void;
  onWholeFileRetry?: () => void;
}): WholeFileFailureLatch;
```

- [ ] **Step 1: Write the failing test** — `useWholeFileFailureLatch.test.tsx` using `renderHook` from `@testing-library/react`, covering (each its own `it`): (1) transition `idle→failed` sets `failure` and calls `onWholeFileFailed` exactly once; (2) staying `failed` across rerenders does NOT re-fire the callback (fire-once latch); (3) `selectedPath` change clears `failure` — but NOT on the initial mount when the failure lands on the same render (mount with `fetchStatus:'failed'`: `failure` must survive — the initial-mount-skip semantics of `DiffPane.tsx:306-313`); (4) `dismiss()` clears `failure` without calling `onWholeFileFailed`; (5) `retry` is `undefined` without `onWholeFileRetry`, and when provided, calling it clears `failure` AND calls `onWholeFileRetry`; (6) re-failure after retry re-latches.
- [ ] **Step 2: Run it, verify FAIL** — `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/useWholeFileFailureLatch.test.tsx` → module not found.
- [ ] **Step 3: Implement the hook** — move the logic of `DiffPane.tsx:283-332` verbatim into the hook (the two `useEffect`s, `prevStatus` ref, `isInitialPathMount` ref, `dismissBanner`→`dismiss`, `retryWholeFile`→`retry`), preserving the code comments (they carry the Copilot-iter-1 rationale).
- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Consume in DiffPane** — replace lines 283-332 with `const { failure: localFailure, dismiss: dismissBanner, retry: retryWholeFile } = useWholeFileFailureLatch({ fetchStatus: wholeFile.fetchStatus, failureReason: wholeFile.failureReason, selectedPath, onWholeFileFailed, onWholeFileRetry });` (keeps downstream names untouched).
- [ ] **Step 6: Run the DiffPane suites** — `./node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/` → all pass.
- [ ] **Step 7: Commit** — `refactor(fe): extract useWholeFileFailureLatch from DiffPane (for #327)`.

### Task 2: `annotationRows` builder (kills the ×4 duplication)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/AnnotationRows.tsx`
- Modify: `DiffPane.tsx:585-591, 604-610, 702-708, 720-726` (the four verbatim `rows.push(<tr className={styles.aiHunkRow}>…)` blocks)

**Interfaces (Produces):**

```tsx
import type { HunkAnnotationDto } from '../../../../api/types'; // match DiffPane's existing import
import { AiHunkAnnotation } from …; // same import DiffPane uses today
import styles from './DiffPane.module.css';

export function annotationRows(opts: {
  annotations: readonly HunkAnnotationDto[];
  colSpan: number;
  keyPrefix: string; // e.g. `ann-${idx}` — caller keeps today's exact key scheme
}): React.ReactElement[];
```

(Verify the annotation DTO type name from DiffPane's imports before writing — use exactly what the four sites use today.)

- [ ] **Step 1: Implement the builder** returning `annotations.map((a, aidx) => <tr key={`${keyPrefix}-${aidx}`} className={styles.aiHunkRow}><td colSpan={colSpan}><AiHunkAnnotation annotation={a} /></td></tr>)` — byte-for-byte the JSX of the existing four sites (diff the four sites first; if any diverges beyond the source array, STOP and re-check the spec).
- [ ] **Step 2: Replace the four sites** with `rows.push(...annotationRows({ annotations: <site's array>, colSpan, keyPrefix: <site's existing prefix> }))`, preserving each site's exact key strings (existing keys must not change — React reconciliation).
- [ ] **Step 3: Run DiffPane suites** (same command as Task 1 Step 6) → pass. **Step 4: Commit** — `refactor(fe): single annotationRows builder for the 4 AI-annotation row sites (for #327)`.

### Task 3: Move `MergedPairedContent` + gutter helpers to sibling files

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/MergedPairedContent.tsx` (from `DiffPane.tsx:55-120`, WITH its `React.memo` wrapper and the #670 comment)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/gutter.tsx` (`NewGutterCell` from `:185-211` + `ComposerSlot` — locate by symbol)
- Modify: `DiffPane.tsx` (delete moved code, import from siblings)

- [ ] **Step 1: Move verbatim** (exports added; imports each file needs carried over; no logic edits). **Step 2: Run DiffPane suites + `./node_modules/.bin/tsc -b`** → pass (note: `DiffPane.wordDiffMemo.perf.test.tsx` mocks the `diff` package at module level — unaffected by the move, verified at spec time). **Step 3: Commit** — `refactor(fe): move MergedPairedContent + gutter cells to DiffPane siblings (for #327)`.

### Task 4: Move `DiffLineRow` and `SplitDiffLineRow` to sibling files; unify the gutter click handlers

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffLineRow.tsx` (from `:928-1049`, with `React.memo` + the "Default shallow compare is correct" comment)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/SplitDiffLineRow.tsx` (from `:1072-…`, with memo)
- Create (in `gutter.tsx` from Task 3): the shared click-handler builder
- Modify: `DiffPane.tsx`

**Interfaces (Produces, in gutter.tsx):**

```ts
export function makeGutterClick(opts: {
  onLineClick: ((anchor: InlineAnchor) => void) | undefined;
  filePath: string;
  lineNumber: number;
  side: InlineAnchor['side'];
  anchoredLineContent: string;
}): (() => void) | undefined;
```

- [ ] **Step 1: Diff the four handleClick closures** (`SplitDiffLineRow` context `:1100-1109`, solo-insert `:1179-1188`, paired `:1225-1234`; `DiffLineRow` `:986-1000`) and confirm they differ only in `anchoredLineContent` (`content ?? ''`, `content ?? ''`, `newText ?? ''`, `line.content`) and anchor fields. If any carries extra logic, keep that difference at the call site.
- [ ] **Step 2: Implement `makeGutterClick`** building today's anchor object identically; replace all four closures with calls.
- [ ] **Step 3: Move the two row components verbatim** to their files (they import `MergedPairedContent`/`gutter` from Task 3's files and `styles`).
- [ ] **Step 4: Run DiffPane suites + tsc -b** → pass (rowMemo.perf mocks the HighlightedLine module — unaffected). **Step 5: Commit** — `refactor(fe): row components to sibling files, one gutter click builder (for #327)`.

### Task 5: `UnifiedDiffBody` / `SplitDiffBody` components (closures → explicit props)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/UnifiedDiffBody.tsx` (from `renderUnifiedRows`, `:553-…`)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/SplitDiffBody.tsx` (from `renderSplitRows` + `emitWidgetAndComposerRows`, `:641-…`)
- Modify: `DiffPane.tsx` (`<tbody>{renderDiffRows()}</tbody>` → `<tbody>` containing `<UnifiedDiffBody …/>` or `<SplitDiffBody …/>`; note both bodies render `<tr>` lists — the `<tbody>` element stays in DiffPane so the table skeleton is unchanged)

**Interfaces (Produces — one shared props type in a `diffBodyProps.ts` or duplicated per file, implementer's choice):**

```ts
export interface DiffBodyProps {
  selectedPath: string;
  lines: DiffLine[];                        // = allLines
  threadsByLine: Map<number, ReviewThreadDto[]>;
  annotationsForFile: Map<number, HunkAnnotationDto[]> | undefined; // hunk mode
  annotationsByRowIdx: Map<number, HunkAnnotationDto[]> | undefined; // whole-file mode
  wholeFileEnabled: boolean;
  wholeFileFetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  colSpan: number;
  syntax: SyntaxTokens;                     // whatever useSyntaxTokens returns — use its exported type
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
  changeStartMap: <existing type>;
  changeEndMap: <existing type>;
  // slice 2 adds: activeComposerKey: string | null
}
```

**IMPORTANT completeness rule (spec Risks):** after converting, grep each body file for every identifier not defined locally or imported — each one MUST be a prop. The spec's list is the floor, not the ceiling; the closures capture ~15 outer variables and missing one is the highest-risk failure of this slice.

- [ ] **Step 1: Extract WITHOUT `React.memo`** — plain function components, props exactly the captured set. Run the full DiffPane suite → pass.
- [ ] **Step 2: Commit** — `refactor(fe): renderUnified/SplitRows closures become body components (for #327)`.
- [ ] **Step 3: Add `React.memo`** to both bodies. Run the FULL frontend suite (`./node_modules/.bin/vitest run`) — the existing suites (thread highlight, annotation arrival, collapse toggle, change-nav) are the non-staleness guard the spec names. → pass.
- [ ] **Step 4: Commit** — `refactor(fe): memoize diff body components (for #327)`.

### Task 6: `prUrl` → `htmlUrl` rename

**Files:** Modify: `DiffPane.tsx` (`:129, :233`, forward site `:902`), `DiffTruncationBanner.tsx` (its own `prUrl` prop — single consumer), `FilesTab.tsx:786`, `DiffPane.rowMemo.perf.test.tsx` (fixture `prUrl:''`→`htmlUrl:''`), `DiffPane.wordDiffMemo.perf.test.tsx` (same).

- [ ] **Step 1: Rename** (grep `prUrl` across `frontend/` afterward → zero hits). **Step 2: Full frontend suite + tsc -b + lint** → pass. **Step 3: Commit** — `refactor(fe): rename prUrl to htmlUrl at the DiffPane boundary (for #327)`.

### Task 7: Slice-1 gate (orchestrator)

- [ ] DiffPane.tsx ≤ ~400 lines (`wc -l`); if meaningfully above, report why rather than force-cutting.
- [ ] Full frontend suite, `tsc -b`, `npm run lint`, backend untouched (`git status` shows only `frontend/` + docs).
- [ ] `/simplify` pass, pre-push checklist, then PR 1 via pr-autopilot (orchestrator does this outside the plan tasks).

---

## SLICE 2 — FilesTab decomposition (PR 2; cut branch AFTER PR 1 merges; re-anchor line refs by symbol)

### Task 8: matchMedia-aware test stub + `SPLIT_DIFF_MIN_WIDTH` + `useIsSplitCapable`

**Files:**
- Modify: `frontend/__tests__/setup.ts:28-43` (the global matchMedia stub)
- Create: `frontend/src/components/PrDetail/FilesTab/useIsSplitCapable.ts`
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` (delete `useViewportWidth` `:73-83`; replace the three `900` literals at `:159, :336, :707`)
- Test: existing `__tests__/FilesTab.test.tsx` viewport tests + `FilesTab.viewPreservation.test.tsx` (the spec's named carve-out)

**Interfaces (Produces):**

```ts
// useIsSplitCapable.ts
export const SPLIT_DIFF_MIN_WIDTH = 900; // px; keep in sync with tokens.css @media (max-width: 899px); #146 edits here
export function useIsSplitCapable(): boolean; // useMediaQuery(`(min-width: ${SPLIT_DIFF_MIN_WIDTH}px)`)
```

```ts
// setup.ts stub upgrade — evaluate width queries, preserve false for the rest:
value: (query: string) => {
  const m = /\((min|max)-width:\s*([\d.]+)px\)/.exec(query);
  const matches = m
    ? (m[1] === 'min' ? window.innerWidth >= parseFloat(m[2]) : window.innerWidth <= parseFloat(m[2]))
    : false;
  return { matches, media: query, /* …existing no-op listener shape unchanged */ };
}
```

- [ ] **Step 1: Upgrade the stub** (evaluate at call time against `window.innerWidth`; keep the exact no-op listener shape). Run the FULL frontend suite → must stay green BEFORE any consumer changes (proves the upgrade is compatible: InboxPage's 1180px gate stays false at jsdom's 1024; per-test overrides win).
- [ ] **Step 2: Commit** — `test(fe): matchMedia stub evaluates width queries against innerWidth (for #327)`.
- [ ] **Step 3: Create `useIsSplitCapable`**, swap the three literals + delete `useViewportWidth`. Viewport tests that change `innerWidth` mid-test: re-render after the change or install a per-test matchMedia mock (InboxPage's save/restore pattern) — touch ONLY the tests the spec names.
- [ ] **Step 4: Full suite + commit** — `refactor(fe): useIsSplitCapable + SPLIT_DIFF_MIN_WIDTH replace useViewportWidth (for #327)`.

### Task 9: Single tree build

**Files:** Modify: `FilesTab.tsx:188` (keep), `FileTree.tsx:151` (drop duplicate `useMemo`; add `tree: TreeNode` prop — ADDITIVE, `files` stays), `FileTree.test.tsx` + `FileTree.scrollbar.test.tsx` fixtures (gain the prop).

- [ ] Test-first: adjust FileTree tests to pass a built tree; implement; full FilesTab+FileTree suites; commit — `refactor(fe): build the file tree once in FilesTab, pass it down (for #327)`.

### Task 10: `useOptimisticComments` extraction

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/useOptimisticComments.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/useOptimisticComments.test.tsx`
- Modify: `FilesTab.tsx` (`:391, :397, :408-418, :423-430, :524-548, :577-596, :647-661` — the whole subsystem)

**Interfaces (Produces):**

```ts
export function useOptimisticComments(realComments: ReviewCommentDto[] /* match today's source */): {
  optimisticByThread: Map<string, OptimisticComment[]>;   // today's grouping memo
  placeholdersForLine: (filePath: string, line: number) => OptimisticComment[]; // today's per-line filter incl. databaseId dedup
  notePosted: (…): void;      // today's onPosted body (new inline threads)
  noteReplyPosted: (…): void; // today's onReplyPosted body
  bumpRefetchGen: () => void; // today's refetchGenRef increment sites
};
```

(Exact parameter lists lifted verbatim from today's handlers — this is a MOVE; the hook wraps the existing `optimisticComment.ts` helpers, and `optimisticComment.test.ts` keeps covering the pure logic.)

- [ ] Test-first on the hook (placeholder added → appears; real comment with matching `databaseId` arrives → deduped; prune on refetch-gen + fallback timer), then move, then full suite, commit — `refactor(fe): extract useOptimisticComments from FilesTab (for #327)`.

### Task 11: `useInlineComposer` extraction

**Files:** Create `frontend/src/components/PrDetail/FilesTab/useInlineComposer.ts` + test; Modify `FilesTab.tsx` (`:378-494` — `activeAnchor`, `composerDraftId`, `activeComposerFlushRef`, `findExistingDraft`, `openComposerAt`, `handleLineClick`, `handleComposerClose`).

**Interfaces (Produces):**

```ts
export function useInlineComposer(opts: { draftSession: …; prDetail: …; show: … /* exact deps read from today's closures */ }): {
  activeAnchor: InlineAnchor | null;
  composerDraftId: string | null;
  flushRef: MutableRefObject<…>;
  handleLineClick: (anchor: InlineAnchor) => void;  // latest-ref stable identity
  handleComposerClose: () => void;
  openComposerAt: (anchor: InlineAnchor) => void;
};
```

- [ ] Move verbatim; `handleLineClick` gains the latest-ref pattern (stable identity; body reads current state via ref — copy the n/p-handler pattern already in DiffPane). Full suite, commit — `refactor(fe): extract useInlineComposer; stable handleLineClick (for #327)`.

### Task 12: Composite `activeComposerKey` + stable `renderComposerForLine`

**Files:** Modify `FilesTab.tsx` (`renderComposerForLine` `:513` becomes `useCallback` reading anchor/placeholders via refs), `DiffPane.tsx` (new `activeComposerKey: string | null` prop, forwarded into both bodies), `UnifiedDiffBody.tsx` (derive per-row `isComposerLocation` boolean → `DiffLineRow` prop), `SplitDiffBody.tsx` (body-level memo break suffices — composer rows are emitted at body level), `DiffLineRow.tsx` (new optional `isComposerLocation?: boolean` prop — participates in shallow compare, may be unused in the body).

**Key computation (in FilesTab):**

```ts
const activeComposerKey = useMemo(() => {
  const locs = new Set<string>();
  if (activeAnchor) locs.add(`${activeAnchor.filePath}:${activeAnchor.lineNumber}`);
  for (const o of optimistic) if (!o.threadId) locs.add(`${o.filePath}:${o.line}`); // un-deduped new-inline placeholders — match today's field names
  return locs.size ? [...locs].sort().join('|') : null;
}, [activeAnchor, optimistic]);
```

- [ ] **Step 1 (test-first): render-count test** `FilesTab.renderCount.perf.test.tsx` per spec acceptance 3: (a) typing spanning an autosave refetch (drive `draftSession.refetch` resolution) re-renders no `DiffLineRow` with unchanged thread data; (b) inverse: click line → composer row mounts; close → unmounts; (c) reply-path inverse: `optimisticByThread` change surfaces in the affected `ExistingCommentWidget`. Use the `rowMemo.perf` harness pattern (module-mock a row-internal component to count renders). Expect (a) to FAIL before stabilization, (b)/(c) to PASS (they pin current behavior first).
- [ ] **Step 2: implement** stable `renderComposerForLine` + the key threading. All three assertions green. Full suite. Commit — `perf(fe): stable renderComposerForLine + composite activeComposerKey; diff body memo now bails (for #327, delivers half of #688 item 2)`.

### Task 13: `replyContext` split (stable-callbacks bag + per-thread data channel)

**Files:** Modify `FilesTab.tsx` (`replyContext` memo `:629-679`), `ExistingCommentWidget.tsx`/`ThreadView` (consume the split), possibly a small `ReplyDataContext` (React context) in `frontend/src/components/PrDetail/FilesTab/`.

Per spec constraints: callbacks bag latest-ref-backed (5 callbacks); per-thread data (draft replies find, `optimisticByThread` lookup, `draftComments`) flows through a React-context (or `useSyncExternalStore`) channel delivering **per-thread slices with stable identity when unchanged** — NOT a ref read (stales on cross-tab draft arrival) and NOT a per-row prop (churns on every autosave). Reply-composer open/close stays widget-local (verify while implementing; it is today).

- [ ] Test-first: extend Task 12's test (c) to span an autosave refetch altering ONE thread's draft-reply state → only that widget re-renders/reflects it. Implement, full suite, commit — `refactor(fe): split replyContext into stable callbacks + per-thread data channel (for #327)`.

### Task 14: Handler-convention sweep + slice-2 gate

- [ ] Everything crossing a memoized boundary is `useCallback`/stable (audit `FilesTab.tsx` for remaining plain functions passed to DiffPane/FileTree); local-only helpers may stay plain. Full suite + tsc -b + lint. DiffPane suites + FilesTab suites green; `useViewportWidth` gone. Commit; orchestrator runs /simplify + checklist + PR 2 (cross-reference #688 item 2 in the body).

---

## SLICE 3 — PrHeader (PR 3; cut branch AFTER PR 2 merges)

### Task 15: `submitErrorMessage` → `api/submit.ts` (pure function + test)

**Files:** Modify `frontend/src/api/submit.ts` (export `submitErrorMessage(err: SubmitConflictError): string` next to `KnownSubmitErrorCode`, body moved verbatim from `PrHeader.tsx:333-373`), `PrHeader.tsx` (import it); Test: `frontend/src/api/submit.test.ts` (or the existing api test file pattern) — one case per `KnownSubmitErrorCode` + the default branch.

- [ ] Test-first (red: function absent) → move → green → full suite → commit — `refactor(fe): submitErrorMessage is a pure api/submit helper (for #327)`.

### Task 16: `useSubmitFlow` extraction

**Files:** Create `frontend/src/components/PrDetail/useSubmitFlow.ts` + test; Modify `PrHeader.tsx` (`:279-451` — the two effects, `patchVerdict`, `onResume`, `surfaceSubmitError`, `surfaceForeignReviewError`, `onResumeForeignPendingReview`, `onDiscardForeignPendingReview`, `onDiscardAllDrafts`, `handlePillDiscard`).

**Interfaces (Produces):**

```ts
export function useSubmitFlow(opts: {
  reference: PrReference; session: …; onSessionRefetch: () => void; show: …; // exact types read from PrHeader's current usage
}): {
  onResume: () => void;
  onResumeForeignPendingReview: () => void;
  onDiscardForeignPendingReview: () => void;
  onDiscardAllDrafts: () => void;
  handlePillDiscard: (…) => void;
  patchVerdict: (…) => void;
  // + any state the layout reads (enumerate from PrHeader's render usage while moving)
};
```

- [ ] Move verbatim (hook test via renderHook covering resume + discard-all + foreign-review surfacing with mocked api); `PrHeader.test.tsx`/`PrHeader.actions.test.tsx` unmodified and green — they are the real guard. Full suite; commit — `refactor(fe): extract useSubmitFlow; PrHeader is layout + action row (for #327)`.

### Task 17: Slice-3 gate

- [ ] Full frontend suite + tsc -b + lint; PrHeader free of orchestration (only layout + hook consumption + action row). Orchestrator: /simplify, checklist, PR 3 with `Closes #327`.

---

## Self-review notes (spec-coverage check done at write time)

- Spec §Slice 1 items → Tasks 1-7 (annotation ×4 → T2; handleClick ×3+1 → T4; sibling moves → T3-T4; latch → T1; bodies+memo phasing → T5; prUrl → T6; ≤400 lines → T7).
- Spec §Slice 2 → Tasks 8-14 (matchMedia caveat → T8 step 1 runs BEFORE consumer swap by design; buildTree → T9; optimistic → T10; composer lifecycle → T11; composite key + render-count a/b → T12; replyContext + (c) → T13; conventions → T14).
- Spec §Slice 3 → Tasks 15-17.
- Deferred questions resolved here: repo-wide stub upgrade = YES (T8); `useIsSplitCapable` wrapper = YES; reply open/close stays widget-local (T13 verifies); `DiffTruncationBanner` prop renames (T6).
