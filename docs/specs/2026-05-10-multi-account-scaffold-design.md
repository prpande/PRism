# Multi-account storage-shape scaffold (v1) + multi-account v2 spec sketch

**Slice**: S6 PR0 — lands ahead of the Settings page work in S6.
**Date**: 2026-05-10.
**Status**: Design — pending user review and implementation plan.
**Branch**: `spec/multi-account-scaffold` (worktree at `D:\src\PRism\.claude\worktrees\spec+multi-account-scaffold`).
**Source authorities**: [`docs/spec/02-architecture.md`](../spec/02-architecture.md) is the PoC architecture; this slice introduces a *deliberate amendment* to its "one host per launch" constraint via storage-shape scaffolding now and runtime support in v2. [`docs/roadmap.md`](../roadmap.md) S6 row gains S6 PR0 as a new prefix.
**Review history**: ce-doc-review surfaced significant scope concerns; § 8.1 was reshaped to adopt the **storage-only scaffold** alternative the initial draft missed. The full-scaffold and no-scaffold options are documented there for completeness.

---

## 1. Goal

Reshape the *on-disk* and *config* surfaces — `state.json`, `config.json`, the token cache — to a multi-account-friendly shape in v1, with all in-memory interfaces and wire payloads unchanged. v2 brainstorms the user-facing model and runtime semantics; when v2 ships, the irreversible bit (data on disk for existing users) is already friendly. Reversible bits (interface signatures, middleware, wire headers) are explicitly out of scope and get designed against the ratified v2 model.

This is the *narrowest* AI-seam-analogous move: AI seams shipped interface contracts in S0+S1 because the v2 implementer had already specified them; multi-account doesn't have that benefit yet, so we ship only the part that's irreversible-if-deferred (storage shape) and defer the part that benefits from v2 design input (interfaces, runtime).

End-to-end demo at slice completion: nothing visible to the user changes. PRism still ships single-account; the keychain still holds one PAT in a JSON-map blob with one entry; the inbox still queries `@me` against one host. Internally, `AppState` exposes `Accounts["default"]` while preserving the existing `Reviews` / `AiState` / `LastConfiguredGithubHost` accessors via delegate properties, so all callers compile and run unchanged.

The bet: v2 ships multi-account *and* the storage shape this slice picks turns out to fit it. If v2 abandons multi-account, the storage shape is dead weight (small, easily reverted via V4→V5). If v2 ships multi-account but with a different storage shape (e.g., active-account record rather than dictionary, or accountKey embedded in `PrReference`), this slice helps less than zero — section 8 quantifies.

## 2. Scope

### In scope (v1, lands in S6 PR0)

1. **State schema migration V3 → V4**: `AppState.{Reviews, AiState, LastConfiguredGithubHost}` move under `AppState.Accounts[accountKey].{Reviews, AiState, LastConfiguredGithubHost}`. UI preferences stay top-level (cross-account).
2. **`AppState` C# record** gains delegate properties for backwards compat: `state.Reviews` returns `state.Accounts["default"].Reviews`, etc. Callers compile and run unchanged. The delegate properties are marked with a comment indicating they will be removed in v2 alongside the multi-account runtime.
3. **Config schema rewrite**: `github.host: string` → `github.accounts: [{ id, host, login?, localWorkspace? }]`. `LocalWorkspace` (currently a sibling of `Host` on `GithubConfig`) moves under each account because clone access is PAT-scoped — same repo cloned for two PATs may have different access paths in v2. v1 has one entry. `AppConfig.Github.Host` becomes a delegate property reading `Accounts[0].Host`.
4. **Token cache reshape with version field**: `PRism.tokens.cache` continues to be one MSAL-wrapped file. Its serialized contents change from `"<pat>"` to `{"version": 1, "tokens": {"default": "<pat>"}}`. The `version` field exists so v1 binaries running against a future-version cache fail loudly rather than silently downgrading.
5. **Token migration on first load**: legacy single-string blob → versioned JSON-map with one `"default"` key. Idempotent. Unparseable cache (or future-version cache) surfaces as "re-validate at Setup" without overwriting.
6. **`AccountKey` as a string constant**, not a typed record-struct. Single source of truth: `public const string DefaultAccountKey = "default";` in `PRism.Core.State`. v1 always uses this constant; v2 introduces UUID generation alongside it.
7. **First-launch initialization**: `ConfigStore` seeds `accounts: [{id: "default", host: null, login: null, localWorkspace: null}]` on first launch when no config exists. Setup populates `host` on commit.
8. **`"default"` key as a permanent fixture in v2**: the spec commits that v1-upgraded users keep `accountKey == "default"` indefinitely. v2's `accountKey` validator MUST accept arbitrary opaque strings, not just UUIDs. Future code that assumes UUID shape (display logic, log redaction) carries this constraint.

### Explicitly NOT in scope (deferred to v2 brainstorm)

The following were in an earlier draft of this spec; ce-doc-review's storage-only-alternative finding moved them out:

- `ITokenStore`, `IReviewService`, `IAppStateStore` interface signatures (no `accountKey` parameter in v1)
- `AccountKeyMiddleware` and the `X-PRism-Account-Key` header
- SSE `accountKey` payload field
- Frontend `apiClient` header injection
- State-event-log emit-site convention enforcement
- Banned-API analyzer rules / Roslyn-emit-site tests for accountKey threading
- Per-account named `HttpClient` registration
- URL-paste account routing logic

These all benefit from the v2 brainstorm having ratified the user-facing model first. Shipping them now bakes guesses about runtime semantics (unified inbox vs switcher, per-account vs global rate-limit budgets, account-on-PrReference vs sibling parameter) into v1 with no exit ramp other than another reshape.

### Deferred to v2 (runtime + UX, no v1 commitment)

- Account add/remove UX (Setup screen redesign, account-list management surface, per-account validation flow)
- Active-account vs unified-inbox decision
- Inbox aggregation (parallel polling, rate-limit budgeting, dedup of same PR across accounts)
- URL-paste account routing including the **non-negotiable rule**: if multiple accounts could serve a pasted URL, prompt the user — never silent fallback (auth-blast-radius bug class). This rule is captured here so the v2 brainstorm inherits it.
- Per-account active-PR poller, SSE channel keying, host-change-modal scoping
- Cross-account operations (intentional non-feature: drafts submit via the account that authored them; no cross-account moves)
- Identity-change rules per-account (login rename, host rebrand)

### Explicit non-goals for v1

- Hidden multi-account code path. The scaffold is `"default"`-only and rigorously single-account. No half-states.
- Interface or wire shape commitments. v2 picks those.

## 3. AccountKey identity

Bare string. Single constant: `public const string DefaultAccountKey = "default";` in `PRism.Core.State`. v1 callers reference the constant.

v2 introduces UUID generation at account-add time (`Guid.NewGuid().ToString("N")`) but MUST treat `accountKey` as an opaque string — not a UUID — because the legacy `"default"` key persists for v1-upgraded users.

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
    // Backwards-compat delegate properties — to be removed in v2 alongside multi-account runtime.
    public PrSessionsState Reviews => Accounts[DefaultAccountKey].Reviews;
    public AiState AiState => Accounts[DefaultAccountKey].AiState;
    public string? LastConfiguredGithubHost => Accounts[DefaultAccountKey].LastConfiguredGithubHost;

    public static AppState Default { get; } = new(
        Version: 4,
        UiPreferences: UiPreferences.Default,
        Accounts: new Dictionary<string, AccountState>
        {
            [DefaultAccountKey] = AccountState.Default
        });
}

public sealed record AccountState(
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost);
```

The delegate properties exist solely to keep all callers (inbox, PR detail, drafts, submit pipeline, every test fixture) compiling and running unchanged. v2 either removes them when interface signatures change to take `accountKey`, or leaves them with a different default-resolution policy.

`IAppStateStore` interface unchanged. `LoadAsync` / `SaveAsync` / `UpdateAsync` operate on the new `AppState` shape; consumers see the existing flat property surface.

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
- If neither present (fresh install), seed `accounts: [{id: "default", host: null, login: null, localWorkspace: null}]`.
- Atomic-rename write so partial writes can't leave a file with both shapes.

`AppConfig.GithubConfig` C# record:

```csharp
public sealed record GithubConfig(IReadOnlyList<GithubAccountConfig> Accounts)
{
    // Backwards-compat delegate properties — removed in v2.
    public string Host => Accounts[0].Host;
    public string? LocalWorkspace => Accounts[0].LocalWorkspace;
}

public sealed record GithubAccountConfig(string Id, string? Host, string? Login, string? LocalWorkspace);
```

Callers continue to access `config.Github.Host` unchanged.

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

Token-store load path:
- If the cache parses as a single string (legacy), wrap it as `{"version": 1, "tokens": {"default": <string>}}` and write back via MSAL.
- If it parses as `{"version": 1, "tokens": {…}}`, no-op.
- If it parses as `{"version": <future>, …}`, set token-store to read-only mode (analogous to `AppStateStore` future-version handling at `AppStateStore.cs:267-269`), surface as "PRism was downgraded; upgrade or wipe `PRism.tokens.cache`."
- If it fails to parse, surface as "re-validate at Setup" — and DO NOT overwrite the cache file. Setup writes a fresh `{"version": 1, "tokens": {…}}` only after successful PAT validation.

The v1-after-v2 regression class (older binary destroying newer cache) is closed by the version field + read-only mode. Without this, an older binary that meets a future v2 cache would silently re-write as `{"version": 1, "tokens": {"default": <new-pat>}}`, destroying any other-account tokens v2 had stored.

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

**No interface changes in v1.** `ITokenStore`, `IReviewService`, `IAppStateStore`, `HostUrlResolver` all keep their current signatures. The storage-shape change is invisible to consumers via the delegate properties on `AppState` and `GithubConfig`.

This is the explicit deferral that distinguishes the storage-only scaffold from the full scaffold. Interface shapes get designed in v2 against a ratified user-facing model rather than guessed at now.

## 6. Wire conventions

**No wire changes in v1.** No `X-PRism-Account-Key` header, no `accountKey` field in SSE payloads, no middleware addition. The wire stays single-account-shaped.

v2 picks header / path / payload conventions when the runtime model is ratified.

## 7. v2 user-facing model (sketch — non-binding)

The v2 brainstorm picks the user-facing model. This section captures *constraints* the v1 storage-shape places on it, plus advisory observations the brainstorm should consider.

**Constraints v1 places on v2:**

1. **`accountKey` is an arbitrary opaque string**, not a UUID. v1-upgraded users carry `"default"` indefinitely. Display logic, log redaction, and any UUID-shape assumption must accept the legacy literal.
2. **Per-account state lives under `Accounts[accountKey]`**. v2 can repartition (e.g., add a top-level `activeAccountKey` field, or restructure `Reviews` keying), but the per-account top-level dimension is committed.
3. **Per-account `localWorkspace`**. v2's clone-management can pick whether to merge clones across accounts, but the config shape supports per-account paths.
4. **One MSAL token cache file, multi-account JSON map inside.** v2 can shard if needed, but the v1-shape doesn't pre-commit to sharding.

**Advisory for v2 brainstorm (no v1 cost if v2 picks differently):**

- **Inbox model**: unified-with-account-badges vs active-account-with-switcher. Both fit the v1 storage shape.
- **`PrReference` shape**: stay as `(owner, repo, number)` with `accountKey` as a sibling parameter, OR embed `accountKey` in the ref. The v1 shape doesn't force the call.
- **URL-paste routing** (binding non-negotiable): no silent fallback when multiple accounts could serve a pasted URL. Always prompt. Captured here so v2 brainstorm inherits it.
- **Submit pipeline**: drafts submit via the account that authored them. Per-account `Reviews` in storage already enforces this.
- **Single-instance enforcement** (P0+ backlog): unchanged. Multi-account does NOT change the single-instance constraint.

## 8. Risks

### 8.1 Three options compared

| Option | Cost | What's irreversible | What's reversible | If v2 doesn't ship multi-account | If v2 ships with different shape |
|---|---|---|---|---|---|
| **A. No scaffold** | 0 days | nothing | n/a | Zero cost | Full retrofit when v2 ships: schema migration + interface reshape + wire dimension addition + token-cache reshape under load. Estimate: 7-10 days. |
| **B. Storage-only scaffold (chosen)** | 1-2 days | V3→V4 state, config rewrite, token cache version | Interface signatures, wire shape, middleware | Small dead weight: V4→V5 collapse migration (1 day). | Schema-shape leverage if v2's shape matches; partial leverage if v2 reshapes (e.g., shards token cache per-account); negative leverage if v2 picks a fundamentally different storage shape (rare — the per-account dictionary is the standard pattern). |
| **C. Full scaffold (initial draft, rejected)** | 5-7 days | V3→V4 state, config, token cache, interface signatures, wire dimension, middleware | nothing | Larger dead weight + spec/invariant repeal cost. Estimate: 5+ days to remove. | Heavier negative leverage: interface/wire/middleware all picked against unbrainstormed v2 model; high probability of partial rewrite. |

The storage-only scaffold (B) dominates A in expected value if there's any non-trivial probability v2 ships multi-account, and dominates C in expected value across the full uncertainty range because it concentrates the bet on the irreversible-cheap part.

### 8.2 V3→V4 migration risk

The C# `AppState` record changes shape, but the delegate properties (`state.Reviews => state.Accounts["default"].Reviews`) keep all callers compiling. Test fixtures that construct `AppState` directly need updating to the new constructor signature; that's mechanical (~all `new AppState(...)` calls in tests). Production code using property accessors (`state.Reviews`) is unchanged.

The migration step itself (`MigrateV3ToV4`) is mechanical: read three keys, write under a new parent. Atomic-rename write. Failure mode: if migration crashes mid-write, the atomic-rename guarantee leaves the V3 file intact — same recovery as V2→V3.

### 8.3 Token cache version field

Without the `version` field, an older PRism binary running against a v2-shaped cache silently re-writes it as a fresh single-`"default"` map, destroying v2's other-account tokens. The version field + read-only mode closes this regression class. Added in this slice.

### 8.4 Dead-weight risk if v2 doesn't ship multi-account

V4→V5 collapse migration: read `accounts.default.{reviews, ai-state, last-configured-github-host}`, write at root, remove `accounts`. ~1 day including tests. The C# delegate properties get removed and `AppState` reverts to its V3 shape. Atomic-rename write.

The reversal cost is small *because the storage-only scaffold doesn't touch interfaces, wire shape, or invariants documents*. The full-scaffold (option C) reversal would also need to repeal the architectural-invariants entry, undo banned-API analyzer rules, rewrite middleware ordering decisions, and update spec docs — order of magnitude more work. The storage-only scope keeps the bet contained.

### 8.5 Wrong storage shape risk

If v2 brainstorms a different storage shape (e.g., active-account with separate side-record per inactive account, or `accountKey` embedded in `PrReference`), this slice's V3→V4 migration still helps with the per-account dimension but a second migration may be needed to restructure further. The conservative read: storage-only is *probably* a partial leverage win in this case rather than zero or negative; the certain win is option A in this scenario.

## 9. Testing

### 9.1 Migration tests

- `AppStateMigrations.MigrateV3ToV4`: load V3 fixture → assert V4 shape, assert `accounts.default` contains all prior data, assert root-level orphan keys removed.
- `MigrateV3ToV4` idempotence: load V4 → no-op.
- `ConfigStore` migration: load `github.host` fixture → assert rewrite to `accounts[0]` with `localWorkspace` moved under the account; assert idempotence.
- `ConfigStore` first-launch: no config file → assert seeded `accounts: [{id: "default", host: null, login: null, localWorkspace: null}]`.
- `TokenStore` migration: legacy single-string blob → versioned JSON-map. Legacy missing → no-op. Future-version cache → read-only mode + clear surfacing message.
- `TokenStore` non-overwrite-on-unparseable: corrupt cache file → "re-validate at Setup" surface; assert cache file untouched until Setup commits.

### 9.2 Backwards-compat tests

- `AppState.Reviews` (delegate property) returns `state.Accounts["default"].Reviews` for a freshly-loaded V4 state.
- `AppState.AiState`, `AppState.LastConfiguredGithubHost` likewise.
- `AppConfig.Github.Host` returns `accounts[0].host`.
- All existing test suites (S2 inbox, S3 PR detail, S4 drafts) pass against the V4 state without modification.

### 9.3 No interface-boundary tests in v1

(Because no interfaces change. v2's slice adds them when interfaces gain `accountKey`.)

## 10. Project standards updates

- `docs/spec/02-architecture.md` § "GitHub host configuration" — amend to describe `github.accounts: [...]` as the canonical config shape; note that v1 has one entry and the runtime is single-account.
- `docs/spec/02-architecture.md` § "Changing `github.host` between launches" — minor amend: `LastConfiguredGithubHost` lives under `accounts.default` in V4; the modal logic is unchanged.
- `docs/spec/05-non-goals.md` "Multi-host concurrency" row — amend to "Multi-host concurrency: storage shape scaffolded in v1; runtime + UX in v2."
- `docs/roadmap.md` S6 row — add S6 PR0 to the front of S6's PR sequence.
- `.ai/docs/architectural-invariants.md` — **no entry yet**. The invariant is added by v2's slice, when interfaces and runtime are committed. Adding the invariant in v1 would couple the dead-weight reversal to a doc repeal and is precisely what § 8.4 trades to keep reversal small.

## 11. Open questions

1. **`AppState` delegate properties — public API or internal-only?** Recommendation: public for v1 (zero caller-side change). v2 removes them when interfaces gain `accountKey`. Alternative: mark `[Obsolete]` from day one so consumers get warnings encouraging migration. I'd vote against the obsolete attribute in v1 because there's nothing for callers to migrate *to* until v2's interfaces land.
2. **Should the `accountKey == "default"` constant be exported from `PRism.Core.State` or co-located with each consumer?** Recommendation: single export (`PRism.Core.State.DefaultAccountKey`). Used by the migrations and by `AppState` itself; nothing else references it in v1.
3. **Token cache version field migration policy beyond v2.** v1 ships `version: 1`. If v2 changes the cache shape (e.g., adds `lastValidatedAt` per token), it bumps to `version: 2` and writes a `MigrateTokenCacheV1ToV2`. Worth committing to that policy now or deferring? Recommendation: defer; the policy follows the state-migration pattern naturally.

These are real open calls. I'll commit to defaults during writing-plans if you don't pull on them.
