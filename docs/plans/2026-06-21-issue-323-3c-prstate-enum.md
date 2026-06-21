# #323 item 3c — `PrState` enum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three divergent stringly-typed PR-state representations with one `PrState` enum fed by a single `PrStates.FromGitHub` parser, so PR-state comparisons become compiler-checked.

**Architecture:** Add `enum PrState { Open, Closed, Merged }` and `static PrStates.FromGitHub(string?, bool)` in `PRism.Core.Contracts`. Both producers (REST poller, GraphQL parser) call `FromGitHub`; the DTO fields (`Pr.State`, `ActivePrPollSnapshot.PrState`), the poller's in-memory `LastPrState`, and the e2e test fake all become enum-typed. Because C# requires every construction and comparison site to change together, the type flip is one atomic task after the foundation lands.

**Tech Stack:** .NET 10 / C#, xUnit + FluentAssertions, System.Text.Json with a global `JsonStringEnumConverter(KebabCaseJsonNamingPolicy)`.

**Source spec:** `docs/specs/2026-06-21-issue-323-3c-prstate-enum-design.md` (approved 2026-06-21).

## Global Constraints

- **Gated (B2):** drive the PR to green-and-ready, then HOLD for owner (@prpande) merge. Do NOT auto-merge.
- **Does NOT close #323:** items 3c-complete leaves item 4c open. Use bare `#323` / `Refs #323` only — NEVER a `close`/`fix`/`resolve` (+`s`/`d`/`es`/`ed`) keyword adjacent to `#323` in ANY polarity, in commit subjects, commit bodies, OR the PR body. Verify post-merge.
- **Build:** Release with `TreatWarningsAsErrors` + `AllEnabledByDefault` analyzers — zero warnings.
- **Tests:** full suite green via `dotnet test --settings .runsettings` (Core / Web / GitHub / Integration / AI).
- **One build/test command at a time, foreground, timeout ≥ 300000ms.** Never `run_in_background` for build/test.
- **Enum serialization is automatic:** the global converter (`PRism.Core/Json/JsonSerializerOptionsFactory.cs:31,44`, registered on BOTH Storage and Api options) renders `PrState` as kebab-case `"open"/"closed"/"merged"` — single-word members, so kebab == lowercase. No per-call-site serialization code.
- **Two unread wire-value flips** result and are documented in the PR (not blockers): (1) `pr.state` on `PrDetailDto.Pr` flips `OPEN`→`open` (zero FE consumers, grep-verified); (2) the `/test/set-pr-state` OK-response `state` field flips the same way (only caller `frontend/e2e/.../s5-submit.ts:159` returns `void`, discards the body).

---

### Task 1: `PrState` enum + `PrStates.FromGitHub` parser

The foundation. Compiles green on its own — no existing code depends on it yet.

**Files:**
- Create: `PRism.Core.Contracts/PrState.cs`
- Create: `PRism.Core.Contracts/PrStates.cs`
- Test: `tests/PRism.Core.Tests/Contracts/PrStatesTests.cs`

**Interfaces:**
- Produces: `enum PrState { Open, Closed, Merged }` (namespace `PRism.Core.Contracts`); `static class PrStates` with `static PrState FromGitHub(string? rawState, bool merged)`.

- [ ] **Step 1: Write the failing parser + serialization tests**

Create `tests/PRism.Core.Tests/Contracts/PrStatesTests.cs`:

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrStatesTests
{
    [Theory]
    // REST: lowercase state + separate merged flag (a merged PR reports REST state "closed").
    [InlineData("open", false, PrState.Open)]
    [InlineData("closed", false, PrState.Closed)]
    [InlineData("closed", true, PrState.Merged)]
    [InlineData("open", true, PrState.Merged)]
    // GraphQL: uppercase state, literal "MERGED", merged flag derived from mergedAt.HasValue.
    [InlineData("OPEN", false, PrState.Open)]
    [InlineData("CLOSED", false, PrState.Closed)]
    [InlineData("MERGED", false, PrState.Merged)]
    // Tolerant: case-insensitive, unknown/null → Open (matches today's fall-through).
    [InlineData("Merged", false, PrState.Merged)]
    [InlineData("garbage", false, PrState.Open)]
    [InlineData(null, false, PrState.Open)]
    public void FromGitHub_maps_rest_and_graphql_states(string? rawState, bool merged, PrState expected)
    {
        PrStates.FromGitHub(rawState, merged).Should().Be(expected);
    }

    [Theory]
    [InlineData(PrState.Open, "\"open\"")]
    [InlineData(PrState.Closed, "\"closed\"")]
    [InlineData(PrState.Merged, "\"merged\"")]
    public void Serializes_kebab_case_on_api_options(PrState value, string expectedJson)
    {
        JsonSerializer.Serialize(value, JsonSerializerOptionsFactory.Api).Should().Be(expectedJson);
    }

    [Fact]
    public void Serializes_kebab_case_on_storage_options()
    {
        JsonSerializer.Serialize(PrState.Merged, JsonSerializerOptionsFactory.Storage).Should().Be("\"merged\"");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~PrStatesTests"`
Expected: FAIL to compile — `The type or namespace name 'PrState' does not exist` / `'PrStates' does not exist`.

- [ ] **Step 3: Create the enum**

Create `PRism.Core.Contracts/PrState.cs`:

```csharp
namespace PRism.Core.Contracts;

// A PR's lifecycle state, normalized from GitHub's REST (lowercase + separate merged flag)
// and GraphQL (uppercase, literal "MERGED") representations. Serializes kebab-case
// ("open"/"closed"/"merged") via the global JsonStringEnumConverter. `Open` is the zero
// value, so a default-constructed snapshot reads as Open (matches the prior string fall-through).
public enum PrState
{
    Open,
    Closed,
    Merged,
}
```

- [ ] **Step 4: Create the parser**

Create `PRism.Core.Contracts/PrStates.cs`:

```csharp
namespace PRism.Core.Contracts;

// The single place a GitHub state string becomes a PrState. REST emits lowercase
// open/closed and reports a merged PR as "closed", so callers pass the merge signal
// separately (merged_at present). GraphQL emits uppercase OPEN/CLOSED/MERGED. This
// helper tolerates both casings and the literal "MERGED"; unknown/null → Open.
public static class PrStates
{
    public static PrState FromGitHub(string? rawState, bool merged)
    {
        if (merged || string.Equals(rawState, "merged", StringComparison.OrdinalIgnoreCase))
            return PrState.Merged;
        return string.Equals(rawState, "closed", StringComparison.OrdinalIgnoreCase)
            ? PrState.Closed
            : PrState.Open;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~PrStatesTests"`
Expected: PASS (all 13 cases).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core.Contracts/PrState.cs PRism.Core.Contracts/PrStates.cs tests/PRism.Core.Tests/Contracts/PrStatesTests.cs
git commit -m "feat(core): add PrState enum + PrStates.FromGitHub parser (#323)"
```

(Use a bare `#323`. No closing keyword — see Global Constraints.)

---

### Task 2: Atomic type conversion — DTO fields, producers, poller, test fakes, fixtures

C# will not compile a half-converted tree: the moment a field type flips, every construction/comparison site must flip with it. This task is therefore one commit. The compiler enumerates the sites (CS1503); the lists below are the complete set verified by grep — there are **no others**.

Two existing test families are the behavior backstops, updated test-first here:
- `GitHubReviewServicePollActivePrTests` (REST producer) — asserts `snap.PrState`.
- `GitHubReviewServicePrDetailTests.GetPrDetailAsync_isClosed_excludes_merged_prs` (GraphQL bool derivation) — asserts `Pr.IsClosed`/`Pr.IsMerged`; these stay green unchanged and prove the enum-derived bools match today's logic.

**Files:**
- Modify: `PRism.Core.Contracts/Pr.cs:14`
- Modify: `PRism.Core.Contracts/ActivePrPollSnapshot.cs:7`
- Modify: `PRism.Core/PrDetail/ActivePrPollerState.cs:10`
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs:129-136,148-149`
- Modify: `PRism.GitHub/GitHubReviewService.cs:328`
- Modify: `PRism.GitHub/GitHubPrParser.cs:128-166`
- Modify: `PRism.Web/TestHooks/FakeReviewBackingStore.cs:56-58,95,108,207-213`
- Modify: `PRism.Web/TestHooks/FakePrReader.cs:44,176,179`
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs:365` (verify only — no change needed)
- Modify (assertions): `tests/PRism.GitHub.Tests/GitHubReviewServicePollActivePrTests.cs:89,104,115`
- Modify (new behavior test): `tests/PRism.Web.Tests/TestHooks/FakeReviewBackingStoreTests.cs`
- Modify (fixtures — full list in Step 6)

**Interfaces:**
- Consumes: `PrState`, `PrStates.FromGitHub` from Task 1.
- Produces: `Pr.State : PrState`, `ActivePrPollSnapshot.PrState : PrState`, `ActivePrPollerState.LastPrState : PrState?`, `FakeReviewBackingStore.PrState : PrState`.

- [ ] **Step 1: Write the failing SetPrState parse test (the one piece of genuinely new behavior)**

`FakeReviewBackingStore.SetPrState` currently stores an uppercase string; it will parse a case-insensitive string into the enum and still throw on unknown (so an e2e typo surfaces as 400, not 500). Add a focused test. If `tests/PRism.Web.Tests/TestHooks/FakeReviewBackingStoreTests.cs` does not exist, create it; otherwise append these facts.

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class FakeReviewBackingStoreTests
{
    [Theory]
    [InlineData("OPEN", PrState.Open)]
    [InlineData("open", PrState.Open)]
    [InlineData("CLOSED", PrState.Closed)]
    [InlineData("merged", PrState.Merged)]
    public void SetPrState_parses_case_insensitively_into_the_enum(string input, PrState expected)
    {
        var store = new FakeReviewBackingStore();
        store.SetPrState(input);
        store.PrState.Should().Be(expected);
    }

    [Fact]
    public void SetPrState_derives_bools_from_the_enum()
    {
        var store = new FakeReviewBackingStore();
        store.SetPrState("MERGED");
        store.IsMerged.Should().BeTrue();
        store.IsClosed.Should().BeFalse();   // merged is not "closed without merging"

        store.SetPrState("CLOSED");
        store.IsClosed.Should().BeTrue();
        store.IsMerged.Should().BeFalse();
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("1")]
    public void SetPrState_throws_on_unknown_state(string input)
    {
        var store = new FakeReviewBackingStore();
        var act = () => store.SetPrState(input);
        act.Should().Throw<ArgumentException>();
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~FakeReviewBackingStoreTests"`
Expected: FAIL — the test project does not compile (CS-class error): `store.PrState` is still `string` here, so `.Should().Be(PrState.Open)` and the `PrState expected` theory parameter don't bind. The whole file is red until Step 6 retypes the property; the run cannot reach the throw/derivation assertions yet.

- [ ] **Step 3: Flip the three field/property types**

`PRism.Core.Contracts/Pr.cs:14` — change the positional parameter:

```csharp
    PrState State,
```
(was `string State,`)

`PRism.Core.Contracts/ActivePrPollSnapshot.cs:7`:

```csharp
    PrState PrState,
```
(was `string PrState,`)

`PRism.Core/PrDetail/ActivePrPollerState.cs:10`:

```csharp
    public PrState? LastPrState { get; set; }
```
(was `public string? LastPrState { get; set; }`. Add `using PRism.Core.Contracts;` if absent. In-memory only — never persisted, so no on-disk concern.)

- [ ] **Step 4: Convert the two producers to call `FromGitHub`**

`PRism.GitHub/GitHubReviewService.cs:328` (REST) — inside the `new ActivePrPollSnapshot(...)`:

```csharp
            PrState: PrStates.FromGitHub(pull.State, pull.Merged),
```
(was `PrState: pull.Merged ? "merged" : pull.State,`. `pull` is the raw `PollPullMeta`; its `State` stays `string` — the enum conversion happens only here, so `PollPullMeta` needs no change.)

`PRism.GitHub/GitHubPrParser.cs` — replace the inline bool derivation at `:134,139` and the `State:` assignment at `:151`. After `var state = GetStr("state");` (line 128) and the `mergedAt`/`closedAt` reads (130-133), replace lines 134-139:

```csharp
        var prState = PrStates.FromGitHub(state, mergedAt.HasValue);
        var isMerged = prState == PrState.Merged;
        // IsClosed means "closed without merging" — a separate state from merged.
        // Consumers that want "no longer open" should spell `IsMerged || IsClosed`.
        var isClosed = prState == PrState.Closed;
```

Then change the constructor's `State:` (line 151) from `State: state,` to:

```csharp
            State: prState,
```

Leave `IsMerged: isMerged,` / `IsClosed: isClosed,` (lines 158-159) as-is — they now read the enum-derived locals. The raw GraphQL `state` string is still used only as `FromGitHub`'s input.

- [ ] **Step 5: Convert the poller comparison sites**

`PRism.Core/PrDetail/ActivePrPoller.cs` — replace the casing-workaround comment (lines 129-134) and the comparison (135-136) with exact enum equality:

```csharp
                // Close-state transition (open → merged/closed). Both producers now hand an enum
                // PrState, so this is exact enum inequality — the prior case-insensitive string
                // compare (bridging fake-uppercase vs real-lowercase) is no longer needed.
                var stateChanged = state.LastPrState is { } prevState && prevState != snapshot.PrState;
```

Replace lines 148-149:

```csharp
                    var isMerged = snapshot.PrState == PrState.Merged;
                    var isClosed = snapshot.PrState == PrState.Closed;
```

(Remove the now-stale "may be lowercase/uppercase, compare case-insensitively" comment above them. `state.LastPrState = snapshot.PrState;` at :169 needs no change — both are now `PrState?`/`PrState`. Add `using PRism.Core.Contracts;` if absent.)

- [ ] **Step 6: Convert the test fakes**

`PRism.Web/TestHooks/FakeReviewBackingStore.cs`:

Property + derived bools (56-58):

```csharp
    public PrState PrState { get; private set; }
    public bool IsClosed => PrState == PrState.Closed;
    public bool IsMerged => PrState == PrState.Merged;
```

Seed + reset (95, 108) — both `PrState = "OPEN";` become:

```csharp
        PrState = PrState.Open;
```

`SetPrState` (207-213) — strict case-insensitive parse that preserves the OPEN/CLOSED/MERGED-only contract and the throw (do NOT use raw `Enum.TryParse`, which would also accept numeric strings like `"1"`):

```csharp
    public void SetPrState(string state)
    {
        ArgumentException.ThrowIfNullOrEmpty(state);
        PrState parsed = state.ToUpperInvariant() switch
        {
            "OPEN" => PrState.Open,
            "CLOSED" => PrState.Closed,
            "MERGED" => PrState.Merged,
            _ => throw new ArgumentException(
                $"Unknown PR state '{state}'; expected OPEN | CLOSED | MERGED.", nameof(state)),
        };
        lock (Gate) PrState = parsed;
    }
```

Add `using PRism.Core.Contracts;` if absent. The property `PrState` and the enum type `PrState` share a name; this compiles unqualified (verified under the repo's `TreatWarningsAsErrors` + `AllEnabledByDefault` config — C#'s "Color Color" rule, §7.6.4.1): `PrState.Open` binds to the type, `PrState ==` binds to the property. No `Contracts.` qualification needed.

`PRism.Web/TestHooks/FakePrReader.cs`:
- Line 44 `State: _store.PrState,` — no change (now both enum).
- Line 176 fallback: `new ActivePrPollSnapshot("", "", "UNKNOWN", "OPEN", 0, 0)` → `new ActivePrPollSnapshot("", "", "UNKNOWN", PrState.Open, 0, 0)`.
- Line 179: `_store.PrState` — no change (now both enum).
- Add `using PRism.Core.Contracts;` if absent.

`PRism.Web/TestHooks/TestEndpoints.cs:365` — `state = store.PrState` needs no change: the enum serializes kebab-case in the response body (documented unread flip #2). Verify it compiles; do not add `.ToString()`.

- [ ] **Step 7: Update the 3 REST-producer assertions**

`tests/PRism.GitHub.Tests/GitHubReviewServicePollActivePrTests.cs`:
- Line 89: `snap.PrState.Should().Be("open");` → `snap.PrState.Should().Be(PrState.Open);`
- Line 104: `.Be("merged");` → `.Be(PrState.Merged);`
- Line 115: `.Be("closed");` → `.Be(PrState.Closed);`

Add `using PRism.Core.Contracts;` if absent.

- [ ] **Step 8: Mechanical fixture sweep — convert every remaining string-literal site**

These are the remaining CS1503 sites (typed C# construction of `Pr` / `ActivePrPollSnapshot`). Mapping rule: `"OPEN"`→`PrState.Open`, `"CLOSED"`→`PrState.Closed`, `"MERGED"`→`PrState.Merged`, `"open"`→`PrState.Open`, `"closed"`→`PrState.Closed`, `"merged"`→`PrState.Merged`. Add `using PRism.Core.Contracts;` to each file if absent.

- `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs:26` — `"OPEN"` in `new(...)`.
- `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointFakes.cs:145` — `"OPEN"`.
- `tests/PRism.Web.Tests/Endpoints/PrRefreshEndpointTests.cs:17` — `"OPEN"` (Pr ctor positional).
- `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs:28` — `State: "OPEN",`.
- `tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs:63` — `"OPEN"`.
- `tests/PRism.Core.Tests/PrDetail/FakePrDetailReviewService.cs:27` — `"OPEN"`.
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSnapshotLogTests.cs:48` — `"OPEN"` (helper).
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs` — helper default param at `:27` (`string prState = "OPEN"` → `PrState prState = PrState.Open`) and call sites `:177,182,205,210,226,230` (`prState: "open"`/`"merged"`/`"closed"` → enum).
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSubscriberFaultTests.cs:20` — helper default param (same shape as Backoff `:27`).
- `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs` — helper `:25` (`State: isMerged ? "MERGED" : "OPEN"` → `State: isMerged ? PrState.Merged : PrState.Open`) and the `DefaultPollResponse = new ActivePrPollSnapshot(..., "OPEN", ...)` sites `:112,118,135,169,200,221,244,263,286,307,330,364,374`.

For any helper whose parameter type changes to `PrState`, update its default and all call-site argument literals together (the compiler points at each).

JSON-string fixtures DO NOT change — they are raw GitHub API bodies parsed by `GetStr("state")`, not typed construction. Leave untouched: every `"state": "OPEN"`/`"MERGED"`/`"CLOSED"` inside a JSON string in `GitHubReviewServicePrDetailTests.cs` (incl. the `[InlineData("OPEN"/"CLOSED"/"MERGED", ...)]` at `:253-255`, which feed raw strings into the parser), `GitHubReviewServicePollActivePrTests.cs:139`, and the `.json` fixture files. The `GetPrDetailAsync_isClosed_excludes_merged_prs` assertions on `Pr.IsClosed`/`Pr.IsMerged` (`:290-291`) stay unchanged and must remain green — they prove the enum-derived bools equal today's behavior.

- [ ] **Step 9: Build Release + run the full suite to verify green**

Run: `dotnet build -c Release` (timeout ≥ 300000ms)
Expected: 0 warnings, 0 errors.

Then: `dotnet test --settings .runsettings` (timeout ≥ 300000ms)
Expected: all green (Core / Web / GitHub / Integration / AI). The two backstop families pass: `GitHubReviewServicePollActivePrTests` (now enum assertions) and `GetPrDetailAsync_isClosed_excludes_merged_prs` (unchanged bool assertions).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(core): convert PR-state to PrState enum end-to-end (#323)"
```

(Bare `#323`. No closing keyword anywhere — Global Constraints.)

---

## Self-Review

**1. Spec coverage** — each spec section maps to a task:
- Spec §1 enum → Task 1 Step 3. §2 parser → Task 1 Step 4. §3 producers → Task 2 Steps 4. §4 comparison sites → Task 2 Step 5. §5 DTO field types → Task 2 Step 3. §6 test fake / e2e seam → Task 2 Steps 1,6. Testing-strategy table: FromGitHub table → Task 1 Step 1; serialization lock → Task 1 Step 1; `GitHubReviewServicePollActivePrTests` update → Task 2 Step 7; GraphQL bool consistency backstop → Task 2 Step 8 (kept green); closed/merged e2e backstop → Task 2 Step 9 + CI e2e gate. AC bullets → covered across both tasks. Out-of-scope (4c) → not touched.

**2. Placeholder scan** — no TBD/TODO; every code step shows complete before/after; the fixture sweep enumerates every site with an explicit mapping rule (no "etc.").

**3. Type consistency** — `PrState`, `PrStates.FromGitHub(string?, bool)`, `Pr.State : PrState`, `ActivePrPollSnapshot.PrState : PrState`, `ActivePrPollerState.LastPrState : PrState?`, `FakeReviewBackingStore.PrState : PrState` are used identically in every task. Member access `PrState.Open/Closed/Merged` matches the enum definition order (Open = zero value).

## Out of scope

- Item 4c (`ConfigStore.HandleFileChangedAsync` unobserved-task-exception) — separate PR / #338.
- Any frontend change — the FE derives PR-state from bools/timestamps and never reads the state string.
