# S4 — Drafts + composer (design)

**Slice.** S4 in [`../roadmap.md`](../roadmap.md). First slice where state mutations originate inside the app.

**Brainstorm output of:** 2026-05-09 brainstorming pass with the user.

**Implementation cycle.** This document is the design (spec). The implementation plan lands separately at `docs/plans/2026-05-09-s4-drafts-and-composer.md` after this spec passes human review.

**Reference axes.** Spec references in this document use the form `spec/0X-name.md § N`. Roadmap-references use `roadmap.md`. ADR references use `specs/2026-05-06-architectural-readiness-design.md § ADR-S4-N`.

---

## 1. Goals & non-goals

### 1.1 Goals

The slice ships the demo: *"Save drafts on a PR; quit and relaunch; drafts survive; classification fires correctly when a teammate pushes."* Concretely:

1. **Architectural prerequisites** (ADR-S4-1 + ADR-S4-2 land first, as a single PR, before any feature consumer):
   - `AppState.ReviewSessions` → `AppState.Reviews: PrSessionsState` (minimal wrap; no `InboxState` placeholder; no `Identity` wrapper).
   - Migration framework: ordered chain of `(toVersion, transform)` steps replacing the inline `if (stored == 1) MigrateV1ToV2(...)`. `Reviews` owns the per-version helpers.

2. **Draft schema additions** to `ReviewSessionState`: `DraftComments[]`, `DraftReplies[]`, `DraftSummaryMarkdown`, `DraftVerdict`, `DraftVerdictStatus`. Migration v2→v3 backfills empty collections.

3. **`PUT/GET /api/pr/{ref}/draft`** single-funnel endpoint per `spec/02-architecture.md` § wire shape.

4. **Reconciliation state machine** in `PRism.Core/Reconciliation/Pipeline/` implementing the seven-row matrix from `spec/03-poc-features.md` § 5, triggered by Reload.

5. **Composers**: inline-comment composer + reply composer + PR-root conversation reply composer + "Mark all read" button on Overview-tab conversation. Auto-save on keystroke (250 ms debounce). Markdown live-preview off-by-default for inline composers, on for the PR-summary textarea (S5's surface) — S4 only ships the inline + reply + PR-root composers.

6. **Drafts tab** activated (currently `DraftsTabDisabled`): flat list grouped by file with body preview, status badge, Edit / Delete / Jump-to actions; replies grouped by parent thread.

7. **Reconciliation `UnresolvedPanel`** sticky-top on every PR-detail tab (Overview / Files / Drafts) when stale drafts exist or verdict needs re-confirm.

8. **`IReviewEventBus` event publication**: typed `DraftSaved` / `DraftDiscarded` per write, *and* an umbrella `StateChanged(ref, fieldsTouched)` per write. Both shapes flow over `/api/events` SSE.

9. **Multi-tab consistency reconciler** subscribes to `state-changed` SSE, invalidates the affected slice in the per-tab cache, **preserves any open composer's body** per `spec/02-architecture.md` § Multi-tab consistency.

### 1.1a What this persistence pattern is NOT for (precedent boundary)

S4 lands the first user-mutating persistence pattern in PRism: auto-save through `PUT /draft`, server-mutex (`_gate`) serializing all writes, last-writer-wins between tabs, single `state.json` slot with versioned migrations. This shape is correct for **user-edited single-author content** (drafts, replies, summary, verdict — content the user composes and refines).

It is **deliberately wrong** for:
- **AI chat session state (P0+).** Chat sessions are append-only conversation transcripts (no edits), are by-design single-tab-active per `prismSessionId` (`spec/02-architecture.md` § ID generation), and have higher cost-of-loss (sunk LLM round-trips). Chat session state lives in `aiState.chatSessions[id]` per `spec/02 § State schema` and needs append-only semantics with per-session ownership, NOT last-writer-wins.
- **Token-usage counters (P0-6).** These are monotonically-increasing counters that need atomic increment, not load-mutate-save.
- **AI cache entries (P0-2).** Cache invalidation drives the lifecycle, not user intent; storage shape is per-key not per-PR.

Naming the divergence here prevents the P0+ implementer from reflexively reaching for the draft pattern. Each of those subsystems gets its own concurrency story when it lands.

### 1.2 Non-goals (deferred)

| Item | Defer to | Why |
|---|---|---|
| Submit Review button + GraphQL pending-review pipeline | S5 | Roadmap S4 row explicit. |
| `pendingReviewId` / `pendingReviewCommitOid` reads/writes | S5 | Idempotency keys for the submit retry path. |
| `DraftSubmitted` event publication | S5 | Type defined in S4; no producer in S4. |
| "Discard all drafts" on closed/merged PR (with `deletePullRequestReview` cleanup) | S5 | Couples to submit pipeline. Local-only suppression ships in S4 (banner + composer-disabled). |
| PR-reopen reconciliation + foreign-pending-review prompt | S5 | Pending-review concept is S5's. |
| Frontend types codegen (NSwag) | P0+ | ADR-P0-1; types stay hand-mirrored. |
| `IReviewService` capability split | S5 | ADR-S5-1; S4 uses `IReviewService.GetFileContentAsync` directly. |
| Multi-tab conflict notification UI | v2 backlog `P4-F9` | PoC accepts last-writer-wins silently. |
| AI-assisted reconciliation (`IDraftReconciliationAssistant`) | v2 (P0+) | PoC: stub returns null; slot renders nothing. |
| `<AiComposerAssistant>` "Refine with AI ✨" visible behavior | v2 (P0+) | Slot exists; capability flag false; renders null. |
| Multi-line / range comments | v2 backlog | `spec/03-poc-features.md` § 4 explicit. Reconciliation matrix doubles in dimensionality; expanding before single-line is dogfooded is premature. |
| `details/summary`/`kbd`/`sub`/`sup` HTML in markdown | v2 backlog `P4` | Strict no-HTML stance kept; `spec/03-poc-features.md` § 4 documents the gap. |

---

## 2. AppState wrap + migration framework (PR1)

### 2.1 Wrap rename (ADR-S4-1)

Minimal shape — only what migration locality requires:

```csharp
public sealed record AppState(
    int Version,
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost,
    UiPreferences UiPreferences)
{
    public static AppState Default { get; } = new(
        Version: 3,
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null,
        UiPreferences: UiPreferences.Default);
}

public sealed record PrSessionsState(
    IReadOnlyDictionary<string, ReviewSessionState> Sessions)
{
    public static PrSessionsState Empty { get; } =
        new(new Dictionary<string, ReviewSessionState>());
}
```

**What we deliberately did NOT wrap:**
- `LastConfiguredGithubHost` stays top-level. No `Identity` wrapper. No consumer needs the abstraction.
- No `InboxState` placeholder. Inbox state is computed live; no persisted shape exists. Adding an empty record speculatively is YAGNI.
- `AiState` and `UiPreferences` already wrapped pre-S4 (no rename needed).

**Wire shape note.** JSON kebab-case from `JsonSerializerOptionsFactory.Storage` already maps `Reviews` → `reviews` and `Sessions` → `sessions`. The migration v2→v3 step renames `review-sessions` to `reviews` and nests `sessions` under it (see § 2.3).

### 2.2 Migration framework (ADR-S4-2)

Replace the inline `if (stored == 1) root = MigrateV1ToV2(root);` in `AppStateStore.MigrateIfNeeded` with an ordered chain:

```csharp
private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] Steps =
{
    (2, Migrations.MigrateV1ToV2),
    (3, Migrations.MigrateV2ToV3),
};

private JsonObject ApplyMigrationChain(JsonObject root, int storedVersion)
{
    foreach (var (toVersion, transform) in Steps)
    {
        if (toVersion > storedVersion && toVersion <= CurrentVersion)
            root = transform(root);
    }
    return root;
}
```

`MigrateIfNeeded` becomes:
1. Validate root-is-object, `version` field exists and is int (existing behavior).
2. If `stored > CurrentVersion` → set `IsReadOnlyMode`, run `EnsureCurrentShape`, return (existing behavior, expanded).
3. If `stored < 1` → throw `JsonException` (existing behavior).
4. Apply migration chain.
5. Run `EnsureCurrentShape` (renamed from `EnsureV2Shape`; same job — backfill optional fields added post-cut).
6. Set `IsReadOnlyMode = false`.

**File layout.** Migration helpers move out of `AppStateStore.cs` into `PRism.Core/State/Migrations/` so the store stays focused on file I/O:
- `Migrations/Migrations.cs` — `MigrateV1ToV2` (moved verbatim from `AppStateStore`), `MigrateV2ToV3` (new, see § 2.3).
- `Migrations/PrSessionsMigrations.cs` — per-subtree helpers called from the per-version steps. `MigrateV2ToV3` calls `PrSessionsMigrations.AddV3DraftCollections(JsonObject sessionsNode)` and `PrSessionsMigrations.RenameReviewSessionsToReviews(JsonObject root)`. Locality lives at the helper layer, not the dispatch layer.

`CurrentVersion` becomes `3` in `AppStateStore`.

**`EnsureCurrentShape` scope.** Backfills optional v3-shape fields that may be missing on a file written by a between-versions binary. Currently: `ui-preferences` (existing), nothing v3-specific (the v3 step always runs cleanly because v3 is the current version at land time).

### 2.3 `MigrateV2ToV3` step

**Pre-existing inconsistency to resolve in this migration.** Two production code paths today write into `state.ReviewSessions` with different key formats:
- `PRism.Web/Endpoints/PrDetailEndpoints.cs` uses `$"{owner}/{repo}/{number}"` (slash-separated, matching `PrReference.ToString()`).
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` uses `$"{owner}/{repo}#{number}"` (`#`-separated).

Both indices target the same `IReadOnlyDictionary<string, ReviewSessionState>` but never read each other's writes. PR1 picks the slash form as canonical (matching `PrReference.ToString()` and the existing draft-endpoint precedent), and `MigrateV2ToV3` includes a key-normalization pass: any session key matching the `#`-separated pattern is rewritten to the slash form (with collision handling: if both keys exist for the same PR, the slash-form entry wins and the `#`-form is dropped — losing only inbox-side bookkeeping that the inbox poller will repopulate). PR1 also updates `InboxRefreshOrchestrator` to use the slash form, so post-migration there is one writer convention.

Two transforms in order:

**A. Rename `review-sessions` → `reviews` and nest under `sessions`.**

Before (v2 wire shape):
```jsonc
{
  "version": 2,
  "review-sessions": { "owner/repo/123": { ... } },
  ...
}
```
After (v3 wire shape):
```jsonc
{
  "version": 3,
  "reviews": {
    "sessions": { "owner/repo/123": { ... } }
  },
  ...
}
```

**B. For each `reviews.sessions[*]`, backfill v3 fields:**
- `draft-comments: []`
- `draft-replies: []`
- `draft-summary-markdown: null`
- `draft-verdict: null`
- `draft-verdict-status: "draft"`

(Each draft inside `draft-comments` and `draft-replies` carries `is-overridden-stale: false` by default once the v3 collection is non-empty — but no v2 file has any drafts, so the migration's per-session backfill leaves the collections empty; the field default applies on first write.)

`pendingReviewId` / `pendingReviewCommitOid` already exist on `ReviewSessionState` (S5's idempotency keys, defined ahead) — no v3 changes touch them.

**Stamp** `version: 3` last.

**Failure semantics (mirrors v1→v2's policy).**
- Non-object root → `JsonException` → quarantine via the existing `LoadAsync` catch (preserves the corrupt file at `state.json.<ts>.corrupt-<random>` per S3's behavior).
- Non-object `review-sessions` value → `JsonException` → quarantine.
- A session entry whose value is not a JSON object → skip the entry (leave it as-is for the deserializer to trip on); the deserializer's failure quarantines the file. This matches v1→v2's existing forgiveness pattern.
- A session entry that already has a v3 field (e.g., a `draft-comments` key from a half-migrated file written by a crashed v3 binary) → preserve the existing value (do NOT overwrite). The migration step is idempotent on already-migrated entries.
- A session entry whose `draft-comments` exists but is not an array → `JsonException` → quarantine.
- Root already has a `reviews` key (signals a half-migrated v3 file with the rename done but the per-session backfill incomplete) → skip the rename step, run only the per-session backfill on `reviews.sessions[*]`.

### 2.4 Schema additions to `ReviewSessionState`

```csharp
public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,            // v3
    IReadOnlyList<DraftReply> DraftReplies,                // v3
    string? DraftSummaryMarkdown,                          // v3
    DraftVerdict? DraftVerdict,                            // v3
    DraftVerdictStatus DraftVerdictStatus);                // v3, enum default `Draft`

public sealed record DraftComment(
    string Id,                          // server-issued UUIDv4
    string? FilePath,                   // null for PR-root drafts
    int? LineNumber,                    // null for PR-root drafts
    string? Side,                       // "left" | "right" | "pr" (PR-root)
    string? AnchoredSha,                // null for PR-root drafts
    string? AnchoredLineContent,        // null for PR-root drafts
    string BodyMarkdown,
    DraftStatus Status,                 // Draft | Moved | Stale (see § 2.4 for ambiguity classification)
    bool IsOverriddenStale);            // user clicked "Keep anyway" on this draft at the current head; cleared on head shift (see § 5.5)

public sealed record DraftReply(
    string Id,
    string ParentThreadId,              // GraphQL Node ID `PRRT_...`
    string? ReplyCommentId,             // populated mid-S5; null in S4
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);            // see DraftComment field

public enum DraftVerdict { Approve, RequestChanges, Comment }
public enum DraftVerdictStatus { Draft, NeedsReconfirm }
public enum DraftStatus { Draft, Moved, Stale }
                                        // FreshAmbiguous / MovedAmbiguous are NOT enum members;
                                        // ambiguity surfaces via the badge fields on the
                                        // reconciliation result, not via DraftStatus, because
                                        // those classifications don't block submit.
```

**Naming clarification.** `DraftStatus` has three members. The seven-row matrix's "Fresh-but-ambiguous" and "Moved-ambiguous" classifications are render-only (persistent badges) and do not block submit per `spec/03-poc-features.md` § 5. They surface through `ReconciledDraft.AlternateMatchCount` (see § 3.2), not through `DraftStatus`. This keeps the type system honest: anything that's `DraftStatus.Stale` blocks submit; anything else doesn't.

**Type collision with existing contract DTOs — namespace placement.** `PRism.Core.Contracts/DraftComment.cs` and `PRism.Core.Contracts/DraftReply.cs` already exist with a different (incompatible) shape — they are the **submit contract** consumed by `DraftReview` (the GraphQL payload to GitHub) and have non-nullable anchor fields, no `Status`, and a `ThreadId` field on `DraftComment`. The S4 records declared above are **persisted state** types and live in `PRism.Core/State/` (alongside `ReviewSessionState`). They are distinct concepts: persisted state covers in-progress reviewer drafts (with reconciliation status); the contract covers the submit payload (no status — ready to ship). The S5 submit pipeline maps from `PRism.Core.State.DraftComment` to `PRism.Core.Contracts.DraftComment` at submit time. The PR1 implementer must NOT delete or edit the contract types; they remain as-is until S5 splits or augments them.

### 2.5 Tests (TDD, written first, ship in PR1)

`tests/PRism.Core.Tests/State/`:
- `MigrationStepTests.cs` — per-step:
  - `MigrateV1ToV2_AddsViewedFilesToEachSession` (existing behavior preserved).
  - `MigrateV2ToV3_RenamesReviewSessionsToReviewsSessions`.
  - `MigrateV2ToV3_BackfillsDraftFieldsPerSession`.
  - `MigrateV2ToV3_StampsVersion3`.
- `MigrationChainTests.cs` — full chain:
  - `LoadsV1File_AppliesV1ToV2_ThenV2ToV3_ResultIsV3`.
  - `LoadsV2File_AppliesOnlyV2ToV3_ResultIsV3`.
  - `LoadsV3File_AppliesNothing_ResultUnchanged`.
- `ForwardCompatTests.cs` — already exists for v2; extend:
  - `LoadsV4File_SetsReadOnlyMode_AppliesEnsureCurrentShape`.
- `AppStateRoundTripTests.cs` — wrap rename:
  - `SerializeAndDeserialize_ReviewsWrap_RoundTrips`.
  - `JsonShape_TopLevelKey_IsReviewsNotReviewSessions`.

**TDD discipline.** Each test is written red before its production code lands. The chain test in particular drives the framework shape — write it first, watch it fail, then build the `Steps` array and `ApplyMigrationChain` to make it pass.

**PR1 scope reality (NOT "no feature consumers").** The wrap rename forces a property rename `state.ReviewSessions.X` → `state.Reviews.Sessions.X` across every existing call site:
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — one read site.
- `PRism.Web/Endpoints/PrDetailEndpoints.cs` — six call sites including `state with { ReviewSessions = ... }` records-with-update expressions that become `state with { Reviews = state.Reviews with { Sessions = ... } }` (a different shape with its own forget-to-nest bug surface).
- `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs`, `AppStateStoreTests.cs`, `AppStateStoreMigrationTests.cs`, `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`, `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs` — fixture sites that hand-construct `AppState`.

PR1 is therefore **wrap rename + migration framework + V2→V3 step + every existing consumer site updated to the new shape + test fixtures rewritten + key normalization in `InboxRefreshOrchestrator`**. The "no feature consumers" framing in the brainstorm was wrong; the rename is a cross-module touch (~11 files). All-existing-tests-pass is the green light.

---

## 3. Reconciliation state machine (PR2)

### 3.1 Layout

Per Convention-1 in `specs/2026-05-06-architectural-readiness-design.md`, the state machine lives in its own pipeline folder:

```
PRism.Core/Reconciliation/
├── Pipeline/
│   ├── DraftReconciliationPipeline.cs      ← entry point
│   ├── Steps/
│   │   ├── FileResolution.cs               ← Step 1 (rename / delete / exists)
│   │   ├── LineMatching.cs                 ← Step 2 (exact / whitespace-equiv matchers)
│   │   ├── Classifier.cs                   ← seven-row matrix (table-driven)
│   │   └── ForcePushFallback.cs            ← anchored-SHA-unreachable branch
│   ├── IFileContentSource.cs               ← abstraction over "fetch file at SHA"
│   └── ReviewServiceFileContentSource.cs   ← concrete: wraps IReviewService.GetFileContentAsync
├── WhitespaceInsignificantExtensions.cs    ← allowlist literal, consumed by LineMatching
└── ReconciliationDtos.cs                   ← ReconciliationResult, ReconciledDraft, etc.
```

`DraftReconciliationPipeline.Reconcile` is the only public surface; the steps are `internal sealed`.

**Why `IFileContentSource` instead of taking `IReviewService` directly.** The pipeline is a unit testable in `PRism.Core.Tests` without booting a `WebApplicationFactory`. A fake `IFileContentSource` returning canned content per-`(filePath, sha)` keeps the matrix tests fast and deterministic. The S5 capability split (`IReviewService` → `IPrReader`) is a no-op for S4 since `GetFileContentAsync` already exists on `IReviewService`.

### 3.2 Result shape

```csharp
public sealed record ReconciliationResult(
    IReadOnlyList<ReconciledDraft> Drafts,
    IReadOnlyList<ReconciledReply> Replies,
    VerdictReconcileOutcome VerdictOutcome);

public sealed record ReconciledDraft(
    string Id,
    DraftStatus Status,                      // Draft | Moved | Stale
    string? ResolvedFilePath,                // updated on rename; null on PR-root drafts
    int? ResolvedLineNumber,                 // updated on move
    string? ResolvedAnchoredSha,
    int AlternateMatchCount,                 // 0 = exact unique; ≥1 = ambiguity badge
    StaleReason? StaleReason,                // null when Status != Stale
    bool ForcePushFallbackTriggered);        // for the "original commit was rewritten" badge

public sealed record ReconciledReply(
    string Id,
    DraftStatus Status,                      // Draft | Stale (replies don't move)
    StaleReason? StaleReason);

public enum StaleReason { FileDeleted, NoMatch, ParentThreadDeleted, ForcePushAmbiguous }
public enum VerdictReconcileOutcome { Unchanged, NeedsReconfirm }
```

`AlternateMatchCount`:
- 0 → no ambiguity badge.
- ≥1 → "Fresh-but-ambiguous" (when `Status = Draft` and original line matched) or "Moved-ambiguous" (when `Status = Moved` and re-anchored to closest).
- **Counting rule.** Counts only candidates of the matcher tier that produced the chosen anchor. If the classifier resolved via exact-match and 2 exact + 5 whitespace-equivalent matches exist, `AlternateMatchCount = 1` (one *other* exact match besides the chosen one). If the classifier resolved via whitespace-equivalent (no exact existed) and 4 whitespace-equivalent matches exist, `AlternateMatchCount = 3`. This keeps the badge user-meaningful: "N other places where the same content exists at the tier the algorithm trusted."

**Override propagation.** The classifier inspects `IsOverriddenStale` on the input draft. If the matrix would classify the draft as `Stale` AND the input has `IsOverriddenStale === true` AND the draft's `AnchoredSha` is reachable in the new commit graph (no force-push fallback), the classifier short-circuits to `Status = Draft` with `IsOverriddenStale` preserved. If the input draft would classify as anything other than `Stale` (Moved, etc.) — the file or content actually re-anchors — the classifier clears `IsOverriddenStale` to `false` (no longer needed; the matrix succeeded). On head shift (any `headSha` change since the override was set), `IsOverriddenStale` is cleared by the apply-result step (Phase 2 of § 3.3) before the matrix runs — the override only applies to one anchor state.

### 3.3 Trigger and persistence

New endpoint **`POST /api/pr/{ref}/reload`**:
- Auth: `X-PRism-Session` (existing S3 middleware).
- Body: `{ "headSha": "abc..." }` — the new head the user is reloading to.
- Backend:
  1. Load the current `AppState` via `IAppStateStore.LoadAsync` and read `state.Reviews.Sessions[refKey]` (with `refKey = PrReference.ToString()` per § 2.3 canonical form).
  2. Build `IFileContentSource` scoped to `(ref, headSha)`.
  3. `pipeline.ReconcileAsync(session, headSha, fileContentSource, ct)` → `ReconciliationResult`.
  4. `appStateStore.UpdateAsync(s => UpdateSessionWithResult(s, ref, result))` — replaces `DraftComments` and `DraftReplies` wholesale; flips `DraftVerdictStatus` per `VerdictOutcome`.
  5. `eventBus.Publish(new StateChanged(ref, fieldsTouched: ["draft-comments", "draft-replies", "draft-verdict-status"]))`.
  6. Returns the full updated `ReviewSessionDto` (saves the frontend a round-trip; reload is the user-perceived wait moment anyway).

**Reload via `POST` not `PUT`.** Reload is a *recompute and store* operation, not idempotent (the result depends on the head SHA at fetch time, which can change between two POSTs to the same URL). `PUT /draft` is for client-initiated edits per § 4.

**`IFileContentSource` cache lifetime + key.** Per single `Reconcile()` call. `Dictionary<(string FilePath, string Sha), string>` constructed at the top of the call, dropped at the end. Several drafts on the same file at the same SHA share the fetch. The cache key omits `PrReference` because `IFileContentSource` is constructed scoped to a single `(prRef, headSha)` pair (one per Reconcile call); a `ReviewServiceFileContentSource(IReviewService inner, PrReference prRef)` constructor captures `prRef` so the wrapper cannot be reused across PRs even if a future refactor lifts the cache.

**File-fetch concurrency + `_gate` discipline.** Reconciliation can fetch N files for a PR with many anchored drafts. To avoid holding `_gate` (which serializes all `state.json` writes) during multi-second GitHub fetches, `POST /reload` runs the pipeline in two phases:

1. **Phase 1 (no gate held):** Build `IFileContentSource`. Call `pipeline.ReconcileAsync(session, headSha, fileContentSource, ct)` to compute the result. File fetches happen in parallel (cap: 8 concurrent — bounded `SemaphoreSlim` inside the pipeline) with a per-fetch timeout (10 s). The pre-loaded session snapshot is the input.
2. **Phase 2 (gate held briefly):** Call `appStateStore.UpdateAsync(s => ApplyResult(s, ref, result))` to atomically write the result. The transform body is pure — it does not call into the pipeline.

**Head-shift detection between phases.** If the active-PR poller advances `headSha` between phase 1 and phase 2, the result is stale-relative-to-current-state. Phase 2's transform compares the request's `headSha` against the session's `LastViewedHeadSha`-equivalent at apply time; if they diverge (rare — requires a poll-fired update during the reload window), the apply is rejected and the endpoint returns `409 reload-stale-head` so the frontend can re-trigger reload against the now-current head.

**Reload double-click guard.** Frontend disables the Reload button while a reload is in flight. Backend rejects a second `POST /reload` for the same `prRef` while the first is in-flight: it returns `409 reload-in-progress` (per-PR `SemaphoreSlim` with `await semaphore.WaitAsync(0)` non-blocking try-acquire).

### 3.4 Tests (TDD, ship in PR2)

`tests/PRism.Core.Tests/Reconciliation/`:

**Matrix coverage.** `MatrixTests.cs` — table-driven, one case per row of `spec/03-poc-features.md` § 5's seven-row matrix:
1. Exact match at original line, no others → Fresh (silent re-anchor).
2. Exact match at original + N others → Fresh-but-ambiguous (badge).
3. Exact match elsewhere only (single) → Moved.
4. Multiple exact matches elsewhere, none at original → Moved-ambiguous (closest wins).
5. No exact, single whitespace-equiv → Fresh (silent).
6. No exact, multiple whitespace-equiv → Moved-ambiguous.
7. No match → Stale.

Plus the two history-rewriting force-push rows.

**Edge case fixtures** — separate file per concern to keep each focused:
- `ForcePushFallbackTests.cs` — anchored-SHA-unreachable branch; multi-match → Stale; single-match → Moved with ForcePushFallbackTriggered=true.
- `WhitespaceTests.cs` — CRLF↔LF flip on a single line; whitespace-only diff in `.cs` (allowlisted) vs `.py` (not allowlisted, falls back to exact).
- `RenameTests.cs` — file renamed (`renamed` status with `from_path` / `to_path`); rename-then-content-changed.
- `DeleteTests.cs` — file deleted (not renamed) → Stale (FileDeleted).
- `ReplyTests.cs` — parent thread deleted out-of-band → Stale (ParentThreadDeleted); parent thread still present → Draft.
- `VerdictReconfirmTests.cs` — verdict set + head SHA changed → NeedsReconfirm; head SHA unchanged → Unchanged.

**Boundary-permutation tests.** `BoundaryPermutationTests.cs` — covers the matrix-row interactions that single-row tests miss:
- Row 4 ∩ row 6: 2 exact-elsewhere + 5 whitespace-equivalent-elsewhere with no exact at original. Asserts row 4 wins (exact priority); `AlternateMatchCount = 1` (counting only exact).
- Row 2 ∩ row 6: exact at original + 1 exact elsewhere + 5 whitespace-equivalent. Asserts row 2 wins (Fresh-but-ambiguous); `AlternateMatchCount = 1`.
- Force-push + whitespace: anchored-SHA-unreachable + no exact in new file + multiple whitespace-equivalent matches. Asserts Stale (per `spec/03 § 5` history-rewrite-multi-match → Stale, NOT Moved-ambiguous).
- Rename + ambiguity: file renamed AND new path has multiple matches of `anchored_line_content`. Asserts step-1 resolves to renamed path, step-2 runs the ambiguity matrix on the new path.

**Override tests.** `OverrideStaleTests.cs`:
- `IsOverriddenStale_TrueAndAnchoredShaReachable_ClassifierShortCircuitsToDraft`.
- `IsOverriddenStale_TrueButForcePushFallback_ClassifierIgnoresOverride_StillStale` (force-push invalidates the original anchor reasoning; override doesn't apply).
- `IsOverriddenStale_TrueButContentNowMatches_ClassifierClearsOverride` (the override is no longer needed).
- `HeadShiftBetweenReloads_ClearsOverride` (Phase 2 apply-result step clears overrides before the matrix runs when `headSha` differs from the previous reload).

All tests use a fake `IFileContentSource` with canned `(filePath, sha) → content` map. No I/O.

---

## 4. Backend endpoint + bus events (PR3)

### 4.1 `GET /api/pr/{ref}/draft`

Returns the full review-session payload per `spec/02-architecture.md` § wire shape. Empty `ReviewSessionDto` if no session exists for the PR.

```csharp
public sealed record ReviewSessionDto(
    DraftVerdictDto? DraftVerdict,
    DraftVerdictStatusDto DraftVerdictStatus,
    string? DraftSummaryMarkdown,
    IReadOnlyList<DraftCommentDto> DraftComments,
    IReadOnlyList<DraftReplyDto> DraftReplies,
    IReadOnlyList<IterationOverrideDto> IterationOverrides,    // empty in S4 (S3 placeholder)
    string? PendingReviewId,                                    // S5 territory
    string? PendingReviewCommitOid,                             // S5 territory
    FileViewStateDto FileViewState);                            // mirrors ReviewSessionState.ViewedFiles
```

Lives in new file `PRism.Web/Endpoints/PrDraftDtos.cs` (sibling to `PrDetailDtos.cs`). Auth: `X-PRism-Session`.

### 4.2 `PUT /api/pr/{ref}/draft`

Body is `ReviewSessionPatch` — exactly one field set per request per `spec/02-architecture.md` § wire shape:

```jsonc
{
  // exactly ONE of:
  "draftVerdict": "approve" | "requestChanges" | "comment" | null,
  "draftSummaryMarkdown": "...",
  "newDraftComment": { "filePath": "...", "lineNumber": 42, "side": "right", "anchoredSha": "...", "anchoredLineContent": "...", "bodyMarkdown": "..." },
  "newPrRootDraftComment": { "bodyMarkdown": "..." },     // PR-root reply; null filePath/lineNumber/side="pr" on the persisted side
  "updateDraftComment": { "id": "uuid", "bodyMarkdown": "..." },
  "deleteDraftComment": { "id": "uuid" },
  "newDraftReply": { "parentThreadId": "PRRT_...", "bodyMarkdown": "..." },
  "updateDraftReply": { "id": "uuid", "bodyMarkdown": "..." },
  "deleteDraftReply": { "id": "uuid" },
  "confirmVerdict": true,                                  // flips draftVerdictStatus needs-reconfirm → draft
  "markAllRead": true                                      // sets lastSeenCommentId to highest existing-comment id
}
```

**`newPrRootDraftComment` as a separate patch kind.** PR-root drafts have no `filePath` / `lineNumber` / `anchoredSha` / `anchoredLineContent`. Conflating them with `newDraftComment` would force the wire shape to make every anchor field optional and the backend to validate "either all four are set or none are." A separate kind keeps the line-anchored shape clean and the discriminated union explicit on the frontend.

**Rejection cases:**
- Multi-field patch → `400 invalid-patch-shape` with `{ "error": "exactly one patch field must be set", "fieldsSet": [...] }`.
- Unknown patch kind → `400 unknown-patch-kind`.
- `updateDraftComment` / `deleteDraftComment` against missing `id` → `404 draft-not-found`. No state mutation; no event published.
- `newDraftReply` against `parentThreadId` not in the existing-comments cache → write succeeds. Reply is classified `Stale (ParentThreadDeleted)` at the next reconciliation pass per `spec/03-poc-features.md` § 4.
- `newDraftComment` with a `filePath` not present in the loaded `PrDetailSnapshot.Files` → `422 draft-file-not-in-diff` (mirrors S3's `GET /file` and `POST /viewed` enforcement). When `DiffDto.truncated` is true, allow the write but mark the draft `Status: Draft` with `AlternateMatchCount = 0` — reconciliation determines the true classification on next reload.
- `confirmVerdict` when status is already `Draft` → no-op success (idempotent). No event published.
- `markAllRead` when there are no existing comments → no-op success (see § 4.7 for cache-empty behavior).
- `markAllRead` for a `prRef` not in the active-PR subscription set → `404 not-subscribed` (see § 4.7).

**Body validation (mirrors S3's `POST /files/viewed` precedent):**
- `[RequestSizeLimit(16384)]` on the endpoint (16 KiB cap on the request body).
- `bodyMarkdown`: max 8192 chars (UTF-16 code units; matches `react-markdown`'s practical limits and ensures one keystroke can't push a single draft past the request cap). Reject with `422 body-too-large`.
- `filePath`: same canonicalization as S3 — max 4096 bytes; reject `..` segments, `.` segments, leading `/`, trailing `/`, empty path, NUL byte, C0/C1 control chars, backslash, non-NFC. Reject with `422 file-path-invalid` (matches the existing `/viewed/path-invalid` family).
- `anchoredSha`, `headSha`: must match `^[0-9a-f]{40}$` (SHA-1) or `^[0-9a-f]{64}$` (SHA-256). Reject with `422 sha-format-invalid`.
- `parentThreadId`: must match `^PRRT_[A-Za-z0-9_-]{1,128}$` (GraphQL Node ID format). Reject with `422 thread-id-format-invalid`.
- `bodyMarkdown` empty after `String.Trim()` → `400 body-empty` (per `spec/02-architecture.md` § "Body validation rules").

**Response shape.**
- `newDraftComment` / `newPrRootDraftComment` / `newDraftReply` → `{ "assignedId": "uuid" }`.
- All other patch kinds → empty body, `200 OK`.

### 4.3 `fieldsTouched` derivation

Per-patch-kind static map in `PrDraftEndpoints.cs`:

| Patch kind | `fieldsTouched` |
|---|---|
| `draftVerdict` | `["draft-verdict"]` |
| `draftSummaryMarkdown` | `["draft-summary"]` |
| `newDraftComment` / `updateDraftComment` / `deleteDraftComment` / `newPrRootDraftComment` | `["draft-comments"]` |
| `newDraftReply` / `updateDraftReply` / `deleteDraftReply` | `["draft-replies"]` |
| `confirmVerdict` | `["draft-verdict-status"]` |
| `markAllRead` | `["last-seen-comment-id"]` |

Reload (`POST /api/pr/{ref}/reload`) emits `["draft-comments", "draft-replies", "draft-verdict-status"]` (broader set; reconciliation can touch any).

### 4.4 Bus events

```csharp
// Per spec/04-ai-seam-architecture.md § IReviewEventBus. Only InboxUpdated and
// ActivePrUpdated exist as concrete records in PRism.Core/Events/ today; the four
// records below are added by PR3 (one file per record per existing convention).
public record DraftSaved(PrReference Pr, string DraftId) : IReviewEvent;
public record DraftDiscarded(PrReference Pr, string DraftId) : IReviewEvent;
public record DraftSubmitted(PrReference Pr) : IReviewEvent;       // declared, NOT published in S4
public record StateChanged(PrReference Pr, string[] FieldsTouched) : IReviewEvent;
```

**SSE serialization for `PrReference`.** Existing `SseChannel` serializes events with `JsonSerializerOptionsFactory.Api` (camelCase). The `PrReference` record (`PRism.Core.Contracts/PrReference.cs`) has `Owner`, `Repo`, `Number` fields; default serialization would emit `pr: { owner, repo, number }` — but spec § 4.5's wire-shape table specifies `prRef: "owner/repo/123"` (a single string). PR3 introduces a custom SSE projection: events are serialized to a wire-side record `{ prRef: PrReference.ToString(), ... }` rather than the raw `IReviewEvent` shape. The projection lives in `PRism.Web/Sse/` next to the existing channel; the projection is per-event-type and exhaustive (TS-side `never`-switch equivalent in C# via switch expression on `IReviewEvent`).

**S4 publication rules:**
- `DraftSaved` — published on `newDraftComment`, `newPrRootDraftComment`, `updateDraftComment`, `newDraftReply`, `updateDraftReply` (one per write, with the `assignedId` for new-* kinds).
- `DraftDiscarded` — published on `deleteDraftComment`, `deleteDraftReply` (one per write).
- `StateChanged` — published on **every** mutating write *and* on Reload (alongside the typed event when applicable). Co-fires with the typed event in the same `try` block after `UpdateAsync` returns.
- `DraftSubmitted` — type defined, no producer in S4 (S5 publishes from the submit pipeline).

**Publication-vs-`_gate` ordering contract (load-bearing for v2 subscribers).** Publication MUST occur **outside** `_gate` (`UpdateAsync` returns; `_gate` is released; events fire). Two consequences subscribers MUST treat as part of the contract:
- A subscriber may observe state newer than the published event implies (a second write between `UpdateAsync` returning and `Publish` running can already be visible). For `state-changed` invalidation that's harmless (refetch gets the latest); for typed `Draft*` consumers (v2 AI cache invalidation per spec/04 line 339-341) that's the same: invalidating against newer state is correct.
- A future maintainer MUST NOT move `Publish` inside the gate, because synchronous in-handler `UpdateAsync` calls would deadlock on `_gate`. The in-process `IReviewEventBus` impl (per spec/04 line 337) dispatches synchronously, so any subscriber doing `await appStateStore.UpdateAsync(...)` from inside its handler depends on publication being outside the lock.

### 4.5 SSE wire shape on `/api/events`

Existing S3 channel. New event names:

| SSE event name | Payload |
|---|---|
| `state-changed` | `{ "prRef": "owner/repo/123", "fieldsTouched": ["..."] }` |
| `draft-saved` | `{ "prRef": "owner/repo/123", "draftId": "uuid" }` |
| `draft-discarded` | `{ "prRef": "owner/repo/123", "draftId": "uuid" }` |

Existing event names (`pr-updated`, `inbox-updated`) unchanged. Frontend SSE plumbing today lives in `frontend/src/api/events.ts` (the `openEventStream` function plus a typed `EventPayloadByType` map keyed by event name); the React `useEventSource` hook is a thin wrapper that hands out the handle. To add the three new event names PR3 must:
1. Extend `EventPayloadByType` in `frontend/src/api/events.ts` with three new entries (defining the `StateChangedEvent`, `DraftSavedEvent`, `DraftDiscardedEvent` payload types).
2. Add the three names to the hardcoded `addEventListener` registration loop (currently `(['inbox-updated', 'pr-updated'] as const).forEach(...)`).
3. Define the new payload TS types in `frontend/src/api/types.ts` (see § 5.9 for the file path correction; types live under `api/`, not `types/`).

### 4.6 Concurrency

- Two `PUT /draft` writes against the same draft id within a poll window: `AppStateStore._gate` semaphore serializes; last-writer-wins per `spec/02-architecture.md` § Multi-tab consistency. Both tabs receive both `state-changed` events; both refetch and observe the second write's body. **No conflict UI in S4.** PoC accepts the imperfection; v2 backlog `P4-F9` reopens if reviewers report losing comments.
- A `PUT /draft` and a `POST /reload` racing on the same PR: `_gate` serializes. If reload runs second, it operates on the post-write state. If reload runs first, the write that follows targets the post-reconciliation draft set; if its target `id` was reclassified `Stale`, the write still applies (status doesn't block writes in the backend; only submit, which is S5). Both events fire.

### 4.7 Endpoint scope discipline (what S4 does NOT add)

- No `POST /api/pr/{ref}/submit` — S5.
- No bulk-discard endpoint — bulk discards in the reconciliation panel iterate `deleteDraftComment` / `deleteDraftReply` per id from the frontend; the backend just sees N writes.
- No `DELETE /api/pr/{ref}/draft/{id}` — discards go through `PUT` per `spec/02-architecture.md`.
- No `pendingReviewId` reads/writes — S5.

**`markAllRead` semantics.** Reads the highest existing-comment id from the in-memory cache populated by the active-PR poller (S3). The candidate set is **issue-comment IDs only** (`IssueCommentDto.Id: long`); review-thread comment Node IDs (`ReviewCommentDto.commentId: string` like `PRRC_…`) are excluded because (a) `ReviewSessionState.LastSeenCommentId` is `string?` but the inbox's `long.TryParse` round-trip in `InboxRefreshOrchestrator` (line 246 today) silently treats anything not parseable as long as "no last-seen value," which would zero out the inbox unread count if a Node ID landed here, and (b) "unread comments" in the inbox-badge sense means top-level PR conversation comments, not review-thread replies. Comparator: numeric max over `long` ids, written back as `id.ToString()`. If the cache contains zero issue-comment ids, `markAllRead` no-ops (returns 200 with no event); the frontend caller MAY suppress the no-op via per-call disable until the active-PR cache is non-empty (a `useFirstActivePrPollComplete` hook returns boolean ready), so a fast-clicking user does not repeatedly fire silently-no-op writes.

**`markAllRead` authorization scope.** `markAllRead` only applies to PRs in the user's active subscription set (the active-PR poller's subscription map, S3). A request for a `prRef` not in the active set returns `404 not-subscribed` rather than reading-and-no-op'ing — closes the drive-by-tab vector where a malicious page could spam `markAllRead` for arbitrary PRs pulled from the inbox.

### 4.8 Spec/02 update obligation (PR3)

The new patch kinds `newPrRootDraftComment`, `confirmVerdict`, and `markAllRead` are NOT in `spec/02-architecture.md` § Draft endpoint semantics today. PR3 includes a documentation edit to `spec/02-architecture.md` to add them to the wire-shape enumeration. Per the project's `.ai/docs/documentation-maintenance.md` rule, this edit lands in the same PR as the endpoint code, not deferred. The S4 spec already describes the wire shapes (§ 4.2) — PR3 mirrors them upstream.

### 4.9 Tests (TDD, ship in PR3)

`tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`:
- One test per patch kind: success path + assigned-id-returned (where applicable) + persisted-state-correct + event-published (using an in-memory `IReviewEventBus` capture).
- `MissingSessionToken_401_Unauthorized` — every patch kind tested for `X-PRism-Session` rejection (parameterized; one assertion per kind).
- `RejectsMultiFieldPatch_400_InvalidPatchShape`.
- `RejectsUnknownPatchKind_400`.
- `UpdateDraftCommentMissingId_404_DraftNotFound`.
- `DeleteDraftReplyMissingId_404_DraftNotFound`.
- `NewDraftCommentFilePathNotInDiff_422_DraftFileNotInDiff`.
- `NewDraftCommentBodyTooLarge_422_BodyTooLarge`.
- `NewDraftCommentFilePathInvalidCanonicalization_422_FilePathInvalid` — table-driven over `..`, `.`, leading `/`, NUL byte, control char, backslash, non-NFC.
- `NewDraftCommentInvalidShaFormat_422_ShaFormatInvalid`.
- `OverrideStaleAgainstNonStaleDraft_400_NotStale`.
- `OverrideStale_SuccessPath_PersistsField_PublishesStateChanged`.
- `MarkAllReadForUnsubscribedPr_404_NotSubscribed`.
- `ConfirmVerdictWhenAlreadyDraft_NoOp_NoEvent`.
- `MarkAllReadWhenNoExistingComments_NoOp`.
- `FieldsTouched_DerivationPerPatchKind` (table-driven, includes the new `overrideStale` kind).

`tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`:
- `Reload_RunsReconciliation_PersistsResult_PublishesStateChanged`.
- `Reload_ReturnsFullReviewSessionDto`.
- `Reload_DoubleClick_409_ReloadInProgress` (per-PR semaphore non-blocking try-acquire).
- `Reload_HeadShiftBetweenPhases_409_ReloadStaleHead` (poller advances headSha mid-reload).
- `Reload_FileFetchTimeout_AbortsAndLeavesStateUnchanged`.
- `Reload_FileFetchConcurrencyCappedAt8`.

`tests/PRism.Web.Tests/Concurrency/DraftRaceTests.cs`:
- `TwoParallelUpdateDraftComments_LastWriterWins_TwoEvents` — uses two `HttpClient`s against the same `WebApplicationFactory` and two `Task.Run` calls.

`tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs`:
- `PutDraft_PublishesStateChanged_FlowsToSseSubscribers`.
- `Reload_PublishesStateChanged_FlowsToSseSubscribers`.

---

## 5. Frontend (PR4 onwards)

### 5.1 Component tree additions

```
frontend/src/
├── components/PrDetail/
│   ├── DraftsTab/
│   │   ├── DraftsTab.tsx                       ← replaces DraftsTabDisabled
│   │   ├── DraftListItem.tsx                   ← per-draft row (preview / status badge / actions)
│   │   ├── DraftListEmpty.tsx
│   │   └── DiscardAllStaleButton.tsx           ← header action (only when staleCount ≥ 1)
│   ├── Composer/
│   │   ├── InlineCommentComposer.tsx           ← anchored to a diff line
│   │   ├── ReplyComposer.tsx                   ← anchored to a thread Node ID
│   │   ├── PrRootReplyComposer.tsx             ← Overview-tab "Reply to this PR" textarea
│   │   ├── ComposerMarkdownPreview.tsx         ← shared live-preview pane
│   │   └── useComposerAutoSave.ts              ← 250 ms debounced PUT hook
│   ├── Reconciliation/
│   │   ├── UnresolvedPanel.tsx                 ← sticky-top; renders on every tab
│   │   └── StaleDraftRow.tsx                   ← Show me / Edit / Delete / Keep anyway
│   └── DraftsBadge.tsx                         ← updates the Drafts-tab count
├── hooks/
│   ├── useDraftSession.ts                      ← GET /api/pr/{ref}/draft + plain-React cache + diff-and-prefer merge on SSE invalidation
│   ├── useDraftMutation.ts                     ← PUT helpers per patch kind
│   ├── useReconcile.ts                         ← POST /api/pr/{ref}/reload
│   ├── useStateChangedSubscriber.ts            ← multi-tab consistency reconciler
│   └── useCrossTabPrPresence.ts                ← BroadcastChannel-based "this PR is open elsewhere" banner
└── api/draft.ts                                ← typed wrapper around fetch (TS discriminated union → wire shape)
```

### 5.2 State architecture

Server is source of truth. Frontend cache is per-PR `ReviewSessionDto` held in **plain React state** inside `useDraftSession` (matching S3's `usePrDetail` precedent — `useState` + `useEffect` + a manual reload counter; the project does NOT use TanStack Query and S4 does not introduce it). The hook returns `{ session, status, refetch, mergeServer }`. SSE `state-changed` for matching `prRef` triggers `refetch()`, which fetches `GET /draft` and runs `mergeServer(serverSession)` (see § 5.7 for the diff-and-prefer merge that protects open composers).

### 5.3 Composer auto-save model

- Composer keeps `body` in local React state for instant typing.
- `useComposerAutoSave({ prRef, anchor, body })` debounces 250 ms. On debounce-fire:
  - If no `draftId` yet AND body trimmed length **≥ 3 chars** AND no in-flight create: `PUT /api/pr/{ref}/draft` with `newDraftComment` (or `newDraftReply` / `newPrRootDraftComment` per anchor kind). The hook holds an `inFlightCreate: Promise<assignedId> | null` while the create is in flight; subsequent debounces during the in-flight window `await` the promise rather than firing a second create. On 200, store `assignedId` in the composer's local state and clear `inFlightCreate`.
  - If `draftId` exists: `PUT` with `updateDraftComment` (or reply variant).
- The hook is the *only* path that mutates persisted draft state from the composer. Discard button calls `deleteDraftComment` / `deleteDraftReply` (only when `draftId` exists; if no draft was ever created, Discard just unmounts) and unmounts the composer.

**First-keystroke threshold.** Auto-save creation is gated on body trimmed length **≥ 3 chars**. Below that threshold, keystrokes accumulate locally only (no PUT). Rationale: protects against accidental drafts ("user opens composer, hits `f` while reaching for `j`, walks away → on return, finds a draft they don't recognize") without compromising the auto-save protection that real text needs. The threshold is small enough that any deliberate comment crosses it within 1-2 keystrokes; large enough to filter typos.

**`assignedId` race protection.** The `inFlightCreate` promise is the contract: between the first `newDraftComment` PUT firing and its 200 response, all subsequent auto-save debounces queue behind it. When the response arrives, the queued debounce (if any) fires once with the now-known `assignedId` as `updateDraftComment(assignedId, latestBody)`. This eliminates the duplicate-create class of bug (per `spec/02-architecture.md` § Multi-tab consistency, the backend is otherwise free to assign two ids for two parallel `newDraftComment` calls).

**Restore on reload.** After `Cmd/Ctrl+R` (or accidental tab close-and-reopen), `useDraftSession` rehydrates the session. Any draft with anchor info pre-fills its composer at the anchor with the saved body. No separate "in-flight composer" sidecar — the spec/03 § 4 concept collapses into the regular draft model with the threshold gate above as the boundary.

**Auto-save failure.** PUT fails: hook distinguishes by status code:
- **Network error / 5xx:** hook keeps the body in local state, marks the composer as "unsaved" with a small badge labeled `Unsaved — retrying on next keystroke`, retries on the next keystroke. No exponential backoff — keystroke cadence IS the retry cadence. If the user stops typing, the unsaved badge persists until either (a) the next keystroke triggers a successful retry, or (b) the user clicks Discard. Position: inline next to the Save button, same row as the discard.
- **404 from `updateDraftComment` / `updateDraftReply` (draft was deleted in another tab):** hook detects this is NOT a transient failure. Clears the local `draftId`, surfaces a modal: *"This draft was deleted in another tab. Re-create as a new draft? / Discard?"* On Re-create → fires `newDraftComment` with the current local body (gets a new id; preserves text). On Discard → unmounts the composer. The modal is dismissable only by one of the two actions (no Esc-to-dismiss; the user must choose, otherwise the composer is in an inconsistent state).
- **422 body validation rejection (e.g., `body-too-large`):** surface a per-composer banner with the validation error; do not retry. User edits the body to comply, next keystroke retries.

### 5.3a Composer Esc / Discard / "click another line" flow

Spec/03 § 4 specifies: `Esc` cancels (with discard prompt if non-empty); `Cmd/Ctrl+Enter` saves; clicking another line opens a "Discard or save current comment?" prompt before moving anchor. With the auto-save model, **the draft may already exist on disk** when these triggers fire. Behavior:

- **Esc on a composer with no `draftId`** (body never crossed the 3-char threshold OR pre-create): close composer, discard local state, no PUT.
- **Esc on a composer with `draftId`**: prompt *"Discard saved draft?"* — Discard → `deleteDraftComment(draftId)` then unmount. Cancel → keep composer open.
- **Click another line, no `draftId`**: same as Esc-no-draftId — close current composer, open new one at the new anchor, no PUT.
- **Click another line, with `draftId`**: prompt *"You have a saved draft on line N. Discard or keep it as you switch to line M?"* — Discard → `deleteDraftComment(draftId)` then move anchor. Keep → leave the existing draft saved (it lives in the Drafts tab and reappears if the user navigates back to line N), open new composer at line M.
- **Cmd/Ctrl+Enter, no `draftId`**: force-flush the auto-save (bypass the 3-char threshold; create the draft with whatever body length).
- **Cmd/Ctrl+Enter, with `draftId`**: force-flush the debounce (fire `updateDraftComment` immediately with the current body); on 200, the composer can be safely closed (close it; the user said "save").
- **Reload-blocked modal "Save as draft" branch when a draft already exists** (per spec/03 § 3): force-flush the debounce (`updateDraftComment` with current body); on 200, allow the reload to proceed. Same code path as Cmd/Ctrl+Enter.

### 5.3a Drafts tab + UnresolvedPanel role separation (intentional surface overlap)

A stale draft appears on two surfaces simultaneously: as a row in the Drafts tab (with Edit / Delete / Jump-to) and as a row in the `UnresolvedPanel` (with Show me / Edit / Delete / Keep anyway). This is intentional, with distinct roles:
- **`UnresolvedPanel`** = *call to action.* Sticky-top, always visible from any tab; only shows things blocking submit (stale drafts, verdict needs re-confirm). Goes away when nothing blocks.
- **Drafts tab** = *inventory.* Always-on home for "every draft I've written on this PR" — the canonical place to find a specific draft to edit, regardless of stale/clean status.

The action sets are deliberately different: `UnresolvedPanel` includes "Keep anyway" (only meaningful for stale) and "Show me" (the panel can sit far from the diff line); the Drafts tab includes only the "anywhere" actions. Implementation note: deletes from either surface call the same backend endpoint, so the other surface refreshes via `state-changed` SSE within ~50 ms.

### 5.4 Drafts tab content

- **Header bar.** "N drafts on M files" + "X stale" badge if `staleCount > 0` + `DiscardAllStaleButton` (only when `staleCount ≥ 1`; opens confirmation modal listing the count and first-three-line previews per `spec/03-poc-features.md` § 5; both `draftComments` and `draftReplies` included; modal sample preview labels each entry as `[thread on src/Foo.cs:42]` or `[reply on thread PRRT_…]`).
- **Body.** Drafts grouped by file (collapsible per-file group). Replies grouped by parent thread under a "Replies" subgroup at the bottom of each file's group (or under a file-less "PR-root replies" group when the parent thread is on the PR conversation). Per-row:
  - **Status chip** (always rendered): one of `Draft` / `Moved (line M → N)` / `Stale (reason)`. Rendered from `DraftStatus`.
  - **Ambiguity chip** (rendered when `AlternateMatchCount > 0` AND status is `Draft` or `Moved`): separate chip next to status — "Fresh-but-ambiguous (N+1 matches)" when status=Draft and original line matched, or "Moved-ambiguous (N candidates)" when status=Moved and re-anchored to closest. Orthogonal to status because ambiguity does not block submit.
  - **Override chip** (rendered when `IsOverriddenStale === true`): "User-overridden (was Stale)". See § 5.5 for the override mechanism.
  - Body preview (first 80 chars; rendered through the shared `MarkdownRenderer` component — see § 5.6 for the no-bare-`<ReactMarkdown>` rule).
  - Actions row: `Edit` / `Delete` / `Jump to file`.
- **`Edit` action mechanic.** Clicking `Edit` on a `DraftListItem` (or `StaleDraftRow` in `UnresolvedPanel` — same mechanic) navigates to `/files/<filePath>?line=<lineNumber>` (uses S3's existing deep-link). On arrival, the diff renderer scrolls to the line and dispatches a "open composer at this anchor with the existing draftId" event. If a composer for that draftId is already open in another tab (per the cross-tab presence channel — § 5.7a), show a small toast on the destination tab: *"This draft is being edited in another tab. Switch tabs or take over."* Take over → forces the other tab's composer to close (via BroadcastChannel message), opens this tab's composer with the current persisted body. PR-root drafts (no `filePath`) navigate to `/<owner>/<repo>/<number>` (Overview tab), scroll to the conversation section, open the `PrRootReplyComposer` with the existing draftId.
- **`Delete` confirmation copy.** When body is non-empty: small confirmation modal — title *"Discard this draft?"*, body shows the first 80 chars of the draft body, two buttons: `Cancel` (default focus) / `Discard` (destructive style). When body is empty: no confirmation — instant delete (defensive against the rare zero-body draft that survived the threshold somehow). Confirmation modal follows the same focus-management pattern as the discard-all modal (see § 5.5a).
- **Empty state** (`N == 0`). `DraftListEmpty` renders "No drafts on this PR yet. Open any line in the Files tab to start one."
- **Loading state.** While initial `GET /draft` is in flight: render a skeleton of the header bar plus 3 skeleton rows (matches the inbox skeleton pattern from S2). Do NOT render `DraftListEmpty` during loading — its copy ("No drafts on this PR yet…") is wrong while data is unknown.
- **Error state.** If initial `GET /draft` fails: render an inline error card — "Couldn't load drafts. [Retry]" — with the retry button calling `useDraftSession.refetch()`. Do NOT render the empty state in error condition.

### 5.5 Reconciliation `UnresolvedPanel`

Renders sticky-top on Overview / Files / Drafts when:
- `staleCount > 0` (excluding drafts where `IsOverriddenStale === true` — see Keep anyway below), OR
- `draftVerdictStatus === "needs-reconfirm"`.

Content:
- Summary line: "N drafts need attention · M moved · verdict needs re-confirm" (each clause omitted when its count is zero).
- One `StaleDraftRow` per stale draft (excluding overridden). Actions: `Show me` (cross-tab navigates to the diff and scrolls to the line; uses S3's `?line=` deep-link; sets focus on the diff line on arrival), `Edit` (per § 5.4 mechanic), `Delete` (per § 5.4 confirmation), `Keep anyway` (see below).
- Verdict re-confirm row when `draftVerdictStatus === "needs-reconfirm"`. Single click on the verdict picker calls `confirmVerdict` patch.

**Loading state.** While initial `GET /draft` is in flight (typically only on first mount of a PR-detail page), the panel renders nothing — it's sticky-top and "nothing to reconcile yet" is the correct null state during load. After load, normal logic applies.

**Error state.** If `GET /draft` fails, the panel renders nothing (the inline error in the Drafts-tab body covers the surface). Reload-specific failures (`POST /reload` 5xx, `409 reload-stale-head`, `409 reload-in-progress`) are surfaced by the banner above the panel, not inside it.

**Keep anyway — server-side override (corrects earlier S4 narrowing).** When the user clicks `Keep anyway` on a stale draft, the frontend issues `PUT /draft` with a new patch kind `overrideStale: { id }`. Backend sets `IsOverriddenStale = true` on the draft (a new field on `DraftComment` and `DraftReply`, default `false`). The reconciliation pipeline's classifier respects the flag: a draft that would otherwise classify as `Stale` is reclassified as `Draft` (with `IsOverriddenStale = true` preserved) so submit is unblocked. The `UnresolvedPanel` filters out overridden drafts from its `staleCount`. The Drafts-tab `DraftListItem` renders the override chip ("User-overridden (was Stale)") so the user can find and revisit the override later. **Override clears on head shift:** any time `headSha` changes (next Reload after a teammate push), the next reconciliation pass clears `IsOverriddenStale = false` on every draft (the override only applies to one anchor state — once the code changes again, the user must re-judge). This faithfully implements `spec/03-poc-features.md` § 5's "Keep anyway moves draft from `stale` to `draft` status — user accepts it might land on the wrong line; rare but allowed" semantics.

**Patch kind addition (consequence).** § 4.2 grows a tenth patch kind: `overrideStale: { id }` (no body other than id). `fieldsTouched` map (§ 4.3) gets entry `overrideStale` → `["draft-comments"]` (or `["draft-replies"]` if applied to a reply id). New rejection case in § 4.2: `overrideStale` against a draft whose `Status !== "stale"` → `400 not-stale`. Tests in PrDraftEndpointTests.cs cover happy path, not-stale rejection, and head-shift-clears-override.

### 5.5a Modal focus management (single rule for all modals)

S4 introduces three modals: per-row Delete confirmation, `DiscardAllStaleButton` confirmation, the "draft was deleted in another tab" recovery modal. All three follow the same accessibility pattern (defined once here, referenced everywhere):
- Focus moves to the modal's primary content (typically the first interactive element, default-focused button if the modal has destructive vs cancel choices) on open.
- Focus is trapped within the modal (Tab cycles within; Shift+Tab cycles backward; Esc closes via the cancel action where applicable).
- On close, focus returns to the element that triggered the modal.
- Modals carry `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` referencing the modal title.
- Default-focused button is the **cancel/safe** action (not the destructive one) for confirmations; for the delete-recovery modal there is no cancel — focus defaults to "Re-create" since preserving text is the safer default.

Implementation can use a single shared `Modal.tsx` primitive that bakes these rules in; all S4 modals route through it.

### 5.5b Keyboard navigation for `UnresolvedPanel`

The panel is sticky-top and contains interactive controls; keyboard reachability is not optional.
- Panel container: `role="region"`, `aria-label="Unresolved drafts"`, `tabindex="-1"` (focusable programmatically when the panel first appears, so a screen reader announces it).
- Per-row tab order: status badges → Show me → Edit → Delete → Keep anyway. Document order matches visual order (left to right).
- `Show me` action: when activated by keyboard, cross-tab navigation moves focus to the diff line in Files tab (focus the line container `tabindex="-1"` and call `.focus()`); a screen reader announces the line content.
- `aria-live="polite"` region inside the panel announces transitions: when `staleCount` drops to zero, announce *"All drafts reconciled."* When a new stale draft appears (post-Reload), announce *"N drafts need attention."*
- Discard / Keep anyway / Delete activations follow the modal-focus rules in § 5.5a.

### 5.5c Composer accessibility

- Composer container: `role="form"`, `aria-label` set to the anchor description (e.g., "Draft comment on src/Foo.cs line 42").
- `ComposerMarkdownPreview` pane (when toggled on): `role="region"`, `aria-label="Markdown preview"`. The preview is keyboard-focusable (Tab from the textarea moves focus to the preview pane); inside the preview, Tab continues to the Save / Discard buttons.
- Markdown preview toggle button: `aria-pressed` reflects on/off state; keyboard shortcut `Cmd/Ctrl+Shift+P` toggles it (consistent with VS Code's preview-toggle convention).
- Save button: when the composer body is empty, button is `aria-disabled="true"` with tooltip *"Type something to save."* Discard button: always enabled.

### 5.6 PR-root reply composer + Mark all read

**Roadmap-row citation.** Both surfaces are explicitly handed off to S4 from S3 per `docs/specs/2026-05-06-s3-pr-detail-read-design.md` line 1029: *"PR-root conversation reply composer + 'Mark all read' button on PR-root comments lands in S4 alongside the inline-comment composer."* They are in S4 scope, not pulled forward from elsewhere.

The Overview tab's existing `pr-conv-reply` button becomes a real composer (`PrRootReplyComposer`). Anchor is "PR root" (no file, no line). On first qualifying keystroke (per § 5.3 threshold): `newPrRootDraftComment` patch with `{ bodyMarkdown }`. The persisted shape is `DraftComment { FilePath: null, LineNumber: null, Side: "pr", AnchoredSha: null, AnchoredLineContent: null, BodyMarkdown, Status: Draft }`.

In S4 these drafts persist locally and render in the Drafts tab under a "PR-root drafts" group. **Submit wiring is S5** (S5 distinguishes by null anchor and submits via `addPullRequestReviewComment` path-less).

**"Mark all read"** button on the Overview-tab conversation header calls `PUT /draft` with `{ markAllRead: true }`. Backend sets `lastSeenCommentId` to the highest issue-comment id in the PR's in-memory cache (per § 4.7 comparator). Frontend invalidates the inbox row's unread badge via the existing `state-changed` `last-seen-comment-id` flow. Button is disabled until the active-PR poller has completed at least one fetch (`useFirstActivePrPollComplete` returns true) so a fast-clicking user does not silently no-op against an empty cache.

**Markdown rendering reuse rule (single point of truth).** Every render site for `bodyMarkdown` — composer live preview, `DraftListItem` body preview (first 80 chars), `StaleDraftRow` body display, the discard-all confirmation modal's first-three-line previews — uses the shared `MarkdownRenderer` component (already exists from S3, applies `react-markdown` v9+ with the `urlTransform` strict allowlist per `spec/03-poc-features.md` § 4). PR4-onwards code review checks: any new bare `<ReactMarkdown>` instantiation in the S4 PRs is a defect. A vitest `MarkdownRendererSecurity.test.ts` exercises a `javascript:` URL in `bodyMarkdown` and asserts the rendered output contains the URL as escaped text (not as an `href`). This test runs against every component that calls `MarkdownRenderer` (parameterized fixture).

### 5.7 Multi-tab consistency reconciler

Top-level `useStateChangedSubscriber` mounted at app root listens to SSE `state-changed`. On event:

1. Match `prRef` against open PR-detail tabs (each `PrDetailPage` registers itself in a context).
2. For each match, call `useDraftSession.refetch()` (the hook owns the merge — see below).
3. Composer text in the affected tab is preserved by the diff-and-prefer merge.

**Diff-and-prefer merge (replaces the earlier `OpenComposerRegistry` design).** When `refetch()` resolves, the merger walks the server `DraftComment[]` and the local `DraftComment[]`:
- For each id present in both: if the local body differs from server AND a composer for this id is currently mounted (the composer registers via `useDraftSession.registerOpenComposer(draftId)` on mount and unregisters on unmount), keep the local body; otherwise use server. This protects the open composer's keystrokes-in-flight from being overwritten by a refetch triggered by another tab's update.
- For each id present in server only (created elsewhere): add to local list as-is.
- For each id present in local only (deleted elsewhere): remove from local list. **Side effect:** if a composer is open for that id, the composer's next auto-save will hit `404 draft-not-found`, which triggers the recovery modal in § 5.3 ("This draft was deleted in another tab — Re-create / Discard?"). Tested by the new `useDraftSession_DraftDeletedElsewhere_TriggersRecovery` test in § 5.10.

The `registerOpenComposer` hook is just a `useEffect` on the composer that calls `session.registerOpenComposer(id)` on mount, returns the unregister cleanup. No new context — the registration set lives inside `useDraftSession`'s state.

**Why diff-and-prefer over the earlier registry approach.** The earlier `OpenComposerRegistry` context required a parallel registration lifecycle outside the cache, and *failed silently* in the deletion case (Tab A holds the open composer for a draft that Tab B deleted; the cache merger correctly preserves Tab A's body, but Tab A's next `updateDraftComment` 404s with no recovery path). The diff-and-prefer approach folds the registry into `useDraftSession` (one place, one lifecycle) AND surfaces deletion explicitly via the 404 recovery modal. Less infrastructure; better failure mode.

**Toast on out-of-band update (without composer).** When the merger detects a remote body change for a draft that has NO open composer, surface a one-time toast: *"Draft on src/Foo.cs:42 was updated from another tab."* This addresses the principle violation surfaced in product-lens review: under "Drafts are never silently dropped," even non-conflict updates from another tab are user-relevant changes that should be visible. The toast is non-blocking (auto-dismisses after 4 s); the user can find the changed draft in the Drafts tab. No toast for SSE events triggered by writes from this same tab (filtered via the SSE event's source-tab id, which the request handler echoes back in the event payload).

### 5.7a Cross-tab presence banner (P4 mitigation)

`useCrossTabPrPresence(prRef)` uses the browser `BroadcastChannel` API (channel: `prism:pr-presence:<prRef>`). On mount, the tab broadcasts `{ kind: "open", tabId }`. On receiving an `open` from a different `tabId`, the tab shows a non-dismissable banner *"This PR is open in another tab. Saves may overwrite each other."* with two actions: *"Switch to other tab"* (calls `BroadcastChannel.postMessage({ kind: "request-focus" })` — the other tab listens and `window.focus()`'s itself) / *"Take over here"* (broadcasts `{ kind: "claim", tabId }`; the receiving tab switches to read-only mode, disabling its composers and dimming its UI; the claiming tab clears its banner).

This is a *frontend-only* mechanism — backend has no knowledge of tab identity. It does NOT prevent the underlying race (two tabs CAN still write concurrently if the user dismisses or ignores the banner), but it surfaces the risk and offers a one-click resolution. Conflict-detection UI proper (P4-F9) remains v2.

Single-PR-single-tab is the common case. Multi-tab is uncommon enough that the banner is acceptable interaction cost when it does occur.

### 5.8 AI placeholder slots

| Slot | Location | Capability flag | S4 behavior |
|---|---|---|---|
| `<AiComposerAssistant>` | Inside `InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer` next to Save | `ai.composerAssist` | Renders null in PoC (flag stays false; Placeholder impl returns null content). |
| `<AiDraftSuggestionsPanel>` | Top of Drafts tab, above the list | `ai.draftSuggestions` | Renders null in PoC. |
| AI badge slot in `StaleDraftRow` | Per stale draft in `UnresolvedPanel` | `ai.draftReconciliationAssist` | Renders null in PoC. |

`/api/capabilities` doesn't change shape; the three new flags are added to the existing flag map (default `false`; toggled to `true` only when `ui.aiPreview === true` AND a future Placeholder impl exists — for S4, Placeholder impls are stubs returning null, so the slots render empty even with aiPreview on).

### 5.9 TypeScript types

`frontend/src/api/types.ts` hand-mirrored per S3 precedent (frontend codegen deferred to ADR-P0-1). The file already exists and houses the S2/S3 types; S4 extends it. The earlier brainstorm-output draft of this section referenced `frontend/src/types/api.ts` — that path does not exist; types live under `api/`.

New types added by S4:
- `ReviewSessionDto`, `DraftCommentDto`, `DraftReplyDto`, `IterationOverrideDto`, `FileViewStateDto`.
- `ReviewSessionPatch` as a discriminated union (`{ kind: "newDraftComment", payload: ... }`-style on the TS side; the backend still expects the spec-described "exactly one field set" wire shape — the union is a frontend-side construction the `api/draft.ts` wrapper unwraps before sending).
- `DraftStatus = "draft" | "moved" | "stale"` literal union.
- `DraftVerdict = "approve" | "requestChanges" | "comment"`.
- `DraftVerdictStatus = "draft" | "needs-reconfirm"`.
- SSE event payloads: `StateChangedEvent`, `DraftSavedEvent`, `DraftDiscardedEvent`.

**Wrapper exhaustiveness.** `api/draft.ts` exposes `sendPatch(patch: ReviewSessionPatch)` which switches on `patch.kind` and serializes to the wire's "exactly-one-field" shape. The switch ends in a `default: const _exhaustive: never = patch.kind; throw new Error(...)` exhaustiveness check so adding a new patch kind to the union without updating the wrapper produces a compile error. Tests in `frontend/__tests__/api/draft.test.ts` (new file) cover one round-trip per patch kind: TS-side discriminated union → wire shape with exactly that field set, no others. The exhaustiveness check is not directly tested (compile-time guarantee), but a test asserts that adding a fictitious `kind: "neverShipped"` would be caught (per the `// @ts-expect-error` pattern).

### 5.10 Tests (TDD)

**Vitest unit tests (`frontend/__tests__/`):**
- `useComposerAutoSave.test.ts`:
  - `Debounce_250ms_BatchesKeystrokes`.
  - `BodyBelow3Chars_NoPut_NoDraftCreated` (the threshold gate).
  - `BodyAt3Chars_FiresNewDraftComment`.
  - `EmptyComposer_NoPut_NoDraftCreated`.
  - `AfterAssignedId_SubsequentKeystrokesUseUpdateDraftComment`.
  - `InFlightCreate_QueuesSubsequentDebounce_NoDuplicateCreate` (assignedId race).
  - `Update404_TriggersDraftDeletedRecoveryModal_OffersReCreateOrDiscard`.
  - `Network5xx_KeepsLocalBody_MarksUnsaved_RetriesOnNextKeystroke`.
  - `Body422_SurfacesBannerError_NoRetry`.
- `useDraftSession.test.ts`:
  - `DiffAndPreferMerge_KeepsLocalBody_WhenComposerOpen`.
  - `DiffAndPreferMerge_AcceptsServer_WhenNoComposerOpen`.
  - `DraftDeletedElsewhere_RemovesFromLocalList`.
  - `OutOfBandUpdate_NoComposer_FiresToast`.
  - `OutOfBandUpdate_OwnTab_NoToast` (filtered by source-tab id).
- `useStateChangedSubscriber.test.ts`:
  - `StateChanged_DraftComments_InvalidatesDraftSession`.
  - `StateChanged_LastSeenCommentId_InvalidatesInboxBadge`.
- `useCrossTabPrPresence.test.ts`:
  - `OpenSamePrInTwoTabs_BothTabsShowBanner`.
  - `TakeOver_TransitionsOtherTabToReadOnly`.
- `api/draft.test.ts`:
  - One round-trip test per patch kind asserting wire-shape "exactly one field set."
  - `OverrideStale_AgainstNonStaleDraft_400NotStale` (server-side rejection round-trip).
- `DraftsTab.test.tsx`:
  - `RendersLoadingSkeleton_WhilePending`.
  - `RendersErrorCard_OnLoadFailure`.
  - `RendersEmptyState_WhenNoDrafts`.
  - `RendersDraftsGroupedByFile`.
  - `RendersStaleBadge_WhenStaleCountGtZero`.
  - `RendersOverrideChip_WhenIsOverriddenStale`.
  - `DiscardAllStaleButton_VisibleOnlyWhenStaleCountGtZero`.
  - `DiscardAllStaleConfirmModal_ListsCountAndPreviews`.
  - `EditAction_NavigatesToFilesTabAndOpensComposer`.
  - `DeleteAction_OpensConfirmation_FocusesCancel`.
- `UnresolvedPanel.test.tsx`:
  - `RendersOnEveryTab_WhenStaleCountGtZero`.
  - `HiddenWhenNoStaleAndNoVerdictReconfirm`.
  - `OverriddenStaleDraft_NotCountedTowardStaleCount`.
  - `VerdictReconfirmRow_FiresConfirmVerdictPatch`.
  - `KeepAnyway_FiresOverrideStalePatch_RowDisappears`.
  - `KeyboardNavigation_TabOrderMatchesVisualOrder`.
  - `AriaLive_AnnouncesStaleCountTransition`.
- `MarkdownRendererSecurity.test.ts`:
  - `JavascriptUrl_RendersAsEscapedText_NotHref` — parameterized over every component that calls `MarkdownRenderer` (composer preview, DraftListItem preview, StaleDraftRow body, discard-all modal preview).
- `Modal.test.tsx`:
  - `OnOpen_FocusMovesToDefaultButton`.
  - `TabKey_TrapsFocusInModal`.
  - `EscKey_ClosesViaCancelAction`.
  - `OnClose_FocusReturnsToTrigger`.

**Playwright E2E (`frontend/e2e/`):**
- `s4-drafts-survive-restart.spec.ts` — open PR → save inline draft → close browser → reopen → draft visible at anchor with body intact.
- `s4-reconciliation-fires.spec.ts` — save draft on iter-3 file → simulate iter-4 push (fixture) → click Reload → assert classification badges per matrix.
- `s4-multi-tab-consistency.spec.ts` — open same PR in two tabs → cross-tab presence banner appears in both → save draft in tab A → tab B's draft list refetches and shows it → open composer in tab B for a different draft → tab A's update of *that* same draft is held back from clobbering tab B's open composer.
- `s4-keep-anyway-survives-reload.spec.ts` — save draft on iter-3 → trigger Stale via fixture → click Keep anyway → click Reload → draft does NOT reappear in panel; remains visible in Drafts tab with override chip; appears again only after another head shift via fixture.

---

## 6. Closed/merged PR handling (S4 partial scope)

PR closure is detected by the active-PR poller (S3, returns `state` field). On `closed | merged`:

**In S4 scope:**
- PR-header banner: *"This PR is now {closed | merged}. Submitting a review is no longer possible."*
- Composer Save button disabled.
- Auto-save suppressed (`useComposerAutoSave` short-circuits when `prState !== "open"`).
- Per-composer banner: *"PR closed — text not saved."*
- Read-only behavior continues for everything else: file viewing, marking viewed, iteration tabs, opening drafts in the Drafts tab.

**Deferred to S5:**
- "Discard all drafts" button + `deletePullRequestReview` courtesy cleanup. Couples to `pendingReviewId`, which is S5's idempotency key.
- PR-reopen reconciliation + foreign-pending-review prompt. Pending-review concept is S5's.

**Drafts on a closed PR are NOT auto-discarded.** They stay in `state.json` per `spec/03-poc-features.md` § 5. On PR reopen, the next active-PR poll lifts the banner; reconciliation runs at the next user-clicked Reload (standard path).

---

## 7. Error handling & edges

### 7.1 Patch validation
- Multi-field patch → `400 invalid-patch-shape` with `{ "error": "exactly one patch field must be set", "fieldsSet": [...] }`.
- Unknown patch kind → `400 unknown-patch-kind`.
- `update*` / `delete*` against missing `id` → `404 draft-not-found`. No state mutation; no event.
- `newDraftReply` against unknown `parentThreadId` → write succeeds; reply is reclassified `Stale (ParentThreadDeleted)` at next reconciliation.
- `confirmVerdict` when status already `Draft` → idempotent no-op success; no event.
- `markAllRead` with no existing comments → no-op success.

### 7.2 Concurrency
- See § 4.6.

### 7.3 Reconciliation edges
- `IFileContentSource.GetAsync(filePath, sha)` returns `404` → `Stale (FileDeleted)`. Distinguish from "SHA unreachable" (force-push fallback).
- Network error during reconciliation: pipeline aborts, returns no result, persists nothing. Frontend shows banner: *"Reload failed; please retry."* Drafts remain in their pre-reload state. The `_gate` was held during the pipeline call but no state was modified.
- `IFileContentSource` cache is per-`Reconcile()` call; nothing persisted across reloads.

### 7.4 Composer auto-save edges
- See § 5.3 (failure path).
- Concurrent open composers: each owns its own `draftId` (or none, pre-first-save). Independent saves; no cross-composer suppression.

### 7.5 SSE backpressure / disconnect
- Existing S3 silence-watcher in `useEventSource` and force-reload on prolonged silence cover `state-changed` / `draft-saved` / `draft-discarded` too. On reconnect, the multi-tab subscriber invalidates *all* open PR caches as a defensive refresh (rather than relying on missed events).

### 7.6 Migration corner cases
- v1 → v2 → v3 chain on a never-upgraded file: works; legacy fields don't exist in v1 or v2; v3 step backfills empties.
- v3 file on a v2 binary (downgrade): `IsReadOnlyMode = true` (existing S3 behavior); `EnsureCurrentShape` fills missing optional v2 fields.
- v3 file with `reviews.sessions` empty: round-trips; no migration triggers.

### 7.7 PR-root drafts on a deleted PR
- A PR-root draft has no anchor. Reconciliation skips it (no file/line to resolve). It remains `Status: Draft` forever (until S5 submits or the user discards). This is correct: a PR-root comment doesn't anchor to code, so nothing about a new commit can stale it.

---

## 8. Testing strategy summary

**TDD throughout** per `.ai/docs/development-process.md`. Every behavior in § 2-§ 7 lands red→green→refactor.

**Coverage matrix** (one entry per behavioral surface):

| Surface | Test file(s) | Test kind |
|---|---|---|
| Migration steps + chain | `tests/PRism.Core.Tests/State/MigrationStepTests.cs`, `MigrationChainTests.cs` | xUnit |
| AppState wrap round-trip | `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs` | xUnit |
| Reconciliation seven-row matrix | `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs` | xUnit (table-driven) |
| Reconciliation boundary permutations | `tests/PRism.Core.Tests/Reconciliation/BoundaryPermutationTests.cs` | xUnit |
| Reconciliation override (Keep anyway) | `tests/PRism.Core.Tests/Reconciliation/OverrideStaleTests.cs` | xUnit |
| Reconciliation edges (force-push, whitespace, rename, delete, replies, verdict) | `tests/PRism.Core.Tests/Reconciliation/{ForcePushFallbackTests, WhitespaceTests, RenameTests, DeleteTests, ReplyTests, VerdictReconfirmTests}.cs` | xUnit |
| `PUT /draft` patch kinds + rejections + auth + body validation + events | `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs` | xUnit + `WebApplicationFactory` |
| `POST /reload` happy path + 409s + concurrency cap | `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs` | xUnit + `WebApplicationFactory` |
| Concurrent draft writes | `tests/PRism.Web.Tests/Concurrency/DraftRaceTests.cs` | xUnit + `WebApplicationFactory` |
| SSE event flow + custom PrReference projection | `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs` | xUnit + `WebApplicationFactory` |
| Composer auto-save behavior (threshold, race, 404, retry) | `frontend/__tests__/useComposerAutoSave.test.ts` | Vitest |
| Draft session diff-and-prefer merge | `frontend/__tests__/useDraftSession.test.ts` | Vitest |
| Multi-tab subscriber | `frontend/__tests__/useStateChangedSubscriber.test.ts` | Vitest |
| Cross-tab presence banner | `frontend/__tests__/useCrossTabPrPresence.test.ts` | Vitest |
| API wrapper exhaustiveness | `frontend/__tests__/api/draft.test.ts` | Vitest |
| Markdown render hardening | `frontend/__tests__/MarkdownRendererSecurity.test.ts` | Vitest |
| Modal focus management | `frontend/__tests__/Modal.test.tsx` | Vitest + Testing Library |
| Drafts tab rendering (loading, error, empty, populated, override chip, edit, delete) | `frontend/__tests__/DraftsTab.test.tsx` | Vitest + Testing Library |
| Reconciliation panel rendering + keyboard nav + aria-live | `frontend/__tests__/UnresolvedPanel.test.tsx` | Vitest + Testing Library |
| Drafts survive restart (demo) | `frontend/e2e/s4-drafts-survive-restart.spec.ts` | Playwright |
| Reconciliation classification (demo) | `frontend/e2e/s4-reconciliation-fires.spec.ts` | Playwright |
| Multi-tab consistency + cross-tab presence | `frontend/e2e/s4-multi-tab-consistency.spec.ts` | Playwright |
| Keep-anyway survives reload | `frontend/e2e/s4-keep-anyway-survives-reload.spec.ts` | Playwright |

**Manual acceptance** (captured in the final S4 PR description as a screencast): *"Save drafts on a PR; quit and relaunch; drafts survive; classification fires correctly when a teammate pushes."*

---

## 9. PR sequencing (sketch — writing-plans owns the final cut)

The brainstorming pass settled on **layer-up ordering** (architectural prerequisites first; backend before frontend) — matches S3's precedent. The `writing-plans` skill owns the final PR boundaries when it produces `docs/plans/2026-05-09-s4-drafts-and-composer.md`. Sketch:

1. **PR1 — AppState wrap + migration framework + V2→V3 step + existing-consumer updates** (per § 2.5: rename + framework + draft-fields backfill + key normalization + every existing `state.ReviewSessions.X` consumer site rewritten to `state.Reviews.Sessions.X` (~6 production files + ~5 test files); all existing tests stay green). NOT "no feature consumers" — it's a cross-module touch that the brainstorm-output framing understated.
2. **PR2 — Reconciliation pipeline** (`PRism.Core/Reconciliation/Pipeline/`; matrix tests; boundary-permutation tests; override tests; no UI; no endpoint).
3. **PR3 — Backend draft endpoints + bus events + SSE wiring + spec/02 doc update** (`PUT/GET /draft`, `POST /reload`, all event publication, all SSE event names, custom `PrReference` SSE projection, plus the `spec/02-architecture.md` § wire shape doc edit per § 4.8).
4. **PR4-N — Frontend in cohesive chunks**: draft client (`useDraftSession` with diff-and-prefer merger) + `api/draft.ts` wrapper + composer hook + inline composer; reply composer + PR-root composer + Mark all read; Drafts tab + Modal primitive; reconciliation `UnresolvedPanel` + cross-tab presence + multi-tab subscriber. The exact split depends on what reviewable units emerge during implementation.

The architectural prerequisites land as a single PR — this lets reviewers focus on the wrap rename + migration framework correctness, which is structurally distinct from feature work even though it touches consumer sites.

---

## 10. References

- Roadmap: `roadmap.md` § S4 row.
- Spec: `spec/02-architecture.md` § wire shape, § Multi-tab consistency, § State schema (PoC), § Schema migration policy.
- Spec: `spec/03-poc-features.md` § 4 (Comments), § 5 (Stale-draft reconciliation).
- Spec: `spec/04-ai-seam-architecture.md` § `IReviewEventBus`.
- ADRs: `specs/2026-05-06-architectural-readiness-design.md` § ADR-S4-1, § ADR-S4-2, Convention-1.
- S3 spec: `specs/2026-05-06-s3-pr-detail-read-design.md` (precedent for slice-shaped specs and PR cuts).
- Design handoff: `design/handoff/pr-detail.jsx` (`StaleDraftPanel`, Drafts-tab tab strip, PR-root conversation reply field).
