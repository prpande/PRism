# #463 — Remove the region "SAMPLE" badges (design)

**Issue:** [#463](https://github.com/prpande/PRism/issues/463) · **Branch base:** V2 · **Tier:** T2 · **Risk:** gated B1 (UI-visual)

## Problem

`SampleBadge` (the Preview-only "Sample" pill, spec §6 truthful-by-default marker)
is mounted in two shapes:

- **`variant="region"`** — a standalone pill in a header/region context: *above* the
  inbox sections list (a sibling before the section map, not on an individual section
  header), in the Activity rail header, and in the Files-tab tree header. Owner
  decision (issue #463, 2026-06-18): these read as out-of-place noise, and on the
  Activity rail the pill is **actively misleading** — the rail renders real GitHub
  activity, not AI/sample output.
- **inline / `solid`** — sits beside actual sample AI output (summary, hunk
  annotation, composer, validator, stale-draft). These **stay**: they preserve the
  §6 guarantee that Preview content isn't mistaken for real AI output.

The design question is settled (`needs-design` dropped). This is a removal, not a
redesign.

## Scope

Remove **only** the three `variant="region"` placements and the now-dead `region`
machinery. Behavior of every other surface is untouched. No backend change.

### Production changes

| File | Change |
|------|--------|
| `frontend/src/pages/InboxPage.tsx` | Remove the `{showCategoryChip && <SampleBadge variant="region" />}` line (≈137) and the now-unused `SampleBadge` import (≈16). **Keep** `showCategoryChip` — still passed to the section list (≈146). |
| `frontend/src/components/ActivityRail/ActivityRail.tsx` | Remove the `<SampleBadge variant="region" />` line (≈197) and the now-unused `SampleBadge` import (≈8). |
| `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` | Remove the `{aiPreview && <SampleBadge variant="region" />}` line (≈184) and the now-unused `SampleBadge` import (≈6). **Keep** `aiPreview` — still drives `data-ai-on` + `AiSlot`. |
| `frontend/src/components/Ai/SampleBadge.tsx` | Drop the `variant` prop entirely (only `inline`/default remains once `region` is gone) and its branch in the `cls` join. Keep `solid`. |
| `frontend/src/components/Ai/SampleBadge.module.css` | Delete the `.region` block (and its comment). |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` | Fix the stale comment (≈95) that references "the region SampleBadge" — the column visibility is driven by `data-on`/`aiPreview` alone now. |

### Test changes

- `frontend/src/components/Ai/SampleBadge.test.tsx` — delete the
  `applies the region class for the region variant` case (the variant no longer
  exists). The `inline` (default) and `solid` cases stay.

### `titleGroup` wrapper — deliberately kept

`ActivityRail` wraps the title in `<span className={styles.titleGroup}>` purely to
group the title with the (now-removed) badge. After removal it wraps a single span.
`.titleGroup` is `display:flex; align-items:center` with no box of its own, so a
single child renders pixel-identically. **Decision: leave the wrapper** — unwrapping
risks a sub-pixel baseline shift for zero user-visible gain, and is out of the
issue's stated cleanup scope (which is the `region` variant + CSS). Recorded here so
the choice is explicit, not an oversight.

## Acceptance criteria

1. No `variant="region"` SampleBadge renders anywhere — inbox sections header,
   Activity rail, Files-tab tree all clear in Preview mode.
2. Inline SampleBadges beside real sample AI content still render in Preview
   (summary, hunk annotation, composer, validator, stale-draft).
3. The `variant`/`region` machinery + its CSS are gone from `SampleBadge`
   (no dead code; `tsc -b` clean, no unused-symbol lint).
4. Live/Off modes unaffected (`SampleBadge` already returns null outside Preview;
   `useIsSampleMode` path unchanged).
5. Affected visual baselines updated **iff** they actually change (see below).

## Visual-baseline impact (AC5)

The parity baselines for the three surfaces are all captured in **AI-off** mode:

- `inbox.png` / `inbox-activity-rail.png` — fixtures default `aiMode:'off'`; the
  activity-rail test toggles only `inbox.showActivityRail`, never AI mode.
- `pr-detail-files-tree.png` — the test explicitly calls `resetAiPreview` →
  `aiPreview=false` before capture.

The region badges are **Preview-only**, so they never appeared in these AI-off
baselines. **Expected: no baseline regenerated.** CI `parity-baselines` is the
empirical backstop — if any snapshot unexpectedly diffs, regenerate it from the
Linux CI artifact per the established workflow.

## Verification

- **Unit (vitest):** SampleBadge test trimmed to `inline`/`solid`; existing
  InboxPage / ActivityRail / FileTree tests stay green (none assert the region
  badge — they pass `aiPreview={false}` or don't reference it).
- **Type/lint/build:** `tsc -b`, eslint, prettier `--check`, `npm run build`.
- **E2E (CI):** `ai-gating-sweep` unchanged — it targets the *inline* badges via
  `.first()` (AiSummaryCard, StaleDraftRow) and `toHaveCount(0)` when Off, none of
  which this touches. `parity-baselines` expected green (no diff).
- **B1 visual proof:** run the app in **Preview** mode, capture before/after of the
  three surfaces (both themes) showing the SAMPLE box gone, plus one inline badge
  still present to prove AC2. For the **Files-tab tree**, open a PR with at least one
  file in the diff so the populated `Files · N/M viewed` header renders — the
  empty-state header never showed the badge and is not a valid before/after surface.
  Attach to the PR for the owner's eyeball-assert.

## Out of scope

- The always-on AI-content marker (`AiMarker`/#489) — a different concern from the
  Preview-only sample marker; untouched.
- Any change to `useIsSampleMode` / `useAiGate` gating.
