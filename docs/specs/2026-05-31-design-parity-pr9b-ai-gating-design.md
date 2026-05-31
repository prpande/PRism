---
date: 2026-05-31
topic: design-parity-pr9b-ai-gating
kind: spec
slice: design-parity-recovery
origin: docs/specs/2026-05-29-design-parity-recovery-design.md
spec-section: § 4.9.2 PR9b family — AI-gating sub-PR
covers-deferrals: D24, D32a, D48, D87 (D28 still deferred — see § 8)
deferrals-sidecar: docs/specs/2026-05-29-design-parity-recovery-deferrals.md
---

# PR9b-ai-gating — AI-surface `aiPreview` gating sweep + selective wirings

Third and final sub-PR of the PR9b family. Closes D24 (AiSummaryCard active-shape verdict), D32a (FileTree focus-dot wiring), D48 (StaleDraftRow AI suggestion span), and the `AiHunkAnnotation` no-op stub. Adjudicates D87's "AI-gating sweep" mandate: hoists the `capabilities[key] && aiPreview` policy into a single `useAiGate` hook, tightens the `AskAiButton` and `InboxPage` gating to match the rest of the AI surface family, and wires three surfaces against backend seams that already ship (`IFileFocusRanker`, `IHunkAnnotator`, `IDraftSuggester`). Defers D28 (iter-new-dot) to V1.X because its signal is session-memory, not AI — no backend or frontend seam fits today.

## 1. Goal

The slice's PR9b family is split into three sub-PRs (density toggle, global-search stub, AI-gating sweep) per spec § 4.9.2. PR9b-density (PR #96) and PR9b-search (PR #96 — bundled) merged 2026-05-31. PR9b-ai-gating closes the family by wiring the four named AI surfaces from origin § 6.4 (AI summary card, AI hunk annotations, AI focus dots in file tree, AI suggestion in stale-draft rows) under a single coherent gating policy.

**Scope-reconciliation note (vs origin § 4.9.2's PR9b-ai-gating candidate list).** Origin § 4.9.2 enumerates the PR9b-ai-gating candidate set as "D24 + D28 + D32a + D48." This spec reclassifies **D28 (iter-new-dot)** out of the AI-gating sweep entirely — the dot is structurally a session-state signal (newest iteration on first load), not an AI-derived signal, despite its handoff framing in the IterationTabStrip. D28's right home is a separate session-memory design pass (D106). The closure claim "PR9b family closes" is honest against origin § 6.4's four-surface list (all wired) but narrows origin § 4.9.2's four-deferral list by one (D28). This is a deliberate scope re-categorization, not an oversight.

## 2. Scope

### 2.1 In scope

- **Backend (3 new HTTP endpoints):**
  - `GET /api/pr/{owner}/{repo}/{number}/ai/file-focus` → 200 `FileFocus[]` / 204
  - `GET /api/pr/{owner}/{repo}/{number}/ai/hunk-annotations` → 200 `HunkAnnotation[]` / 204
  - `GET /api/pr/{owner}/{repo}/{number}/ai/draft-suggestions` → 200 `DraftSuggestion[]` / 204
  - All three follow `/ai/summary`'s precedent exactly: no per-endpoint `IsSubscribed` check (the existing `/ai/summary` endpoint has no per-endpoint identity check either). All four `/api/pr/{owner}/{repo}/{number}/ai/*` endpoints still sit behind the session-token middleware that gates the entire `/api/*` surface (`SessionTokenMiddleware.cs:59`); they are NOT unauthenticated, just not subscription-gated. See § 7.5 for the auth posture rationale and D111 for the deferred decision when the seam binding swaps to real AI.
  - All three resolve their seam via the existing `IAiSeamSelector` (Noop → empty list → 204; Placeholder → canned data → 200).

- **Frontend gating policy:**
  - New `useAiGate(key: keyof AiCapabilities): boolean` hook centralizes the `capabilities[key] && aiPreview` compute.
  - Migrate six existing call sites (`OverviewTab`, `PrHeader` validators derivation, `AiComposerAssistant`, `AskAiButton`, `InboxPage` category chip, `InboxPage` activity rail) to the new hook.
  - The `AskAiButton` migration tightens gating from `aiPreview`-only to `useAiGate('composerAssist')` — matches the surrounding `AiComposerAssistant` consumer. Framed as a UI consistency fix, not a security/correctness fix; see § 4.2.
  - The `InboxPage` migrations close two parallel gating gaps surfaced during the sweep: `showCategoryChip` gates only on `inboxEnrichment` capability today (no `aiPreview`); `showActivityRail` gates only on `aiPreview` (no capability). See § 4.6.

- **Frontend wirings (3 new surfaces against existing seams):**
  - `useAiFileFocus(prRef, enabled)` hook → `FilesTab` calls it → passes `FileFocus[] | null` to `FileTree` → per-row dot conditional render with handoff-faithful High/Medium level differentiation.
  - `useAiHunkAnnotations(prRef, enabled)` hook → `DiffPane` calls it → emits `<AiHunkAnnotation>` rows after matching hunk headers.
  - `useAiDraftSuggestions(prRef, enabled)` hook → `UnresolvedPanel` (the parent of `StaleDraftRow`) calls it → passes `DraftSuggestion[] | null` down to each `StaleDraftRow` → per-row suggestion span conditional render.
  - `AiHunkAnnotation.tsx` replaces its no-op `: null` body with the handoff-faithful informational shape (sparkles icon + "AI" label + tone-chip + body text). Quote/Dismiss action buttons NOT shipped (deferred — see § 8.3).
  - `StaleDraftRow.tsx` gains a `<span className="stale-ai ai-tint">` between the preview text and the action buttons when a matching `DraftSuggestion` exists. See § 4.5.

- **Verdict-only adjudication:**
  - D24 — confirm the smaller `.pr-ai-summary` shape; no code change beyond comment rewrite. Rationale leans on reversal cost, not cohort evidence; see § 4.1.

- **CSS:**
  - Rename `.fileTreeAi` → `.fileTreeAiMed` (existing dormant rule, now Medium-shaped with handoff `opacity: 0.6`); add new `.fileTreeAiHigh` with handoff glow.
  - Add a wrapper `.fileTreeAi` column that reserves width unconditionally and collapses to `width: 0` when `aiPreview` is off — prevents row layout shift on toggle (handoff `screens.css:580-581` pattern).
  - Replace existing stub `AiHunkAnnotation.module.css` to port handoff `.ai-hunk` + `.ai-hunk-meta`; drop the existing dormant `.aiHunkActions` rule per D108.
  - Add `.staleAi` + `.staleAiBody` + `.staleAiLabel` rules to `StaleDraftRow.module.css` per handoff `screens.css:489-494` shape (icon + labeled body, `display: flex; gap`).

- **Backend placeholder alignment (§ 4.7):**
  - Update `PlaceholderData.cs` to target `src/Calc.cs` (the canned `FakePrReader` PR's actual file) instead of the fictional `services/leases/…` paths. One-file edit (~10 LOC) so the wiring is visually demonstrable in cohort demos without requiring endpoint mocks.

- **Tests:**
  - 6 new vitest specs (`useAiGate`, `useAiFileFocus`, `useAiHunkAnnotations`, `useAiDraftSuggestions`, `AiHunkAnnotation`, `AskAiButton`).
  - 2 existing vitest specs extended (`FileTree`, `StaleDraftRow`); 1 existing extended for InboxPage gating (`InboxPage`).
  - Migration sweep of ~4-6 existing component specs that mock `useCapabilities` + `usePreferences` to instead mock `useAiGate` at the call boundary.
  - 3 new dotnet endpoint tests.
  - 1 new Playwright spec (`ai-gating-sweep.spec.ts`) covering off → on → off flow with all five AI-surface classes (AiSummaryCard / FileTree dots / AiHunkAnnotation / StaleDraftRow ai-suggestion / AskAiButton) plus InboxPage activity rail.
  - Re-capture 3 existing parity baselines (`pr-detail-files-tree.png`, `pr-detail-files-diff.png`, `pr-detail-reconciliation-panel.png`) — the new DOM is inside their zones.

- **Deferrals (6 new D-entries to land in the slice sidecar):**
  - D106 — D28 iter-new-dot DEFER-TO-V1.X (no backend signal; session-memory work, not AI).
  - D108 — `AiHunkAnnotation` action buttons (Quote / Dismiss) DEFER-TO-V1.X.
  - D109 — Hunk-annotations endpoint per-PR vs per-hunk seam-shape divergence.
  - D110 — D24 verdict CONFIRMED (smaller shape).
  - D111 — Per-endpoint `IsSubscribed` gating on `/ai/*` family deferred to V1.X (real-AI-backend swap trigger, atomically enforced).
  - D112 — `useAiGate` two-factor abstraction's behavioral payoff is post-backend-decoupling; `composerAssist` + `inboxRanking` key-choice semantic-imprecision liabilities documented.

  D107 (D48 deferral) is NOT created — the original premise that no `IDraftSuggester` seam exists was empirically wrong (verified during ce-doc-review). D48 is wired in this sub-PR; the "would-have-been-D107" slot is documented in the sidecar as "closed; rationale superseded — see § 4.5."

### 2.2 Out of scope (deferred)

- **D28 iter-new-dot** — no backend `iteration.isNew` signal; frontend-synthetic "newest iteration on first load" is session-memory work whose right home is a separate session-state design pass (D106). The dot was framed as AI in the handoff but is structurally a session-state signal, not an AI signal — it does not belong in the AI-gating sweep.
- **AiHunkAnnotation Quote / Dismiss action buttons** — both require cross-cutting wiring (composer-seed plumbing for Quote, session-state for Dismiss) that doesn't exist (D108).
- **Per-file / per-hunk endpoint shapes** — v1 endpoints return all annotations / focus entries / suggestions for the PR in one fetch; the seam interfaces (`IFileFocusRanker.RankAsync(prRef, ct)`, `IHunkAnnotator.AnnotateAsync(prRef, filePath, hunkIndex, ct)`, `IDraftSuggester.SuggestAsync(prRef, ct)`) support more granular calls. The endpoint shape for hunk-annotations passes `("", 0)` sentinels to satisfy the per-hunk method signature; the placeholder ignores them. Endpoint redesign deferred to V1.X (D109).
- **Per-endpoint `IsSubscribed` gating on `/ai/*` family** — the endpoints sit behind the session-token middleware that protects all `/api/*` routes; no additional per-PR subscription check is added. Re-evaluate when the seam binding swaps from canned to real AI (D111).
- **All other PR9b family work** — PR9b-density (PR #96) and PR9b-search (PR #96) already merged 2026-05-31. PR9b-ai-gating closes the family.

## 3. Architecture

### 3.1 The gating policy

**Wire coupling caveat (read first).** Today, `AiCapabilities` are derived 1:1 from `AiPreviewState.IsOn` at the backend (`CapabilitiesEndpoints.cs:13` returns `state.IsOn ? AiCapabilities.AllOn : AiCapabilities.AllOff`; `PreferencesEndpoints.cs:47` mirrors `aiState.IsOn = config.Current.Ui.AiPreview`). This means every `useAiGate(key)` call returns the same value as `aiPreview` regardless of which capability key is named — the two-factor shape is forward-compat scaffolding for a future product where individual capabilities flip independently of `aiPreview` (e.g., per-user feature flags, A/B rollout of an inbox-ranking algorithm, real-AI seam-swap with cost-controlled per-capability rollout). The migration's behavioral payoff TODAY is consistency of abstraction, not divergent gating. The `AskAiButton` tightening (§ 4.2) and `InboxPage` tightenings (§ 4.6) are no-ops on the current wire — they ensure that when the backend decouples capabilities from `aiPreview` (a V1.X-shaped change), the frontend doesn't need a second sweep. This caveat affects how we frame the work: "wire each AI surface under a single gating policy so future capability decoupling is a backend-only change" — not "fix a bug." See D112 for the deferred backend-decoupling decision.

Today every AI surface independently computes its own gate:

```ts
// OverviewTab.tsx:29-30 — typical site
const aiPreview = preferences?.ui.aiPreview ?? false;
const aiOn = !!capabilities?.summary && aiPreview;
const aiSummary = useAiSummary(prRef, aiOn);
```

The audit pass surfaced three categories of inconsistency:

1. **`AskAiButton.tsx:9`** — gates on `aiPreview` only, no capability check. The component's own header comment ("no backend touchpoint") is a defensible reason for the original omission, but it diverges from the surrounding `AiComposerAssistant` pattern. Tightening to `useAiGate('composerAssist')` aligns the two question-answering surfaces. See § 4.2 for the rationale on the chosen key.

2. **`InboxPage.tsx:20`** — `showCategoryChip = capabilities?.inboxEnrichment === true` gates on capability only, no `aiPreview`. After migration, the category chip respects both flags.

3. **`InboxPage.tsx:21`** — `showActivityRail = preferences?.ui.aiPreview === true` gates on `aiPreview` only, no capability. After migration, the rail respects both. The capability key is `inboxRanking` (the activity rail surfaces ranked PR activity — closest semantic match in `AiCapabilities`).

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

Call-site migration (9 sites — 6 existing + 3 new):

| Site | Current expression | After |
|---|---|---|
| `OverviewTab.tsx:29-30` | `!!capabilities?.summary && (preferences?.ui.aiPreview ?? false)` | `useAiGate('summary')` |
| `PrHeader.tsx:104-106` | `(preferences?.ui.aiPreview ?? false) && !!capabilities?.preSubmitValidators` | `useAiGate('preSubmitValidators')` |
| `AiComposerAssistant.tsx:17` | `!!capabilities?.composerAssist && !!preferences?.ui.aiPreview` | `useAiGate('composerAssist')` |
| `AskAiButton.tsx:9` | `!aiPreview` (no capability check) | `useAiGate('composerAssist')` |
| `InboxPage.tsx:20` (showCategoryChip) | `capabilities?.inboxEnrichment === true` | `useAiGate('inboxEnrichment')` |
| `InboxPage.tsx:21` (showActivityRail) | `preferences?.ui.aiPreview === true` | `useAiGate('inboxRanking')` |
| `FileTree.tsx` (parent: `FilesTab`) | — | `useAiGate('fileFocus')` |
| `DiffPane.tsx` | — | `useAiGate('hunkAnnotations')` |
| `UnresolvedPanel.tsx` (parent of `StaleDraftRow`) | — | `useAiGate('draftSuggestions')` |

**PrHeader coordination.** After migration, `PrHeader.tsx` has two `useAiGate` calls (line 106 for `preSubmitValidators`; the `AskAiButton` instance reads its own gate). The orphan `const aiPreview = preferences?.ui.aiPreview ?? false;` at line 104 is removed. The line 336 prop pass `<AskAiButton aiPreview={aiPreview} ... />` becomes `<AskAiButton onClick={toggleAskAi} />` — see § 4.2.

**`PrDescription` migration policy.** `PrDescription` reads `aiPreview` to switch BOTH the card class AND whether the title element renders (`PrDescription.tsx:21-27`). It is a real gate, not a pass-through — earlier framing has been corrected. The migration rule applied here: components that compute the same gate as their parent keep the prop (avoid duplicate hook calls + re-fetches); components that compute an independent gate migrate to `useAiGate`. `PrDescription`'s gate is the same as `OverviewTab`'s `'summary'` gate, one level up — keep the prop pass. Migration would duplicate the underlying `useCapabilities`/`usePreferences` reads inside the hook for the same value.

### 3.2 Backend endpoints

All three new endpoints are direct clones of `/ai/summary`'s shape — no per-endpoint `IsSubscribed` check (matching the existing endpoint), just resolve the seam and map empty → 204 / populated → 200. The session-token middleware gates all `/api/*` paths automatically, so the new endpoints are NOT unauthenticated:

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

app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/draft-suggestions",
    async (string owner, string repo, int number,
           IAiSeamSelector ai, CancellationToken ct) =>
    {
        var suggester = ai.Resolve<IDraftSuggester>();
        var suggestions = await suggester.SuggestAsync(new PrReference(owner, repo, number), ct).ConfigureAwait(false);
        return suggestions.Count == 0 ? Results.NoContent() : Results.Ok(suggestions);
    });
```

**Auth posture.** The new endpoints — like the existing `/ai/summary` — sit behind `SessionTokenMiddleware`, which enforces session-token presence on all `/api/*` paths (`PRism.Web/Middleware/SessionTokenMiddleware.cs:59`). What `/ai/summary` lacks is a per-endpoint `IsSubscribed` check (the per-PR-subscription presence check that some mutating endpoints add on top). The new endpoints follow the same posture: session-token-gated by middleware, no per-PR subscription gate. PR1 D3's 401→403 flip applied to the Events/Subscribe endpoint's `IsSubscribed`-derived 401, not the AI family. See D111 for the deferred decision on whether to add subscription gating when the seam swaps to real AI.

`AiCapabilities` already has `FileFocus`, `HunkAnnotations`, and `DraftSuggestions` on the wire (`AiCapabilities.cs:5-9`); the frontend already deserializes them (`api/types.ts:45-49`). No capabilities shape change needed.

### 3.3 Frontend data hooks

Three new hooks clone `useAiSummary`'s shape exactly:

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

`useAiHunkAnnotations` and `useAiDraftSuggestions` are structurally identical with `HunkAnnotation[]` and `DraftSuggestion[]` element types respectively.

**Loading state — explicit decision.** The three new hooks (plus the existing `useAiSummary`) all return `T[] | null` where `null` is the union of three states: (a) `enabled` is false, (b) fetch is in-flight, (c) seam returned 204 / network error. No `isLoading` flag is introduced. The downstream consumer (FileTree dot, DiffPane row, StaleDraftRow span, AiSummaryCard) renders nothing for null — matches the off-state visual exactly. The in-flight flash on slow connections is acknowledged as cosmetic (sub-second on canned-data; would be visible on real-AI but real-AI is V1.X-shaped work). Matches `useAiSummary` precedent.

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

`getAiHunkAnnotations` and `getAiDraftSuggestions` mirror the shape. All follow `aiSummary.ts`'s 204 → null convention so the consuming hook has a clean discriminator. The `apiClient` lives at `frontend/src/api/client.ts`.

**Frontend types:**

```ts
// Append to frontend/src/api/types.ts (after existing AI-related types):

export type FocusLevel = 'high' | 'medium' | 'low';

export interface FileFocus {
  path: string;
  level: FocusLevel;
}

export type AnnotationTone = 'calm' | 'heads-up' | 'concern';

export interface HunkAnnotation {
  path: string;
  hunkIndex: number;
  body: string;
  tone: AnnotationTone;
}

export interface DraftSuggestion {
  filePath: string;
  lineNumber: number;
  body: string;
}
```

**Wire-shape (critical):** `JsonSerializerOptionsFactory.Api` (`PRism.Core/Json/JsonSerializerOptionsFactory.cs:35-46`) registers `JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())`. Enums serialize **kebab-case** on the API wire — `FocusLevel.High` → `"high"`, `FocusLevel.Medium` → `"medium"`, `FocusLevel.Low` → `"low"`, `AnnotationTone.Calm` → `"calm"`, `AnnotationTone.HeadsUp` → `"heads-up"`, `AnnotationTone.Concern` → `"concern"`. Property names are camelCase as expected. The frontend literals above match the wire shape exactly. Verified at `JsonSerializerOptionsFactory.cs:44`.

`AnnotationTone` carries three values in the backend (`PRism.AI.Contracts/Dtos/HunkAnnotation.cs:5-10`); the frontend type matches the full union. Today's placeholder data only emits `calm` + `heads-up`, but the wider type allows future placeholder edits or a v2 backend swap to render `concern` correctly without a silent narrowing. See § 4.4 for the tone-to-chip lookup.

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

Rationale documented in D110: reversal cost is one rule deletion if a future cohort signal disagrees with the smaller shape. No cohort signal in either direction at N=3; deferring to handoff parity awaits an actual cohort prompt (the slice's lead-with-evidence default).

### 4.2 AskAiButton (gating consistency tightening)

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

Component loses its `aiPreview: boolean` prop; `PrHeader.tsx:336` drops the prop and stops passing it (verified call site).

**Framing — abstraction consistency, not behavior change.** The component's own header comment notes "no backend touchpoint" — the original `aiPreview`-only gate was defensible (the button itself makes no AI call). Today the change is a no-op behaviorally because capabilities are coupled to `aiPreview` on the wire (see § 3.1 caveat). The sweep tightens this to align with the surrounding `AiComposerAssistant`, which already gates on `composerAssist` for the same question-answering surface area. Picking `'composerAssist'` (over `'summary'` or a new dedicated `'askAi'` key) couples Q&A with composer-assist on the assumption that when the backend decouples capabilities, an operator who wants composer assist off also wants Ask AI off. Note that § 4.6 picks the key by semantic name (`'inboxRanking'` because the activity rail surfaces ranked PR activity); § 4.2 picks by adjacent-surface coupling. The two strategies are reconciled by: name-match where a precise key exists; closest-coupling-surface where it doesn't (no `'askAi'` key exists today). Reversal cost if cohort signal disagrees post-decoupling: add a dedicated `'askAi'` capability key (one-line addition to `AiCapabilities` + this hook arg).

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
    aiPreview={fileFocusEnabled}
  />
);
```

**FileTree builds a path → level map and threads the gate down:**

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
  aiPreview: boolean;                  // ← new (gate state — controls column-slot collapse)
}

const focusByPath = useMemo(() => {
  if (!focusEntries) return null;
  const m = new Map<string, FocusLevel>();
  for (const entry of focusEntries) m.set(entry.path, entry.level);
  return m;
}, [focusEntries]);
```

**FileNodeComponent renders an unconditional column slot that collapses when AI is off** — matches handoff `pr-detail.jsx:38-42` + `screens.css:580-581`'s width-reservation pattern. Prevents row layout shift when `aiPreview` is toggled mid-session:

```tsx
// In FileNodeComponent's return, between <span file-tree-spacer/> and <input>:
const focusLevel = focusByPath?.get(node.path) ?? null;

<span
  className={`file-tree-ai ${styles.fileTreeAi}`}
  data-on={aiPreview ? '1' : '0'}
  aria-hidden="true"
>
  {focusLevel && focusLevel !== 'low' && (
    <span
      className={focusLevel === 'high' ? styles.fileTreeAiHigh : styles.fileTreeAiMed}
      title={`AI focus: ${focusLevel}`}
    />
  )}
</span>
```

The outer `.fileTreeAi` slot is always emitted with `data-on` reflecting the gate state. CSS collapses it to `width: 0` when `data-on='0'`. The inner level dot is conditional on a focus entry matching the row's path (and not Low — handoff CSS doesn't render Low; the wider type lets a future v2 backend emit it without breaking this component).

`aria-hidden="true"` keeps the decorative dot out of AT trees; the `title` attribute is a hover-tooltip-only surface (the focus signal is visual, not assertive UX).

**CSS:**

```css
/* FileTree.module.css — rename + add */

/* Column slot — always emitted in JSX, collapses when AI gate is off.
   Ports handoff `screens.css:580-581` (`.tree-ai` + `.tree-ai[data-on='0']`)
   to prevent row layout shift on aiPreview toggle. */
.fileTreeAi {
  width: 16px;
  display: inline-flex;
  justify-content: center;
  flex: none;
}
.fileTreeAi[data-on='0'] {
  width: 0;
  overflow: hidden;
}

/* OLD .fileTreeAi (D32a dormant) renamed and re-purposed for Medium focus
   with handoff's opacity-dimmed accent. See D110/D32a closure: the dormant
   rule was authored against a single-shape assumption that the handoff
   disproves; renaming with the level suffix is what the §6.2 dormant-CSS
   policy explicitly contemplates. */
.fileTreeAiMed {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.6;
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

Production placeholder data (`PlaceholderData.cs:14-18`) targets `services/leases/LeaseRenewalProcessor.cs` (High) + `services/leases/RenewalRetryPolicy.cs` (Medium). These paths do NOT match the canned `FakePrReader` PR (`src/Calc.cs`), so the placeholder seam against the real fake PR produces zero rendered dots in the default fixture. The Playwright spec (§ 5.5) explicitly overrides with mocked endpoint responses targeting `src/Calc.cs` to demonstrate the High-glow vs Medium-dim differentiation. Aligning `PlaceholderData.cs` with `src/Calc.cs` is a follow-up consideration (see § 9), not blocking PR9b-ai-gating.

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
const DIFF_TABLE_COLSPAN = 3;  // gutter-old / gutter-new / content — verified at DiffPane.tsx:279-297
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

`DIFF_TABLE_COLSPAN = 3` matches the existing `<DiffLineRow>` `<td>` count (gutter-old / gutter-new / content) and the existing comment-row + composer-row wrappers in DiffPane (lines 301 + 333). The `.aiHunkRow` wrapper sets `padding: 0` and zero borders so the inner `.ai-hunk` block defines its own surface.

**Hunk-header line discriminant.** Production `DiffLine.type === 'hunk-header'` literal — verified at `DiffPane.tsx:232` and `DiffPane.tsx:229`. The counter increments only on this discriminant; word-diff overlay rows and DiffTruncationBanner emit different row types so the counter walks cleanly.

**Component rewrite (`AiHunkAnnotation.tsx`):**

```tsx
import type { HunkAnnotation, AnnotationTone } from '../../../../api/types';
import styles from './AiHunkAnnotation.module.css';

export interface AiHunkAnnotationProps {
  annotation: HunkAnnotation;
}

// Tone → chip variant + label lookup. Adding a tone value here is the only
// touch required when the wire shape widens (e.g., a future v2 emits a new
// tone): map to the appropriate chip variant + handoff-aligned label.
const TONE_CHIP: Record<AnnotationTone, { variant: 'info' | 'warning' | 'danger'; label: string }> = {
  calm: { variant: 'info', label: 'Note' },
  'heads-up': { variant: 'warning', label: 'Behavior change' },
  concern: { variant: 'danger', label: 'Concern' },
};

export function AiHunkAnnotation({ annotation }: AiHunkAnnotationProps) {
  const chip = TONE_CHIP[annotation.tone];
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk-annotation">
      <span className="ai-icon" aria-hidden="true">✨</span>
      <div className={styles.aiHunkBody}>
        <div className={`ai-hunk-meta ${styles.aiHunkMeta}`}>
          <span>AI</span>
          <span className={`chip chip-${chip.variant}`}>{chip.label}</span>
        </div>
        <div>{annotation.body}</div>
      </div>
    </div>
  );
}
```

Drops the no-op stub interface. Tone-to-chip mapping replaces the boolean ternary so the wire's `'concern'` value renders as `chip-danger` "Concern" rather than silently falling through to `chip-info` "Note". `chip-info`, `chip-warning`, and `chip-danger` globals are all already in `tokens.css` from prior PRs. `.ai-icon` is also already global.

**`'concern'` tone is forward-compat without handoff parity gate.** Handoff `diff.jsx:134-136` defines only binary severity (`warn` → `chip-warning` "Behavior change"; else → `chip-info` "Note"); there is no handoff visual reference for the `'concern'` tone. The TypeScript exhaustiveness check on `TONE_CHIP` (`Record<AnnotationTone, ...>`) is the correctness mechanism — when a future placeholder or v2 backend emits the third value, the renderer maps it deterministically rather than narrowing silently. Visual review for the `'concern'` chip happens at the moment a real producer emits it; until then, the Playwright spec (§ 5.5 step 4) exercises the chip-danger render path via mocked data so the variant is at least screenshotted before merge. Acknowledged as forward-compat scaffolding with no handoff parity gate.

**Action buttons NOT shipped.** Handoff `.ai-hunk-actions` (Quote in comment / Dismiss) requires composer-seed plumbing for Quote and per-session dismissal state for Dismiss. Both are cross-cutting V1.X work — deferred via D108.

**Replace existing stub `AiHunkAnnotation.module.css`:** (the file ships today as a stub with `.aiHunk`/`.aiHunkMeta`/`.aiHunkActions` — the rewrite replaces it. Drop the dormant `.aiHunkActions` rule since action buttons are deferred per D108.)

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

### 4.5 StaleDraftRow AI suggestion (D48)

**Data path:**

```tsx
// UnresolvedPanel.tsx — call site (DraftLike is the existing comment|reply discriminated
// union at frontend/src/components/PrDetail/draftKinds.ts; reply drafts have no file
// anchor so they never match a suggestion).
const draftSuggestionsEnabled = useAiGate('draftSuggestions');
const allSuggestions = useAiDraftSuggestions(prRef, draftSuggestionsEnabled);

const suggestionFor = useMemo(() => {
  if (!allSuggestions) return null;
  // Map by anchor key. Multiple suggestions on the same anchor are allowed in
  // the contract but unused by v1 placeholder; we surface only the first.
  const m = new Map<string, DraftSuggestion>();
  for (const s of allSuggestions) {
    const key = `${s.filePath}:${s.lineNumber}`;
    if (!m.has(key)) m.set(key, s);
  }
  return m;
}, [allSuggestions]);

// Pass down to each StaleDraftRow. Discriminate on draft.kind first — DraftReplyDto
// has no filePath/lineNumber so the suggestion is always null for reply drafts.
<StaleDraftRow
  ...existing props
  aiSuggestion={
    draft.kind === 'comment' &&
    draft.data.filePath != null &&
    draft.data.lineNumber != null
      ? suggestionFor?.get(`${draft.data.filePath}:${draft.data.lineNumber}`) ?? null
      : null
  }
/>
```

The anchor key `(filePath, lineNumber)` matches the placeholder data's emission shape (`PlaceholderDraftSuggester.cs:12` returns `("services/leases/LeaseRenewalProcessor.cs", 142, "Worth a comment on the retry budget here?")`). PR-root comment drafts (filePath/lineNumber null) and reply drafts (no anchor at all) never match — appropriate behavior; the suggestion surface is line-anchored. § 4.7 aligns `PlaceholderDraftSuggester` with the canned PR so the surface renders in the cohort demo.

**StaleDraftRow gains a prop + handoff-faithful conditional render** (mirrors handoff `pr-detail.jsx:336-342` — a `<div>` flex container with a sparkles icon, a labeled "AI suggestion" header row, and the body text):

```tsx
// StaleDraftRow.tsx — extend Props
interface Props {
  ...existing
  aiSuggestion: DraftSuggestion | null;
}

// In return, between .stale-draft-row-preview and the action buttons:
// (aiSuggestion.body is rendered as a React text node — never via
// dangerouslySetInnerHTML or a markdown parser. The DraftSuggestion contract
// is plain string; any future rich-text rendering requires explicit security
// review.)
{aiSuggestion && (
  <div
    className={`stale-ai ai-tint ${styles.staleAi}`}
    data-testid="stale-draft-ai-suggestion"
  >
    <span className="ai-icon" aria-hidden="true">✨</span>
    <div className={styles.staleAiBody}>
      <div className={`ai-summary-label ${styles.staleAiLabel}`}>AI suggestion</div>
      <div>{aiSuggestion.body}</div>
    </div>
  </div>
)}
```

The element is a `<div>` (not `<span>`) because it contains block-level children — `<span>` enclosing `<div>` is invalid HTML. The `.ai-tint` global (already in `tokens.css:525-528`) supplies the accent-tinted background; `.ai-icon` (already in `tokens.css:530-539`) supplies the icon surface; `.ai-summary-label` (already in `screens.css:91` as a global; verify portage to production globals at implementation time — if absent, lift to `tokens.css` per § 3.1's lift-on-second-use policy since `AiSummaryCard` is the second consumer).

**CSS (append to `StaleDraftRow.module.css`):**

```css
/* AI suggestion row — handoff `pr-detail.jsx:336-342` shape (icon + labeled
   body). Visible when useAiGate('draftSuggestions') is true AND a placeholder
   seam emits a suggestion matching the draft's anchor. D48 closure in
   PR9b-ai-gating. Ports handoff `screens.css:489-494`. */
.staleAi {
  display: flex;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  flex: 1 1 100%;
}

.staleAiBody {
  flex: 1;
  min-width: 0;
}

.staleAiLabel {
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 2px;
}
```

`flex: 1 1 100%` matches the existing `.staleDraftRowPreview` row-wrap pattern (verified at `StaleDraftRow.module.css` — preview also wraps to full width). When the suggestion row is present it consumes its own line below the preview; when absent, no slot is reserved.

### 4.6 InboxPage gating tightening (audit findings)

Two `InboxPage.tsx` sites surfaced during the sweep. Both are one-line migrations:

```tsx
// InboxPage.tsx:20-21 — before
const showCategoryChip = capabilities?.inboxEnrichment === true;
const showActivityRail = preferences?.ui.aiPreview === true;

// after
const showCategoryChip = useAiGate('inboxEnrichment');
const showActivityRail = useAiGate('inboxRanking');
```

The first migration adds the `aiPreview` gate (was capability-only). The second adds the capability gate (was `aiPreview`-only). Both align with the surrounding AI-surface gating pattern. Per § 3.1's coupling caveat, both migrations are no-ops on the current wire — `inboxRanking` and `inboxEnrichment` flip in lockstep with `aiPreview` today. The behavioral payoff lands when the backend decouples capabilities (D112). `useCapabilities` and `usePreferences` direct reads stay only for non-AI fields (none currently in InboxPage). The inline `const { capabilities } = useCapabilities(); const { preferences } = usePreferences();` lines at the top of the function can be removed if no other consumers remain — verify at implementation time.

**Capability key choice for the activity rail:** `inboxRanking` — chosen as the closest semantic match in the current `AiCapabilities` shape (the rail surfaces ranked PR activity). The choice carries a semantic-imprecision liability: a future schema split that introduces a dedicated `activityRail` key would leave this site bound to the wrong key. The reversal cost is named in D112 (one key addition + one call-site swap).

**Layout behavior when the rail is gated away.** When `useAiGate('inboxRanking')` returns false, `<ActivityRail />` doesn't mount. The InboxPage `<div className={styles.grid}>` (verify the actual grid-template-columns at implementation time against `InboxPage.module.css`) collapses to single-column display — the main PR queue expands to fill the row. This is the post-decoupling user experience for capability-off + aiPreview-on; the Playwright spec (§ 5.5 step 2) asserts the single-column state in the off-mode assertion suite.

### 4.7 PlaceholderData alignment with canned PR fixture

The current `PlaceholderData.cs` targets fictional paths from S3-era spec text (`services/leases/LeaseRenewalProcessor.cs`) that don't exist in the canned `FakePrReader` PR (`src/Calc.cs`). Against the placeholder seam (not mocked endpoints), all three new surfaces render nothing in the default cohort fixture — and the cohort demo for D32a + D48 + AiHunkAnnotation appears broken.

Fold the alignment fix into THIS sub-PR (one-file edit, ~10 LOC) so the wiring is visually demonstrable in cohort demos without requiring endpoint mocks:

```csharp
// PRism.AI.Placeholder/PlaceholderData.cs — replace path targets with canned PR's actual file
public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
{
    new FileFocus("src/Calc.cs", FocusLevel.High),
    // Single-file canned PR — only one entry. When FakePrReader grows to
    // multiple files in a future slice, add a Medium entry for the second.
};

public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
{
    new HunkAnnotation("src/Calc.cs", 0, "Reads cleaner - same behavior.", AnnotationTone.Calm),
    // Hunk index 0 is the single hunk in the canned PR. Adding a second
    // entry (HeadsUp at index 1) is deferred until FakePrReader emits a
    // multi-hunk diff — see § 9 follow-on.
};

public static IReadOnlyList<DraftSuggestion> DraftSuggestions { get; } = new[]
{
    new DraftSuggestion("src/Calc.cs", 5, "Worth a comment on the validation here?"),
    // Anchor at line 5 (or whichever line the canned PR's stale-draft
    // fixture targets — verify at implementation time against
    // FakeReviewBackingStore.Scenario's stale-draft anchor).
};
```

The verify-at-implementation-time note for line 5 is real: the canned stale-draft fixture's anchor must match the suggestion line exactly. Read `PRism.Core/PrDetail/FakeReviewBackingStore.cs` for the stale-comment anchor and align. The Playwright spec (§ 5.5) continues to mock endpoints for the multi-tone HunkAnnotation case (Calm + HeadsUp + Concern) since the placeholder ships only one canned hunk annotation — placeholder alignment + Playwright mocks are complementary, not redundant.

The single-tone placeholder constraint is acknowledged: the cohort demo shows one Calm annotation; the Playwright spec exercises all three tones. § 9 carries the follow-on "grow FakePrReader to multi-hunk + add HeadsUp/Concern placeholder entries."

## 5. Tests

### 5.1 Vitest — new (6 specs)

| File | Coverage |
|---|---|
| `frontend/__tests__/useAiGate.test.tsx` | Returns `false` when capability off (mocked); `false` when `aiPreview` off; `true` only when both on; handles `capabilities`/`preferences` `null` (returns `false`); narrows by key — `useAiGate('summary')` reads only `capabilities.summary`. |
| `frontend/__tests__/useAiFileFocus.test.tsx` | Fetches when `enabled === true`; returns `null` when `enabled === false`; handles 204 (null sentinel); handles network error silently (matches `useAiSummary` precedent); cleanup on prRef change. |
| `frontend/__tests__/useAiHunkAnnotations.test.tsx` | Same shape as `useAiFileFocus`. |
| `frontend/__tests__/useAiDraftSuggestions.test.tsx` | Same shape as `useAiFileFocus`. |
| `frontend/__tests__/AiHunkAnnotation.test.tsx` | `tone: 'calm'` → renders `"Note"` + `chip-info`; `tone: 'heads-up'` → renders `"Behavior change"` + `chip-warning`; `tone: 'concern'` → renders `"Concern"` + `chip-danger`; body text rendered; `.ai-icon` rendered with `aria-hidden`; `data-testid="ai-hunk-annotation"` present. |
| `frontend/__tests__/AskAiButton.test.tsx` | Renders when `composerAssist + aiPreview` both true; does NOT render when `composerAssist === false` but `aiPreview === true` (documents the consistency fix); does NOT render when `aiPreview === false`. (Today the only `AskAiButton` coverage is incidental via `PrHeader.test.tsx`; this is a fresh, focused spec.) |

### 5.2 Vitest — existing extended (3 specs)

| File | New assertions |
|---|---|
| `frontend/__tests__/FileTree.test.tsx` | `level: 'high'` → renders element with `.fileTreeAiHigh` class; `level: 'medium'` → `.fileTreeAiMed`; `level: 'low'` → no inner dot rendered (slot still emitted); not in focusEntries → no inner dot; outer `.fileTreeAi` slot always emitted with correct `data-on`; title attribute matches `"AI focus: high\|medium"`; `aria-hidden="true"` present. |
| `frontend/__tests__/UnresolvedPanel.test.tsx` (or wherever StaleDraftRow is covered today) | Matching suggestion → renders `.stale-ai` with body text; no matching suggestion → no `.stale-ai` rendered; PR-root draft (null filePath/lineNumber) → no `.stale-ai` rendered. |
| `frontend/__tests__/InboxPage.test.tsx` | `inboxEnrichment + aiPreview` both true → `showCategoryChip` true; either off → false; `inboxRanking + aiPreview` both true → `showActivityRail` renders the rail; either off → no rail. |

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

Specs that test the migrated component's other behavior (not the gate) can keep their existing mock setup — only the gate-specific fixtures simplify. Migration boundary: if a test builds a `capabilities + preferences` fixture *solely* to drive an AI gate, it migrates; if the fixture also drives non-AI state (e.g., theme, density, inbox-section behavior), the existing mocks stay alongside an added `useAiGate` mock.

### 5.4 Backend dotnet test — new (3 specs)

| File | Coverage |
|---|---|
| `tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs` | 200 with array body when seam returns populated; 204 when seam returns empty; route binding correct (owner/repo/number passed through); **401 without `X-PRism-Session` header / cookie** (asserts the new endpoint is covered by `SessionTokenMiddleware`'s `/api/*` enforcement — catches accidental middleware exemptions). |
| `tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs` | Same three cases (200, 204, 401). |
| `tests/PRism.Web.Tests/Endpoints/AiDraftSuggestionsEndpointTests.cs` | Same three cases (200, 204, 401). |

Mirrors `tests/PRism.Web.Tests/Endpoints/AiEndpointsTests.cs` structure verbatim. The 401-without-session-token assertion is added explicitly so an implementer who accidentally widens `SessionTokenMiddleware`'s `/api/health`-style exemption to include `/ai/*` paths is caught by CI rather than shipping unauthenticated AI endpoints. No per-endpoint `IsSubscribed` test needed — endpoints follow `/ai/summary`'s no-per-endpoint-gate precedent per § 3.2. The middleware enforcement is also covered by existing `SessionTokenMiddleware` unit tests at the middleware level; these new tests add per-route spot-checks.

### 5.5 Playwright e2e — new (1 spec)

`frontend/e2e/ai-gating-sweep.spec.ts` — single spec covering the canonical user flow:

1. Land on PR detail with `aiPreview` off (default fixture).
2. Assert: no AI summary card visible (`getByTestId('ai-summary-card')` not present); no FileTree dots (`.fileTreeAiHigh, .fileTreeAiMed` count zero — the outer `.fileTreeAi` slot exists but is collapsed); no `.ai-hunk` blocks (`getByTestId('ai-hunk-annotation')` count zero); no Ask AI button (`getByRole('button', { name: 'Ask AI' })` not present); no `.stale-ai` row (`getByTestId('stale-draft-ai-suggestion')` not present); navigate to Inbox tab and assert no activity rail visible AND the inbox grid is single-column (`getByTestId('inbox-grid')` has only one column child — verify the assertion shape against InboxPage.module.css's grid layout at implementation time).
3. Register endpoint mocks BEFORE toggling (intercept-first pattern — eliminates the race window):
   - `POST /api/preferences` → 204
   - `GET /api/pr/.../ai/summary` → 200 placeholder summary
   - `GET /api/pr/.../ai/file-focus` → 200 `[{path: 'src/Calc.cs', level: 'high'}, {path: 'src/Calc.Tests.cs', level: 'medium'}]` (kebab-case enum per § 3.3 wire-shape note)
   - `GET /api/pr/.../ai/hunk-annotations` → 200 with at least one Calm + one HeadsUp + one Concern annotation matching real hunk indices in the canned PR's first file
   - `GET /api/pr/.../ai/draft-suggestions` → 200 with at least one suggestion matching the stale-draft fixture's anchor
4. Toggle `aiPreview` on via the AI preview toggle in `HeaderControls` — locator `getByRole('button', { name: /AI preview/i })` (the toggle is a `<button>` with `aria-pressed`, not `role="switch"` — verified at `AiPreviewToggle.tsx:8-11`). Use `waitForResponse('/api/preferences')` on the toggle POST before subsequent assertions.
5. Assert: AI summary card visible; FileTree shows one `.fileTreeAiHigh` + one `.fileTreeAiMed` (outer `.fileTreeAi` slot count matches files.length, regardless of toggle state); DiffPane (after navigating to Files tab + selecting the matching file) shows all three `.ai-hunk` blocks (Calm → "Note" / `chip-info`, HeadsUp → "Behavior change" / `chip-warning`, Concern → "Concern" / `chip-danger`) immediately after their matching hunk headers; the stale-draft fixture row shows `.stale-ai` with sparkles icon + "AI suggestion" label + body text; Ask AI button visible; activity rail visible on Inbox tab; inbox grid is two-column.
6. Toggle `aiPreview` off; assert all surface classes disappear (FileTree `.fileTreeAi` slot collapses to `width: 0` but remains in the DOM; inbox grid collapses back to single-column).

**Race prevention:** Mock registrations BEFORE the toggle fires (Playwright `page.route` calls precede `page.locator(...).click()`). Use `waitForResponse` on the toggle POST before subsequent assertions, per `feedback_windows_ci_fixed_delay_flake` memory. Don't use fixed sub-second delays. The `feedback_test_factory_configurewebhost` precedent applies for backend test factories.

### 5.6 Parity baselines

No new baselines. Per spec § 5, "no new parity baselines unless the wiring changes visible chrome." The dots + annotations + suggestion spans are inside content surfaces (FileTree row, DiffPane body, reconciliation panel); they don't change zone topology covered by existing baselines.

**Re-capture required** for three existing baselines because the new DOM is part of those zones:
- `pr-detail-files-tree.png` — FileTree row gains the `.fileTreeAi` column slot (collapsed in off-state baseline; verify no visual shift on capture).
- `pr-detail-files-diff.png` — DiffPane is unchanged in off-state (no annotations render when gate is off); verify no visual shift.
- `pr-detail-reconciliation-panel.png` — StaleDraftRow gains the `.stale-ai` conditional; off-state baseline should match today.

Flag in PR body as expected re-capture. Capture all baselines in `aiPreview: false` state (default).

## 6. Validation per slice § 5

Code-PR validation in full:

1. **Side-by-side screenshot in PR description** per `.ai/docs/design-handoff.md`. Capture FileTree row with both dots visible + DiffPane with all three tone annotations visible + StaleDraftRow with suggestion span (`aiPreview: on` state). Optional second pair for `aiPreview: off` to demonstrate clean absence.
2. **Re-captured viewport baselines** (`pr-detail-files-tree.png`, `pr-detail-files-diff.png`, `pr-detail-reconciliation-panel.png`) committed in the same PR. No new zones.
3. **All existing tests pass.** Vitest, dotnet test, Playwright. The `useAiGate` hoist changes test-mock shape for ~4-6 specs; those tests must update in the same PR.
4. **Pre-push checklist** per `.ai/docs/development-process.md`: `npm run lint`, `npm run build`, `npm test`, `dotnet build --configuration Release`, `dotnet test --no-build --configuration Release`, Playwright where applicable.

## 7. Cross-cutting risks

### 7.1 Re-capture asymmetry — off-state baseline drift

The off-state baselines capture in `aiPreview: false` (the default fixture). The new DOM additions:
- FileTree's outer `.fileTreeAi` slot collapses via `width: 0; overflow: hidden` when `data-on='0'` — should produce zero visual shift in off-state, but verify on capture.
- DiffPane's annotation row emission depends on `annotationsForFile != null` — null when gate is off, so no `<tr>` injected. Off-state matches today.
- StaleDraftRow's `.stale-ai` span is conditional on `aiSuggestion != null` — null when gate is off, so no span injected. Off-state matches today.

If any off-state baseline drifts, that's a bug to fix before the baseline lands (likely the FileTree column collapse not collapsing cleanly).

### 7.2 Hunk-index counter correctness

The `hunkCounter` walk in DiffPane increments on each `line.type === 'hunk-header'` row. The discriminant is verified against `DiffPane.tsx:232` (the rendering switch reads `line.type === 'hunk-header'`). Word-diff overlay rows + DiffTruncationBanner emit different row shapes (DiffTruncationBanner is rendered at the foot, outside the line walk; word-diff is inline within `'insert'`/`'delete'` rows). The counter is correct as long as production `DiffLine` keeps the `'hunk-header'` literal type. If a future refactor changes the discriminant, this code drifts silently — covered by the Playwright spec's annotation-count assertion.

`PlaceholderData.HunkAnnotations` indexes 0 and 2 (hunks 0 and 2 in the canned annotator). The canned `FakePrReader` PR (`src/Calc.cs`) has only a single hunk, so these indices never match the real fake. The Playwright spec mocks the endpoint to return annotations indexed to hunks the canned PR actually contains.

### 7.3 `useAiGate` mock-shape ripple

Migrating 4-6 existing component tests to mock `useAiGate` instead of `useCapabilities`+`usePreferences` is mechanical but touches every AI-gated component test. Don't over-rewrite — only the test setup that builds capabilities/preferences fixtures *solely for the gate compute* simplifies. Tests that exercise other consumers of `useCapabilities` / `usePreferences` (e.g., density toggle, theme) keep their existing fixtures. Identify the surgical edit boundary at implementation time.

### 7.4 Endpoint per-PR vs per-hunk/per-file shape divergence (D109)

The seam interfaces support more granular calls than the v1 endpoints exercise:
- `IHunkAnnotator.AnnotateAsync(prRef, filePath, hunkIndex, ct)` — v1 calls with `("", 0)` sentinels.
- `IDraftSuggester.SuggestAsync(prRef, ct)` — v1 calls correctly.
- `IFileFocusRanker.RankAsync(prRef, ct)` — v1 calls correctly.

The `IHunkAnnotator` mismatch is real: v1 violates the seam's `(prRef, filePath, hunkIndex)` contract by passing empty-string/zero sentinels. A future v2 implementer who reads `filePath` (for telemetry, cost control, or argument validation) silently breaks against the v1 endpoint. D109 documents this; the proper fix is V1.X-shaped — either widen the seam (add `AnnotateAllAsync(prRef, ct)` for per-PR queries) or split the endpoint per-file. The inline comment in § 3.2 names this debt at the call site.

### 7.5 Auth posture across the `/ai/*` family

The session-token middleware (`SessionTokenMiddleware.cs:59`) enforces session-token presence on all `/api/*` paths in Production and Test environments — including the new endpoints. The middleware bypasses enforcement in Development (`SessionTokenMiddleware.cs:40` comment "accepting unauthenticated /api/* in that environment matches the…"). The new endpoints inherit both behaviors.

What the AI family lacks (relative to mutating endpoints like submit/resume/discard) is a per-endpoint `IsSubscribed` check — the per-PR subscription presence check from `IActivePrCache.IsSubscribed(prRef)`. The existing `/ai/summary` doesn't have one, and the three new endpoints don't add one. Rationale: `IsSubscribed` is a presence-not-identity check that protects write semantics against PRs the user never loaded. Read-only AI endpoints with no mutation side effects don't require it.

This reasoning holds for canned-data seams. When the seam binding swaps to real AI (V1.X+, see D109 for endpoint redesign trigger), the seam may produce data derived from the actual PR content — per-file paths, per-hunk-content annotations, real-draft-content suggestions. At that point, adding `IsSubscribed` becomes worth re-evaluating: a session-authenticated caller without an active subscription would otherwise be able to enumerate seam output for arbitrary PRs. See D111.

### 7.6 PlaceholderData multi-tone constraint

After § 4.7 alignment, `PlaceholderData.cs` targets `src/Calc.cs` and the canned fixture renders the FileTree dot + AiHunkAnnotation + StaleDraftRow suggestion in default cohort demos. One residual constraint: the placeholder ships ONE hunk annotation (Calm tone) because the canned `FakePrReader` PR emits a single hunk. The HeadsUp and Concern tone variants only render through Playwright-mocked responses (§ 5.5 step 4 ships all three) — the cohort demo shows the wiring without exercising every tone variant. § 9 carries the follow-on "grow FakePrReader to multi-hunk + add HeadsUp/Concern placeholder entries" for when the canned fixture gains a second hunk.

## 8. Deferrals (6 new D-entries)

All six entries land in `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` under a new `## PR9b-ai-gating — Selective wirings` section appended after the existing `## PR9b-search` and `## PR9b-density` sections.

(D107 — the originally-planned D48 deferral — is NOT created. The ce-doc-review pass surfaced that the `IDraftSuggester` seam, `PlaceholderDraftSuggester`, `AiCapabilities.DraftSuggestions`, and the frontend wire shape ALL already exist. The original "no seam exists" premise was empirically wrong. D48 is wired in this sub-PR — see § 4.5.)

### 8.1 D106 — D28 iter-new-dot DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; D28 original deferral.
**Covers:** D28 — IterationTabStrip iter-new-dot wiring.
**Verdict rationale:** No backend `IterationDto.IsNew` flag exists. Adding it requires either a backend signal (would need design — what's "new"? Server-side: since last user visit? Last cluster computation? Frontend-side: relative to a session-tracked baseline?) OR a frontend-synthetic "newest iteration on first load" heuristic backed by `localStorage`/`sessionStorage`. Both paths are session-memory work whose right home is a separate design pass, not the AI-gating sweep. The dot was framed as AI in the handoff but is structurally a session-state signal, not an AI signal — conflating them muddies the sweep's purpose.
**Status:** DEFER-TO-V1.X.
**Reopener:** Backend `IterationDto.IsNew` flag added OR explicit cohort signal requesting iteration-recency indication.
**Cross-refs:** D28; D87; spec § 4.9.2.

### 8.2 D108 — AiHunkAnnotation action buttons (Quote / Dismiss) DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31; surfaced during AiHunkAnnotation rewrite design.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; handoff `.ai-hunk-actions` (`diff.jsx:139-142`, `screens.css:835`).
**Covers:** Handoff `<div className="ai-hunk-actions">` with two action buttons: "Quote in comment" + "Dismiss".
**Verdict rationale:** Quote requires composer-seed plumbing — `InlineCommentComposer` doesn't accept a `seed: string` prop today; threading one through requires touching the composer prop chain + the open-composer registry + the per-anchor draft session. Dismiss requires per-session dismissal state — no `dismissedAnnotations` set exists; building one is session-state design work parallel to D106. Both are cross-cutting V1.X work whose absence doesn't break the informational read of the annotation.
**Status:** DEFER-TO-V1.X. Annotation ships informational-only (sparkles icon + "AI" label + tone chip + body).
**Reopener:** Cohort signal requesting Quote-in-comment OR a session-state design pass lands the dismissal model.
**Cross-refs:** D87; D106 (parallel session-state shape).

### 8.3 D109 — Endpoint per-PR vs seam per-hunk/per-file shape divergence

**Source:** PR9b-ai-gating brainstorm 2026-05-31; ce-doc-review adversarial pass sharpened the framing from "documentation note" to "contract violation."
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; `IHunkAnnotator.AnnotateAsync(prRef, filePath, hunkIndex)` seam interface.
**Reality:** The `IHunkAnnotator` seam method takes `(prRef, filePath, hunkIndex)` for v2 streaming / cost-control use. The v1 endpoint `GET /ai/hunk-annotations` returns all annotations for the PR in one fetch — calls the seam with empty path + 0 index; the placeholder ignores both args. `IFileFocusRanker.RankAsync` and `IDraftSuggester.SuggestAsync` take per-PR signatures already so their endpoints align cleanly. The hunk-annotator violation is real — a future v2 implementer that reads `filePath` for telemetry/validation silently breaks against the v1 endpoint.
**Verdict rationale:** A future v2 real-AI backend will want per-hunk fetches (real generation is expensive; per-PR pre-generation doesn't scale). The seam interface supports that shape; the v1 endpoint doesn't. The proper fix is V1.X-shaped — either widen the seam (add a per-PR `AnnotateAllAsync(prRef, ct)` overload alongside the existing per-hunk method) or split the endpoint per-file/per-hunk. The v1 endpoint comment names the debt at the call site.
**Status:** DEFER-TO-V1.X (endpoint redesign + seam-widening when real-AI backend ships).
**Reopener:** Real AI backend swap-in at the `IHunkAnnotator` seam.
**Cross-refs:** D87; D111; § 6.4; § 7.4.

### 8.4 D110 — D24 verdict CONFIRMED smaller AiSummaryCard shape

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating verdict; D24 original deferral.
**Covers:** D24 — AiSummaryCard active-shape parity delta (current smaller `.pr-ai-summary` shape vs handoff's larger `.overview-card-hero`).
**Verdict rationale:** No cohort signal in either direction at N=3; deferring to handoff parity awaits an actual cohort prompt. The current shape (`padding: var(--s-3) var(--s-4); border-radius: var(--radius-3)` via `.aiSummaryCard` module rule) ships unchanged. The `AiSummaryCard.module.css` comment header rewrites to reference D110 (this entry) instead of D24, but no rule changes. Reversal is one rule deletion (drop `padding` + `border-radius` from `.aiSummaryCard`) — cheap if a future cohort surfaces growth pressure.
**Status:** CONFIRMED.
**Cross-refs:** D24; D87; § 4.9.2; § 6.4.

### 8.5 D111 — Per-endpoint `IsSubscribed` gating on `/ai/*` family DEFER-TO-V1.X

**Source:** PR9b-ai-gating ce-doc-review security-lens + adversarial pass.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; § 7.5 auth posture rationale.
**Reality:** The session-token middleware (`SessionTokenMiddleware.cs:59`) gates all `/api/*` paths including `/ai/summary` and the three new AI endpoints. Per-endpoint `IsSubscribed` check (the per-PR subscription presence check from `IActivePrCache.IsSubscribed`) is absent from `/ai/summary` and not added to the new endpoints.
**Verdict rationale:** `IsSubscribed` is a presence-not-identity check that protects write semantics against PRs the user never loaded. Read-only AI endpoints with no mutation side effects don't require it when the seam returns canned data — anyone gets the same placeholder. This reasoning ages badly when the seam swaps to real AI: the same endpoint path would surface PR-content-derived output to any session-authenticated caller. The seam swap is V1.X-shaped (D109); the auth-gating decision swaps at the same time.
**Status:** DEFER-TO-V1.X.
**Reopener (enforced):** Same trigger as D109 — real AI backend swap-in at any of the three seams. **The seam-swap PR MUST include the per-endpoint `IsSubscribed` gate in the same atomic merge** (mirroring the mutating-endpoint pattern). Merging a real-AI seam binding without D111 closure is a security regression. Inline `// D111` comments at each of the three new `app.MapGet(...)` calls in `AiEndpoints.cs` anchor the reopener in the code the implementer touches when swapping the binding, so the reminder isn't sidecar-doc-only. Comment template: `// D111: No per-PR IsSubscribed check while seam is canned-data only. When the binding swaps to a real AI implementation (real generation, not Noop/Placeholder), add an IsSubscribed gate before the seam call — DO NOT merge the seam swap without this gate.`
**Cross-refs:** D109; § 7.5.

### 8.6 D112 — `useAiGate` two-factor abstraction's behavioral payoff is post-decoupling

**Source:** PR9b-ai-gating ce-doc-review adversarial round 2 (adv-r2-001).
**Spec position:** § 3.1 wire-coupling caveat; § 4.2 + § 4.6 framing.
**Reality:** Today, `CapabilitiesEndpoints.cs:13` returns `AllOn` xor `AllOff` based on `AiPreviewState.IsOn`, and `PreferencesEndpoints.cs:47` mirrors `aiState.IsOn = config.Current.Ui.AiPreview`. Every `useAiGate(key)` call returns the same value as `aiPreview` regardless of key. The two-factor abstraction is forward-compat scaffolding for backend capability decoupling.
**Verdict rationale:** Backend decoupling (per-user feature flags, A/B rollout of inbox ranking, real-AI seam-swap with cost-controlled per-capability rollout) is V1.X-shaped infrastructure work. The PR9b-ai-gating sweep ships the frontend gate shape now so that when the backend decouples, no frontend follow-up is required — the decoupling lands as a backend-only change. Two semantic-imprecision liabilities surface in advance: (1) `useAiGate('composerAssist')` for `AskAiButton` couples Ask AI with composer-assist; (2) `useAiGate('inboxRanking')` for the activity rail couples the rail's visibility with the ranking algorithm. Both are documented for cohort signal monitoring post-decoupling.
**Status:** DEFER-TO-V1.X.
**Reopener:** Backend capability decoupling lands. When `AiCapabilities` stops mirroring `AiPreviewState.IsOn`, re-evaluate the two key choices documented above; either confirm the coupling-by-name or add dedicated `askAi` / `activityRail` keys (one-line additions to `AiCapabilities` + call-site swaps).
**Cross-refs:** § 3.1 coupling caveat; § 4.2 + § 4.6 key-choice rationale; D109 + D111 (real-AI swap pulls capability decoupling forward).

## 9. Open follow-ons (post-merge)

Captured here for cohort-driven re-prioritization; not blocking PR9b-ai-gating ship:

- **D109 + D111 paired reopener** — when the real AI backend ships at any of the three AI seams, redesign endpoints (per-file or per-hunk where appropriate) AND add per-endpoint `IsSubscribed` gating atomically in the same merge.
- **D108 reopener** — cohort Quote/Dismiss signal triggers the cross-cutting action-button work for `AiHunkAnnotation`.
- **D106 reopener** — backend signal arrives (D28 `IterationDto.IsNew` flag).
- **D112 reopener** — backend `AiCapabilities` decouples from `AiPreviewState.IsOn`. At that point, the semantic-imprecision liabilities documented in § 4.2 (`composerAssist` for AskAiButton) and § 4.6 (`inboxRanking` for activity rail) become real and may need dedicated `askAi` / `activityRail` capability keys.
- **Multi-hunk `FakePrReader` PR + HeadsUp/Concern placeholder entries** — § 7.6 acknowledges the single-tone constraint. When `FakePrReader` grows to a multi-hunk diff, add `(src/Calc.cs, 1, "…", AnnotationTone.HeadsUp)` + a Concern entry to `PlaceholderData.HunkAnnotations` so all three tone variants render in cohort demos without endpoint mocks.
- **Backend enum-validation gap (carried from PR #96 Deviation 6)** — `density`/`theme`/`accent` accept arbitrary strings on `POST /api/preferences`. Parallel gap for `aiPreview` (it's a `bool` so type-validation catches non-bool input; enum-validation N/A here). Worth tracking as a backend follow-up.
- **`PrDescription` carried review note** — adv-005 surfaced that `PrDescription`'s `aiPreview` prop is a gate not a pass-through (controls card class AND title-element rendering). § 3.1 keeps the prop pass because the parent (`OverviewTab`) already computes the same `'summary'` gate — migration would duplicate the underlying hook reads. If a future refactor moves `PrDescription` out from under `OverviewTab` (e.g., to a sibling tab), migrating to `useAiGate('summary')` directly is the natural follow-up.

## 10. Self-review

Run before handing to ce-doc-review and user-review:

- [ ] **Placeholder scan:** No "TBD" / "TODO" / "implement later" text in any normative section.
- [ ] **Internal consistency:** All four new D-entries match the deferrals listed in § 2.2. The migration table in § 3.1 (9 sites) matches the per-site rewrites in § 4. The endpoint paths in § 3.2 (3 endpoints) match § 2.1 and § 5.4.
- [ ] **Scope check:** The doc covers exactly one sub-PR's work — wire 4 AI surfaces named in origin § 6.4 + close 4 deferrals.
- [ ] **Ambiguity check:** Every wire-shape decision names the source of truth (handoff JSX/CSS line numbers; backend record names; existing-precedent file paths).
- [ ] **Implementer-readable:** Every section is concrete enough that a fresh implementer can act on it without re-reading the slice spec end-to-end.

---

**Origin:** [`docs/specs/2026-05-29-design-parity-recovery-design.md § 4.9.2`](2026-05-29-design-parity-recovery-design.md).
**Sidecar:** [`docs/specs/2026-05-29-design-parity-recovery-deferrals.md`](2026-05-29-design-parity-recovery-deferrals.md) — D106, D108-D112 land here on merge.
**Family siblings:** PR9b-density + PR9b-search shipped together as PR #96 (merge 2026-05-31).
