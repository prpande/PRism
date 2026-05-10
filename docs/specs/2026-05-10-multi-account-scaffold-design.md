# Multi-account storage-shape scaffold (v1) + multi-account v2 spec sketch

**Slice**: S6 PR0 — lands ahead of the Settings page work in S6.
**Date**: 2026-05-10.
**Status**: Design — pending user review and implementation plan.
**Branch**: `spec/multi-account-scaffold` (worktree at `D:\src\PRism\.claude\worktrees\spec+multi-account-scaffold`).
**Source authorities**: [`docs/spec/02-architecture.md`](../spec/02-architecture.md) is the PoC architecture; this slice introduces a *deliberate amendment* to its "one host per launch" constraint via storage-shape scaffolding now and runtime support in v2. [`docs/roadmap.md`](../roadmap.md) S6 row gains S6 PR0 as a new prefix.
**Review history**: ce-doc-review run twice. Round 1 reshaped scope from full scaffold (5-7d) to storage-only (1-2d implementation). Round 2 surfaced the C# `with`-expression breakage that the delegate-property pattern would cause, the first-launch nullability cascade, and undercounted cost; this version corrects all three. Implementation cost: **3-5 days all-in** (1-2d implementation + 1d plan + ~1d review/iteration + ~1d test fixture rewrites).

---

## 1. Goal

Reshape the *on-disk* and *config* surfaces — `state.json`, `config.json`, the token cache — to a multi-account-friendly shape in v1, with all in-memory interfaces and wire payloads unchanged. v2 brainstorms the user-facing model and runtime semantics; when v2 ships, the irreversible bit (data on disk for existing users) is already friendly. Reversible bits (interface signatures, middleware, wire headers) are explicitly out of scope and get designed against the ratified v2 model.

This is the *narrowest* AI-seam-analogous move: AI seams shipped interface contracts in S0+S1 because the v2 implementer had already specified them; multi-account doesn't have that benefit yet, so we ship only the part that's irreversible-if-deferred (storage shape) and defer the part that benefits from v2 design input (interfaces, runtime).

End-to-end demo at slice completion: nothing visible to the user changes. PRism still ships single-account; the keychain still holds one PAT in a versioned JSON-map blob with one entry; the inbox still queries `@me` against one host. Internally, `AppState` exposes `Accounts["default"]` while preserving the existing `Reviews` / `AiState` / `LastConfiguredGithubHost` accessors via delegate properties for **reads** and explicit helper methods (`WithDefaultReviews`, etc.) for **writes**.

**Trajectory note:** this is the first PRism slice that ships zero user-visible delta. The justification is that the storage shape is irreversible-if-deferred (V4 schema in user data is hard to walk back) while interfaces and wire are not. Future "ship infrastructure ahead of features" slices should pass the same test — does deferring this cost something irreversible? — rather than inheriting unexamined permission from this precedent.

The bet: v2 ships multi-account *and* the storage shape this slice picks turns out to fit it. If v2 abandons multi-account, the storage shape is dead weight (small, V4→V5 reversal cost in § 8.4). If v2 ships multi-account but with a different storage shape, this slice helps less than zero (§ 8.5 quantifies).

## 2. Scope

### In scope (v1, lands in S6 PR0)

1. **State schema migration V3 → V4**: `AppState.{Reviews, AiState, LastConfiguredGithubHost}` move under `AppState.Accounts[accountKey].{Reviews, AiState, LastConfiguredGithubHost}`. UI preferences stay top-level (cross-account).
2. **`AppState` C# record reshape with read delegates and write helpers**: `state.Reviews` (read) returns `state.Accounts["default"].Reviews`; `state.WithDefaultReviews(newReviews)` (write) returns `state with { Accounts = state.Accounts.SetItem("default", state.Accounts["default"] with { Reviews = newReviews }) }`. Read-site callers compile unchanged. Write-site callers (currently using `state with { Reviews = ... }` and `state with { LastConfiguredGithubHost = ... }`) get rewritten to use the helpers — this is part of v1 scope, not deferred. Same pattern for `WithDefaultAiState` and `WithDefaultLastConfiguredGithubHost`.
3. **Config schema rewrite**: `github.host: string` → `github.accounts: [{ id, host, login?, localWorkspace? }]`. `LocalWorkspace` (currently a sibling of `Host` on `GithubConfig`) moves under each account because clone access is PAT-scoped. v1 has one entry. `AppConfig.Github.Host` becomes a delegate property reading `Accounts[0].Host`; **`AppConfig.Default` is updated to construct the new `GithubConfig(Accounts: [...])` shape** so first-launch writes the V4 config layout from day one.
4. **Token cache reshape with version field**: `PRism.tokens.cache` continues to be one MSAL-wrapped file. Its serialized contents change from `"<pat>"` to `{"version": 1, "tokens": {"default": "<pat>"}}`. The `version` field exists so v1 binaries running against a future-version cache fail loudly rather than silently downgrading.
5. **Token migration on first load**: legacy single-string blob → versioned JSON-map with one `"default"` key. Idempotent. Unparseable cache (or future-version cache, or a JSON object whose `version < 1`) surfaces as "re-validate at Setup" without overwriting.
6. **`AccountKey` as a string constant**, not a typed record-struct. Single source of truth: `public const string DefaultAccountKey = "default";` in `PRism.Core.State`. v1 always uses this constant; v2 introduces UUID generation alongside it.
7. **First-launch initialization**: `ConfigStore` seeds `accounts: [{id: "default", host: "https://github.com", login: null, localWorkspace: null}]` on first launch when no config exists. `host` defaults to `"https://github.com"` to match the existing `AppConfig.Default` contract — DI registration of host-dependent components (`IReviewService`, the `github` `HttpClient`) reads a non-null host at startup, same as today. The Setup screen overrides this default if the user enters a GHES host.
8. **`"default"` key as a permanent fixture (in v1) with v2 rekey option open**: spec commits that v1-upgraded users keep `accountKey == "default"` *if v2 chooses not to rekey*. v2 MAY perform a one-time `default` → UUID rekey on first v2 launch; the v1 storage shape supports either path. Future code that assumes UUID shape (display logic, log redaction) carries the legacy-literal constraint only if v2 picks the no-rekey path.

### Explicitly NOT in scope (deferred to v2 brainstorm)

The following were in an earlier draft of this spec; ce-doc-review's storage-only-alternative finding moved them out:

- `ITokenStore`, `IReviewService`, `IAppStateStore` interface signatures (no `accountKey` parameter in v1)
- `AccountKeyMiddleware` and the `X-PRism-Account-Key` header
- SSE `accountKey` payload field
- Frontend `apiClient` header injection
- State-event-log emit-site convention enforcement
- Banned-API analyzer rules / Roslyn-emit-site tests for accountKey threading
- Per-account named `HttpClient` registration
- URL-paste account routing logic (the *binding non-negotiable* — no silent fallback — is captured in § 7 below)

These all benefit from the v2 brainstorm having ratified the user-facing model first.

### Deferred to v2 (runtime + UX, no v1 commitment)

- Account add/remove UX (Setup screen redesign, account-list management surface, per-account validation flow)
- Active-account vs unified-inbox decision
- Inbox aggregation (parallel polling, rate-limit budgeting, dedup of same PR across accounts)
- URL-paste account routing
- Notification routing, Setup connect for additional accounts, SSE channel keying — see § 7 binding constraint on no-silent-fallback that v2 inherits across all of these
- Per-account active-PR poller, host-change-modal scoping
- Cross-account operations (intentional non-feature: drafts submit via the account that authored them; no cross-account moves)
- Identity-change rules per-account (login rename, host rebrand)

### Explicit non-goals for v1

- Hidden multi-account code path. The scaffold is `"default"`-only and rigorously single-account. No half-states.
- Interface or wire shape commitments. v2 picks those.

## 3. AccountKey identity

Bare string. Single constant: `public const string DefaultAccountKey = "default";` in `PRism.Core.State`. v1 callers reference the constant.

v2 introduces UUID generation at account-add time (`Guid.NewGuid().ToString("N")`). v2 has two design options for the legacy `"default"` key:

- **Keep the legacy literal**: every `accountKey` consumer (display, log redaction, banned-API rules) must accept arbitrary opaque strings. Simpler implementation; carries the literal indefinitely.
- **Rekey at first v2 launch**: read `accounts.default`, generate UUID, write `accounts.<uuid>`, retire the literal. Cleaner downstream code; one-time migration cost.

This spec does NOT pre-commit to either path. v2's brainstorm picks. v1 storage shape supports both because the key is just a JSON map key — read, generate, write.

**Display name** (v2 concern): `${login}@${host}` derived from `viewer.login` and the configured host. Cached on `config.github.accounts[…].login`.

**Why not a typed `AccountKey` record-struct in v1:** there are no interfaces accepting `accountKey` parameters in v1. The dimension lives only in JSON serialization (state, config, token cache) and that's already a string boundary. A record-struct would be ceremony with no compiler-checked benefit. v2 can introduce a typed wrapper alongside the interface changes if it wants.

## 4. Schema

### 4.1 State (`state.json`) V3 → V4

```jsonc
{
  "version": 4,
  "ui-preferences": { /* unchanged, cross-account */ },
  "accounts": {
    "default": {
      "reviews": { /* prior AppState.Reviews */ },
      "ai-state": { /* prior AppState.AiState */ },
      "last-configured-github-host": "https://github.com"
    }
  }
}
```

Migration `MigrateV3ToV4(JsonObject root)`:
1. Read `reviews`, `ai-state`, `last-configured-github-host` from root.
2. Create `accounts.default` containing those three keys.
3. Remove the now-orphaned root keys.
4. Set `version: 4`.

JsonNode-rewrite, follows the existing `MigrateV2ToV3` pattern. Atomic-rename write via `AppStateStore`.

**C# `AppState` record reshape:**

```csharp
public sealed record AppState(
    int Version,
    UiPreferences UiPreferences,
    IReadOnlyDictionary<string, AccountState> Accounts)
{
    // Read delegate properties — to be removed in v2 alongside multi-account runtime.
    public PrSessionsState Reviews => Accounts[DefaultAccountKey].Reviews;
    public AiState AiState => Accounts[DefaultAccountKey].AiState;
    public string? LastConfiguredGithubHost => Accounts[DefaultAccountKey].LastConfiguredGithubHost;

    // Write helpers — replace `state with { Reviews = ... }` patterns.
    public AppState WithDefaultReviews(PrSessionsState newReviews) =>
        this with { Accounts = Accounts.SetItem(DefaultAccountKey,
            Accounts[DefaultAccountKey] with { Reviews = newReviews }) };

    public AppState WithDefaultAiState(AiState newAiState) =>
        this with { Accounts = Accounts.SetItem(DefaultAccountKey,
            Accounts[DefaultAccountKey] with { AiState = newAiState }) };

    public AppState WithDefaultLastConfiguredGithubHost(string? newHost) =>
        this with { Accounts = Accounts.SetItem(DefaultAccountKey,
            Accounts[DefaultAccountKey] with { LastConfiguredGithubHost = newHost }) };

    public static AppState Default { get; } = new(
        Version: 4,
        UiPreferences: UiPreferences.Default,
        Accounts: ImmutableDictionary<string, AccountState>.Empty
            .Add(DefaultAccountKey, AccountState.Default));
}

public sealed record AccountState(
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AccountState Default { get; } = new(
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}
```

`Accounts` is typed as `IReadOnlyDictionary<string, AccountState>` for read-only consumption and instantiated as `ImmutableDictionary<string, AccountState>` so `SetItem` exists for the write helpers.

**Caller migration** — production code that mutates state:

| Current pattern | Rewritten as |
|---|---|
| `state with { Reviews = newR }` | `state.WithDefaultReviews(newR)` |
| `state with { LastConfiguredGithubHost = newH }` | `state.WithDefaultLastConfiguredGithubHost(newH)` |
| `state with { AiState = newA }` | `state.WithDefaultAiState(newA)` |
| `state with { Reviews = state.Reviews with { Sessions = s } }` | `state.WithDefaultReviews(state.Reviews with { Sessions = s })` |

Affected files (verified via current codebase grep): `PRism.Web/Endpoints/AuthEndpoints.cs` (3 sites), `PRism.Web/Endpoints/PrDetailEndpoints.cs` (2 sites), `PRism.Web/Endpoints/PrDraftEndpoints.cs` (1 site), `PRism.Web/Endpoints/PrReloadEndpoints.cs` (1 site), plus test files. Mechanical find-and-replace; the helper methods preserve identical semantics. Read-site callers (`state.Reviews`, `state.LastConfiguredGithubHost`) are unchanged.

`IAppStateStore` interface signatures unchanged. `LoadAsync` / `SaveAsync` / `UpdateAsync` continue accepting `AppState` and `AppConfig` — the interface contract (method names, parameter count, return types) is preserved while the `AppState` type itself reshapes from V3 to V4.

### 4.2 Config (`config.json`) — additive rewrite

Old:
```jsonc
{ "github": { "host": "https://github.com", "local-workspace": "C:/..." } }
```

New:
```jsonc
{
  "github": {
    "accounts": [
      {
        "id": "default",
        "host": "https://github.com",
        "login": null,
        "local-workspace": "C:/..."
      }
    ]
  }
}
```

`ConfigStore` load path:
- If `github.host` present and `github.accounts` not, rewrite to the new shape; move `local-workspace` into the single account.
- If `github.accounts` already present, no-op.
- If neither present (fresh install), seed `accounts: [{id: "default", host: "https://github.com", login: null, localWorkspace: null}]`. **Host defaults to `"https://github.com"`** (matches current `AppConfig.Default` contract; preserves DI's non-null host expectation at registration time).
- Atomic-rename write so partial writes can't leave a file with both shapes.

`AppConfig.GithubConfig` C# record:

```csharp
public sealed record GithubConfig(IReadOnlyList<GithubAccountConfig> Accounts)
{
    // Read delegate properties — removed in v2.
    public string Host => Accounts[0].Host;                  // non-null in v1
    public string? LocalWorkspace => Accounts[0].LocalWorkspace;
}

public sealed record GithubAccountConfig(string Id, string Host, string? Login, string? LocalWorkspace);
```

`GithubAccountConfig.Host` is non-null to preserve the existing public-API contract. Callers continue to access `config.Github.Host` unchanged.

`AppConfig.Default` is updated to construct the new shape:

```csharp
Github: new GithubConfig(Accounts: new[]
{
    new GithubAccountConfig(
        Id: DefaultAccountKey,
        Host: "https://github.com",
        Login: null,
        LocalWorkspace: null)
}),
```

### 4.3 Token store

`PRism.tokens.cache` stays one MSAL-wrapped file, one keychain entry. Serialized contents change:

Before (v1):
```
"ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

After (v1 with scaffold):
```jsonc
{
  "version": 1,
  "tokens": {
    "default": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

Token-store load path (in priority order):
1. **Empty / missing cache** → no-op (no token yet; user runs Setup).
2. **Parses as a single string (legacy)** → wrap as `{"version": 1, "tokens": {"default": <string>}}` and write back via MSAL. **Migration crash window**: between read and MSAL-save, a process crash leaves the file half-written or zero-byte; the user runs Setup to re-validate. This crash window is acknowledged rather than mitigated — `MsalCacheHelper.SaveUnencryptedTokenCache` does not provide atomic-rename, and adding our own temp-write-then-rename around MSAL is out of scope for this slice.
3. **Parses as `{"version": 1, "tokens": {…}}`** → no-op.
4. **Parses as `{"version": <future>, …}` (version > 1)** → token-store enters read-only mode (analogous to `AppStateStore.cs:267-269`); surface "PRism was downgraded; upgrade or wipe `PRism.tokens.cache`."
5. **Parses as `{"version": <0 or negative>, …}` or any other JSON shape** → treat as parse failure; surface "re-validate at Setup"; do **not** overwrite.
6. **Fails to parse** → same as branch 5.

The v1-after-v2 regression class (older binary destroying newer cache) is closed by the version field + read-only mode under one assumption: **v2 disciplines version bumps when extending the `tokens` map structure**. See § 7 for the binding policy v2 inherits. Without that policy, v2 could add a second token to the `tokens` map without bumping `version: 2`, in which case a v1 binary parses it as `{"version": 1, "tokens": {…}}` (branch 3, no-op) — and any downstream v1 write path that re-serializes only `default` would silently drop the v2-added token. The version-field defense is *conditional on v2's discipline*; the § 7 constraint makes that discipline binding.

Same regression-class concern applies to state.json V4 (see § 7 same constraint).

`ITokenStore` interface unchanged. Methods continue to read/write a single PAT (the `"default"` entry); the multi-token JSON shape is internal to `TokenStore`'s implementation.

**Why one file, not per-account files:**

| Trait | Per-account cache files | One file with versioned JSON map (chosen) |
|---|---|---|
| Keychain entries | N | 1 |
| First-run consent prompts (Linux) | N | 1 |
| Atomic write surface | Per-account | Whole-map |
| Corruption blast radius | One account | All accounts |
| Ops complexity | Higher | Lower |

The corruption blast radius is the only real downside, but MSAL's atomic-rename wrap keeps the corruption window small and the recovery path is the same as today's single-string cache.

## 5. Interfaces

**No interface changes in v1.** `ITokenStore`, `IReviewService`, `IAppStateStore`, `HostUrlResolver` all keep their current signatures. The storage-shape change is invisible to read-site consumers via the delegate properties on `AppState` and `GithubConfig`. Write-site consumers use the new `WithDefault*` helper methods on `AppState` (§ 4.1) — semantically equivalent to the prior `with` expressions.

This is the explicit deferral that distinguishes the storage-only scaffold from the full scaffold. Interface shapes get designed in v2 against a ratified user-facing model rather than guessed at now.

## 6. Wire conventions

**No wire changes in v1.** No `X-PRism-Account-Key` header, no `accountKey` field in SSE payloads, no middleware addition. The wire stays single-account-shaped.

v2 picks header / path / payload conventions when the runtime model is ratified.

## 7. v2 user-facing model — constraints v1 places + advisory observations

The v2 brainstorm picks the user-facing model. This section captures *binding constraints* the v1 storage-shape places on v2, plus *advisory observations* the brainstorm should consider.

### Binding constraints v1 places on v2

These are non-negotiable because v1 ships data to disk that v2 inherits. Reversal cost varies; the spec calls out which are truly irreversible vs. costly-to-revert.

1. **`accountKey` is an arbitrary opaque string** (irreversible if v2 keeps the `"default"` literal — see § 3 for the rekey alternative). v1-upgraded users carry `"default"` indefinitely if v2 doesn't rekey. Display logic, log redaction, and any UUID-shape assumption must accept the legacy literal under that path.
2. **`accountKey` MUST pass a safe-string allowlist before use in JSON map keys, log lines, file paths, or HTTP headers.** v1 hardcodes `"default"` (trivially safe). v2's `accountKey` validator MUST enforce a bounded character set (recommended: `[a-zA-Z0-9_-]`, max 64 characters). Without this, an attacker-controlled or accidentally-malformed accountKey lands in log output (CRLF injection), JSON dictionary key (escape-character injection), or path component (`../../`) depending on serializer / sink configuration. The "arbitrary opaque string" commitment in (1) is bounded by this allowlist.
3. **One MSAL token cache file, multi-account JSON map inside.** v2 can shard if needed, but the v1-shape doesn't pre-commit to sharding.
4. **Per-account `localWorkspace`** field exists. v2's clone-management can pick whether to merge clones across accounts, but the config shape supports per-account paths.
5. **Version-bump discipline (binding)**: any v2 change that extends the `tokens` map (token cache) or `accounts` map (state.json) MUST bump the corresponding `version` field, even if the shape is structurally backwards-readable by an older binary. Without this discipline, the version-field regression-mitigation in § 4.3 / § 4.1 partially fails — older binaries silently round-trip-strip new map entries. This is cheap to commit now and load-bearing if violated later.
6. **No-silent-fallback (binding) — auth-blast-radius bug class**. When v2 routes a request to one of multiple accounts, prompt the user when the routing is ambiguous; never silent fallback. Applies to:
   - **URL-paste**: if multiple accounts could serve a pasted URL, prompt.
   - **Notification routing**: a notification must be dispatched only via the account that owns the subscription, never a fallback account.
   - **Setup connect for additional accounts**: adding a new account must not silently overwrite the default account's token; explicit confirmation if a same-host account already exists.
   - **SSE channel routing**: events must be tagged to the originating account before merge; consumers filter by their authenticated account.

### Advisory for v2 brainstorm (no v1 cost if v2 picks differently)

These are recommendations, not constraints. v1 storage shape supports either the recommendation or its alternatives.

- **Inbox model**: unified-with-account-badges vs active-account-with-switcher. Both fit the v1 storage shape.
- **`PrReference` shape**: stay as `(owner, repo, number)` with `accountKey` as a sibling parameter, OR embed `accountKey` in the ref. The v1 shape doesn't force the call.
- **Per-account state partitioning** (formerly listed as "binding"): v1 ships `Accounts[accountKey]` as a top-level dictionary. v2 may repartition (e.g., add a top-level `activeAccountKey` field, or restructure `Reviews` keying) at the cost of a V4→V5 migration step (~3-5 days per § 8.4). The dictionary topology is the *preferred* shape; not load-bearing.
- **Submit pipeline**: drafts submit via the account that authored them. Per-account `Reviews` in storage already supports this.
- **Single-instance enforcement** (P0+ backlog): unchanged. Multi-account does NOT change the single-instance constraint.

## 8. Risks

### 8.1 Three options compared

| Option | All-in cost | Implementation only | What's irreversible | What's reversible | If v2 doesn't ship multi-account | If v2 ships with different shape |
|---|---|---|---|---|---|---|
| **A. No scaffold** | 0 days | 0 days | nothing | n/a | Zero cost | Full retrofit when v2 ships: schema migration + interface reshape + wire dimension addition + token-cache reshape under load. Estimate: 7-10 days. |
| **B. Storage-only scaffold (chosen)** | 3-5 days | 1-2 days | V3→V4 state, config rewrite, token cache version | Interface signatures, wire shape, middleware, write-helper API | Small dead weight: V4→V5 collapse migration (3-5d, see § 8.4). | Schema-shape leverage if v2's shape matches; partial leverage if v2 reshapes (e.g., shards token cache per-account); negative leverage if v2 picks a fundamentally different storage shape. |
| **C. Full scaffold (initial draft, rejected)** | 9-12 days | 5-7 days | V3→V4 state, config, token cache, interface signatures, wire dimension, middleware | nothing | Larger dead weight + spec/invariant repeal cost. Estimate: 5+ days to remove. | Heavier negative leverage: interface/wire/middleware all picked against unbrainstormed v2 model; high probability of partial rewrite. |

**All-in vs implementation-only**: implementation-only counts coding + unit tests. All-in adds writing-plans (~1d for a slice this scope, based on existing PRism plan documents that run 3000+ lines), code-review iteration (~1d), and the write-site rewrites across endpoints + test fixtures (§ 4.1, ~1d for ~7 production sites + test files).

The storage-only scaffold (B) dominates A in expected value if there's any non-trivial probability v2 ships multi-account, and dominates C in expected value across the full uncertainty range because it concentrates the bet on the irreversible-cheap part. The all-in 3-5d cost narrows the dominance over A vs. the optimistic 1-2d implementation framing — the bet is still positive-EV at moderate probability of v2 shipping, but lower than the round-1 framing implied.

### 8.2 V3→V4 migration risk

The C# `AppState` record changes shape, but the read delegate properties keep callers compiling for read access. Write access via `with` expressions does NOT compile against the new shape — see § 4.1 caller-migration table for the mechanical rewrite to `WithDefault*` helpers. Test fixtures that construct `AppState` directly need updating to the new constructor signature; that's a one-time rewrite across `tests/PRism.Core.Tests`, `tests/PRism.GitHub.Tests`, and `tests/PRism.Web.Tests`.

The migration step itself (`MigrateV3ToV4`) is mechanical: read three keys, write under a new parent. Atomic-rename write. Failure mode: if migration crashes mid-write, the atomic-rename guarantee leaves the V3 file intact — same recovery as V2→V3.

### 8.3 Token cache version field

Without the `version` field, an older PRism binary running against a v2-shaped cache (which has `version > 1`) would parse the JSON, fail to recognize the version, and silently re-write it as `{"version": 1, "tokens": {"default": <new-pat>}}`, destroying v2's other-account tokens. The version field + read-only mode (§ 4.3 branch 4) closes this regression class. When parsed `version > 1`, the binary enters read-only mode and surfaces "PRism was downgraded; upgrade or wipe `PRism.tokens.cache`."

The defense is conditional on v2's version-bump discipline (§ 7 constraint 5). v2 must bump `version` even when adding a token entry under a new account key — the version-extension is what triggers the older-binary branch.

Token migration write-back from legacy single-string blob is **not atomic** (§ 4.3 branch 2). Crash between read and MSAL-save loses the PAT; user runs Setup to re-validate. This crash window is small but explicitly accepted; mitigation (temp-write-then-rename around MSAL) is out of scope for this slice.

### 8.4 Dead-weight risk if v2 doesn't ship multi-account

V4→V5 collapse migration: read `accounts.default.{reviews, ai-state, last-configured-github-host}`, write at root, remove `accounts`. Plus:

- **Test-fixture churn (second pass)**: every fixture rewritten for V3→V4 reverts on V4→V5, paying the constructor-signature cost twice.
- **Production write-site reverts**: `state.WithDefaultReviews(...)` callers revert to `state with { Reviews = ... }`. Mechanical but spans the same ~7 production sites.
- **Data-integrity verification**: V5 migration must handle production state files containing months of accumulated drafts, viewed-files, AI summaries. Edge cases include the user manually editing state.json to add a non-`default` key (silent merge? quarantine? error?) — spec must commit a policy.
- **Downgrade-block for V5**: same version-field + read-only mode pattern § 4.3 applies to tokens. Without it, an older V4-only binary running against a V5 file mis-reads and clobbers.

Realistic estimate: **3-5 days** including the items above. The "small dead weight" framing in § 8.1 reflects this revised number.

The reversal cost is *contained* (3-5d, not a full architectural unwind) because the storage-only scaffold doesn't touch interfaces, wire shape, or invariants documents. The full-scaffold (option C) reversal would also need to repeal the architectural-invariants entry, undo banned-API analyzer rules, rewrite middleware ordering decisions, and update spec docs — order of magnitude more work. The storage-only scope keeps the bet contained.

### 8.5 Wrong storage shape risk

If v2 brainstorms a different storage shape (e.g., active-account with separate side-record per inactive account, or `accountKey` embedded in `PrReference`), this slice's V3→V4 migration still helps with the per-account dimension but a second migration may be needed to restructure further. Conservative read: storage-only is *probably* a partial leverage win in this case rather than zero or negative; the certain win is option A in this scenario.

§ 7 demotes the Accounts-dictionary topology from "binding constraint" to "advisory" precisely to keep this design space open.

## 9. Testing

### 9.1 Migration tests

- `AppStateMigrations.MigrateV3ToV4`: load V3 fixture → assert V4 shape, assert `accounts.default` contains all prior data, assert root-level orphan keys removed.
- `MigrateV3ToV4` idempotence: load V4 → no-op.
- `AppState.WithDefault*` helpers: assert each helper returns a new `AppState` with the targeted account-state field updated and all other fields unchanged.
- `ConfigStore` migration: load `github.host` fixture → assert rewrite to `accounts[0]` with `localWorkspace` moved under the account; assert idempotence.
- `ConfigStore` first-launch: no config file → assert seeded `accounts: [{id: "default", host: "https://github.com", login: null, localWorkspace: null}]`.
- `AppConfig.Default` round-trip: serialize `AppConfig.Default` → assert JSON contains `github.accounts[0].host` and does NOT contain `github.host`.
- `TokenStore` migration: legacy single-string blob → versioned JSON-map. Legacy missing → no-op. Future-version cache → read-only mode + clear surfacing message. **`version: 0` cache → parse-failure surface (no overwrite)**. Unparseable cache → parse-failure surface (no overwrite).

### 9.2 Backwards-compat tests

- `AppState.Reviews` (delegate property) returns `state.Accounts["default"].Reviews` for a freshly-loaded V4 state.
- `AppState.AiState`, `AppState.LastConfiguredGithubHost` likewise.
- `AppConfig.Github.Host` returns `accounts[0].host`; `AppConfig.Github.LocalWorkspace` returns `accounts[0].localWorkspace`.
- Production write-site smoke: every endpoint that previously used `state with { Reviews = ... }` now uses `state.WithDefaultReviews(...)` and produces an identical post-state to the V3 baseline (assert via state-snapshot diff against a frozen fixture).

### 9.3 No interface-boundary tests in v1

(Because no interfaces change. v2's slice adds them when interfaces gain `accountKey`.)

## 10. Project standards updates

- `docs/spec/02-architecture.md` § "GitHub host configuration" — amend to describe `github.accounts: [...]` as the canonical config shape; note that v1 has one entry and the runtime is single-account.
- `docs/spec/02-architecture.md` § "one host per launch" constraint — amend to note the constraint holds for v1 runtime but the storage shape scaffolds multiple accounts for v2.
- `docs/spec/02-architecture.md` § "Changing `github.host` between launches" — minor amend: `LastConfiguredGithubHost` lives under `accounts.default` in V4; the modal logic is unchanged.
- `docs/spec/05-non-goals.md` "Multi-host concurrency" row — amend to "Multi-host concurrency: storage shape scaffolded in v1; runtime + UX in v2."
- `docs/roadmap.md` S6 row — add S6 PR0 to the front of S6's PR sequence.
- `.ai/docs/architectural-invariants.md` — **no entry yet**. The invariant is added by v2's slice, when interfaces and runtime are committed. Adding the invariant in v1 would couple the dead-weight reversal to a doc repeal and is precisely what § 8.4 trades to keep reversal contained.

## 11. Open questions

1. **`AppState` delegate properties — public API or internal-only?** Recommendation: public for v1 (zero caller-side change for read sites). v2 removes them when interfaces gain `accountKey`. Alternative: mark `[Obsolete]` from day one so consumers get warnings. Vote against `[Obsolete]` in v1 because there's nothing for callers to migrate *to* until v2's interfaces land.

I'll commit to the default during writing-plans if you don't pull on it.
