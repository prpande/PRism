# Draft PR Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a GitHub draft PR (`state = open, draft = true`) unmistakable on both the inbox row and the PR-detail header, sourced from GitHub's `draft` flag end-to-end, with an info-blue visual treatment.

**Architecture:** The inbox plumbing already parses `draft` (#410); this slice (a) reads `isDraft` on the GraphQL PR-detail parser and carries it on the `Pr` record, (b) extracts the PR-state glyph constants out of `InboxRow` into a shared module that adds a `draft` entry, (c) completes the inbox chip's a11y/colour, (d) introduces a full state-glyph set + `Draft` marker on the PR-detail header, and (e) verifies (does not "fix") inbox draft visibility with a backend regression guard plus a real-flow sandbox fixture.

**Tech Stack:** .NET 10 (`PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web` test hooks), C# / xUnit / FluentAssertions; React + Vite + TypeScript, Vitest + Testing Library, Playwright (fake-backend visual baselines + real-flow specs).

## Global Constraints

- **Branch base:** `V2` (all work branches off and merges to `V2`).
- **Colour:** info-blue only — reuse the existing `--info` / `--info-soft` / `--info-fg` design tokens (defined in both light and dark in `frontend/src/styles/tokens.css`). Do **not** introduce a new token.
- **Term:** the PR-detail element is a **"marker"** (not "pill"/"badge") in code comments and copy.
- **Glyph constants are shared, not duplicated** between `InboxRow` and `PrHeader` (single module).
- **Load-time only:** the PR-detail marker/glyph reflects the loaded DTO. A draft↔ready toggle made on GitHub while the page is open does NOT live-update (`ActivePrUpdated` carries only `IsMerged`/`IsClosed`). This matches the pre-existing merged/closed live behaviour and is a documented follow-up.
- **`isDraft` is additive** — a boolean defaulting to `false`; no existing field changes, no wire-shape break.
- **Precedence:** merged/closed (`isDone`) always win over draft. A closed/merged draft renders as merged/closed, never draft.
- **No change** to inbox section queries, visibility, or GitHub review-requested semantics. Drafts never appear under `review-requested` (GitHub semantics, kept).

---

### Task 1: Backend — parse `isDraft` on the PR-detail GraphQL path and carry it on `Pr`

**Files:**
- Modify: `PRism.Core.Contracts/Pr.cs`
- Modify: `PRism.GitHub/GitHubPrParser.cs:106-159` (`ParsePr`)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs`

**Interfaces:**
- Consumes: nothing new. The GraphQL query at `GitHubReviewService.cs:42` **already selects `isDraft`** — only the parser read is missing.
- Produces: `Pr.IsDraft` (bool, default `false`), positioned in the record's optional-parameter block. `ParsePr` populates it null-safely (true / false / absent → false).

- [ ] **Step 1: Write the failing test**

Add to `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs` (above the closing `}`):

```csharp
    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    public async Task GetPrDetailAsync_parses_isDraft_from_graphql(string isDraftJson, bool expected)
    {
        var body = $$"""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "title": "x", "body": "", "url": "https://github.com/o/r/pull/1",
                "state": "OPEN", "isDraft": {{isDraftJson}},
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "headRefName": "h", "baseRefName": "main",
                "headRefOid": "h", "baseRefOid": "b",
                "author": { "login": "a" },
                "createdAt": "2026-01-01T00:00:00Z",
                "closedAt": null, "mergedAt": null, "changedFiles": 0,
                "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
              }
            }
          }
        }
        """;
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.IsDraft.Should().Be(expected);
    }

    [Fact]
    public async Task GetPrDetailAsync_defaults_isDraft_false_when_field_absent()
    {
        // No "isDraft" key in the payload at all → must default to false, not throw.
        var body = """
        {
          "data": {
            "repository": {
              "pullRequest": {
                "title": "x", "body": "", "url": "https://github.com/o/r/pull/1",
                "state": "OPEN",
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "headRefName": "h", "baseRefName": "main",
                "headRefOid": "h", "baseRefOid": "b",
                "author": { "login": "a" },
                "createdAt": "2026-01-01T00:00:00Z",
                "closedAt": null, "mergedAt": null, "changedFiles": 0,
                "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
              }
            }
          }
        }
        """;
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto!.Pr.IsDraft.Should().BeFalse();
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReviewServicePrDetailTests"`
Expected: FAIL — `Pr` has no `IsDraft` member → compile error (`'Pr' does not contain a definition for 'IsDraft'`).

- [ ] **Step 3: Add `IsDraft` to the `Pr` record**

In `PRism.Core.Contracts/Pr.cs`, add `IsDraft` to the optional-parameter tail (keeps existing positional construction working; the inbox path doesn't build `Pr`, so the default covers all other call sites):

```csharp
public sealed record Pr(
    PrReference Reference,
    string Title,
    string Body,
    string Author,
    string State,
    string HeadSha,
    string BaseSha,
    string HeadBranch,
    string BaseBranch,
    string Mergeability,
    string CiSummary,
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    string? HtmlUrl = null,
    bool IsDraft = false);
```

- [ ] **Step 4: Read `isDraft` in `ParsePr`**

In `PRism.GitHub/GitHubPrParser.cs`, inside `ParsePr` (before the `return new Pr(...)`), add the null-safe read (mirroring `GitHubSectionQueryRunner.cs:140-141`):

```csharp
        // Draft flag — additive (#501). The GraphQL query already selects isDraft;
        // read it null-safely (absent/null → false), mirroring the inbox path.
        var isDraft = pull.TryGetProperty("isDraft", out var dr)
            && dr.ValueKind == JsonValueKind.True;
```

Then pass it into the constructor by adding the named argument at the end of the `return new Pr(...)` argument list:

```csharp
            AvatarUrl: avatarUrl,
            HtmlUrl: HtmlUrl(),
            IsDraft: isDraft);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReviewServicePrDetailTests"`
Expected: PASS (all draft tests green; existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core.Contracts/Pr.cs PRism.GitHub/GitHubPrParser.cs tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs
git commit -m "feat(pr-detail): parse GitHub draft flag onto Pr.IsDraft (#501)"
```

---

### Task 2: Backend — inbox visibility regression guard (authored-by-me draft survives the pipeline)

**Files:**
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

**Interfaces:**
- Consumes: existing test helpers in that file — `RawDraft(int n)` (line 229, `RawPr(n,...) with { IsDraft = true }`), `RawOpen(int n)` (line 220), `FakeSectionQueryRunner` (line 66), `ConfigStoreFake`, `ConfigWithSections` (line 140), `Build(...)` (line 182), `CapturingEnricher` (line 232).
- Produces: a pinned guarantee that an authored draft lands in the `authored-by-me` snapshot section with `IsDraft = true` after enrichment + dedup + materialization. No production code changes — this is a guard so a future section-query / materialization / dedup edit can't silently start dropping authored drafts (§7).

- [ ] **Step 1: Write the failing test**

Add to `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (above the final closing `}` of the class):

```csharp
    [Fact]
    public async Task RefreshAsync_keeps_authored_draft_visible_in_authored_by_me_with_IsDraft_true()
    {
        // #501 visibility guard: an authored draft must survive enrichment + dedup +
        // materialization and remain in the authored-by-me section with IsDraft=true.
        // Drafts are excluded from AI enrichment INPUT only (RefreshAsync_excludes_...),
        // never from the snapshot the user sees.
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["authored-by-me"] = new[] { RawOpen(1), RawDraft(2) },
            });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: false, authoredByMe: true,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var authored = sut.Current!.Sections["authored-by-me"];
        authored.Select(i => i.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2 });
        authored.Single(i => i.Reference.Number == 2).IsDraft.Should().BeTrue();
        authored.Single(i => i.Reference.Number == 1).IsDraft.Should().BeFalse();
    }
```

- [ ] **Step 2: Run the test to verify it passes (guard confirms current behaviour)**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RefreshAsync_keeps_authored_draft_visible"`
Expected: PASS immediately — this is a *regression guard* on already-correct behaviour (§7: "verify, don't fix"). If it FAILS, stop: an authored draft is being dropped, which contradicts the spec's code analysis — open a follow-up with the exact repro before proceeding (spec §7 "conditional fix").

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "test(inbox): pin authored-draft visibility through the refresh pipeline (#501)"
```

---

### Task 3: Frontend — shared `prStateGlyph` module (extract + add `draft`)

**Files:**
- Create: `frontend/src/components/shared/prStateGlyph.ts`
- Create: `frontend/src/components/shared/prStateGlyph.test.ts`
- Modify: `frontend/src/components/Inbox/InboxRow.tsx:11-24` (remove the local glyph constants; import from the shared module)

**Interfaces:**
- Consumes: nothing.
- Produces (the public surface both `InboxRow` and `PrHeader` import):
  - `type GlyphState = 'open' | 'merged' | 'closed' | 'draft'`
  - `const PR_GLYPH_PATH: Record<GlyphState, string>`
  - `const PR_GLYPH_CLASS: Record<GlyphState, string>` → values `'prOpen' | 'prMerged' | 'prClosed' | 'prDraft'`
  - `const PR_GLYPH_LABEL: Record<GlyphState, string>` → `'PR open' | 'PR merged' | 'PR closed' | 'Draft PR'` (single source for both the SVG `<title>` tooltip and the aria state word, mirroring `CI_GLYPH_LABEL`)

  This task is a pure refactor for the open/merged/closed entries — `InboxRow`'s rendered output is unchanged. The `draft` entry is added here but not yet consumed (Tasks 4 + 5 wire it).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/shared/prStateGlyph.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL } from './prStateGlyph';

describe('prStateGlyph', () => {
  it('has a path, class, and label for every state including draft', () => {
    for (const state of ['open', 'merged', 'closed', 'draft'] as const) {
      expect(PR_GLYPH_PATH[state]).toMatch(/^M/); // non-empty SVG path data
      expect(PR_GLYPH_CLASS[state]).toBeTruthy();
      expect(PR_GLYPH_LABEL[state]).toBeTruthy();
    }
  });

  it('maps classes and labels to the expected values', () => {
    expect(PR_GLYPH_CLASS.draft).toBe('prDraft');
    expect(PR_GLYPH_LABEL.draft).toBe('Draft PR');
    expect(PR_GLYPH_LABEL.open).toBe('PR open');
    expect(PR_GLYPH_LABEL.merged).toBe('PR merged');
    expect(PR_GLYPH_LABEL.closed).toBe('PR closed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/shared/prStateGlyph.test.ts`
Expected: FAIL — `Cannot find module './prStateGlyph'`.

- [ ] **Step 3: Create the shared module**

Create `frontend/src/components/shared/prStateGlyph.ts`. Copy the open/merged/closed path data **verbatim** from `InboxRow.tsx:13-19` (do not retype the coordinates). The `draft` path is the Primer octicon `git-pull-request-draft-16` (verify against `@primer/octicons` if installed; the value below is that icon):

```ts
// Shared PR-state octicons (Primer v19, 16-viewBox). Extracted from InboxRow (#501)
// so InboxRow and PrHeader render the identical glyph set. The `draft` entry is new.
export type GlyphState = 'open' | 'merged' | 'closed' | 'draft';

export const PR_GLYPH_PATH: Record<GlyphState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged:
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
  closed:
    'M10.72 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.75.75 0 1 1 1.06 1.061l-.97.97.97.97a.75.75 0 1 1-1.06 1.06l-.97-.97-.97.97a.75.75 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Zm-9.22 2.02a2.25 2.25 0 1 1 3 2.123v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm10.5 7.503a2.25 2.25 0 1 1-1.5 0V8.755a.75.75 0 0 1 1.5 0ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  draft:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM12.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
};

export const PR_GLYPH_CLASS: Record<GlyphState, string> = {
  open: 'prOpen',
  merged: 'prMerged',
  closed: 'prClosed',
  draft: 'prDraft',
};

// Single source for both the SVG <title> tooltip and the aria state word (mirrors
// CI_GLYPH_LABEL). NOTE: the inbox aria-label uses a lowercased state token ("· draft")
// derived separately; this label is the human-readable tooltip/title text.
export const PR_GLYPH_LABEL: Record<GlyphState, string> = {
  open: 'PR open',
  merged: 'PR merged',
  closed: 'PR closed',
  draft: 'Draft PR',
};
```

- [ ] **Step 4: Refactor `InboxRow.tsx` to consume the shared module**

In `frontend/src/components/Inbox/InboxRow.tsx`:

1. Delete the local `type PrState = ...` (line 12) **only if** it's no longer referenced after this edit — it IS still used for the `prState` variable typing, so KEEP a local `PrState` alias. Delete only the `PR_GLYPH_PATH` (lines 13-19) and `PR_GLYPH_CLASS` (lines 20-24) const declarations.
2. Add the import near the other imports (after line 8):

```ts
import { PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL } from '../shared/prStateGlyph';
```

3. The existing render reads `PR_GLYPH_PATH[prState]` / `PR_GLYPH_CLASS[prState]` where `prState: PrState = 'open' | 'merged' | 'closed'`. Those keys are a subset of `GlyphState`, so they resolve unchanged. Update the `<title>` from the inline template `{`PR ${prState}`}` to the shared label so the tooltip is single-sourced:

```tsx
          <title>{PR_GLYPH_LABEL[prState]}</title>
```

(This changes the open/merged/closed tooltip text from `"PR open"`/`"PR merged"`/`"PR closed"` to the identical strings — no visible change.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/shared/prStateGlyph.test.ts src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (shared module green; InboxRow tests still green — pure refactor).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/shared/prStateGlyph.ts frontend/src/components/shared/prStateGlyph.test.ts frontend/src/components/Inbox/InboxRow.tsx
git commit -m "refactor(inbox): extract shared prStateGlyph module with draft entry (#501)"
```

---

### Task 4: Frontend — inbox draft completion (info colour + draft glyph + `· draft` aria)

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

**Interfaces:**
- Consumes: `PR_GLYPH_PATH`, `PR_GLYPH_CLASS`, `PR_GLYPH_LABEL`, `GlyphState` from Task 3; `pr.isDraft` (already on `PrInboxItem`).
- Produces: an open draft row that renders (a) the `draft` glyph (`data-pr-state="draft"`, class `prDraft`), (b) the info-coloured `.draftChip` (with an info-tinted hover), and (c) the aria-label `· draft` in the state slot.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/Inbox/InboxRow.test.tsx` (a new `describe` block; `PR` is the shared non-draft fixture at the top of the file):

```tsx
describe('InboxRow draft treatment (#501)', () => {
  it('renders the draft glyph and draft aria-label for an open draft row', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: true });
    // status glyph switches to the draft discriminant
    expect(container.querySelector('[data-pr-state="draft"]')).not.toBeNull();
    // aria-label carries "· draft" in the state slot (replacing "· open")
    const row = screen.getByRole('button', { name: /Add user pagination/i });
    expect(row.getAttribute('aria-label')).toContain('· draft ·');
    expect(row.getAttribute('aria-label')).not.toContain('· open ·');
  });

  it('renders the info draft chip for an open draft row', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: true });
    expect(container.querySelector(`.${'draftChip'}`) ?? screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('a merged draft renders as merged (precedence), not draft', () => {
    const { container } = renderInboxRow({
      ...PR,
      isDraft: true,
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(container.querySelector('[data-pr-state="draft"]')).toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('a non-draft open row is unchanged (open glyph, open aria, no Draft chip)', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: false });
    expect(container.querySelector('[data-pr-state="open"]')).not.toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
    const row = screen.getByRole('button', { name: /Add user pagination/i });
    expect(row.getAttribute('aria-label')).toContain('· open ·');
  });
});
```

Note: the `.draftChip` class is CSS-Module-hashed, so the test asserts on the visible `Draft` text rather than the raw class name for the chip.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — the draft-glyph test fails (status renders `data-pr-state="open"`, not `"draft"`) and the aria test fails (label says `· open ·`).

- [ ] **Step 3: Derive `glyphState` and the draft aria token in `InboxRow.tsx`**

In `frontend/src/components/Inbox/InboxRow.tsx`, after `const prState: PrState = doneState ?? 'open';` (line 81), add:

```tsx
  // #501 — display discriminant for the status glyph. Drafts only matter while open
  // (merged/closed win via precedence); the PrState type stays open/merged/closed.
  // Same shape as PrHeader's derivation (prState === 'open' ⟺ !isDone here) so the
  // two read identically across surfaces.
  const glyphState: GlyphState = pr.isDraft && prState === 'open' ? 'draft' : prState;
```

Update the import from Task 3 to also bring in the type:

```tsx
import { PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL, type GlyphState } from '../shared/prStateGlyph';
```

Replace the status-glyph `<svg>` block (lines 106-117) to key off `glyphState`:

```tsx
        <svg
          className={`${styles.prState} ${styles[PR_GLYPH_CLASS[glyphState]]}`}
          data-pr-state={glyphState}
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <title>{PR_GLYPH_LABEL[glyphState]}</title>
          <path d={PR_GLYPH_PATH[glyphState]} />
        </svg>
```

Update the `ariaLabel` open-branch (lines 91-95) so the state slot reads `draft` for an open draft. Replace that block with:

```tsx
  // For an open draft the state word becomes "draft" (occupies the slot "open" used);
  // unread / CI suffixes unchanged; AI provenance never applies to drafts.
  const openStateWord = pr.isDraft ? 'draft' : 'open';

  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}${aiSuffix}`
    : `${pr.title} · ${pr.repo} · ${openStateWord} · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}${aiSuffix}`;
```

(The chip render at lines 127-148 already gates on `pr.isDraft && !isDone` — no change needed there.)

- [ ] **Step 4: Recolour the draft chip + add the `prDraft` glyph colour in CSS**

In `frontend/src/components/Inbox/InboxRow.module.css`:

1. Add the `.prDraft` glyph colour next to `.prOpen`/`.prMerged`/`.prClosed` (after line 77):

```css
.prDraft {
  color: var(--info-fg);
}
```

2. Recolour `.draftChip` (lines 245-255) from neutral to info:

```css
.draftChip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background: var(--info-soft);
  color: var(--info-fg);
  border-radius: var(--radius-2);
  font-size: var(--text-2xs);
  font-weight: 500;
  white-space: nowrap;
}
```

3. Replace the neutral hover override (lines 296-301) with an info-tinted hover so the chip still reads as raised on a hovered row in both themes (the neutral `--row-hover-pill` would erase the info tint):

```css
/* #501 — keep the info draft chip reading as raised on a hovered row. --info-soft is a
   tinted surface (unlike the old neutral --surface-3), so it doesn't vanish into
   --row-hover; nudge it toward --info-fg instead of flipping to the neutral pill token. */
.row:hover .draftChip {
  background: color-mix(in oklch, var(--info-soft) 88%, var(--info-fg));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (all four draft-treatment tests green; existing InboxRow tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(inbox): info-blue draft chip + draft glyph + draft aria-label (#501)"
```

---

### Task 5: Frontend — PR-detail header full state-glyph set + `Draft` marker

**Files:**
- Modify: `frontend/src/api/types.ts:170-189` (`PrDetailPr`)
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx:396-433` (thread `isDraft`)
- Test: `frontend/src/components/PrDetail/PrHeader.test.tsx`

**Interfaces:**
- Consumes: `PR_GLYPH_PATH`, `PR_GLYPH_CLASS`, `PR_GLYPH_LABEL`, `GlyphState` from Task 3; `data.pr.isDraft` from the DTO; the global CSS classes `.chip` + `.chip-info` (already defined in `tokens.css:599,615`).
- Produces: `PrDetailPr.isDraft: boolean`; a new optional `isDraft?: boolean` prop on `PrHeader` (default `false`); a leading state glyph in the header breadcrumb for every state (open/merged/closed/draft); a `Draft` marker (`chip chip-info`) in the subtitle chip row when `prState === 'open' && isDraft`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/PrDetail/PrHeader.test.tsx` (new `describe` block; `renderHeader` is the helper at the top of the file):

```tsx
describe('PrHeader state glyph + draft marker (#501)', () => {
  it.each([
    ['open', false, 'open'],
    ['merged', false, 'merged'],
    ['closed', false, 'closed'],
    ['open', true, 'draft'],
  ] as const)(
    'renders the %s glyph (isDraft=%s) → data-pr-state=%s',
    (prState, isDraft, expected) => {
      const { container } = renderHeader({ loading: false, title: 't', prState, isDraft });
      expect(container.querySelector(`[data-pr-state="${expected}"]`)).not.toBeNull();
    },
  );

  it('shows the Draft marker for an open draft PR', () => {
    const { container } = renderHeader({ loading: false, title: 't', prState: 'open', isDraft: true });
    const marker = container.querySelector('.chip-info');
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent('Draft');
  });

  it('hides the Draft marker for a non-draft open PR', () => {
    const { container } = renderHeader({ loading: false, title: 't', prState: 'open', isDraft: false });
    expect(container.querySelector('.chip-info')).toBeNull();
  });

  it('a merged draft shows the merged glyph and no Draft marker (precedence)', () => {
    const { container } = renderHeader({ loading: false, title: 't', prState: 'merged', isDraft: true });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(container.querySelector('[data-pr-state="draft"]')).toBeNull();
    expect(container.querySelector('.chip-info')).toBeNull();
  });

  it('keeps the Draft marker as a chip-draft keeplist hook (survives collapse CSS)', () => {
    // The collapse rule hides every .prSubtitle child except the keeplist classes; the
    // marker must carry chip-draft so it isn't blanked in collapsed mode. (JSDOM doesn't
    // apply the stylesheet, so this pins the class contract that the CSS keeplist depends on
    // rather than computed visibility.)
    const { container } = renderHeader({ loading: false, title: 't', prState: 'open', isDraft: true });
    expect(container.querySelector('.chip-draft')).not.toBeNull();
    expect(container.querySelector('.chip-draft')).toHaveTextContent('Draft');
  });
});
```

Note: the collapse suppression itself is CSS-only (a `data-collapsed` attribute rule), so JSDOM unit tests assert the **class contract** the keeplist relies on; the actual collapsed-visibility is covered by the Playwright baseline in Task 7 (capture the draft header in its collapsed state, or confirm the marker renders in the collapsed shot).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: FAIL — no element with `data-pr-state` exists in the header yet; `.chip-info` not found.

- [ ] **Step 3: Add `isDraft` to `PrDetailPr`**

In `frontend/src/api/types.ts`, add to the `PrDetailPr` interface (after `isClosed: boolean;` at line 184):

```ts
  isDraft: boolean;
```

- [ ] **Step 4: Add the `isDraft` prop + glyph + marker to `PrHeader.tsx`**

In `frontend/src/components/PrDetail/PrHeader.tsx`:

1. Add the shared-module import (after the existing imports, near line 29):

```tsx
import { PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL, type GlyphState } from '../shared/prStateGlyph';
import glyphStyles from '../shared/prStateGlyph.module.css';
```

2. Add `isDraft` to the `PrHeaderProps` interface (after `prState?: PrState;` at line 117):

```tsx
  // #501 — GitHub draft flag (data.pr.isDraft). Drives the leading state glyph
  // (open→draft) and the info Draft marker. Load-time only; defaults false.
  isDraft?: boolean;
```

3. Add `isDraft = false,` to the destructured parameter list (after `prState = 'open',` at line 163).

4. Derive `glyphState` near the top of the component body (after the `useSubmit`/`useState` setup, e.g. after line 191):

```tsx
  // #501 — header status glyph discriminant (full set: open/merged/closed/draft).
  // isDone (merged/closed) wins over draft via the prState check.
  const glyphState: GlyphState = isDraft && prState === 'open' ? 'draft' : prState;
```

5. Render the leading glyph inside the breadcrumb row. Replace the breadcrumb `<div>` (lines 411-417) with:

```tsx
          <div className="row gap-2 muted-2 pr-meta-repo">
            <svg
              className={`${glyphStyles.prState} ${glyphStyles[PR_GLYPH_CLASS[glyphState]]}`}
              data-pr-state={glyphState}
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <title>{PR_GLYPH_LABEL[glyphState]}</title>
              <path d={PR_GLYPH_PATH[glyphState]} />
            </svg>
            <span>
              {reference.owner}/{reference.repo}
            </span>
            <span aria-hidden="true">·</span>
            <span>#{reference.number}</span>
          </div>
```

6. Render the `Draft` marker in the subtitle chip row. Immediately after the `iterationLabel` chip (line 481), add:

```tsx
            {/* #501 — info Draft marker. Open drafts only; merged/closed win via glyphState.
                A "marker", not a pill/badge. Load-time only (ActivePrUpdated carries no draft).
                The chip-draft class is a collapse-keeplist hook (see Step 4a) — chip-info
                supplies the visuals, chip-draft carries no style of its own. */}
            {prState === 'open' && isDraft && (
              <span className="chip chip-info chip-draft">Draft</span>
            )}
```

- [ ] **Step 4a: Keep the Draft marker visible when the header is collapsed**

The collapse CSS hides the breadcrumb glyph (`.pr-meta-repo` is hidden on collapse, `PrHeader.module.css:116`) AND every `.prSubtitle` child that isn't `.chip-ci` / `.chip-mergeability` (the implicit allowlist at `PrHeader.module.css:151`). Without this step, a collapsed draft header shows **zero** draft signal (no glyph, no marker) for both sighted and AT users — the same blank state a returning visitor sees by default (`usePrHeaderCollapsed` persists collapse). Add `chip-draft` to the keeplist so the marker survives collapse (the glyph staying hidden on collapse is fine — the surviving chip is the draft bearer, mirroring how merged/closed text status is also collapse-hidden). In `frontend/src/components/PrDetail/PrHeader.module.css`, change line 151 from:

```css
.prHeader[data-collapsed] .prSubtitle > :not(:global(.chip-ci)):not(:global(.chip-mergeability)) {
  display: none;
}
```

to:

```css
.prHeader[data-collapsed] .prSubtitle
  > :not(:global(.chip-ci)):not(:global(.chip-mergeability)):not(:global(.chip-draft)) {
  display: none;
}
```

Also extend the FOOTGUN keeplist comment above it (lines 148-150) to name `.chip-draft` alongside `.chip-ci` / `.chip-mergeability`.

- [ ] **Step 5: Add the glyph CSS module for the header**

Create `frontend/src/components/shared/prStateGlyph.module.css` (the glyph colours, reused by `PrHeader`; `InboxRow` keeps its own `.prState`/`.prOpen`/… in its module, so this file serves the header):

```css
/* Shared PR-state glyph colours for PrHeader (#501). InboxRow defines its own copies
   in InboxRow.module.css; this module exists so the header doesn't import the inbox
   row's stylesheet. Colours match the established semantics. */
.prState {
  display: block;
  width: 14px;
  height: 14px;
  flex: none;
}
.prOpen {
  color: var(--success-fg);
}
.prMerged {
  color: var(--merged-fg);
}
.prClosed {
  color: var(--danger-fg);
}
.prDraft {
  color: var(--info-fg);
}
```

- [ ] **Step 6: Thread `isDraft` from `PrDetailView` into `PrHeader`**

In `frontend/src/components/PrDetail/PrDetailView.tsx`, in the `<PrHeader .../>` element (after `prState={...}` at line 423), add:

```tsx
        isDraft={data?.pr.isDraft ?? false}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: PASS (all new state-glyph + marker tests green; existing PrHeader tests unaffected — the breadcrumb text spans are unchanged, only a leading glyph was added).

- [ ] **Step 8: Fix the shared `makePr` factory, then typecheck-sweep the remaining fixtures**

Adding a required `isDraft` field to `PrDetailPr` breaks every test fixture that builds a `PrDetailPr`. There is a **shared factory** that most consumers go through — fix it first (DRY), then let the typechecker surface the hand-rolled literals.

1. In `frontend/__tests__/helpers/prDetail.ts`, add `isDraft: false,` to the `makePr()` default object (next to `isMerged: false,` / `isClosed: false,` at lines 25-26). This covers every `makePr()` / `makePrDetailDto()` consumer in one edit.

2. Then run the typecheck to find the remaining inline `pr: { ... }` literals that don't use the factory:

Run: `cd frontend && node_modules/.bin/tsc -b` (use `tsc -b`, NOT `tsc --noEmit` alone — with project references the latter is vacuous)
Expected: errors at the inline `pr:` literals. This list is **illustrative, not exhaustive — `tsc` is authoritative**; sweep every error it reports. Known offenders at time of writing: `PrDetailView.test.tsx`, `PrDetailView.fileFocus.test.tsx`, `PrDetailView.freshness.test.tsx`, `PrDetailView.transition.test.tsx`, `PrDetailView.clearPr.test.tsx`, `PrTabHost.test.tsx`, `usePrDetail.test.tsx`, `usePrDetail.preservation.test.tsx`, `FilesTab.viewPreservation.test.tsx`, `FilesTab.deepLink.test.tsx`, `useFirstActivePrPollComplete.test.tsx`, `MarkAllReadButton.test.tsx`. Add `isDraft: false,` next to the `isMerged`/`isClosed` lines in each. Re-run `tsc -b` until clean.

- [ ] **Step 9: Run the affected frontend tests**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrHeader.test.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/shared/prStateGlyph.module.css frontend/src/components/PrDetail/*.test.tsx
git commit -m "feat(pr-detail): full header state-glyph set + info Draft marker (#501)"
```

---

### Task 6: Sandbox draft fixture (real-flow provisioning)

**Files:**
- Modify: `frontend/e2e/real/helpers/sandbox-fixture.ts:5` (`SandboxFixture.name` union)
- Modify: `frontend/scripts/setup-real-e2e-fixtures.ts`

**Interfaces:**
- Consumes: the existing `ensureBranchAtSeed` / `ensurePr` / `gh` helpers.
- Produces: a long-lived **draft** PR on `prpande/prism-sandbox` (branch `e2e-real-draft-fixture-<login>`), recorded in `fixtures.json` with `name: 'draft'`. Idempotent (re-run = no-op), local-dev / pre-release only (mirrors the existing four; not wired into CI).

- [ ] **Step 1: Extend the `SandboxFixture` union**

In `frontend/e2e/real/helpers/sandbox-fixture.ts`, change line 5 to add `'draft'` and update the comment on line 2:

```ts
// One entry per fixture name (happy / foreign / lost-response / stale-oid / draft).
export interface SandboxFixture {
  name: 'happy' | 'foreign' | 'lost-response' | 'stale-oid' | 'draft';
```

- [ ] **Step 2: Add `'draft'` to `FIXTURE_NAMES` and a draft-aware `ensurePr`**

In `frontend/scripts/setup-real-e2e-fixtures.ts`:

1. Add `'draft'` to the `FIXTURE_NAMES` array (line 10):

```ts
const FIXTURE_NAMES = ['happy', 'foreign', 'lost-response', 'stale-oid', 'draft'] as const;
```

2. Replace `ensurePr` (lines 97-122) so the `draft` fixture is created with `draft: true`. The REST `POST /pulls` `draft` field must be a real JSON boolean, so use a `--input` JSON body via stdin rather than `-f draft=true` (which sends the string `"true"`):

```ts
function ensurePr(
  branch: string,
  name: string,
  login: string,
  asDraft: boolean,
): { number: number; nodeId: string } {
  // List PRs targeting master from this branch (open OR draft — drafts are still "open").
  const list = gh<Array<{ number: number; node_id: string }>>([
    'api',
    `repos/${OWNER}/${REPO}/pulls?head=${OWNER}:${branch}&state=open`,
  ]);
  if (list.length > 0) {
    return { number: list[0].number, nodeId: list[0].node_id };
  }
  // Create. draft must be a JSON boolean, so POST a JSON body via --input - (stdin),
  // not -f draft=true (which would send the string "true").
  const bodyJson = JSON.stringify({
    title: `[e2e fixture, ${login}] ${name}`,
    head: branch,
    base: 'master',
    body: 'Generated by setup-real-e2e-fixtures.ts. Safe to delete if no longer needed.',
    draft: asDraft,
  });
  const out = execFileSync('gh', ['api', '-X', 'POST', `repos/${OWNER}/${REPO}/pulls`, '--input', '-'], {
    input: bodyJson,
    encoding: 'utf8',
  });
  const created = JSON.parse(out) as { number: number; node_id: string };
  return { number: created.number, nodeId: created.node_id };
}
```

3. Update the `main()` call site (line 133) to pass the draft flag:

```ts
    const pr = ensurePr(branch, name, login, name === 'draft');
```

4. **Add the CI guard the spec requires** (§7: "Guard creation so an inadvertent CI run of the helper cannot create a live PR on the sandbox"). The current script calls `main()` unconditionally and CI does not invoke it today — but the spec mandates the guard before this slice adds a draft-PR-creating path. Add at the very top of `main()`, before any `gh` call:

```ts
  if (process.env.CI) {
    console.error(
      '[setup-real-e2e-fixtures] Refusing to run in CI: this script creates live ' +
        'GitHub PRs on prpande/prism-sandbox and must only be run locally.',
    );
    process.exit(1);
  }
```

- [ ] **Step 3: Verify the script typechecks**

Run: `cd frontend && node_modules/.bin/tsc -b --noEmit`
Expected: clean (no new type errors). Do NOT run the script itself here — it mutates the live sandbox and requires `gh` auth; provisioning happens in the manual verification step of Task 7.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/real/helpers/sandbox-fixture.ts frontend/scripts/setup-real-e2e-fixtures.ts
git commit -m "test(e2e-real): add draft sandbox fixture provisioning (#501)"
```

---

### Task 7: Visual baselines + draft-aware fake backend + manual verification

**Files:**
- Modify: `PRism.Web/TestHooks/FakeReviewBackingStore.cs`
- Modify: `PRism.Web/TestHooks/FakePrReader.cs:39-56`
- Modify: `PRism.Web/TestHooks/FakeSectionQueryRunner.cs:33-45`
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs`
- Create/Modify: a Playwright visual spec that seeds a draft and captures the inbox row + PR-detail header
- Regenerate: affected `__screenshots__` baselines (both platforms)

**Interfaces:**
- Consumes: the `Pr.IsDraft` field (Task 1), the inbox draft render (Task 4), the header glyph/marker (Task 5).
- Produces: a deterministic draft scenario the fake backend can emit (`/test/set-draft`), so a draft inbox row and a draft PR-detail header appear in regenerated baselines. **Note:** the full-header-glyph decision rebaselines **all** PR-detail header screenshots (open/merged/closed gain a leading glyph), not only the draft shot.

- [ ] **Step 1: Add a draft flag + mutator to `FakeReviewBackingStore`**

In `PRism.Web/TestHooks/FakeReviewBackingStore.cs`:

1. Add an auto-property near `PrState` (after line 57):

```csharp
    public bool IsDraftPr { get; private set; }
```

2. Reset it in `Reset()` (in the locked block around line 104, next to `PrState = "OPEN";`):

```csharp
            IsDraftPr = false;
```

3. Add a mutator next to `SetPrState` (after line 208):

```csharp
    // #501 e2e-only. Flags the scenario PR as a draft so FakePrReader / FakeSectionQueryRunner
    // emit IsDraft=true, driving the header glyph+marker and the inbox draft chip in baselines.
    public void SetDraft(bool isDraft)
    {
        lock (Gate) IsDraftPr = isDraft;
    }
```

- [ ] **Step 2: Emit the draft flag from both fakes**

In `PRism.Web/TestHooks/FakePrReader.cs`, add `IsDraft: _store.IsDraftPr,` to the `new Pr(...)` constructor (inside the `lock`, after `IsClosed: _store.IsClosed,` at line 52):

```csharp
                IsMerged: _store.IsMerged,
                IsClosed: _store.IsClosed,
                IsDraft: _store.IsDraftPr,
```

In `PRism.Web/TestHooks/FakeSectionQueryRunner.cs`, add `IsDraft: _store.IsDraftPr,` to the seeded `new RawPrInboxItem(...)` (inside the `lock`, after `IterationNumberApprox: _store.Iterations.Count` at line 44 — add a trailing comma to that line):

```csharp
                        HeadSha: _store.CurrentHeadSha,
                        IterationNumberApprox: _store.Iterations.Count,
                        IsDraft: _store.IsDraftPr);
```

- [ ] **Step 3: Add the `/test/set-draft` endpoint**

In `PRism.Web/TestHooks/TestEndpoints.cs`:

1. Add a request record next to `SetPrStateRequest` (after line 44):

```csharp
    internal sealed record SetDraftRequest(bool IsDraft);
```

2. Add the endpoint next to `/test/set-pr-state` (after the `/test/set-pr-state` block ending near line 367):

```csharp
        app.MapPost("/test/set-draft", (SetDraftRequest req, IServiceProvider sp) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/set-draft");
            store.SetDraft(req.IsDraft);
            return Results.NoContent();
        });
```

(Match the exact return/`StoreMissing` shape used by the neighbouring `/test/set-pr-state` handler — read lines 347-368 and mirror them. The endpoint must be added INSIDE `MapTestEndpoints`, after the `if (!env.IsEnvironment("Test")) return app;` guard, so it is absent in production like every other `/test/*` route.)

- [ ] **Step 3a: Extend the production-guard test to cover `/test/set-draft`**

`tests/PRism.Web.Tests/TestHooks/TestEndpointsRegistrationTests.cs` currently probes only one route (`/test/advance-head`) to verify `/test/*` is absent in Production. Add a probe for the new route so the guard contract is pinned for it too. Convert the existing single-route assertion to a `[Theory]` (or add a second probe) so both routes are checked under the Production environment:

```csharp
    [Theory]
    [InlineData("/test/advance-head")]
    [InlineData("/test/set-draft")]
    public async Task TestEndpoints_NotLiveInProduction(string route)
    {
        // ... existing Production-host setup ...
        var resp = await client.PostAsJsonAsync(route, new { });
        // ... existing assertion that the route is NOT a live test endpoint
        //     (404 / not-registered), per the current test's expectation ...
    }
```

Read the existing test body and preserve its exact setup + assertion; only parameterize the route. Expected after the change: PASS for both routes (the shared `if (!env.IsEnvironment("Test")) return app;` early-return blocks both).

- [ ] **Step 4: Build the backend to confirm the test hooks compile**

Run: `dotnet build PRism.Web`
Expected: build succeeds.

- [ ] **Step 5: Add the Playwright visual spec**

Locate the existing fake-backend visual specs (the ones that call `/test/seed-inbox` and capture inbox / pr-detail screenshots — search `frontend/e2e` for `seed-inbox` and `toHaveScreenshot`). Add a draft scenario that, after seeding the inbox and before capturing, POSTs `/test/set-draft` `{ "isDraft": true }`, then:
- navigates to the inbox and captures the draft row,
- opens the scenario PR and captures the draft header.

Follow the established pattern in the neighbouring specs exactly (same fixtures, same `toHaveScreenshot` naming convention, same viewport). Example shape (adapt to the repo's actual helper names):

```ts
test('draft PR shows info marker on inbox row and header', async ({ page, request }) => {
  await request.post('/test/seed-inbox');
  await request.post('/test/set-draft', { data: { isDraft: true } });

  await page.goto('/');
  await expect(page.getByRole('button', { name: /· draft ·/ })).toHaveScreenshot('inbox-draft-row.png');

  await page.getByRole('button', { name: /· draft ·/ }).click();
  await expect(page.getByTestId('pr-header')).toHaveScreenshot('pr-detail-draft-header.png');
});
```

- [ ] **Step 6: Generate the new baseline locally (win32) + verify the run is otherwise green**

Run the fake-backend Playwright suite with snapshot update for the affected specs (use the repo's configured command — e.g. `node_modules/.bin/playwright test <draft-spec> --update-snapshots`). This writes the win32 baselines for the new draft shots AND re-writes the existing PR-detail header baselines (open/merged/closed now carry the leading glyph — expected per the full-set decision).

Run: `cd frontend && node_modules/.bin/playwright test --update-snapshots` (scoped to the affected specs)
Expected: PASS; new `inbox-draft-row.png` + `pr-detail-draft-header.png` written under `__screenshots__/win32`; existing PR-detail header baselines updated. Inspect the diffs to confirm only the intended glyph/marker changes appear.

**Scope warning:** the full-header-glyph decision changes EVERY PR-detail header shot, not just the draft one. The `--update-snapshots` scope MUST include every spec that captures a PR-detail header in open/merged/closed state — not only the new draft spec. If you scope it to the draft spec alone, the open/merged/closed header baselines go stale and the next unscoped CI run fails. Grep the e2e specs for `pr-header` / `toHaveScreenshot` header captures and include all of them in the regeneration run.

- [ ] **Step 7: Obtain the linux baselines from CI**

Push the branch; the CI Playwright job renders linux. Per the established baseline-regeneration process (memory: delete the linux baseline so CI writes the exact render and goes red, then download the `e2e-results` / `test-results` artifact's `__screenshots__/linux/*.png` and commit them — do NOT use the `/zip` redirect). Commit the linux PNGs alongside the win32 ones so both platforms are pinned.

- [ ] **Step 8: Manual real-flow verification (record in PR `## Proof`)**

Provision the sandbox draft fixture and verify the authored draft appears under `authored-by-me`:

```bash
cd frontend && node --import tsx scripts/setup-real-e2e-fixtures.ts
```

(Requires `gh` auth; mirrors the existing real-flow setup. Use the repo's actual tsx/ts-node invocation.) Then, with the app pointed at the sandbox, confirm:
- the authored draft PR appears in the inbox under **`authored-by-me`** with the info `Draft` chip + draft glyph + `· draft` accessible name;
- opening it shows the draft header glyph + `Draft` marker;
- collapse the PR-detail header (the collapse toggle) and confirm the `Draft` marker stays visible (validates Step 4a);
- **contrast:** verify the info `Draft` chip text (`--info-fg` on `--info-soft`) and its hover blend (`color-mix(... --info-soft 88%, --info-fg)`) meet WCAG AA (≥4.5:1 for the `--text-2xs` chip text) in **both** themes. `getComputedStyle().color` returns authored oklch, not rgb, so measure the rendered px values via a 1px canvas rather than eyeballing the tokens.

Record the outcome (and a screenshot) in the PR's `## Proof` section (spec §7). If the authored draft is genuinely missing despite Task 2's guard passing, STOP and open a follow-up with the exact repro (spec §7 "conditional fix") rather than altering section queries here.

- [ ] **Step 9: Commit**

```bash
git add PRism.Web/TestHooks/ frontend/e2e
git add frontend/**/__screenshots__/**
git commit -m "test(e2e): draft-aware fake backend + draft visual baselines (#501)"
```

---

## Self-Review

**1. Spec coverage:**
- §3 (backend GraphQL parse + `Pr.IsDraft`, REST untouched) → Task 1.
- §4 (`PrDetailPr.isDraft`) → Task 5 Step 3.
- §5.1 (shared glyph module + `draft` entry) → Task 3.
- §5.2 (chip recolour + info hover) → Task 4 Step 4.
- §5.3 (`glyphState` derivation, `PrState` type unchanged) → Task 4 Step 3.
- §5.4 (full aria-label `· draft`) → Task 4 Step 3.
- §5.5 (narrow-width glyph-only) → no code change (existing `@container` rule already hides `.chipWrap`; the glyph remains). Confirmed in `InboxRow.module.css:316-332`; called out here so it isn't mistaken for a gap.
- §5 precedence (merged/closed win) → Task 4 (`!isDone` guard) + Task 5 (`prState === 'open'` guard); tested in both.
- §6 (full header glyph set + Draft marker + load-time-only) → Task 5; collapsed-header draft visibility (the `chip-draft` keeplist hook) → Task 5 Step 4a + its collapse test.
- §7 (verify-not-fix + regression guard) → Task 2 (guard) + Task 7 Step 8 (manual verify).
- §7 sandbox fixture (union + FIXTURE_NAMES + draft:true) → Task 6, incl. the spec-mandated CI guard (Task 6 Step 2 item 4). The new `/test/set-draft` endpoint's production-absence is pinned by Task 7 Step 3a.
- §8 unit tests (InboxRow, PrHeader, parser, visibility guard) → Tasks 1, 2, 4, 5; visual baselines → Task 7.
- §10 decisions (full glyph set, info colour, shared glyph) → realized across Tasks 3, 5.
- §11 acceptance → satisfied by Tasks 1–7 collectively.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The two spots that defer to the repo's existing conventions (Task 7 Step 5 Playwright spec wiring; Task 7 Step 7 linux-baseline retrieval) point at concrete, named existing patterns rather than leaving the work undefined — the screenshot mechanics are repo-established process, not inventable code.

**3. Type consistency:** `GlyphState` ('open'|'merged'|'closed'|'draft'), `PR_GLYPH_PATH`/`PR_GLYPH_CLASS`/`PR_GLYPH_LABEL` are defined once in Task 3 and consumed identically in Tasks 4 + 5. `glyphState` is the variable name in both `InboxRow` and `PrHeader`. `isDraft` is the consistent field/prop name across `Pr` (C#), `PrDetailPr` (TS), `PrHeader` prop, and `IsDraftPr` (the fake store's mutable flag — distinct name on purpose, since it's mutable test state, not the DTO field). `SetDraft` / `/test/set-draft` / `SetDraftRequest` are consistent.
