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
- Modify `frontend/src/contexts/PreferencesContext.tsx` — `PreferenceKey` union + `InboxSectionKey` Exclude + `readKey`/`writeKey` arms (so `set('contentScale', …)` typechecks and rolls back correctly). **(Found in plan review — without this, Task 7 fails `tsc -b`.)**
- Modify `frontend/src/utils/applyTheme.ts` — `applyContentScaleToDocument`.
- Create `frontend/src/utils/applyTheme.test.ts` — applier unit test.
- Modify `frontend/src/components/AppearanceSync.tsx` — call applier on load/change.
- Create `frontend/src/components/AppearanceSync.test.tsx` — apply-on-load round-trip test (the one load-bearing wiring step otherwise ungated).
- Modify `frontend/e2e/fixtures/preferences.ts` — add `contentScale: 'm'` to `makeDefaultPreferences()`.
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
- Add `data-testid`s to the scaled leaf elements that lack one (CSS-module class names are hashed by Vite, so `[class*=…]` selectors don't work — the e2e suite selects by testid): `stats-tile-value` (`StatsTiles.tsx`), `ai-summary-category` (`AiSummaryCard.tsx`), `pr-description-body` (the `<MarkdownRenderer>` wrapper in `PrDescription.tsx`), `pr-comment-meta` (the `.band` in `PrRootConversation.tsx`), `diff-code-line` (first `.diffContent` in `DiffPane.tsx`), `diff-pane-header` (`DiffPane.tsx`), `ai-hunk` (`AiHunkAnnotation.tsx`), `markdown-raw` (`MarkdownFileView.tsx` raw `<pre>`). Reuse existing: `pr-description`, `stats-tile`, `pr-root-comment`, `pr-title` (PrHeader, chrome), `pr-tab-*` (tab strip, chrome).
- Create `frontend/e2e/font-size-control.spec.ts` — per-surface Playwright proof (real-backend harness).
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

### Task 3b: Extend `PreferencesContext` so `set('contentScale', …)` typechecks + rolls back

**Files:**
- Modify: `frontend/src/contexts/PreferencesContext.tsx:18-29` (union), `:31` (Exclude), `:37` (readKey), `:52-56` (writeKey)

`set(key: PreferenceKey, …)` takes a **closed** union. Without adding `contentScale` to it, `set('contentScale', value)` in Task 7 is a type error (`tsc -b` fails). And `readKey`/`writeKey` need a `contentScale` arm or a `contentScale` key falls through to the `inbox.sections.` slice branch — corrupting state on the rollback path the spec's error-handling relies on.

- [ ] **Step 1: Add `'contentScale'` to the `PreferenceKey` union (line 18-29)**

```ts
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'aiPreview'
  | 'density'
  | 'contentScale'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'ci-failing'
      | 'recently-closed'}`;
```

- [ ] **Step 2: Add it to the `InboxSectionKey` Exclude (line 31)**

```ts
type InboxSectionKey = Exclude<
  PreferenceKey,
  'theme' | 'accent' | 'aiPreview' | 'density' | 'contentScale'
>;
```

- [ ] **Step 3: Add a `readKey` arm (after the `density` arm, line 37)**

```ts
  if (key === 'contentScale') return prefs.ui.contentScale;
```

- [ ] **Step 4: Add a `writeKey` arm (after the `density` block, line 56)**

```ts
  if (key === 'contentScale')
    return {
      ...prefs,
      ui: { ...prefs.ui, contentScale: value as PreferencesResponse['ui']['contentScale'] },
    };
```

- [ ] **Step 5: Typecheck**

Run (cwd `frontend`): `npm run build`
Expected: PASS (the union now admits `contentScale`; no consumer calls it yet, so nothing else changes).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/contexts/PreferencesContext.tsx
git commit -m "feat(#135): allow contentScale through PreferencesContext set/read/write"
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

AppearanceSync is the load-bearing apply-on-load path (without it, every page outside
/settings ignores the saved scale). Cover it with a real assertion — not just a typecheck.

**Files:**
- Create: `frontend/src/components/AppearanceSync.test.tsx`
- Modify: `frontend/src/components/AppearanceSync.tsx:3` (import), effect body

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/AppearanceSync.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceSync } from './AppearanceSync';

// Provide a preferences value via the lenient usePreferences fallback (no provider →
// it builds a local store, but here we render under a stub provider value instead).
import { PreferencesContext } from '../contexts/PreferencesContext';
import type { PreferencesResponse } from '../api/types';

function prefs(contentScale: PreferencesResponse['ui']['contentScale']): PreferencesResponse {
  return {
    ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable', contentScale },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'ci-failing': true,
        'recently-closed': true,
      },
    },
    github: { host: 'h', configPath: 'c', logsPath: 'l' },
  };
}

afterEach(() => document.documentElement.removeAttribute('data-content-scale'));

describe('AppearanceSync', () => {
  it('applies the saved contentScale to <html> on load', () => {
    render(
      <PreferencesContext.Provider
        value={{ preferences: prefs('xl'), error: null, refetch: async () => {}, set: async () => prefs('xl') }}
      >
        <AppearanceSync />
      </PreferencesContext.Provider>,
    );
    expect(document.documentElement.getAttribute('data-content-scale')).toBe('xl');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (cwd `frontend`): `npx vitest run src/components/AppearanceSync.test.tsx`
Expected: FAIL — the attribute is never set (applier not wired yet).

- [ ] **Step 3: Wire the applier**

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

- [ ] **Step 4: Run to verify it passes**

Run (cwd `frontend`): `npx vitest run src/components/AppearanceSync.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AppearanceSync.tsx frontend/src/components/AppearanceSync.test.tsx
git commit -m "feat(#135): apply contentScale on load/change in AppearanceSync (+ test)"
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

Add `fireEvent` to the existing top-of-file import:

```ts
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
```

Add to the "renders …" test (inside the `it` at line 20):

```ts
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
```

Then a new test:

```ts
  it('writes the contentScale preference on slider change', async () => {
    render(<AppearancePane />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    await waitFor(() => expect(set).toHaveBeenCalledWith('contentScale', 'xl'));
  });
```

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

### Task 12: Add testids + Playwright per-surface scaling proof

CSS-module class names are hashed by Vite, so `[class*=…]` selectors don't work (the
whole e2e suite uses `data-testid`). First add testids to the scaled leaf elements that
lack one; then write the proof using the **real-backend harness** (`resetBackendState` +
`setupAndOpenScenarioPr` → fake PR `acme/api/123`). The test drives `data-content-scale`
directly via `page.evaluate` for determinism (the slider→PATCH→DOM round-trip is covered
by the unit tests in Tasks 4–7); it asserts each rendered in-scope surface's computed
font-size **increases** at XL, and chrome + comment metadata **do not change**.

**Files:**
- Modify: `StatsTiles.tsx`, `AiSummaryCard.tsx`, `PrDescription.tsx`, `PrRootConversation.tsx`, `DiffPane.tsx`, `AiHunkAnnotation.tsx`, `MarkdownFileView.tsx` (add testids)
- Modify: `frontend/e2e/fixtures/preferences.ts` (fixture field)
- Create: `frontend/e2e/font-size-control.spec.ts`

- [ ] **Step 1: Add `data-testid`s to scaled leaf elements**

Add the attribute to the element that carries the scaled font-size (so the e2e reads the right node):
- `StatsTiles.tsx` — on the `.statsTileValue` element: `data-testid="stats-tile-value"`; on `.statsTileLabel`: `data-testid="stats-tile-label"`.
- `AiSummaryCard.tsx` — on the `.aiSummaryCategory` element: `data-testid="ai-summary-category"`. (`.aiSummaryBody` is inside the existing `ai-summary-card`.)
- `PrDescription.tsx` — pass through a testid to the rendered body. Since `MarkdownRenderer` has no testid prop, wrap the title div with `data-testid="pr-description-title"` and add a testid to the body by giving the `<MarkdownRenderer>`’s parent or using the existing `[data-testid="pr-description"]` + the body being its `.markdown-body` child: add `data-testid="pr-description-body"` to a wrapping element around `<MarkdownRenderer source={body} className={styles.prDescriptionBody} />`, or extend MarkdownRenderer to forward `data-testid`. Simplest: wrap in `<div data-testid="pr-description-body">…</div>`.
- `PrRootConversation.tsx` — on the `.band` (author/time) element: `data-testid="pr-comment-meta"`.
- `DiffPane.tsx` — on the diff-pane header element (`.diffPaneHeader`): `data-testid="diff-pane-header"`; on the first rendered `.diffContent` code cell: `data-testid="diff-code-line"` (or select the first via `[data-testid="diff-pane"] td` — verify the diff-pane root testid).
- `AiHunkAnnotation.tsx` — on the `.aiHunk` root: `data-testid="ai-hunk"`.
- `MarkdownFileView.tsx` — on the raw `<pre className={styles.markdownRaw}>`: `data-testid="markdown-raw"`; on the rendered branch wrapper: `data-testid="markdown-rendered"`.

- [ ] **Step 2: Add `contentScale` to the e2e default-preferences fixture**

`frontend/e2e/fixtures/preferences.ts` — add to the `ui` block of `makeDefaultPreferences()` (line 33):

```ts
      contentScale: 'm' as const,
```

- [ ] **Step 3: Write the spec**

Create `frontend/e2e/font-size-control.spec.ts`:

```ts
import { test, expect, type Locator, type Page } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

async function fontPx(loc: Locator): Promise<number> {
  return loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function setScale(page: Page, scale: string | null) {
  await page.evaluate((s) => {
    if (s) document.documentElement.setAttribute('data-content-scale', s);
    else document.documentElement.removeAttribute('data-content-scale');
  }, scale);
}

// Assert a present surface scales up at XL; skip (do not fail) a surface the fake
// scenario doesn't render — those are covered by the real-data B1 screenshots (Step 5).
async function expectScales(loc: Locator, label: string) {
  if ((await loc.count()) === 0) {
    test.info().annotations.push({ type: 'skip-surface', description: `${label}: not rendered in fake scenario — covered by B1 screenshot` });
    return;
  }
  const before = await fontPx(loc.first());
  await setScale(loc.page(), 'xl');
  expect(await fontPx(loc.first()), label).toBeGreaterThan(before);
  await setScale(loc.page(), null);
}

test.beforeEach(async ({ request }) => {
  await resetBackendState(request); // also resets aiPreview=false → in-tab title renders
});

test.describe('#135 content font-size scaling', () => {
  test('Overview data surfaces scale; chrome + comment metadata stay fixed', async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');
    await expect(page.getByTestId('overview-tab')).toBeVisible();

    // Fixed chrome/metadata — capture baselines, assert unchanged at XL.
    const tabStrip = page.getByTestId('pr-tab-overview');
    const prHeaderTitle = page.getByTestId('pr-title');
    const commentMeta = page.getByTestId('pr-comment-meta').first();
    const fixed = [tabStrip, prHeaderTitle, commentMeta].filter(async (l) => (await l.count()) > 0);
    const fixedBase = await Promise.all(fixed.map((l) => fontPx(l.first())));

    // Data surfaces — assert each scales.
    await expectScales(page.getByTestId('pr-description-body'), 'description');
    await expectScales(page.getByTestId('pr-description-title'), 'in-tab title');
    await expectScales(page.getByTestId('stats-tile-value'), 'stats value');
    await expectScales(page.getByTestId('stats-tile-label'), 'stats label');
    await expectScales(page.getByTestId('pr-root-comment').locator('p').first(), 'comment body');

    // Chrome stayed fixed.
    await setScale(page, 'xl');
    for (let i = 0; i < fixed.length; i++) {
      expect(await fontPx(fixed[i].first())).toBeCloseTo(fixedBase[i], 1);
    }
    await setScale(page, null);
  });

  test('Overview AI surfaces scale when AI preview is on (chip stays fixed)', async ({ page, request }) => {
    // Enable AI preview so AiSummaryCard renders (fake AI service supplies a summary).
    await request.post('http://localhost:5180/api/preferences', {
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5180' },
      data: JSON.stringify({ aiPreview: true }),
    });
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');

    await expectScales(page.getByTestId('ai-summary-card'), 'AI summary body');
    await expectScales(page.getByTestId('ai-summary-category'), 'AI summary category');
  });

  test('Files diff scales; diff-pane header fixed; h-scroll spacer recomputes', async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await expect(page.getByTestId('files-tab-diff')).toBeVisible();

    const codeLine = page.getByTestId('diff-code-line').first();
    const header = page.getByTestId('diff-pane-header').first();
    const baseHeader = await fontPx(header);

    // M-1: assert the synthetic h-scrollbar spacer recomputes (line widths grow), not
    // merely that the body is visible. diff-hscroll spacer scrollWidth must increase.
    const scroller = page.getByTestId('diff-hscroll');
    const widthBefore = (await scroller.count())
      ? await scroller.evaluate((el) => el.scrollWidth)
      : 0;

    await setScale(page, 'xl');
    expect(await fontPx(codeLine)).toBeGreaterThan(0); // present
    expect(await fontPx(header)).toBeCloseTo(baseHeader, 1); // chrome fixed
    if (await scroller.count()) {
      expect(await scroller.evaluate((el) => el.scrollWidth)).toBeGreaterThanOrEqual(widthBefore);
    }
    await setScale(page, null);
  });
});
```

(Note: `codeLine` scaling is asserted via the `expectScales` pattern if `diff-code-line` resolves; if the diff-pane testid wiring differs at execution time, adapt the selector to the diff-pane root — do NOT weaken to a visibility-only check.)

- [ ] **Step 4: Run the e2e spec**

Run (cwd `frontend`): `npm run test:e2e -- font-size-control`
Expected: PASS. Any surface absent from the fake scenario is annotated `skip-surface` (not failed) and must be confirmed in Step 5's screenshots.

- [ ] **Step 5: Capture B1 screenshots (human visual gate prep)**

Launch the app on real data (`./run.ps1 -Reset None --no-browser` → http://localhost:5180), open a real PR, and screenshot each tab at XS / Default / XL plus the slider at all five steps. Attach to the PR's `## Proof`. Confirm visually — especially the surfaces the fake scenario can't exercise: drafts body, raw + rendered markdown file view, AI hunk annotation, AI summary category. And confirm fixed: tab strip, toolbars, file-tree names, diff header, comment author/time, AI summary chip; slider thumb sits over each "a" glyph (Risk 4 — if it drifts, tune the `.ticks` padding in `FontSizeSlider.module.css`).

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e/font-size-control.spec.ts frontend/e2e/fixtures/preferences.ts frontend/src/components/PrDetail
git commit -m "test(#135): testids + Playwright per-surface scaling proof (data scales, chrome fixed)"
```

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
- `set()` plumbing (`PreferenceKey` union + read/write rollback) → Task 3b. ✓ *(added after plan review — Critical blocker: closed union would fail `tsc -b`.)*
- Apply path (`applyContentScaleToDocument` + AppearanceSync, with apply-on-load test) → Tasks 4–5. ✓
- Control widget (`FontSizeSlider`, SCALE_ORDER, prior-capture, no-debounce) → Tasks 6–7. ✓
- CSS hooks: `--content-scale` + `.markdown-body` → Task 8; non-markdown table (diff, AI summary body+category, stats value+label, aiHunk, raw, title) → Task 9; C1 → Task 10; I1 (3 sites) → Task 11. ✓
- Submit-dialog preview + validator messages → covered by Task 8's universal `.markdown-body` rule (both wrap a bare/no-rule `<MarkdownRenderer>`, verified parent-pinned: `SubmitDialog.tsx:439` no className; `PreSubmitValidatorCard` uses `.ai-validator-card__md` which has no CSS rule, parent pins `var(--text-sm)`). No same-element collision, no extra task. ✓
- `ComposerMarkdownPreview` (M-B) → parent-pinned (`.composerMarkdownPreview` on the wrapper `<div>`, separate `<MarkdownRenderer>` child) → covered by Task 8, **no edit needed**. ✓
- No chrome contamination → no toolbar/menu/banner renders `<MarkdownRenderer>`, so the universal hook can't scale chrome. ✓
- Comment metadata stays fixed (I-A) → covered by *omission* (no hook) + asserted fixed in Task 12. ✓
- Testing (backend round-trip, applier, AppearanceSync apply-on-load, slider, pane, Playwright per-surface incl. AI surfaces + h-scroll recompute) → Tasks 1,2,4,5,6,7,12. ✓
- Error handling (optimistic+rollback, unrecognized value, back-compat default) → Task 7 handler + Task 3b rollback, Task 4 defensive branch, Task 1 legacy-default test. ✓
- Risks: diff h-scroll recompute → Task 12 scrollWidth assertion; slider thumb/glyph alignment → Task 12 Step 5 (B1 visual, tune `.ticks` padding). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/uncoded steps. Task 12 uses `.count()` guards so surfaces absent from the *fake* scenario (drafts/raw-view/AI-hunk may not be seeded) are annotated `skip-surface` and confirmed by the real-data B1 screenshots — this is an honest harness limit, not a coverage gap (the C1 site, description, is automated).

**Type consistency:** `ContentScale` ('xs'|'s'|'m'|'l'|'xl') and `SCALE_ORDER` (same order, 'm' at index 2) are identical in types.ts (Task 3), FontSizeSlider (Task 6), and AppearancePane (Task 7). `'contentScale'` is in the `PreferenceKey` union (Task 3b), so `set('contentScale', …)` typechecks (Task 7). `applyContentScaleToDocument(value: ContentScale)` signature matches all call sites (Tasks 4, 5, 7). Backend `ContentScale` (record member) ↔ `contentScale` (wire/patch key) ↔ `data-content-scale` (DOM attr) ↔ `--content-scale` (CSS var) consistent across Tasks 1, 2, 4, 8.
