---
source-doc: docs/specs/2026-05-10-multi-account-scaffold-design.md
plan-doc: docs/plans/2026-05-10-multi-account-scaffold.md
created: 2026-05-13
last-updated: 2026-05-13
status: open
revisions:
  - 2026-05-13: plan-writing pass — recorded the V3→V4 → V4→V5 version-bump correction, the write-site undercount, the § 11 delegate-properties resolution, the new `IConfigStore.SetDefaultAccountLoginAsync` method, and the `AccountKeys.Default` placement.
  - 2026-05-13: ce-doc-review pass — corrected the write-site count from 9 to 23 (11 prod + 12 tests; original grep recipe `new AppState(` returns zero hits), promoted `TokenStore.IsReadOnlyMode` parity from P2-deferred to P0-enforced, fixed the token-cache branch-2 legacy-blob detection (real legacy bytes are bare PATs, not JSON-quoted), tightened `MigrateV4ToV5` idempotency against partial-rollback files with both root-level and `accounts` keys, promoted the `ServiceCollectionExtensions.cs` DI factory edit + `FakeConfigStore` stub from conditional to required, added two new tests (future-version V6 state.json under EnsureCurrentShape + concurrent `SetDefaultAccountLoginAsync` × `PatchAsync` with FSW debounce), added `[Risk]` entries for `ConfigStore.WriteToDiskAsync` non-atomic-rename asymmetry, `login`-as-PII handling, and Task 3's atomic-reshape alternative consideration, and revised the v2-doesn't-ship reversal estimate from 3–5d to 5–8d.
---

# Deferrals — S6 PR0 multi-account storage-shape scaffold

Plan-time decisions that diverge from the spec or that the spec deferred to plan-writing. Each entry names the source, the severity (P0 = blocks merge, P1 = revisit before v2, P2 = noted for posterity), the rationale, and the trigger that should reopen the decision.

The 8 in-scope items + 6 binding constraints + 5 advisory observations enumerated in [`2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md) are the *applied* decisions. This sidecar records the *not-applied-as-written* set so future readers can see what was weighed and why each item didn't land as the spec described.

---

## Plan-time deviations from the spec

### [Decision] V3→V4 migration becomes V4→V5

- **Source:** Plan-writing 2026-05-13. Code sanity-check against `PRism.Core/State/AppStateStore.cs` surfaced that `CurrentVersion = 4` and `MigrateV3ToV4` already exist — the V3→V4 step was added by S5 PR2 (DraftComment.ThreadId additive migration, merged in May 2026 before this slice's plan was written).
- **Severity:** P0 — load-bearing for the implementation.
- **Date:** 2026-05-13
- **Reason:** The spec was authored 2026-05-10, before S5 PR2 landed. Every reference to "V3 → V4 migration" / "version 4 schema" in [`2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md) is interpreted as V4 → V5 / version 5 in the plan. The new migration step is `MigrateV4ToV5` (in `PRism.Core/State/Migrations/AppStateMigrations.cs`), `MigrationSteps` gets `(5, MigrateV4ToV5)` appended, and `AppStateStore.CurrentVersion` becomes 5.
- **Spec sections affected:** § 1 (trajectory note), § 2 in-scope 1, § 4.1 (entire), § 8.1 (cost table — the "V3→V4 state" entry is V4→V5 state in reality), § 8.2 (migration risk — "V3→V4" → "V4→V5"), § 8.4 (V4→V5 collapse migration if v2 doesn't ship multi-account becomes V5→V6 — same logic, one version higher), § 9.1 (`MigrateV3ToV4` test name → `MigrateV4ToV5`).
- **Revisit when:** Never — this is purely a version-bump correction. If a future slice catches a similar drift before plan-writing, run `git grep MigrateV.*To.*V` and `git grep 'CurrentVersion = '` as a standing pre-plan sanity check.
- **Where the gap lives in code:** Tasks 4 (per-step + framework wiring), 4 step 7 (end-to-end LoadAsync test), 9 (no doc impact — the spec doc keeps its V3→V4 prose since the spec's authoring moment was pre-S5-PR2). The deferrals sidecar is the durable record of the version mapping.

### [Decision] Total `with`-expression rewrite count is 23, not 9 (recount during ce-doc-review)

- **Source:** ce-doc-review 2026-05-13 (feasibility + adversarial reviewers both flagged it).
- **Severity:** P0 — Task 3's compile success depends on rewriting all 23.
- **Date:** 2026-05-13
- **Original draft claim:** "9 production sites" with grep `git grep 'new AppState('`.
- **Corrected count:** 11 production + 12 test sites = 23 total. Production additions over the original plan-time count: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:635` (in-pipeline overlay write helper) and `PRism.Web/TestHooks/TestEndpoints.cs:171` (`/test/advance-head` test endpoint). Test additions: `AppStateRoundTripTests.cs:30`, `InboxRefreshOrchestratorTests.cs:506`, `AppStateStoreMigrationTests.cs:163, 427`, and the `InMemoryAppStateStore.cs:48-57` SeedSession helper.
- **Why the original grep returned nothing:** `git grep 'new AppState('` returns **zero** hits on the codebase — nothing calls the constructor directly. Every construction goes through `AppState.Default with { ... }`, and after Task 3's reshape *every* `with`-expression assigning to `Reviews` / `AiState` / `LastConfiguredGithubHost` breaks with `CS8852: Init-only property '...' can only be assigned in an object initializer` (the fields become read-only delegate properties). The correct grep is `git grep -nE 'with \{ *(Reviews|AiState|LastConfiguredGithubHost) *='` plus manual inspection of two known multi-line `with` blocks (the regex doesn't catch newlines between `with` and `{`).
- **Where the gap lives in code:** Plan Task 3 step 4 (11 prod sites), Task 3 step 5 (12 test sites including the multi-line ones), Task 7 step 7 (`FakeConfigStore` stub), Task 7 step 6 (`ServiceCollectionExtensions.cs` factory edit).
- **Revisit when:** A future S6 slice grows new endpoints with `state with { Reviews = ... }` patterns before this slice merges — repeat the grep.

### [Decision] `TokenStore.IsReadOnlyMode` promoted from P2-deferred to P0-enforced

- **Source:** ce-doc-review 2026-05-13 (security-lens finding 2 + adversarial finding 7).
- **Severity:** P0 — protects against silent v2-PAT destruction.
- **Date:** 2026-05-13
- **Original draft claim:** Deferred to v2 in the "[Risk] IsReadOnlyMode parity" entry below, on the reasoning that "every commit path goes through Setup, which surfaces the error to the user."
- **Why elevated:** The reasoning has a gap. `ViewerLoginHydrator.StartAsync` catches `Exception` and swallows the `FutureVersionCache` — surfacing only `Log.ValidationFailed` (a warning), not a user-visible "PRism was downgraded" prompt. The user proceeds to Setup, `WriteTransientAsync` populates `_transient`, `CommitAsync` writes a v1-shape map containing only `"default"` — and any v2-added second-account PAT in the original cache is silently destroyed. This is the exact data-loss scenario the version-discriminator branch was supposed to prevent. Adding a `_isReadOnlyMode` flag + `CommitAsync` guard is a one-field + one-`if` change with parity to `AppStateStore.IsReadOnlyMode`.
- **Where the fix lives in code:** Task 8 step 4 (state field + `CommitAsync` guard), Task 8 step 1 (new test `CommitAsync_after_future_version_ReadAsync_refuses_to_overwrite_the_v2_cache`).
- **Revisit when:** Resolved at plan-time; the v2 multi-account interface refactor may layer additional read-only-mode semantics but the v1 guard stays.

### [Decision] Token-cache branch-2 legacy detection rewritten to match real legacy bytes

- **Source:** ce-doc-review 2026-05-13 (feasibility finding 2 + security finding 1 + adversarial finding 1, all P0).
- **Severity:** P0 — without this, every existing PRism user loses their PAT on upgrade.
- **Date:** 2026-05-13
- **Original draft heuristic:** `if (trimmed[0] == '"')` then `JsonSerializer.Deserialize<string>(raw)`. The test fixture wrote `"\"ghp_legacy\""` (JSON-quoted PAT).
- **Why wrong:** Pre-S6-PR0 `CommitAsync` wrote `Encoding.UTF8.GetBytes(_transient)` — raw PAT bytes, NOT JSON-encoded. Real legacy files contain `ghp_xxxxx` (no surrounding quotes). The original heuristic skips branch-2 for every real legacy user, falls through to `JsonNode.Parse("ghp_xxxxx")`, throws, surfaces as `TokenStoreFailure.CorruptCache`, breaks the "byte-identical user-visible behavior" goal from the spec § 1.
- **Corrected heuristic:** First try a PAT regex `^[A-Za-z0-9_\-]{20,255}$` on the trimmed content — if matched, treat as branch-2 (bare-PAT legacy). Else try `JsonNode.Parse`; if it returns a `JsonValue<string>`, also treat as branch-2 (defensive hand-edited-JSON-quoted form). Otherwise fall through to the structural shape checks.
- **Where the fix lives in code:** Task 8 step 4 `ParseCacheFileBytes` rewrite; Task 8 step 1 test fixtures `ReadAsync_migrates_legacy_bare_pat_blob_to_versioned_map_on_first_read` (writes bare bytes) + `ReadAsync_migrates_legacy_quoted_pat_blob_too_for_hand_edited_safety` (defensive).

### [Decision] `MigrateV4ToV5` idempotency guard tightened to reject partial-rollback files

- **Source:** ce-doc-review 2026-05-13 (adversarial finding 5).
- **Severity:** P0 — silent data loss for users who hand-edit state.json after a future-version downgrade.
- **Date:** 2026-05-13
- **Original draft check:** `if (root["accounts"] is JsonObject) { root["version"] = 5; return root; }` — treats any presence of `accounts` as "already V5, idempotent no-op."
- **Why wrong:** A partial-rollback or hand-edited state.json could have BOTH `accounts` (from a future v6 binary) AND root-level `reviews` / `ai-state` / `last-configured-github-host` (newly added or re-introduced by the user). The naive guard skips the migration step's move-keys-under-accounts logic, the orphan root keys never get merged in, and the deserializer drops them — the user's freshly-edited root-level data is silently lost.
- **Corrected check:** Track `hasOrphanRoot = root["reviews"] is not null || root["ai-state"] is not null || root["last-configured-github-host"] is not null`. Only short-circuit when `accounts is JsonObject` AND `!hasOrphanRoot`. When both are present, throw `JsonException` so `LoadCoreAsync.catch (JsonException)` quarantines the file and falls back to `AppState.Default` — fail loud rather than silently picking one set.
- **Where the fix lives in code:** Task 4 step 3 (`MigrateV4ToV5` body), Task 4 step 1 new test `MigrateV4ToV5_throws_on_partial_rollback_file_with_both_orphan_root_keys_and_accounts`.

### [Decision] § 11 open question — `AppState` delegate properties stay public, no `[Obsolete]`

- **Source:** Spec § 11. The spec recommended public + no `[Obsolete]` and asked plan-writing to commit.
- **Severity:** P1 — affects how loudly v2 has to migrate consumers off the delegates.
- **Date:** 2026-05-13
- **Reason:** Concur with the spec's recommendation. (1) There's nothing for callers to migrate *to* until v2's interfaces gain `accountKey` parameters; `[Obsolete]` would flood the build with warnings at zero benefit. (2) `TreatWarningsAsErrors` is enabled across the solution (verified in the existing CI workflow), so `[Obsolete]` would force every consumer to suppress the warning at the use site — net negative ergonomics. (3) The v2 brainstorm hasn't decided whether the delegates survive into the multi-account API; some may stay (for back-compat reads of "the current viewer's session") while others are removed. Pre-emptively obsoleting all three over-commits.
- **Revisit when:** v2 brainstorm ratifies the multi-account interface model. If v2 decides delegates go, `[Obsolete]` lands in the same PR that introduces the parameterized replacements, so consumers see both the deprecation and the migration target at once.
- **Where the gap lives in code:** `PRism.Core/State/AppState.cs` (delegate property comments cite this decision); `PRism.Core/Config/AppConfig.cs` (same pattern for `GithubConfig.Host` / `LocalWorkspace`).

### [Decision] `ViewerLoginHydrator` config write uses new `IConfigStore.SetDefaultAccountLoginAsync` (not extended `PatchAsync`)

- **Source:** Plan-writing 2026-05-13. Spec § 4.2 says the hydrator gains a side-write but doesn't specify the integration point.
- **Severity:** P1 — the public surface of `IConfigStore` grows by one method.
- **Date:** 2026-05-13
- **Reason:** Two options were on the table:
  - **(A) Widen `PatchAsync`'s allowlist** to include `github.accounts[0].login`. Rejected because `PatchAsync` is the *user-editable-fields* surface (currently `theme`, `accent`, `aiPreview`) and adding internally-set fields to the same allowlist couples two unrelated concerns. The patch shape `{ "github.accounts[0].login": "alice" }` also has a path-traversal flavor that the existing allowlist's flat-key model doesn't accommodate.
  - **(B) Add a narrow typed method.** `Task SetDefaultAccountLoginAsync(string login, CancellationToken ct)` — scoped to the v1 single-account semantics. v2 generalizes when interfaces gain `accountKey`; until then, "the default account's login" is a precise, bounded contract. Chosen.
- **Revisit when:** v2's multi-account brainstorm decides on the per-account login-write API. The likely v2 evolution is either `SetAccountLoginAsync(string accountKey, string login, CancellationToken ct)` or a typed `AccountConfigUpdater` seam. v1's `SetDefaultAccountLoginAsync` becomes a delegate over the v2 method or gets removed alongside the delegate-property removal.
- **Where the gap lives in code:** Task 7 (interface, implementation, hydrator call site); plan body's "File structure" list.

### [Decision] `AccountKeys.Default` const lives on a new static class, not on `AppState`

- **Source:** Plan-writing 2026-05-13. Spec § 3 says `public const string DefaultAccountKey = "default";` "in `PRism.Core.State`" (namespace-level, but C# requires a containing class).
- **Severity:** P2 — naming/placement detail only.
- **Date:** 2026-05-13
- **Reason:** Three placements were weighed:
  - **On `AppState`** as `public const string DefaultAccountKey = "default";`. Couples the constant to a record type that doesn't logically own it; v2 may have non-state consumers of the key (config builders, log redaction).
  - **On a new `AccountKeys` static class.** Single-responsibility, semantically named, namespace-level resolution as `AccountKeys.Default`. Chosen.
  - **As a `record struct` typed wrapper** (`AccountKey(string Value)`). Rejected for the same reasons spec § 3 already gave — ceremony with no compile-time benefit when no interfaces accept the parameter.
- **Revisit when:** v2's typed-wrapper question reopens. If v2 introduces `AccountKey` as a typed seam, `AccountKeys.Default` can stay as the well-known string constant and `AccountKey.Default` (the typed variant) can layer on top.
- **Where the gap lives in code:** Task 1; every reference site uses `AccountKeys.Default`.

---

## Spec items kept as-is (no plan-time deviation)

These are noted so future readers can see they were considered and confirmed, not skipped:

- **One-file token cache (spec § 4.3 table).** Confirmed against MSAL's `MsalCacheHelper` constraints — per-account files would create N keychain entries and N first-run consent prompts on Linux; the corruption blast radius trade is accepted as the spec already laid out. No change.
- **§ 7 binding 6 — no-silent-fallback rule.** v1 hardcodes one account so the rule is vacuously satisfied; the rule binds v2. No v1 implementation work, no test.
- **§ 7 binding 2 — `accountKey` safe-string allowlist.** v1 hardcodes `"default"` (trivially safe). No validator in v1; v2 adds it alongside multi-account UX. Noted for v2.
- **§ 8.4 dead-weight reversal estimate — revised during ce-doc-review from 3–5d to 5–8d.** The 3–5d figure captured code-and-test reverts (state migration, fixture rewrites, write-site reverts) but underweighted: (a) `IConfigStore.SetDefaultAccountLoginAsync` orphan-method decision (delete or keep dead); (b) `ViewerLoginHydrator`'s config side-write becoming a single-site v1-only path; (c) `docs/spec/02-architecture.md` three-amendment revert tone; (d) production state files in the wild carry V5 shape — a code revert without a `MigrateV5ToV4` step plus release note coordination leaves users in read-only mode; (e) token cache versioned-map is one-way — a code revert needs a `MigrateV1ToV0` step + release note. The decision (option B dominates option A in EV at moderate p(v2 ships)) still holds, but the bet is tighter than the spec's framing implied.

---

## Forward-looking residual risks for the implementer

Items the implementing engineer should keep an eye on during Phase 1 execution; they're *not* deferred decisions, just hazards the plan can't pre-empty.

### [Risk] Snapshot tests pinning the old `GithubConfig` JSON shape

- **Where:** `tests/PRism.Web.Tests/`, possibly `tests/PRism.Core.Tests/`. The plan flags this in Task 6 step 4 with a `git grep '"host":' tests/` sanity scan.
- **Mitigation:** If a snapshot test fails after Task 6 because it pinned a `{ "github": { "host": "..." } }` shape, update the fixture inline to the new `accounts` shape. If the snapshot pins prose (e.g., a settings-page render that displays the host), the delegate property `Github.Host` keeps the rendered value identical — no fixture change needed.

### [Risk] Legacy-blob detection in `TokenStore` — RESOLVED at plan-time

- **Status update:** Caught by ce-doc-review before plan handoff. The plan body's Task 8 step 4 now implements the PAT-pattern + `JsonValue<string>` detection (see [Decision] entry above). Test fixtures updated to write bare-PAT bytes (`ghp_legacy`) instead of JSON-quoted PATs, so the test catches a regression to the original buggy heuristic.

### [Risk] `IsReadOnlyMode` parity between `AppStateStore` and `TokenStore` — RESOLVED at plan-time

- **Status update:** Promoted from P2-deferred to P0-enforced during ce-doc-review (see [Decision] entry above). `TokenStore` now has a `_isReadOnlyMode` flag + `CommitAsync` guard; the test `CommitAsync_after_future_version_ReadAsync_refuses_to_overwrite_the_v2_cache` pins the contract.

### [Risk] DI registration order — `ViewerLoginHydrator` needs `IConfigStore` before `IConfigStore.InitAsync` is called

- **Where:** `IHostedService` registrations execute in registration order. If `ConfigStore` is registered as a singleton that lazy-initializes on first access, the hydrator's startup can run before `InitAsync` completes, and the hydrator's `SetDefaultAccountLoginAsync` call would write against `AppConfig.Default`'s seeded shape, not the loaded shape.
- **Mitigation:** Verify the existing `ServiceCollectionExtensions.cs` registration sequence puts `ConfigStore.InitAsync` ahead of `ViewerLoginHydrator.StartAsync`. The likely current state is that `ConfigStore` is registered as a singleton with `InitAsync` called in `Program.cs` before `app.Run()`, and the hosted-service registration list has `ViewerLoginHydrator` somewhere in that list — in which case the timing already works because `Program.cs`'s explicit `InitAsync` await happens before any hosted service starts. Confirm in Task 7 step 6.
- **Severity:** P1 — if the timing is wrong, the hydrator's first launch writes a stale login that the next launch overwrites once `ConfigStore.InitAsync` completes. Self-healing but ugly.

### [Risk] `EnsureCurrentShape` backfill scope — partial coverage at plan-time

- **Status update:** Plan Task 4 added the future-version V6 LoadAsync test `LoadAsync_future_version_V6_file_enters_read_only_mode_and_EnsureCurrentShape_backfills_safely` per ce-doc-review adversarial F6. The test asserts the future-version + missing-optional-sub-fields case produces a safe in-memory state and a read-only-mode-blocked `SaveAsync`. The `last-configured-github-host` field is still NOT explicitly backfilled by `EnsureCurrentShape`, but the test verifies it deserializes to null without crashing — which was the actual concern.
- **Severity:** P2 (test-pinned).

### [Risk] `ConfigStore.WriteToDiskAsync` lacks `MoveWithRetryAsync` (Windows AV/indexer race) — asymmetry with `AppStateStore`

- **Where:** `PRism.Core/Config/ConfigStore.cs:126-132`. Bare `File.Move(temp, _path, overwrite: true)`. Compare to `AppStateStore.cs:189-218` which has a 10-attempt exponential-backoff retry specifically for the Windows Defender / Search Indexer transient-handle race.
- **Why this is the right place to note it:** Pre-existing asymmetry, but this slice **widens the call frequency**: `WriteToDiskAsync` is now called from `SetDefaultAccountLoginAsync`, which fires on every launch for users with a token. Pre-S6-PR0, `WriteToDiskAsync` only fired on first-launch seed + occasional user `PatchAsync` (theme/accent). Higher write frequency → higher race exposure.
- **Mitigation in v1:** None. The `SetDefaultAccountLoginAsync` exception is caught and logged at the hydrator's `Log.ConfigLoginWriteFailed` — the in-memory login cache is still set, so the v1 user experience self-heals on the next launch.
- **The right fix is shared infrastructure:** Lift `MoveWithRetryAsync` from `AppStateStore` into a `PRism.Core.Storage` helper and have both stores call it. ~½ day of refactor; out of v1 scope for this slice.
- **Severity:** P2.
- **Revisit when:** A user reports `ConfigLoginWriteFailed` warnings repeatedly across launches (indicating a persistent AV race on their machine), OR a future slice already plans to touch `ConfigStore.WriteToDiskAsync` and can include the shared-helper refactor.

### [Risk] `ConfigStore.SetDefaultAccountLoginAsync` triggers the FSW → re-read → duplicate `Changed` raise

- **Where:** `ConfigStore`'s `FileSystemWatcher` fires on the writer's own `File.Move`, re-reads disk under `_gate`, raises `Changed` a second time (~100ms later). Current subscribers (`AiPreviewState.IsOn = args.Config.Ui.AiPreview`) are idempotent, so the duplicate is benign today.
- **Why this is the right place to note it:** Future subscribers that do non-idempotent work on `Changed` (e.g., re-initializing a HTTP client, re-subscribing to a poll) would react twice. The plan added a regression test (`SetDefaultAccountLoginAsync_concurrent_with_PatchAsync_preserves_both_writes` in `ConfigStoreMigrationTests`) that drains pending FSW events and asserts both writes survive — this pins the contract.
- **Mitigation in v1:** None — the duplicate-raise is benign with current subscribers. Documented for v2 reviewers who add new subscribers.
- **Severity:** P2.

### [Risk] `TokenStore.CommitAsync` legacy migration write-back is not atomic-rename

- **Where:** `MsalCacheHelper.SaveUnencryptedTokenCache` is the standard MSAL write path. Both `CommitAsync` and the migration write-back inside `ParseCacheFileBytes` (branch-2) call it directly with no temp-write-then-rename wrap. A process crash between the read of the legacy PAT bytes and the migrate-write leaves the cache file in one of three states: pre-write (legacy bare PAT — next launch re-migrates), mid-write (half-written JSON — next launch surfaces `CorruptCache`), post-write (complete versioned map). The mid-write window is small but not zero.
- **Spec acknowledged the legacy-migration crash window** (§ 4.3 branch 2, § 8.3) but the plan doubles the exposure by routing every `CommitAsync` through the same non-atomic path on every re-authentication.
- **Mitigation in v1:** None. Out of v1 scope to wrap MSAL with temp-write-then-rename (spec explicitly accepted this trade-off). The version-discriminator + read-only-mode guard partially compensates: a half-written future-version cache surfaces as `CorruptCache`, preserving the file rather than overwriting.
- **The right fix is the same shared-helper refactor as the previous risk** — `PRism.Core.Storage.AtomicMove` wrapping both stores' write paths.
- **Severity:** P2.

### [Risk] `login` is GitHub-supplied PII (username) — must not appear in structured-log fields

- **Where:** `ViewerLoginHydrator.StartAsync` reads `result.Login` and calls `_config.SetDefaultAccountLoginAsync(login, ct)`. The four `LoggerMessage` declarations in the hydrator do NOT log the login value — verified correct.
- **Why this is the right place to note it:** `SensitiveFieldScrubber.BlockedFieldNames` (existing) does not currently include `login`. A future log site that does `_log.LogInformation("Validated as {login}", result.Login)` would NOT be redacted. GitHub usernames are PII, not credentials, but the v1 logging discipline should treat them like other identity values.
- **Mitigation in v1:** No code change required (no current log site leaks). Captured as a forward-looking guideline: if a future log call needs to reference the login, either use `[REDACTED]` in the template OR add `login` to `BlockedFieldNames`.
- **Severity:** P3 (advisory only).

### [Decision considered, not applied] Task 3 atomic-reshape alternative (additive `Accounts` field + per-site migration)

- **Source:** ce-doc-review adversarial finding 9.
- **Alternative considered:** Make `AppState.Accounts` nullable initially; have delegate properties fall through to the legacy top-level fields when `Accounts is null`; migrate sites one-at-a-time under TDD red-green discipline; flip a one-line switch to make `Accounts` non-nullable and remove the legacy fields after every site is migrated.
- **Why rejected:** (1) The compat shim adds dual-write complexity to every endpoint write path (the helper has to choose between updating `Accounts` and updating the legacy field); (2) the temptation to leave the shim in place "just in case v2 needs it" is a real risk to discipline; (3) the atomic reshape's compile-error feedback IS the discovery mechanism — when the post-reshape build fails with `CS8852` at a missed site, the engineer has the exact line in the exact file in the exact error message; (4) the rewrite is mechanical at every site (the transform is identical: `with { F = ... }` → `WithDefaultF(...)`).
- **Severity:** Decision noted, not deferred.
- **Revisit when:** If a future PR misses a site at Task 3-style scope and the resulting fix-forward churn is large, reconsider the per-site additive pattern for the analogous v2 interface refactor.

---

## Note on the deferrals format

This sidecar mirrors the format of [`2026-05-11-s5-submit-pipeline-deferrals.md`](2026-05-11-s5-submit-pipeline-deferrals.md): top-level `[Decision]` and `[Risk]` entries, severity tag, date, reason, revisit-trigger, where-the-gap-lives. The plan body's "Plan-time decisions" section (top of `docs/plans/2026-05-10-multi-account-scaffold.md`) is the in-plan summary; this sidecar is the durable per-decision record.
