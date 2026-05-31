---
date: 2026-05-31
topic: design-parity-pr9b-ai-gating
kind: spec
slice: design-parity-recovery
origin: docs/specs/2026-05-29-design-parity-recovery-design.md
spec-section: § 4.9.2 PR9b family — AI-gating sub-PR
covers-deferrals: D24, D32a, D87 (D28 + D48 deferred — see § 8)
deferrals-sidecar: docs/specs/2026-05-29-design-parity-recovery-deferrals.md
---

# PR9b-ai-gating — AI-surface `aiPreview` gating sweep + selective wirings

Third and final sub-PR of the PR9b family. Closes D24 (AiSummaryCard active-shape verdict), D32a (FileTree focus-dot wiring), and the `AiHunkAnnotation` no-op stub. Adjudicates D87's "AI-gating sweep" mandate: hoists the `capabilities[key] && aiPreview` policy into a single `useAiGate` hook, fixes the `AskAiButton` capability-check inconsistency, and wires two surfaces against backend seams that already ship (`IFileFocusRanker` + `IHunkAnnotator`). Defers D28 (iter-new-dot) and D48 (stale-row AI suggestion) to V1.X because their backend data paths don't exist and inventing them conflicts with v1's "no AI backend" framing.

## 1. Goal

The slice's PR9b family is split into three sub-PRs (density toggle, global-search stub, AI-gating sweep) per spec § 4.9.2. PR9b-density (PR #96) and PR9b-search (PR #96 — bundled) merged 2026-05-31. PR9b-ai-gating closes the family.

The sub-PR's literal goal: bring all `aiPreview`-conditioned surfaces under a single gating policy AND wire the surfaces whose backend data path already exists, in one coherent pass.

## 2. Scope

### 2.1 In scope

- **Backend (2 new HTTP endpoints):**
  - `GET /api/pr/{owner}/{repo}/{number}/ai/file-focus` → 200 `FileFocus[]` / 204
  - `GET /api/pr/{owner}/{repo}/{number}/ai/hunk-annotations` → 200 `HunkAnnotation[]` / 204
  - Both follow `/ai/summary`'s precedent exactly: no auth-gate (the existing `/ai/summary` endpoint has no `IsSubscribed` check; seam returns canned data either way so there's no real disclosure risk). PR1 D3's 401→403 flip applied to the Events/Subscribe endpoint, NOT the AI family — verified by direct read of `AiEndpoints.cs`.
  - Both resolve their seam via the existing `IAiSeamSelector` (Noop → empty list → 204; Placeholder → canned data → 200).

- **Frontend gating policy:**
  - New `useAiGate(key: keyof AiCapabilities): boolean` hook centralizes the `capabilities[key] && aiPreview` compute.
  - Migrate four existing consumers (`OverviewTab`, `PrHeader`, `AiComposerAssistant`, `AskAiButton`) to the new hook.
  - The `AskAiButton` migration fixes a pre-existing gating inconsistency: today it reads `aiPreview` directly with no capability check; after the sweep it gates on `useAiGate('composerAssist')`.

- **Frontend wirings (2 new surfaces against existing seams):**
  - `useAiFileFocus(prRef, enabled)` hook → `FilesTab` calls it → passes `FileFocus[] | null` to `FileTree` → per-row dot conditional render with handoff-faithful High/Medium level differentiation.
  - `useAiHunkAnnotations(prRef, enabled)` hook → `DiffPane` calls it → emits `<AiHunkAnnotation>` rows after matching hunk headers.
  - `AiHunkAnnotation.tsx` replaces its no-op `: null` body with the handoff-faithful informational shape (sparkles icon + "AI" label + tone-chip + body text). Quote/Dismiss action buttons NOT shipped (deferred — see § 8.3).

- **Verdict-only adjudication:**
  - D24 — confirm the smaller `.pr-ai-summary` shape; no code change beyond comment rewrite.

- **CSS:**
  - Rename `.fileTreeAi` → `.fileTreeAiMed` (existing dormant rule re-purposed); add new `.fileTreeAiHigh` with handoff glow.
  - New `AiHunkAnnotation.module.css` ports handoff `.ai-hunk` + `.ai-hunk-meta` (`.ai-hunk-actions` NOT ported per § 8.3).

- **Tests:**
  - 4 new vitest specs (`useAiGate`, `useAiFileFocus`, `useAiHunkAnnotations`, `AiHunkAnnotation`).
  - 2 existing vitest specs extended (`FileTree`, `AskAiButton`).
  - Migration sweep of ~4-6 existing component specs that mock `useCapabilities` + `usePreferences` to instead mock `useAiGate` at the call boundary.
  - 2 new dotnet endpoint tests.
  - 1 new Playwright spec (`ai-gating-sweep.spec.ts`) covering off → on → off flow with all four surfaces.
  - Re-capture 2 existing parity baselines (`pr-detail-files-tree.png`, `pr-detail-files-diff.png`) — the new DOM is inside their zones.

- **Deferrals (5 new D-entries to land in the slice sidecar):**
  - D106 — D28 iter-new-dot DEFER-TO-V1.X (no backend signal, frontend-synthetic is session-memory work).
  - D107 — D48 stale-row AI suggestion DEFER-TO-V1.X (no `IDraftSuggester` seam; inventing one conflicts with v1 framing).
  - D108 — `AiHunkAnnotation` action buttons (Quote / Dismiss) DEFER-TO-V1.X.
  - D109 — Hunk-annotations endpoint per-PR vs per-hunk seam-shape divergence.
  - D110 — D24 verdict CONFIRMED (smaller shape).

### 2.2 Out of scope (deferred)

- **D28 iter-new-dot** — no backend `iteration.isNew` signal; frontend-synthetic "newest iteration on first load" is session-memory work whose right home is a separate session-state design pass (D106).
- **D48 stale-row AI suggestion span** — no `IDraftSuggester` seam exists; building canned-data infrastructure for a seam that doesn't exist conflicts with § 6.4's "use existing canned data" framing (D107).
- **AiHunkAnnotation Quote / Dismiss action buttons** — both require cross-cutting wiring (composer-seed plumbing for Quote, session-state for Dismiss) that doesn't exist (D108).
- **Per-hunk `/ai/hunk-annotations` endpoint** — v1 returns all annotations for the PR in one fetch; the `IHunkAnnotator` seam method still takes `(prRef, filePath, hunkIndex)` for v2 streaming/cost-control use. The placeholder ignores those args (D109).
- **`PrDescription` migration to `useAiGate`** — receives `aiPreview` as a prop from `OverviewTab` (line 7) rather than reading it directly. Leave as-is; pass-through props are not gates. (Not a deferral, just out-of-scope.)
- **All other PR9b family work** — PR9b-density (PR #96) and PR9b-search (PR #96) already merged 2026-05-31. PR9b-ai-gating closes the family.

## 3. Architecture

### 3.1 The gating policy

Today every AI surface independently computes its own gate:

```ts
// OverviewTab.tsx:29-30 — typical site
const aiPreview = preferences?.ui.aiPreview ?? false;
const aiOn = !!capabilities?.summary && aiPreview;
const aiSummary = useAiSummary(prRef, aiOn);
```

Four sites do this; one (`AskAiButton.tsx:9`) is inconsistent — it gates on `aiPreview` only with no capability check, which means an environment with `composerAssist: false` would still show the Ask AI button. The audit pass surfaced this; the sweep fixes it.

The hoist is one expression:

```ts
// frontend/src/hooks/useAiGate.ts
import type { AiCapabilities } from '../api/types';
import { useCapabilities } from './useCapabilities';
import { usePreferences } from './usePreferences';

export function useAiGate(key: keyof AiCapabilities): boolean {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  return (capabilities?.[key] ?? false) && (preferences?.ui.aiPreview ?? false);
}
```

Call-site migration (6 sites — 4 existing + 2 new):

| Site | Current expression | After |
|---|---|---|
| `OverviewTab.tsx:29-30` | `!!capabilities?.summary && (preferences?.ui.aiPreview ?? false)` | `useAiGate('summary')` |
| `PrHeader.tsx:104-106` | `(preferences?.ui.aiPreview ?? false) && !!capabilities?.preSubmitValidators` | `useAiGate('preSubmitValidators')` |
| `AiComposerAssistant.tsx:17` | `!!capabilities?.composerAssist && !!preferences?.ui.aiPreview` | `useAiGate('composerAssist')` |
| `AskAiButton.tsx:9` | `!aiPreview` (BUG — no capability check) | `useAiGate('composerAssist')` |
| `FileTree.tsx` (parent: `FilesTab`) | — | `useAiGate('fileFocus')` |
| `DiffPane.tsx` | — | `useAiGate('hunkAnnotations')` |

`PrDescription` (line 7 — `aiPreview: boolean` prop) is a pass-through, not a gate: it receives `aiPreview` from `OverviewTab` to switch its card class. Leave it as a prop — converting it to a hook call would make the component non-pure for an existing test seam, and the prop drilling is one level deep.

### 3.2 Backend endpoints

Both new endpoints are direct clones of `/ai/summary`'s shape — no auth gate (matching the existing endpoint), just resolve the seam and map empty → 204 / populated → 200:

```csharp
// PRism.Web/Endpoints/AiEndpoints.cs — new MapGet calls (mirrors existing `/ai/summary`)

app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/file-focus",
    async (string owner, string repo, int number,
           IAiSeamSelector ai, CancellationToken ct) =>
    {
        var ranker = ai.Resolve<IFileFocusRanker>();
        var entries = await ranker.RankAsync(new PrReference(owner, repo, number), ct).ConfigureAwait(false);
        return entries.Count == 0 ? Results.NoContent() : Results.Ok(entries);
    });

app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/hunk-annotations",
    async (string owner, string repo, int number,
           IAiSeamSelector ai, CancellationToken ct) =>
    {
        var annotator = ai.Resolve<IHunkAnnotator>();
        // The seam interface takes (prRef, filePath, hunkIndex) for v2 per-hunk
        // queries; v1's placeholder ignores filePath/hunkIndex and returns the
        // canned set wholesale. The endpoint surfaces all annotations for the
        // PR in one fetch so DiffPane can index locally. See D109 for the
        // seam-vs-endpoint divergence rationale.
        var annotations = await annotator.AnnotateAsync(
            new PrReference(owner, repo, number), filePath: string.Empty, hunkIndex: 0, ct).ConfigureAwait(false);
        return annotations.Count == 0 ? Results.NoContent() : Results.Ok(annotations);
    });
```

The no-auth precedent comes from `/ai/summary`: it has no `IsSubscribed` / identity check today. Seam returns canned data either way, so there's no real disclosure risk — anyone hitting the URL gets the same placeholder. PR1 D3's 401→403 flip applied to the Events/Subscribe endpoint, not the AI family.

`AiCapabilities` already has `FileFocus` + `HunkAnnotations` on the wire (`AiCapabilities.cs:5-6`); the frontend already deserializes them (`api/types.ts:45-46`). No capabilities shape change needed.

### 3.3 Frontend data hooks

Both new hooks clone `useAiSummary`'s shape exactly:

```ts
// frontend/src/hooks/useAiFileFocus.ts
import { useEffect, useState } from 'react';
import { getAiFileFocus } from '../api/aiFileFocus';
import type { PrReference, FileFocus } from '../api/types';

export function useAiFileFocus(prRef: PrReference, enabled: boolean): FileFocus[] | null {
  const [entries, setEntries] = useState<FileFocus[] | null>(null);
  useEffect(() => {
    if (!enabled) { setEntries(null); return; }
    let cancelled = false;
    getAiFileFocus(prRef)
      .then((result) => { if (!cancelled) setEntries(result); })
      .catch(() => { if (!cancelled) setEntries(null); });
    return () => { cancelled = true; };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);
  return entries;
}
```

`useAiHunkAnnotations` is structurally identical with `HunkAnnotation[]` element type.

**API client shape:**

```ts
// frontend/src/api/aiFileFocus.ts
import { apiClient } from './client';
import type { PrReference, FileFocus } from './types';

export async function getAiFileFocus(prRef: PrReference): Promise<FileFocus[] | null> {
  // 204 → null sentinel per existing aiSummary convention.
  const result = await apiClient.get<FileFocus[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
  );
  return result ?? null;
}
```

`getAiHunkAnnotations` mirrors the shape. Both follow `aiSummary.ts`'s 204 → null convention so the consuming hook has a clean discriminator. The `apiClient` lives at `frontend/src/api/client.ts` (not `apiClient.ts`); confirm import path at implementation time.

**Frontend types:**

```ts
// Append to frontend/src/api/types.ts (after existing AI-related types):

export type FocusLevel = 'high' | 'medium' | 'low';

export interface FileFocus {
  path: string;
  level: FocusLevel;
}

export type AnnotationTone = 'calm' | 'heads-up';

export interface HunkAnnotation {
  path: string;
  hunkIndex: number;
  body: string;
  tone: AnnotationTone;
}
```

**Wire-shape (critical):** `JsonSerializerOptionsFactory.Api` (`PRism.Core/Json/JsonSerializerOptionsFactory.cs:35-46`) registers `JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())`. Enums serialize **kebab-case** on the API wire — `FocusLevel.High` → `"high"`, `FocusLevel.Medium` → `"medium"`, `FocusLevel.Low` → `"low"`, `AnnotationTone.Calm` → `"calm"`, `AnnotationTone.HeadsUp` → `"heads-up"`. Property names are camelCase as expected. The frontend literals above match the wire shape exactly. Verified at `JsonSerializerOptionsFactory.cs:44`.

## 4. Surface wirings

### 4.1 AiSummaryCard (D24 — verdict-only)

**Verdict: CONFIRM smaller shape.** D87's initial lean stands. No code change beyond a comment update.

Update `AiSummaryCard.module.css:1-10` — replace the existing 9-line block that cites "D24 in the deferrals sidecar" with:

```css
/*
 * Intentionally tighter padding + smaller border-radius than `.overview-card-hero`
 * (handoff `.pr-ai-summary` shape — `screens.css:84-89`). The JSX composes
 * `overview-card overview-card-hero ai-tint` literal classes alongside this
 * hashed module class; Vite injects CSS-modules AFTER the global tokens.css,
 * so this rule wins the equal-specificity cascade over `.overview-card-hero`'s
 * larger padding/radius. Active shape confirmed in PR9b-ai-gating per D110.
 */
```

Rationale documented in D110: cohort feedback at N=3 indicated no friction with the smaller shape; growing to the hero footprint would have been speculative against absent signal. Reversal is one rule deletion if a future cohort surfaces growth pressure.

### 4.2 AskAiButton (gating inconsistency fix)

Before:

```tsx
// AskAiButton.tsx:9
if (!aiPreview) return null;
```

After:

```tsx
import { useAiGate } from '../../hooks/useAiGate';

export function AskAiButton({ onClick }: { onClick: () => void }) {
  const enabled = useAiGate('composerAssist');
  if (!enabled) return null;
  // ...rest unchanged
}
```

Component loses its `aiPreview: boolean` prop; the parent (`PrHeader` or wherever it mounts — verify call site at implementation time) drops the prop and stops passing it. The hook reads `capabilities.composerAssist + preferences.ui.aiPreview` directly.

Rationale for `'composerAssist'` (vs `'summary'` or a new `'askAi'` key): Ask AI is a question-answering surface, parallel to `AiComposerAssistant` which already gates on `composerAssist`. Adding a new capability key for one consumer is over-cautious. If V1.X cohort surfaces a coupling problem (e.g., "I want composer assist off but Ask AI on"), splitting is cheap.

### 4.3 FileTree focus dot (D32a)

**Data path:**

```tsx
// FilesTab.tsx — call site
const fileFocusEnabled = useAiGate('fileFocus');
const focusEntries = useAiFileFocus(prRef, fileFocusEnabled);

return (
  <FileTree
    files={files}
    selectedPath={selectedPath}
    onSelectFile={onSelectFile}
    viewedPaths={viewedPaths}
    onToggleViewed={onToggleViewed}
    focusEntries={focusEntries}
  />
);
```

**FileTree builds a path → level map:**

```tsx
// FileTree.tsx — extend FileTreeProps
export interface FileTreeProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  isLoading?: boolean;
  focusEntries: FileFocus[] | null;  // ← new
}

const focusByPath = useMemo(() => {
  if (!focusEntries) return null;
  const m = new Map<string, FocusLevel>();
  for (const entry of focusEntries) m.set(entry.path, entry.level);
  return m;
}, [focusEntries]);
```

**FileNodeComponent renders the dot:**

```tsx
// In FileNodeComponent's return, between <span file-tree-spacer/> and <input>:
const focusLevel = focusByPath?.get(node.path) ?? null;

{focusLevel && focusLevel !== 'low' && (
  <span
    className={focusLevel === 'high' ? styles.fileTreeAiHigh : styles.fileTreeAiMed}
    title={`AI focus: ${focusLevel}`}
    aria-hidden="true"
  />
)}
```

The level is passed down via the `focusByPath` Map; each `FileNodeComponent` looks up its own path. `aria-hidden="true"` keeps the decorative dot out of AT trees; the `title` attribute is a hover-tooltip-only surface (the focus signal is visual, not assertive UX).

**CSS:**

```css
/* FileTree.module.css — rename + add */

/* OLD .fileTreeAi (D32a dormant) renamed and re-purposed for Medium focus.
   See D110/D32a closure: the dormant rule was authored against a single-shape
   assumption that the handoff disproves; renaming with the level suffix is
   what the §6.2 dormant-CSS policy explicitly contemplates. */
.fileTreeAiMed {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}

.fileTreeAiHigh {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--accent) 25%, transparent);
  flex: none;
}
```

Production placeholder data carries `(LeaseRenewalProcessor.cs, High)` + `(RenewalRetryPolicy.cs, Medium)` — cohort sees the glow differentiation immediately.

Handoff CSS doesn't define `.ai-focus-low`; the JSX above skips Low entirely. The `FocusLevel.Low` enum value stays on the contract for forward compat with real v2 backends that may want a third tier; v1 placeholder doesn't produce it.

### 4.4 AiHunkAnnotation (replaces no-op stub)

**Data path:**

```tsx
// DiffPane.tsx — call site
const annotationsEnabled = useAiGate('hunkAnnotations');
const allAnnotations = useAiHunkAnnotations(prRef, annotationsEnabled);

const annotationsForFile = useMemo(() => {
  if (!allAnnotations || !selectedPath) return null;
  const m = new Map<number, HunkAnnotation[]>();
  for (const a of allAnnotations) {
    if (a.path !== selectedPath) continue;
    const existing = m.get(a.hunkIndex);
    if (existing) existing.push(a);
    else m.set(a.hunkIndex, [a]);
  }
  return m;
}, [allAnnotations, selectedPath]);
```

**Walk `allLines`, maintaining a running hunk-index counter:**

```tsx
let hunkCounter = -1;
const rendered: ReactNode[] = [];
for (let idx = 0; idx < allLines.length; idx++) {
  const line = allLines[idx];
  // ...existing DiffLineRow emission...
  rendered.push(<DiffLineRow key={idx} ... />);

  if (line.type === 'hunk-header') {
    hunkCounter += 1;
    const annotations = annotationsForFile?.get(hunkCounter);
    if (annotations) {
      for (let aidx = 0; aidx < annotations.length; aidx++) {
        rendered.push(
          <tr key={`ann-${idx}-${aidx}`}>
            <td colSpan={DIFF_TABLE_COLSPAN} className={styles.aiHunkRow}>
              <AiHunkAnnotation annotation={annotations[aidx]} />
            </td>
          </tr>,
        );
      }
    }
  }
}
```

`DIFF_TABLE_COLSPAN` matches the table's column count — verify at implementation time by counting `<td>` per `<DiffLineRow>` (likely 3: gutter / line-num / content; one constant defined alongside). The `.aiHunkRow` wrapper sets `padding: 0` and zero borders so the inner `.ai-hunk` block defines its own surface.

**Component rewrite (`AiHunkAnnotation.tsx`):**

```tsx
import type { HunkAnnotation } from '../../../../api/types';
import styles from './AiHunkAnnotation.module.css';

export interface AiHunkAnnotationProps {
  annotation: HunkAnnotation;
}

export function AiHunkAnnotation({ annotation }: AiHunkAnnotationProps) {
  const isHeadsUp = annotation.tone === 'heads-up';
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk-annotation">
      <span className="ai-icon" aria-hidden="true">✨</span>
      <div className={styles.aiHunkBody}>
        <div className={`ai-hunk-meta ${styles.aiHunkMeta}`}>
          <span>AI</span>
          <span className={`chip chip-${isHeadsUp ? 'warning' : 'info'}`}>
            {isHeadsUp ? 'Behavior change' : 'Note'}
          </span>
        </div>
        <div>{annotation.body}</div>
      </div>
    </div>
  );
}
```

Drops the no-op stub interface. Tone-to-chip mapping: `HeadsUp` → `chip-warning` "Behavior change"; `Calm` → `chip-info` "Note". Both chip globals already in `tokens.css` from prior PRs. `.ai-icon` is also already global.

**Action buttons NOT shipped.** Handoff `.ai-hunk-actions` (Quote in comment / Dismiss) requires composer-seed plumbing for Quote and per-session dismissal state for Dismiss. Both are cross-cutting V1.X work — deferred via D108.

**New CSS file (`AiHunkAnnotation.module.css`):**

```css
/* Port of handoff `.ai-hunk` (screens.css:824-832) and `.ai-hunk-meta`
   (screens.css:834). The literal classes (.ai-hunk, .ai-hunk-meta) stay on
   JSX as the test seam + visual identity; hashed module classes (.aiHunk,
   .aiHunkBody, .aiHunkMeta) carry the paint. Matches the literal-class-
   and-module pattern from PR4 D16. The handoff's .ai-hunk-actions surface
   is NOT ported — Quote/Dismiss action buttons are deferred per D108. */

.aiHunk {
  display: flex;
  gap: var(--s-2);
  margin: var(--s-2) var(--s-4);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--radius-2);
  background: color-mix(in oklch, var(--accent-soft) 50%, var(--surface-1));
  border: 1px dashed color-mix(in oklch, var(--accent) 40%, var(--border-1));
  font-family: var(--font-sans);
  font-size: var(--text-xs);
}

.aiHunkBody {
  flex: 1;
  min-width: 0;
}

.aiHunkMeta {
  display: flex;
  gap: var(--s-2);
  align-items: center;
  margin-bottom: 4px;
  font-weight: 600;
  color: var(--accent);
}

.aiHunkRow > td {
  padding: 0;
  border: 0;
}
```

The `.aiHunkRow > td` selector covers the table-row wrapper added in DiffPane.

## 5. Tests

### 5.1 Vitest — new (4 specs)

| File | Coverage |
|---|---|
| `frontend/__tests__/useAiGate.test.tsx` | Returns `false` when capability off (mocked); `false` when `aiPreview` off; `true` only when both on; handles `capabilities`/`preferences` `null` (returns `false`); narrows by key — `useAiGate('summary')` reads only `capabilities.summary`. |
| `frontend/__tests__/useAiFileFocus.test.tsx` | Fetches when `enabled === true`; returns `null` when `enabled === false`; handles 204 (null sentinel); handles network error silently (matches `useAiSummary` precedent); cleanup on prRef change. |
| `frontend/__tests__/useAiHunkAnnotations.test.tsx` | Same shape as `useAiFileFocus`. |
| `frontend/__tests__/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.test.tsx` | `tone: 'calm'` → renders `"Note"` + `chip-info`; `tone: 'heads-up'` → renders `"Behavior change"` + `chip-warning`; body text rendered; `.ai-icon` rendered with `aria-hidden`; `data-testid="ai-hunk-annotation"` present. |

### 5.2 Vitest — existing extended (2 specs)

| File | New assertions |
|---|---|
| `frontend/__tests__/PrDetail/FilesTab/FileTree.test.tsx` | `level: 'high'` → renders element with `.fileTreeAiHigh` class; `level: 'medium'` → `.fileTreeAiMed`; `level: 'low'` → no dot rendered; not in focusEntries → no dot; title attribute matches `"AI focus: high|medium"`; `aria-hidden="true"` present. |
| `frontend/__tests__/PrDetail/AskAiButton.test.tsx` | Renders when `composerAssist + aiPreview` both true (new requirement); does NOT render when `composerAssist === false` but `aiPreview === true` (documents the bug fix); does NOT render when `aiPreview === false`. |

### 5.3 Vitest — migration sweep (~4-6 specs)

Existing component specs that mock `useCapabilities` + `usePreferences` to construct the gate compute should migrate to mocking `useAiGate` directly at the hook-call boundary:

```ts
vi.mock('../hooks/useAiGate', () => ({ useAiGate: vi.fn() }));
// In test: vi.mocked(useAiGate).mockReturnValue(true);
```

Affected specs (verify at implementation time — list grows as call sites are migrated):
- `OverviewTab.test.tsx`
- `AiComposerAssistant.test.tsx`
- `PrHeader.test.tsx`
- Any other test that builds a full `capabilities + preferences` fixture solely to drive an AI gate

Specs that test the migrated component's other behavior (not the gate) can keep their existing mock setup — only the gate-specific fixtures simplify.

### 5.4 Backend dotnet test — new (2 specs)

| File | Coverage |
|---|---|
| `tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs` | 200 with array body when seam returns populated; 204 when seam returns empty; route binding correct (owner/repo/number passed through). |
| `tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs` | Same two cases. |

Mirrors `tests/PRism.Web.Tests/Endpoints/AiEndpointsTests.cs` structure verbatim. No auth-gate test needed — endpoints follow `/ai/summary`'s no-auth precedent per § 3.2.

### 5.5 Playwright e2e — new (1 spec)

`frontend/e2e/ai-gating-sweep.spec.ts` — single spec covering the canonical user flow:

1. Land on PR detail with `aiPreview` off (default fixture).
2. Assert: no AI summary card visible (`getByTestId('ai-summary-card')` not present); no FileTree dots (`.fileTreeAiHigh, .fileTreeAiMed` count zero); no `.ai-hunk` blocks (`getByTestId('ai-hunk-annotation')` count zero); no Ask AI button (selector defined at implementation time).
3. Toggle `aiPreview` on via the existing header toggle button (mocked `POST /api/preferences` → 204).
4. Mock all three AI endpoints to return canned data:
   - `GET /api/pr/.../ai/summary` → 200 placeholder summary
   - `GET /api/pr/.../ai/file-focus` → 200 `[{path: 'src/Calc.cs', level: 'high'}, {path: 'src/Calc.Tests.cs', level: 'medium'}]` (kebab-case enum per § 3.3 wire-shape note)
   - `GET /api/pr/.../ai/hunk-annotations` → 200 with at least one Calm + one HeadsUp annotation matching real hunk indices in the canned PR's first file
5. Assert: AI summary card visible; FileTree shows one `.fileTreeAiHigh` + one `.fileTreeAiMed`; DiffPane (after navigating to Files tab + selecting the matching file) shows both `.ai-hunk` blocks immediately after their matching hunk headers; Ask AI button visible.
6. Toggle `aiPreview` off; assert all four surface classes disappear.

**Race prevention:** Use `waitForResponse` on the toggle POST before subsequent assertions, per `feedback_windows_ci_fixed_delay_flake` memory. Don't use fixed sub-second delays.

### 5.6 Parity baselines

No new baselines. Per spec § 5, "no new parity baselines unless the wiring changes visible chrome." The dots + annotations are inside content surfaces (FileTree row, DiffPane body); they don't change zone topology covered by `pr-detail-files-tree.png` / `pr-detail-files-diff.png`.

**Re-capture required** for both existing baselines because the new DOM is part of those zones. Flag in PR body as expected re-capture. Capture in `aiPreview: false` state (default) — no AI surfaces visible, baseline matches today's content + new column reservation (`.fileTreeSpacer` already absorbs the right-edge slack, so the row layout shouldn't visually shift in the off state; verify on capture).

## 6. Validation per slice § 5

Code-PR validation in full:

1. **Side-by-side screenshot in PR description** per `.ai/docs/design-handoff.md`. Capture FileTree row with both dots visible + DiffPane with both annotations visible (`aiPreview: on` state). Optional second pair for `aiPreview: off` to demonstrate clean absence.
2. **Re-captured viewport baselines** (`pr-detail-files-tree.png`, `pr-detail-files-diff.png`) committed in the same PR. No new zones.
3. **All existing tests pass.** Vitest, dotnet test, Playwright. The `useAiGate` hoist changes test-mock shape for ~4-6 specs; those tests must update in the same PR.
4. **Pre-push checklist** per `.ai/docs/development-process.md`: `npm run lint`, `npm run build`, `npm test`, `dotnet build --configuration Release`, `dotnet test --no-build --configuration Release`, Playwright where applicable.

## 7. Cross-cutting risks

### 7.1 Re-capture asymmetry — dots visible in baseline vs not

The baselines capture in `aiPreview: off` state (the default fixture). The new DOM (AI column placeholder in FileTree, no-op-when-no-annotations in DiffPane) should not visually shift the off-state baselines — but verify on capture. If the off-state baseline drifts because of layout reflow from the new conditional `<span>` reserving space even when null, that's a JSX bug to fix before the baseline lands. The conditional `{... && (<span/>)}` pattern emits nothing when the condition fails — no reserved column. Should be safe.

### 7.2 Hunk-index counter correctness

The `hunkCounter` walk in DiffPane assumes `allLines` is ordered with hunk-header rows at the start of each hunk. `PlaceholderData.HunkAnnotations` indexes 0 and 2 (hunks 0 and 2 in the canned file). The Playwright spec asserts both render. If the production diff builder produces hunk-header rows out of order or with gaps, the counter drifts. Verify at implementation time by stepping through `Calc.cs`'s canned diff — count hunk-header rows, confirm indices match `PlaceholderData.HunkAnnotations`'s indices.

### 7.3 `useAiGate` mock-shape ripple

Migrating 4-6 existing component tests to mock `useAiGate` instead of `useCapabilities`+`usePreferences` is mechanical but touches every AI-gated component test. Don't over-rewrite — only the test setup that builds capabilities/preferences fixtures *solely for the gate compute* simplifies. Tests that exercise other consumers of `useCapabilities` / `usePreferences` (e.g., density toggle, theme) keep their existing fixtures. Identify the surgical edit boundary at implementation time.

### 7.4 Endpoint per-PR vs per-hunk shape divergence (D109)

The `IHunkAnnotator.AnnotateAsync` signature takes `(prRef, filePath, hunkIndex)` for v2 cost-control (real-AI backends will want streaming/per-hunk queries). The v1 endpoint calls it with empty path + 0 index because the placeholder ignores both. A future v2 backend swap-in at the seam will need an endpoint redesign — the v1 endpoint shape (one fetch returns all annotations) won't scale. D109 documents this; the redesign is V1.X-shaped work that lands when the real backend ships.

## 8. Deferrals (5 new D-entries)

All five entries land in `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` under a new `## PR9b-ai-gating — Selective wirings` section appended after the existing `## PR9b-search` and `## PR9b-density` sections.

### 8.1 D106 — D28 iter-new-dot DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; D28 original deferral.
**Covers:** D28 — IterationTabStrip iter-new-dot wiring.
**Verdict rationale:** No backend `IterationDto.IsNew` flag exists. Adding it requires either a backend signal (would need design — what's "new"? Server-side: since last user visit? Last cluster computation? Frontend-side: relative to a session-tracked baseline?) OR a frontend-synthetic "newest iteration on first load" heuristic backed by `localStorage`/`sessionStorage`. Both paths are session-memory work whose right home is a separate design pass, not the AI-gating sweep. The dot was framed as AI in the handoff but is structurally a session-state signal, not an AI signal — conflating them muddies the sweep's purpose.
**Status:** DEFER-TO-V1.X.
**Reopener:** Backend `IterationDto.IsNew` flag added OR explicit cohort signal requesting iteration-recency indication.
**Cross-refs:** D28; D87; spec § 4.9.2.

### 8.2 D107 — D48 stale-row AI suggestion DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; D48 original deferral.
**Covers:** D48 — StaleDraftRow AI suggestion span (`.stale-ai`).
**Verdict rationale:** Unlike D32a (`IFileFocusRanker` seam ready) and `AiHunkAnnotation` (`IHunkAnnotator` seam ready), no `IDraftSuggester` seam exists in `PRism.AI.Contracts/Seams/`. The handoff's `.stale-ai` span renders per-row AI suggestion text for stale drafts; production has no seam for that signal. Building one (canned `IDraftSuggester` + `PlaceholderDraftSuggester` + endpoint + frontend hook) is net-new backend infrastructure — § 6.4's "use existing canned data" framing applies only to seams that already ship. Inventing a seam to gate it behind `aiPreview` is wrong-direction work for v1.
**Status:** DEFER-TO-V1.X.
**Reopener:** Real AI backend ships (v1.X+) OR explicit cohort signal requesting canned suggestions for stale rows.
**Cross-refs:** D48; D87; spec § 4.9.2; § 6.4.

### 8.3 D108 — AiHunkAnnotation action buttons (Quote / Dismiss) DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31; surfaced during AiHunkAnnotation rewrite design.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; handoff `.ai-hunk-actions` (`diff.jsx:139-142`, `screens.css:835`).
**Covers:** Handoff `<div className="ai-hunk-actions">` with two action buttons: "Quote in comment" + "Dismiss".
**Verdict rationale:** Quote requires composer-seed plumbing — `InlineCommentComposer` doesn't accept a `seed: string` prop today; threading one through requires touching the composer prop chain + the open-composer registry + the per-anchor draft session. Dismiss requires per-session dismissal state — no `dismissedAnnotations` set exists; building one is session-state design work parallel to D106. Both are cross-cutting V1.X work whose absence doesn't break the informational read of the annotation.
**Status:** DEFER-TO-V1.X. Annotation ships informational-only (sparkles icon + "AI" label + tone chip + body).
**Reopener:** Cohort signal requesting Quote-in-comment OR a session-state design pass lands the dismissal model.
**Cross-refs:** D87; D106 (parallel session-state shape).

### 8.4 D109 — Hunk-annotations endpoint per-PR vs per-hunk seam shape

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; `IHunkAnnotator.AnnotateAsync(prRef, filePath, hunkIndex)` seam interface.
**Reality:** The `IHunkAnnotator` seam method takes `(prRef, filePath, hunkIndex)` for v2 streaming / cost-control use. The v1 endpoint `GET /ai/hunk-annotations` returns all annotations for the PR in one fetch — calls the seam with empty path + 0 index; the placeholder ignores both args and returns the canned set wholesale.
**Verdict rationale:** A future v2 real-AI backend will want per-hunk fetches (real generation is expensive; per-PR pre-generation doesn't scale). The seam interface supports that shape; the v1 endpoint doesn't. Redesigning the endpoint when the real backend ships is straightforward (the seam stays unchanged; the endpoint splits into per-file or per-hunk routes). v1's framing trades the cleaner contract for the simpler frontend consumption pattern.
**Status:** DEFER-TO-V1.X (endpoint redesign when real-AI backend ships).
**Reopener:** Real AI backend swap-in at the `IHunkAnnotator` seam.
**Cross-refs:** D87; § 6.4.

### 8.5 D110 — D24 verdict CONFIRMED smaller AiSummaryCard shape

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating verdict; D24 original deferral.
**Covers:** D24 — AiSummaryCard active-shape parity delta (current smaller `.pr-ai-summary` shape vs handoff's larger `.overview-card-hero`).
**Verdict rationale:** D87's initial lean stands. N=3 cohort feedback indicated no friction with the smaller shape; growing to the hero footprint would have been speculative against absent signal. The current shape (`padding: var(--s-3) var(--s-4); border-radius: var(--radius-3)` via `.aiSummaryCard` module rule) ships unchanged. The `AiSummaryCard.module.css` comment header rewrites to reference D110 (this entry) instead of D24, but no rule changes.
**Status:** CONFIRMED.
**Reversal cost:** One rule deletion (drop `padding` + `border-radius` from `.aiSummaryCard`) — cheap if a future cohort surfaces growth pressure.
**Cross-refs:** D24; D87; § 4.9.2; § 6.4.

## 9. Open follow-ons (post-merge)

Captured here for cohort-driven re-prioritization; not blocking PR9b-ai-gating ship:

- **D109 redesign trigger** — when the real AI backend ships, redesign `/ai/hunk-annotations` to per-file or per-hunk.
- **D108 reopener** — cohort Quote/Dismiss signal triggers the cross-cutting action-button work.
- **D106 + D107 reopeners** — backend signal arrives (D28 `IsNew` flag, D48 `IDraftSuggester`).
- **Backend enum-validation gap (carried from PR #96 Deviation 6)** — `density`/`theme`/`accent` accept arbitrary strings on `POST /api/preferences`. Parallel gap for `aiPreview` (it's a `bool` so type-validation catches non-bool input; enum-validation N/A here). Worth tracking as a backend follow-up.

## 10. Self-review

Run before handing to ce-doc-review and user-review:

- [ ] **Placeholder scan:** No "TBD" / "TODO" / "implement later" text in any normative section.
- [ ] **Internal consistency:** All five new D-entries match the deferrals listed in § 2.2. The migration table in § 3.1 matches the per-site rewrites in § 4. The endpoint paths in § 3.2 match § 2.1 and § 5.4.
- [ ] **Scope check:** The doc covers exactly one sub-PR's work — no creep into D28/D48 wiring or new-seam construction.
- [ ] **Ambiguity check:** Every wire-shape decision names the source of truth (handoff JSX/CSS line numbers; backend record names; existing-precedent file paths).
- [ ] **Implementer-readable:** Every section is concrete enough that a fresh implementer can act on it without re-reading the slice spec end-to-end.

---

**Origin:** [`docs/specs/2026-05-29-design-parity-recovery-design.md § 4.9.2`](2026-05-29-design-parity-recovery-design.md).
**Sidecar:** [`docs/specs/2026-05-29-design-parity-recovery-deferrals.md`](2026-05-29-design-parity-recovery-deferrals.md) — D106-D110 land here on merge.
**Family siblings:** PR9b-density + PR9b-search shipped together as PR #96 (merge 2026-05-31).
