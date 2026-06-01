# Whole-file context expansion (P4-B8 slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-file "Show full file" toggle to the DiffPane toolbar that fetches the file at the relevant SHA(s) and interleaves it with the existing hunks, rendering the full file with the diff highlighted in place.

**Architecture:** Orthogonal layer on slice 1's renderer. `FilesTab` owns a `Set<string>` of paths in whole-file mode + the toolbar button. `DiffPane` consumes `wholeFileEnabled` + new `headSha`/`baseSha` props, fires a new lazy `useWholeFileContent` hook (raw `fetch()` because `/file` returns `text/plain`), and uses a pure `interleaveWholeFile` function to extend `DiffLine[]` across the full file. Failure paths surface a `<WholeFileFailureBanner>` via a DiffPane-local `failureReason` latch that survives the toggle-revert.

**Tech Stack:** React 19 + TypeScript + Vite + CSS Modules + Vitest + Playwright. Backend untouched except for a single test-hooks force-failure endpoint.

**Reference:** Spec at `docs/specs/2026-06-01-whole-file-context-expansion-design.md`. Deferrals sidecar at `docs/specs/2026-06-01-whole-file-context-expansion-deferrals.md`.

---

## File structure

**New files (5):**
- `frontend/src/hooks/useWholeFileContent.ts` — hook
- `frontend/__tests__/useWholeFileContent.test.ts` — 6 hook cases
- `frontend/src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile.ts` — pure function extracted from DiffPane (lives as a sibling module so it can be unit-tested without React)
- `frontend/__tests__/interleaveWholeFile.test.ts` — 5 algorithm cases
- `frontend/src/components/PrDetail/FilesTab/DiffPane/WholeFileFailureBanner.tsx` — banner component

**Modified files (10):**
- `frontend/src/api/types.ts` — `DiffLine` interface gains `isFilled?: true` (move the interface from DiffPane.tsx local to types.ts since it's now exported for the pure function)
- `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` — interleave call site, hook call, failure latch, render branches, row-prop threading, hunk-header skip, AI annotation re-anchoring
- `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` — `[data-fill="true"]` selector, `.diffPaneBodyLoading`, `.diffPaneLoadingOverlay`
- `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — `wholeFilePaths` state, toolbar button, DSx11 gate, `handleWholeFileFailed`, DiffPane prop wiring
- `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` — extract `.toolbarToggleButton` shape from `.diffModeToggle`; add `.wholeFileToggle`
- `frontend/__tests__/DiffPane.test.tsx` — 4 new cases
- `frontend/__tests__/FilesTab.test.tsx` — 5 new cases
- `frontend/e2e/parity-baselines.spec.ts` — new whole-file functional scenario + parity baseline assertion
- `PRism.Web/TestHooks/TestEndpoints.cs` — `/test/file/force-failure` POST
- `PRism.Web/TestHooks/FakePrReader.cs` — honor the registered force-failure mapping on next `GetFileContentAsync`

**New parity baseline (1):**
- `frontend/e2e/__screenshots__/win32/pr-detail-files-diff-whole-file.png`

---

## Task 1: `interleaveWholeFile` pure function + `DiffLine.isFilled` extension

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile.ts`
- Create: `frontend/__tests__/interleaveWholeFile.test.ts`
- Modify: `frontend/src/api/types.ts` (extend `DiffLine` — but `DiffLine` is currently local to `DiffPane.tsx`; move it to types.ts in step 1)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (re-import `DiffLine` from types; remove local declaration)

- [ ] **Step 1: Move `DiffLine` to `types.ts` and add `isFilled` flag**

Add to `frontend/src/api/types.ts` after the existing `FileChange` block:

```ts
export interface DiffLine {
  type: 'context' | 'insert' | 'delete' | 'hunk-header';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
  isFilled?: true;
}
```

Remove the local `interface DiffLine { ... }` declaration from `DiffPane.tsx` (lines 50-55). Add `DiffLine` to the existing `from '../../../../api/types'` import block at the top of DiffPane.tsx.

- [ ] **Step 2: Write the failing tests**

Create `frontend/__tests__/interleaveWholeFile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { FileChange } from '../src/api/types';
import { interleaveWholeFile, parseHunkLines } from '../src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile';

function modifiedFile(hunks: FileChange['hunks']): FileChange {
  return { path: 'src/a.ts', status: 'modified', hunks };
}

describe('interleaveWholeFile', () => {
  it('1. single hunk spanning whole file — output matches parseHunkLines (no filled lines)', () => {
    const file = modifiedFile([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, body: '@@ -1,2 +1,3 @@\n a\n+b\n c' },
    ]);
    const headContent = 'a\nb\nc';
    const result = interleaveWholeFile(file, headContent, null);
    const expected = parseHunkLines(file.hunks[0].body);
    expect(result).toEqual(expected);
    expect(result.every((l) => !l.isFilled)).toBe(true);
  });

  it('2. single hunk in middle — leading and trailing gaps are filled-context', () => {
    const file = modifiedFile([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, body: '@@ -3,1 +3,2 @@\n-old\n+new1\n+new2' },
    ]);
    const headContent = 'line1\nline2\nnew1\nnew2\nline5';
    const result = interleaveWholeFile(file, headContent, null);
    expect(result[0]).toMatchObject({ type: 'context', content: 'line1', oldLineNum: 1, newLineNum: 1, isFilled: true });
    expect(result[1]).toMatchObject({ type: 'context', content: 'line2', oldLineNum: 2, newLineNum: 2, isFilled: true });
    expect(result.find((l) => l.content === 'line5')).toMatchObject({
      type: 'context',
      oldLineNum: 4,
      newLineNum: 5,
      isFilled: true,
    });
  });

  it('3. multiple hunks with gaps — oldLineNum derivations correct across hunks', () => {
    const file = modifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, body: '@@ -2,1 +2,2 @@\n-x\n+y\n+z' },
      { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1, body: '@@ -5,1 +6,1 @@\n-p\n+q' },
    ]);
    const headContent = 'a\ny\nz\nb\nc\nq\nd';
    const result = interleaveWholeFile(file, headContent, null);
    const gap2 = result.find((l) => l.content === 'b' && l.isFilled);
    expect(gap2).toMatchObject({ oldLineNum: 3, newLineNum: 4 });
    const gap3 = result.find((l) => l.content === 'c' && l.isFilled);
    expect(gap3).toMatchObject({ oldLineNum: 4, newLineNum: 5 });
    const trailing = result.find((l) => l.content === 'd' && l.isFilled);
    expect(trailing).toMatchObject({ oldLineNum: 6, newLineNum: 7 });
  });

  it('4. leading gap — hunk does not start at line 1', () => {
    const file = modifiedFile([
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, body: '@@ -5,1 +5,1 @@\n-old\n+new' },
    ]);
    const headContent = 'l1\nl2\nl3\nl4\nnew';
    const result = interleaveWholeFile(file, headContent, null);
    expect(result.slice(0, 4)).toEqual([
      { type: 'context', content: 'l1', oldLineNum: 1, newLineNum: 1, isFilled: true },
      { type: 'context', content: 'l2', oldLineNum: 2, newLineNum: 2, isFilled: true },
      { type: 'context', content: 'l3', oldLineNum: 3, newLineNum: 3, isFilled: true },
      { type: 'context', content: 'l4', oldLineNum: 4, newLineNum: 4, isFilled: true },
    ]);
  });

  it('5. trailing gap — file longer than last hunk range; trailing-newline-terminated content emits one extra empty filled row', () => {
    const file = modifiedFile([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    const headContent = 'new\ntail1\ntail2\n';
    const result = interleaveWholeFile(file, headContent, null);
    const trail = result.filter((l) => l.isFilled);
    expect(trail.map((l) => l.content)).toEqual(['tail1', 'tail2', '']);
    expect(trail[0]).toMatchObject({ oldLineNum: 2, newLineNum: 2 });
    expect(trail[1]).toMatchObject({ oldLineNum: 3, newLineNum: 3 });
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `npm test -- interleaveWholeFile`
Expected: All 5 fail because `interleaveWholeFile` does not exist.

- [ ] **Step 4: Extract `parseHunkLines` to the new module and implement `interleaveWholeFile`**

Create `frontend/src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile.ts`:

```ts
import type { DiffLine, FileChange } from '../../../../api/types';

export function parseHunkLines(body: string): DiffLine[] {
  const rawLines = body.split('\n');
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(raw);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ type: 'hunk-header', content: raw, oldLineNum: null, newLineNum: null });
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'insert', content: raw.slice(1), oldLineNum: null, newLineNum: newLine });
      newLine++;
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'delete', content: raw.slice(1), oldLineNum: oldLine, newLineNum: null });
      oldLine++;
    } else if (raw.startsWith(' ')) {
      lines.push({ type: 'context', content: raw.slice(1), oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return lines;
}

export function interleaveWholeFile(
  file: FileChange,
  headContent: string,
  // baseContent reserved for split-mode parity checks (test § 9.1 case 5 uses it implicitly via the contract);
  // current implementation derives oldLineNum from cumulative-shift arithmetic per spec § 5.4, so baseContent
  // is not consulted. Kept in the signature so split callers can opt into byte-comparison if a future
  // verification pass needs it. Until then, callers can pass null.
  _baseContent: string | null,
): DiffLine[] {
  const out: DiffLine[] = [];
  const headLines = headContent.split('\n');
  let prevNewEnd = 0;
  let prevOldEnd = 0;

  for (const hunk of file.hunks) {
    for (let n = prevNewEnd + 1; n < hunk.newStart; n++) {
      out.push({
        type: 'context',
        content: headLines[n - 1] ?? '',
        oldLineNum: prevOldEnd + (n - prevNewEnd),
        newLineNum: n,
        isFilled: true,
      });
    }
    out.push(...parseHunkLines(hunk.body));
    prevNewEnd = hunk.newStart + hunk.newLines - 1;
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }

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

Update `DiffPane.tsx`: remove the local `parseHunkLines` declaration (lines 57-90) and add `import { parseHunkLines, interleaveWholeFile } from './interleaveWholeFile';` to the imports.

- [ ] **Step 5: Run tests to confirm pass**

Run: `npm test -- interleaveWholeFile`
Expected: All 5 pass.

Also run the existing DiffPane tests to confirm the parseHunkLines extraction didn't break anything: `npm test -- DiffPane`
Expected: existing 9 cases still pass.

- [ ] **Step 6: Run prettier on new files**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile.ts frontend/__tests__/interleaveWholeFile.test.ts frontend/src/api/types.ts frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
Expected: any formatting normalized before commit.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts \
        frontend/src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile.ts \
        frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx \
        frontend/__tests__/interleaveWholeFile.test.ts
git commit -m "feat(diff): interleaveWholeFile pure function + DiffLine.isFilled flag"
```

---

## Task 2: `useWholeFileContent` hook

**Files:**
- Create: `frontend/src/hooks/useWholeFileContent.ts`
- Create: `frontend/__tests__/useWholeFileContent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/__tests__/useWholeFileContent.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { FileChange, PrReference } from '../src/api/types';
import { useWholeFileContent } from '../src/hooks/useWholeFileContent';

const prRef: PrReference = { owner: 'o', repo: 'r', number: 1 };
const modifiedFile: FileChange = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' }],
};

function mockFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
}

function okText(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function problem(type: string, status: number): Response {
  return new Response(JSON.stringify({ type }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

describe('useWholeFileContent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. enabled false → idle, no fetch fired', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const { result } = renderHook(() =>
      useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled: false, isSplit: false }),
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('2. unified, 200 head → ok with headContent', async () => {
    mockFetch(async (url) => {
      expect(url).toContain('sha=h');
      return okText('a\nb\nc');
    });
    const { result } = renderHook(() =>
      useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled: true, isSplit: false }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect(result.current.headContent).toBe('a\nb\nc');
    expect(result.current.baseContent).toBeNull();
  });

  it('3. split, 200 head + 200 base → ok with both contents', async () => {
    mockFetch(async (url) =>
      url.includes('sha=h') ? okText('new-content') : okText('old-content'),
    );
    const { result } = renderHook(() =>
      useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled: true, isSplit: true }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect(result.current.headContent).toBe('new-content');
    expect(result.current.baseContent).toBe('old-content');
  });

  it('4. unified, 413 head → failed with mapped reason', async () => {
    mockFetch(async () => problem('/file/too-large', 413));
    const { result } = renderHook(() =>
      useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled: true, isSplit: false }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('failed'));
    expect(result.current.failureReason).toBe('file is too large to expand');
  });

  it('5. split, 200 head + 413 base → failed with old-side prefix', async () => {
    mockFetch(async (url) =>
      url.includes('sha=h') ? okText('new-content') : problem('/file/too-large', 413),
    );
    const { result } = renderHook(() =>
      useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled: true, isSplit: true }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('failed'));
    expect(result.current.failureReason).toBe('old-side file is too large to expand');
  });

  it('6. cache reuse: same key after re-enable does not re-fetch', async () => {
    const fetchSpy = vi.fn(async () => okText('cached-content')) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useWholeFileContent({ prRef, path: 'src/a.ts', file: modifiedFile, headSha: 'h', baseSha: 'b', enabled, isSplit: false }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    const initialCalls = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length;
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm test -- useWholeFileContent`
Expected: All 6 fail because `useWholeFileContent` does not exist.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useWholeFileContent.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, PrReference } from '../api/types';

export interface UseWholeFileContentInput {
  prRef: PrReference;
  path: string | null;
  file: FileChange | null;
  headSha: string;
  baseSha: string;
  enabled: boolean;
  isSplit: boolean;
}

export interface UseWholeFileContentResult {
  fetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  headContent: string | null;
  baseContent: string | null;
  failureReason: string | null;
}

interface CacheValue {
  kind: 'ok' | 'failed';
  headContent?: string;
  baseContent?: string;
  failureReason?: string;
}

function mapProblemType(type: string | undefined): string {
  switch (type) {
    case '/file/too-large':
      return 'file is too large to expand';
    case '/file/binary':
      return 'file is binary';
    case '/file/missing':
      return 'file not present at this revision';
    case '/file/not-in-diff':
    case '/file/truncation-window':
      return 'file not available in current diff snapshot';
    case '/file/snapshot-evicted':
      return 'diff snapshot has been evicted — reload the PR';
    default:
      return 'could not load file';
  }
}

async function fetchOne(prRef: PrReference, path: string, sha: string, signal: AbortSignal): Promise<{ kind: 'ok'; content: string } | { kind: 'failed'; reason: string }> {
  const url = `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/file?path=${encodeURIComponent(path)}&sha=${sha}`;
  let resp: Response;
  try {
    resp = await fetch(url, { credentials: 'include', signal });
  } catch (_err) {
    return { kind: 'failed', reason: 'could not load file' };
  }
  if (resp.ok) {
    return { kind: 'ok', content: await resp.text() };
  }
  let problemType: string | undefined;
  try {
    const body = (await resp.json()) as { type?: string };
    problemType = body.type;
  } catch (_err) {
    /* malformed problem details — fall through to default reason */
  }
  return { kind: 'failed', reason: mapProblemType(problemType) };
}

export function useWholeFileContent(input: UseWholeFileContentInput): UseWholeFileContentResult {
  const { prRef, path, file, headSha, baseSha, enabled, isSplit } = input;
  const cacheRef = useRef<Map<string, CacheValue>>(new Map());
  const [state, setState] = useState<UseWholeFileContentResult>({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  });

  const inactive = useMemo(
    () =>
      !enabled ||
      path === null ||
      file === null ||
      file.status !== 'modified' ||
      file.hunks.length === 0,
    [enabled, path, file],
  );

  useEffect(() => {
    if (inactive || path === null) {
      setState({ fetchStatus: 'idle', headContent: null, baseContent: null, failureReason: null });
      return;
    }
    const key = `${path}::${headSha}::${baseSha}::${isSplit}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      if (cached.kind === 'ok') {
        setState({
          fetchStatus: 'ok',
          headContent: cached.headContent ?? null,
          baseContent: cached.baseContent ?? null,
          failureReason: null,
        });
      } else {
        setState({
          fetchStatus: 'failed',
          headContent: null,
          baseContent: null,
          failureReason: cached.failureReason ?? 'could not load file',
        });
      }
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setState({ fetchStatus: 'loading', headContent: null, baseContent: null, failureReason: null });

    (async () => {
      const headPromise = fetchOne(prRef, path, headSha, controller.signal);
      const basePromise = isSplit ? fetchOne(prRef, path, baseSha, controller.signal) : Promise.resolve({ kind: 'ok', content: '' } as const);
      const [headResult, baseResult] = await Promise.all([headPromise, basePromise]);

      let value: CacheValue;
      if (headResult.kind === 'failed' && (!isSplit || baseResult.kind === 'ok')) {
        value = {
          kind: 'failed',
          failureReason: isSplit ? `new-side ${headResult.reason}` : headResult.reason,
        };
      } else if (isSplit && baseResult.kind === 'failed' && headResult.kind === 'ok') {
        value = {
          kind: 'failed',
          failureReason: `old-side ${baseResult.reason}`,
        };
      } else if (isSplit && baseResult.kind === 'failed' && headResult.kind === 'failed') {
        value = {
          kind: 'failed',
          failureReason: `new-side ${headResult.reason}`,
        };
      } else if (headResult.kind === 'ok') {
        value = {
          kind: 'ok',
          headContent: headResult.content,
          baseContent: isSplit && baseResult.kind === 'ok' ? baseResult.content : undefined,
        };
      } else {
        value = { kind: 'failed', failureReason: 'could not load file' };
      }

      cacheRef.current.set(key, value);
      if (cancelled) return;
      if (value.kind === 'ok') {
        setState({
          fetchStatus: 'ok',
          headContent: value.headContent ?? null,
          baseContent: value.baseContent ?? null,
          failureReason: null,
        });
      } else {
        setState({
          fetchStatus: 'failed',
          headContent: null,
          baseContent: null,
          failureReason: value.failureReason ?? 'could not load file',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [inactive, path, headSha, baseSha, isSplit, prRef]);

  return state;
}
```

**Plan deviation from spec § 6.3 — X-PRism-Session / X-PRism-Tab-Id headers omitted.** The spec's fetch snippet includes these headers; the plan drops them based on middleware analysis:

- `SessionTokenMiddleware` enforces session auth on `/api/*` paths but only on mutating verbs (POST/PUT/PATCH/DELETE) — `GET /file` is a read endpoint and is not enforced (verified by reading `PRism.Web/Middleware/SessionTokenMiddleware.cs` + `TestEndpoints.cs` notes).
- `OriginCheckMiddleware` applies only to POST/PUT/PATCH/DELETE — GET requests skip the check.
- `credentials: 'include'` on the raw `fetch()` carries the auth cookie, which is what GitHub-PAT-mode auth relies on.

The spec author's "hook reads sessionId/tabId from the auth context" wording was speculative — in this codebase, that context is set up inside `apiClient` and isn't trivially re-usable from a raw `fetch()` call. Implementing the headers would require either (a) exporting the session/tab IDs from a shared module, or (b) gaining access via a new context hook, both of which expand scope. Slice 2 ships without the headers based on the middleware analysis above. **Reviewer-facing flag:** if `OriginCheckMiddleware` or `SessionTokenMiddleware` is later tightened to enforce on GETs, the hook needs to be revisited.

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- useWholeFileContent`
Expected: All 6 pass.

- [ ] **Step 5: Run prettier**

Run: `npx prettier --write frontend/src/hooks/useWholeFileContent.ts frontend/__tests__/useWholeFileContent.test.ts`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useWholeFileContent.ts frontend/__tests__/useWholeFileContent.test.ts
git commit -m "feat(diff): useWholeFileContent hook with lazy fetch + cache + cancellation"
```

---

## Task 3: `WholeFileFailureBanner` component

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/WholeFileFailureBanner.tsx`
- (No dedicated test file — covered by DiffPane integration tests in Task 9)

- [ ] **Step 1: Create the component**

Create `frontend/src/components/PrDetail/FilesTab/DiffPane/WholeFileFailureBanner.tsx`:

```tsx
export interface WholeFileFailureBannerProps {
  reason: string;
  onDismiss: () => void;
}

export function WholeFileFailureBanner({ reason, onDismiss }: WholeFileFailureBannerProps) {
  return (
    <div
      className="banner banner-warning"
      role="alert"
      data-testid="whole-file-failure-banner"
    >
      <span>Whole-file view unavailable: {reason}</span>
      <button
        type="button"
        className="banner-dismiss"
        aria-label="Dismiss whole-file error banner"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
```

The `banner` / `banner-warning` / `banner-dismiss` global classes already exist in `frontend/src/styles/tokens.css` (PR #88 lift); no new CSS is needed for this component.

- [ ] **Step 2: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/DiffPane/WholeFileFailureBanner.tsx`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/WholeFileFailureBanner.tsx
git commit -m "feat(diff): WholeFileFailureBanner component"
```

---

## Task 4: Row-component prop threading (`isFilled` → `data-fill`)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (DiffLineRow + SplitDiffLineRow context kind)

- [ ] **Step 1: Add `isFilled?: boolean` to `DiffLineRowProps` and apply `data-fill` to the `<tr>`**

In `DiffPane.tsx`, locate `interface DiffLineRowProps` (currently at line ~396) and add the optional prop:

```ts
interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  filePath: string;
  colSpan: number;
  isFilled?: boolean;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  replyContext?: ExistingCommentWidgetReplyContext;
}
```

In the `DiffLineRow` function body, destructure `isFilled` and apply the attribute to the `<tr>`:

```tsx
function DiffLineRow({
  line,
  pair,
  threadsAtLine,
  filePath,
  colSpan,
  isFilled,
  onLineClick,
  renderComposerForLine,
  replyContext,
}: DiffLineRowProps) {
  // ...
  return (
    <>
      <tr className={rowClass} {...(isFilled ? { 'data-fill': 'true' } : {})}>
        {/* ... existing cells ... */}
      </tr>
      {/* ... existing widget + composer slot rows ... */}
    </>
  );
}
```

- [ ] **Step 2: Add `isFilled?: boolean` to `SplitDiffLineRowProps` and apply `data-fill` to the `context` kind only**

```ts
interface SplitDiffLineRowProps {
  kind: SplitRowKind;
  oldLineNum?: number | null;
  newLineNum?: number | null;
  oldText?: string;
  newText?: string;
  content?: string;
  filePath: string;
  isFilled?: boolean;
  onLineClick?: (anchor: InlineAnchor) => void;
}
```

In `SplitDiffLineRow`'s `context` branch, apply the attribute:

```tsx
if (kind === 'context') {
  // ... existing handleClick ...
  return (
    <tr
      className="diff-line diff-line--context"
      {...(isFilled ? { 'data-fill': 'true' } : {})}
    >
      {/* ... existing cells ... */}
    </tr>
  );
}
```

Other split kinds (`header`, `paired`, `solo-delete`, `solo-insert`) never originate from filled context — they only appear inside hunks. `isFilled` is undefined for them and ignored.

- [ ] **Step 3: Run existing DiffPane tests to confirm no regression**

Run: `npm test -- DiffPane`
Expected: existing 9 cases still pass (the prop is optional; no existing test passes it).

- [ ] **Step 4: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx
git commit -m "feat(diff): isFilled prop threading on row components (data-fill attribute)"
```

---

## Task 5: `DiffPane` integration

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`

This is the largest task in the plan — it integrates the hook, adds prop threading, adds the failure latch, adds the loading state, adds the AI annotation re-anchoring, and adds the whole-file render branch. Steps are small but numerous.

- [ ] **Step 1: Add new imports**

At the top of `DiffPane.tsx`:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';
import { WholeFileFailureBanner } from './WholeFileFailureBanner';
```

(`useRef`, `useState`, `useEffect` are net-new beyond the existing `useMemo` import.)

- [ ] **Step 2: Extend `DiffPaneProps`**

All four slice-2 additions are OPTIONAL with safe defaults. This is load-bearing: `DiffPane.test.tsx` has 21 inline render sites and no `renderDiffPane` helper. Making the props required would force a 21-site test migration in this PR. Optional props preserve existing test compatibility — when `wholeFileEnabled` defaults to false, the hook returns `'idle'`, the failure latch never fires, and the SHAs are never used.

```ts
export interface DiffPaneProps {
  // ... existing props ...
  isLoading?: boolean;

  // Slice 2 additions (all optional with defaults — see step 3 destructuring):
  wholeFileEnabled?: boolean;
  onWholeFileFailed?: (reason: string) => void;
  headSha?: string;
  baseSha?: string;
}
```

- [ ] **Step 3: Destructure new props + call the hook**

**Hook-ordering rule:** ALL new hooks added in Task 5 (the `useWholeFileContent` call here, the `useState` + `useRef` + `useEffect` for the failure latch in step 4, the `useMemo` for `allLines` in step 5, the `useMemo` for `annotationsByRowIdx` in step 6, and the `useRef` + `useEffect` for scroll reset in step 9) MUST be placed above the existing `if (!selectedPath)` guard at line 132, immediately after the existing `annotationsForFile` useMemo at line 121. React's Rules of Hooks require unconditional same-order hook calls; dropping any new hook below an early-return guard will trigger a "Rendered fewer hooks than expected" error on the first guard-hit path.

Update the `DiffPane` function signature and add the hook call right after the existing `useAiHunkAnnotations` call:

```tsx
export function DiffPane({
  prRef,
  selectedPath,
  file,
  diffMode,
  truncated,
  reviewThreads,
  prUrl,
  onLineClick,
  renderComposerForLine,
  replyContext,
  isLoading = false,
  wholeFileEnabled = false,
  onWholeFileFailed,
  headSha = '',
  baseSha = '',
}: DiffPaneProps) {
  const annotationsEnabled = useAiGate('hunkAnnotations');
  const allAnnotations = useAiHunkAnnotations(prRef, annotationsEnabled);

  const isSplit = diffMode === 'side-by-side';

  const wholeFile = useWholeFileContent({
    prRef,
    path: selectedPath,
    file,
    headSha,
    baseSha,
    enabled: wholeFileEnabled,
    isSplit,
  });

  // ... rest of the function ...
}
```

Move the `const isSplit = ...` declaration up before the hook call (it currently lives further down at line 189).

- [ ] **Step 4: Add the failure latch + callback fire-once useEffect**

After the hook call:

```tsx
const [localFailure, setLocalFailure] = useState<string | null>(null);
const prevStatus = useRef<typeof wholeFile.fetchStatus>('idle');

useEffect(() => {
  if (prevStatus.current !== 'failed' && wholeFile.fetchStatus === 'failed' && wholeFile.failureReason) {
    setLocalFailure(wholeFile.failureReason);
    onWholeFileFailed?.(wholeFile.failureReason);
  }
  prevStatus.current = wholeFile.fetchStatus;
}, [wholeFile.fetchStatus, wholeFile.failureReason, onWholeFileFailed]);

const dismissBanner = () => {
  // Capture the reason BEFORE the state clear — `localFailure` is closed
  // over from the render-time state value, so reading it after the
  // setLocalFailure(null) enqueue would still yield the old value here, but
  // the explicit capture makes the intent unambiguous to future readers.
  const reason = localFailure;
  setLocalFailure(null);
  if (selectedPath && reason) onWholeFileFailed?.(reason);
};
```

- [ ] **Step 5: Build the `allLines` accumulator with whole-file branching**

Replace the existing `const allLines: DiffLine[] = []; for (const hunk of file.hunks) { allLines.push(...parseHunkLines(hunk.body)); }` with:

```ts
const allLines: DiffLine[] = useMemo(() => {
  if (!file) return [];
  if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && wholeFile.headContent !== null) {
    return interleaveWholeFile(file, wholeFile.headContent, wholeFile.baseContent);
  }
  const out: DiffLine[] = [];
  for (const hunk of file.hunks) {
    out.push(...parseHunkLines(hunk.body));
  }
  return out;
}, [file, wholeFileEnabled, wholeFile.fetchStatus, wholeFile.headContent, wholeFile.baseContent]);
```

(Wrap in `useMemo` so the array isn't recomputed every render.)

The existing `file === null` and `file.hunks.length === 0` short-circuits stay above this block (they return JSX directly before allLines is built).

- [ ] **Step 6: Add AI annotation re-anchoring map for whole-file mode**

After the `allLines` computation:

```ts
const annotationsByRowIdx = useMemo(() => {
  if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') return null;
  const map = new Map<number, HunkAnnotation[]>();
  const consumedHunks = new Set<number>();
  let hunkCounter = -1;
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];
    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      continue;
    }
    if (hunkCounter >= 0 && !consumedHunks.has(hunkCounter)) {
      const ann = annotationsForFile?.get(hunkCounter);
      if (ann) map.set(idx, ann);
      consumedHunks.add(hunkCounter);
    }
  }
  return map;
}, [wholeFileEnabled, wholeFile.fetchStatus, allLines, annotationsForFile]);
```

- [ ] **Step 7: Wire whole-file annotation rendering into `renderUnifiedRows`**

In `renderUnifiedRows`, replace the existing hunk-annotation emission (currently in the `if (line.type === 'hunk-header')` block) with whole-file-aware logic. The new flow inside the loop:

```tsx
function renderUnifiedRows(): React.ReactNode[] {
  const path = selectedPath ?? '';
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
        // Emit hunk-header row + per-hunk annotations as today.
        // (Existing DiffLineRow push + annotation emission code stays here.)
      }
      // In whole-file ok mode: do NOT emit hunk-header <tr>. Annotations
      // for this hunk are attached to the first non-header row of the
      // hunk via annotationsByRowIdx (see whole-file-mode emission below).
      continue;
    }

    // Whole-file mode: emit any annotations queued for this idx BEFORE the row.
    if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
      const ann = annotationsByRowIdx.get(idx);
      if (ann) {
        for (let aidx = 0; aidx < ann.length; aidx++) {
          rows.push(
            <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
              <td colSpan={colSpan}>
                <AiHunkAnnotation annotation={ann[aidx]} />
              </td>
            </tr>,
          );
        }
      }
    }

    const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
    const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
    const pair = findAdjacentPair(allLines, idx);

    rows.push(
      <DiffLineRow
        key={idx}
        line={line}
        pair={pair}
        threadsAtLine={threadsAtLine}
        filePath={path}
        colSpan={colSpan}
        isFilled={line.isFilled}
        onLineClick={onLineClick}
        renderComposerForLine={renderComposerForLine}
        replyContext={replyContext}
      />,
    );
  }
  return rows;
}
```

The shape preserves slice 1's hunks-only behavior verbatim (the `if (!wholeFileEnabled || …)` block contains today's hunk-header + annotation emission). The whole-file branches add the annotation-before-row pattern.

- [ ] **Step 8: Same change in `renderSplitRows`**

Apply the symmetric change to `renderSplitRows`. The hunk-header row in slice 1 is emitted via `<SplitDiffLineRow kind="header" …>`. In whole-file mode, that line gets skipped. The annotation-before-row pattern works the same.

```tsx
function renderSplitRows(): React.ReactNode[] {
  // ... existing path, rows, hunkCounter, emitWidgetAndComposerRows helper ...

  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
        rows.push(
          <SplitDiffLineRow key={idx} kind="header" content={line.content} filePath={path} />,
        );
        const annotations = annotationsForFile?.get(hunkCounter);
        if (annotations) {
          for (let aidx = 0; aidx < annotations.length; aidx++) {
            rows.push(
              <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkAnnotation annotation={annotations[aidx]} />
                </td>
              </tr>,
            );
          }
        }
      }
      continue;
    }

    if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
      const ann = annotationsByRowIdx.get(idx);
      if (ann) {
        for (let aidx = 0; aidx < ann.length; aidx++) {
          rows.push(
            <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
              <td colSpan={colSpan}>
                <AiHunkAnnotation annotation={ann[aidx]} />
              </td>
            </tr>,
          );
        }
      }
    }

    // ... existing context / delete-pair / delete / insert branches ...
    // Pass isFilled to SplitDiffLineRow for the `context` kind:
    //   <SplitDiffLineRow ... isFilled={line.isFilled} ... />
  }
  return rows;
}
```

In the existing `context` branch of the loop, add `isFilled={line.isFilled}` to the `<SplitDiffLineRow kind="context" …>` props.

- [ ] **Step 9: Scroll reset on `wholeFileEnabled` transition**

Add a `useEffect` that resets the `.diffPaneBody` scroll position when `wholeFileEnabled` changes (per spec § 10, prevents jarring snap when toggling off from a scrolled-deep position):

```tsx
const diffBodyRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (diffBodyRef.current) diffBodyRef.current.scrollTop = 0;
}, [wholeFileEnabled, selectedPath]);
```

Attach `ref={diffBodyRef}` to the existing `<div className={`diff-pane-body …`}>` element.

- [ ] **Step 10: Update the JSX render output (failure banner + loading overlay)**

Replace the existing final `return (...)` block of `DiffPane`:

```tsx
return (
  <div className={`diff-pane ${modeClass} ${styles.diffPane}`} data-testid="diff-pane">
    <div className={`diff-pane-header ${styles.diffPaneHeader}`}>
      <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
      {isLoading && (
        <span
          className={`diff-pane-loading muted ${styles.diffPaneLoading}`}
          role="status"
          aria-live="polite"
        >
          Loading…
        </span>
      )}
    </div>
    {localFailure !== null && (
      <WholeFileFailureBanner reason={localFailure} onDismiss={dismissBanner} />
    )}
    <div
      ref={diffBodyRef}
      className={`diff-pane-body ${styles.diffPaneBody} ${
        wholeFileEnabled && wholeFile.fetchStatus === 'loading' ? styles.diffPaneBodyLoading : ''
      }`}
    >
      {wholeFileEnabled && wholeFile.fetchStatus === 'loading' && (
        <div
          role="status"
          aria-live="polite"
          className={styles.diffPaneLoadingOverlay}
        >
          Loading whole file…
        </div>
      )}
      <table className={`diff-table ${styles.diffTable}`}>
        {isSplit && (
          <colgroup>
            <col style={{ width: '3em' }} />
            <col />
            <col style={{ width: '3em' }} />
            <col />
          </colgroup>
        )}
        <tbody>{renderDiffRows()}</tbody>
      </table>
    </div>
    {truncated && <DiffTruncationBanner prUrl={prUrl} />}
  </div>
);
```

- [ ] **Step 11: Run existing DiffPane tests**

Run: `npm test -- DiffPane`
Expected: existing 9 cases still pass. (Updates may require passing the new required props in test setup — see Task 9 step 1 for the standard test-setup updates.)

If tests fail because `wholeFileEnabled` / `onWholeFileFailed` / `headSha` / `baseSha` are missing in the test's `renderDiffPane` helper, update the helper to pass defaults (`wholeFileEnabled: false`, `onWholeFileFailed: () => {}`, `headSha: ''`, `baseSha: ''`). The defaults render the same hunks-only behavior the existing tests assert.

- [ ] **Step 12: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 13: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx \
        frontend/__tests__/DiffPane.test.tsx
git commit -m "feat(diff): DiffPane whole-file integration (hook, latch, render branches)"
```

---

## Task 6: `DiffPane.module.css` rules

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`

- [ ] **Step 1: Add the test-seam selector + loading-state rules**

Append at the end of `DiffPane.module.css`:

```css
/* Slice 2: whole-file context expansion.
   Test seam — filled-context rows carry data-fill="true". No declarations
   ship at slice-2 baseline (Q4a chose no visual distinction); the selector
   exists so DSx7's future minimap or a polish-time tint is a one-line add. */
[data-fill='true'] {
  /* intentionally empty */
}

/* Whole-file fetch loading state — dim the underlying hunks-only diff and
   show a sticky overlay status indicator. Applied via DiffPane.tsx render
   branch when wholeFileEnabled && fetchStatus === 'loading'. */
.diffPaneBodyLoading {
  position: relative;
  opacity: 0.5;
  pointer-events: none;
}
.diffPaneLoadingOverlay {
  position: sticky;
  top: var(--s-2);
  z-index: 2;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  color: var(--text-2);
  font-size: var(--text-sm);
  width: fit-content;
  margin: 0 auto var(--s-3);
}
```

Centering is via `width: fit-content; margin: 0 auto` (block-level auto-margin centering). `align-self: center` was dropped from the original draft because `.diffPaneBody` is not a flex container; the property would have been dead code.

- [ ] **Step 2: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css
git commit -m "feat(diff): DiffPane.module.css rules for data-fill seam and loading overlay"
```

---

## Task 7: `FilesTab.module.css` button class split

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`

- [ ] **Step 1: Extract `.toolbarToggleButton` and add `.wholeFileToggle`**

Replace the existing `.diffModeToggle` block (lines 71-90 of FilesTab.module.css) with:

```css
.toolbarToggleButton {
  flex-shrink: 0;
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: var(--s-1) var(--s-3);
  font-size: var(--text-sm);
  color: var(--text-2);
  cursor: pointer;
}
.toolbarToggleButton[aria-pressed='true'] {
  background: var(--surface-3);
  color: var(--text-1);
  border-color: var(--border-strong);
}
.toolbarToggleButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.diffModeToggle {
  composes: toolbarToggleButton;
  margin-left: auto;
}

.wholeFileToggle {
  composes: toolbarToggleButton;
  margin-left: var(--s-2);
}
```

Existing class consumers in JSX continue to use `styles.diffModeToggle`; behavior is preserved because `composes:` inlines the shape rules.

- [ ] **Step 2: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`

- [ ] **Step 3: Verify existing FilesTab tests still pass**

Run: `npm test -- FilesTab`
Expected: existing 17+ cases still pass (Selectors that target `styles.diffModeToggle` still resolve to a generated hash; the shape is preserved.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.module.css
git commit -m "feat(diff): FilesTab.module.css extract toolbarToggleButton + add wholeFileToggle"
```

---

## Task 8: `FilesTab.tsx` integration

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`

- [ ] **Step 1: Add `wholeFilePaths` state + DSx11 gate**

In `FilesTab` function body, after the existing `diffMode` useState (line 61):

```tsx
const [wholeFilePaths, setWholeFilePaths] = useState<Set<string>>(new Set());

const iterationGatePermits = activeRange === 'all' && selectedCommits === null;
const wholeFileEnabled =
  selectedPath !== null && wholeFilePaths.has(selectedPath) && iterationGatePermits;
```

- [ ] **Step 2: Add toggle handler + failure handler**

```tsx
const handleToggleWholeFile = useCallback(() => {
  if (!selectedPath) return;
  setWholeFilePaths((prev) => {
    const next = new Set(prev);
    if (next.has(selectedPath)) next.delete(selectedPath);
    else next.add(selectedPath);
    return next;
  });
}, [selectedPath]);

const handleWholeFileFailed = useCallback(
  (_reason: string) => {
    if (!selectedPath) return;
    setWholeFilePaths((prev) => {
      if (!prev.has(selectedPath)) return prev;
      const next = new Set(prev);
      next.delete(selectedPath);
      return next;
    });
  },
  [selectedPath],
);
```

- [ ] **Step 3: Add the toolbar button**

In the existing toolbar JSX (line ~371), insert a new button AFTER the existing `.diffModeToggle` button:

```tsx
<button
  type="button"
  className={styles.diffModeToggle}
  aria-pressed={effectiveDiffMode === 'side-by-side'}
  disabled={viewportWidth < 900}
  onClick={handleToggleDiffMode}
>
  {effectiveDiffMode === 'side-by-side' ? 'Side-by-side' : 'Unified'}
</button>
<button
  type="button"
  className={styles.wholeFileToggle}
  aria-pressed={wholeFileEnabled}
  disabled={
    selectedPath === null ||
    !selectedFile ||
    selectedFile.status !== 'modified' ||
    selectedFile.hunks.length === 0 ||
    !iterationGatePermits
  }
  title={
    !iterationGatePermits
      ? "Whole-file view available only on the 'all' iteration view"
      : selectedFile && selectedFile.status !== 'modified'
        ? 'Whole-file view available for modified files only'
        : ''
  }
  onClick={handleToggleWholeFile}
  data-testid="whole-file-toggle"
>
  {wholeFileEnabled ? 'Hunks only' : 'Show full file'}
</button>
```

- [ ] **Step 4: Pass new props to DiffPane**

In the existing `<DiffPane …>` JSX block (line ~414), append the new props:

```tsx
<DiffPane
  prRef={prRef}
  selectedPath={selectedPath}
  file={selectedFile}
  diffMode={effectiveDiffMode}
  truncated={diff.data?.truncated ?? false}
  reviewThreads={fileThreads}
  prUrl={prUrl}
  onLineClick={handleLineClick}
  renderComposerForLine={renderComposerForLine}
  replyContext={replyContext}
  isLoading={diff.isLoading}
  wholeFileEnabled={wholeFileEnabled}
  onWholeFileFailed={handleWholeFileFailed}
  headSha={prDetail.pr.headSha}
  baseSha={prDetail.pr.baseSha}
/>
```

- [ ] **Step 5: Run existing FilesTab tests to confirm no regression**

Run: `npm test -- FilesTab`
Expected: existing cases pass; new tests for the toggle button come in Task 10.

- [ ] **Step 6: Run prettier**

Run: `npx prettier --write frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx
git commit -m "feat(diff): FilesTab whole-file toggle + DSx11 gate + DiffPane prop wiring"
```

---

## Task 9: DiffPane vitest cases (4 new)

**Files:**
- Modify: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Add the module mocks at the top of the test file**

Above the existing imports in `frontend/__tests__/DiffPane.test.tsx`, add:

```tsx
import { vi } from 'vitest';
vi.mock('../src/hooks/useWholeFileContent');
vi.mock('../src/hooks/useAiHunkAnnotations');
```

Then in the imports block:

```tsx
import { useWholeFileContent } from '../src/hooks/useWholeFileContent';
import { useAiHunkAnnotations } from '../src/hooks/useAiHunkAnnotations';
import styles from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css';
```

In the `beforeEach` (or at the top of each new test if no `beforeEach` exists), set a default mock return for `useWholeFileContent` so existing tests don't break:

```tsx
beforeEach(() => {
  vi.mocked(useWholeFileContent).mockReturnValue({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  });
});
```

If a `beforeEach` exists for clearing state, add the mock reset to it.

Note: the 21 existing inline `render(<DiffPane ... />)` sites do NOT need updating because Task 5 made the new props optional with safe defaults. The module mocks above ensure `useWholeFileContent` returns idle without hitting fetch in tests that don't opt in.

- [ ] **Step 2: Add the 4 new cases**

Define a `makeModifiedFile` helper at the top of the describe block (or in the existing test scaffold area):

```tsx
function makeModifiedFile(hunks: FileChange['hunks']): FileChange {
  return { path: 'src/a.ts', status: 'modified', hunks };
}
```

(Import `FileChange` from `'../src/api/types'` if not already imported.)

Then append to `frontend/__tests__/DiffPane.test.tsx`:

```tsx
describe('DiffPane whole-file mode', () => {
  it('renders filled-context rows with data-fill="true" when wholeFileEnabled and fetch ok (unified)', async () => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'line1\nline2\nline3\nline4',
      baseContent: null,
      failureReason: null,
    });
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+line2' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="unified" wholeFileEnabled={true} />,
    );
    const filledTrs = container.querySelectorAll('tr[data-fill="true"]');
    expect(filledTrs.length).toBeGreaterThan(0);
    const hunkHeaders = container.querySelectorAll('.diff-line--hunk-header');
    expect(hunkHeaders.length).toBe(0);
  });

  it('renders filled-context rows in split mode (4-column layout)', async () => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'line1\nline2\nline3',
      baseContent: 'line1\nold\nline3',
      failureReason: null,
    });
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+line2' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="side-by-side" wholeFileEnabled={true} />,
    );
    const filledTrs = container.querySelectorAll('tr[data-fill="true"]');
    expect(filledTrs.length).toBeGreaterThan(0);
    filledTrs.forEach((tr) => {
      expect(tr.querySelectorAll('td').length).toBe(4);
    });
  });

  it('renders failure banner and fires onWholeFileFailed once on transition; dismiss clears banner with the correct reason', async () => {
    const onFailed = vi.fn();
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'failed',
      headContent: null,
      baseContent: null,
      failureReason: 'file is too large to expand',
    });
    render(<DiffPane {...defaultProps} wholeFileEnabled={true} onWholeFileFailed={onFailed} />);
    expect(await screen.findByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(screen.getByText(/file is too large to expand/)).toBeInTheDocument();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('file is too large to expand');

    fireEvent.click(screen.getByRole('button', { name: /dismiss whole-file/i }));
    expect(screen.queryByTestId('whole-file-failure-banner')).not.toBeInTheDocument();
    expect(onFailed).toHaveBeenCalledTimes(2);
    expect(onFailed).toHaveBeenLastCalledWith('file is too large to expand');
  });

  it('latch survives the toggle revert: banner stays visible when wholeFileEnabled flips false after a failure', async () => {
    const onFailed = vi.fn();
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'failed',
      headContent: null,
      baseContent: null,
      failureReason: 'file is binary',
    });
    const { rerender } = render(
      <DiffPane {...defaultProps} wholeFileEnabled={true} onWholeFileFailed={onFailed} />,
    );
    expect(await screen.findByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(onFailed).toHaveBeenCalledTimes(1);

    // Simulate FilesTab removing the path from wholeFilePaths: rerender with
    // wholeFileEnabled=false and the hook now returning 'idle'.
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
    rerender(<DiffPane {...defaultProps} wholeFileEnabled={false} onWholeFileFailed={onFailed} />);

    // Banner survives because DiffPane's local latch holds the reason.
    expect(screen.getByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(screen.getByText(/file is binary/)).toBeInTheDocument();

    // Dismiss clears the latch.
    fireEvent.click(screen.getByRole('button', { name: /dismiss whole-file/i }));
    expect(screen.queryByTestId('whole-file-failure-banner')).not.toBeInTheDocument();
  });

  it('renders AI annotation row before the first non-header line of each hunk in whole-file mode', async () => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'a\nb\nc\nd',
      baseContent: null,
      failureReason: null,
    });
    vi.mocked(useAiHunkAnnotations).mockReturnValue([
      { path: 'src/a.ts', hunkIndex: 0, body: 'Annotation for hunk 0', tone: 'calm' },
    ]);
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+b' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="unified" wholeFileEnabled={true} />,
    );
    const annotationRow = container.querySelector(`.${styles.aiHunkRow}`);
    expect(annotationRow).toBeInTheDocument();
    const allRows = Array.from(container.querySelectorAll('tr'));
    const annotationIdx = allRows.indexOf(annotationRow as HTMLTableRowElement);
    expect(annotationIdx).toBeGreaterThanOrEqual(0);
    expect(allRows[annotationIdx + 1]?.classList.contains('diff-line--delete')).toBe(true);
  });
});
```

The case count for this task is **5** (not 4): the original 4 cases plus the new latch-survival case. The plan's grand total updates accordingly (see Task 13 Step 3 expected — 21 new cases instead of 20). The spec's AC #10 (currently "18 new cases" → "20 new cases" per ce-doc-review of the spec) was based on the original 4 DiffPane cases; the implementation-time addition of the latch-survival test is a documented plan-implementation refinement.

`defaultProps` is the existing slice-1 test scaffold variable. If the existing test file uses inline prop objects instead of a `defaultProps` constant, extract a `defaultProps` constant at the top of the describe block:

```tsx
const defaultProps = {
  prRef: { owner: 'o', repo: 'r', number: 1 },
  selectedPath: 'src/a.ts',
  file: makeModifiedFile([]),
  diffMode: 'unified' as DiffMode,
  truncated: false,
  reviewThreads: [],
  prUrl: 'https://example.com/pr/1',
};
```

- [ ] **Step 3: Run tests**

Run: `npm test -- DiffPane`
Expected: existing 9 + new 5 = 14 pass.

- [ ] **Step 4: Run prettier + commit**

```bash
npx prettier --write frontend/__tests__/DiffPane.test.tsx
git add frontend/__tests__/DiffPane.test.tsx
git commit -m "test(diff): 5 new DiffPane cases for whole-file mode + latch-survival"
```

---

## Task 10: FilesTab vitest cases (5 new)

**Files:**
- Modify: `frontend/__tests__/FilesTab.test.tsx`

- [ ] **Step 1: Locate the existing test scaffolding pattern**

Read `frontend/__tests__/FilesTab.test.tsx` lines 1-100 to identify:
- The existing `renderFilesTab()` helper or equivalent setup function
- The existing fetch-mock helper (likely `diffOrDraft` / `jsonResponse` or a custom router)
- The fixture data used for "modified file" + "iteration view" + "low-quality clustering" scenarios

The whole-file hook fetches at `/api/pr/{owner}/{repo}/{number}/file?path=...&sha=...` — distinct from the existing diff fetch. The mock router needs to handle this URL pattern.

- [ ] **Step 2: Add a `mockWholeFileFetch` helper that extends the existing router**

Add to the test file's helper section:

```tsx
// Extends the existing fetch-mock router with a /file?path=&sha= route handler.
// Returns a response function suitable for assigning to globalThis.fetch.
function mockWholeFileFetch(opts: {
  diffResponse: () => Promise<Response>;          // forwarded for existing diff/draft routes
  draftResponse?: () => Promise<Response>;
  fileContent?: string;                            // 200 text/plain on /file
  fileProblem?: { type: string; status: number }; // non-200 problem+json on /file
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/file?path=')) {
      if (opts.fileProblem) {
        return new Response(JSON.stringify({ type: opts.fileProblem.type }), {
          status: opts.fileProblem.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return new Response(opts.fileContent ?? 'mock content\nline 2\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.includes('/draft') && opts.draftResponse) return opts.draftResponse();
    return opts.diffResponse();
  }) as unknown as typeof fetch;
}
```

If the existing test file already has a `diffOrDraft` helper, use the same pattern — wrap it and add the `/file` handler before the existing fallback.

- [ ] **Step 3: Add the 5 new cases**

Append to `frontend/__tests__/FilesTab.test.tsx`. The fixture `sampleModifiedDiff`, `sampleAddedDiff`, etc. are the same shape the existing tests use — extend them per below.

```tsx
describe('FilesTab whole-file toggle', () => {
  it('clicking "Show full file" on a modified file flips the button label and sets aria-pressed', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileContent: 'whole content\nline 2\nline 3\n',
    }) as typeof fetch;
    renderFilesTab();
    const button = await screen.findByTestId('whole-file-toggle');
    expect(button).toHaveTextContent('Show full file');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Hunks only'));
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggle disabled for added / deleted / renamed file statuses', async () => {
    // sampleAddedDiff has one file with status: 'added'
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleAddedDiff)),
    }) as typeof fetch;
    renderFilesTab();
    const button = await screen.findByTestId('whole-file-toggle');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/modified files only/i);
  });

  it('toggle disabled when activeRange !== "all" (DSx11 gate)', async () => {
    // sampleMultiIterationDiff has prDetail.iterations populated so IterationTabStrip renders
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleMultiIterationDiff)),
    }) as typeof fetch;
    renderFilesTab();
    // The iteration-tab strip renders tabs whose accessible names contain the chip text
    // pattern from IterationTabStrip.tsx (e.g., "Iter 1+5-2"). Use the data-testid the
    // strip already exposes for stable selection.
    const iterationTab = await screen.findByTestId('iteration-tab-1');
    fireEvent.click(iterationTab);
    await waitFor(() => {
      const button = screen.getByTestId('whole-file-toggle');
      expect(button).toBeDisabled();
    });
    const button = screen.getByTestId('whole-file-toggle');
    expect(button.getAttribute('title')).toMatch(/'all' iteration view/i);
  });

  it('toggle disabled when selectedCommits !== null (DSx11 gate)', async () => {
    // sampleLowQualityDiff has clusteringQuality: 'low' so CommitMultiSelectPicker renders
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleLowQualityDiff)),
    }) as typeof fetch;
    renderFilesTab();
    const commitCheckbox = await screen.findByRole('checkbox', { name: /commit-0001/i });
    fireEvent.click(commitCheckbox);
    await waitFor(() => {
      const button = screen.getByTestId('whole-file-toggle');
      expect(button).toBeDisabled();
    });
    const button = screen.getByTestId('whole-file-toggle');
    expect(button.getAttribute('title')).toMatch(/'all' iteration view/i);
  });

  it('onWholeFileFailed flow: failure callback removes path from wholeFilePaths; button reverts', async () => {
    // 413 from /file → DiffPane's failure latch fires → onWholeFileFailed removes path → button reverts
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileProblem: { type: '/file/too-large', status: 413 },
    }) as typeof fetch;
    renderFilesTab();
    const button = await screen.findByTestId('whole-file-toggle');
    fireEvent.click(button);
    // Wait for the fetch to resolve and the failure callback to fire
    await waitFor(() => expect(button).toHaveTextContent('Show full file'));
    expect(button).toHaveAttribute('aria-pressed', 'false');
    // Banner is rendered by DiffPane; presence and dismiss flow asserted in Task 9 cases 3+4
  });
});
```

If the test file doesn't already have `iteration-tab-1` data-testid on `IterationTabStrip`, add it as a one-line preparatory change to `IterationTabStrip.tsx`. The strip already renders one tab per iteration; adding `data-testid={\`iteration-tab-\${iter.number}\`}` is mechanical and aids both this test and future Playwright tests.

If `sampleAddedDiff`, `sampleMultiIterationDiff`, `sampleLowQualityDiff` don't exist as fixtures, define them at the top of the test file modeled on the existing `sampleModifiedDiff` (or equivalent slice-1 fixture). Each is a `PrDetail` + `DiffDto` pair shaped like the wire response — copy the existing slice-1 fixture and mutate one field (`status: 'added'` for the file in `sampleAddedDiff`, `iterations: [...]` populated for `sampleMultiIterationDiff`, `clusteringQuality: 'low'` for `sampleLowQualityDiff`).

- [ ] **Step 2: Run tests**

Run: `npm test -- FilesTab`
Expected: existing cases + 5 new = pass.

- [ ] **Step 3: Run prettier + commit**

```bash
npx prettier --write frontend/__tests__/FilesTab.test.tsx
git add frontend/__tests__/FilesTab.test.tsx
git commit -m "test(diff): 5 new FilesTab cases for whole-file toggle + DSx11 gate"
```

---

## Task 11: Test-hooks force-failure endpoint

**Files:**
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs`
- Modify: `PRism.Web/TestHooks/FakePrReader.cs`

- [ ] **Step 1: Add the `/test/file/force-failure` endpoint**

In `PRism.Web/TestHooks/TestEndpoints.cs`, follow the existing `AsFake(sp)` pattern (e.g., from the existing `/test/submit/…` endpoints — `FakePrReader` is registered in DI only via the `IPrReader` interface, not directly as `FakePrReader`, so the handler must resolve the interface from `IServiceProvider` and cast).

Add this internal record alongside the existing internal records (around line 56):

```csharp
internal sealed record ForceFileFailureRequest(string Path, string Sha, string ProblemType);
```

Then add the endpoint registration in the `Map(...)` method, after the last existing `app.MapPost("/test/…")`:

```csharp
app.MapPost("/test/file/force-failure",
    async (ForceFileFailureRequest body, IServiceProvider sp, CancellationToken ct) =>
    {
        if (string.IsNullOrEmpty(body.Path) || string.IsNullOrEmpty(body.Sha) || string.IsNullOrEmpty(body.ProblemType))
            return Results.Problem(type: "/test/missing-params", statusCode: 422);
        if (sp.GetService<IPrReader>() is not FakePrReader fake)
            return Results.Problem(type: "/test/reader-missing", statusCode: 500);
        fake.RegisterFileForceFailure(body.Path, body.Sha, body.ProblemType);
        await Task.CompletedTask;
        return Results.NoContent();
    });
```

The failure registration is keyed by `(Path, Sha)` so split-mode tests can deterministically force head-only or base-only failures.

- [ ] **Step 2: Add the force-failure map + consumer to `FakePrReader`**

In `PRism.Web/TestHooks/FakePrReader.cs`, add `using System.Collections.Concurrent;` if not already present, then add the field + method:

```csharp
private readonly ConcurrentDictionary<(string Path, string Sha), string> _forceFileFailures = new();

public void RegisterFileForceFailure(string path, string sha, string problemType)
{
    _forceFileFailures[(path, sha)] = problemType;
}
```

Modify `GetFileContentAsync` to check the map before the existing happy-path. The current method (verified at FakePrReader.cs:117-128) is:

```csharp
public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
{
    if (reference != FakeReviewBackingStore.Scenario)
        return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
    lock (_store.Gate)
    {
        if (!_store.FileContent.TryGetValue((path, sha), out var content))
            return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
        return Task.FromResult(new FileContentResult(FileContentStatus.Ok, content, Encoding.UTF8.GetByteCount(content)));
    }
}
```

Insert the force-failure check at the top of the method, before the scenario guard. `FileContentResult` takes three positional args `(Status, Content, ByteSize)` — match the existing call sites:

```csharp
public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
{
    if (_forceFileFailures.TryRemove((path, sha), out var problemType))
    {
        return Task.FromResult(problemType switch
        {
            "/file/too-large" => new FileContentResult(FileContentStatus.TooLarge, null, 0),
            "/file/binary"    => new FileContentResult(FileContentStatus.Binary, null, 0),
            "/file/missing"   => new FileContentResult(FileContentStatus.NotFound, null, 0),
            _                 => new FileContentResult(FileContentStatus.NotInDiff, null, 0),
        });
    }
    if (reference != FakeReviewBackingStore.Scenario)
        return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
    lock (_store.Gate)
    {
        if (!_store.FileContent.TryGetValue((path, sha), out var content))
            return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
        return Task.FromResult(new FileContentResult(FileContentStatus.Ok, content, Encoding.UTF8.GetByteCount(content)));
    }
}
```

The `TryRemove` semantics mean the force-failure fires ONCE per registration. The Playwright spec re-registers before each scenario that needs it. Keying on `(path, sha)` lets split-mode tests register head-only or base-only failures without ambiguity.

- [ ] **Step 3: Build the backend**

Run: `dotnet build --configuration Release` (foreground; timeout 300000ms per CLAUDE.md).
Expected: clean build.

- [ ] **Step 4: Run existing dotnet tests to ensure no regression**

Run: `dotnet test --configuration Release` (foreground; timeout 600000ms).
Expected: all existing tests pass; new endpoint is additive.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/TestHooks/TestEndpoints.cs PRism.Web/TestHooks/FakePrReader.cs
git commit -m "feat(test-hooks): /test/file/force-failure endpoint for whole-file e2e"
```

---

## Task 12: Playwright spec extension + parity baseline capture

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-files-diff-whole-file.png` (captured via test run)

- [ ] **Step 1: Add the functional scenario block at the end of the existing `parity-baselines.spec.ts`**

The canonical PR scenario URL is `/pr/acme/api/123/...` (verified at `frontend/e2e/parity-baselines.spec.ts:198` — the slice-1 `pr-detail-files-tree` spec uses this). The existing fixture helper `setupAndOpenHandoffParityFixture(page)` already opens the scenario with `src/Calc.cs` present in the file tree. Use it for consistency with the slice-1 baselines.

Append a new top-level describe block at the bottom of `parity-baselines.spec.ts`:

```ts
test.describe('parity baselines — PR Detail — whole-file', () => {
  test('pr-detail-files-diff-whole-file: toggle whole-file then capture parity baseline', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await resetAiPreview(page);
    await page.goto('/pr/acme/api/123/files');

    await page.locator('[data-testid="files-tab-tree-row"]').filter({ hasText: 'src/Calc.cs' }).click();
    await page.waitForSelector('[data-testid="diff-pane"]');

    const toggle = page.locator('[data-testid="whole-file-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText('Show full file');
    expect(await page.locator('tr[data-fill="true"]').count()).toBe(0);

    await toggle.click();
    // Wait for the fetch to complete and filled rows to render. This implicitly
    // proves the loading state transitioned through (no separate assertion).
    await page.waitForFunction(() => document.querySelectorAll('tr[data-fill="true"]').length > 0);
    expect(await page.locator('.diff-line--hunk-header').count()).toBe(0);

    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="diff-pane"]')).toHaveScreenshot(
      'pr-detail-files-diff-whole-file.png',
      SCREENSHOT_OPTS,
    );

    // Toggle off + scroll-reset assertion
    await page.locator('[data-testid="diff-pane"]').evaluate((el) => {
      (el.querySelector('.diff-pane-body') as HTMLElement).scrollTop = 500;
    });
    await toggle.click();
    await expect(toggle).toHaveText('Show full file');
    const scrollTop = await page.locator('[data-testid="diff-pane"]').evaluate((el) => {
      return (el.querySelector('.diff-pane-body') as HTMLElement).scrollTop;
    });
    expect(scrollTop).toBe(0);
  });

  test('whole-file toggle disabled when iteration is not "all"', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');

    // The iteration-tab-strip renders tabs whose accessible name includes the iteration
    // number + chip metadata ("1Iter 1+X-Y"). The strip already exposes data-testid
    // entries per iteration (added in Task 10 step 3 if not present today). Click the
    // first non-"all" iteration tab.
    await page.locator('[data-testid="iteration-tab-1"]').click();

    const toggle = page.locator('[data-testid="whole-file-toggle"]');
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('title', /'all' iteration view/);
  });

  test('whole-file force-failure renders banner and reverts toggle', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);

    // Read the PR's head SHA from the rendered detail page to register a precise
    // force-failure. The pr-header data-testid exposes the head SHA via title attr,
    // or we can read it from the scenario fixture's well-known value.
    // The canonical scenario's headSha is the value from FakeReviewBackingStore.
    // For test stability, use the known value:
    const headSha = '3333333333333333333333333333333333333333';

    const forceResp = await page.request.post('http://localhost:5180/test/file/force-failure', {
      data: { path: 'src/Calc.cs', sha: headSha, problemType: '/file/too-large' },
      headers: { Origin: 'http://localhost:5180' },
    });
    expect(forceResp.ok()).toBe(true);

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"]').filter({ hasText: 'src/Calc.cs' }).click();
    const toggle = page.locator('[data-testid="whole-file-toggle"]');
    await toggle.click();

    const banner = page.locator('[data-testid="whole-file-failure-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/file is too large/i);
    await expect(toggle).toHaveText('Show full file');

    await banner.locator('button[aria-label="Dismiss whole-file error banner"]').click();
    await expect(banner).toHaveCount(0);
    await expect(toggle).toHaveText('Show full file');
  });
});
```

**Note on test-hook URL absoluteness:** Per memory `project_pr82_s6_pr9_shipped`, Vite proxies `/api/*` only; test-hook routes need absolute `http://localhost:5180/test/...` URLs to bypass the proxy. This is why the force-failure POST above uses the absolute URL.

**Note on `iteration-tab-1` data-testid:** Confirm during Task 10 that the helper testid was added to `IterationTabStrip.tsx`. If not yet added, add the one-liner there before this Playwright test runs.

**Note on `headSha`:** The canonical scenario's `headSha` is set by `FakeReviewBackingStore.cs` (verified in the existing parity tests). If the scenario rotates the SHA, read it from a stable accessor — e.g., the existing helper that exposes scenario constants. The hard-coded value above is acceptable for slice 2; a future cleanup PR can lift it.

- [ ] **Step 2: Capture the parity baseline**

Run: `npx playwright test parity-baselines --project=prod --grep "pr-detail-files-diff-whole-file" --update-snapshots`
Expected: a new `pr-detail-files-diff-whole-file.png` is written to `frontend/e2e/__screenshots__/win32/`.

- [ ] **Step 3: Run the full parity spec to confirm nothing regressed**

Run: `npx playwright test parity-baselines --project=prod`
Expected: all parity tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts \
        frontend/e2e/__screenshots__/win32/pr-detail-files-diff-whole-file.png
git commit -m "test(diff): Playwright spec + parity baseline for whole-file mode"
```

---

## Task 13: Pre-push checklist + PR via pr-autopilot

**Files:** (none — process task)

- [ ] **Step 1: Run lint**

Run: `npm run lint` (foreground; timeout 300000ms).
Expected: clean.

- [ ] **Step 2: Run build**

Run: `npm run build` (foreground; timeout 300000ms).
Expected: clean.

- [ ] **Step 3: Run vitest suite**

Run: `npm test` (foreground; timeout 600000ms).
Expected: all suites green, including the 21 new cases (5 interleaveWholeFile + 6 useWholeFileContent + 5 DiffPane + 5 FilesTab).

- [ ] **Step 4: Run dotnet test**

Run: `dotnet test --configuration Release` (foreground; timeout 600000ms).
Expected: all green.

- [ ] **Step 5: Run Playwright prod-project suite**

Run: `npx playwright test --project=prod` (foreground; timeout 1800000ms).
Expected: all green, including the 3 new whole-file scenarios + the new parity-baseline assertion.

- [ ] **Step 6: Push and open PR via pr-autopilot**

Per the user's `feedback_use_pr_autopilot` standing preference, invoke `pr-autopilot` to push the branch and open the PR. The skill handles Phase 1 (preflight) → Phase 2 (open) → Phase 3 (loop) → Phase 4 (CI gate) → Phase 5 (final report).

```
Use skill: pr-autopilot
```

If pr-autopilot is unavailable in the session, fall back to:

```bash
git push -u origin worktree-whole-file-context-expansion-spec
gh pr create --title "feat(diff): whole-file context expansion (P4-B8 slice 2)" --body "$(cat <<'EOF'
## Summary
- Adds a per-file "Show full file" toggle to the DiffPane toolbar
- New `useWholeFileContent` hook fetches at headSha (unified) or both (split) lazily
- New `interleaveWholeFile` pure function walks hunks + fills gaps from head content
- `<WholeFileFailureBanner>` for 413/415/404/422 with side-qualified reasons in split mode
- DSx11: toggle disabled on non-'all' iteration views (per-range SHA threading deferred)

## Test plan
- [x] 5 `interleaveWholeFile` unit tests
- [x] 6 `useWholeFileContent` hook tests
- [x] 4 new DiffPane integration tests
- [x] 5 new FilesTab tests (toggle + 2 DSx11 gates + failure flow)
- [x] 3 new Playwright scenarios (whole-file render, iteration-gate, force-failure)
- [x] Parity baseline `pr-detail-files-diff-whole-file.png` captured
- [x] `npm run lint`, `npm run build`, `npm test`, `dotnet test`, `npx playwright test --project=prod` all green

Spec: `docs/specs/2026-06-01-whole-file-context-expansion-design.md`
Deferrals: `docs/specs/2026-06-01-whole-file-context-expansion-deferrals.md`
🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

After saving the plan, walked it against the spec:

**1. Spec coverage:**
- § 4 architecture composition → Task 5 + Task 8
- § 5 interleave algorithm → Task 1 (tests + impl)
- § 5.5 hunk-header skip → Task 5 step 7-8
- § 6.1 DiffPane changes → Task 5 (all 13 steps)
- § 6.2 banner component → Task 3
- § 6.3 hook → Task 2
- § 6.4 FilesTab changes → Task 8
- § 6.5 CSS rules → Tasks 6 + 7
- § 7 toolbar/disabled gating → Task 8 step 3
- § 8.2 AI annotation re-anchoring → Task 5 steps 6-8
- § 9.1 vitest cases → Tasks 1, 2, 9, 10
- § 9.2 Playwright → Task 12
- § 10 edge cases (scroll reset) → Task 5 step 9
- § 12 acceptance criteria → covered transitively

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" anywhere in the plan. Every step has either concrete code or an exact command + expected output.

**3. Type consistency:** `DiffLine.isFilled?: true` matches across Task 1 (definition) + Task 4 (row threading) + Task 5 (interleave + render). `UseWholeFileContentInput` / `UseWholeFileContentResult` consistent between Task 2 + Task 5. Banner prop shape consistent between Task 3 + Task 5.

**4. Test count totals:** 5 (interleaveWholeFile) + 6 (useWholeFileContent) + 5 (DiffPane, originally 4 — added latch-survival case per ce-doc-review DL6) + 5 (FilesTab) = **21 new vitest cases**. Spec AC #10 said 20; the plan's added latch-survival test is a documented refinement. 3 new Playwright scenarios + 1 parity baseline (matches spec § 9.2).
