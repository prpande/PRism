# PR9b-ai-gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the four origin § 6.4 AI surfaces (AiSummaryCard verdict, FileTree focus dot, AiHunkAnnotation rewrite, StaleDraftRow AI suggestion) against existing backend seams + hoist the `capabilities[key] && aiPreview` policy into a single `useAiGate` hook across 9 call sites + align `PlaceholderData.cs` with the canned PR fixture so cohort demos are visually demonstrable.

**Architecture:** Three new HTTP endpoints (`/ai/file-focus`, `/ai/hunk-annotations`, `/ai/draft-suggestions`) clone `/ai/summary`'s seam-resolve-and-map pattern; three new frontend hooks clone `useAiSummary`'s shape; `useAiGate(key)` centralizes the gating expression; surface JSX wires the data into FileTree / DiffPane / StaleDraftRow row layouts per handoff shapes. The migration is forward-compat scaffolding for backend capability decoupling (D112) — today every `useAiGate(key)` returns the same value as `aiPreview` because `CapabilitiesEndpoints.cs:13` derives `AllOn` xor `AllOff` from `AiPreviewState.IsOn`.

**Tech Stack:** .NET 10 minimal-API endpoints + xUnit + FluentAssertions for backend; React 19.2.5 + Vite + TypeScript + CSS modules for frontend; vitest + jsdom + `@testing-library/react` + `userEvent.setup()` for unit; Playwright (`prod` project) for e2e.

**Spec:** `docs/specs/2026-05-31-design-parity-pr9b-ai-gating-design.md`
**Sidecar:** `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` (D106 + D108-D112 + D107-superseded land on merge).

---

## File structure

**Backend (6 files — 2 modify + 3 endpoint tests + 1 endpoints file modify; sidecar at Task 21 is separate):**
- MODIFY `PRism.AI.Placeholder/PlaceholderData.cs` — align with `src/Calc.cs`
- MODIFY `PRism.AI.Placeholder/PlaceholderDraftSuggester.cs` — delegate to `PlaceholderData.DraftSuggestions`
- MODIFY `PRism.Web/Endpoints/AiEndpoints.cs` — add 3 `MapGet` calls with inline `// D111` comments
- CREATE `tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs` — 200/204/401
- CREATE `tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs` — 200/204/401
- CREATE `tests/PRism.Web.Tests/Endpoints/AiDraftSuggestionsEndpointTests.cs` — 200/204/401 + cross-file-anchor pin

**Frontend types + API clients (4 files):**
- MODIFY `frontend/src/api/types.ts` — append `FocusLevel`, `FileFocus`, widen `AnnotationTone`, `HunkAnnotation`, `DraftSuggestion`
- CREATE `frontend/src/api/aiFileFocus.ts`
- CREATE `frontend/src/api/aiHunkAnnotations.ts`
- CREATE `frontend/src/api/aiDraftSuggestions.ts`

**Frontend hooks (4 files):**
- CREATE `frontend/src/hooks/useAiGate.ts`
- CREATE `frontend/src/hooks/useAiFileFocus.ts`
- CREATE `frontend/src/hooks/useAiHunkAnnotations.ts`
- CREATE `frontend/src/hooks/useAiDraftSuggestions.ts`

**Frontend component modifications (12 files):**
- MODIFY `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` — `useAiGate('summary')`
- MODIFY `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css` — D110 comment rewrite
- MODIFY `frontend/src/components/PrDetail/PrHeader.tsx` — `useAiGate('preSubmitValidators')` + drop `aiPreview` prop pass to AskAiButton
- MODIFY `frontend/src/components/Ai/AiComposerAssistant.tsx` — `useAiGate('composerAssist')`
- MODIFY `frontend/src/components/PrDetail/AskAiButton.tsx` — `useAiGate('composerAssist')`, drop `aiPreview` prop
- MODIFY `frontend/src/pages/InboxPage.tsx` — 2-site migration
- MODIFY `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — wire `useAiFileFocus`
- MODIFY `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` — add `focusEntries` + `aiPreview` props + dot rendering
- MODIFY `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` — rename + add CSS rules
- MODIFY `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` — wire `useAiHunkAnnotations` + counter walk
- MODIFY `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` — replace no-op stub
- MODIFY `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css` — replace stub
- MODIFY `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx` — wire `useAiDraftSuggestions`
- MODIFY `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx` — add `aiSuggestion` prop + JSX
- MODIFY `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.module.css` — add `.staleAi` rules

**Frontend styles:**
- MODIFY `frontend/src/styles/tokens.css` — add `.ai-summary-label` global (first production consumer is `StaleDraftRow` in this PR)

**Frontend tests (6 new + 3 extended):**
- CREATE `frontend/__tests__/useAiGate.test.tsx`
- CREATE `frontend/__tests__/useAiFileFocus.test.tsx`
- CREATE `frontend/__tests__/useAiHunkAnnotations.test.tsx`
- CREATE `frontend/__tests__/useAiDraftSuggestions.test.tsx`
- CREATE `frontend/__tests__/AiHunkAnnotation.test.tsx`
- CREATE `frontend/__tests__/AskAiButton.test.tsx`
- MODIFY `frontend/__tests__/FileTree.test.tsx` — extend
- MODIFY `frontend/__tests__/UnresolvedPanel.test.tsx` — extend (if exists; verify and create if absent)
- MODIFY `frontend/__tests__/InboxPage.test.tsx` — extend (if exists; verify and create if absent)
- Migration sweep: ~4 existing specs that mock `useCapabilities`+`usePreferences` solely for the gate — list emerges at Task 11

**Playwright (1 new):**
- CREATE `frontend/e2e/ai-gating-sweep.spec.ts`

**Documentation (1 file):**
- MODIFY `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` — append `## PR9b-ai-gating — Selective wirings` section with D106 + D108-D112 + D107-superseded note

**Parity baselines (3 re-captures):**
- `frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png`
- `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png`
- `frontend/e2e/__screenshots__/win32/pr-detail-reconciliation-panel.png`

---

## Phase 1: Backend (Tasks 1-4)

### Task 1: Align PlaceholderData + PlaceholderDraftSuggester with canned PR fixture (§ 4.7)

**Files:**
- Modify: `PRism.AI.Placeholder/PlaceholderData.cs`
- Modify: `PRism.AI.Placeholder/PlaceholderDraftSuggester.cs` (currently hardcodes a literal — must delegate to `PlaceholderData.DraftSuggestions`)

The current placeholder targets fictional `services/leases/…` paths from S3-era spec text. The canned `FakePrReader` PR (registered as `PRism.Web/TestHooks/FakeReviewBackingStore.cs` — TEST hook, registered under test-env service replacement; backs e2e + dev-mode flows) serves only `src/Calc.cs` with a single hunk. After this task, the placeholder seam produces visually demonstrable surfaces against the canned fixture when running locally or via Playwright.

**Note on cohort-demo scope:** The placeholder alignment makes the new AI surfaces visible when the app runs against the canned `FakeReviewBackingStore` fixture (local dev mode + Playwright). Against real GitHub PRs (production cohort flow), the seam would receive whatever paths the actual PR contains — the `services/leases/...` paths are equally irrelevant there. The § 4.7 alignment is for canned-data demonstrability, not production correctness; both flows benefit.

- [ ] **Step 1.1: Read the canned PR's stale-draft anchor**

Run: `grep -n "DraftCommentDto\|filePath\|lineNumber\|StaleComment\|Stale" PRism.Web/TestHooks/FakeReviewBackingStore.cs | head -20`

Expected: locate the stale-comment fixture's `filePath` and `lineNumber` values. The `DraftSuggestion` anchor must match exactly so the suggestion renders on the stale-draft row. **Note the exact `lineNumber` value** — Step 1.2 needs it.

- [ ] **Step 1.2: Rewrite PlaceholderData.cs body to target src/Calc.cs**

```csharp
using PRism.AI.Contracts.Dtos;

namespace PRism.AI.Placeholder;

internal static class PlaceholderData
{
    public const string SummaryBody =
        "Refactors the Calc utilities to consolidate validation logic, simplifies error mapping, " +
        "and tightens partial-failure semantics. Behavior is preserved; tests added for the new " +
        "boundary cases.";

    public const string SummaryCategory = "Refactor";

    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("src/Calc.cs", FocusLevel.High),
        // Single-file canned PR — only one entry. When FakePrReader grows to
        // multiple files in a future slice, add a Medium entry for the second.
    };

    public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
    {
        new HunkAnnotation("src/Calc.cs", 0, "Reads cleaner — same behavior.", AnnotationTone.Calm),
        // Hunk index 0 is the single hunk in the canned PR. Adding a second
        // entry (HeadsUp at index 1) is deferred until FakePrReader emits a
        // multi-hunk diff — see PR9b-ai-gating § 9 follow-on.
    };

    public static IReadOnlyList<DraftSuggestion> DraftSuggestions { get; } = new[]
    {
        // Anchor at the stale-draft fixture's (filePath, lineNumber) from
        // FakeReviewBackingStore so the suggestion renders on the existing
        // stale-draft row. REPLACE STALE_DRAFT_LINE_FROM_STEP_1_1 with the
        // integer found at Step 1.1 — compile WILL fail until replaced
        // (intentional — prevents silent commit-with-wrong-anchor).
        new DraftSuggestion("src/Calc.cs", STALE_DRAFT_LINE_FROM_STEP_1_1,
            "Worth a comment on the validation here?"),
    };

    public static ValidatorReport Validator { get; } = new(new ValidatorFinding[]
    {
        new("info", "Verdict matches comment severity"),
        new("info", "No drafts left in stale state"),
        new("warn", "Heads-up about partial-failure tests."),
    });
}
```

**Important:** Replace `STALE_DRAFT_LINE_FROM_STEP_1_1` with the actual integer (e.g., `42`) from Step 1.1's grep output. The deliberately unbound identifier makes the file fail compilation until replaced — Step 1.3's `dotnet build` is the gate that surfaces a forgotten replacement.

- [ ] **Step 1.3: Update `PlaceholderDraftSuggester.cs` to delegate to `PlaceholderData`**

Currently `PlaceholderDraftSuggester.cs:9-13` returns a hardcoded literal (`new DraftSuggestion("services/leases/LeaseRenewalProcessor.cs", 142, "Worth a comment on the retry budget here?")`). This bypasses `PlaceholderData.DraftSuggestions` entirely — without this step, Step 1.2's PlaceholderData edit is dead code and the endpoint would still emit the wrong path.

Replace the entire body of `PRism.AI.Placeholder/PlaceholderDraftSuggester.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.DraftSuggestions);
}
```

Pattern mirrors `PlaceholderFileFocusRanker.cs:9-10` and `PlaceholderHunkAnnotator.cs:9-10`.

- [ ] **Step 1.4: Build to confirm no compile errors**

Run: `dotnet build PRism.AI.Placeholder/PRism.AI.Placeholder.csproj --configuration Release`
Expected: `Build succeeded` with 0 errors. If you see `The name 'STALE_DRAFT_LINE_FROM_STEP_1_1' does not exist in the current context` — go back to Step 1.2 and replace the sentinel with the value from Step 1.1.

- [ ] **Step 1.5: Run the existing AI seam tests**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --no-build --configuration Release --filter "FullyQualifiedName~PRism.Core.Tests.Ai" -v minimal`
Expected: all existing AI tests pass. They assert on the seam-selector wiring + summary content; the path changes don't affect them.

- [ ] **Step 1.6: Commit**

```bash
git add PRism.AI.Placeholder/PlaceholderData.cs PRism.AI.Placeholder/PlaceholderDraftSuggester.cs
git commit -m "feat(ai): align PlaceholderData + PlaceholderDraftSuggester with src/Calc.cs canned PR

§ 4.7 PlaceholderData alignment. Replaces fictional services/leases/…
paths with src/Calc.cs so the three AI surfaces (FileFocus dots,
HunkAnnotation, DraftSuggestion) render in cohort demos against the
canned FakePrReader PR without endpoint mocks.

PlaceholderDraftSuggester previously emitted a hardcoded literal
bypassing PlaceholderData entirely — now delegates per the
PlaceholderFileFocusRanker / PlaceholderHunkAnnotator pattern.

DraftSuggestion line number = <Step 1.1 value> (matches the canned
stale-draft fixture's anchor in FakeReviewBackingStore at
PRism.Web/TestHooks/)."
```

---

### Task 2: Add `GET /ai/file-focus` endpoint + tests

**Files:**
- Modify: `PRism.Web/Endpoints/AiEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs`

- [ ] **Step 2.1: Write the failing tests**

Create `tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/file-focus endpoint mirrors /ai/summary's
// seam-resolve-and-map pattern: Noop seam → empty list → 204; Placeholder
// seam → canned data → 200. No per-endpoint IsSubscribed check — D111
// defers that to the real-AI seam-swap moment.
public class AiFileFocusEndpointTests
{
    [Fact]
    public async Task Get_ai_file_focus_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("level").GetString().Should().BeOneOf("high", "medium", "low");
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_401_without_session_token()
    {
        // Spec § 5.4: per-route spot-check that SessionTokenMiddleware covers
        // the new endpoint. Catches accidental middleware exemption widening
        // (a la /api/health) for the /ai/* family.
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
```

**Helper verified:** `PRismWebApplicationFactory.CreateUnauthenticatedClient()` (defined at `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs:104`) is the canonical helper for unauthenticated calls. It calls `Server.CreateClient()` directly to bypass `ConfigureClient`'s automatic auth injection. Used by existing `SessionTokenMiddlewareTests`, `PrDraftEndpointTests`, `EventsSubscriptionsEndpointTests`. Do NOT use any fallback that removes only the `X-PRism-Session` header — the factory also injects a `Cookie: prism-session=<token>` (`PRismWebApplicationFactory.cs:94-95`), and `SessionTokenMiddleware.cs:102-103` accepts either credential, so header-removal alone returns 200, not 401 (false-green security test).

- [ ] **Step 2.2: Run tests to verify they fail (endpoint not yet added)**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiFileFocusEndpointTests" -v minimal`

Expected: 3 failures, each with `404 NotFound` from the GetAsync call because the route isn't mapped yet.

- [ ] **Step 2.3: Add the endpoint to AiEndpoints.cs**

Modify `PRism.Web/Endpoints/AiEndpoints.cs` — append after the existing `/ai/summary` MapGet (before the `return app;` line). The full file at this stage:

```csharp
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Contracts;

namespace PRism.Web.Endpoints;

internal static class AiEndpoints
{
    public static IEndpointRouteBuilder MapAi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Spec § 7.3. /ai/summary — existing.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/summary",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var summarizer = ai.Resolve<IPrSummarizer>();
                var summary = await summarizer
                    .SummarizeAsync(new PrReference(owner, repo, number), ct)
                    .ConfigureAwait(false);
                return summary is null ? Results.NoContent() : Results.Ok(summary);
            });

        // PR9b-ai-gating § 3.2. Mirrors /ai/summary's seam-resolve-and-map.
        // D111: No per-PR IsSubscribed check while seam is canned-data only.
        // When the binding swaps to a real AI implementation (real generation,
        // not Noop/Placeholder), add an IsSubscribed gate before the seam call
        // — DO NOT merge the seam swap without this gate.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/file-focus",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var ranker = ai.Resolve<IFileFocusRanker>();
                var entries = await ranker
                    .RankAsync(new PrReference(owner, repo, number), ct)
                    .ConfigureAwait(false);
                return entries.Count == 0 ? Results.NoContent() : Results.Ok(entries);
            });

        return app;
    }
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiFileFocusEndpointTests" -v minimal`

Expected: 3 passing tests.

- [ ] **Step 2.5: Commit**

```bash
git add PRism.Web/Endpoints/AiEndpoints.cs tests/PRism.Web.Tests/Endpoints/AiFileFocusEndpointTests.cs
git commit -m "feat(ai): add GET /api/pr/{owner}/{repo}/{number}/ai/file-focus endpoint

§ 3.2 first of three new AI endpoints; resolves IFileFocusRanker seam
via IAiSeamSelector. NoopFileFocusRanker → empty list → 204;
PlaceholderFileFocusRanker → canned FileFocus[] → 200.

Inline D111 comment anchors the IsSubscribed-gating reopener in code,
not just sidecar — the implementer who swaps the seam binding to a real
AI implementation must add the IsSubscribed gate in the same merge."
```

---

### Task 3: Add `GET /ai/hunk-annotations` endpoint + tests

**Files:**
- Modify: `PRism.Web/Endpoints/AiEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs`

- [ ] **Step 3.1: Write the failing tests**

Create `tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/hunk-annotations endpoint surfaces ALL
// annotations for the PR in one fetch — calls the per-hunk seam method
// with empty filePath + 0 hunkIndex sentinels; the placeholder ignores
// them (D109 documents this seam-vs-endpoint divergence).
public class AiHunkAnnotationsEndpointTests
{
    [Fact]
    public async Task Get_ai_hunk_annotations_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("hunkIndex").GetInt32().Should().BeGreaterOrEqualTo(0);
        first.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("tone").GetString().Should().BeOneOf("calm", "heads-up", "concern");
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_401_without_session_token()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateUnauthenticatedClient();
        // Or whatever helper / inline-pattern Task 2 settled on.

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiHunkAnnotationsEndpointTests" -v minimal`

Expected: 3 failures with 404 NotFound.

- [ ] **Step 3.3: Add the endpoint to AiEndpoints.cs**

Append after the `/ai/file-focus` MapGet from Task 2:

```csharp
// PR9b-ai-gating § 3.2. The seam interface takes (prRef, filePath, hunkIndex)
// for v2 per-hunk queries; v1's placeholder ignores filePath/hunkIndex and
// returns the canned set wholesale. The endpoint surfaces all annotations
// for the PR in one fetch so DiffPane can index locally. D109 documents the
// seam-vs-endpoint divergence rationale; D111 comment below anchors the
// IsSubscribed-gating reopener.
//
// D111: No per-PR IsSubscribed check while seam is canned-data only. When
// the binding swaps to a real AI implementation (real generation, not Noop/
// Placeholder), add an IsSubscribed gate before the seam call — DO NOT
// merge the seam swap without this gate.
app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/hunk-annotations",
    async (string owner, string repo, int number,
           IAiSeamSelector ai, CancellationToken ct) =>
    {
        var annotator = ai.Resolve<IHunkAnnotator>();
        var annotations = await annotator
            .AnnotateAsync(new PrReference(owner, repo, number),
                           filePath: string.Empty, hunkIndex: 0, ct)
            .ConfigureAwait(false);
        return annotations.Count == 0 ? Results.NoContent() : Results.Ok(annotations);
    });
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiHunkAnnotationsEndpointTests" -v minimal`

Expected: 3 passing tests.

- [ ] **Step 3.5: Commit**

```bash
git add PRism.Web/Endpoints/AiEndpoints.cs tests/PRism.Web.Tests/Endpoints/AiHunkAnnotationsEndpointTests.cs
git commit -m "feat(ai): add GET /api/pr/{owner}/{repo}/{number}/ai/hunk-annotations endpoint

§ 3.2 second of three new AI endpoints. Per-PR shape (returns all
annotations in one fetch) while seam stays per-hunk for v2 cost-control —
divergence documented in D109. D111 inline comment anchors IsSubscribed
reopener.

AnnotationTone serializes kebab-case on the wire (calm / heads-up /
concern) via JsonSerializerOptionsFactory.Api's KebabCase enum converter."
```

---

### Task 4: Add `GET /ai/draft-suggestions` endpoint + tests

**Files:**
- Modify: `PRism.Web/Endpoints/AiEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/AiDraftSuggestionsEndpointTests.cs`

- [ ] **Step 4.1: Write the failing tests**

Create `tests/PRism.Web.Tests/Endpoints/AiDraftSuggestionsEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/draft-suggestions endpoint resolves
// IDraftSuggester (existing seam, parallel to IFileFocusRanker /
// IHunkAnnotator). Noop → empty list → 204; Placeholder → canned
// DraftSuggestion[] → 200.
public class AiDraftSuggestionsEndpointTests
{
    [Fact]
    public async Task Get_ai_draft_suggestions_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("filePath").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("lineNumber").GetInt32().Should().BeGreaterThan(0);
        first.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_401_without_session_token()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Get_ai_draft_suggestions_returns_anchor_from_PlaceholderData()
    {
        // Pins the cross-file invariant: PlaceholderData.DraftSuggestions[0]
        // must contain the canned PR's stale-draft anchor. If Task 1 forgets to
        // update PlaceholderDraftSuggester to delegate to PlaceholderData (or
        // forgets the lineNumber replacement), this test catches it before the
        // cohort demo silently breaks.
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/draft-suggestions", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var first = body[0];
        // The seam must return the path Task 1 set: src/Calc.cs. If it returns
        // the original `services/leases/...` fixture, PlaceholderDraftSuggester
        // is still emitting hardcoded data instead of reading PlaceholderData.
        first.GetProperty("filePath").GetString().Should().Be("src/Calc.cs");
    }
}
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiDraftSuggestionsEndpointTests" -v minimal`

Expected: 3 failures with 404 NotFound.

- [ ] **Step 4.3: Add the endpoint to AiEndpoints.cs**

Append after the `/ai/hunk-annotations` MapGet:

```csharp
// PR9b-ai-gating § 3.2. Third new AI endpoint. IDraftSuggester.SuggestAsync
// takes (prRef, ct) — clean per-PR shape, no sentinel args needed.
//
// D111: No per-PR IsSubscribed check while seam is canned-data only. When
// the binding swaps to a real AI implementation (real generation, not Noop/
// Placeholder), add an IsSubscribed gate before the seam call — DO NOT
// merge the seam swap without this gate.
app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/draft-suggestions",
    async (string owner, string repo, int number,
           IAiSeamSelector ai, CancellationToken ct) =>
    {
        var suggester = ai.Resolve<IDraftSuggester>();
        var suggestions = await suggester
            .SuggestAsync(new PrReference(owner, repo, number), ct)
            .ConfigureAwait(false);
        return suggestions.Count == 0 ? Results.NoContent() : Results.Ok(suggestions);
    });
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --configuration Release --filter "FullyQualifiedName~AiDraftSuggestionsEndpointTests" -v minimal`

Expected: 3 passing tests.

- [ ] **Step 4.5: Run the full backend suite to catch any cross-cutting regressions**

Run: `dotnet test --configuration Release --no-build -v minimal`

Expected: all existing tests pass + 9 new tests pass (3 per endpoint).

- [ ] **Step 4.6: Commit**

```bash
git add PRism.Web/Endpoints/AiEndpoints.cs tests/PRism.Web.Tests/Endpoints/AiDraftSuggestionsEndpointTests.cs
git commit -m "feat(ai): add GET /api/pr/{owner}/{repo}/{number}/ai/draft-suggestions endpoint

§ 3.2 third of three new AI endpoints. IDraftSuggester seam already
existed (PR9b-ai-gating D107 superseded — see § 8). Per-PR shape;
endpoint maps Noop → 204, Placeholder → 200 with canned suggestions
matching the canned PR's stale-draft anchor.

Backend Phase 1 complete: 3 endpoints + 3 endpoint tests (9 cases)
+ PlaceholderData alignment + D111 inline comments anchoring the
IsSubscribed-gating reopener in code."
```

---

## Phase 2: Frontend types + API clients (Tasks 5-6)

### Task 5: Extend `frontend/src/api/types.ts` with new AI types

**Files:**
- Modify: `frontend/src/api/types.ts:208-213` (extend the existing AI block)

- [ ] **Step 5.1: Locate the existing AI types block**

Run: `grep -n "PrSummary\|FocusLevel\|AnnotationTone" frontend/src/api/types.ts`

Expected: `PrSummary` at line 208; no `FocusLevel` or `AnnotationTone` yet (we're adding them).

- [ ] **Step 5.2: Append the new types**

Add after the existing `PrSummary` interface (around line 212), before the existing `export type FileChangeStatus`:

```ts
// PR9b-ai-gating § 3.3. The backend `FocusLevel` enum carries 3 values;
// today's PlaceholderFileFocusRanker emits High + Medium. Wire-shape:
// kebab-case via JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())
// — see JsonSerializerOptionsFactory.cs:44.
export type FocusLevel = 'high' | 'medium' | 'low';

export interface FileFocus {
  path: string;
  level: FocusLevel;
}

// AnnotationTone carries 3 backend values (PRism.AI.Contracts/Dtos/
// HunkAnnotation.cs:5-10: Calm, HeadsUp, Concern). Today's placeholder
// emits Calm + HeadsUp only; widening the type ensures a future
// placeholder edit or v2 backend swap renders 'concern' deterministically
// rather than silently narrowing.
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

- [ ] **Step 5.3: Run typecheck to confirm no breakage**

Run (from `frontend/` directory): `npx tsc --noEmit`

Expected: clean exit. The new types don't break any existing consumers.

- [ ] **Step 5.4: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(ai): add FocusLevel, FileFocus, AnnotationTone (3 vals), HunkAnnotation, DraftSuggestion types

§ 3.3 wire-shape types for the three new AI endpoints.

AnnotationTone widens to 3 values (calm | heads-up | concern) matching
the backend enum even though placeholder emits only 2 — the third lets
v2 backend swaps render deterministically. Kebab-case enum literals
match the API JsonSerializerOptions converter."
```

---

### Task 6: Create three API client modules

**Files:**
- Create: `frontend/src/api/aiFileFocus.ts`
- Create: `frontend/src/api/aiHunkAnnotations.ts`
- Create: `frontend/src/api/aiDraftSuggestions.ts`

- [ ] **Step 6.1: Reference the existing `aiSummary.ts` shape**

Run: `cat frontend/src/api/aiSummary.ts`

Expected output: the existing pattern using `apiClient.get<PrSummary | undefined>` + `result ?? null`. The new clients mirror this.

- [ ] **Step 6.2: Create `aiFileFocus.ts`**

```ts
// frontend/src/api/aiFileFocus.ts
import { apiClient } from './client';
import type { PrReference, FileFocus } from './types';

// 204 No Content (NoopFileFocusRanker) round-trips as undefined; coerce to
// null so the consuming hook has a clean { FileFocus[] | null } discriminator.
export async function getAiFileFocus(prRef: PrReference): Promise<FileFocus[] | null> {
  const result = await apiClient.get<FileFocus[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
  );
  return result ?? null;
}
```

- [ ] **Step 6.3: Create `aiHunkAnnotations.ts`**

```ts
// frontend/src/api/aiHunkAnnotations.ts
import { apiClient } from './client';
import type { PrReference, HunkAnnotation } from './types';

export async function getAiHunkAnnotations(
  prRef: PrReference,
): Promise<HunkAnnotation[] | null> {
  const result = await apiClient.get<HunkAnnotation[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/hunk-annotations`,
  );
  return result ?? null;
}
```

- [ ] **Step 6.4: Create `aiDraftSuggestions.ts`**

```ts
// frontend/src/api/aiDraftSuggestions.ts
import { apiClient } from './client';
import type { PrReference, DraftSuggestion } from './types';

export async function getAiDraftSuggestions(
  prRef: PrReference,
): Promise<DraftSuggestion[] | null> {
  const result = await apiClient.get<DraftSuggestion[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/draft-suggestions`,
  );
  return result ?? null;
}
```

- [ ] **Step 6.5: Prettier + typecheck**

Run (from `frontend/`):
```bash
npm run prettier -- --write src/api/aiFileFocus.ts src/api/aiHunkAnnotations.ts src/api/aiDraftSuggestions.ts
npx tsc --noEmit
```

Expected: prettier rewrites the three new files in place (no diff if already conformant); typecheck passes.

- [ ] **Step 6.6: Commit**

```bash
git add frontend/src/api/aiFileFocus.ts frontend/src/api/aiHunkAnnotations.ts frontend/src/api/aiDraftSuggestions.ts
git commit -m "feat(ai): add three API client modules for the new AI endpoints

§ 3.3. getAiFileFocus / getAiHunkAnnotations / getAiDraftSuggestions
all mirror getAiSummary's shape: apiClient.get<T[] | undefined> with
204 → null coercion so the consuming hook has a clean discriminator."
```

---

## Phase 3: Frontend hooks (Tasks 7-11)

### Task 7: Create `useAiGate` hook + test

**Files:**
- Create: `frontend/src/hooks/useAiGate.ts`
- Create: `frontend/__tests__/useAiGate.test.tsx`

- [ ] **Step 7.1: Write the failing test**

Create `frontend/__tests__/useAiGate.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAiGate } from '../src/hooks/useAiGate';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { usePreferences } from '../src/hooks/usePreferences';

vi.mock('../src/hooks/useCapabilities');
vi.mock('../src/hooks/usePreferences');

describe('useAiGate', () => {
  beforeEach(() => {
    vi.mocked(useCapabilities).mockReset();
    vi.mocked(usePreferences).mockReset();
  });

  it('returns false when both capability and aiPreview are off', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: false, fileFocus: false, hunkAnnotations: false,
        preSubmitValidators: false, composerAssist: false, draftSuggestions: false,
        draftReconciliation: false, inboxEnrichment: false, inboxRanking: false },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when capability is off but aiPreview is on', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: false, fileFocus: false, hunkAnnotations: false,
        preSubmitValidators: false, composerAssist: false, draftSuggestions: false,
        draftReconciliation: false, inboxEnrichment: false, inboxRanking: false },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when capability is on but aiPreview is off', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: true, fileFocus: true, hunkAnnotations: true,
        preSubmitValidators: true, composerAssist: true, draftSuggestions: true,
        draftReconciliation: true, inboxEnrichment: true, inboxRanking: true },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns true only when both capability and aiPreview are on', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: true, fileFocus: true, hunkAnnotations: true,
        preSubmitValidators: true, composerAssist: true, draftSuggestions: true,
        draftReconciliation: true, inboxEnrichment: true, inboxRanking: true },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(true);
  });

  it('returns false when capabilities is null (still loading)', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: null, error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when preferences is null (still loading)', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: true, fileFocus: true, hunkAnnotations: true,
        preSubmitValidators: true, composerAssist: true, draftSuggestions: true,
        draftReconciliation: true, inboxEnrichment: true, inboxRanking: true },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: null, error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('narrows by key: useAiGate(summary) ignores other capability flags', () => {
    // composerAssist:false, summary:true → useAiGate('summary') is true
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { summary: true, fileFocus: false, hunkAnnotations: false,
        preSubmitValidators: false, composerAssist: false, draftSuggestions: false,
        draftReconciliation: false, inboxEnrichment: false, inboxRanking: false },
      error: null, refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: { ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never, github: {} as never },
      error: null, refetch: vi.fn(), set: vi.fn(),
    } as never);

    expect(renderHook(() => useAiGate('summary')).result.current).toBe(true);
    expect(renderHook(() => useAiGate('composerAssist')).result.current).toBe(false);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run __tests__/useAiGate.test.tsx`

Expected: failures because `useAiGate` doesn't exist yet — error message will be `Cannot find module '../src/hooks/useAiGate'`.

- [ ] **Step 7.3: Create the hook**

```ts
// frontend/src/hooks/useAiGate.ts
import type { AiCapabilities } from '../api/types';
import { useCapabilities } from './useCapabilities';
import { usePreferences } from './usePreferences';

// PR9b-ai-gating § 3.1. Centralizes the `capabilities[key] && aiPreview`
// expression that was previously duplicated across 4 sites (and missing
// the capability check on AskAiButton). 9 consumers after this PR ships.
//
// Today the two factors are coupled on the wire — CapabilitiesEndpoints.cs:13
// returns AllOn xor AllOff from AiPreviewState.IsOn, and PreferencesEndpoints
// mirrors aiPreview into that state. So `useAiGate(key)` returns the same
// value as `aiPreview` regardless of key. The two-factor shape is forward-
// compat scaffolding for backend capability decoupling — see D112.
export function useAiGate(key: keyof AiCapabilities): boolean {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  return (capabilities?.[key] ?? false) && (preferences?.ui.aiPreview ?? false);
}
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `npx vitest run __tests__/useAiGate.test.tsx`

Expected: 7 passing tests.

- [ ] **Step 7.5: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write src/hooks/useAiGate.ts __tests__/useAiGate.test.tsx
cd ..
git add frontend/src/hooks/useAiGate.ts frontend/__tests__/useAiGate.test.tsx
git commit -m "feat(ai): add useAiGate(key) hook + tests

§ 3.1 centralizes the gating expression. 7 test cases cover the truth
table (capability × aiPreview), null-loading paths, and key narrowing.
Comment in the hook itself names the wire-coupling caveat (D112) so the
next reader understands why a two-factor hook returns identical values
across keys today."
```

---

### Task 8: Create `useAiFileFocus` hook + test

**Files:**
- Create: `frontend/src/hooks/useAiFileFocus.ts`
- Create: `frontend/__tests__/useAiFileFocus.test.tsx`

- [ ] **Step 8.1: Write the failing test**

Create `frontend/__tests__/useAiFileFocus.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiFileFocus } from '../src/hooks/useAiFileFocus';
import * as aiFileFocus from '../src/api/aiFileFocus';

vi.mock('../src/api/aiFileFocus');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiFileFocus', () => {
  beforeEach(() => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockReset();
  });

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiFileFocus(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiFileFocus.getAiFileFocus).not.toHaveBeenCalled();
  });

  it('fetches and returns FileFocus[] when enabled', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockResolvedValue([
      { path: 'src/Calc.cs', level: 'high' },
      { path: 'src/Calc.Tests.cs', level: 'medium' },
    ]);

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(2);
    expect(result.current?.[0].path).toBe('src/Calc.cs');
    expect(result.current?.[0].level).toBe('high');
  });

  it('returns null on 204 (empty seam → null sentinel)', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockResolvedValue(null);

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    // Brief await to let the useEffect run; result stays null.
    await waitFor(() => expect(aiFileFocus.getAiFileFocus).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error (silent failure matches useAiSummary precedent)', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    await waitFor(() => expect(aiFileFocus.getAiFileFocus).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('does not set state after unmount (cancelled cleanup)', async () => {
    let resolve!: (value: ReturnType<typeof aiFileFocus.getAiFileFocus> extends Promise<infer R> ? R : never) => void;
    vi.mocked(aiFileFocus.getAiFileFocus).mockReturnValue(
      new Promise((r) => { resolve = r; }),
    );

    const { result, unmount } = renderHook(() => useAiFileFocus(PR_REF, true));
    unmount();
    resolve([{ path: 'src/Calc.cs', level: 'high' }]);
    // No React warning about setState on unmounted component — assertion is
    // the absence of a console warning, but the cleanup path also short-
    // circuits the resolve. The result captured pre-unmount is the only
    // value we can observe.
    expect(result.current).toBe(null);
  });
});
```

- [ ] **Step 8.2: Run test to verify it fails**

Run: `npx vitest run __tests__/useAiFileFocus.test.tsx`

Expected: failures because `useAiFileFocus` doesn't exist.

- [ ] **Step 8.3: Create the hook**

```ts
// frontend/src/hooks/useAiFileFocus.ts
import { useEffect, useState } from 'react';
import { getAiFileFocus } from '../api/aiFileFocus';
import type { PrReference, FileFocus } from '../api/types';

// PR9b-ai-gating § 3.3. Mirrors useAiSummary's shape exactly. `null` is the
// union of three states: not-enabled, in-flight, 204/error. Downstream
// consumers (FileTree) render nothing for null — matches the off-state
// visual exactly. No isLoading flag in v1.
export function useAiFileFocus(prRef: PrReference, enabled: boolean): FileFocus[] | null {
  const [entries, setEntries] = useState<FileFocus[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiFileFocus(prRef)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return entries;
}
```

- [ ] **Step 8.4: Run test to verify it passes**

Run: `npx vitest run __tests__/useAiFileFocus.test.tsx`

Expected: 5 passing tests.

- [ ] **Step 8.5: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write src/hooks/useAiFileFocus.ts __tests__/useAiFileFocus.test.tsx
cd ..
git add frontend/src/hooks/useAiFileFocus.ts frontend/__tests__/useAiFileFocus.test.tsx
git commit -m "feat(ai): add useAiFileFocus hook + tests"
```

---

### Task 9: Create `useAiHunkAnnotations` hook + test

**Files:**
- Create: `frontend/src/hooks/useAiHunkAnnotations.ts`
- Create: `frontend/__tests__/useAiHunkAnnotations.test.tsx`

- [ ] **Step 9.1: Write the test** (mirrors `useAiFileFocus.test.tsx` shape exactly — replace `useAiFileFocus` → `useAiHunkAnnotations`, `aiFileFocus` → `aiHunkAnnotations`, `FileFocus` → `HunkAnnotation`, and the canned data with annotation shape):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiHunkAnnotations } from '../src/hooks/useAiHunkAnnotations';
import * as aiHunkAnnotations from '../src/api/aiHunkAnnotations';

vi.mock('../src/api/aiHunkAnnotations');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiHunkAnnotations', () => {
  beforeEach(() => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockReset();
  });

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiHunkAnnotations.getAiHunkAnnotations).not.toHaveBeenCalled();
  });

  it('fetches and returns HunkAnnotation[] when enabled', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue([
      { path: 'src/Calc.cs', hunkIndex: 0, body: 'Reads cleaner.', tone: 'calm' },
    ]);

    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].tone).toBe('calm');
  });

  it('returns null on 204', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue(null);
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(aiHunkAnnotations.getAiHunkAnnotations).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(aiHunkAnnotations.getAiHunkAnnotations).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });
});
```

- [ ] **Step 9.2: Run test to verify it fails**

Run: `npx vitest run __tests__/useAiHunkAnnotations.test.tsx`
Expected: module-not-found failure.

- [ ] **Step 9.3: Create the hook**

```ts
// frontend/src/hooks/useAiHunkAnnotations.ts
import { useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import type { PrReference, HunkAnnotation } from '../api/types';

export function useAiHunkAnnotations(prRef: PrReference, enabled: boolean): HunkAnnotation[] | null {
  const [entries, setEntries] = useState<HunkAnnotation[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return entries;
}
```

- [ ] **Step 9.4: Run + commit**

```bash
cd frontend
npx vitest run __tests__/useAiHunkAnnotations.test.tsx
npm run prettier -- --write src/hooks/useAiHunkAnnotations.ts __tests__/useAiHunkAnnotations.test.tsx
cd ..
git add frontend/src/hooks/useAiHunkAnnotations.ts frontend/__tests__/useAiHunkAnnotations.test.tsx
git commit -m "feat(ai): add useAiHunkAnnotations hook + tests"
```

---

### Task 10: Create `useAiDraftSuggestions` hook + test

**Files:**
- Create: `frontend/src/hooks/useAiDraftSuggestions.ts`
- Create: `frontend/__tests__/useAiDraftSuggestions.test.tsx`

- [ ] **Step 10.1: Write the test** (same shape as Task 9, with `DraftSuggestion` element type):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiDraftSuggestions } from '../src/hooks/useAiDraftSuggestions';
import * as aiDraftSuggestions from '../src/api/aiDraftSuggestions';

vi.mock('../src/api/aiDraftSuggestions');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiDraftSuggestions', () => {
  beforeEach(() => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockReset();
  });

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiDraftSuggestions.getAiDraftSuggestions).not.toHaveBeenCalled();
  });

  it('fetches and returns DraftSuggestion[] when enabled', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue([
      { filePath: 'src/Calc.cs', lineNumber: 5, body: 'Worth a comment here?' },
    ]);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].filePath).toBe('src/Calc.cs');
    expect(result.current?.[0].lineNumber).toBe(5);
  });

  it('returns null on 204', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue(null);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(aiDraftSuggestions.getAiDraftSuggestions).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(aiDraftSuggestions.getAiDraftSuggestions).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });
});
```

- [ ] **Step 10.2: Run to verify failure → Create hook → Re-run → Commit**

Hook body (copy `useAiHunkAnnotations` shape, replace types and import path):

```ts
// frontend/src/hooks/useAiDraftSuggestions.ts
import { useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import type { PrReference, DraftSuggestion } from '../api/types';

export function useAiDraftSuggestions(prRef: PrReference, enabled: boolean): DraftSuggestion[] | null {
  const [entries, setEntries] = useState<DraftSuggestion[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return entries;
}
```

Commit:
```bash
cd frontend
npx vitest run __tests__/useAiDraftSuggestions.test.tsx
npm run prettier -- --write src/hooks/useAiDraftSuggestions.ts __tests__/useAiDraftSuggestions.test.tsx
cd ..
git add frontend/src/hooks/useAiDraftSuggestions.ts frontend/__tests__/useAiDraftSuggestions.test.tsx
git commit -m "feat(ai): add useAiDraftSuggestions hook + tests"
```

---

### Task 11: Migrate 4 existing consumers to `useAiGate`

> **Atomic-pair note.** Tasks 11 and 12 are a coupled pair: Task 11 widens the source-code gating sites; Task 12 updates the test mocks that drive those sites. Between the two, the relevant tests fail (mocks don't match). The plan defers the commit until BOTH tasks have landed (Task 12.4 commits both). For subagent-driven-development: dispatch Tasks 11 and 12 as a SINGLE coupled unit; do not insert a checkpoint commit between them. A subagent should not mark Task 11 complete until Task 12's tests pass.

**Files (4 modify):**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx:29-30`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:104-106` (+ AskAiButton prop drop in same file)
- Modify: `frontend/src/components/Ai/AiComposerAssistant.tsx:17`
- Modify: `frontend/src/components/PrDetail/AskAiButton.tsx`

This task touches 4 source files + the test-mock-shape ripple. Migrate tests later in Task 12 — the source migration here.

- [ ] **Step 11.1: Migrate OverviewTab**

Read `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` around line 29-30. Replace:

```ts
const aiPreview = preferences?.ui.aiPreview ?? false;
const aiOn = !!capabilities?.summary && aiPreview;
```

with:

```ts
const aiPreview = preferences?.ui.aiPreview ?? false;  // still needed for PrDescription prop
const aiOn = useAiGate('summary');
```

Add `import { useAiGate } from '../../../hooks/useAiGate';` at the top. The `aiPreview` const stays because `PrDescription` reads it as a prop (§ 3.1 PrDescription policy).

- [ ] **Step 11.2: Migrate AiComposerAssistant**

Read `frontend/src/components/Ai/AiComposerAssistant.tsx:17`. Replace:

```ts
const on = !!capabilities?.composerAssist && !!preferences?.ui.aiPreview;
```

with:

```ts
const on = useAiGate('composerAssist');
```

Add the import. Remove the `useCapabilities` / `usePreferences` imports if they have no other use in the file (verify with grep before removing).

- [ ] **Step 11.3: Migrate AskAiButton + drop the `aiPreview` prop**

Current `AskAiButton.tsx:11` (verified): `<button type="button" className="btn btn-secondary ask-ai-button" onClick={onClick}>`. **Preserve this className verbatim** — the spec § 4.2 framing is "abstraction consistency, not behavior change"; changing visual styling would be a regression. Only the gating mechanism and the prop interface change.

Replace the body so the gate is internal and the prop is gone (verify against the actual file — preserve any icon, exact text, and any data-testid you find):

```tsx
// frontend/src/components/PrDetail/AskAiButton.tsx
// Spec § 4.2. Hidden unless useAiGate('composerAssist') is true. Tightens
// the gating to match AiComposerAssistant; today the change is a no-op on
// the wire because capabilities mirror aiPreview (D112).
import { useAiGate } from '../../hooks/useAiGate';

interface Props {
  onClick: () => void;
}

export function AskAiButton({ onClick }: Props) {
  const enabled = useAiGate('composerAssist');
  if (!enabled) return null;
  return (
    <button type="button" className="btn btn-secondary ask-ai-button" onClick={onClick}>
      Ask AI
    </button>
  );
}
```

Run `git diff frontend/src/components/PrDetail/AskAiButton.tsx` after edit and confirm only the gating mechanism (replaced `if (!aiPreview)` with `const enabled = useAiGate(...)`) + the Props interface (dropped `aiPreview: boolean`) changed. className, text, and any other JSX details must match HEAD.

- [ ] **Step 11.4: Migrate PrHeader — both line 106 derivation AND drop the AskAiButton prop pass**

Read `frontend/src/components/PrDetail/PrHeader.tsx:100-115` and `:330-345`. The migration touches two regions in this file:

Replace lines 104-106:

```ts
const aiPreview = preferences?.ui.aiPreview ?? false;
const validatorResults: ValidatorResult[] =
  aiPreview && !!capabilities?.preSubmitValidators ? CANNED_PRESUBMIT_VALIDATOR_RESULTS : [];
```

with:

```ts
const validatorResults: ValidatorResult[] =
  useAiGate('preSubmitValidators') ? CANNED_PRESUBMIT_VALIDATOR_RESULTS : [];
```

The standalone `const aiPreview = ...` line is removed (verified to be orphan — no other consumers in PrHeader.tsx).

Around line 336, change the `AskAiButton` JSX from:

```tsx
<AskAiButton aiPreview={aiPreview} onClick={toggleAskAi} />
```

to:

```tsx
<AskAiButton onClick={toggleAskAi} />
```

Add `import { useAiGate } from '../../hooks/useAiGate';` at the top. Remove the `useCapabilities` / `usePreferences` imports only if no other use remains (verify with grep).

- [ ] **Step 11.5: Typecheck after all 4 migrations**

Run: `npx tsc --noEmit`
Expected: clean exit. Any leftover unused imports get caught here.

- [ ] **Step 11.6: Run the existing tests for these 4 files to surface mock-shape failures**

Run (from `frontend/`):
```bash
npx vitest run __tests__/OverviewTab.test.tsx __tests__/AiComposerAssistant.test.tsx __tests__/PrHeader.test.tsx 2>&1 | tail -60
```

Expected: some failures because tests still mock `useCapabilities` + `usePreferences` instead of `useAiGate`. Task 12 fixes the test mocks. For now: **do not commit until Task 12 lands** to avoid a broken-tests intermediate commit.

---

### Task 12: Migration sweep — update test mocks to use `useAiGate`

**Files (mock-shape migration in ~3-4 specs):**
- Modify: `frontend/__tests__/OverviewTab.test.tsx`
- Modify: `frontend/__tests__/AiComposerAssistant.test.tsx`
- Modify: `frontend/__tests__/PrHeader.test.tsx`
- Modify: `frontend/__tests__/header.test.tsx` (if it mocks the gate; verify)

The pattern: where a test builds a `capabilities + preferences` fixture solely to drive the gate compute, replace with `vi.mock('../src/hooks/useAiGate')` + `vi.mocked(useAiGate).mockReturnValue(true|false)`. Where the same test also drives non-AI fields (theme, density, etc.), keep the existing fixture and ADD the `useAiGate` mock alongside.

- [ ] **Step 12.1: For each affected file, identify the surgical edit boundary**

For each file:

```bash
grep -n "useCapabilities\|usePreferences\|aiPreview\|composerAssist\|summary.*capability" frontend/__tests__/OverviewTab.test.tsx
```

Note which test cases use the fixture for the gate vs other purposes.

- [ ] **Step 12.2: Add `useAiGate` mock import + use at relevant test cases**

Example pattern (apply to each affected file):

```ts
import { useAiGate } from '../src/hooks/useAiGate';
vi.mock('../src/hooks/useAiGate');

// In tests that gate AI surface visibility:
beforeEach(() => {
  vi.mocked(useAiGate).mockReturnValue(true); // or false for off-state tests
});
```

Where existing tests built `capabilities = { summary: true, ... }` solely to drive the gate, those fixtures can simplify but they may also feed `useCapabilities` for other reasons (e.g., AiSummaryCard rendering reads `useAiSummary` which is independent). Use the grep output from Step 12.1 to decide per-test.

- [ ] **Step 12.3: Run the migrated tests**

Run (from `frontend/`): `npx vitest run __tests__/OverviewTab.test.tsx __tests__/AiComposerAssistant.test.tsx __tests__/PrHeader.test.tsx __tests__/header.test.tsx 2>&1 | tail -40`

Expected: all green. If a test fails because `useAiGate` is undefined, the mock import is missing in that file.

- [ ] **Step 12.4: Prettier + commit BOTH Task 11 + Task 12 changes together**

```bash
cd frontend
npm run prettier -- --write src/components/PrDetail/OverviewTab/OverviewTab.tsx \
  src/components/PrDetail/PrHeader.tsx \
  src/components/Ai/AiComposerAssistant.tsx \
  src/components/PrDetail/AskAiButton.tsx \
  __tests__/OverviewTab.test.tsx \
  __tests__/AiComposerAssistant.test.tsx \
  __tests__/PrHeader.test.tsx \
  __tests__/header.test.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx \
  frontend/src/components/PrDetail/PrHeader.tsx \
  frontend/src/components/Ai/AiComposerAssistant.tsx \
  frontend/src/components/PrDetail/AskAiButton.tsx \
  frontend/__tests__/OverviewTab.test.tsx \
  frontend/__tests__/AiComposerAssistant.test.tsx \
  frontend/__tests__/PrHeader.test.tsx \
  frontend/__tests__/header.test.tsx
git commit -m "refactor(ai): migrate 4 existing AI gates to useAiGate hook + test mocks

§ 3.1 + § 4.2. Migrates OverviewTab, PrHeader (validators derivation +
AskAiButton prop drop), AiComposerAssistant, and AskAiButton to the
hoisted gate. Today the migration is a no-op behaviorally (capabilities
mirror aiPreview on the wire — D112); behavioral payoff arrives when
backend decouples capabilities.

PrHeader loses the orphan const aiPreview at line 104 and drops the
aiPreview prop pass on AskAiButton — caller signature shrinks to
{ onClick }. AskAiButton's own gate is internal via useAiGate(
'composerAssist'), matching AiComposerAssistant."
```

---

## Phase 4: New surface wirings (Tasks 13-16)

### Task 13: AiHunkAnnotation component rewrite (replaces no-op stub) + test

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css`
- Create: `frontend/__tests__/AiHunkAnnotation.test.tsx`

- [ ] **Step 13.1: Write the failing test**

Create `frontend/__tests__/AiHunkAnnotation.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiHunkAnnotation } from '../src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation';

describe('AiHunkAnnotation', () => {
  it('renders Calm tone as Note + chip-info', () => {
    render(<AiHunkAnnotation annotation={{
      path: 'src/Calc.cs', hunkIndex: 0, body: 'Looks fine.', tone: 'calm',
    }} />);
    expect(screen.getByTestId('ai-hunk-annotation')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByText('Looks fine.')).toBeInTheDocument();
    const chip = screen.getByText('Note');
    expect(chip.className).toContain('chip-info');
  });

  it('renders HeadsUp tone as "Behavior change" + chip-warning', () => {
    render(<AiHunkAnnotation annotation={{
      path: 'src/Calc.cs', hunkIndex: 1, body: 'Failure semantics changed.', tone: 'heads-up',
    }} />);
    expect(screen.getByText('Behavior change')).toBeInTheDocument();
    expect(screen.getByText('Failure semantics changed.')).toBeInTheDocument();
    const chip = screen.getByText('Behavior change');
    expect(chip.className).toContain('chip-warning');
  });

  it('renders Concern tone as Concern + chip-danger', () => {
    render(<AiHunkAnnotation annotation={{
      path: 'src/Calc.cs', hunkIndex: 2, body: 'Possible regression.', tone: 'concern',
    }} />);
    expect(screen.getByText('Concern')).toBeInTheDocument();
    expect(screen.getByText('Possible regression.')).toBeInTheDocument();
    const chip = screen.getByText('Concern');
    expect(chip.className).toContain('chip-danger');
  });

  it('renders the ai-icon with aria-hidden', () => {
    const { container } = render(<AiHunkAnnotation annotation={{
      path: 'src/Calc.cs', hunkIndex: 0, body: 'x', tone: 'calm',
    }} />);
    const icon = container.querySelector('.ai-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 13.2: Run to verify failures**

Run: `npx vitest run __tests__/AiHunkAnnotation.test.tsx`

Expected: failures — the current component returns null. The tests find no rendered output.

- [ ] **Step 13.3: Replace the component implementation**

Replace `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` body:

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

- [ ] **Step 13.4: Replace the CSS file body**

Replace `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css`:

```css
/* PR9b-ai-gating § 4.4. Port of handoff `.ai-hunk` (screens.css:824-832) and
   `.ai-hunk-meta` (screens.css:834). The literal classes (.ai-hunk,
   .ai-hunk-meta) stay on JSX as the test seam + visual identity; hashed
   module classes (.aiHunk, .aiHunkBody, .aiHunkMeta) carry the paint.
   Matches the literal-class-and-module pattern from PR4 D16. The handoff's
   .ai-hunk-actions surface is NOT ported — Quote/Dismiss action buttons
   are deferred per D108. */

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

- [ ] **Step 13.5: Run test to verify all 4 pass**

Run: `npx vitest run __tests__/AiHunkAnnotation.test.tsx`
Expected: 4 passing tests.

- [ ] **Step 13.6: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx __tests__/AiHunkAnnotation.test.tsx
cd ..
git add frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx \
  frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.module.css \
  frontend/__tests__/AiHunkAnnotation.test.tsx
git commit -m "feat(ai): replace AiHunkAnnotation no-op stub with handoff-faithful shape

§ 4.4. Tone-to-chip lookup map handles 3 tones (calm/heads-up/concern);
TypeScript exhaustiveness check on Record<AnnotationTone, ...> catches
silent narrowing when wire shape widens. Quote/Dismiss action buttons
deferred per D108."
```

---

### Task 14: FileTree focus dot wiring + CSS + test extension

> **Atomic-pair note.** Tasks 14 and 15 are a coupled pair: Task 14 widens `FileTreeProps` (adding required `focusEntries` + `aiPreview` props); Task 15 updates `FilesTab.tsx` to pass them. Until both land, the typecheck is RED. The plan commits both in Task 15.5 (a single commit covering Task 14 + 15). For subagent-driven-development: dispatch Tasks 14 and 15 as a SINGLE coupled unit; do not run `npx tsc --noEmit` over the whole project as a gate between them (the per-file test runs in Task 14 still pass because they mount FileTree directly). A subagent should not mark Task 14 complete until Task 15's typecheck passes.

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`
- Modify: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 14.1: Extend the FileTree test first**

Read `frontend/__tests__/FileTree.test.tsx` to see the existing fixture shape. Then append tests for the focus dot rendering:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileTree } from '../src/components/PrDetail/FilesTab/FileTree';
import type { FileChange, FileFocus } from '../src/api/types';

const F = (path: string, status: FileChange['status'] = 'modified'): FileChange => ({
  path,
  status,
  hunks: [],
});

describe('FileTree — AI focus dot (D32a)', () => {
  const files = [F('src/Calc.cs'), F('src/Calc.Tests.cs')];

  it('renders no dot when aiPreview is off, but the column slot is collapsed', () => {
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        aiPreview={false}
      />,
    );
    // Outer slot exists (one per row); inner dots do not.
    expect(container.querySelectorAll('.file-tree-ai')).toHaveLength(files.length);
    expect(container.querySelectorAll('[class*="fileTreeAiHigh"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="fileTreeAiMed"]')).toHaveLength(0);
  });

  it('renders the high dot for level high', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'high' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    const highDots = container.querySelectorAll('[class*="fileTreeAiHigh"]');
    expect(highDots).toHaveLength(1);
    expect(highDots[0]).toHaveAttribute('title', 'AI focus: high');
  });

  it('renders the medium dot for level medium', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'medium' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    const medDots = container.querySelectorAll('[class*="fileTreeAiMed"]');
    expect(medDots).toHaveLength(1);
    expect(medDots[0]).toHaveAttribute('title', 'AI focus: medium');
  });

  it('does NOT render a dot for level low (handoff has no .ai-focus-low)', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'low' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    expect(container.querySelectorAll('[class*="fileTreeAiHigh"], [class*="fileTreeAiMed"]')).toHaveLength(0);
  });

  it('outer .file-tree-ai slot carries aria-hidden=true so AT ignores the column', () => {
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        aiPreview={false}
      />,
    );
    container.querySelectorAll('.file-tree-ai').forEach((node) => {
      expect(node).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
```

- [ ] **Step 14.2: Run to verify failures**

Run: `npx vitest run __tests__/FileTree.test.tsx -t "AI focus dot"`

Expected: failures because `FileTree`'s props don't yet include `focusEntries` and `aiPreview`. TypeScript will yell at the test fixture; runtime failures follow.

- [ ] **Step 14.3: Extend `FileTreeProps` + thread props down + render dot**

Modify `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`. Add to imports:

```ts
import type { FileChange, FileChangeStatus, FileFocus, FocusLevel } from '../../../api/types';
```

Update the `FileTreeProps` interface:

```ts
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
```

In the `FileTree` function body, build the path-to-level map and pass it to children:

```tsx
export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  isLoading = false,
  focusEntries,
  aiPreview,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const viewedCount = files.filter((f) => viewedPaths.has(f.path)).length;

  // Map path → focus level. null when no entries (gate off or fetch in-flight).
  const focusByPath = useMemo(() => {
    if (!focusEntries) return null;
    const m = new Map<string, FocusLevel>();
    for (const entry of focusEntries) m.set(entry.path, entry.level);
    return m;
  }, [focusEntries]);

  // ... existing early-return for empty + rendering of file tree wrapper ...
```

Thread `focusByPath` and `aiPreview` through to `TreeNodeComponent` and on to `FileNodeComponent`. In `FileNodeComponent`'s return, between the existing `<span file-tree-spacer>` and `<input>`:

```tsx
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
{focusLevel && focusLevel !== 'low' && (
  <span className={styles.srOnly}>{` AI focus: ${focusLevel}`}</span>
)}
```

where `focusLevel = focusByPath?.get(node.path) ?? null`. Extend the `FileNodeComponent` props signature to receive `focusByPath: Map<string, FocusLevel> | null` and `aiPreview: boolean`. Same for `TreeNodeComponent` / `DirectoryNodeComponent` — pass through (DirectoryNode emits its own children recursively).

**a11y note.** The decorative dot is wrapped in `aria-hidden="true"` (no AT announcement). A visually-hidden `.srOnly` span sits OUTSIDE the hidden slot but inside the `role="treeitem"`, so screen readers reading the row announce `"<filename> AI focus: high"`. Add `.srOnly` to `FileTree.module.css` if not already present:

```css
.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

(If a global `.sr-only` exists in `tokens.css`, prefer that — grep before adding the module-scoped version. Extend Task 14.1's test to assert the sr-only span is present when focus level is High/Medium.)

- [ ] **Step 14.4: Extend CSS**

Modify `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`. Replace the existing `.fileTreeAi` block (lines ~91-97) with three rules:

```css
/* PR9b-ai-gating § 4.3. Column slot — always emitted in JSX, collapses when
   AI gate is off. Ports handoff `screens.css:580-581` to prevent row layout
   shift on aiPreview toggle. */
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
   with handoff's opacity-dimmed accent. See D110/D32a closure. */
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

- [ ] **Step 14.5: Run tests to verify they pass**

Run: `npx vitest run __tests__/FileTree.test.tsx`
Expected: all existing tests + 5 new AI-focus-dot tests pass.

- [ ] **Step 14.6: Prettier + commit (don't include FilesTab wiring yet)**

The `FilesTab.tsx` call site needs to pass `focusEntries` and `aiPreview`. That edit lands in Task 15. For now, callers of `FileTree` will fail typecheck — that's OK for this commit because Task 15 follows immediately.

Actually — to keep the source tree compiling between commits, fold Task 14 + Task 15 into one commit. Skip the commit here and continue to Task 15.

---

### Task 15: FilesTab wiring + DiffPane hunk-annotation walk + commit Task 14 + Task 15 together

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`

- [ ] **Step 15.1: Wire `useAiFileFocus` in FilesTab + pass props to FileTree**

Modify `FilesTab.tsx`. Add imports:

```ts
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiFileFocus } from '../../../hooks/useAiFileFocus';
```

In the `FilesTab` function body, add (anywhere after `prRef` is computed):

```ts
const fileFocusEnabled = useAiGate('fileFocus');
const focusEntries = useAiFileFocus(prRef, fileFocusEnabled);
```

Find the `<FileTree ... />` JSX call site and add the two new props:

```tsx
<FileTree
  files={files}
  selectedPath={selectedPath}
  onSelectFile={onSelectFile}
  viewedPaths={viewedPaths}
  onToggleViewed={onToggleViewed}
  isLoading={isLoading}
  focusEntries={focusEntries}
  aiPreview={fileFocusEnabled}
/>
```

(Use the actual prop names from the existing call site — match exactly.)

- [ ] **Step 15.2: Wire `useAiHunkAnnotations` in DiffPane + walk emit**

Modify `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`. Add imports:

```ts
import { useAiGate } from '../../../../hooks/useAiGate';
import { useAiHunkAnnotations } from '../../../../hooks/useAiHunkAnnotations';
import type { HunkAnnotation } from '../../../../api/types';
import { AiHunkAnnotation } from './AiHunkAnnotation';
```

(`useAiGate` import depth confirmed: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` → `../../../../hooks/useAiGate` — verify the actual `frontend/src` root depth.)

Near the top of the `DiffPane` function (where existing hooks are called):

```ts
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

(`DiffPane` does NOT currently receive `prRef` — verified against `DiffPaneProps` at `DiffPane.tsx:13-37`. Add `prRef: PrReference` to `DiffPaneProps` and pass it from `FilesTab` where it is already computed at `FilesTab.tsx:46`. Mirrors the `UnresolvedPanel` prop pattern in `Reconciliation/`.)

In the `<tbody>` rendering loop (currently lines 183-201 of DiffPane.tsx), refactor to maintain a hunk counter:

```tsx
const DIFF_TABLE_COLSPAN = 3;  // gutter-old / gutter-new / content — see DiffPane.tsx:279-297
const rows: React.ReactNode[] = [];
let hunkCounter = -1;
for (let idx = 0; idx < allLines.length; idx++) {
  const line = allLines[idx];
  const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
  const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
  const pair = findAdjacentPair(allLines, idx);

  rows.push(
    <DiffLineRow
      key={idx}
      line={line}
      pair={pair}
      threadsAtLine={threadsAtLine}
      filePath={selectedPath}
      onLineClick={onLineClick}
      renderComposerForLine={renderComposerForLine}
      replyContext={replyContext}
    />,
  );

  if (line.type === 'hunk-header') {
    hunkCounter += 1;
    const annotations = annotationsForFile?.get(hunkCounter);
    if (annotations) {
      for (let aidx = 0; aidx < annotations.length; aidx++) {
        rows.push(
          <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
            <td colSpan={DIFF_TABLE_COLSPAN}>
              <AiHunkAnnotation annotation={annotations[aidx]} />
            </td>
          </tr>,
        );
      }
    }
  }
}

// Replace the existing <tbody>{allLines.map(...)}</tbody> with:
return (
  // ... existing outer wrapper ...
  <tbody>{rows}</tbody>
  // ...
);
```

(The exact code structure depends on the existing `DiffPane.tsx` body — read the file in context before rewriting. The principle is the same: walk `allLines` with a counter and inject annotation rows after matching hunk-header rows.)

- [ ] **Step 15.3: Typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: clean exit. If `prRef` isn't directly available in DiffPane today, the diff shows where to thread it through (either as a new prop from FilesTab or from a shared context).

- [ ] **Step 15.4: Run the full FileTree + DiffPane suites**

Run (from `frontend/`): `npx vitest run __tests__/FileTree.test.tsx __tests__/DiffPane.test.tsx`
Expected: all green. If DiffPane tests fail because they don't mock `useAiHunkAnnotations`, add the mock (`vi.mock('../src/hooks/useAiHunkAnnotations')` + `vi.mocked(...).mockReturnValue(null)` in `beforeEach`).

- [ ] **Step 15.5: Prettier + commit (folds Task 14 + Task 15)**

```bash
cd frontend
npm run prettier -- --write \
  src/components/PrDetail/FilesTab/FileTree.tsx \
  src/components/PrDetail/FilesTab/FileTree.module.css \
  src/components/PrDetail/FilesTab/FilesTab.tsx \
  src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx \
  __tests__/FileTree.test.tsx
cd ..
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx \
  frontend/src/components/PrDetail/FilesTab/FileTree.module.css \
  frontend/src/components/PrDetail/FilesTab/FilesTab.tsx \
  frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx \
  frontend/__tests__/FileTree.test.tsx
git commit -m "feat(ai): wire D32a FileTree focus dot + AiHunkAnnotation in DiffPane

§ 4.3 + § 4.4. FileTree:
- New focusEntries + aiPreview props on FileTreeProps
- Outer .file-tree-ai column slot always emitted with aria-hidden=true
  and data-on (collapses to width:0 when aiPreview off — prevents layout
  shift on toggle per handoff screens.css:580-581)
- Inner .fileTreeAiHigh (solid + glow) / .fileTreeAiMed (opacity 0.6)
  dots conditional on focus level (High or Medium); Low not rendered

DiffPane:
- useAiGate('hunkAnnotations') gates useAiHunkAnnotations fetch
- annotationsForFile Map<hunkIndex, HunkAnnotation[]> indexed locally
- hunkCounter walk emits <tr><td colSpan={3}><AiHunkAnnotation/></td></tr>
  after matching hunk-header rows
- DIFF_TABLE_COLSPAN = 3 verified vs DiffLineRow's td count"
```

---

### Task 16: UnresolvedPanel + StaleDraftRow wiring + CSS + test extension

**Files:**
- Modify: `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx`
- Modify: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx`
- Modify: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.module.css`
- Verify/Create: `frontend/__tests__/UnresolvedPanel.test.tsx` (extend OR create if absent)

- [ ] **Step 16.1: Check whether UnresolvedPanel.test.tsx exists**

Run: `ls frontend/__tests__/UnresolvedPanel.test.tsx 2>&1; ls frontend/__tests__/Reconciliation/ 2>&1`

Expected: report whether the file exists and where stale-draft assertions currently live.

- [ ] **Step 16.2a: Enumerate existing `DraftsSession` test fixtures FIRST**

Before writing any new test, locate the canonical `DraftsSession` fixture in the existing test suite — copying a real fixture beats inventing one. Run:

```bash
grep -rln "draftComments:" frontend/__tests__/ | head -5
```

Pick the most complete fixture (typically the one used by the largest UnresolvedPanel-adjacent test). Copy its shape verbatim into `buildSessionFixture()` for the new tests. The `as never` casts in the snippet below are placeholders only — they MUST be replaced with the actual session-fixture shape from this step before the test will run cleanly.

- [ ] **Step 16.2b: Write/extend the test**

If `UnresolvedPanel.test.tsx` doesn't exist, find where `StaleDraftRow` is currently covered (`grep -rn "StaleDraftRow" frontend/__tests__/`) and append to that file. Add:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnresolvedPanel } from '../src/components/PrDetail/Reconciliation/UnresolvedPanel';
import { useAiGate } from '../src/hooks/useAiGate';
import { useAiDraftSuggestions } from '../src/hooks/useAiDraftSuggestions';

vi.mock('../src/hooks/useAiGate');
vi.mock('../src/hooks/useAiDraftSuggestions');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('UnresolvedPanel — StaleDraftRow AI suggestion (D48)', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiDraftSuggestions).mockReturnValue(null);
  });

  it('renders no .stale-ai when gate is off', () => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiDraftSuggestions).mockReturnValue(null);
    render(
      <UnresolvedPanel
        prRef={PR_REF}
        session={/* stale-draft session fixture with one comment at src/Calc.cs:5 */ buildSessionFixture()}
        onMutated={() => {}}
      />,
    );
    expect(screen.queryByTestId('stale-draft-ai-suggestion')).not.toBeInTheDocument();
  });

  it('renders .stale-ai with sparkles icon + "AI suggestion" label + body when suggestion matches anchor', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiDraftSuggestions).mockReturnValue([
      { filePath: 'src/Calc.cs', lineNumber: 5, body: 'Worth a comment here?' },
    ]);
    const { container } = render(
      <UnresolvedPanel
        prRef={PR_REF}
        session={buildSessionFixture()}
        onMutated={() => {}}
      />,
    );
    const ai = screen.getByTestId('stale-draft-ai-suggestion');
    expect(ai).toBeInTheDocument();
    expect(ai.querySelector('.ai-icon')).toBeInTheDocument();
    expect(ai.querySelector('.ai-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByText('Worth a comment here?')).toBeInTheDocument();
  });

  it('does NOT render .stale-ai when suggestion does not match the draft anchor', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiDraftSuggestions).mockReturnValue([
      { filePath: 'src/Other.cs', lineNumber: 99, body: 'Mismatched anchor.' },
    ]);
    render(
      <UnresolvedPanel
        prRef={PR_REF}
        session={buildSessionFixture()}
        onMutated={() => {}}
      />,
    );
    expect(screen.queryByTestId('stale-draft-ai-suggestion')).not.toBeInTheDocument();
  });
});

// Helper — build a minimal DraftsSession with one stale comment draft at
// src/Calc.cs:5 so the matching path renders. Reuse the project's existing
// session-fixture builder if one exists; this is the minimum stub if not.
function buildSessionFixture() {
  return {
    draftComments: [
      {
        id: 'draft-1',
        filePath: 'src/Calc.cs',
        lineNumber: 5,
        side: 'right',
        anchoredSha: 'abc',
        anchoredLineContent: 'x',
        bodyMarkdown: 'My draft body.',
        verdict: null,
        isStale: true,
      },
    ],
    draftReplies: [],
    // ... other DraftsSession fields as required by UnresolvedPanel's
    // counts.stale logic; verify the exact shape against
    // frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx
    // and the existing test fixtures in __tests__/.
  } as never;
}
```

**Important:** The `buildSessionFixture` helper must match the production `DraftsSession` shape. Use an existing test fixture from another spec rather than inventing one — search `frontend/__tests__/` for `draftComments:` to find a real example.

- [ ] **Step 16.3: Run to verify failures**

Run: `npx vitest run __tests__/UnresolvedPanel.test.tsx`

Expected: failures because the suggestion wiring doesn't exist yet.

- [ ] **Step 16.4: Wire `useAiDraftSuggestions` into `UnresolvedPanel`**

Add to imports in `UnresolvedPanel.tsx`:

```ts
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiDraftSuggestions } from '../../../hooks/useAiDraftSuggestions';
import type { DraftSuggestion } from '../../../api/types';
```

Inside `UnresolvedPanel`:

```ts
const draftSuggestionsEnabled = useAiGate('draftSuggestions');
const allSuggestions = useAiDraftSuggestions(prRef, draftSuggestionsEnabled);

const suggestionFor = useMemo(() => {
  if (!allSuggestions) return null;
  const m = new Map<string, DraftSuggestion>();
  for (const s of allSuggestions) {
    const key = `${s.filePath}:${s.lineNumber}`;
    if (!m.has(key)) m.set(key, s);
  }
  return m;
}, [allSuggestions]);
```

In the existing `<StaleDraftRow>` mapping (around line 156), add the `aiSuggestion` prop:

```tsx
{counts.stale.map((d) => (
  <StaleDraftRow
    key={d.data.id}
    prRef={prRef}
    draft={d}
    onMutated={onMutated}
    aiSuggestion={
      d.kind === 'comment' &&
      d.data.filePath != null &&
      d.data.lineNumber != null
        ? suggestionFor?.get(`${d.data.filePath}:${d.data.lineNumber}`) ?? null
        : null
    }
  />
))}
```

- [ ] **Step 16.5: Extend `StaleDraftRow` to render the AI suggestion**

Modify `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx`. Add to imports:

```ts
import type { DraftSuggestion } from '../../../api/types';
```

Extend `StaleDraftRowProps`:

```ts
interface StaleDraftRowProps {
  prRef: PrReference;
  draft: DraftLike;
  onMutated: () => void;
  aiSuggestion: DraftSuggestion | null;  // ← new
}
```

In the destructuring at the function entry:

```ts
export function StaleDraftRow({ prRef, draft, onMutated, aiSuggestion }: StaleDraftRowProps) {
```

In the JSX return, between `.stale-draft-row-preview` (`{previewBody(body)}`) and the first `<button>` action button, add:

```tsx
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

`aiSuggestion.body` renders as a React text node — never via `dangerouslySetInnerHTML` or markdown. The `DraftSuggestion` contract is plain string; any future rich-text rendering requires explicit security review.

- [ ] **Step 16.6: Append CSS rules to StaleDraftRow.module.css**

```css
/* PR9b-ai-gating § 4.5 — D48 closure. AI suggestion row matches handoff
   pr-detail.jsx:336-342 shape (icon + labeled body in flex container).
   Ports handoff screens.css:489-494. Parent `<li>` is rendered inside the
   `unresolved-panel-rows` list with column-direction flex; this rule does
   NOT use `flex: 1 1 100%` because the column-flex parent stacks block
   children naturally — `flex: 1 1 100%` would only matter inside a
   row-wrap parent. Verify the parent shape during implementation. */
.staleAi {
  display: flex;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
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

- [ ] **Step 16.7: Add `.ai-summary-label` global to `tokens.css`**

Production `tokens.css` does NOT currently define `.ai-summary-label` (verified — `AiSummaryCard.module.css` uses the camelCase module class `.aiSummaryLabel`, not the literal global). StaleDraftRow's JSX in this PR is the FIRST production consumer of the literal global class. Add to `frontend/src/styles/tokens.css` (ports handoff `screens.css:91`):

```css
.ai-summary-label {
  font-weight: 600;
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--accent);
}
```

Include `frontend/src/styles/tokens.css` in the Task 16.9 commit.

- [ ] **Step 16.8: Run tests**

Run: `npx vitest run __tests__/UnresolvedPanel.test.tsx`
Expected: 3 new tests pass + all existing UnresolvedPanel tests still green.

- [ ] **Step 16.9: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write \
  src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx \
  src/components/PrDetail/Reconciliation/StaleDraftRow.tsx \
  __tests__/UnresolvedPanel.test.tsx
cd ..
git add frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx \
  frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx \
  frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.module.css \
  frontend/src/styles/tokens.css \
  frontend/__tests__/UnresolvedPanel.test.tsx
git commit -m "feat(ai): wire D48 StaleDraftRow AI suggestion span

§ 4.5. UnresolvedPanel fetches DraftSuggestion[] via useAiDraftSuggestions
gated by useAiGate('draftSuggestions'). Suggestions indexed by
(filePath, lineNumber) anchor key match against DraftLike's comment
variant (reply drafts have no anchor — never match).

StaleDraftRow gains aiSuggestion prop + handoff-faithful shape:
- <div className='stale-ai ai-tint'> flex container
- <span className='ai-icon'> sparkles icon with aria-hidden=true
- <div className='ai-summary-label'> 'AI suggestion' label row
- <div>{aiSuggestion.body}</div> body text (React text node only — no
  dangerouslySetInnerHTML; markdown rendering would require security
  review)

CSS ports handoff screens.css:489-494."
```

---

## Phase 5: Sweep tightening (Tasks 17-18)

### Task 17: InboxPage 2-site migration + test extension

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx:20-21`
- Verify/Create: `frontend/__tests__/InboxPage.test.tsx`

- [ ] **Step 17.1: Check whether the InboxPage test exists**

Run: `ls frontend/__tests__/InboxPage.test.tsx 2>&1`

Expected: file exists OR file doesn't exist. If absent, create with the structure below.

- [ ] **Step 17.2: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboxPage } from '../src/pages/InboxPage';
import { useAiGate } from '../src/hooks/useAiGate';

vi.mock('../src/hooks/useAiGate');
vi.mock('../src/hooks/useInbox', () => ({
  useInbox: () => ({
    data: {
      sections: [],
      enrichments: {},
      lastRefreshedAt: '2026-01-01T00:00:00Z',
      tokenScopeFooterEnabled: false,
    },
    error: null,
    isLoading: false,
    reload: vi.fn(),
  }),
}));
vi.mock('../src/hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ hasUpdate: false, summary: '', dismiss: vi.fn() }),
}));

describe('InboxPage — useAiGate migrations', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReset();
  });

  it('calls useAiGate("inboxEnrichment") and useAiGate("inboxRanking")', () => {
    vi.mocked(useAiGate).mockReturnValue(false);
    render(<InboxPage />);
    const calls = vi.mocked(useAiGate).mock.calls.map((c) => c[0]);
    expect(calls).toContain('inboxEnrichment');
    expect(calls).toContain('inboxRanking');
  });

  it('hides the activity rail when inboxRanking gate is off', () => {
    // useAiGate returns true only for inboxEnrichment; false for inboxRanking.
    vi.mocked(useAiGate).mockImplementation((key) => key === 'inboxEnrichment');
    const { container } = render(<InboxPage />);
    expect(container.querySelector('[class*="ActivityRail"], [data-testid="activity-rail"]')).toBeNull();
  });

  it('shows the activity rail when inboxRanking gate is on', () => {
    vi.mocked(useAiGate).mockImplementation((key) => key === 'inboxRanking');
    const { container } = render(<InboxPage />);
    // The ActivityRail component should mount — adjust the selector to match
    // its actual root class or data-testid. If unsure, run the existing
    // ActivityRail tests to find the selector pattern.
    expect(container.querySelector('[class*="activity"], [class*="ActivityRail"], [data-testid="activity-rail"]')).not.toBeNull();
  });
});
```

- [ ] **Step 17.3: Run to verify failures**

Run: `npx vitest run __tests__/InboxPage.test.tsx`
Expected: failures because `InboxPage` still uses the old `capabilities?.inboxEnrichment` + `preferences?.ui.aiPreview` direct reads.

- [ ] **Step 17.4: Migrate InboxPage**

Replace `frontend/src/pages/InboxPage.tsx:17-21`:

```ts
  const { data, error, isLoading, reload } = useInbox();
  const updates = useInboxUpdates();

  const showCategoryChip = useAiGate('inboxEnrichment');
  const showActivityRail = useAiGate('inboxRanking');
```

Add import: `import { useAiGate } from '../hooks/useAiGate';`

Remove the now-unused `useCapabilities` and `usePreferences` imports + destructured calls. Verify no other usage in the file before removing.

- [ ] **Step 17.5: Run tests**

Run: `npx vitest run __tests__/InboxPage.test.tsx`
Expected: 3 passing tests.

- [ ] **Step 17.6: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write src/pages/InboxPage.tsx __tests__/InboxPage.test.tsx
cd ..
git add frontend/src/pages/InboxPage.tsx frontend/__tests__/InboxPage.test.tsx
git commit -m "feat(ai): migrate InboxPage gating to useAiGate (audit findings)

§ 4.6. Two sites:
- showCategoryChip: capabilities?.inboxEnrichment === true → useAiGate('inboxEnrichment')
  (adds aiPreview gate — was capability-only)
- showActivityRail: preferences?.ui.aiPreview === true → useAiGate('inboxRanking')
  (adds capability gate — was aiPreview-only)

Both migrations are no-ops behaviorally today (capabilities mirror
aiPreview on the wire). Documented in D112; reopener fires when backend
decouples capabilities."
```

---

### Task 18: AiSummaryCard.module.css comment rewrite (D110)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css:1-10`

- [ ] **Step 18.1: Rewrite the comment block**

Replace the existing 9-line header comment at lines 1-10 with:

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

No rule changes — only the trailing line of the comment changes (D24 → D110).

- [ ] **Step 18.2: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css
git commit -m "docs(ai): D110 — confirm smaller AiSummaryCard shape

§ 4.1 verdict-only adjudication. Comment header reference updates from
D24 (deferred) to D110 (confirmed). No CSS rule changes. Reversal cost
is one rule deletion if a future cohort signal disagrees."
```

---

## Phase 6: E2E + baselines (Tasks 19-20)

### Task 19: Playwright `ai-gating-sweep.spec.ts`

**Files:**
- Create: `frontend/e2e/ai-gating-sweep.spec.ts`

- [ ] **Step 19.1: Reference existing patterns**

Run: `ls frontend/e2e/ | head -20 && grep -l "page.route\|waitForResponse" frontend/e2e/*.ts | head -3`

Expected: list of existing e2e specs that use `page.route` mocking and `waitForResponse`. Reuse the mock helpers if any (`frontend/e2e/fixtures/preferences.ts` etc.).

- [ ] **Step 19.2: Write the spec**

```ts
// frontend/e2e/ai-gating-sweep.spec.ts
import { test, expect } from '@playwright/test';

// PR9b-ai-gating § 5.5. Single spec covering the off → on → off flow with
// all five AI-surface classes + InboxPage activity rail.

test('ai-gating-sweep: off → on → off shows/hides AI surfaces', async ({ page }) => {
  // Step 1: Register endpoint mocks BEFORE navigation (intercept-first pattern).
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 204 });
    } else {
      await route.continue();
    }
  });

  await page.route('**/api/pr/*/*/*/ai/summary', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: 'Refactor of Calc utilities.', category: 'Refactor' }),
    });
  });

  await page.route('**/api/pr/*/*/*/ai/file-focus', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { path: 'src/Calc.cs', level: 'high' },
        { path: 'src/Calc.Tests.cs', level: 'medium' },
      ]),
    });
  });

  await page.route('**/api/pr/*/*/*/ai/hunk-annotations', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Reads cleaner.', tone: 'calm' },
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Behavior shift.', tone: 'heads-up' },
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Possible regression.', tone: 'concern' },
      ]),
    });
  });

  await page.route('**/api/pr/*/*/*/ai/draft-suggestions', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        // Anchor matches the canned stale-draft fixture. Adjust the line number
        // to whatever Task 1 Step 1.1 surfaced — must match the canned anchor
        // for the suggestion to render.
        { filePath: 'src/Calc.cs', lineNumber: 5, body: 'Worth a comment here?' },
      ]),
    });
  });

  // Step 2: Land on PR detail (default fixture; aiPreview off).
  await page.goto('/pr/octo/repo/1/overview');

  // Step 3: Assert OFF-state — no AI surfaces visible.
  await expect(page.getByTestId('ai-summary-card')).not.toBeVisible();
  expect(await page.locator('[class*="fileTreeAiHigh"], [class*="fileTreeAiMed"]').count()).toBe(0);
  expect(await page.getByTestId('ai-hunk-annotation').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Ask AI' })).not.toBeVisible();
  await expect(page.getByTestId('stale-draft-ai-suggestion')).not.toBeVisible();

  // Inbox: navigate and assert no rail + single-column grid.
  await page.goto('/inbox');
  await expect(page.locator('[data-testid="activity-rail"], [class*="activity"]')).not.toBeVisible();

  // Step 4: Toggle aiPreview on via the header toggle.
  await page.goto('/pr/octo/repo/1/overview');
  const toggleResponse = page.waitForResponse('**/api/preferences');
  await page.getByRole('button', { name: /AI preview/i }).click();
  await toggleResponse;

  // Step 5: Assert ON-state — all surfaces visible.
  await expect(page.getByTestId('ai-summary-card')).toBeVisible();

  // Navigate to Files tab to see FileTree dots + DiffPane annotations.
  await page.getByRole('tab', { name: /Files/i }).click();
  expect(await page.locator('[class*="fileTreeAiHigh"]').count()).toBe(1);
  expect(await page.locator('[class*="fileTreeAiMed"]').count()).toBe(1);

  // Click the file matching the placeholder data.
  await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  // All three tone annotations render in DiffPane.
  expect(await page.getByTestId('ai-hunk-annotation').count()).toBe(3);
  await expect(page.locator('.chip-info', { hasText: 'Note' })).toBeVisible();
  await expect(page.locator('.chip-warning', { hasText: 'Behavior change' })).toBeVisible();
  await expect(page.locator('.chip-danger', { hasText: 'Concern' })).toBeVisible();

  // Ask AI button + stale-draft suggestion.
  await expect(page.getByRole('button', { name: 'Ask AI' })).toBeVisible();
  // Stale drafts live in the Drafts tab or the reconciliation panel — adjust
  // navigation to whichever surface the canned fixture exposes.
  await page.getByRole('tab', { name: /Drafts/i }).click();
  await expect(page.getByTestId('stale-draft-ai-suggestion')).toBeVisible();
  await expect(page.getByText('AI suggestion')).toBeVisible();
  await expect(page.getByText('Worth a comment here?')).toBeVisible();

  // Inbox activity rail.
  await page.goto('/inbox');
  await expect(page.locator('[data-testid="activity-rail"], [class*="activity"]').first()).toBeVisible();

  // Step 6: Toggle off; assert disappearance.
  await page.goto('/pr/octo/repo/1/overview');
  const offResponse = page.waitForResponse('**/api/preferences');
  await page.getByRole('button', { name: /AI preview/i }).click();
  await offResponse;
  await expect(page.getByTestId('ai-summary-card')).not.toBeVisible();
});
```

**Note on selectors:** several locator strings (`[data-testid="activity-rail"]`, the Drafts tab name, etc.) need verification against the actual production DOM. Run the spec against the dev server once, observe the failure (Playwright produces a screenshot + trace), and adjust selectors to match the actual rendered markup.

- [ ] **Step 19.3: Run the spec against the local dev backend**

Run (from `frontend/`):
```bash
npm run build
cd ..
dotnet run --project PRism.Web --launch-profile https &
sleep 5
cd frontend
npx playwright test e2e/ai-gating-sweep.spec.ts --project=prod
```

(Or follow whatever pattern other e2e specs in this repo use — likely a `npm run e2e` or similar. Verify before running.)

Expected: spec passes against the prod build. If a selector misses, the Playwright trace shows what to change.

- [ ] **Step 19.4: Prettier + commit**

```bash
cd frontend
npm run prettier -- --write e2e/ai-gating-sweep.spec.ts
cd ..
git add frontend/e2e/ai-gating-sweep.spec.ts
git commit -m "test(e2e): add ai-gating-sweep.spec.ts for off→on→off flow

§ 5.5. Single spec covering all five AI-surface classes:
- AiSummaryCard (Overview)
- FileTree High + Medium focus dots (Files)
- AiHunkAnnotation for all three tones (DiffPane)
- AskAiButton (PrHeader)
- StaleDraftRow AI suggestion (Reconciliation)
- ActivityRail (Inbox)

Mock-first registration eliminates the race window between toggle POST
and subsequent hook fetches. waitForResponse on /api/preferences
synchronizes assertions to the gate flip."
```

---

### Task 20: Re-capture 3 parity baselines

**Files:**
- Re-capture: `frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png`
- Re-capture: `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png`
- Re-capture: `frontend/e2e/__screenshots__/win32/pr-detail-reconciliation-panel.png`

- [ ] **Step 20.1: Identify the parity baseline spec**

Run: `grep -l "pr-detail-files-tree.png\|pr-detail-files-diff.png\|pr-detail-reconciliation-panel.png" frontend/e2e/*.ts`

Expected: locate `parity-baselines.spec.ts` or similar. Note the spec file path.

- [ ] **Step 20.2: Re-capture with `--update-snapshots`**

Run (from `frontend/`):
```bash
npx playwright test e2e/parity-baselines.spec.ts --project=prod \
  --update-snapshots \
  -g "pr-detail-files-tree|pr-detail-files-diff|pr-detail-reconciliation-panel"
```

(Substitute the actual spec file path from Step 20.1. The `-g` filter scopes to only the three affected baselines so other baselines don't re-capture incidentally.)

Expected: 3 PNG files updated. The baselines capture in `aiPreview: false` (default), so the new DOM additions (`.fileTreeAi` collapsed slot, no `AiHunkAnnotation` rows, no `.stale-ai` span) shouldn't visually shift the off-state baselines — verify on capture.

- [ ] **Step 20.3: Run the parity-baselines spec without `--update-snapshots` to confirm the new captures pass**

Run: `npx playwright test e2e/parity-baselines.spec.ts --project=prod -g "pr-detail-files-tree|pr-detail-files-diff|pr-detail-reconciliation-panel"`

Expected: 3 passing tests against the freshly captured baselines.

- [ ] **Step 20.4: Commit**

```bash
git add frontend/e2e/__screenshots__/win32/pr-detail-files-tree.png \
  frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png \
  frontend/e2e/__screenshots__/win32/pr-detail-reconciliation-panel.png
git commit -m "test(parity): re-capture 3 baselines after PR9b-ai-gating DOM additions

§ 5.6. Captures in aiPreview: false (default) so the new DOM (FileTree
.fileTreeAi collapsed slot, DiffPane unchanged off-state, StaleDraftRow
no-suggestion state) matches the existing visual surface. No new zones."
```

---

## Phase 7: Documentation (Task 21)

### Task 21: Append 6 new D-entries to the deferrals sidecar

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

- [ ] **Step 21.1: Locate insertion point**

The sidecar currently has sections PR1 through PR7 plus "Implementation-time deferrals — PR7". There are NO existing PR9b-density / PR9b-search top-level sections (those slices wrote their D-entries under different headers — confirm with `grep -n "^##" docs/specs/2026-05-29-design-parity-recovery-deferrals.md | tail -10`). Append the new `## PR9b-ai-gating — Selective wirings` section at the END of the file.

- [ ] **Step 21.2: Append the new section**

Append the following to the end of `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`:

```markdown

---

## PR9b-ai-gating — Selective wirings

### D106 — D28 iter-new-dot DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; D28 original deferral.
**Covers:** D28 — IterationTabStrip iter-new-dot wiring.
**Verdict rationale:** No backend `IterationDto.IsNew` flag exists. Adding it requires either a backend signal (would need design — what's "new"? Server-side: since last user visit? Last cluster computation? Frontend-side: relative to a session-tracked baseline?) OR a frontend-synthetic "newest iteration on first load" heuristic backed by `localStorage`/`sessionStorage`. Both paths are session-memory work whose right home is a separate design pass, not the AI-gating sweep. The dot was framed as AI in the handoff but is structurally a session-state signal, not an AI signal — conflating them muddies the sweep's purpose.
**Status:** DEFER-TO-V1.X.
**Reopener:** Backend `IterationDto.IsNew` flag added OR explicit cohort signal requesting iteration-recency indication.
**Cross-refs:** D28; D87; spec § 4.9.2.

### D107 — D48 stale-row AI suggestion — SUPERSEDED (wired in this PR)

**Source:** PR9b-ai-gating ce-doc-review pass 2026-05-31.
**Status:** CLOSED — the originally-planned D107 deferral premise (no `IDraftSuggester` seam exists) was empirically wrong. The seam, the `PlaceholderDraftSuggester` (returning canned data), and the `AiCapabilities.DraftSuggestions` wire flag all already exist. D48 was wired in this sub-PR — see § 4.5 of the PR9b-ai-gating spec.
**Cross-refs:** D48 (now closed); spec § 4.5.

### D108 — AiHunkAnnotation action buttons (Quote / Dismiss) DEFER-TO-V1.X

**Source:** PR9b-ai-gating brainstorm 2026-05-31; surfaced during AiHunkAnnotation rewrite design.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; handoff `.ai-hunk-actions` (`diff.jsx:139-142`, `screens.css:835`).
**Covers:** Handoff `<div className="ai-hunk-actions">` with two action buttons: "Quote in comment" + "Dismiss".
**Verdict rationale:** Quote requires composer-seed plumbing — `InlineCommentComposer` doesn't accept a `seed: string` prop today; threading one through requires touching the composer prop chain + the open-composer registry + the per-anchor draft session. Dismiss requires per-session dismissal state — no `dismissedAnnotations` set exists; building one is session-state design work parallel to D106. Both are cross-cutting V1.X work whose absence doesn't break the informational read of the annotation.
**Status:** DEFER-TO-V1.X. Annotation ships informational-only (sparkles icon + "AI" label + tone chip + body).
**Reopener:** Cohort signal requesting Quote-in-comment OR a session-state design pass lands the dismissal model.
**Cross-refs:** D87; D106 (parallel session-state shape).

### D109 — Endpoint per-PR vs seam per-hunk/per-file shape divergence

**Source:** PR9b-ai-gating brainstorm 2026-05-31; ce-doc-review adversarial pass sharpened the framing from "documentation note" to "contract violation."
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; `IHunkAnnotator.AnnotateAsync(prRef, filePath, hunkIndex)` seam interface.
**Reality:** The `IHunkAnnotator` seam method takes `(prRef, filePath, hunkIndex)` for v2 streaming / cost-control use. The v1 endpoint `GET /ai/hunk-annotations` returns all annotations for the PR in one fetch — calls the seam with empty path + 0 index; the placeholder ignores both args. `IFileFocusRanker.RankAsync` and `IDraftSuggester.SuggestAsync` take per-PR signatures already so their endpoints align cleanly. The hunk-annotator violation is real — a future v2 implementer that reads `filePath` for telemetry/validation silently breaks against the v1 endpoint.
**Verdict rationale:** A future v2 real-AI backend will want per-hunk fetches (real generation is expensive; per-PR pre-generation doesn't scale). The seam interface supports that shape; the v1 endpoint doesn't. The proper fix is V1.X-shaped — either widen the seam (add a per-PR `AnnotateAllAsync(prRef, ct)` overload alongside the existing per-hunk method) or split the endpoint per-file/per-hunk. The v1 endpoint comment names the debt at the call site.
**Status:** DEFER-TO-V1.X (endpoint redesign + seam-widening when real-AI backend ships).
**Reopener:** Real AI backend swap-in at the `IHunkAnnotator` seam.
**Cross-refs:** D87; D111; § 6.4; § 7.4.

### D110 — D24 verdict CONFIRMED smaller AiSummaryCard shape

**Source:** PR9b-ai-gating brainstorm 2026-05-31.
**Spec position:** § 4.9.2 — PR9b-ai-gating verdict; D24 original deferral.
**Covers:** D24 — AiSummaryCard active-shape parity delta (current smaller `.pr-ai-summary` shape vs handoff's larger `.overview-card-hero`).
**Verdict rationale:** No cohort signal in either direction at N=3; deferring to handoff parity awaits an actual cohort prompt. The current shape ships unchanged. The `AiSummaryCard.module.css` comment header rewrites to reference D110 (this entry) instead of D24, but no rule changes. Reversal is one rule deletion (drop `padding` + `border-radius` from `.aiSummaryCard`) — cheap if a future cohort surfaces growth pressure.
**Status:** CONFIRMED.
**Cross-refs:** D24; D87; § 4.9.2; § 6.4.

### D111 — Per-endpoint `IsSubscribed` gating on `/ai/*` family DEFER-TO-V1.X

**Source:** PR9b-ai-gating ce-doc-review security-lens + adversarial pass.
**Spec position:** § 4.9.2 — PR9b-ai-gating sweep scope; § 7.5 auth posture rationale.
**Reality:** The session-token middleware (`SessionTokenMiddleware.cs:59`) gates all `/api/*` paths including `/ai/summary` and the three new AI endpoints. Per-endpoint `IsSubscribed` check (the per-PR subscription presence check from `IActivePrCache.IsSubscribed`) is absent from `/ai/summary` and not added to the new endpoints.
**Verdict rationale:** `IsSubscribed` is a presence-not-identity check that protects write semantics against PRs the user never loaded. Read-only AI endpoints with no mutation side effects don't require it when the seam returns canned data — anyone gets the same placeholder. This reasoning ages badly when the seam swaps to real AI: the same endpoint path would surface PR-content-derived output to any session-authenticated caller.
**Status:** DEFER-TO-V1.X.
**Reopener (enforced):** Same trigger as D109 — real AI backend swap-in at any of the three seams. **The seam-swap PR MUST include the per-endpoint `IsSubscribed` gate in the same atomic merge** (mirroring the mutating-endpoint pattern). Inline `// D111` comments at each of the three new `app.MapGet(...)` calls in `AiEndpoints.cs` anchor the reopener in the code the implementer touches when swapping the binding.
**Cross-refs:** D109; § 7.5.

### D112 — `useAiGate` two-factor abstraction's behavioral payoff is post-decoupling

**Source:** PR9b-ai-gating ce-doc-review adversarial round 2.
**Spec position:** § 3.1 wire-coupling caveat; § 4.2 + § 4.6 framing.
**Reality:** Today, `CapabilitiesEndpoints.cs:13` returns `AllOn` xor `AllOff` based on `AiPreviewState.IsOn`, and `PreferencesEndpoints.cs:47` mirrors `aiState.IsOn = config.Current.Ui.AiPreview`. Every `useAiGate(key)` call returns the same value as `aiPreview` regardless of key. The two-factor abstraction is forward-compat scaffolding for backend capability decoupling.
**Verdict rationale:** Backend decoupling (per-user feature flags, A/B rollout of inbox ranking, real-AI seam-swap with cost-controlled per-capability rollout) is V1.X-shaped infrastructure work. The PR9b-ai-gating sweep ships the frontend gate shape now so that when the backend decouples, no frontend follow-up is required — the decoupling lands as a backend-only change. Two semantic-imprecision liabilities surface in advance: (1) `useAiGate('composerAssist')` for `AskAiButton` couples Ask AI with composer-assist; (2) `useAiGate('inboxRanking')` for the activity rail couples the rail's visibility with the ranking algorithm. Both are documented for cohort signal monitoring post-decoupling.
**Status:** DEFER-TO-V1.X.
**Reopener:** Backend capability decoupling lands. When `AiCapabilities` stops mirroring `AiPreviewState.IsOn`, re-evaluate the two key choices documented above; either confirm the coupling-by-name or add dedicated `askAi` / `activityRail` keys.
**Cross-refs:** § 3.1 coupling caveat; § 4.2 + § 4.6 key-choice rationale; D109 + D111 (real-AI swap pulls capability decoupling forward).
```

- [ ] **Step 21.3: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(ai): append D106 + D107-superseded + D108-D112 to deferrals sidecar

PR9b-ai-gating — Selective wirings section. Six new entries:
- D106: D28 iter-new-dot DEFER-TO-V1.X (session-state, not AI)
- D107: D48 SUPERSEDED — premise was false; D48 wired in this PR
- D108: AiHunkAnnotation Quote/Dismiss actions DEFER-TO-V1.X
- D109: endpoint per-PR vs seam per-hunk divergence
- D110: D24 verdict CONFIRMED (smaller shape)
- D111: IsSubscribed gating DEFER-TO-V1.X (atomic with seam swap)
- D112: useAiGate behavioral payoff is post-decoupling"
```

---

## Phase 8: Pre-push (Task 22)

### Task 22: Full pre-push checklist per `.ai/docs/development-process.md`

- [ ] **Step 22.1: Frontend lint (includes prettier --check)**

Run (from `frontend/`): `npm run lint`
Expected: clean exit. If prettier reports unformatted files, run `npm run prettier -- --write <file>` and re-stage.

- [ ] **Step 22.2: Frontend build**

Run (from `frontend/`): `npm run build`
Expected: clean exit. Vite emits `wwwroot/` artifacts; chunk-size warnings are pre-existing.

- [ ] **Step 22.3: Frontend vitest full suite**

Run (from `frontend/`): `npm test -- --run`
Expected: all tests pass (pre-existing count + 6 new + 3 extended).

- [ ] **Step 22.4: Backend build**

Run (from repo root): `dotnet build --configuration Release`
Expected: 0 errors.

- [ ] **Step 22.5: Backend test full suite**

Run: `dotnet test --no-build --configuration Release -v minimal`
Expected: all tests pass (pre-existing count + 9 new).

- [ ] **Step 22.6: Playwright `--project=prod`**

Run (from `frontend/`): `npx playwright test --project=prod`
Expected: all specs pass (including the new `ai-gating-sweep.spec.ts` and the re-captured parity baselines).

- [ ] **Step 22.7: Git status sanity**

Run: `git status` and `git log main..HEAD --oneline`
Expected: clean working tree; the PR body should reference the spec + sidecar entries. Note the commits before pushing for the PR description.

- [ ] **Step 22.8: Report green pre-push checklist to orchestrator**

Pre-push verification is complete. **STOP here.** Surface the green checklist + the list of new commits (output of `git log main..HEAD --oneline`) to the orchestrator/user. The user (or the top-level Claude session) fires `pr-autopilot` from outside this plan's execution scope — `pr-autopilot` is a user-triggered skill and cannot be invoked from inside a subagent.

For subagent-driven-development: terminate at this step; return the green-check report. The orchestrator then invokes `pr-autopilot` as a separate skill dispatch.

---

## Self-Review

After writing this plan, fresh-eye check against the spec:

**Spec coverage:**
- § 2.1 in-scope items: backend endpoints (Tasks 2-4), gating hook (Task 7), 4 hooks (Tasks 8-10), 6 site migrations including 4 existing + 2 InboxPage (Tasks 11+17), 3 new surface wirings (Tasks 13-16), CSS changes (Tasks 13-16+18), tests (Tasks 7-10, 13, 14, 16, 17), placeholder alignment (Task 1), deferrals (Task 21). ✓
- § 2.2 out-of-scope items: D28, action buttons, per-hunk endpoint, IsSubscribed gating — all captured as deferrals, none accidentally implemented. ✓
- § 3.1 migration table 9 sites — Task 11 covers 4, Task 15 wires FileTree + DiffPane, Task 16 wires UnresolvedPanel, Task 17 covers 2 InboxPage sites. ✓
- § 3.2 backend endpoints — Tasks 2, 3, 4. ✓
- § 3.3 frontend types — Task 5. ✓
- § 4.1 D110 verdict — Task 18. ✓
- § 4.2 AskAiButton — Task 11.3. ✓
- § 4.3 FileTree dot — Task 14. ✓
- § 4.4 AiHunkAnnotation — Task 13 + Task 15. ✓
- § 4.5 StaleDraftRow — Task 16. ✓
- § 4.6 InboxPage — Task 17. ✓
- § 4.7 PlaceholderData — Task 1. ✓
- § 5.1-5.5 tests — Tasks 7-10, 13, 14, 16, 17, 19. ✓
- § 5.6 baselines — Task 20. ✓
- § 6 validation — Task 22. ✓
- § 8 6 D-entries — Task 21. ✓

**Placeholder scan:**
- One literal placeholder remains in Task 1 Step 1.2 — the `/* TODO replace with Step 1.1 value */ 5` line number. The text explicitly says the implementer must replace it before committing. This is not a plan failure (the plan tells the implementer what to do); it's an information-flow dependency between Step 1.1 (find the value) and Step 1.2 (use the value). Acceptable.

**Type consistency:**
- `FocusLevel` defined in Task 5 → used in Tasks 8, 14. ✓
- `FileFocus` defined in Task 5 → used in Tasks 8, 14, 15. ✓
- `AnnotationTone` defined in Task 5 with 3 values → matched in Task 13's TONE_CHIP map (3 entries: calm/heads-up/concern). ✓
- `HunkAnnotation` defined in Task 5 → used in Tasks 9, 13, 15. ✓
- `DraftSuggestion` defined in Task 5 → used in Tasks 10, 16. ✓
- `useAiGate` signature `(key: keyof AiCapabilities): boolean` consistent across creation (Task 7) and all migration sites. ✓
- `DIFF_TABLE_COLSPAN = 3` referenced consistently in spec § 4.4 and Task 15. ✓

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks (spec compliance + code quality), fast iteration.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints for review.
