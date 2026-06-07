# PR-detail Content Font-Size Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings slider that scales the font-size of all *data* across the PR-detail tabs (Overview / Files / Drafts) while interactive/navigational chrome stays fixed.

**Architecture:** A new `ui.contentScale` string-enum preference (`xs|s|m|l|xl`, default `m`), persisted and wired exactly like the existing `density` preference. The frontend applier sets a `data-content-scale` attribute on `<html>`; tokens.css maps it to a global `--content-scale` multiplier (default `1`). Content text hooks (`.markdown-body` + a verified set of module-CSS classes) multiply their font-size by it; chrome uses the bare `--text-*` tokens and stays fixed for free. The control is a native range slider with five growing "a" glyphs.

**Tech Stack:** .NET 10 (PRism.Core / PRism.Web), xUnit + FluentAssertions; React 19 + Vite + TypeScript, Vitest + Testing Library, Playwright.

**Spec:** `docs/specs/2026-06-07-font-size-control-design.md`

**Worktree / branch:** `D:\src\PRism-135-fontsize` on `feature/135-font-size-control`.

**Conventions:**
- Frontend single test: `npx vitest run <path>` (cwd `frontend`). Full: `npm test`. Build/typecheck: `npm run build` (`tsc -b && vite build`). Lint gate: run prettier directly — `node ./node_modules/prettier/bin/prettier.cjs --check .` (rtk masks prettier output).
- Backend: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj` / `tests/PRism.Web.Tests/PRism.Web.Tests.csproj` (timeout ≥ 300000ms). Build: `dotnet build -c Release`.
- Run only ONE long-running build/test command at a time.

---

## File Structure

**Backend (persistence — mirrors `density`):**
- Modify `PRism.Core/Config/AppConfig.cs` — `UiConfig` record + `Default` ctor.
- Modify `PRism.Core/Config/ConfigStore.cs` — field-type map + patch switch.
- Modify `PRism.Web/Endpoints/PreferencesDtos.cs` — `UiPreferencesDto`.
- Modify `PRism.Web/Endpoints/PreferencesEndpoints.cs` — GET projection.
- Modify `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` — patch/round-trip/legacy tests.
- Modify `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` — GET shape assertion.

**Frontend (wire + apply + control):**
- Modify `frontend/src/api/types.ts` — `ContentScale` type + `UiPreferences.contentScale`.
- Modify `frontend/src/utils/applyTheme.ts` — `applyContentScaleToDocument`.
- Create `frontend/src/utils/applyTheme.test.ts` — applier unit test.
- Modify `frontend/src/components/AppearanceSync.tsx` — call applier on load/change.
- Create `frontend/src/components/controls/FontSizeSlider.tsx` — the slider.
- Create `frontend/src/components/controls/FontSizeSlider.module.css` — slider styles.
- Create `frontend/src/components/controls/FontSizeSlider.test.tsx` — slider test.
- Modify `frontend/src/components/Settings/panes/AppearancePane.tsx` — new row.
- Modify `frontend/src/components/Settings/panes/AppearancePane.test.tsx` — mock + assertions.

**Frontend (CSS scaling hooks):**
- Modify `frontend/src/styles/tokens.css` — `--content-scale` mapping + `.markdown-body`.
- Modify `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` — `.diffTable`.
- Modify `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css` — `.aiSummaryCard`, `.aiSummaryCategory`.
- Modify `frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css` — `.statsTileValue`, `.statsTileLabel`.
- Modify `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css` — `.aiHunk`.
- Modify `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.module.css` — `.markdownRaw`.
- Modify `frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css` — `.prDescriptionTitle`, `.prDescriptionBody` (C1), `.prDescriptionBody code` (I1).
- Modify `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css` — `.body code` (I1).
- Modify `frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css` — `.draftListItemPreview code` (I1).

**B1 proof + docs:**
- Create `frontend/e2e/font-size-control.spec.ts` — per-surface Playwright proof.
- Modify spec status + `.ai/docs/` doc per documentation-maintenance.

---

## Phase 1 — Backend persistence

### Task 1: Persist `ui.contentScale` in ConfigStore

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:52` (UiConfig), `:24` (Default ctor)
- Modify: `PRism.Core/Config/ConfigStore.cs:37` (field map), `:140` (patch switch)
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the failing tests**

In `ConfigStorePatchAsyncDottedPathTests.cs`, add `contentScale` rows to the existing `StringKeyTypeMismatchInputs` member-data block (the one ending at line 164, after the `density` rows):

```csharp
        { "contentScale", null },
        { "contentScale", true },
        { "contentScale", 5 },
```

Then add two new tests after `InitAsync_LegacyConfigWithoutDensity_DefaultsToComfortable` (after line 225):

```csharp
    // #135: contentScale is a string-typed `ui.*` key alongside theme/accent/density.
    // Round-trips all five legal values; enum-membership is NOT enforced server-side
    // (Deviation 6 — same gap as theme/accent/density).
    [Theory]
    [InlineData("xs")]
    [InlineData("s")]
    [InlineData("m")]
    [InlineData("l")]
    [InlineData("xl")]
    public async Task PatchAsync_ContentScaleValidString_PersistsAndReadsBack(string value)
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(
            new Dictionary<string, object?> { ["contentScale"] = value },
            CancellationToken.None);

        store.Current.Ui.ContentScale.Should().Be(value);
    }

    // #135: a config.json written before the field existed must load with the
    // parameter default ("m"). Same STJ record-positional-default path as density.
    [Fact]
    public async Task InitAsync_LegacyConfigWithoutContentScale_DefaultsToM()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        await File.WriteAllTextAsync(path, """
            {
              "ui": { "theme": "dark", "accent": "amber", "ai-preview": true, "density": "compact" }
            }
            """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.ContentScale.Should().Be("m");
        store.Current.Ui.Density.Should().Be("compact");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests"`
Expected: FAIL — `UiConfig` has no `ContentScale` member (compile error), and `contentScale` is an unknown field.

- [ ] **Step 3: Add the `ContentScale` field to `UiConfig` + Default**

In `AppConfig.cs`, change line 52:

```csharp
public sealed record UiConfig(string Theme, string Accent, bool AiPreview, string Density = "comfortable", string ContentScale = "m");
```

And the `Default` ctor at line 24 (explicit for clarity even though the param defaults):

```csharp
        new UiConfig("system", "indigo", false, "comfortable", "m"),
```

- [ ] **Step 4: Register and handle the `contentScale` patch key**

In `ConfigStore.cs`, add to `_allowedFields` (after the `["density"]` line, ~line 37):

```csharp
            ["contentScale"]                     = ConfigFieldType.String,
```

And add a switch arm in `PatchAsync` (after the `"density"` arm, ~line 140):

```csharp
                "contentScale" => _current with { Ui = ui with { ContentScale = (string)value! } },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests"`
Expected: PASS (all theory rows + both new facts green).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#135): persist ui.contentScale string enum (mirrors density)"
```

---

### Task 2: Surface `contentScale` on GET /api/preferences

**Files:**
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs:24`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs:63`
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs:35`

- [ ] **Step 1: Write the failing assertion**

In `PreferencesEndpointsTests.cs`, inside `GET_returns_nested_ui_inbox_github_blocks`, add after the `density` assertion (line 35):

```csharp
        ui.GetProperty("contentScale").GetString().Should().Be("m");
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PreferencesEndpointsTests.GET_returns_nested_ui_inbox_github_blocks"`
Expected: FAIL — response JSON has no `contentScale` property (KeyNotFound).

- [ ] **Step 3: Add `ContentScale` to the DTO + projection**

`PreferencesDtos.cs` line 24:

```csharp
internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview, string Density, string ContentScale);
```

`PreferencesEndpoints.cs` `BuildResponse` (line 63):

```csharp
            Ui: new UiPreferencesDto(ui.Theme, ui.Accent, ui.AiPreview, ui.Density, ui.ContentScale),
```

- [ ] **Step 4: Run to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PreferencesEndpointsTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(#135): include contentScale in GET /api/preferences projection"
```

---

## Phase 2 — Frontend wire + applier

### Task 3: Add `ContentScale` to frontend types

**Files:**
- Modify: `frontend/src/api/types.ts:3` and `:12-17`

- [ ] **Step 1: Add the type + interface field**

In `types.ts`, after line 3 (`export type Density = ...`):

```ts
export type ContentScale = 'xs' | 's' | 'm' | 'l' | 'xl';
```

And inside `UiPreferences` (after `density: Density;`, line 16):

```ts
  contentScale: ContentScale;
```

- [ ] **Step 2: Typecheck**

Run (cwd `frontend`): `npm run build`
Expected: PASS — the field is additive; no consumer references it yet, so nothing breaks.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(#135): add ContentScale type + UiPreferences.contentScale"
```

---

### Task 4: `applyContentScaleToDocument` applier + unit test

**Files:**
- Modify: `frontend/src/utils/applyTheme.ts:1` (import), end of file (new fn)
- Create: `frontend/src/utils/applyTheme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/utils/applyTheme.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { applyContentScaleToDocument } from './applyTheme';

const ATTR = 'data-content-scale';

afterEach(() => {
  document.documentElement.removeAttribute(ATTR);
});

describe('applyContentScaleToDocument', () => {
  it.each(['xs', 's', 'l', 'xl'] as const)('sets data-content-scale="%s"', (value) => {
    applyContentScaleToDocument(value);
    expect(document.documentElement.getAttribute(ATTR)).toBe(value);
  });

  it('removes the attribute for the default "m"', () => {
    document.documentElement.setAttribute(ATTR, 'xl');
    applyContentScaleToDocument('m');
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
  });

  it('removes the attribute for an unrecognized value (defensive)', () => {
    document.documentElement.setAttribute(ATTR, 'xl');
    applyContentScaleToDocument('zzz' as never);
    expect(document.documentElement.hasAttribute(ATTR)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (cwd `frontend`): `npx vitest run src/utils/applyTheme.test.ts`
Expected: FAIL — `applyContentScaleToDocument` is not exported.

- [ ] **Step 3: Implement the applier**

In `applyTheme.ts`, extend the import on line 1:

```ts
import type { Accent, ContentScale, Density, Theme } from '../api/types';
```

Append at end of file:

```ts
// #135 — content font-size scaling. Mirrors applyDensityToDocument's key-scoped
// DOM-applier pattern: AppearanceSync (boot + change) and AppearancePane (interactive
// picker) both call this so the visible `data-content-scale` attribute on <html>
// updates without waiting for a refetch. The multiplier→size mapping lives in CSS
// (tokens.css), so this only sets the selector. Defensive on any value outside the
// enum: the wire shape is `string` (validated for type, not membership), and "m"
// (Default) writes no attribute — both fall through to the :root 1× default.
export function applyContentScaleToDocument(value: ContentScale): void {
  if (typeof document === 'undefined') return;
  if (value === 'xs' || value === 's' || value === 'l' || value === 'xl') {
    document.documentElement.setAttribute('data-content-scale', value);
  } else {
    document.documentElement.removeAttribute('data-content-scale');
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run (cwd `frontend`): `npx vitest run src/utils/applyTheme.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/applyTheme.ts frontend/src/utils/applyTheme.test.ts
git commit -m "feat(#135): applyContentScaleToDocument applier + unit test"
```

---

### Task 5: Apply content-scale on load/change in AppearanceSync

**Files:**
- Modify: `frontend/src/components/AppearanceSync.tsx:3` (import), `:17-19` (effect)

- [ ] **Step 1: Add the applier call**

Change the import (line 3):

```ts
import {
  applyThemeToDocument,
  applyDensityToDocument,
  applyContentScaleToDocument,
} from '../utils/applyTheme';
```

And inside the effect (after `applyDensityToDocument(preferences.ui.density);`, line 18):

```ts
      applyContentScaleToDocument(preferences.ui.contentScale);
```

- [ ] **Step 2: Typecheck + run existing tests**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AppearanceSync.tsx
git commit -m "feat(#135): apply contentScale on load/change in AppearanceSync"
```

---

## Phase 3 — Control widget

### Task 6: `FontSizeSlider` control + test

**Files:**
- Create: `frontend/src/components/controls/FontSizeSlider.tsx`
- Create: `frontend/src/components/controls/FontSizeSlider.module.css`
- Create: `frontend/src/components/controls/FontSizeSlider.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/controls/FontSizeSlider.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FontSizeSlider } from './FontSizeSlider';

describe('FontSizeSlider', () => {
  it('renders a labelled range slider positioned at the current value', () => {
    render(<FontSizeSlider value="m" onChange={() => {}} />);
    const slider = screen.getByRole('slider', { name: 'Content font size' });
    expect(slider).toHaveValue('2'); // 'm' is index 2 of xs,s,m,l,xl
    expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  });

  it('renders five growing "a" glyphs as the size legend', () => {
    render(<FontSizeSlider value="m" onChange={() => {}} />);
    expect(screen.getAllByText('a')).toHaveLength(5);
  });

  it('maps the slider index back to the enum on change', () => {
    const onChange = vi.fn();
    render(<FontSizeSlider value="m" onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    expect(onChange).toHaveBeenCalledWith('xl');
  });

  it('falls back to index 0 when value is out of the enum', () => {
    render(<FontSizeSlider value={'zzz' as never} onChange={() => {}} />);
    expect(screen.getByRole('slider', { name: 'Content font size' })).toHaveValue('0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (cwd `frontend`): `npx vitest run src/components/controls/FontSizeSlider.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/controls/FontSizeSlider.tsx`:

```tsx
import type { ContentScale } from '../../api/types';
import styles from './FontSizeSlider.module.css';

// Single ordered source of truth for both directions of the index↔enum mapping.
// Index 0–4; 'm' (Default) sits at the center, index 2.
const SCALE_ORDER = ['xs', 's', 'm', 'l', 'xl'] as const;
const STEP_NAMES: Record<ContentScale, string> = {
  xs: 'Extra small',
  s: 'Small',
  m: 'Default',
  l: 'Large',
  xl: 'Extra large',
};

export interface FontSizeSliderProps {
  value: ContentScale;
  onChange: (value: ContentScale) => void;
}

export function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  // Math.max(0, …) keeps the slider reachable if an out-of-enum value is persisted.
  const index = Math.max(0, (SCALE_ORDER as readonly string[]).indexOf(value));
  return (
    <div className={styles.wrap}>
      <input
        type="range"
        min={0}
        max={SCALE_ORDER.length - 1}
        step={1}
        value={index}
        aria-label="Content font size"
        aria-valuetext={STEP_NAMES[SCALE_ORDER[index]]}
        className={styles.range}
        onChange={(e) => onChange(SCALE_ORDER[Number(e.target.value)])}
      />
      {/* Visual size legend: five "a" glyphs growing left→right. Decorative
          (aria-hidden) — the slider's aria-valuetext carries the accessible value. */}
      <div className={styles.ticks} aria-hidden="true">
        {SCALE_ORDER.map((step, i) => (
          <span key={step} className={styles.tick} style={{ fontSize: `${0.7 + i * 0.18}rem` }}>
            a
          </span>
        ))}
      </div>
    </div>
  );
}
```

Create `frontend/src/components/controls/FontSizeSlider.module.css`:

```css
.wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 160px;
}
.range {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
}
.ticks {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  /* Pad to the thumb's reachable range so glyphs line up under each stop
     (native range thumbs don't reach the track's pixel edges). Tuned at B1. */
  padding: 0 6px;
  color: var(--text-3);
  line-height: 1;
}
.tick {
  font-family: var(--font-sans);
  user-select: none;
}
```

- [ ] **Step 4: Run to verify it passes**

Run (cwd `frontend`): `npx vitest run src/components/controls/FontSizeSlider.test.tsx`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/FontSizeSlider.tsx frontend/src/components/controls/FontSizeSlider.module.css frontend/src/components/controls/FontSizeSlider.test.tsx
git commit -m "feat(#135): FontSizeSlider control (range + growing-a legend)"
```

---

### Task 7: Wire the slider into AppearancePane

**Files:**
- Modify: `frontend/src/components/Settings/panes/AppearancePane.tsx`
- Modify: `frontend/src/components/Settings/panes/AppearancePane.test.tsx`

- [ ] **Step 1: Update the test mock + add failing assertions**

In `AppearancePane.test.tsx`, add `contentScale: 'm'` to the mocked `ui` object (line 10):

```ts
      ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false, contentScale: 'm' },
```

Add to the "renders …" test (inside the `it` at line 20), then a new test:

```ts
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
```

```ts
  it('writes the contentScale preference on slider change', async () => {
    const { default: userEventDefault } = await import('@testing-library/user-event');
    render(<AppearancePane />);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    await waitFor(() => expect(set).toHaveBeenCalledWith('contentScale', 'xl'));
    void userEventDefault;
  });
```

(Keep it simple — you may instead add a top-level `import { fireEvent } from '@testing-library/react';` and drop the inline dynamic import.)

- [ ] **Step 2: Run to verify it fails**

Run (cwd `frontend`): `npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: FAIL — no slider rendered; `set('contentScale', …)` never called.

- [ ] **Step 3: Add the imports + handler + row**

In `AppearancePane.tsx`:

Imports (top of file):

```ts
import {
  applyThemeToDocument,
  applyDensityToDocument,
  applyContentScaleToDocument,
} from '../../../utils/applyTheme';
import type { Accent, ContentScale, Density, Theme } from '../../../api/types';
import { FontSizeSlider } from '../../controls/FontSizeSlider';
```

After the `density` derivation/handler (after line 41), add:

```ts
  const SCALE_ORDER: readonly ContentScale[] = ['xs', 's', 'm', 'l', 'xl'];
  const contentScale: ContentScale = SCALE_ORDER.includes(preferences.ui.contentScale)
    ? preferences.ui.contentScale
    : 'm';
  const onContentScale = (value: ContentScale) => {
    const prior = contentScale; // captured before the optimistic DOM write
    applyContentScaleToDocument(value);
    void set('contentScale', value).catch(() => applyContentScaleToDocument(prior));
  };
```

Add a new row after the Density row (after line 98, before the AI-preview row):

```tsx
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Content size</div>
          <div className={pane.help}>Font size for PR content — comments, description, diffs</div>
        </div>
        <div className={pane.spring}>
          <FontSizeSlider value={contentScale} onChange={onContentScale} />
        </div>
      </div>
```

Update the pane subtitle (line 59) to mention it:

```tsx
          <p className={pane.sub}>Theme, accent color, density, content size, and AI preview</p>
```

- [ ] **Step 4: Run to verify it passes**

Run (cwd `frontend`): `npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck the whole frontend**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/panes/AppearancePane.tsx frontend/src/components/Settings/panes/AppearancePane.test.tsx
git commit -m "feat(#135): add Content size slider row to AppearancePane"
```

---

## Phase 4 — CSS scaling hooks

> CSS-module scaling cannot be verified by Vitest (jsdom does not compute `calc()`/CSS vars). Each task's gate is **`npm run build` green** (the CSS is valid + nothing else broke); the *visual* verification of scaling is the Playwright B1 proof in Task 12. Each multiply is a scale-1 no-op, so existing snapshot/visual baselines are unchanged at Default.

### Task 8: Keystone — `--content-scale` mapping + `.markdown-body`

**Files:**
- Modify: `frontend/src/styles/tokens.css:357`

- [ ] **Step 1: Add the multiplier mapping + prose hook**

Immediately before line 357 (`.markdown-body { overflow-wrap: anywhere; }`), insert:

```css
/* #135 — content font-size scaling. A single multiplier var, selected by the
   data-content-scale attribute on <html> (set by applyContentScaleToDocument).
   No attribute / "m" → 1 → no-op (existing baselines unchanged). Consumed only by
   the content hooks below + the enumerated module-CSS classes; chrome uses the bare
   --text-* tokens and stays fixed. */
:root { --content-scale: 1; }
[data-content-scale='xs'] { --content-scale: 0.8; }
[data-content-scale='s'] { --content-scale: 0.9; }
[data-content-scale='l'] { --content-scale: 1.2; }
[data-content-scale='xl'] { --content-scale: 1.4; }
```

Then change line 357 itself to add the font-size multiply (universal prose hook; `1em` resolves to the inherited size so scale 1 is a true no-op):

```css
.markdown-body {
  overflow-wrap: anywhere;
  font-size: calc(1em * var(--content-scale));
}
```

- [ ] **Step 2: Build**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(#135): --content-scale mapping + .markdown-body multiply"
```

---

### Task 9: Non-markdown content hooks (additive multiply)

Each edit converts a pinned token to `calc(<token> * var(--content-scale))` — a scale-1 no-op.

**Files:** DiffPane, AiSummaryCard, StatsTiles, AiHunkAnnotation, MarkdownFileView, PrDescription (title).

- [ ] **Step 1: `.diffTable`** — `DiffPane.module.css:49`

```css
  font-size: calc(var(--text-sm) * var(--content-scale));
```
(within `.diffTable { … }`; `.diffContent`/`.diffGutter` inherit → code + line numbers scale together)

- [ ] **Step 2: AI summary** — `AiSummaryCard.module.css`

`.aiSummaryCard` (line 13):
```css
  font-size: calc(var(--text-sm) * var(--content-scale));
```
`.aiSummaryCategory` (line 32):
```css
  font-size: calc(var(--text-xs) * var(--content-scale));
```
(Leave `.aiSummaryChip` untouched — disclaimer label, intentionally fixed.)

- [ ] **Step 3: Stats tiles** — `StatsTiles.module.css`

`.statsTileLabel` (line 19):
```css
  font-size: calc(var(--text-xs) * var(--content-scale));
```
`.statsTileValue` (line 25):
```css
  font-size: calc(var(--text-2xl) * var(--content-scale));
```

- [ ] **Step 4: AI hunk annotation** — `AiHunkAnnotation.module.css:18`

`.aiHunk`:
```css
  font-size: calc(var(--text-xs) * var(--content-scale));
```
(body `<div>` is classless and inherits; the severity `.chip` keeps its own fixed size.)

- [ ] **Step 5: Raw markdown file view** — `MarkdownFileView.module.css:33`

`.markdownRaw`:
```css
  font-size: calc(var(--text-sm) * var(--content-scale));
```

- [ ] **Step 6: In-tab PR title** — `PrDescription.module.css:7`

`.prDescriptionTitle`:
```css
  font-size: calc(var(--text-md) * var(--content-scale));
```
(renders only when `aiPreview=false`; sibling of the body, so it needs its own multiply.)

- [ ] **Step 7: Build**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.module.css frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css
git commit -m "feat(#135): scale non-markdown data hooks (diff, AI summary, stats, hunk, raw, title)"
```

---

### Task 10: C1 — scale the winning `.prDescriptionBody` class directly

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css:15`

The description's prose element carries BOTH `.markdown-body` and `.prDescriptionBody`; the module class wins the equal-specificity cascade, so `.markdown-body`'s multiply is overridden. Scale the winning class itself.

- [ ] **Step 1: Make `.prDescriptionBody` scale**

`.prDescriptionBody` (line 15):
```css
  font-size: calc(var(--text-sm) * var(--content-scale));
```

- [ ] **Step 2: Build**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css
git commit -m "fix(#135): C1 — scale .prDescriptionBody directly (same-element cascade winner)"
```

---

### Task 11: I1 — make pinned inline `code` relative so it tracks scaled prose

**Files:**
- Modify: `PrDescription.module.css:31`, `PrRootConversation.module.css:152`, `DraftListItem.module.css:45`

- [ ] **Step 1: Convert all three inline-code pins to `0.92em`**

`PrDescription.module.css` `.prDescriptionBody code` (line 31): replace `font-size: 12px;` with
```css
  font-size: 0.92em;
```

`PrRootConversation.module.css` `.body code` (line 152): replace `font-size: 12px;` with
```css
  font-size: 0.92em;
```

`DraftListItem.module.css` `.draftListItemPreview code` (line 45): replace `font-size: var(--text-xs);` with
```css
  font-size: 0.92em;
```

- [ ] **Step 2: Build**

Run (cwd `frontend`): `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css
git commit -m "fix(#135): I1 — inline code uses relative 0.92em so it tracks scaled prose"
```

---

## Phase 5 — B1 visual proof + full gates

### Task 12: Playwright per-surface scaling proof

**Files:**
- Create: `frontend/e2e/font-size-control.spec.ts`

This is the automated half of the B1 gate; the human visual sign-off (screenshots) follows. The test toggles `data-content-scale` and asserts each in-scope data surface's computed font-size **increases** at XL vs Default, and that chrome + comment metadata **do not change**. Use computed font-size comparison (robust to exact px), and drive the attribute directly via `page.evaluate` for determinism (the Settings round-trip is covered by the unit + backend tests).

- [ ] **Step 1: Write the spec**

Create `frontend/e2e/font-size-control.spec.ts` (adapt the import path / fixture helper to the repo's existing e2e harness — see a sibling spec in `frontend/e2e/` for the seeded-PR navigation pattern):

```ts
import { test, expect, type Locator } from '@playwright/test';

// Helper: computed font-size in px for a locator.
async function fontPx(loc: Locator): Promise<number> {
  return loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function setScale(page: import('@playwright/test').Page, scale: string | null) {
  await page.evaluate((s) => {
    if (s) document.documentElement.setAttribute('data-content-scale', s);
    else document.documentElement.removeAttribute('data-content-scale');
  }, scale);
}

test.describe('#135 content font-size scaling', () => {
  test('Overview data surfaces scale; chrome + comment metadata stay fixed', async ({ page }) => {
    // Navigate to a seeded PR Overview (aiPreview=false fixture so the in-tab title renders).
    // Replace with the repo's existing seed/navigation helper.
    await page.goto('/pr/acme/api/123');

    const description = page.locator('[data-testid="pr-description"] .markdown-body').first();
    const title = page.locator('[data-testid="pr-description"] >> text=').first(); // title div
    const statValue = page.locator('[class*="statsTileValue"]').first();
    const commentMeta = page.locator('[class*="band"]').first(); // author/time — must stay fixed
    const tabStrip = page.getByRole('tablist').first(); // chrome — must stay fixed

    const base = {
      description: await fontPx(description),
      stat: await fontPx(statValue),
      meta: await fontPx(commentMeta),
      tabs: await fontPx(tabStrip),
    };

    await setScale(page, 'xl');

    expect(await fontPx(description)).toBeGreaterThan(base.description);
    expect(await fontPx(statValue)).toBeGreaterThan(base.stat);
    // Fixed surfaces unchanged:
    expect(await fontPx(commentMeta)).toBeCloseTo(base.meta, 1);
    expect(await fontPx(tabStrip)).toBeCloseTo(base.tabs, 1);

    await setScale(page, null); // restore
    void title;
  });

  test('Files diff code scales; diff-pane header stays fixed; h-scroll still tracks', async ({
    page,
  }) => {
    await page.goto('/pr/acme/api/123/files');
    const codeLine = page.locator('[class*="diffContent"]').first();
    const paneHeader = page.locator('[class*="diffPaneHeader"]').first();

    const baseCode = await fontPx(codeLine);
    const baseHeader = await fontPx(paneHeader);

    await setScale(page, 'xl');
    expect(await fontPx(codeLine)).toBeGreaterThan(baseCode);
    expect(await fontPx(paneHeader)).toBeCloseTo(baseHeader, 1);

    // h-scroll sanity: the diff body is still horizontally navigable (spacer recomputed).
    const body = page.locator('[class*="diffPaneBody"]').first();
    await expect(body).toBeVisible();

    await setScale(page, null);
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run (cwd `frontend`): `npm run test:e2e -- font-size-control`
Expected: PASS. (If selectors miss because the harness needs a specific seed, adapt to the sibling specs' navigation/seed helpers — do NOT weaken the assertions.)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/font-size-control.spec.ts
git commit -m "test(#135): Playwright per-surface scaling proof (data scales, chrome fixed)"
```

- [ ] **Step 4: Capture B1 screenshots (human visual gate prep)**

Launch the app (`./run.ps1 -Reset None --no-browser` → http://localhost:5180), open a real PR, and screenshot each tab at XS / Default / XL plus the slider at all five steps. These are attached to the PR's Proof section for the owner's visual sign-off (B1-gated). Confirm: description, AI summary (body + category), stats, comments, diff code, AI hunk, drafts, raw+rendered file view all scale; tab strip, toolbars, file-tree names, diff header, comment author/time, AI summary chip stay fixed; slider thumb sits over each "a" glyph.

---

### Task 13: Docs + full pre-push gate

**Files:**
- Modify: `docs/specs/2026-06-07-font-size-control-design.md` (status → Implemented)
- Modify: the appropriate `.ai/docs/` reference per `documentation-maintenance.md` (e.g. add `contentScale` to any preferences/`ui.*` enumeration; if none documents `density`, no doc change is needed — verify).

- [ ] **Step 1: Flip the spec status**

Change the spec's Status line to note it shipped (PR #/commit filled at merge).

- [ ] **Step 2: Check documentation-maintenance mapping**

Read `.ai/docs/documentation-maintenance.md`; if a doc enumerates `ui.*` preferences or Settings controls, add `contentScale` / the Content-size control there. If `density` is not documented anywhere, there is nothing to update — record that in the commit body.

- [ ] **Step 3: Full pre-push checklist** (`.ai/docs/development-process.md`)

Run, one at a time:
- Backend: `dotnet build -c Release` then `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj` and `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj` — all green.
- Frontend: `npm run build` (tsc -b + vite) — green.
- Frontend tests: `npm test` — green.
- Lint gate (bypass rtk): `node ./node_modules/prettier/bin/prettier.cjs --check .` and `npx eslint .` — clean.
- Sync main: `git fetch origin && git merge origin/main` — resolve any drift; re-run the above if main moved.

- [ ] **Step 4: Commit docs**

```bash
git add docs/specs/2026-06-07-font-size-control-design.md .ai/docs/
git commit -m "docs(#135): mark font-size-control spec implemented; note ui.contentScale"
```

- [ ] **Step 5: Open the PR** via `pr-autopilot` (per house convention). Fill the `## Proof` section with the B1 screenshots and the test results. B1-gated: pause for the owner's visual sign-off before merge.

---

## Self-Review

**Spec coverage** (each spec section → task):
- Persistence (`ui.contentScale`, backend table) → Tasks 1–2. ✓
- FE types → Task 3. ✓
- Apply path (`applyContentScaleToDocument` + AppearanceSync) → Tasks 4–5. ✓
- Control widget (`FontSizeSlider`, SCALE_ORDER, prior-capture, no-debounce) → Tasks 6–7. ✓
- CSS hooks: `--content-scale` + `.markdown-body` → Task 8; non-markdown table (diff, AI summary body+category, stats value+label, aiHunk, raw, title) → Task 9; C1 → Task 10; I1 (3 sites) → Task 11. ✓
- Comment metadata stays fixed (I-A) → covered by *omission* (no hook) + asserted fixed in Task 12. ✓
- Testing (backend round-trip, applier, slider, pane, Playwright per-surface) → Tasks 1,2,4,6,7,12. ✓
- Error handling (optimistic+rollback, unrecognized value, back-compat default) → Task 7 handler, Task 4 defensive branch, Task 1 legacy-default test. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/uncoded steps. The only adaptation note is in Task 12 (e2e harness navigation/seed helper), inherent to not bundling the whole e2e fixture corpus here; assertions are concrete.

**Type consistency:** `ContentScale` ('xs'|'s'|'m'|'l'|'xl') and `SCALE_ORDER` (same order, 'm' at index 2) are identical in types.ts (Task 3), FontSizeSlider (Task 6), and AppearancePane (Task 7). `applyContentScaleToDocument(value: ContentScale)` signature matches all three call sites (Tasks 4, 5, 7). Backend `ContentScale` (record member) ↔ `contentScale` (wire/patch key) ↔ `data-content-scale` (DOM attr) ↔ `--content-scale` (CSS var) consistent across Tasks 1, 2, 4, 8.
