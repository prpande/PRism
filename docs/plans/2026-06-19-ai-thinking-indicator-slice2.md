# AI "thinking" indicator — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Slice-1 "AI is thinking" idiom to the three remaining AI surfaces — the Hotspots tab (working marker on the tab label + skeleton regen to the #520 row shape), the inbox kind-of-change chip (working marker while enrichment is in flight, backed by a new per-PR "settled" signal), and the stale-draft suggestion overlay (one region-level working cue on `UnresolvedPanel`). **Also folds in #548**: stop the Preview-mode placeholder category ("Refactor") from leaking into Live/Off by invalidating inbox enrichments on an AI-mode change — the inbox chip work is the natural home for that fix, and this slice's settled signal is what lets the post-invalidation state show an honest in-progress cue rather than a stale placeholder.

**Architecture:** Reuse the Slice-1 primitives unchanged — `AiMarker state="working"` (hue-token differentiator, reduced-motion-safe) and `AiLoadState = 'loading' | 'ready' | 'empty' | 'error'`. Extract the file-focus→marker-state reduction Slice 1 inlined in `FileTree.tsx` into one shared helper now that a second caller (Hotspots tab) needs the identical mapping. Add a per-PR `AiEnrichmentSettled` set on `InboxSnapshot`/`InboxResponse` (modeled on `CiProbeComplete`) so the chip placeholder can resolve to *nothing* on "settled, no chip" instead of pulsing forever; and subscribe the inbox orchestrator to `IConfigStore.Changed` so an AI-mode change clears stale enrichments and force-notifies the FE (#548). This is Slice 2 of `docs/specs/2026-06-19-ai-thinking-indicator-design.md` (§3, §5, §7); Slice 1 (foundation + summary/file-tree/annotator) shipped in PR #543.

**Tech Stack:** React 18 + TypeScript + Vite, CSS Modules + global `tokens.css`, Vitest + Testing Library, Playwright (visual e2e); backend C# (.NET, minimal APIs), xUnit.

## Global Constraints

- Branch base: **V2** (worktree `feature/ai-thinking-indicator-slice2` at `D:/src/PRism/.claude/worktrees/ai-thinking-slice2`). Run all commands from the worktree root. **#508 is a GATED issue** (backend risk + visual): the human spec/plan + B1 visual gates are retained; do not self-approve. **This PR closes #508 (Slice 2) and #548.**
- **No change to AI behaviour/output** — enrichment categories, focus thresholds, which files/hunks are flagged, summarizer content are untouched. State-plumbing + visuals + the #548 mode-change invalidation only.
- The **only** indicator component is `AiMarker`; do not introduce a parallel one. Working↔idle differentiator is the `--ai-working-color` hue token, **not** motion; under `prefers-reduced-motion` the pulse drops and the hue alone differentiates (already built in Slice 1 — do not re-touch `AiMarker.module.css` tokens).
- **`Enrichments` map semantics (precise):** the **`OnInboxEnrichmentsReady` (async-merge) path** stores chip-only entries (the `if (r.CategoryChip is null) continue;` drop at `InboxRefreshOrchestrator.cs:402` stays). The **main refresh path** builds `enrichmentMap` from the enricher's *cached* results, which **can include cached null-chip "Other" entries** (the enricher caches confident nulls — `ClaudeCodeInboxItemEnricher.cs:133`). So a row can be in `Enrichments` with `categoryChip == null`. The FE derivation handles both uniformly: `categoryChip ? ready : empty`. Do not assume "present in Enrichments ⇒ has a chip."
- Inbox settled signal is a **per-PR set** (`AiEnrichmentSettled`), not a bool — enrichment arrives progressively (cached hits sync, misses via background `InboxEnrichmentsReady` batches), so a snapshot-wide bool can't represent it.
- **Chip-pulse invariant:** the inbox chip shows `working` ONLY while a backend enrichment is genuinely in flight. The FE gate `showCategoryChip` (= `useAiGate('inboxEnrichment')`) must track backend enrichment availability. Today `useAiGate` derives capability from `aiMode` so this holds (Off → no chip, no pulse). **Cross-dependency: #536 (per-feature AI toggles) is wiring real per-flag capabilities** — if that lands first, re-check that a client cannot have `inboxEnrichment` capability `true` while the resolved backend seam is Noop/unconsented (which would leave the set permanently empty → perpetual pulse). Re-verify this seam before this PR ships if both are in flight.
- Draft cue is **region-level, not per-draft** — `useAiDraftSuggestions` is a single PR-wide fetch; a per-draft marker would flash working→nothing on drafts that get no suggestion (the positional-promise failure fixed in Slice 1).
- Run unit tests with the **local** binary `node_modules/.bin/vitest` (never `npx vitest`) from `frontend/`. Typecheck with `node_modules/.bin/tsc -b` (never `tsc --noEmit`). Run `npm run lint` (prettier `--check` gates CI) before any commit. Backend: `dotnet test` (timeout ≥ 300000ms, foreground, one at a time).
- A duplicate test tree exists at `frontend/__tests__/`. The **full** vitest suite is the gate (scoped runs miss the shadow dir). Grep it for any of the files this plan touches before claiming green.

---

## File Structure

**New files:**
- `frontend/src/components/Ai/fileFocusMarkerState.ts` + `.test.ts` — shared `fileFocusStatusToMarkerState(status)` (Task 1).

**Modified — frontend:**
- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` — refactor the inlined reduction to the helper (Task 1, no behavior change).
- `frontend/src/components/PrDetail/PrSubTabStrip.tsx` (+ `.test.tsx`) — `aiMarker?: boolean` → `aiMarkerState?: 'idle'|'working'|null` (Task 2).
- `frontend/src/components/PrDetail/PrHeader.tsx`, `frontend/src/components/PrDetail/PrDetailView.tsx` — thread `hotspotsAiState` (Task 2).
- `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx` (+ `.module.css`, + `.test.tsx`) — skeleton regen (Task 3).
- `frontend/src/api/types.ts` — `InboxResponse.aiEnrichmentSettled: string[]` (Task 6).
- `frontend/src/pages/InboxPage.tsx`, `frontend/src/components/Inbox/InboxSection.tsx`, **`frontend/src/components/Inbox/RepoGroupAccordion.tsx`** (the DEFAULT grouped render path — a second `InboxRow` parent), `frontend/src/components/Inbox/InboxRow.tsx` (+ `.module.css`, + `InboxRow.test.tsx`) — thread the settled set + per-row chip state (Task 6).
- `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx` (+ `.module.css`, + `.test.tsx`) — region-level draft cue (Task 7).
- `frontend/src/components/Ai/aiStrings.ts` — new sr-only labels (Tasks 6, 7).

**Modified — backend:**
- `PRism.Core/Inbox/InboxSnapshot.cs` — add `AiEnrichmentSettled` (Task 4).
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — populate it (main path + `OnInboxEnrichmentsReady`) (Task 4); subscribe to `IConfigStore.Changed` for mode-change invalidation (Task 5, #548).
- `PRism.Web/Endpoints/InboxDtos.cs` + `InboxEndpoints.cs` — wire `AiEnrichmentSettled` onto `InboxResponse` (Task 4).
- Backend test files under `PRism.Core.Tests`/`PRism.Tests` constructing `InboxSnapshot`/`InboxResponse` or asserting the orchestrator (Tasks 4, 5).

---

### Task 1: Extract the shared `fileFocusStatusToMarkerState` helper

**Why first:** Tasks 2 (Hotspots tab) and the existing Slice-1 file-tree header both need the identical file-focus→marker-state mapping. Slice 1 inlined it with a YAGNI note. **Note on spec §1's YAGNI directive:** that directive forbids extracting a shared `toAiLoadState` reducer (the `AiLoadState` mapping) until a third caller appears. This helper is a *different* reduction — `FileFocusStatus` → marker state — and it has two real callers in this slice (file-tree header + Hotspots tab), so extraction is justified, not gold-plating.

**Files:** Create `frontend/src/components/Ai/fileFocusMarkerState.ts` + `.test.ts`; Modify `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (the `headerMarkerState` block, ~lines 176–183).

**Interfaces:** Produces `fileFocusStatusToMarkerState(status: FileFocusStatus): 'idle' | 'working' | null`. Consumes `FileFocusStatus` from `frontend/src/api/types.ts`.

- [ ] **Step 1: Write the failing test.** `frontend/src/components/Ai/fileFocusMarkerState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileFocusStatusToMarkerState } from './fileFocusMarkerState';

describe('fileFocusStatusToMarkerState', () => {
  it('maps loading to working', () => {
    expect(fileFocusStatusToMarkerState('loading')).toBe('working');
  });
  it('maps resolved-with-content states to idle', () => {
    expect(fileFocusStatusToMarkerState('ok')).toBe('idle');
    expect(fileFocusStatusToMarkerState('empty')).toBe('idle');
    expect(fileFocusStatusToMarkerState('fallback')).toBe('idle');
  });
  it('maps no-marker states to null', () => {
    expect(fileFocusStatusToMarkerState('error')).toBeNull();
    expect(fileFocusStatusToMarkerState('no-changes')).toBeNull();
    expect(fileFocusStatusToMarkerState('not-subscribed')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `node_modules/.bin/vitest run src/components/Ai/fileFocusMarkerState.test.ts` (from `frontend/`) → FAIL (module not found).

- [ ] **Step 3: Implement the helper.** `frontend/src/components/Ai/fileFocusMarkerState.ts`:

```ts
import type { FileFocusStatus } from '../../api/types';

/**
 * Reduce a `useFileFocusResult` status to an AiMarker working/idle state for a
 * region-level cue (spec §3). `loading` → working; resolved-with-output
 * (`ok`/`empty`/`fallback`) → the persistent idle "AI analyzed this" glyph;
 * `error`/`no-changes`/`not-subscribed` → no marker (null).
 *
 * Second caller of this exact mapping is the Hotspots tab (via PrDetailView),
 * so per spec §1's YAGNI threshold ("extract when a second caller appears")
 * this is shared rather than inlined twice. This is the focus-ONLY mapping; the
 * file-tree header additionally OR-folds its hunk-annotation pass into `working`
 * at the call site (it spans two AI passes).
 */
export function fileFocusStatusToMarkerState(
  status: FileFocusStatus,
): 'idle' | 'working' | null {
  if (status === 'loading') return 'working';
  if (status === 'ok' || status === 'empty' || status === 'fallback') return 'idle';
  return null; // 'error' | 'no-changes' | 'not-subscribed'
}
```

- [ ] **Step 4: Run it, verify it passes.** → PASS (3 tests).

- [ ] **Step 5: Refactor `FileTree.tsx` (no behavior change).** Replace the inlined block:

```tsx
let headerMarkerState: 'working' | 'idle' | null = null;
if (aiPreview) {
  if (focusStatus === 'loading' || annotationsLoading) {
    headerMarkerState = 'working';
  } else if (focusStatus === 'ok' || focusStatus === 'empty' || focusStatus === 'fallback') {
    headerMarkerState = 'idle';
  }
}
```

with:

```tsx
// Header marker spans BOTH AI passes (file-focus ranking + hunk annotation): stays
// `working` while either loads, else reflects focus status via the shared reduction.
// Behavior identical to the Slice-1 inline form — fileFocusStatusToMarkerState('loading')
// === 'working', so the original `focusStatus === 'loading' || annotationsLoading` OR is
// preserved transitively. The helper is NOT the sole authority here; annotationsLoading
// overrides it. Do not strip the annotationsLoading arm.
const headerMarkerState: 'working' | 'idle' | null = aiPreview
  ? annotationsLoading
    ? 'working'
    : fileFocusStatusToMarkerState(focusStatus)
  : null;
```

Add the import: `import { fileFocusStatusToMarkerState } from '../../Ai/fileFocusMarkerState';` (verify the relative path from `FilesTab/FileTree.tsx`).

- [ ] **Step 6: Run the file-tree tests** — `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx` → all existing Slice-1 cases PASS (proves no behavior change).

- [ ] **Step 7: Commit.** `git add frontend/src/components/Ai/fileFocusMarkerState.ts frontend/src/components/Ai/fileFocusMarkerState.test.ts frontend/src/components/PrDetail/FilesTab/FileTree.tsx && git commit -m "refactor(ai): extract shared fileFocusStatusToMarkerState (#508)"`

---

### Task 2: Hotspots tab-label working marker

**Files:** Modify `PrSubTabStrip.tsx` (+ `.test.tsx`), `PrHeader.tsx`, `PrDetailView.tsx`.

**Interfaces:** Consumes `fileFocusStatusToMarkerState` (Task 1), `fileFocus.status`. Produces `PrSubTabStripProps.aiMarkerState?: 'idle'|'working'|null`; `PrHeaderProps.hotspotsAiState?: 'idle'|'working'|null`.

- [ ] **Step 1: Write the failing test** in `PrSubTabStrip.test.tsx` (add `within` to the `@testing-library/react` import):

```tsx
it('renders a working AiMarker on the Hotspots tab when aiMarkerState is working', () => {
  render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState="working" />);
  expect(within(screen.getByTestId('pr-tab-hotspots')).getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'working');
});
it('renders an idle AiMarker when aiMarkerState is idle', () => {
  render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState="idle" />);
  expect(within(screen.getByTestId('pr-tab-hotspots')).getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'idle');
});
it('renders no AiMarker when aiMarkerState is null', () => {
  render(<PrSubTabStrip activeTab="files" onTabChange={() => {}} showHotspots aiMarkerState={null} />);
  expect(within(screen.getByTestId('pr-tab-hotspots')).queryByTestId('ai-marker')).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Replace `aiMarker` boolean with `aiMarkerState`.** In `PrSubTabStripProps`, add `aiMarkerState?: 'idle' | 'working' | null;` (with a comment that it drives the Hotspots tab-label marker, replacing the former boolean `aiMarker`). Destructure it. On the Hotspots `<Tab>`, replace `aiMarker` with `aiMarkerState={aiMarkerState ?? null}`. In `TabProps`, replace `aiMarker?: boolean;` with `aiMarkerState?: 'idle' | 'working' | null;`. In `Tab`, replace the render line with:

```tsx
      {aiMarkerState && (
        <AiMarker variant="lead" state={aiMarkerState} decorative={aiMarkerState === 'idle'} />
      )}
```

(Working is non-decorative so its sr-only "AI is working…" enters the tab's accessible name — an intentional in-progress announcement; idle stays decorative to keep the resting name clean.)

- [ ] **Step 4: Run it, verify it passes; full `PrSubTabStrip.test.tsx` still green.**

- [ ] **Step 5: Thread through `PrHeader`.** Add `hotspotsAiState?: 'idle' | 'working' | null;` to `PrHeaderProps`; destructure; pass `aiMarkerState={hotspotsAiState ?? null}` to `<PrSubTabStrip>`.

- [ ] **Step 6: Compute it in `PrDetailView.tsx`.** Import `fileFocusStatusToMarkerState` from `../Ai/fileFocusMarkerState`. Near the existing `hotspotsCount`/`showHotspots` derivation:

```tsx
// Hotspots tab-label cue mirrors the file-tree header reduction (spec §3): working
// while focus loads, idle once resolved, hidden on error/no-changes/off. Gate on the
// SAME capability flag that drives showHotspots so the tab marker and the tab presence
// stay in lockstep (avoid divergence between fileFocusEnabled and showHotspots).
const hotspotsAiState = showHotspots
  ? fileFocusStatusToMarkerState(fileFocus.status)
  : null;
```

Pass `hotspotsAiState={hotspotsAiState}` to `<PrHeader>`. (Use the exact boolean that gates `showHotspots`; if that boolean is named `fileFocusEnabled`, use it — the point is one gate, not two.)

- [ ] **Step 7: Grep + typecheck + full suite.** `grep` for `aiMarker` across `frontend/` (including `__tests__/`) to confirm no call site still passes the removed boolean prop; then `node_modules/.bin/tsc -b` (clean) and `node_modules/.bin/vitest run` (full).

- [ ] **Step 8: Commit.** `git add` the four files + test → `git commit -m "feat(ai): working marker on the Hotspots tab label (#508)"`

---

### Task 3: Regenerate the Hotspots loading skeleton to the #520 row shape

**Files:** Modify `HotspotsTab.tsx` (`status === 'loading'` branch, ~45–52), `HotspotsTab.module.css`, `HotspotsTab.test.tsx`.

**Interfaces:** Consumes the existing pulse keyframe + the live row structure (`LevelGlyph` glyph slot + `.headline` + `.path`, ~168–186). Produces a `data-testid="hotspots-skeleton"` block whose rows mimic the #520 layout so the resolve doesn't reflow.

- [ ] **Step 1: Write the failing test** (mirror the file's existing `status:'loading'` mocking helper):

```tsx
it('renders skeleton rows shaped like the live hotspot rows while loading', () => {
  renderHotspots({ status: 'loading' });
  const rows = within(screen.getByTestId('hotspots-skeleton')).getAllByTestId('hotspots-skeleton-row');
  expect(rows.length).toBeGreaterThanOrEqual(3);
  expect(within(rows[0]).getByTestId('hotspots-skeleton-glyph')).toBeInTheDocument();
  expect(within(rows[0]).getByTestId('hotspots-skeleton-headline')).toBeInTheDocument();
  expect(within(rows[0]).getByTestId('hotspots-skeleton-path')).toBeInTheDocument();
});
it('exposes a persistent role=status announcer that is NOT inside the aria-busy skeleton', () => {
  renderHotspots({ status: 'loading' });
  expect(screen.getByRole('status')).toHaveTextContent(/analyzing ai hotspots/i);
  // the announcer must be a sibling of, not a descendant of, the aria-busy skeleton
  expect(within(screen.getByTestId('hotspots-skeleton')).queryByRole('status')).toBeNull();
});
it('announces the resolved outcome via the same persistent status region', () => {
  renderHotspots({ status: 'empty' });
  expect(screen.getByRole('status')).toHaveTextContent(/no files need special attention/i);
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Rebuild the skeleton branch.** Replace the `status === 'loading'` return. The container gets `role="region" aria-label="AI hotspots loading" aria-busy="true"` — spec §6 names the tab-panel container as the host, but `HotspotsTab` early-returns the skeleton as its own subtree, so we scope `aria-busy` to a labelled region on the skeleton itself and record this as a §6 deviation in the PR Proof. **Do NOT nest an `aria-live` region inside this `aria-busy` container** — assistive tech suppresses live-region announcements within a busy subtree, so the announcement would never fire (round-2 design review, conf 100). The loading/outcome announcement is handled by a persistent `role="status"` region added in Step 3b, which sits OUTSIDE the busy subtree:

```tsx
  if (status === 'loading') {
    return (
      <div className={styles.hotspots} data-testid="hotspots-skeleton" role="region" aria-label="AI hotspots loading" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.skeletonRow} data-testid="hotspots-skeleton-row">
            <span className={styles.skeletonGlyph} data-testid="hotspots-skeleton-glyph" />
            <span className={styles.skeletonStack}>
              <span className={styles.skeletonHeadline} data-testid="hotspots-skeleton-headline" />
              <span className={styles.skeletonPath} data-testid="hotspots-skeleton-path" />
            </span>
          </div>
        ))}
      </div>
    );
  }
```

- [ ] **Step 3b: Add a persistent `role="status"` announcer (resolves the silenced-live-region + the loading→resolved-outcome gaps; round-2 design review, conf 75–100).** `HotspotsTab` currently early-returns a different subtree per status, so no live region survives the loading→resolved swap and a screen-reader user gets no outcome announcement. Wrap the existing per-status bodies in a fragment with ONE always-mounted sr-only `role="status"` region as the first child, so a single polite live region announces every transition (it is a sibling ABOVE the `aria-busy` skeleton, never inside it):

```tsx
  // One persistent polite announcer across all status branches (loading → ok/empty/fallback/
  // error/no-changes/not-subscribed). role="status" is an implicit aria-live="polite"; because
  // it is always mounted and lives outside any aria-busy subtree, AT announces each transition.
  const statusAnnouncement =
    status === 'loading' ? 'Analyzing AI hotspots…'
    : status === 'ok' ? `${highMediumCount} ${highMediumCount === 1 ? 'file needs' : 'files need'} attention`
    : status === 'empty' ? 'No files need special attention'
    : status === 'fallback' ? 'AI could not rank this pull request automatically'
    : ''; // 'error' | 'no-changes' | 'not-subscribed' announce nothing (no AI outcome)

  return (
    <>
      <span role="status" className="sr-only">{statusAnnouncement}</span>
      {renderHotspotsBody()}
    </>
  );
```

(Implementer note: this converts `HotspotsTab`'s several `return <…>` early-exits into a single trailing `return` that wraps a body expression. Keep each branch's existing markup verbatim inside `renderHotspotsBody()` — an IIFE or a small switch helper; the skeleton block above becomes its loading arm. `highMediumCount` is the SAME High+Medium count that already feeds the `hotspotsCount` tab badge — reuse it, do not recompute. Verify the exact in-component name before wiring.)

- [ ] **Step 4: Update the CSS.** **Replace the old `.skeletonRow` rule entirely** — it must become a flex container with **no `animation` of its own** (the old full-row `animation: pulse …` is removed; the shimmer now lives on the sub-elements). Sub-elements use `var(--surface-3)` (a real per-theme token with a visible contrast step against the `--surface-2` container — `--skeleton-base` does NOT exist and would fall back to `--surface-2`, invisible in dark). Reuse the file's existing `pulse` keyframe:

```css
.skeletonRow {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.skeletonGlyph {
  width: 16px; height: 16px; border-radius: 3px; flex: 0 0 auto;
  background: var(--surface-3);
  animation: pulse 1.2s ease-in-out infinite;
}
.skeletonStack { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; }
.skeletonHeadline {
  height: 14px; width: 70%; border-radius: 3px;
  background: var(--surface-3);
  animation: pulse 1.2s ease-in-out infinite;
}
.skeletonPath {
  height: 11px; width: 45%; border-radius: 3px;
  background: var(--surface-3);
  animation: pulse 1.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .skeletonGlyph, .skeletonHeadline, .skeletonPath { animation: none; }
}
```

(If the file's pulse keyframe has a different name, use it. Confirm no other rule still applies `animation` to `.skeletonRow`. **Skeleton→content cross-fade** (spec §3 ~200ms) is a conditional-return DOM swap here, with no shared wrapper; matching Slice-1's summary-card pattern, the cross-fade for this surface is **deferred to the B1 gate** — note it in Proof rather than building a wrapper.)

- [ ] **Step 5: Run it, verify it passes; non-loading branch tests still pass.**

- [ ] **Step 6: Commit.** `git commit -m "feat(ai): regenerate Hotspots loading skeleton to the #520 row shape (#508)"`

---

### Task 4: Backend — per-PR `AiEnrichmentSettled` signal

**Files:** Modify `InboxSnapshot.cs`, `InboxRefreshOrchestrator.cs` (main path ~254–258; `OnInboxEnrichmentsReady` ~382–422), `InboxDtos.cs`, `InboxEndpoints.cs` (~67–69); backend tests (find with `grep -rl "new InboxSnapshot(" --include=*.cs` and `grep -rl "OnInboxEnrichmentsReady\|InboxEnrichmentsReady" --include=*.cs`).

**Interfaces:** Produces `InboxSnapshot.AiEnrichmentSettled : IReadOnlySet<string>` (PR-IDs whose enrichment pass has settled — chip arrived OR confidently chip-less); `InboxResponse.AiEnrichmentSettled` serialized as `aiEnrichmentSettled: string[]`.

**Semantics:** a PR-ID is in `AiEnrichmentSettled` once its enrichment resolved, regardless of chip. FE: `settled.has(prId) ? (chip ? ready : empty) : loading`. **Bounded-transient cases (intentional, document in Proof):** (a) a PR edited after its batch dispatched is skipped on the stale-token guard → stays unsettled until the next refresh re-enriches it (bounded by the poll interval); (b) a batch that fails (provider error) is not cached and not published → its PRs stay unsettled until retry; (c) on Live cold start the set is empty → all chip-eligible rows show `loading` until the first batch lands. There is no per-PR inbox *error* signal on the wire (enrichment is best-effort, per spec §5); failures therefore degrade to a continued `loading` cue until retry, not to a distinct error state — adding a per-PR error signal is out of Slice-2 scope.

- [ ] **Step 1: Failing test for the record field.** In a snapshot/orchestrator test file:

```csharp
[Fact]
public void InboxSnapshot_AiEnrichmentSettled_DefaultsToEmptyNonNull()
{
    var snap = new InboxSnapshot(new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
        new Dictionary<string, InboxItemEnrichment>(), DateTimeOffset.UtcNow);
    Assert.NotNull(snap.AiEnrichmentSettled);
    Assert.Empty(snap.AiEnrichmentSettled);
    Assert.NotNull(InboxSnapshot.Empty.AiEnrichmentSettled); // the static Empty must also normalize
    Assert.Empty(InboxSnapshot.Empty.AiEnrichmentSettled);
    var withSet = snap with { AiEnrichmentSettled = new HashSet<string>(StringComparer.Ordinal) { "o/r#1" } };
    Assert.Contains("o/r#1", withSet.AiEnrichmentSettled);
}
```

- [ ] **Step 2: Run it, verify it fails to compile** (no `AiEnrichmentSettled`).

- [ ] **Step 3: Implement the record field — ADD the property; KEEP the existing `static Empty`.** Do not replace the whole record body. Add the positional param (last, defaulted) and the normalizing property; leave `public static InboxSnapshot Empty { get; } = new(...)` untouched (it omits the new arg → defaults to empty, which the test above asserts):

```csharp
public sealed record InboxSnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool CiProbeComplete = true,
    IReadOnlySet<string>? AiEnrichmentSettled = null)
{
    /// PR-IDs whose AI inbox enrichment has settled — a chip arrived OR the model
    /// confidently produced none. Distinct from <see cref="Enrichments"/>: a
    /// settled-but-chip-less PR may be absent from (or null-valued in) Enrichments
    /// but present here, letting the frontend resolve its chip placeholder
    /// loading→empty instead of pulsing forever. Mirrors <see cref="CiProbeComplete"/>.
    /// Normalized to a non-null empty set so older call sites stay safe.
    public IReadOnlySet<string> AiEnrichmentSettled { get; init; } =
        AiEnrichmentSettled ?? new HashSet<string>(StringComparer.Ordinal);

    // ...existing members (including `public static InboxSnapshot Empty { get; } = ...`) unchanged.
}
```

(`with { AiEnrichmentSettled = … }` sets the property directly and must pass a real set.)

- [ ] **Step 4: Run the snapshot test, verify it passes.**

- [ ] **Step 5: Populate the main path (failing test first).** Orchestrator test: enricher returns N cached results (mix of chip/chip-less) → committed snapshot's `AiEnrichmentSettled` == those N PR-IDs. Two edits, ~4 lines apart: (i) derive `aiSettled` right after `var enrichmentMap = enrichments.ToDictionary(e => e.PrId);` (~254); (ii) pass it into the `new InboxSnapshot(...)` constructor (~258). The two code blocks below are that derivation and that constructor call — confirm both line anchors against the current file before inserting:

```csharp
            // Every PR the enricher resolved synchronously (cache hits) is settled —
            // chip or not. Misses are still in flight; they arrive later via
            // OnInboxEnrichmentsReady, which extends this set. (The cache is the durable
            // store, so a later refresh re-derives the same settled set from enrichmentMap.)
            var aiSettled = enrichmentMap.Keys.ToHashSet(StringComparer.Ordinal);
```

```csharp
            var newSnap = new InboxSnapshot(
                sectionsFinal, enrichmentMap, DateTimeOffset.UtcNow, ciProbeComplete, aiSettled);
```

- [ ] **Step 6: Run it, verify it passes.**

- [ ] **Step 7: Extend the set in `OnInboxEnrichmentsReady` + fix the all-null-chip early-return (failing test first).** Test: an `InboxEnrichmentsReady` batch whose results are ALL chip-less but live + token-matched must still commit a snapshot whose `AiEnrichmentSettled` gains those PR-IDs AND publish `InboxUpdated` (today `if (applied == 0) return;` skips this). Implement — rewrite the merge body (~397–416), preserving the existing live/stale guards exactly:

```csharp
            var merged = new Dictionary<string, InboxItemEnrichment>(current.Enrichments, StringComparer.Ordinal);
            var settled = new HashSet<string>(current.AiEnrichmentSettled, StringComparer.Ordinal);
            var changedSections = new HashSet<string>(StringComparer.Ordinal);
            var applied = 0;
            var newlySettled = 0;
            foreach (var r in evt.Results)
            {
                if (!liveByPrId.TryGetValue(r.PrId, out var live)) continue;      // PR gone since batch started
                if (InboxEnrichmentContent.Token(live.Title, live.Description) != r.ContentToken) continue; // stale edit-during-batch (#410 guard)
                if (settled.Add(r.PrId)) newlySettled++;                          // resolved against the live PR → settled, chip or not
                if (r.CategoryChip is not null)                                   // Enrichments stays chip-only on this path
                {
                    merged[r.PrId] = new InboxItemEnrichment(r.PrId, r.CategoryChip, HoverSummary: null);
                    applied++;
                }
                foreach (var kv in current.Sections)
                    if (kv.Value.Any(p => p.Reference.PrId == r.PrId)) changedSections.Add(kv.Key);
            }
            // Commit if a chip landed OR a PR newly settled — an all-"Other" batch must
            // still clear the FE's working markers. A no-op batch (all stale/gone) → both 0 → return.
            if (applied == 0 && newlySettled == 0) return;

            Volatile.Write(ref _current, current with { Enrichments = merged, AiEnrichmentSettled = settled });
            _events.Publish(new InboxUpdated(changedSections.ToArray(), applied)); // unconditional (ComputeDiff is enrichment-blind)
```

- [ ] **Step 8: Run the orchestrator tests, verify they pass** (new all-null-chip-settles test + existing merge tests).

- [ ] **Step 9: Wire onto the DTO.** In `InboxDtos.cs` add `IReadOnlyCollection<string> AiEnrichmentSettled` to `InboxResponse`. In `InboxEndpoints.cs` (~67–69):

```csharp
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter, snap.CiProbeComplete,
                snap.AiEnrichmentSettled.ToArray()));
```

`InboxViewedState.ApplyViewedState` is a `with`-copy (`InboxViewedState.cs:65` → `return snapshot with { Sections = rebuilt };`), so `AiEnrichmentSettled` survives the viewed-state re-projection — **confirmed, no change needed there.**

- [ ] **Step 10: Verify the wire JSON key.** Assert the property serializes to `aiEnrichmentSettled` under `JsonSerializerOptionsFactory.Api` (the same camelCase policy that already renders `CiProbeComplete`→`ciProbeComplete`, which the FE reads). Confirm the factory uses camelCase (not kebab) before relying on the precedent.

- [ ] **Step 11: Fix all `new InboxResponse(` / `new InboxSnapshot(` call sites + fixtures.** Grep both (include `InboxSnapshot.Empty` in the audit). The snapshot default keeps most snapshot constructions compiling; every `InboxResponse` construction (tests/fixtures) needs the new arg.

- [ ] **Step 12: Full backend test run** — `dotnet test` (timeout ≥ 300000ms) → green.

- [ ] **Step 13: Commit.** `git commit -m "feat(inbox): per-PR AI enrichment-settled signal on the snapshot (#508)"`

---

### Task 5: Backend — invalidate inbox enrichments on AI-mode change (#548)

**Why:** The Preview placeholder category "Refactor" (`PlaceholderInboxItemEnricher` returns it for every row) leaks into Live/Off because **nothing invalidates `_current.Enrichments` on an AI-mode change**, and `ComputeDiff` is **blind to enrichment changes** (it diffs Sections only, ~319–365), so even a later refresh that drops the placeholder never notifies the FE. Fix: subscribe the orchestrator to `IConfigStore.Changed`; on an `Ui.Ai.Mode` delta, clear the stale enrichments + settled set and **force-publish** `InboxUpdated`. This mirrors the existing `PrDetailLoader.OnConfigChanged → InvalidateAll` pattern (`PrDetailLoader.cs:396`). Combined with Task 4/6, the post-invalidation state shows an honest `loading` cue (or no chip in Off), never a stale placeholder.

**Files:** Modify `InboxRefreshOrchestrator.cs` (constructor subscription + dispose; a new `OnConfigChanged` handler); orchestrator tests.

**Interfaces:** Consumes `IConfigStore.Changed` (`ConfigChangedEventArgs` carrying the new `Config`); the orchestrator already holds `_config` (an `IConfigStore`) and `_events`.

- [ ] **Step 1: Failing test.** Orchestrator test: seed `_current` with an enrichment map + settled set (simulating Preview "Refactor"); raise `IConfigStore.Changed` with a config whose `Ui.Ai.Mode` differs from the prior mode; assert (a) `_current.Enrichments` is now empty, (b) `_current.AiEnrichmentSettled` is now empty, (c) an `InboxUpdated` was published. Also assert a `Changed` event with the SAME mode does NOT clear (no spurious churn — gate on an actual mode delta). **Do not assert synchronous re-population** — the handler kicks `RefreshAsync` fire-and-forget, so the cleared state is the observable post-handler state; re-population lands on the async refresh. (Optional hardening: a test that raises `Changed` from a thread while a stub `RefreshAsync` is parked on `_writerLock`, asserting the handler still returns promptly — proves the lock-free claim. Keep it only if it isn't flaky.)

```csharp
[Fact]
public void OnConfigChanged_AiModeChange_ClearsEnrichmentsAndNotifies() { /* arrange seeded _current, act raise Changed with new mode, assert cleared + published */ }

[Fact]
public void OnConfigChanged_SameAiMode_DoesNotClear() { /* raise Changed with unchanged mode → enrichments intact, no publish */ }
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement — LOCK-FREE (do NOT take `_writerLock`).** `IConfigStore.RaiseChanged` fires **synchronously on the caller thread** — the `PUT /api/preferences` request thread, and the config-file watcher thread. A blocking `_writerLock.Wait()` here would freeze the settings-save behind any in-flight `RefreshAsync` (which holds the lock across section queries + enrichment + CI probe — seconds, longer under CI back-off). The plan's original cited precedent, `PrDetailLoader.OnConfigChanged → InvalidateAll`, is itself **lock-free** (`Interlocked` + `ConcurrentDictionary.Clear`, `PrDetailLoader.cs`), so the precedent mandates the lock-free shape, not a lock-taking one (round-2 adversarial review, conf 75; confirmed against `ConfigStore.RaiseChanged` + `PreferencesEndpoints`).

In the constructor, capture the initial mode (stored as `int` for `Interlocked`) and subscribe:

```csharp
        _lastAiMode = (int)_config.Current.Ui.Ai.Mode;
        _config.Changed += OnConfigChanged;
```

Add the handler — lock-free CAS clear + a coalesced refresh poke, no `_writerLock`:

```csharp
    // #548 — a stale Preview placeholder ("Refactor") must not linger after the AI mode changes.
    // RaiseChanged is SYNCHRONOUS on the caller thread (preferences PUT thread + config-watcher
    // thread), so this MUST be lock-free — mirror the real PrDetailLoader.InvalidateAll precedent.
    private void OnConfigChanged(object? sender, ConfigChangedEventArgs e)
    {
        if (_disposed) return;
        var newMode = e.Config.Ui.Ai.Mode;
        // Atomically advance the last-seen mode; Interlocked.Exchange makes the delta-gate safe
        // against two concurrent Changed producers (API thread + file-watcher thread) — neither
        // can pass on a torn/stale read of _lastAiMode.
        var prev = (AiMode)Interlocked.Exchange(ref _lastAiMode, (int)newMode);
        if (prev == newMode) return; // only on an actual AI-mode delta

        // CAS-clear the AI-derived fields. If a concurrent RefreshAsync already replaced _current,
        // it loses the CAS — and that is CORRECT: that refresh's snapshot is authoritative for the
        // new mode. The refresh poke below converges either outcome.
        var current = Volatile.Read(ref _current);
        if (current is not null &&
            (current.Enrichments.Count > 0 || current.AiEnrichmentSettled.Count > 0))
        {
            var cleared = current with
            {
                Enrichments = new Dictionary<string, InboxItemEnrichment>(StringComparer.Ordinal),
                AiEnrichmentSettled = new HashSet<string>(StringComparer.Ordinal),
            };
            if (ReferenceEquals(Interlocked.CompareExchange(ref _current, cleared, current), current))
                // All section keys: ComputeDiff is enrichment-blind, so publish unconditionally to
                // force the FE refetch. applied = 0 (no chips landed — we cleared them).
                _events.Publish(new InboxUpdated(current.Sections.Keys.ToArray(), 0));
        }

        // Re-populate via the RESOLVED enricher rather than leaving every chip-eligible row pulsing
        // for a full Polling.InboxSeconds (round-2 adversarial review, conf 75 — the N-row pulse-storm
        // is the DEFAULT Preview→Live path, not an edge case). Fire-and-forget RefreshAsync is
        // _writerLock-serialized, so a concurrent poll coalesces naturally; it runs OFF the caller
        // thread, so the preferences PUT is never blocked. (If a poller handle is reachable from the
        // orchestrator, prefer InboxPoller.RequestImmediateRefresh() — verify the wiring in-step;
        // today the dependency runs poller→orchestrator, so RefreshAsync is the reachable path.)
        _ = RefreshAsync(CancellationToken.None);
    }
```

Add a `private int _lastAiMode;` field (int, not `AiMode`, so `Interlocked` can touch it; add `using PRism.Core.Ai;` for the `AiMode` cast and `using System.Threading;` if not already present). In `Dispose()`, add `_config.Changed -= OnConfigChanged;` (unsubscribe before flagging `_disposed`, alongside the existing `_enrichmentSub.Dispose()`).

- [ ] **Step 4: Run it, verify it passes; full orchestrator suite green.**

- [ ] **Step 5: Commit.** `git commit -m "fix(inbox): clear stale AI enrichments on AI-mode change (#548)"`

---

### Task 6: Frontend — inbox chip working marker

**Files:** Modify `types.ts`, `InboxPage.tsx`, `InboxSection.tsx`, **`RepoGroupAccordion.tsx`** (the default grouped path — a second `InboxRow` parent), `InboxRow.tsx` (+ `.module.css`, + `.test.tsx`), `aiStrings.ts`.

**Interfaces:** Consumes `InboxResponse.aiEnrichmentSettled` (Task 4); the existing `showCategoryChip` gate; `enrichment?.categoryChip`. Produces per-row chip state `'off' | 'loading' | 'ready' | 'empty'`. **Row key:** `InboxRow` has no `id` prop — derive it with `prId(pr)` from `./groupByRepo` (the exact key the parents already use for `enrichments[id]`; form `owner/repo#number`, identical to the backend `PrReference.PrId`). The backend settled set uses the same key form.

- [ ] **Step 1: Add the TS field (non-optional) + sr-only label.** In `types.ts` `InboxResponse`, add `aiEnrichmentSettled: string[];` — **keep it non-optional** so `tsc -b` flags every FE mock missing the field (the mock-coverage gate is worth more than silencing the runtime `?? []` belt-and-suspenders). In `aiStrings.ts`: `export const AI_INBOX_ENRICHING_LABEL = 'Categorizing this pull request…';`

- [ ] **Step 2: Write the failing tests** in `InboxRow.test.tsx` (mirror the existing render harness; pass `showCategoryChip`, `enrichment`, and the new `settled` set; `ID = prId(pr)` for the fixture):

```tsx
it('shows a working marker in the chip slot while enrichment is unsettled', () => {
  renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set<string>() });
  expect(screen.getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'working');
});
it('renders the chip (idle marker) once settled with a chip', () => {
  renderRow({ showCategoryChip: true, enrichment: { prId: ID, categoryChip: 'Refactor', hoverSummary: null }, settled: new Set([ID]) });
  expect(screen.getByText('Refactor')).toBeInTheDocument();
  expect(screen.getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'idle');
});
it('renders nothing in the chip slot once settled with no chip', () => {
  renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set([ID]) });
  expect(screen.queryByTestId('ai-marker')).toBeNull();
});
it('renders nothing when the chip feature is off, even while unsettled', () => {
  renderRow({ showCategoryChip: false, enrichment: undefined, settled: new Set<string>() });
  expect(screen.queryByTestId('ai-marker')).toBeNull();
});
it('announces the in-flight state on the row aria-label while loading', () => {
  renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set<string>() });
  expect(screen.getByRole('button')).toHaveAccessibleName(/categoriz/i);
});
it('announces the in-flight state on a merged/closed (done) PR too — both aria-label branches', () => {
  // The isDone aria-label branch is separate from the open-PR branch; the loading suffix must
  // reach both (round-2 design review). Set whatever fixture field renderRow uses for done state
  // (e.g. pr.state='MERGED' / pr.mergedAt) so the isDone branch is taken.
  renderRow({ done: true, showCategoryChip: true, enrichment: undefined, settled: new Set<string>() });
  expect(screen.getByRole('button')).toHaveAccessibleName(/categoriz/i);
});
```

- [ ] **Step 3: Run it, verify it fails.**

- [ ] **Step 4: Implement in `InboxRow.tsx`.** Add a `settled: ReadonlySet<string>` prop; import `prId` from `./groupByRepo`; derive `const id = prId(pr);`. If `pr.isDraft` short-circuits to a draft chip in the existing code, gate the category chipState **after** that branch (a draft row must not show a category working marker — confirm the draft-chip branch wins). Then:

```tsx
  const chipState: 'off' | 'loading' | 'ready' | 'empty' = !showCategoryChip
    ? 'off'
    : !settled.has(id)
      ? 'loading'
      : enrichment?.categoryChip
        ? 'ready'
        : 'empty';
```

`aria-label` on the row's `<button>` overrides descendant sr-only text, so the AiMarker's own sr-only label is **silenced** — append a loading suffix to `ariaLabel` (like the existing `aiSuffix`/`ciSuffix`) and make the loading marker **decorative**. **`InboxRow` composes `ariaLabel` in TWO branches — the `isDone` (merged/closed) branch and the open-PR branch, both already appending `aiSuffix` (`InboxRow.tsx:94–98`). Append `aiLoadingSuffix` to BOTH branches** (immediately after the existing `aiSuffix`), or a merged/closed PR still being enriched pulses with no SR announcement (round-2 design review, conf 75):

```tsx
  const aiLoadingSuffix = chipState === 'loading' ? ` · ${AI_INBOX_ENRICHING_LABEL}` : '';
  // …append aiLoadingSuffix to the composed ariaLabel in BOTH the isDone and open branches…
```

Replace the chip render (~136–149):

```tsx
  {chipState === 'loading' && (
    <span className={styles.chipWrap}>
      <span className={`${styles.chip} ${styles.chipLoading}`} data-testid="inbox-chip-loading">
        <AiMarker variant="inline" state="working" decorative className={styles.chipMarker} />
      </span>
      <span className={styles.dotsep}>·</span>
    </span>
  )}
  {chipState === 'ready' && enrichment?.categoryChip && (
    <span className={styles.chipWrap}>
      <span className={styles.chip}>
        <AiMarker variant="inline" decorative className={styles.chipMarker} />
        {enrichment.categoryChip}
      </span>
      <span className={styles.dotsep}>·</span>
    </span>
  )}
```

(`'empty' | 'off'` render nothing. No `aria-busy` on the row — a table row is not a valid host (spec §6); the `ariaLabel` suffix carries the announcement.)

- [ ] **Step 5: Size the loading chip to avoid reflow.** In `InboxRow.module.css`, `.chipLoading { min-width: 56px; justify-content: center; }` — a representative width approximating a real category label so the meta line doesn't shift left when text arrives. **Flag for B1 tuning against real labels** (e.g. "Bug fix") in the Proof, same as other `min-width` placeholders in this file.

- [ ] **Step 6: Thread the settled set from the page through BOTH render paths.** In `InboxPage.tsx`:

```tsx
  // Belt-and-suspenders: type is non-optional, but guard a stale-backend deploy that
  // predates aiEnrichmentSettled (older snapshot served while FE is fresh).
  const settled = useMemo(() => new Set(data?.aiEnrichmentSettled ?? []), [data?.aiEnrichmentSettled]);
```

Pass `settled={settled}` to `<InboxSection>`. In `InboxSection.tsx`, add a `settled: ReadonlySet<string>` prop and forward it to **both** the flat `<InboxRow>` branch **and** the `<RepoGroupAccordion>` branch. In `RepoGroupAccordion.tsx`, add a `settled: ReadonlySet<string>` prop and forward `settled={settled}` to each `<InboxRow>` (mirroring how it already forwards `enrichments`).

- [ ] **Step 7: Run it, verify it passes; typecheck + full suite.** `node_modules/.bin/vitest run src/components/Inbox/InboxRow.test.tsx` → PASS; then `node_modules/.bin/tsc -b` (fix every FE `InboxResponse` mock missing the field) and full `node_modules/.bin/vitest run`.

- [ ] **Step 8: Commit.** `git commit -m "feat(inbox): working marker on the kind-of-change chip while enriching (#508, #548)"`

---

### Task 7: Frontend — region-level draft-suggestion cue

**Files:** Modify `UnresolvedPanel.tsx` (header ~169–176 only — NO `aria-busy` on the section, see Step 3), `UnresolvedPanel.module.css`, `aiStrings.ts`, `UnresolvedPanel.test.tsx`.

**Interfaces:** Consumes `useAiDraftSuggestions(prRef, draftSuggestionsEnabled).state` (lifted in Slice 1) + `draftSuggestionsEnabled`. Produces one region-level working marker; no per-draft markers.

- [ ] **Step 1: Write the failing test** (reuse the file's existing `useAiGate`/`useAiDraftSuggestions` mocks; include `useIsSampleMode: () => false` to avoid SampleBadge non-determinism):

```tsx
it('shows a region-level working marker while draft suggestions load', () => {
  mockAiGate({ draftSuggestions: true });
  mockUseAiDraftSuggestions({ state: 'loading', suggestions: null });
  renderPanel({ session: sessionWithOneStaleDraft });
  const header = screen.getByTestId('unresolved-panel').querySelector('header')!;
  expect(within(header).getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'working');
  // NO aria-busy on the <section>: it would silence the section's existing summary aria-live
  // (round-2 design review, conf 100). The cue is the marker + the one sr-only label below.
  expect(screen.getByTestId('unresolved-panel')).not.toHaveAttribute('aria-busy');
  // exactly one sr-only announcement (no double-announce)
  expect(within(header).getAllByText(/reviewing your stale drafts/i)).toHaveLength(1);
});
it('shows no region marker once suggestions settle', () => {
  mockAiGate({ draftSuggestions: true });
  mockUseAiDraftSuggestions({ state: 'ready', suggestions: [] });
  renderPanel({ session: sessionWithOneStaleDraft });
  expect(within(screen.getByTestId('unresolved-panel')).queryByTestId('ai-marker')).toBeNull();
});
it('shows no region marker when draft suggestions are gated off', () => {
  mockAiGate({ draftSuggestions: false });
  mockUseAiDraftSuggestions({ state: 'empty', suggestions: null });
  renderPanel({ session: sessionWithOneStaleDraft });
  expect(within(screen.getByTestId('unresolved-panel')).queryByTestId('ai-marker')).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.** Derive `const draftsWorking = draftSuggestionsEnabled && aiSuggestions.state === 'loading';`. **Do NOT add `aria-busy` to the `<section>`** — it already contains the summary `<span aria-live="polite">{summary}</span>` (`UnresolvedPanel.tsx:171`), and `aria-busy` on an ancestor suppresses descendant live-region announcements, regressing the existing "N drafts need attention" cue (round-2 design review, conf 100). The region cue is carried entirely by the marker + a single sr-only label. In the `<header>`, render the cue as a **sibling of the `aria-live` summary span** (NOT inside it — keep the live region scoped to `{summary}` so the marker unmount doesn't re-announce the summary). Use a **decorative** marker plus a single explicit sr-only span (decorative avoids the AiMarker's built-in label double-announcing with the explicit one):

```tsx
        {draftsWorking && (
          <span className={styles.draftAiCue} data-testid="unresolved-panel-ai-cue">
            <AiMarker variant="inline" state="working" decorative />
            <span className="sr-only">{AI_DRAFT_REVIEWING_LABEL}</span>
          </span>
        )}
```

Import `AiMarker` and `AI_DRAFT_REVIEWING_LABEL`.

- [ ] **Step 4: Add the string + CSS.** In `aiStrings.ts`: `export const AI_DRAFT_REVIEWING_LABEL = 'AI is reviewing your stale drafts…';`. In `UnresolvedPanel.module.css`, lay the header as a flex row (merge, don't overwrite, if `.unresolvedPanelSummary` already has rules): `.unresolvedPanelSummary { display: flex; align-items: center; gap: var(--space-2); }` and `.draftAiCue { display: inline-flex; align-items: center; }`.

- [ ] **Step 5: Run it, verify it passes; full suite + typecheck.**

- [ ] **Step 6: Commit.** `git commit -m "feat(ai): region-level working cue on the stale-draft panel (#508)"`

---

### Task 8: Docs, visual verification, and final gate

- [ ] **Step 1: Documentation maintenance.** Per `.ai/docs/documentation-maintenance.md`, update the spec (`docs/specs/2026-06-19-ai-thinking-indicator-design.md`) status line: Slice 2 implemented; record the fork resolutions (settled = snapshot-level per-PR set; draft cue = region-level) and the #548 fold-in. Also **confirm the spec §3 annotator divergence cases (a/b/c) shipped in PR #543** — if any remain open, file a follow-on and reference it in the spec note. Include doc edits in this PR.

- [ ] **Step 2: Visual baseline + fixture check (run the exact greps; do not eyeball).**
  - (a) **Confirm the named files exist first** (don't assume): list `frontend/e2e/` and check for inbox/enrichment/unresolved specs — `ls frontend/e2e | grep -iE 'inbox|enrich|unresolved|hotspot'`. Adjust the names below to what actually exists.
  - (b) **Baseline scan:** `grep -rniE 'showCategoryChip|aiPreview|hotspots|unresolved' frontend/e2e` to find any spec rendering the inbox with chips on, a loading Hotspots tab, or the drafts panel with AI on. Per the Slice-1 finding, AI e2e specs are DOM-only and parity baselines render `aiPreview=false`; confirm that still holds.
  - (c) **Settled-field fixture audit (behavioral, not tsc):** the FE `?? []` only fires when `data` itself is undefined — a *typed* mock omitting the field is caught by `tsc -b`, but an `as any` / untyped fixture or a backend test hook is NOT. Grep every inbox-response synthesizer and confirm it emits `aiEnrichmentSettled`: FE side `grep -rniE 'aiEnrichmentSettled|InboxResponse' frontend/e2e frontend/src/**/__mocks__ frontend/__tests__`; backend side `grep -rnE 'new InboxResponse\(|new InboxSnapshot\(|FakePrEnricher|FakeInboxEnricher' --include=*.cs`. A synthesizer that omits the field produces permanently-pulsing chips with green tests.
  - (d) If a baseline captures a new marker/skeleton, regenerate via the Linux-CI-artifact flow and verify the diff; if none do, record the no-baseline-change decision in Proof.

- [ ] **Step 3: B1 live visual gate (gated issue — owner sign-off).** Serve detached against the real token store (`run.ps1` serve-detached, `-SkipBuild` after build); verify in both themes + `prefers-reduced-motion`:
  - Hotspots tab label working→idle on settle; skeleton matches live #520 rows (and is visible in **dark** theme — the `--surface-3` fix).
  - Inbox chip: working while enriching → chip on settle → **nothing** on settled-no-chip (confirm a chip-less PR stops pulsing). **Live cold-start row-storm:** open the inbox in Live with an empty enricher cache and confirm the simultaneous multi-row pulse is acceptable; if it reads as noise, decide on first-load suppression and record it in Proof.
  - **#548:** toggle Preview→Live→Off and confirm "Refactor" never lingers — Off shows no chip; Live shows loading then the real category, never the placeholder.
  - Draft panel: one region cue while loading, gone on settle; no per-draft flashing.
  Capture screenshots for Proof.

- [ ] **Step 4: Pre-push checklist + PR.** Run the repo's full pre-push checklist verbatim (`.ai/docs/development-process.md`): full FE suite (local vitest), `tsc -b`, `npm run lint`, full `dotnet test`, e2e as applicable. Run `superpowers:simplify` before raising the PR. Open with `--base V2`, referencing **#508 (Slice 2) and Closes #548**, and a `## Proof` section recording every B1 finding + disposition, the baseline decision, and the §6 aria-busy deviation (Hotspots skeleton region; draft panel section).

---

## Verified-safe (adversarial refutations — do not re-litigate)

These failure scenarios were traced against the code and **refuted**; recorded so a later reviewer doesn't re-raise them:
- **Settled set unbounded growth / stale re-entry:** the main path rebuilds `AiEnrichmentSettled` from `enrichmentMap.Keys` each refresh (cache-backed), so a departed PR drops out; a PR that re-enters with unchanged title/description hits the content-keyed cache and re-settles in the same commit. No stale-settled pulse. (Minor: the set isn't pruned mid-cycle for a removed PR, but the FE ignores settled IDs for absent rows — harmless.)
- **Union-vs-overwrite race:** both `RefreshAsync` and `OnInboxEnrichmentsReady` serialize on `_writerLock` and re-read `_current` inside the lock before the read-modify-write. No interleaving loses settled IDs. The new `OnConfigChanged` (Task 5) is deliberately **lock-free** (it MUST NOT take `_writerLock` — `RaiseChanged` is synchronous on the preferences-PUT / config-watcher thread; a blocking wait would freeze the settings save behind an in-flight refresh). It CAS-clears `_current`; losing the CAS to a concurrent authoritative refresh is correct. `_lastAiMode` is advanced via `Interlocked.Exchange`, so two concurrent `Changed` producers (API thread + config-file-watcher thread) can't both pass a stale delta-gate.
- **Spurious `InboxUpdated` storm / missed publish from the early-return change:** the new `applied == 0 && newlySettled == 0` guard is strictly weaker than the old `applied == 0` only when a PR genuinely newly-settled — exactly the case that must publish.
- **AI-off perpetual pulse:** `useAiGate('inboxEnrichment')` is false when `aiMode === 'off'`, so `chipState` is `'off'` (no marker). Covered by a Task-6 test.

## Self-Review (writing-plans)

- **Spec coverage:** Hotspots marker+skeleton (§3, §4) → Tasks 2,3. Inbox chip + backend settled signal (§3, §5) → Tasks 4,6. #548 mode-change leak → Task 5. Draft overlay (§3, §7, region-level resolving the "provisional placement" flag) → Task 7. `aria-busy` hosts (§6): Hotspots skeleton keeps `aria-busy` but its announcement moved to a persistent `role="status"` region OUTSIDE the busy subtree (Task 3 Step 3b — `aria-live` nested inside `aria-busy` is silenced); inbox row omitted by design (Task 6); draft panel `<section>` does **not** take `aria-busy` (Task 7 — it would silence the existing summary `aria-live`; the cue is the marker + one sr-only label). Working→ready transition: inherited from Slice-1 tokens; Hotspots skeleton cross-fade deferred to B1.
- **Type consistency:** `fileFocusStatusToMarkerState` identical across Tasks 1,2. `'idle'|'working'|null` consistent for `aiMarkerState`/`hotspotsAiState`. `AiEnrichmentSettled`: `IReadOnlySet<string>` (snapshot) → `IReadOnlyCollection<string>` (DTO) → `string[]` (wire) → `Set<string>`/`ReadonlySet<string>` (FE), converted explicitly at each boundary. Row key `prId(pr)` (`owner/repo#number`) matches the backend `PrReference.PrId`.
- **Placeholder scan:** none — every code step shows the code; every command shows the expected outcome.
- **Open verifications (called out in-step, not gaps):** exact `PrHeader`/`PrDetailView` line numbers; the file's pulse keyframe name; the API JSON casing policy; the `pr.isDraft` chip-priority interaction; `ConfigChangedEventArgs`'s exact shape; the in-component `highMediumCount` name reused by Task 3 Step 3b; whether the FE SSE handler refetches the **named** sections on `InboxUpdated` (an all-null-chip settled batch lists those PRs' sections in `changedSections` — the section-scan in `OnInboxEnrichmentsReady` runs for every settled PR, not only chip-bearing ones — so the markers clear; confirm the FE doesn't ignore a `changedSectionIds`-non-empty / `count==0` event); whether an `InboxPoller` handle is reachable from the orchestrator (if so, prefer `RequestImmediateRefresh()` over fire-and-forget `RefreshAsync` in Task 5).

## Round-2 ce-doc-review dispositions (2026-06-19)

Second pass at the user's explicit request, on the round-1-revised plan. Reviewers: coherence, feasibility (0 findings — all load-bearing code claims verified against the worktree), design-lens, scope-guardian, adversarial.

**Applied (P1):**
- **Task 3** — `aria-live` nested inside the `aria-busy` skeleton is silenced by AT (design, conf 100). Removed the nested live span; added a persistent `role="status"` announcer outside the busy subtree (Step 3b), which also closes the loading→resolved no-announcement gap (design, conf 75).
- **Task 7** — `aria-busy` on the panel `<section>` would silence the existing summary `aria-live` (design, conf 100). Dropped it; cue is marker + one sr-only label.
- **Task 5** — `OnConfigChanged` took `_writerLock` on the synchronous preferences-PUT thread → settings-save hangs behind an in-flight refresh; the cited `PrDetailLoader` precedent is itself lock-free (adversarial, conf 75; cross-confirmed by scope-guardian on `_lastAiMode`). Reworked to a lock-free CAS clear + `Interlocked.Exchange` delta-gate. **Owner chose the lock-free mechanism.**

**Applied (P2/P3):**
- **Task 5** — added a fire-and-forget `RefreshAsync` poke so a Preview→Live switch doesn't strand every chip pulsing for a poll interval (adversarial, conf 75).
- **Task 6** — `aiLoadingSuffix` now appended to BOTH `aria-label` branches (a done PR was missing it) + a done-PR loading test (design, conf 75).
- **Task 8** — exact grep patterns + file-existence checks for the baseline/fixture audit (coherence, conf 75).
- **Task 4** — clarified the ~254 vs ~258 two-edit split (coherence, conf 75).

**FYI / not separately edited:** `?? []` vs non-optional field tension (scope — typed mocks are still `tsc`-gated, so low risk); positional record-param reorder (scope — param appended last + defaulted, safe); `PrHeader` prop threading (scope, conf 50 — already wired at Step 6); `.chipLoading` min-width vs `.chip` padding (design — already B1-deferred); `getByRole('button')` scoping (design, conf 50).

**Refuted (dropped):**
- "prId key format unverified vs backend" (coherence) — feasibility read the code: `prId(pr)` == `PrReference.PrId` form `owner/repo#number`. Cross-reviewer contradiction resolved in feasibility's favor.
- "`changedSections` empty on all-null-chip settle strands markers" (scope residual) — misread indentation; the section-scan loop runs for every settled PR, not only chip-bearing ones. Kept a one-line defensive FE-refetch verify in Open verifications.
