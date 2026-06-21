# #323 item 3c — `PrState` enum with centralized parse (design)

**Issue:** #323 (epic #317, Theme C), item 3c. Sibling items 3a (typed `ReviewThreadNotFoundException`)
and 3b (MSAL comment) shipped in PR #573. Item 4c (`ConfigStore`) remains a separate follow-up.

**Classification:** **Gated (B2)** by owner choice. The change is effectively backend-internal
(see "Blast radius" below — no live frontend consumer reads any serialized PR-state string), but
it touches the active-PR poller path and a serialization boundary, so it retains the human spec
gate and **holds for owner merge** rather than auto-merging.

**Status:** approved design (user "lgtm" 2026-06-21). Backend-only.

---

## Problem

The concept "PR state" exists today as **three divergent stringly-typed representations** with
inconsistent casing, compared via fragile case-insensitive ordinal string equality:

| Representation | Casing | Where | Comparisons |
|---|---|---|---|
| `ActivePrPollSnapshot.PrState` | lowercase `open/closed/merged` | poller snapshot (`PRism.Core.Contracts/ActivePrPollSnapshot.cs:7`) | `ActivePrPoller.cs:135-136,148-149` (`OrdinalIgnoreCase`) |
| `Pr.State` | **uppercase** `OPEN/CLOSED/MERGED` | raw GraphQL value (`PRism.Core.Contracts/Pr.cs:14`) | derived into bools at `GitHubPrParser.cs:134,139` |
| `FakeReviewBackingStore.PrState` | uppercase | test/e2e fake (`PRism.Web/TestHooks/FakeReviewBackingStore.cs:56`) | `IsClosed`/`IsMerged` at `:57-58` |

Two independent parse sites (REST poller, GraphQL parser) normalize GitHub's state independently,
which is exactly why the casing diverged. The robustness finding is real: a typo or a new caller
that compares `== "Merged"` or `== "open"` against the wrong-cased source silently misclassifies a
PR's state. An enum makes the value set closed and the comparisons compiler-checked.

This is the "PrState ordinal/enum" half of #323 item 3 (the other halves — 3a/3b — shipped in #573).

## Blast radius — why this is not a functional wire-shape change

Every PR-state seam was traced. **No frontend consumer reads any serialized PR-state string:**

- **Detail surfaces** (`FilesTab.tsx:492`, `OverviewTab.tsx:74`, `DraftsTabRoute.tsx:7`) derive their
  lowercase `prState` from the **bools** `pr.isMerged` / `pr.isClosed`.
- **Inbox** (`InboxRow.tsx:64-65`) derives `doneState` from **timestamps** `pr.mergedAt` / `pr.closedAt`.
- `pr.state` is serialized on `PrDetailDto.Pr` but is **dead** — `grep` confirms zero FE reads of
  `pr.state` / `prDetail.pr.state`.
- `ActivePrPollSnapshot.PrState` never reaches the FE: it is internal to the poller and the SSE
  `state-changed` event carries only a PR ref + a changed-field list (`SseEventProjection.cs:33,70`),
  not the state value.

**No PR-state field is persisted to disk.** The poller state (`ActivePrPoller.cs:19` `_state`), the
active-PR cache (`ActivePrCache.cs:13`), and the PR-detail snapshot cache (`PrDetailLoader.cs:49`)
are all **in-memory `ConcurrentDictionary`** instances, reconstructed from GitHub on restart. There
is therefore **no on-disk backward-compatibility concern** — no old JSON file holds an uppercase
`"OPEN"` that a kebab-case enum read could fail on.

**The observable wire deltas (two, both unread):**
1. The dead `pr.state` JSON value on `PrDetailDto.Pr` flips `"OPEN"` → `"open"` (and `CLOSED`→`closed`).
   Zero FE consumers (grep-verified).
2. The `/test/set-pr-state` OK response body — `TestEndpoints.cs:365` returns `state = store.PrState` —
   flips the same way once `FakeReviewBackingStore.PrState` is the enum. Its only caller
   (`s5-submit.ts:159` `setPrState`) returns `void` and discards the body, so the flip is unobserved.

Both are read by no one; both are documented in the PR with the grep evidence so the wire-delta
accounting is complete (not just `pr.state`).

## Design

### Approach chosen (Option A — full + centralized parse)

Convert all three representations to one `PrState` enum, fed by a single parse helper that both
producers call. Rejected alternatives: (B) convert only the live-compared `ActivePrPollSnapshot`
field — leaves a second stringly field and two parse paths; (C) keep DTO fields as strings and map
at boundaries — barely removes the stringliness it targets.

### 1. The enum — `PRism.Core.Contracts/PrState.cs`

```csharp
namespace PRism.Core.Contracts;

public enum PrState { Open, Closed, Merged }
```

Serializes via the already-registered global `JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())`
(`PRism.Core/Json/JsonSerializerOptionsFactory.cs:45`) → `"open" / "closed" / "merged"`. `Open` is
the zero value, so a default-constructed snapshot reads as `Open` (matches today's fall-through).

### 2. Centralized parser

One normalization point — the only place a GitHub state string becomes a `PrState`:

```csharp
public static class PrStates
{
    // REST emits lowercase open/closed and reports a merged PR as "closed", so callers pass the
    // merge signal separately (merged_at present). GraphQL emits uppercase OPEN/CLOSED/MERGED.
    // This helper tolerates both casings and the literal "MERGED" string.
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

Unknown/null `rawState` with `merged == false` → `Open`. This preserves today's behavior
(`GitHubReviewService` already defaulted an empty REST state to `""` → treated as open).

### 3. Producers converge on the parser

- **REST** — `GitHubReviewService.PollActivePrAsync` (method at `:303`; snapshot construction `:324-330`, the
  `PrState` assignment at `:328`):
  `PrState: PrStates.FromGitHub(pull.State, pull.Merged)` (was `pull.Merged ? "merged" : pull.State`).
  `pull` is the raw `PollPullMeta` — its `State` stays a `string` (raw REST value); the enum conversion
  happens only here, at snapshot construction, so `PollPullMeta` needs no type change.
- **GraphQL** — `GitHubPrParser.ParsePr` (`:107-166`):
  ```csharp
  var prState = PrStates.FromGitHub(state, mergedAt.HasValue);
  // ...
  State: prState,
  IsMerged: prState == PrState.Merged,
  IsClosed: prState == PrState.Closed,
  ```
  `IsMerged`/`IsClosed` stay as positional record fields (the FE reads them — the live contract)
  but are now **derived from the enum**, making the enum the single source of truth. No ctor-arity
  churn. Rejected alternative: computed properties (removes the params) — churns every `new Pr(...)`
  call site and fixture for no wire benefit.

### 4. Comparison sites become typed

- `ActivePrPoller.cs:135-136` — `state.LastPrState is { } prev && prev != snapshot.PrState`
  (enum `!=`, was `OrdinalIgnoreCase`).
- `ActivePrPoller.cs:148-149` — `var isMerged = snapshot.PrState == PrState.Merged;`
  `var isClosed = snapshot.PrState == PrState.Closed;`.
- `ActivePrPollerState.LastPrState` (`:10`) — `string?` → `PrState?` (in-memory only; no persistence).

### 5. DTO field type changes

- `ActivePrPollSnapshot.PrState`: `string` → `PrState`.
- `Pr.State`: `string` → `PrState`.

### 6. Test fake / e2e seam

- `FakeReviewBackingStore.PrState`: `string` → `PrState`; `IsClosed`/`IsMerged` derive from it.
- `SetPrState(string state)` keeps its **string** input (the `/test/set-pr-state` request shape and
  `s5-submit.ts:159` are unchanged), parsing case-insensitively (`OPEN`/`open` both accepted) into
  the enum; unknown still throws → 400 (existing behavior at `TestEndpoints.cs:361`).
- `FakePrReader` returns the enum in both `Pr.State` (`:44`) and `ActivePrPollSnapshot.PrState`
  (`:176,179`). Note the non-scenario fallback at `:176` hard-codes the string `"OPEN"`
  (`new ActivePrPollSnapshot("", "", "UNKNOWN", "OPEN", 0, 0)`) — it becomes `PrState.Open`. The
  compiler flags it (CS1503) the moment `ActivePrPollSnapshot.PrState` is retyped; it is one of the
  ~26 string-literal construction sites below.

## Testing strategy (TDD)

| Test | Asserts |
|------|---------|
| `PrStates.FromGitHub` table (new, the heart) | REST `("open", false)`→Open, `("closed", false)`→Closed, `("open", true)`→Merged; GraphQL `("OPEN", false)`→Open, `("CLOSED", false)`→Closed, `("MERGED", false)`→Merged; `(null, false)`→Open, `("garbage", false)`→Open, `("Merged", false)`→Merged (case-insensitive). |
| `PrState` serialization lock (new) | `JsonSerializer.Serialize(PrState.Merged, apiOptions)` == `"\"merged\""` (and Open/Closed); guards against a numeric or wrong-casing regression on the one live-ish wire field. |
| `GitHubReviewServicePollActivePrTests` (update `:89,104,115`) | `snap.PrState.Should().Be(PrState.Open/Merged/Closed)` (was `.Be("open")`). |
| `GitHubPrParser` PR-state tests | `State`/`IsMerged`/`IsClosed` consistent for OPEN/CLOSED/MERGED + merged-at-while-closed. |
| Existing closed/merged e2e (`recently-closed-readonly`, `s5-submit-closed-merged-discard`) | unchanged — backstop that the read-only/discard behavior still works end-to-end. |

**Fixture surface (mechanical, compiler-enforced).** Retyping `Pr.State` and `ActivePrPollSnapshot.PrState`
breaks every string-literal construction site — ~26 across unit-test helpers, not just the three named
above: `ActivePrPollerBackoffTests`, `ActivePrPollerSubscriberFaultTests`, `ActivePrCacheTests`,
`PrDetailLoaderTests`, `PrDetailEndpointsTests`, `PrRefreshEndpointTests`, `SubmitEndpointFakes`, plus the
`FakePrReader:176` fallback. All are CS1503 compile errors the implementer fixes mechanically; none change
behavior.

**Behavior-equivalence note (GraphQL bools).** Today's `GitHubPrParser.cs:134,139` derive `IsMerged`/`IsClosed`
with `StringComparison.Ordinal` (case-sensitive `"MERGED"`/`"CLOSED"`); `FromGitHub` uses `OrdinalIgnoreCase`.
For real GitHub inputs — GraphQL `PullRequestState` is uppercase-only — the result is identical (the test
table locks every real case). The enum path is strictly *more* tolerant on malformed lowercase input; this is
a non-regression, not a faithful bit-for-bit re-expression, and is called out so a future reader doesn't
assume strict equivalence.

**No frontend test or type changes** — the FE never reads the state string. (Verified per the global
gotcha that a wire-value change can escape typed FE mocks: here the value is read nowhere, and e2e
route-mock bodies that include a `state` string remain harmless because nothing consumes it.)

## Acceptance criteria

- [ ] `enum PrState { Open, Closed, Merged }` exists in `PRism.Core.Contracts` and serializes
      kebab-case (`open`/`closed`/`merged`) through the API and Storage options.
- [ ] A single `PrStates.FromGitHub(rawState, merged)` is the only place a GitHub state string
      becomes a `PrState`; both REST and GraphQL producers call it.
- [ ] `ActivePrPollSnapshot.PrState`, `Pr.State`, `ActivePrPollerState.LastPrState`, and the test
      fake are `PrState`-typed. The only remaining string comparisons of PR state live **inside the
      single `PrStates.FromGitHub` helper** (unavoidable — GitHub hands us strings); every other site
      uses compiler-checked enum equality.
- [ ] `Pr.IsMerged` / `Pr.IsClosed` are derived from the enum (single source of truth) and remain
      on the wire unchanged for the frontend.
- [ ] The `/test/set-pr-state` request contract is unchanged (string in, case-insensitive parse);
      existing closed/merged e2e specs pass untouched.
- [ ] Both wire-value changes — `pr.state` `OPEN`→`open` on `PrDetailDto.Pr`, and the
      `/test/set-pr-state` response body's `state` field — are on fields with zero (resp. discarded) FE
      consumers, both documented in the PR.
- [ ] Backend build (Release, TreatWarningsAsErrors) and the full test suite are green.

## Risks & mitigations

- **Dead-field wire flips (`pr.state` OPEN→open on `PrDetailDto.Pr`, and the `/test/set-pr-state`
  response body).** Mitigation: grep-verified zero FE consumers (resp. discarded response body); both
  documented in the PR. No mitigation code needed.
- **e2e casing.** Mitigation: `SetPrState` keeps string input + case-insensitive parse; e2e specs
  untouched.
- **On-disk compat.** None — no PR-state field is persisted (all caches in-memory). Explicitly
  verified, not assumed.

## Out of scope

- Item 4c (`ConfigStore.HandleFileChangedAsync` unobserved-task-exception) — separate PR / #338.
- Any frontend refactor of the bool/timestamp-derived `prState` (works as-is; no reason to touch).
