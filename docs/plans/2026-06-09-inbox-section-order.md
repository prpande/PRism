# Inbox Section-Order Implementation Plan (#275)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reorder the four inbox *work* sections from Settings → Inbox, persisted as a `config.json` string preference and applied at render time, with `recently-closed` pinned to the bottom and a restore-default.

**Architecture:** A new scalar `inbox.sectionOrder` preference (comma-delimited string of the four work-section ids) rides the existing scalar patch pipeline with zero protocol change — same shape as `inbox.defaultSort`. The backend only persists; a pure frontend helper `orderInboxSections` sorts the live sections by the saved order at render time (strict-write / lenient-read). The Settings pane gains move-up/down buttons that compute new permutations and call the existing `set()`.

**Tech Stack:** .NET 9 (`PRism.Core`, `PRism.Web`) + xUnit/FluentAssertions; React 19 + Vite + TypeScript + vitest/Testing Library; Playwright e2e.

**Spec:** `docs/specs/2026-06-09-inbox-section-order-design.md`

**Working tree:** worktree `D:\src\PRism-275-section-order`, branch `feature/275-section-order`. All commands below run from the repo root of that worktree.

---

## File Structure

**Backend (persist only):**
- `PRism.Core/Config/AppConfig.cs` — `InboxConfig.SectionOrder` field + default string.
- `PRism.Core/Config/ConfigStore.cs` — allowlist entry + permutation validation + switch arm.
- `PRism.Web/Endpoints/PreferencesDtos.cs` — `InboxPreferencesDto.SectionOrder`.
- `PRism.Web/Endpoints/PreferencesEndpoints.cs` — populate the new DTO field.

**Frontend:**
- `frontend/src/api/types.ts` — `InboxPreferences.sectionOrder`.
- `frontend/src/components/Inbox/sectionOrder.ts` *(new)* — the single source of truth for the canonical work-section list + the pure `orderInboxSections` (render sort) and `orderedWorkSectionIds` (Settings rows) helpers.
- `frontend/src/contexts/PreferencesContext.tsx` — union + `Exclude` + `readKey`/`writeKey` arms.
- `frontend/src/pages/InboxPage.tsx` — apply the sort before `.map`.
- `frontend/src/components/Settings/panes/InboxPane.tsx` — reorder UI.
- `frontend/src/components/Settings/panes/Pane.module.css` — move-button + pinned-tag classes.

**Tests:** alongside each (xUnit under `tests/`, vitest co-located or under `frontend/__tests__/`), plus one Playwright e2e.

---

## Task 1: Backend config model — `InboxConfig.SectionOrder`

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:37-42` (`InboxConfig` record)
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the failing test** — legacy config without the key defaults to canonical order.

Append to `ConfigStorePatchAsyncDottedPathTests`:

```csharp
// #275: SectionOrder is a new trailing-defaulted string parameter on InboxConfig.
// A config.json written before the field existed must load with the canonical
// work-section order. Same STJ record-positional-default path as DefaultSort.
[Fact]
public void Default_SectionOrder_IsCanonicalWorkOrder()
{
    AppConfig.Default.Inbox.SectionOrder
        .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");
}

[Fact]
public async Task InitAsync_LegacyConfigWithoutSectionOrder_DefaultsToCanonical()
{
    using var dir = new TempDataDir();
    var path = Path.Combine(dir.Path, "config.json");
    await File.WriteAllTextAsync(path, """
        {
          "inbox": { "deduplicate": true, "sections": { "review-requested": true } }
        }
        """);
    using var store = new ConfigStore(dir.Path);
    await store.InitAsync(CancellationToken.None);

    store.Current.Inbox.SectionOrder
        .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests.Default_SectionOrder_IsCanonicalWorkOrder|FullyQualifiedName~InitAsync_LegacyConfigWithoutSectionOrder"`
Expected: FAIL — `InboxConfig` has no `SectionOrder` member (compile error).

- [ ] **Step 3: Add the field**

In `PRism.Core/Config/AppConfig.cs`, change `InboxConfig` to add a trailing-defaulted parameter:

```csharp
public sealed record InboxConfig(
    bool Deduplicate,
    InboxSectionsConfig Sections,
    bool ShowHiddenScopeFooter,
    int RecentlyClosedWindowDays = 14,
    string DefaultSort = "updated",
    string SectionOrder = "review-requested,awaiting-author,authored-by-me,mentioned");
```

`AppConfig.Default` constructs `InboxConfig` positionally without the trailing args (`new InboxConfig(true, new InboxSectionsConfig(...), true, 14)`), so the new default applies automatically — no change needed there. `recently-closed` is deliberately **not** in the string (it is pinned in the frontend).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests.Default_SectionOrder_IsCanonicalWorkOrder|FullyQualifiedName~InitAsync_LegacyConfigWithoutSectionOrder"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#275): add InboxConfig.SectionOrder with canonical default"
```

---

## Task 2: Backend patch allowlist + permutation validation

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs:32-46` (allowlist), `:52-53` (add a known-ids set), `:139-144` (validation block), `:151-171` (switch)
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the failing tests** — accept a valid permutation; reject every malformed shape.

Append to `ConfigStorePatchAsyncDottedPathTests`:

```csharp
// #275: a valid 4-id permutation patches through to InboxConfig.SectionOrder and persists.
[Fact]
public async Task Patch_sets_valid_section_order()
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);
    await store.PatchAsync(
        new Dictionary<string, object?>
            { ["inbox.sectionOrder"] = "mentioned,review-requested,authored-by-me,awaiting-author" },
        CancellationToken.None);
    store.Current.Inbox.SectionOrder
        .Should().Be("mentioned,review-requested,authored-by-me,awaiting-author");
}

[Fact]
public async Task Patch_section_order_persists_across_reload()
{
    var dir = Directory.CreateTempSubdirectory().FullName;
    var store = new ConfigStore(dir);
    await store.InitAsync(CancellationToken.None);
    await store.PatchAsync(
        new Dictionary<string, object?>
            { ["inbox.sectionOrder"] = "authored-by-me,mentioned,review-requested,awaiting-author" },
        CancellationToken.None);

    var roundTrip = new ConfigStore(dir);
    await roundTrip.InitAsync(CancellationToken.None);
    roundTrip.Current.Inbox.SectionOrder
        .Should().Be("authored-by-me,mentioned,review-requested,awaiting-author");
}

// Each malformed value must be rejected with a ConfigPatchException naming the field
// (→ 400 at the endpoint), not silently persisted.
public static TheoryData<string> InvalidSectionOrders() => new()
{
    "review-requested,awaiting-author,authored-by-me",                       // incomplete (3)
    "review-requested,awaiting-author,authored-by-me,mentioned,recently-closed", // too long / pinned id
    "review-requested,review-requested,authored-by-me,mentioned",            // duplicate
    "review-requested,awaiting-author,authored-by-me,bogus",                 // unknown id
    "",                                                                       // empty
    "recently-closed,review-requested,awaiting-author,mentioned",            // includes pinned id
};

[Theory]
[MemberData(nameof(InvalidSectionOrders))]
public async Task Patch_rejects_invalid_section_order(string value)
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);
    var act = async () => await store.PatchAsync(
        new Dictionary<string, object?> { ["inbox.sectionOrder"] = value }, CancellationToken.None);
    await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*inbox.sectionOrder*");
}

// Non-string value (number/null/bool) is rejected by the per-key type check.
[Fact]
public async Task Patch_rejects_nonstring_section_order()
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);
    var act = async () => await store.PatchAsync(
        new Dictionary<string, object?> { ["inbox.sectionOrder"] = 42 }, CancellationToken.None);
    await act.Should().ThrowAsync<ConfigPatchException>()
        .Where(e => e.Message.Contains("inbox.sectionOrder") && e.Message.Contains("string"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests.Patch_sets_valid_section_order|FullyQualifiedName~Patch_section_order_persists|FullyQualifiedName~Patch_rejects_invalid_section_order|FullyQualifiedName~Patch_rejects_nonstring_section_order"`
Expected: FAIL — `inbox.sectionOrder` is an unknown field (rejected by allowlist).

- [ ] **Step 3: Add the allowlist entry, the known-ids set, the validation block, and the switch arm**

In `ConfigStore.cs`, add to `_allowedFields` (after the `inbox.defaultSort` line at `:45`):

```csharp
            ["inbox.defaultSort"]                = ConfigFieldType.String,
            ["inbox.sectionOrder"]               = ConfigFieldType.String,
```

After the `_allowedSorts` set (`:52-53`), add the canonical work-section id set:

```csharp
    // #275: inbox.sectionOrder is a string-typed key whose value must be a permutation
    // of exactly these four work-section ids (recently-closed is pinned in the frontend
    // and never part of the persisted order). Validated BEFORE the gate so a malformed
    // value returns 400, not a persisted order the frontend can't render coherently.
    private static readonly string[] _workSectionIds =
        { "review-requested", "awaiting-author", "authored-by-me", "mentioned" };
```

In `PatchAsync`, after the existing `inbox.defaultSort` validation block (`:142-144`), add:

```csharp
        if (key == "inbox.sectionOrder")
        {
            var ids = ((string)value!).Split(
                ',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            var ordered = new HashSet<string>(ids, StringComparer.Ordinal);
            if (ids.Length != _workSectionIds.Length
                || ordered.Count != ids.Length
                || !_workSectionIds.All(ordered.Contains))
            {
                throw new ConfigPatchException(
                    "field 'inbox.sectionOrder' expects a comma-separated permutation of the four " +
                    "work-section ids (review-requested, awaiting-author, authored-by-me, mentioned)");
            }
        }
```

In the `key switch` (after the `inbox.defaultSort` arm at `:168-169`), add:

```csharp
                "inbox.sectionOrder" =>
                    _current with { Inbox = _current.Inbox with { SectionOrder = (string)value! } },
```

(`System.Linq` is already in scope — `PatchAsync` uses `patch.Single()`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests"`
Expected: PASS (all, including the new section-order tests and the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#275): validate + persist inbox.sectionOrder permutation"
```

---

## Task 3: Backend wire shape — DTO + endpoint

**Files:**
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs:26` (`InboxPreferencesDto`)
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs:64-71` (`BuildResponse`)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`

- [ ] **Step 1: Write the failing test** — GET surfaces `sectionOrder`; a POST round-trips it.

Open `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`, read the top to match its existing host/client setup helper (look for the method that creates the test app and returns an `HttpClient` — reuse it verbatim), then add a test mirroring an existing GET/POST test:

```csharp
// #275: GET /api/preferences surfaces inbox.sectionOrder (defaults to canonical),
// and POST round-trips a valid permutation.
[Fact]
public async Task Preferences_section_order_defaults_and_round_trips()
{
    using var app = CreateApp(out var client); // reuse this test class's existing factory helper
    await using var _ = app;

    var initial = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
    initial.GetProperty("inbox").GetProperty("sectionOrder").GetString()
        .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");

    var post = await client.PostAsJsonAsync("/api/preferences",
        new Dictionary<string, object?>
            { ["inbox.sectionOrder"] = "mentioned,authored-by-me,review-requested,awaiting-author" });
    post.StatusCode.Should().Be(HttpStatusCode.OK);

    var after = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
    after.GetProperty("inbox").GetProperty("sectionOrder").GetString()
        .Should().Be("mentioned,authored-by-me,review-requested,awaiting-author");
}
```

> If the test class has no reusable app factory matching `CreateApp(out var client)`, copy the setup idiom from the nearest existing `[Fact]` in the same file (the precise helper name varies — match what is already there rather than inventing one).

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Preferences_section_order_defaults_and_round_trips"`
Expected: FAIL — response `inbox` has no `sectionOrder` property.

- [ ] **Step 3: Add the DTO field and populate it**

In `PreferencesDtos.cs:26`:

```csharp
internal sealed record InboxPreferencesDto(InboxSectionsDto Sections, string DefaultSort, string SectionOrder);
```

In `PreferencesEndpoints.cs` `BuildResponse`, change the `Inbox:` construction (`:64-71`) to pass the new field:

```csharp
            Inbox: new InboxPreferencesDto(
                new InboxSectionsDto(
                    ReviewRequested: sections.ReviewRequested,
                    AwaitingAuthor:  sections.AwaitingAuthor,
                    AuthoredByMe:    sections.AuthoredByMe,
                    Mentioned:       sections.Mentioned,
                    RecentlyClosed:  sections.RecentlyClosed),
                config.Current.Inbox.DefaultSort,
                config.Current.Inbox.SectionOrder),
```

(`SectionOrder` serializes as `sectionOrder` under the API camelCase policy — no `[JsonPropertyName]` needed.)

- [ ] **Step 4: Run the test + full Web suite to verify**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Preferences_section_order_defaults_and_round_trips"`
Expected: PASS. Then `dotnet build PRism.Web` to confirm no other `InboxPreferencesDto` construction site broke.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(#275): surface inbox.sectionOrder on the preferences wire"
```

---

## Task 4: Frontend pure helper — `sectionOrder.ts` (SSOT + sorts)

**Files:**
- Create: `frontend/src/components/Inbox/sectionOrder.ts`
- Test: `frontend/src/components/Inbox/sectionOrder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/Inbox/sectionOrder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { InboxSection } from '../../api/types';
import {
  CANONICAL_WORK_ORDER,
  CANONICAL_DEFAULT_ORDER_STRING,
  orderInboxSections,
  orderedWorkSectionIds,
} from './sectionOrder';

const sec = (id: string): InboxSection => ({ id, label: id, items: [] });
const ids = (xs: InboxSection[]) => xs.map((s) => s.id);

describe('CANONICAL_DEFAULT_ORDER_STRING', () => {
  it('is the four work ids joined, no recently-closed', () => {
    expect(CANONICAL_DEFAULT_ORDER_STRING).toBe(
      'review-requested,awaiting-author,authored-by-me,mentioned',
    );
    expect(CANONICAL_WORK_ORDER).not.toContain('recently-closed');
  });
});

describe('orderInboxSections', () => {
  const live = [
    sec('review-requested'),
    sec('awaiting-author'),
    sec('authored-by-me'),
    sec('mentioned'),
    sec('recently-closed'),
  ];

  it('reorders by the saved permutation, recently-closed pinned last', () => {
    const out = orderInboxSections(live, 'mentioned,authored-by-me,review-requested,awaiting-author');
    expect(ids(out)).toEqual([
      'mentioned',
      'authored-by-me',
      'review-requested',
      'awaiting-author',
      'recently-closed',
    ]);
  });

  it('forces recently-closed last even if the saved order lists it first', () => {
    const out = orderInboxSections(live, 'recently-closed,mentioned,review-requested,awaiting-author,authored-by-me');
    expect(ids(out).at(-1)).toBe('recently-closed');
  });

  it('appends a section absent from the saved order in canonical order (no drop)', () => {
    // saved order omits authored-by-me; it must still render, after the listed ones.
    const out = orderInboxSections(live, 'mentioned,review-requested,awaiting-author');
    expect(ids(out)).toEqual([
      'mentioned',
      'review-requested',
      'awaiting-author',
      'authored-by-me',
      'recently-closed',
    ]);
  });

  it('ignores a saved id that matches no live section', () => {
    const out = orderInboxSections([sec('mentioned'), sec('review-requested')], 'ghost,mentioned,review-requested');
    expect(ids(out)).toEqual(['mentioned', 'review-requested']);
  });

  it('falls back to canonical order for undefined / empty / malformed', () => {
    for (const bad of [undefined, '', '   ', ',,,']) {
      const out = orderInboxSections(live, bad);
      expect(ids(out)).toEqual([
        'review-requested',
        'awaiting-author',
        'authored-by-me',
        'mentioned',
        'recently-closed',
      ]);
    }
  });

  it('arranges a filter-narrowed subset by the saved order', () => {
    const subset = [sec('mentioned'), sec('review-requested')];
    const out = orderInboxSections(subset, 'mentioned,authored-by-me,review-requested,awaiting-author');
    expect(ids(out)).toEqual(['mentioned', 'review-requested']);
  });
});

describe('orderedWorkSectionIds', () => {
  it('returns exactly the four work ids in saved order', () => {
    expect(orderedWorkSectionIds('mentioned,authored-by-me,review-requested,awaiting-author')).toEqual([
      'mentioned',
      'authored-by-me',
      'review-requested',
      'awaiting-author',
    ]);
  });

  it('appends missing ids canonically and dedups / drops unknowns', () => {
    expect(orderedWorkSectionIds('mentioned,bogus,mentioned')).toEqual([
      'mentioned',
      'review-requested',
      'awaiting-author',
      'authored-by-me',
    ]);
  });

  it('returns full canonical order for undefined', () => {
    expect(orderedWorkSectionIds(undefined)).toEqual([
      'review-requested',
      'awaiting-author',
      'authored-by-me',
      'mentioned',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Inbox/sectionOrder.test.ts` (from `frontend/`)
Expected: FAIL — module `./sectionOrder` not found.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/components/Inbox/sectionOrder.ts`:

```typescript
import type { InboxSection } from '../../api/types';

// Single source of truth for the canonical inbox WORK-section order. recently-closed
// is NOT here — it is an archive, pinned to the bottom of the inbox and never part of
// the persisted/reorderable set (#275 spec, scope decision 2). Every consumer (the
// render-time sort, the Settings pane rows, the restore-default button) imports from
// here so the id list can never drift between layers.
export const CANONICAL_WORK_ORDER = [
  'review-requested',
  'awaiting-author',
  'authored-by-me',
  'mentioned',
] as const;

export type WorkSectionId = (typeof CANONICAL_WORK_ORDER)[number];

// The persisted default string (what config.json holds out of the box, what
// restore-default writes, and the disabled-when-equal comparison key).
export const CANONICAL_DEFAULT_ORDER_STRING = CANONICAL_WORK_ORDER.join(',');

const RECENTLY_CLOSED = 'recently-closed';

function parseSavedIds(savedOrder: string | undefined): string[] {
  return (savedOrder ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Render-time sort. Lenient by contract (strict-write / lenient-read, #275 spec):
// - sections in the saved order sort by their saved index;
// - a section NOT in the saved order sorts AFTER the listed ones, in canonical order
//   (so a future/new section is appended, never dropped — acceptance criterion #3);
// - a saved id matching no live section is harmlessly ignored;
// - recently-closed is ALWAYS forced last regardless of the saved/canonical order.
// Array.prototype.sort is stable (Node/V8), so equal-rank ties keep input order.
export function orderInboxSections(
  sections: InboxSection[],
  savedOrder: string | undefined,
): InboxSection[] {
  const saved = parseSavedIds(savedOrder);
  const rank = (id: string): number => {
    if (id === RECENTLY_CLOSED) return Number.MAX_SAFE_INTEGER;
    const savedIndex = saved.indexOf(id);
    if (savedIndex >= 0) return savedIndex;
    const canonicalIndex = (CANONICAL_WORK_ORDER as readonly string[]).indexOf(id);
    return saved.length + (canonicalIndex >= 0 ? canonicalIndex : CANONICAL_WORK_ORDER.length);
  };
  return [...sections].sort((a, b) => rank(a.id) - rank(b.id));
}

// The four work-section ids in display order for the Settings pane. Guarantees exactly
// the four ids: valid saved ids first (in order, deduped), then any canonical id not yet
// present. Unknown / pinned ids in the saved string are dropped.
export function orderedWorkSectionIds(savedOrder: string | undefined): WorkSectionId[] {
  const valid = parseSavedIds(savedOrder).filter(
    (id): id is WorkSectionId => (CANONICAL_WORK_ORDER as readonly string[]).includes(id),
  );
  const seen = new Set<WorkSectionId>(valid);
  return [...valid, ...CANONICAL_WORK_ORDER.filter((id) => !seen.has(id))];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Inbox/sectionOrder.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/sectionOrder.ts frontend/src/components/Inbox/sectionOrder.test.ts
git commit -m "feat(#275): add sectionOrder SSOT + pure render/Settings sort helpers"
```

---

## Task 5: Frontend types + PreferencesContext arms (with the Exclude trap)

**Files:**
- Modify: `frontend/src/api/types.ts:29-32` (`InboxPreferences`)
- Modify: `frontend/src/contexts/PreferencesContext.tsx:18-46, 68-86` (union, Exclude, readKey, writeKey)
- Test: `frontend/__tests__/PreferencesContext.test.tsx`

- [ ] **Step 1: Write the failing test** — `set('inbox.sectionOrder', …)` round-trips and does NOT touch `inbox.sections.*`.

Read `frontend/__tests__/PreferencesContext.test.tsx` to match its existing harness (it renders a consumer and stubs `apiClient`). Add a test asserting the new key writes through `writeKey` correctly. Model it on the existing optimistic/rollback tests in that file; the key assertion:

```typescript
it('writes inbox.sectionOrder via its own arm without touching inbox.sections', () => {
  // writeKey is exported from the context module.
  const before = {
    ui: {}, github: {},
    inbox: {
      sections: { 'review-requested': true, 'awaiting-author': true, 'authored-by-me': true, mentioned: true, 'recently-closed': true },
      defaultSort: 'updated',
      sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
    },
  } as unknown as import('../src/api/types').PreferencesResponse;

  const after = writeKey(before, 'inbox.sectionOrder', 'mentioned,review-requested,authored-by-me,awaiting-author');

  expect(after.inbox.sectionOrder).toBe('mentioned,review-requested,authored-by-me,awaiting-author');
  // The slice-fallthrough trap: sections must be untouched.
  expect(after.inbox.sections).toEqual(before.inbox.sections);
  expect(readKey(after, 'inbox.sectionOrder')).toBe('mentioned,review-requested,authored-by-me,awaiting-author');
});
```

Add `writeKey, readKey` to the existing import from `'../src/contexts/PreferencesContext'` at the top of the test file (they are already exported).

- [ ] **Step 2: Run to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run __tests__/PreferencesContext.test.tsx`
Expected: FAIL — `'inbox.sectionOrder'` is not assignable to `PreferenceKey`; and at runtime `writeKey` routes it through the `inbox.sections.` slice path, corrupting `sections`.

- [ ] **Step 3: Add the type field + the three coordinated context edits**

In `frontend/src/api/types.ts`, `InboxPreferences`:

```typescript
export interface InboxPreferences {
  sections: InboxSectionsPreferences;
  defaultSort: SortKey;
  sectionOrder: string;
}
```

In `frontend/src/contexts/PreferencesContext.tsx`:

(1) Add to the `PreferenceKey` union (after `'inbox.defaultSort'` at `:24`):

```typescript
  | 'inbox.defaultSort'
  | 'inbox.sectionOrder'
```

(2) Add to the `Exclude<...>` that forms `InboxSectionKey` (`:32-35`):

```typescript
type InboxSectionKey = Exclude<
  PreferenceKey,
  'theme' | 'accent' | 'aiPreview' | 'density' | 'contentScale' | 'inbox.defaultSort' | 'inbox.sectionOrder'
>;
```

(3) Add an early-return arm in `readKey` (after the `inbox.defaultSort` line at `:43`):

```typescript
  if (key === 'inbox.defaultSort') return prefs.inbox.defaultSort;
  if (key === 'inbox.sectionOrder') return prefs.inbox.sectionOrder;
```

(4) Add an arm in `writeKey` (after the `inbox.defaultSort` block, before the trailing `inbox.sections.` slice logic at `:76`):

```typescript
  if (key === 'inbox.sectionOrder')
    return {
      ...prefs,
      inbox: { ...prefs.inbox, sectionOrder: value as string },
    };
```

- [ ] **Step 4: Run the test + typecheck**

Run: `node ./node_modules/vitest/vitest.mjs run __tests__/PreferencesContext.test.tsx`
Expected: PASS. Then `npm run build` (`tsc -b`) — it will flag every test fixture that constructs an `inbox` preferences object without the now-required `sectionOrder`. Add `sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned'` to each (expected sites: `frontend/__tests__/InboxPage.test.tsx`, `frontend/src/components/Settings/panes/InboxPane.test.tsx`, `frontend/src/components/AppearanceSync.test.tsx`, and any other the compiler names). Re-run `npm run build` until green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx frontend/__tests__/PreferencesContext.test.tsx
git add -A   # include the test-fixture sectionOrder additions tsc surfaced
git commit -m "feat(#275): plumb inbox.sectionOrder through PreferencesContext (guard Exclude trap)"
```

---

## Task 6: Apply the order in `InboxPage`

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx:102-113`
- Test: `frontend/__tests__/InboxPage.test.tsx`

- [ ] **Step 1: Write the failing test** — sections render in the saved order, recently-closed last.

Read the existing `InboxPage.test.tsx` `setHooks` helper (it mocks `usePreferences` to return a `preferences` object — extend the inbox block there to accept a `sectionOrder`). Add:

```typescript
it('renders sections in the saved order with recently-closed pinned last', () => {
  setHooks({
    data: {
      sections: [
        { id: 'review-requested', label: 'Review requested', items: [] },
        { id: 'authored-by-me', label: 'Authored by me', items: [] },
        { id: 'mentioned', label: 'Mentioned', items: [] },
        { id: 'recently-closed', label: 'Recently closed', items: [] },
      ],
      enrichments: {}, lastRefreshedAt: '', tokenScopeFooterEnabled: false, ciProbeComplete: true,
    },
    sectionOrder: 'mentioned,authored-by-me,review-requested,awaiting-author',
  });
  render(
    <MemoryRouter><OpenTabsProvider><InboxPage /></OpenTabsProvider></MemoryRouter>,
  );
  const headings = screen.getAllByRole('button', { name: /Review requested|Authored by me|Mentioned|Recently closed/ });
  // Assert the rendered section heading order. (Match the actual accessible name/role
  // the InboxSection header exposes — adjust the query to the existing section header testid
  // if role/name differ; the assertion is the ORDER of ids in the DOM.)
  const order = headings.map((h) => h.textContent);
  expect(order[0]).toMatch(/Mentioned/);
  expect(order[1]).toMatch(/Authored by me/);
  expect(order[2]).toMatch(/Review requested/);
  expect(order.at(-1)).toMatch(/Recently closed/);
});
```

Extend `setHooks` so its `usePreferences` mock includes `inbox: { …, sectionOrder: opts.sectionOrder ?? 'review-requested,awaiting-author,authored-by-me,mentioned' }`.

> If the section header is not exposed as a `button` with that name, locate the existing query the other InboxPage tests use for section headers and assert DOM order with that selector instead. The behavioral assertion is unchanged: the ids appear in saved order, recently-closed last.

- [ ] **Step 2: Run to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run __tests__/InboxPage.test.tsx`
Expected: FAIL — sections render in API order (review-requested first), not the saved order.

- [ ] **Step 3: Apply the sort before the map**

In `InboxPage.tsx`, add the import:

```typescript
import { orderInboxSections } from '../components/Inbox/sectionOrder';
```

Replace the render block (`:102-113`) to sort `visibleSections` first:

```tsx
            {!zeroMatch &&
              orderInboxSections(visibleSections, preferences?.inbox.sectionOrder).map((s) => (
                <InboxSection
                  key={s.id}
                  section={s}
                  enrichments={data.enrichments}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                  defaultOpen={s.id !== 'recently-closed'}
                  forceOpen={filterActive && s.id !== 'recently-closed'}
                />
              ))}
```

(`preferences` is already destructured at `InboxPage.tsx:22`. When preferences are still loading, `preferences?.inbox.sectionOrder` is `undefined` → the helper returns canonical order, identical to today's cold load.)

- [ ] **Step 4: Run to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run __tests__/InboxPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/__tests__/InboxPage.test.tsx
git commit -m "feat(#275): apply saved section order on the inbox render path"
```

---

## Task 7: Settings reorder UI (`InboxPane`)

**Files:**
- Modify: `frontend/src/components/Settings/panes/InboxPane.tsx` (full rewrite of the rows region)
- Modify: `frontend/src/components/Settings/panes/Pane.module.css` (append classes)
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `InboxPane.test.tsx` (its `usePreferences` mock already returns an `inbox` block — add `sectionOrder` to it, defaulting to canonical, and let `renderInboxPane` accept a `sectionOrder` override mirroring how it handles `defaultSort`):

```typescript
describe('InboxPane reorder', () => {
  it('renders move buttons for the four work sections and none for recently-closed', () => {
    renderInboxPane();
    expect(screen.getByRole('button', { name: 'Move Review requested up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Mentioned down' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move Recently closed/ })).toBeNull();
  });

  it('disables up on the first row and down on the last work row', () => {
    renderInboxPane(); // canonical order: review-requested first, mentioned last (work set)
    expect(screen.getByRole('button', { name: 'Move Review requested up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Mentioned down' })).toBeDisabled();
  });

  it('writes the swapped permutation on Move down', async () => {
    renderInboxPane();
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        'inbox.sectionOrder',
        'awaiting-author,review-requested,authored-by-me,mentioned',
      ),
    );
  });

  it('disables reorder controls while a move POST is in flight (no lost second click)', async () => {
    let resolve!: (v: unknown) => void;
    renderInboxPane({ set: () => new Promise((r) => { resolve = r; }) });
    const down = screen.getByRole('button', { name: 'Move Review requested down' });
    await userEvent.click(down);
    // While pending, all move buttons are disabled — a rapid second click cannot fire.
    expect(screen.getByRole('button', { name: 'Move Authored by me up' })).toBeDisabled();
    resolve(undefined);
  });

  it('disables Restore default order when already at the canonical default', () => {
    renderInboxPane(); // canonical
    expect(screen.getByRole('button', { name: 'Restore default order' })).toBeDisabled();
  });

  it('enables and uses Restore default order when reordered', async () => {
    renderInboxPane({ sectionOrder: 'mentioned,authored-by-me,review-requested,awaiting-author' });
    const restore = screen.getByRole('button', { name: 'Restore default order' });
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith('inbox.sectionOrder', 'review-requested,awaiting-author,authored-by-me,mentioned'),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/InboxPane.test.tsx`
Expected: FAIL — no move/restore buttons exist.

- [ ] **Step 3: Rewrite `InboxPane.tsx`**

Replace the whole file with:

```tsx
import { useState } from 'react';
import { usePreferences, type PreferenceKey } from '../../../hooks/usePreferences';
import type { InboxSectionsPreferences } from '../../../api/types';
import { SORT_OPTIONS } from '../../Inbox/filters/applyInboxFilters';
import {
  CANONICAL_DEFAULT_ORDER_STRING,
  orderedWorkSectionIds,
  type WorkSectionId,
} from '../../Inbox/sectionOrder';
import { Switch } from '../../controls/Switch';
import pane from './Pane.module.css';

const WORK_LABELS: Record<WorkSectionId, string> = {
  'review-requested': 'Review requested',
  'awaiting-author': 'Needs re-review',
  'authored-by-me': 'Authored by me',
  mentioned: 'Mentioned',
};
const RECENTLY_CLOSED_LABEL = 'Recently closed';
const HELP_ID = 'inbox-section-help';

function Chevron({ dir }: { dir: 'up' | 'down' }) {
  // Decorative — the button's aria-label carries the meaning.
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path
        d={dir === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InboxPane() {
  const { preferences, set } = usePreferences();
  const [pending, setPending] = useState(false);
  if (!preferences) return null;

  const sections = preferences.inbox.sections;
  const order = orderedWorkSectionIds(preferences.inbox.sectionOrder);
  const isDefaultOrder = order.join(',') === CANONICAL_DEFAULT_ORDER_STRING;

  // Clamp to a known option so a hand-edited / version-skewed inbox.defaultSort
  // doesn't leave the controlled <select> in an invalid/blank state.
  const defaultSort = SORT_OPTIONS.some((o) => o.key === preferences.inbox.defaultSort)
    ? preferences.inbox.defaultSort
    : 'updated';

  // Apply-on-success model (PreferencesContext.set is NOT optimistic): disable all
  // reorder controls while a move POST is pending so order-dependent moves serialize
  // and a rapid second click can't compute from a stale order (#275 spec, Unit 4).
  const writeOrder = (next: WorkSectionId[]) => {
    setPending(true);
    set('inbox.sectionOrder', next.join(','))
      .catch(() => {})
      .finally(() => setPending(false));
  };
  const move = (index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    writeOrder(next);
  };

  const renderSwitch = (id: keyof InboxSectionsPreferences, label: string) => (
    <Switch
      id={`inbox-section-${id}`}
      label={label}
      describedById={HELP_ID}
      checked={sections[id]}
      onChange={(next) => set(`inbox.sections.${id}` as PreferenceKey, next).catch(() => {})}
    />
  );

  return (
    <section aria-labelledby="inbox-heading">
      <div className={pane.head}>
        <div>
          <h2 id="inbox-heading" className={pane.title}>
            Inbox
          </h2>
          <p className={pane.sub}>Choose which inbox sections appear and in what order</p>
        </div>
      </div>
      <p id={HELP_ID} className={pane.help}>
        Changes apply on the next inbox refresh (within 2 minutes).
      </p>

      <div role="group" aria-label="Inbox section order">
        {order.map((id, index) => (
          <div key={id} className={pane.row}>
            <label className={pane.label} htmlFor={`inbox-section-${id}`}>
              {WORK_LABELS[id]}
            </label>
            <div className={pane.spring} />
            <div className={pane.moveGroup}>
              <button
                type="button"
                className={pane.moveBtn}
                aria-label={`Move ${WORK_LABELS[id]} up`}
                disabled={pending || index === 0}
                onClick={() => move(index, -1)}
              >
                <Chevron dir="up" />
              </button>
              <button
                type="button"
                className={pane.moveBtn}
                aria-label={`Move ${WORK_LABELS[id]} down`}
                disabled={pending || index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                <Chevron dir="down" />
              </button>
            </div>
            {renderSwitch(id, WORK_LABELS[id])}
          </div>
        ))}

        {/* recently-closed: pinned archive — on/off stays, no reorder controls. */}
        <div className={pane.row}>
          <label className={pane.label} htmlFor="inbox-section-recently-closed">
            {RECENTLY_CLOSED_LABEL}
          </label>
          <div className={pane.spring} />
          <span className={pane.pinnedTag}>Pinned</span>
          {renderSwitch('recently-closed', RECENTLY_CLOSED_LABEL)}
        </div>
      </div>

      <div className={pane.row}>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Restore default order"
          disabled={pending || isDefaultOrder}
          onClick={() => writeOrder([...orderedWorkSectionIds(CANONICAL_DEFAULT_ORDER_STRING)])}
        >
          Restore default order
        </button>
      </div>

      <div className={pane.row}>
        <label className={pane.label} htmlFor="inbox-default-sort">
          Default sort
        </label>
        <div className={pane.spring} />
        <select
          id="inbox-default-sort"
          value={defaultSort}
          onChange={(e) => set('inbox.defaultSort', e.target.value).catch(() => {})}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
```

> Note: the original pane wrapped the `<select>`/`<Switch>` in `<div className={pane.spring}>control</div>`. This rewrite uses `pane.spring` as an empty flex-spacer `<div>` and places controls after it, which keeps the existing right-alignment while letting a row hold multiple trailing controls (move buttons + switch). Verify against the rendered layout in Step 4's screenshot; if `pane.spring` is `flex: 1`, an empty spacer div is the correct idiom.

- [ ] **Step 4: Add CSS + run the tests**

Append to `frontend/src/components/Settings/panes/Pane.module.css`:

```css
/* #275 — inbox section reorder controls */
.moveGroup {
  display: inline-flex;
  gap: 2px;
  margin-right: var(--space-2, 8px);
}
.moveBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-1, var(--surface-3));
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--text-1);
  cursor: pointer;
}
.moveBtn:hover:not(:disabled) {
  background: var(--surface-2);
}
.moveBtn:disabled {
  opacity: 0.4;
  cursor: default;
}
.pinnedTag {
  margin-right: var(--space-2, 8px);
  font-size: var(--text-xs, 0.75rem);
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

> The CSS custom-property names above (`--surface-1`, `--text-2`, `--space-2`, `--text-xs`, `--border-1`) follow the repo's token scheme. Before writing, grep `frontend/src` for the actual token names in sibling `*.module.css` (e.g. `Pane.module.css`, `filters.module.css`) and substitute the real ones — do not invent tokens. Fallbacks are provided inline where a token may not exist.

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/InboxPane.test.tsx`
Expected: PASS (all reorder tests + the pre-existing switch/sort tests).

- [ ] **Step 5: Visual check + commit**

Launch the app and eyeball the pane (real PAT, dev port):
`pwsh ./run.ps1 -Port 5180 -Reset None --no-browser` → open `http://localhost:5180` → Settings → Inbox. Confirm: 4 work rows with up/down + switch, recently-closed pinned with "Pinned" tag + switch, restore-default disabled at canonical, reorder works and persists on reload.

```bash
git add frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Settings/panes/Pane.module.css frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#275): inbox section reorder UI in Settings"
```

---

## Task 8: e2e — reorder persists end-to-end

**Files:**
- Create: `frontend/e2e/inbox-section-order.spec.ts`

- [ ] **Step 1: Write the e2e test**

Read an existing functional e2e under `frontend/e2e/` (NOT the `parity-baselines.spec.ts` visual one — a functional spec that drives the app and asserts DOM, e.g. one that mocks `/api/inbox` + `/api/preferences`/auth state). Mirror its app-bootstrap + route-mock setup. Create `frontend/e2e/inbox-section-order.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
// Reuse the same fixture/route-mock harness the neighboring functional specs use
// (mock /api/auth/state as authed, /api/inbox with the 4 work sections + recently-closed,
//  /api/preferences GET returning canonical sectionOrder, POST echoing the patched value).

test('reordering a section in Settings reorders the inbox and persists', async ({ page }) => {
  // 1. Open Settings → Inbox, move "Review requested" down.
  await page.goto('/settings/inbox'); // match the app's actual Settings route
  await page.getByRole('button', { name: 'Move Review requested down' }).click();

  // 2. Assert the POST carried the swapped permutation.
  //    (Assert via the mock's recorded request body, or re-open and read the row order.)

  // 3. Navigate to the inbox; assert the section heading DOM order reflects the new order.
  await page.goto('/');
  const headings = page.getByTestId('inbox-section-header'); // match the real testid/selector
  await expect(headings.first()).not.toHaveText(/Review requested/);

  // 4. Reload; assert the order persists (preferences GET returns the patched value).
  await page.reload();
  await expect(headings.first()).not.toHaveText(/Review requested/);
});
```

> This is a functional (DOM-order) e2e, not a visual baseline — it does not add screenshot baselines (which are CI-linux-only and churn-prone). The selectors/route names above are placeholders to match against the actual neighboring spec; the assertions (POST permutation, inbox DOM order, persistence after reload) are the contract.

- [ ] **Step 2: Run the e2e**

Run (from `frontend/`): `node ./node_modules/@playwright/test/cli.js test e2e/inbox-section-order.spec.ts`
Expected: PASS. If the harness needs the app server, follow the neighboring spec's `webServer`/globalSetup convention.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/inbox-section-order.spec.ts
git commit -m "test(#275): e2e — section reorder persists across reload"
```

---

## Final verification (before opening the PR)

- [ ] **Backend:** `dotnet test PRism.sln` (or the solution test target) — all green.
- [ ] **Frontend unit:** from `frontend/`, `node ./node_modules/vitest/vitest.mjs run` — all green.
- [ ] **Typecheck:** from `frontend/`, `npm run build` (`tsc -b`) — clean (the real typecheck; `--noEmit` is vacuous here).
- [ ] **Lint/format:** from `frontend/`, `node ./node_modules/prettier/bin/prettier.cjs --check .` and `npm run lint` (bypass rtk if it masks output).
- [ ] **e2e:** the new spec passes; full e2e suite not regressed.
- [ ] **B1 visual proof:** capture Playwright screenshots of (a) Settings → Inbox showing the reorder controls and (b) the inbox in a reordered state, post to the PR per the house B1 convention (review-assets branch). This is a **gated** UI change — do not merge without owner visual sign-off.

---

## Spec-coverage self-review

- **Unit 1 (config model)** → Task 1. ✓
- **Unit 2 (allowlist + permutation validation, strict write)** → Task 2. ✓ (valid permutation; rejects incomplete/too-long/dup/unknown/empty/pinned-id/non-string).
- **Unit 3 (DTO + endpoint wire)** → Task 3. ✓ + Task 5 (frontend type + Exclude trap).
- **Unit 4 (InboxPane reorder UI)** → Task 7. ✓ (move buttons, boundary-disabled, in-flight disable, restore-default-disabled-when-default, pinned recently-closed, subtitle, aria, group).
- **Unit 5 (orderInboxSections pure sort + InboxPage wiring, lenient read)** → Task 4 (helper) + Task 6 (wiring). ✓ (full perm, unknown appended, stale ignored, recently-closed forced last, empty/undefined → canonical, filter subset).
- **SSOT for canonical id list** → Task 4 (`CANONICAL_WORK_ORDER` / `CANONICAL_DEFAULT_ORDER_STRING` imported everywhere). ✓
- **Apply-on-success / in-flight race fix** → Task 7 (`pending` disable) + tests. ✓
- **On/off independent of order; all four ids always persisted** → Task 4 (`orderedWorkSectionIds` always returns 4) + Task 7 (switches independent of move). ✓
- **Restore default** → Task 7. ✓
- **Acceptance criteria #1–#4** → Tasks 6/7 (reorder), 1–3 (persist), 4 (no drop), 7 (restore). ✓
- **Testing (backend/frontend/e2e)** → Tasks 1–8. ✓

No placeholders carrying TBD/TODO. Type/name consistency verified: `CANONICAL_WORK_ORDER`, `CANONICAL_DEFAULT_ORDER_STRING`, `orderInboxSections`, `orderedWorkSectionIds`, `WorkSectionId`, `InboxConfig.SectionOrder`, `inbox.sectionOrder`, `InboxPreferences.sectionOrder` are used identically across all tasks.
