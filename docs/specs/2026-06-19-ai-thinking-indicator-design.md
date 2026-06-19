# AI "thinking" indicator — holistic in-progress signalling across AI surfaces

- **Date:** 2026-06-19
- **Branch:** V2 (part of the V2 AI roadmap, epic #423)
- **Status:** Design — awaiting human review
- **Supersedes:** generalizes and replaces the scope of #508 (file-tree dots + annotator in-progress). Adjacent: #509 (styled dot tooltip), #489 (universal AI marker), #484 (AI failure surfacing).

## Problem

When AI is enabled, every AI feature fetches in the background after the page renders. Most surfaces show **nothing** while that fetch is in flight — results simply pop in later with no prior cue. A user sees a fully-rendered page and cannot tell whether AI is working, finished-with-nothing, off, or broken. The few surfaces that *do* signal loading (AI summary, Hotspots tab) each do it bespoke, so there is no shared "AI is thinking" idiom.

The gap is **two-axis**:

1. **State-contract drift.** Three hooks (`useAiHunkAnnotations`, `useAiDraftSuggestions`, and the inbox enrichment chip) return a bare `T | null`. `null` collapses four distinct states — *off*, *in-flight*, *empty*, *error* — into one value, so a consumer literally cannot render an in-progress cue or distinguish "still working" from "done, nothing to show." `useFileFocusResult` already carries a rich status enum; `useAiSummary` already carries `{ loading, error, … }`. The contract is inconsistent.
2. **Visual-idiom drift.** Even surfaces that have loading state render it ad-hoc (summary skeleton vs Hotspots skeleton vs nothing). There is no shared in-progress component, and the existing AI *content* marker (`AiMarker` / ✨, #489) has no "working" state.

## Goals

- A single, consistent "AI is thinking" visual idiom, reused across **all** AI background surfaces, with per-surface size/placement variants.
- Lift the three bare-`null` hooks to a shared four-state contract so every surface can distinguish loading / ready / empty / error.
- The in-progress cue is part of the **same visual family** as the #489 AI content marker (sparkle), differentiated by a concrete, non-motion-dependent treatment (see §2) — never identical to "AI content is present."
- Resolve cleanly in both light and dark themes and under `prefers-reduced-motion`.

## Non-goals

- **No global "any AI in flight" indicator** (nav/header). AI fetches fire on nearly every PR open, so a global signal would be on almost constantly and train users to ignore it (banner blindness). The local cues escape this because they are **transient** — each resolves within seconds of page load — whereas a global cue is near-constant. Per-surface, local cues only. (Revisit only if a concrete need appears.)
- **No change to AI behaviour or output**: which files get dots, the high/medium thresholds, which hunks get annotated, summarizer content, ranker selectivity — all unchanged. This is *not* a frontend-only change, though: lifting the hooks changes their FE consumer contract (§1), and the inbox terminal state requires a small backend signal (§5).
- **No new AI features.** This wires indicators onto existing surfaces.
- Error *handling* beyond surfacing a cue is out of scope; we reuse the existing #484 error vocabulary where it exists.

## Current state (V2)

| Surface | Hook | State model today | In-progress today |
|---|---|---|---|
| AI Summary card | `useAiSummary` | rich: `{ summary, loading, error, isStale, … }` | none (card early-returns `null`) |
| Hotspots tab | `useFileFocusResult` | status enum (`loading \| ok \| empty \| error \| fallback \| no-changes \| not-subscribed`) + `retry` | skeleton (3 generic rows) on `loading` |
| File-tree focus dots | `useFileFocusResult` | same enum, but dot column ignores it | none (empty column) |
| Hunk annotator | `useAiHunkAnnotations` | **bare** `HunkAnnotation[] \| null` | none |
| Draft suggestions | `useAiDraftSuggestions` | **bare** `DraftSuggestion[] \| null` | none |
| Inbox kind-of-change chip | `useInbox` enrichment (full-snapshot reload on contentless `inbox-updated` SSE) | chip `string \| null`; **null-chip results are dropped server-side** (`InboxRefreshOrchestrator` skips `CategoryChip is null`) | none inline |

Shared primitives available: `AiMarker` (`frontend/src/components/Ai/AiMarker.tsx`, variants `superscript | inline | lead`, renders `SparkIcon` + sr-only provenance label), `Skeleton`/`SkeletonText`, `Spinner` (reduced-motion aware), `LoadingBar`. (Feasibility-verified against the V2 worktree — these shapes are accurate.)

## Design

### 1. Shared status contract — `AiLoadState`

Introduce a small four-value state, the smallest vocabulary that answers every indicator question:

```ts
type AiLoadState = 'loading' | 'ready' | 'empty' | 'error';
```

- **"Off"** is *not* a state — it is the existing `enabled` gate (`useAiGate(...)`); a disabled hook renders nothing, as today.
- The three bare hooks change their return shape from `T | null` to `{ state: AiLoadState; data: T | null }`:
  - `useAiHunkAnnotations` → `{ state, annotations }`
  - `useAiDraftSuggestions` → `{ state, suggestions }`
  - inbox enrichment → a per-row `AiLoadState` (see §5 — requires a backend settled signal).
- **`error` must be sourced from the same path as the #484 failure bus.** `useAiHunkAnnotations`/`useAiDraftSuggestions` already route failures to the `useAiFailure` bus and set `entries = null`. The new `error` state must be derived from that same signal, or the hook's own state will report `empty` while the bus reports `error` (divergent sources of truth).
- `useFileFocusResult` keeps its richer enum internally; reduce it to `AiLoadState` for indicator purposes (`loading→loading`; `ok/fallback→ready`; `empty/no-changes→empty`; `error→error`; `not-subscribed→` off). `useAiSummary` maps `{ loading, error }` the same way. Inline each reduction at its hook/adapter — the two mappings are bespoke to their source types; do **not** extract a shared `toAiLoadState` helper unless a third caller with an identical source shape appears (YAGNI). Coverage comes from testing each hook's state output directly (see Testing).
- **Consumer-migration surface (must be enumerated in the plan).** Changing `T | null` → `{ state, data }` breaks every call site and mock: `UnresolvedPanel.tsx` (binds the array directly), `DiffPane.tsx` (binds `allAnnotations` directly), and the ~10 test files that mock `() => null` / `mockReturnValue([...])` against the old shape. This is migration work, not just additive plumbing.

This is fork-1 in concrete form (chosen approach A1 over A2 "full enum everywhere" and A3 "just a loading boolean"). A2 forces `fallback`/`not-subscribed` semantics onto hooks where they are meaningless; A3 cannot distinguish empty from error, leaving the inbox terminal state ambiguous.

### 2. Indicator component — extend `AiMarker`

Add one prop to the existing marker rather than building a parallel component (keeps "thinking" in the same family as "content"):

```ts
interface AiMarkerProps {
  variant?: 'superscript' | 'inline' | 'lead'; // existing — drives size/placement
  state?: 'idle' | 'working';                   // NEW — default 'idle'
  decorative?: boolean;
  className?: string;
}
```

- **The working-vs-idle differentiator is a hue token, not motion.** Define `--ai-working-color` (a distinct working tone, e.g. a blue/violet accent) and `--ai-idle-color` (the existing muted sparkle tone), each with a light- and dark-theme value. `state="working"` fills the glyph with `--ai-working-color`; `idle` uses `--ai-idle-color`. This hue shift — **not** motion — is the load-bearing signal, so the distinction survives `prefers-reduced-motion`.
- **Motion is layered on top, never the sole signal.** With motion enabled, `working` adds a pulse animation; under `prefers-reduced-motion` the pulse is dropped entirely and the hue alone differentiates working from idle (no opacity-only fallback that would collapse the two). The pulse keyframe references CSS custom properties (tokens), not hardcoded colours, so it resolves in both themes from one `@keyframes` block.
- **`idle`** is the existing static glyph (the #489 content marker), now formalized with `--ai-idle-color`.
- Size comes from `variant`; per-surface positioning comes from `className`. No new size enum.
- **B1 gate:** mock all three sparkle states side by side — `working` / `idle` / #489 content-present — in both themes **and** under `prefers-reduced-motion`, and confirm the working↔idle distinction survives the reduced-motion degrade before hardening.

### 3. Per-surface mapping (`AiLoadState` → marker + skeleton)

| Surface | `loading` | `ready` | `empty` | `error` |
|---|---|---|---|---|
| **AI Summary** | `Skeleton` body + `AiMarker state="working"` pulsing in sync with shimmer | render summary; the transient working marker stops (the existing #489 lead provenance marker on the card, if present, is unaffected — no *new* persistent marker added) | hide card (as today) | inline error block (existing #484 path); working marker removed |
| **Hotspots tab** | `AiMarker state="working"` on the tab label + regenerated in-tab skeleton | tab label returns to normal (working marker → idle/removed); rows render | normal tab, empty-state copy | **tab working marker removed** (consistent with file-tree); in-tab error + `retry` (exists) — the tab must not show a marker that reads identical to the ready state |
| **File-tree** | **single** `AiMarker state="working"` in the header, right-aligned, **rendered into the AI-dot-gutter header cell** (see placement note) | marker → `idle` (**persistent** — stays as the "AI is on here" marker); dots render | marker stays `idle` (truthful "AI ran, flagged nothing") | working marker removed |
| **Hunk annotator** | when file-focus is `ready`, show `Skeleton` + `AiMarker state="working"` in focus-flagged files; **otherwise fall back to the annotator's own `loading` state** (now available post-§1) per open file — focus output only *enriches* placement, it is never the sole gate | annotations render; working marker removed | no skeleton | working marker removed; #484 path |
| **Draft suggestions** | per-draft `AiMarker state="working"` beside the draft (**placement provisional** — see B1 note) | suggestion overlay renders | no overlay | no overlay; working marker removed |
| **Inbox chip** | `AiMarker state="working"` in the chip slot | chip pops in (marker → chip) | placeholder resolves to **nothing** (needs the §5 settled signal) | placeholder resolves to nothing |

**Working→ready transition (applies to every row).** When a surface resolves: the working marker stops (hue transitions `--ai-working-color`→`--ai-idle-color` over ~150ms, or snaps under reduced-motion); where a skeleton is present, the skeleton cross-fades into content (opacity over ~200ms, or swaps under reduced-motion). Each row above states whether the marker is *removed* or *settles to idle* on ready — the only surface that retains an idle marker post-load is the file-tree (pending the open decision).

**Annotator divergence cases (file-focus and annotator can disagree).** The annotator fetch is PR-wide and independent of file-focus. Handle all orderings: (a) annotator resolves before focus → render results, no skeleton; (b) focus *errors* but annotator still loading → drive the skeleton off the annotator's own `loading` state for the open file, do not wait on focus `ready`; (c) focus flags zero files but the open file *is* annotated → still show the per-open-file cue off the annotator's state. Gating solely on focus `ready` would leave uncued pop-in in exactly the disagreement cases this feature exists to prevent.

**File-tree placement note.** The file-tree header today is a single full-width element above the body; the AI-dot gutter (`.file-tree-ai-col`, `width: var(--ai-col-w)`) lives *inside* the body. "Right-aligned above the gutter" is therefore not a position the current header exposes. The header must be restructured to reserve the same right-side column width (`--ai-col-w`, and account for the checkbox column) so the marker sits above the gutter, and the reserved width must track the `data-ai-on` gate so it collapses to width-0 with the gutter when AI is off (mirroring #492's lockstep CSS). This is a header-layout change, not a drop-in.

**File-tree is one cue, not per-row.** A pulse per row (≈30 rows) is exactly the motion-noise #508 warns against and would be redundant — one header-level cue says "AI is ranking these files" once.

### 4. Skeletons

Three skeleton spots, all built on the existing `Skeleton` primitive:

- **Summary body** — new; shimmer lines sized to the summary card body.
- **Hotspots** — regenerate the current 3-generic-row skeleton to mimic the #520 headline-led rows (signal-bars glyph slot + headline line + path line). #520 is **merged to V2** (PR #523), so this is unblocked. *This skeleton-fidelity update is orthogonal to the thinking cue (which only needs the tab-label marker) and is separable — see Sequencing; it can land as its own commit/slice.*
- **Annotator** — new; a per-hunk skeleton occupying the annotation slot in focus-flagged (or annotator-loading) files.

### 5. Inbox terminal state (requires a backend signal)

The inbox enricher is best-effort: some rows legitimately get no chip. The chip-slot placeholder **must** resolve to nothing on "settled, no chip," not pulse forever.

This is **not** achievable frontend-only. Enrichments arrive as a whole-snapshot `Record<prId, InboxItemEnrichment>` after a contentless `inbox-updated` SSE triggers a full reload, and the orchestrator **drops null-chip results** (`InboxRefreshOrchestrator`: `if (r.CategoryChip is null) continue;`). So a row that is still enriching, a row enriched-to-nothing, and a row whose enrichment was dropped are all **wire-identical** (absent from the map). A placeholder keyed on entry-absence would either pulse forever or never pulse.

**Required backend change:** expose a per-PR "enrichment settled" signal distinct from "has a chip" — either include null-chip results in the snapshot with an explicit settled/empty marker, or add a snapshot-level "enrichment pass complete" set (analogous to the existing `CiProbeComplete`). The frontend derives the per-row `AiLoadState` from that: `loading` until the PR is settled, then `ready` if a chip arrived or `empty` if not. Without this signal the §5 behaviour is unimplementable.

This backend change is **in scope** for this feature.

### 6. Accessibility

- `working` marker carries an sr-only working announcement; `idle` carries the existing #489 provenance label.
- **`aria-busy` host per surface (enumerated, not "e.g."):** AI Summary → the `<section>` wrapping the card; Hotspots → the tab-panel container; file-tree → the file-tree root element (one region, not per-row); hunk annotator → the diff/file container while its skeleton shows; draft suggestions → the draft row container; **inbox chip → omit `aria-busy`** (a table row is not a valid `aria-busy` host and the per-row sr-only working label on the chip marker is sufficient).
- `prefers-reduced-motion`: pulse dropped; the `--ai-working-color` hue is the differentiator (see §2). Motion is never the only signal.
- File-tree: the existing per-dot `sr-only` "AI focus: <level>" path (and #509's tooltip work) is untouched; the header marker adds a single region-level cue.
- Both light and dark themes mocked from real tokens before hardening (B1 visual gate).

### 7. Sequencing (for the implementation plan)

Six surfaces in one PR is a wide blast radius across visual baselines, and one surface (draft-suggestion overlay) is not yet visually verified. Recommended slicing — the spec stays whole; the plan splits:

- **Slice 1 (foundation + high-traffic):** `AiLoadState` + the lifted hooks + `AiMarker state="working"` (hue tokens + reduced-motion) + the highest-traffic surfaces (summary, file-tree header, hunk annotator). Backend inbox settled-signal can ride here or in Slice 2.
- **Slice 2 (remaining):** Hotspots tab marker + skeleton regen, inbox chip (with backend signal), and the **draft-suggestion overlay** (after its live B1 verification — placement is provisional until then).

This keeps the most-felt pain from being gated on the riskiest/least-verified surface.

## Items to verify visually during implementation (B1 gate)

- **Three-state sparkle distinguishability** — `working` / `idle` / #489 content-present, side by side, both themes, and under `prefers-reduced-motion` (§2).
- **All-surfaces-loading frame** — eyeball one PR-open moment with summary, Hotspots tab, file-tree header, and per-draft markers all in `working` at once, to confirm the collective motion does not itself become noise.
- **Empty-vs-off, file-tree** — render the header AI-on-empty beside AI-off in both themes; confirm a sighted user can tell "ran, flagged nothing" from "off." If the idle glyph alone is ambiguous, add an empty-state affordance (tooltip/label) rather than relying on glyph presence.
- **Draft-suggestion overlay** — built and reachable (`PrDetailView.tsx`, committed e2e baselines), but the `useAiDraftSuggestions` overlay on stale drafts is not yet visually verified. Do a quick live render (even a stub) to establish the DOM anchor for the per-draft marker before finalizing placement, then validate tokens/themes at B1.
- **File-tree header marker** alignment with the AI-dot gutter across horizontal-scroll positions.
- **Hotspots skeleton** vs the live #520 rows (both themes).

## Testing strategy

- **Unit:** each lifted hook returns the right `state` across fetch / 204-empty / error / 401 paths; the `useFileFocusResult` and `useAiSummary` reductions to `AiLoadState` (inlined) are exercised via their hooks' outputs.
- **Component:** `AiMarker` renders the `--ai-working-color` hue under `state="working"`, drops the pulse under reduced-motion while preserving the hue distinction, and switches the sr-only label by state.
- **Consumer migration:** every call site (`UnresolvedPanel`, `DiffPane`) and every mock (~10 spec files) updated to the `{ state, data }` shape — this is an explicit completion checklist, not incidental.
- **Backend:** the inbox settled-signal (per-row or snapshot-level) is emitted for enriched, empty, and dropped rows.
- **Integration/e2e:** each surface shows the working cue while pending and resolves to loaded / empty / error. Reuse the AI-mock e2e harness. New/updated visual baselines (summary skeleton, Hotspots skeleton, file-tree header marker, inbox chip placeholder) regenerated per the established CI-baseline flow.

## Acceptance criteria

- [ ] `AiLoadState` exists; each lifted hook exposes it (no longer bare `T | null`), with `error` sourced consistently with the #484 failure bus.
- [ ] All consumer call sites and test mocks migrated to the `{ state, data }` shape.
- [ ] `AiMarker` supports `state="working"` with a `--ai-working-color` hue differentiator (not motion-dependent) and a reduced-motion-safe degrade; working sr-only label.
- [ ] Each of the six surfaces shows the in-progress cue while loading and resolves cleanly to loaded / empty / error, in both themes (per the §3 table), including the working→ready transition.
- [ ] Annotator cue handles the file-focus divergence cases (§3) — no uncued pop-in when focus errors or flags zero files.
- [ ] File-tree shows **one** header marker (not per-row), rendered into the gutter header cell and collapsing with `data-ai-on` when AI is off.
- [ ] Inbox: backend emits a settled signal; the chip placeholder resolves to nothing on "settled, no chip."
- [ ] `aria-busy` hosts set per the §6 enumeration; no `aria-busy` on a table row.
- [ ] No regression to existing summary / Hotspots loading behaviour, AI thresholds, or content.

## Relationship to existing issues

- **#508** — this design covers its acceptance criteria (annotator status + file-tree in-progress) and supersedes its scope. Close #508 by the PR (or re-scope to a pointer).
- **#509** — independent (styled dot tooltip); not touched here, shares the AI visual language.
- **#489 / #484** — extended (marker gains a working state + formalized idle hue) / reused (error vocabulary, failure bus), not redefined.
