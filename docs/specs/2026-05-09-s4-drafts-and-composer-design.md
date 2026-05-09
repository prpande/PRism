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

`pendingReviewId` / `pendingReviewCommitOid` already exist on `ReviewSessionState` (S5's idempotency keys, defined ahead) — no v3 changes touch them.

**Stamp** `version: 3` last.

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
    string FilePath,                    // null for PR-root drafts
    int? LineNumber,                    // null for PR-root drafts
    string? Side,                       // "left" | "right" | "pr" (PR-root)
    string? AnchoredSha,                // null for PR-root drafts
    string? AnchoredLineContent,        // null for PR-root drafts
    string BodyMarkdown,
    DraftStatus Status);                // Draft | FreshAmbiguous | Moved | MovedAmbiguous | Stale
                                        // (Fresh-but-ambiguous and Moved-ambiguous keep persistent badges
                                        //  but Status is `Draft` — they don't block submit; the badge is
                                        //  rendered from AlternateMatchCount, not from Status.)

public sealed record DraftReply(
    string Id,
    string ParentThreadId,              // GraphQL Node ID `PRRT_...`
    string? ReplyCommentId,             // populated mid-S5; null in S4
    string BodyMarkdown,
    DraftStatus Status);

public enum DraftVerdict { Approve, RequestChanges, Comment }
public enum DraftVerdictStatus { Draft, NeedsReconfirm }
public enum DraftStatus { Draft, Moved, Stale }
                                        // FreshAmbiguous / MovedAmbiguous are NOT enum members;
                                        // ambiguity surfaces via the badge fields on the
                                        // reconciliation result, not via DraftStatus, because
                                        // those classifications don't block submit.
```

**Naming clarification.** `DraftStatus` has three members. The seven-row matrix's "Fresh-but-ambiguous" and "Moved-ambiguous" classifications are render-only (persistent badges) and do not block submit per `spec/03-poc-features.md` § 5. They surface through `ReconciledDraft.AlternateMatchCount` (see § 3.2), not through `DraftStatus`. This keeps the type system honest: anything that's `DraftStatus.Stale` blocks submit; anything else doesn't.

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

### 3.3 Trigger and persistence

New endpoint **`POST /api/pr/{ref}/reload`**:
- Auth: `X-PRism-Session` (existing S3 middleware).
- Body: `{ "headSha": "abc..." }` — the new head the user is reloading to.
- Backend:
  1. Resolve `IPrSessionLookup.Get(ref)` → current `ReviewSessionState`.
  2. Build `IFileContentSource` scoped to `(ref, headSha)`.
  3. `pipeline.ReconcileAsync(session, headSha, fileContentSource, ct)` → `ReconciliationResult`.
  4. `appStateStore.UpdateAsync(s => UpdateSessionWithResult(s, ref, result))` — replaces `DraftComments` and `DraftReplies` wholesale; flips `DraftVerdictStatus` per `VerdictOutcome`.
  5. `eventBus.Publish(new StateChanged(ref, fieldsTouched: ["draft-comments", "draft-replies", "draft-verdict-status"]))`.
  6. Returns the full updated `ReviewSessionDto` (saves the frontend a round-trip; reload is the user-perceived wait moment anyway).

**Reload via `POST` not `PUT`.** Reload is a *recompute and store* operation, not idempotent (the result depends on the head SHA at fetch time, which can change between two POSTs to the same URL). `PUT /draft` is for client-initiated edits per § 4.

**`IFileContentSource` cache lifetime.** Per single `Reconcile()` call. `Dictionary<(string FilePath, string Sha), string>` constructed at the top of the call, dropped at the end. Several drafts on the same file at the same SHA share the fetch.

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
- `confirmVerdict` when status is already `Draft` → no-op success (idempotent). No event published.
- `markAllRead` when there are no existing comments → no-op success.

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
// From spec/04-ai-seam-architecture.md § IReviewEventBus, all already declared:
public record DraftSaved(PrReference Pr, string DraftId) : IReviewEvent;
public record DraftDiscarded(PrReference Pr, string DraftId) : IReviewEvent;
public record DraftSubmitted(PrReference Pr) : IReviewEvent;       // declared, NOT published in S4
public record StateChanged(PrReference Pr, string[] FieldsTouched) : IReviewEvent;
```

**S4 publication rules:**
- `DraftSaved` — published on `newDraftComment`, `newPrRootDraftComment`, `updateDraftComment`, `newDraftReply`, `updateDraftReply` (one per write, with the `assignedId` for new-* kinds).
- `DraftDiscarded` — published on `deleteDraftComment`, `deleteDraftReply` (one per write).
- `StateChanged` — published on **every** mutating write *and* on Reload (alongside the typed event when applicable). Co-fires with the typed event in the same `try` block after `UpdateAsync` returns.
- `DraftSubmitted` — type defined, no producer in S4 (S5 publishes from the submit pipeline).

### 4.5 SSE wire shape on `/api/events`

Existing S3 channel. New event names:

| SSE event name | Payload |
|---|---|
| `state-changed` | `{ "prRef": "owner/repo/123", "fieldsTouched": ["..."] }` |
| `draft-saved` | `{ "prRef": "owner/repo/123", "draftId": "uuid" }` |
| `draft-discarded` | `{ "prRef": "owner/repo/123", "draftId": "uuid" }` |

Existing event names (`pr-updated`, `inbox-updated`) unchanged. Frontend `useEventSource` hook gains a switch on event name (it already dispatches by name internally; add the three new branches).

### 4.6 Concurrency

- Two `PUT /draft` writes against the same draft id within a poll window: `AppStateStore._gate` semaphore serializes; last-writer-wins per `spec/02-architecture.md` § Multi-tab consistency. Both tabs receive both `state-changed` events; both refetch and observe the second write's body. **No conflict UI in S4.** PoC accepts the imperfection; v2 backlog `P4-F9` reopens if reviewers report losing comments.
- A `PUT /draft` and a `POST /reload` racing on the same PR: `_gate` serializes. If reload runs second, it operates on the post-write state. If reload runs first, the write that follows targets the post-reconciliation draft set; if its target `id` was reclassified `Stale`, the write still applies (status doesn't block writes in the backend; only submit, which is S5). Both events fire.

### 4.7 Endpoint scope discipline (what S4 does NOT add)

- No `POST /api/pr/{ref}/submit` — S5.
- No bulk-discard endpoint — bulk discards in the reconciliation panel iterate `deleteDraftComment` / `deleteDraftReply` per id from the frontend; the backend just sees N writes.
- No `DELETE /api/pr/{ref}/draft/{id}` — discards go through `PUT` per `spec/02-architecture.md`.
- No `pendingReviewId` reads/writes — S5.
- No `IReviewService.GetCommentsAsync` re-fetch path for "Mark all read" — the highest existing-comment id is read from the in-memory cache populated by the active-PR poller (S3); if the cache is empty, `markAllRead` no-ops.

### 4.8 Tests (TDD, ship in PR3)

`tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`:
- One test per patch kind: success path + assigned-id-returned (where applicable) + persisted-state-correct + event-published (using an in-memory `IReviewEventBus` capture).
- `RejectsMultiFieldPatch_400_InvalidPatchShape`.
- `RejectsUnknownPatchKind_400`.
- `UpdateDraftCommentMissingId_404_DraftNotFound`.
- `DeleteDraftReplyMissingId_404_DraftNotFound`.
- `ConfirmVerdictWhenAlreadyDraft_NoOp_NoEvent`.
- `MarkAllReadWhenNoExistingComments_NoOp`.
- `FieldsTouched_DerivationPerPatchKind` (table-driven).

`tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`:
- `Reload_RunsReconciliation_PersistsResult_PublishesStateChanged`.
- `Reload_ReturnsFullReviewSessionDto`.

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
│   ├── useDraftSession.ts                      ← GET /api/pr/{ref}/draft + cache + invalidation
│   ├── useDraftMutation.ts                     ← PUT helpers per patch kind
│   ├── useReconcile.ts                         ← POST /api/pr/{ref}/reload
│   └── useStateChangedSubscriber.ts            ← multi-tab consistency reconciler
├── contexts/
│   └── OpenComposerRegistry.tsx                ← Set<string> of currently-edited draftIds (multi-tab guard)
└── api/draft.ts                                ← typed wrapper around fetch
```

### 5.2 State architecture

Server is source of truth. Frontend cache is per-PR `ReviewSessionDto` held in TanStack Query (already in use from S3). Cache key: `["draft", prRef]`. SSE `state-changed` for matching `prRef` invalidates the cache; the next render refetches.

### 5.3 Composer auto-save model

- Composer keeps `body` in local React state for instant typing.
- `useComposerAutoSave({ prRef, anchor, body })` debounces 250 ms. On debounce-fire:
  - If no `draftId` yet AND body has any non-whitespace content: `PUT /api/pr/{ref}/draft` with `newDraftComment` (or `newDraftReply` / `newPrRootDraftComment` per anchor kind). On 200, store `assignedId` in the composer's local state.
  - If `draftId` exists: `PUT` with `updateDraftComment` (or reply variant).
- The hook is the *only* path that mutates persisted draft state from the composer. Discard button calls `deleteDraftComment` / `deleteDraftReply` and unmounts the composer.

**First-keystroke semantics.** If the user opens a composer but never types non-whitespace, no draft is ever created. The first non-whitespace keystroke creates the draft on disk. This collapses spec/03 § 4's "in-flight composer" concept into the regular draft model: the persisted draft *is* the in-flight composer.

**Restore on reload.** After `Cmd/Ctrl+R` (or accidental tab close-and-reopen), `useDraftSession` rehydrates the session. Any draft with anchor info pre-fills its composer at the anchor with the saved body. No separate "in-flight composer" sidecar.

**Auto-save failure.** PUT fails (network blip): hook keeps the body in local state, marks the composer as "unsaved" with a small badge, retries on the next keystroke. No exponential backoff — keystroke cadence IS the retry cadence. If the user stops typing, the unsaved badge persists until either (a) the next keystroke triggers a successful retry, or (b) the user clicks Discard.

### 5.4 Drafts tab content

- **Header bar.** "N drafts on M files" + "X stale" badge if `staleCount > 0` + `DiscardAllStaleButton` (only when `staleCount ≥ 1`; opens confirmation modal listing the count and first-three-line previews per `spec/03-poc-features.md` § 5; both `draftComments` and `draftReplies` included; modal sample preview labels each entry as `[thread on src/Foo.cs:42]` or `[reply on thread PRRT_…]`).
- **Body.** Drafts grouped by file (collapsible per-file group). Replies grouped by parent thread under a "Replies" subgroup at the bottom of each file's group (or under a file-less "PR-root replies" group when the parent thread is on the PR conversation). Per-row: status badge (rendered from `DraftStatus` — Draft / Moved / Stale), ambiguity badge (rendered from `AlternateMatchCount > 0` — "Fresh-but-ambiguous (N+1 matches)" or "Moved-ambiguous (N candidates)" per the matrix; orthogonal to status because ambiguity does not block submit), body preview (first 80 chars), `Edit`, `Delete` (with confirmation if body non-empty), `Jump to file`.
- **Empty state** (`N == 0`). `DraftListEmpty` renders "No drafts on this PR yet. Open any line in the Files tab to start one."

### 5.5 Reconciliation `UnresolvedPanel`

Renders sticky-top on Overview / Files / Drafts when:
- `staleCount > 0`, OR
- `draftVerdictStatus === "needs-reconfirm"`.

Content:
- Summary line: "N drafts need attention · M moved · verdict needs re-confirm" (each clause omitted when its count is zero).
- One `StaleDraftRow` per stale draft. Actions: `Show me` (cross-tab navigates to the diff and scrolls to the line; uses S3's `?line=` deep-link), `Edit` (opens the composer), `Delete` (discards), `Keep anyway` (flips `Status: Stale → Draft` via... see § 5.6).
- Verdict re-confirm row when `draftVerdictStatus === "needs-reconfirm"`. Single click on the verdict picker calls `confirmVerdict` patch.

**`Keep anyway` mechanism.** No new patch kind. The action sets a per-draft flag in component state on `UnresolvedPanel` — `keepAnywayUntilNextReload: Set<string>` — that suppresses the `Stale` row for this draft until the next Reload click. The flag is component-state-ephemeral: closing the tab or navigating away clears it; refreshing also clears it (which is fine because the next render will go through Reload). The backend draft remains `Status: Stale`. This is a UX shortcut, not a server-side state change — the server-side classification is recomputed at every reload, so any client-side override is correctly overridden by the next reconciliation. Submit (S5) will still be blocked while *server-side* `Stale` drafts exist; "Keep anyway" buys the user dismissal of the row in the panel, not server-side reclassification. Spec/03 § 5's "Keep anyway" semantics ("moves draft from `stale` to `draft` status — user accepts it might land on the wrong line; rare but allowed") is intentionally narrowed in S4 to a UI dismissal because the persisted `DraftStatus = Draft` would just be re-set to `Stale` on the next reload anyway. A future enhancement could persist a `userOverrodeStaleAt` field if dogfooding shows users want stale-overrides to survive reloads, but the current behavior covers the spec's stated use case ("the reviewer wants to dismiss the row to focus on others").

### 5.6 PR-root reply composer + Mark all read

The Overview tab's existing `pr-conv-reply` button becomes a real composer (`PrRootReplyComposer`). Anchor is "PR root" (no file, no line). On first keystroke: `newPrRootDraftComment` patch with `{ bodyMarkdown }`. The persisted shape is `DraftComment { FilePath: null, LineNumber: null, Side: "pr", AnchoredSha: null, AnchoredLineContent: null, BodyMarkdown }`.

In S4 these drafts persist locally and render in the Drafts tab under a "PR-root drafts" group. **Submit wiring is S5** (S5 distinguishes by null anchor and submits via `addPullRequestReviewComment` path-less).

**"Mark all read"** button on the Overview-tab conversation header calls `PUT /draft` with `{ markAllRead: true }`. Backend sets `lastSeenCommentId` to the highest existing-comment id in the PR's in-memory cache. Frontend invalidates the inbox row's unread badge via the existing `state-changed` `last-seen-comment-id` flow.

### 5.7 Multi-tab consistency reconciler

Top-level `useStateChangedSubscriber` mounted at app root listens to SSE `state-changed`. On event:

1. Match `prRef` against open PR-detail tabs (each `PrDetailPage` registers itself in a context).
2. For each match, invalidate the affected slice in TanStack cache driven by `fieldsTouched`:
   - `draft-comments` / `draft-replies` / `draft-verdict` / `draft-summary` / `draft-verdict-status` → invalidate `["draft", prRef]`.
   - `last-seen-comment-id` / `last-viewed-head-sha` → invalidate the inbox row's unread badge.
3. Composer text in the affected tab is preserved.

**The `excludeIds` mechanism.** A React context `OpenComposerRegistry` exposes a `Set<string>` of draft ids that are currently being edited in any open composer. Each open composer (after its first save assigned an id) calls `registry.add(draftId)` on mount and `registry.remove(draftId)` on unmount. `useDraftSession`'s refetch merger consults the registry: when SSE-triggered invalidation refetches the draft list, the merged `DraftComment[]` *replaces* server data for all ids except those in the registry — for excluded ids, the composer's local body wins. This satisfies the load-bearing rule: **the open composer's body is sacred until the user presses Discard or Save.**

A composer that has not yet saved (no `draftId`) needs no protection — the server has no record of it.

### 5.8 AI placeholder slots

| Slot | Location | Capability flag | S4 behavior |
|---|---|---|---|
| `<AiComposerAssistant>` | Inside `InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer` next to Save | `ai.composerAssist` | Renders null in PoC (flag stays false; Placeholder impl returns null content). |
| `<AiDraftSuggestionsPanel>` | Top of Drafts tab, above the list | `ai.draftSuggestions` | Renders null in PoC. |
| AI badge slot in `StaleDraftRow` | Per stale draft in `UnresolvedPanel` | `ai.draftReconciliationAssist` | Renders null in PoC. |

`/api/capabilities` doesn't change shape; the three new flags are added to the existing flag map (default `false`; toggled to `true` only when `ui.aiPreview === true` AND a future Placeholder impl exists — for S4, Placeholder impls are stubs returning null, so the slots render empty even with aiPreview on).

### 5.9 TypeScript types

`frontend/src/types/api.ts` hand-mirrored per S3 precedent (frontend codegen deferred to ADR-P0-1):

- `ReviewSessionDto`, `DraftCommentDto`, `DraftReplyDto`, `IterationOverrideDto`, `FileViewStateDto`.
- `ReviewSessionPatch` as a discriminated union (`{ kind: "newDraftComment", payload: ... }`-style on the TS side; the backend still expects the spec-described "exactly one field set" wire shape — the union is a frontend-side construction the wrapper unwraps before sending).
- `DraftStatus = "draft" | "moved" | "stale"` literal union.
- `DraftVerdict = "approve" | "requestChanges" | "comment"`.
- `DraftVerdictStatus = "draft" | "needs-reconfirm"`.
- SSE event payloads: `StateChangedEvent`, `DraftSavedEvent`, `DraftDiscardedEvent`.

### 5.10 Tests (TDD)

**Vitest unit tests (`frontend/__tests__/`):**
- `useComposerAutoSave.test.ts`:
  - `Debounce_250ms_BatchesKeystrokes`.
  - `FirstNonWhitespaceKeystroke_FiresNewDraftComment`.
  - `EmptyComposer_NoPut_NoDraftCreated`.
  - `AfterAssignedId_SubsequentKeystrokesUseUpdateDraftComment`.
  - `PutFailure_KeepsLocalBody_MarksUnsaved_RetriesOnNextKeystroke`.
- `useStateChangedSubscriber.test.ts`:
  - `StateChanged_DraftComments_InvalidatesDraftQuery`.
  - `StateChanged_LastSeenCommentId_InvalidatesInboxBadge`.
  - `ExcludeIds_ProtectsOpenComposerDraftFromCacheReplacement`.
- `DraftsTab.test.tsx`:
  - `RendersEmptyState_WhenNoDrafts`.
  - `RendersDraftsGroupedByFile`.
  - `RendersStaleBadge_WhenStaleCountGtZero`.
  - `DiscardAllStaleButton_VisibleOnlyWhenStaleCountGtZero`.
  - `DiscardAllStaleConfirmModal_ListsCountAndPreviews`.
- `UnresolvedPanel.test.tsx`:
  - `RendersOnEveryTab_WhenStaleCountGtZero`.
  - `HiddenWhenNoStaleAndNoVerdictReconfirm`.
  - `VerdictReconfirmRow_FiresConfirmVerdictPatch`.
  - `KeepAnyway_HidesRowUntilNextReload`.

**Playwright E2E (`frontend/e2e/`):**
- `s4-drafts-survive-restart.spec.ts` — open PR → save inline draft → close browser → reopen → draft visible at anchor with body intact.
- `s4-reconciliation-fires.spec.ts` — save draft on iter-3 file → simulate iter-4 push (fixture) → click Reload → assert classification badges per matrix.
- `s4-multi-tab-consistency.spec.ts` — open same PR in two tabs → save draft in tab A → tab B's draft list refetches and shows it; open composer in tab B for a different draft → tab A's update of *that* same draft is held back from clobbering tab B's open composer.

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
| Reconciliation edges (force-push, whitespace, rename, delete, replies, verdict) | `tests/PRism.Core.Tests/Reconciliation/{ForcePushFallbackTests, WhitespaceTests, RenameTests, DeleteTests, ReplyTests, VerdictReconfirmTests}.cs` | xUnit |
| `PUT /draft` patch kinds + rejections + events | `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs` | xUnit + `WebApplicationFactory` |
| `POST /reload` happy path | `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs` | xUnit + `WebApplicationFactory` |
| Concurrent draft writes | `tests/PRism.Web.Tests/Concurrency/DraftRaceTests.cs` | xUnit + `WebApplicationFactory` |
| SSE event flow | `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs` | xUnit + `WebApplicationFactory` |
| Composer auto-save behavior | `frontend/__tests__/useComposerAutoSave.test.ts` | Vitest |
| Multi-tab subscriber | `frontend/__tests__/useStateChangedSubscriber.test.ts` | Vitest |
| Drafts tab rendering | `frontend/__tests__/DraftsTab.test.tsx` | Vitest + Testing Library |
| Reconciliation panel rendering | `frontend/__tests__/UnresolvedPanel.test.tsx` | Vitest + Testing Library |
| Drafts survive restart (demo) | `frontend/e2e/s4-drafts-survive-restart.spec.ts` | Playwright |
| Reconciliation classification (demo) | `frontend/e2e/s4-reconciliation-fires.spec.ts` | Playwright |
| Multi-tab consistency | `frontend/e2e/s4-multi-tab-consistency.spec.ts` | Playwright |

**Manual acceptance** (captured in the final S4 PR description as a screencast): *"Save drafts on a PR; quit and relaunch; drafts survive; classification fires correctly when a teammate pushes."*

---

## 9. PR sequencing (sketch — writing-plans owns the final cut)

The brainstorming pass settled on **layer-up ordering** (architectural prerequisites first; backend before frontend) — matches S3's precedent. The `writing-plans` skill owns the final PR boundaries when it produces `docs/plans/2026-05-09-s4-drafts-and-composer.md`. Sketch:

1. **PR1 — AppState wrap + migration framework + V2→V3 step** (pure refactor + framework + draft-fields backfill; no feature consumers).
2. **PR2 — Reconciliation pipeline** (`PRism.Core/Reconciliation/Pipeline/`; matrix tests; no UI; no endpoint).
3. **PR3 — Backend draft endpoints + bus events + SSE wiring** (`PUT/GET /draft`, `POST /reload`, all event publication, all SSE event names).
4. **PR4-N — Frontend in cohesive chunks**: draft client + composer hook + inline composer; reply composer + PR-root composer + Mark all read; Drafts tab; reconciliation `UnresolvedPanel` + multi-tab subscriber. The exact split depends on what reviewable units emerge during implementation.

The architectural prerequisites land as a single PR with no feature consumers — this lets reviewers focus on the wrap rename + migration framework correctness without feature-shaped distractions.

---

## 10. References

- Roadmap: `roadmap.md` § S4 row.
- Spec: `spec/02-architecture.md` § wire shape, § Multi-tab consistency, § State schema (PoC), § Schema migration policy.
- Spec: `spec/03-poc-features.md` § 4 (Comments), § 5 (Stale-draft reconciliation).
- Spec: `spec/04-ai-seam-architecture.md` § `IReviewEventBus`.
- ADRs: `specs/2026-05-06-architectural-readiness-design.md` § ADR-S4-1, § ADR-S4-2, Convention-1.
- S3 spec: `specs/2026-05-06-s3-pr-detail-read-design.md` (precedent for slice-shaped specs and PR cuts).
- Design handoff: `design/handoff/pr-detail.jsx` (`StaleDraftPanel`, Drafts-tab tab strip, PR-root conversation reply field).
