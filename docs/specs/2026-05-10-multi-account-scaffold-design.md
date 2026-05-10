# Multi-account scaffold (v1) + multi-account v2 spec sketch

**Slice**: S6 PR0 — lands ahead of the Settings page work in S6.
**Date**: 2026-05-10.
**Status**: Design — pending user review and implementation plan.
**Branch**: `spec/multi-account-scaffold` (worktree at `D:\src\PRism\.claude\worktrees\spec+multi-account-scaffold`).
**Source authorities**: [`docs/spec/02-architecture.md`](../spec/02-architecture.md) is the PoC architecture; this slice introduces a *deliberate amendment* to its "one host per launch" constraint via scaffolding now and runtime support in v2. [`docs/roadmap.md`](../roadmap.md) S6 row gains S6 PR0 as a new prefix.

---

## 1. Goal

Land the multi-account *shape* — schema, interfaces, wire dimension, migrations — in v1 PoC, with all surfaces hardcoded to a single `"default"` account. v2 adds the user-facing model (account add/remove, unified inbox, switcher, etc.) with zero schema or interface refactor.

This mirrors the AI-seam pattern the spec already uses: ship architecture in S0+S1 with `Noop*` defaults, swap to real impls in v2 without reshaping anything.

End-to-end demo at slice completion: nothing visible to the user changes. PRism still ships single-account; the keychain still holds one PAT; the inbox still queries `@me` against one host. But internally, every persistence boundary, every API call, and every SSE event carries an `accountKey` dimension that v2 can populate without rewriting plumbing.

The bet: v2 ships multi-account. If it doesn't, the scaffold is dead weight. Section 8 quantifies the bet.

## 2. Scope

### In scope (v1, lands in S6 PR0)

- **State schema migration V3 → V4**: `AppState.{Reviews, AiState, LastConfiguredGithubHost}` move under `AppState.Accounts[accountKey].{Reviews, AiState, LastConfiguredGithubHost}`. UI preferences stay top-level (cross-account).
- **Config schema rewrite**: `github.host: string` → `github.accounts: [{ id, host, login? }]`. Idempotent at load time. v1 reads `accounts[0]`.
- **Token store reshape**: `PRism.tokens.cache` continues to be one MSAL-wrapped file, but its serialized contents change from a single-string blob to a JSON map keyed by accountKey. Token migration on first load.
- **`ITokenStore` interface**: every method gains an `accountKey` parameter. v1 callsites pass `"default"`.
- **`IReviewService` interface**: every method gains `accountKey` as the first parameter. `GitHubReviewService` resolves the per-account `HttpClient` via named factory (`$"github-{accountKey}"`).
- **`IAppStateStore` interface**: per-account accessors (`GetReviews(accountKey)`, `SetReviews(accountKey, …)`, etc.). The store internally indexes into `Accounts[accountKey]`.
- **`HostUrlResolver`**: takes an `accountKey` parameter and resolves against `config.github.accounts[…where id==accountKey].host`.
- **Wire dimension**: `X-PRism-Account-Key` header on every state-mutating request and every SSE subscription.
- **Middleware**: `AccountKeyMiddleware` validates the header; missing → defaults to `"default"` (v1 backwards-compat); unknown → 400 Bad Request.
- **SSE**: every event payload gains an `accountKey` field. v1 always emits `"default"`.
- **Frontend `apiClient`**: injects `X-PRism-Account-Key: 'default'` on every request.
- **Frontend `useStateChangedSubscriber`** (and any other SSE consumer added by the time S6 PR0 lands): accepts an optional `accountKey` parameter defaulting to `"default"`; filters incoming events by it.
- **`PrReference` stays unchanged**: `(owner, repo, number)`. `accountKey` is a sibling parameter on every backend call and request, never embedded in the ref.
- **Banned-API analyzer rule**: any new method overload on `ITokenStore` / `IReviewService` / `IAppStateStore` that omits `accountKey` fails the build.
- **State-event-log convention**: every `StateEvent.Fields` dict MUST include `"accountKey"`. S6 PR0 ships an emit-site test that fails the build if any caller of `IStateEventLog.AppendAsync` omits it. No amendment to the eventual real `IStateEventLog` impl PR.
- **Identity-change rules** for `state.json`: stay at the per-account level. Each `AccountState.LastConfiguredGithubHost` is compared against the same account's `config.github.accounts[…].host`. The host-change-between-launches modal becomes per-account in shape but only fires for the single `"default"` account in v1.

### Deferred to v2 (spec covers design intent, no code in v1)

- **Account add/remove UX**: how does the user register a second PAT? Setup screen redesign, account-list management surface, per-account validation flow.
- **Active account concept**: does the inbox show all accounts merged (recommended; see § 7) or one active account at a time?
- **Unified inbox renderer**: account badges on PR rows, parallel polling per account, rate-limit budgeting across accounts, cross-account dedup rules for the same PR appearing in two accounts.
- **URL-paste account routing**: when the user pastes a PR URL and multiple accounts could serve it (same host, two PATs), how is disambiguation done?
- **Settings page account-management surface**: list, add, remove, re-validate per-account PATs.
- **Active-PR poller per-account isolation**: parallel polling cycles, per-account backoff, rate-limit budgets.
- **SSE per-PR REST subscribe/unsubscribe per-account**: the channel keying expansion.
- **Per-account login-change rules**: when an account's `viewer.login` changes (rename), what carries forward and what clears.
- **Cross-account operations** (intentional non-feature): drafts on PR-A in Account-1 cannot move to Account-2's submission. Each account's drafts submit via that account's PAT.

### Explicit non-goal for v1

A hidden multi-account code path that's "almost working." The scaffold is `"default"`-only and rigorously single-account. No half-states. No second-account in tests. The `"default"` constant is not a feature flag.

## 3. AccountKey identity

Opaque string. Recommendation:

- v1: hardcoded `"default"`.
- v2: UUID generated at account-add time (`Guid.NewGuid().ToString("N")`).

**Why opaque, not derived from `host` or `login`:**
- A user can rename their GitHub login (rare but real). Display strings change; identity should not.
- Same for host changes within an account (e.g., GHES instance rebrand).
- Display strings (`pratyush@github.com`) are derived metadata, not the key.

**Display name** (v2): `${login}@${host}` derived from `viewer.login` and the configured host. Cached on `config.github.accounts[…].login`.

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

JsonNode-rewrite, follows existing `MigrateV2ToV3` pattern. Atomic-rename write via `AppStateStore`.

### 4.2 Config (`config.json`) — additive rewrite

Old:
```jsonc
{ "github": { "host": "https://github.com" } }
```

New:
```jsonc
{
  "github": {
    "accounts": [
      { "id": "default", "host": "https://github.com", "login": null }
    ]
  }
}
```

`ConfigStore` load path (idempotent):
- If `github.host` is present and `github.accounts` is not, rewrite to the new shape.
- If `github.accounts` is already present, no-op.
- Atomic-rename write so partial writes can't leave a file with both shapes.

### 4.3 Token store

`PRism.tokens.cache` stays one file, one MSAL-wrapped keychain entry. The serialized contents change:

Before (v1):
```
"ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

After (v1 with scaffold):
```jsonc
{ "default": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Token-store load path (idempotent):
- If the cache parses as a single string (legacy), wrap it as `{ "default": <string> }` and write back via MSAL.
- If it parses as a JSON object, no-op.
- If it fails to parse, surface as "re-validate at Setup" — same recovery path as any token corruption today.

**Why one file, not per-account files:**

| Trait | Per-account cache files (rejected) | One file with JSON map (chosen) |
|---|---|---|
| Keychain entries | N | 1 |
| First-run consent prompts (Linux) | N | 1 |
| Atomic write surface | Per-account | Whole-map |
| Corruption blast radius | One account | All accounts |
| `ClearAsync(accountKey)` | Delete file | Rewrite map |
| Ops complexity | Higher | Lower |

The corruption blast radius is the only real downside, but MSAL's atomic-rename wrap keeps the corruption window small and the recovery path is the same as today. One file wins.

## 5. Interfaces

### 5.1 `ITokenStore`

```csharp
public interface ITokenStore
{
    Task<bool>    HasTokenAsync(string accountKey, CancellationToken ct);
    Task<string?> ReadAsync(string accountKey, CancellationToken ct);
    Task          WriteTransientAsync(string accountKey, string token, CancellationToken ct);
    Task          SetTransientLoginAsync(string accountKey, string login, CancellationToken ct);
    Task<string?> ReadTransientLoginAsync(string accountKey, CancellationToken ct);
    Task          CommitAsync(string accountKey, CancellationToken ct);
    Task          RollbackTransientAsync(string accountKey, CancellationToken ct);
    Task          ClearAsync(string accountKey, CancellationToken ct);
}
```

### 5.2 `IReviewService`

`accountKey` becomes the first parameter on every method. `GitHubReviewService` uses it to:
- Resolve the per-account `HttpClient` via `IHttpClientFactory.CreateClient($"github-{accountKey}")`.
- Resolve the per-account host via `HostUrlResolver.ApiBase(config.github.accounts[…where id==accountKey].host)`.

In v1, the named-client registration in `ServiceCollectionExtensions` registers exactly one client (`"github-default"`). In v2, it registers one per configured account.

### 5.3 `IAppStateStore`

Replace flat accessors with per-account accessors:

```csharp
public interface IAppStateStore
{
    Task<bool> LoadAsync(CancellationToken ct);
    bool IsReadOnly { get; }

    // Per-account accessors
    PrSessionsState GetReviews(string accountKey);
    Task SetReviewsAsync(string accountKey, PrSessionsState value, CancellationToken ct);

    AiState GetAiState(string accountKey);
    Task SetAiStateAsync(string accountKey, AiState value, CancellationToken ct);

    string? GetLastConfiguredGithubHost(string accountKey);
    Task SetLastConfiguredGithubHostAsync(string accountKey, string? value, CancellationToken ct);

    // Cross-account
    UiPreferences GetUiPreferences();
    Task SetUiPreferencesAsync(UiPreferences value, CancellationToken ct);

    Task ResetAsync(CancellationToken ct);
}
```

The store internally indexes into `Accounts[accountKey]`. Unknown accountKey on read → throws `UnknownAccountException` (caller bug, not user-facing).

### 5.4 `HostUrlResolver`

```csharp
public static class HostUrlResolver
{
    public static Uri ApiBase(string host);          // unchanged signature; called with the per-account host
    public static Uri GraphQlEndpoint(string host);  // unchanged
}
```

The resolver itself doesn't need an `accountKey` parameter — callers fetch the per-account host from config and pass the string in. But every call-site in `GitHubReviewService` (and any future caller) MUST resolve the host from `config.github.accounts[accountKey].host`, never from a hardcoded source.

## 6. Wire convention

### 6.1 `X-PRism-Account-Key` header

On every state-mutating request:
- `PUT /api/pr/{ref}/draft`
- `POST /api/pr/{ref}/reload`
- `POST /api/auth/connect`, `POST /api/auth/connect/commit`
- All future state-mutating endpoints (banned-API analyzer enforces inclusion via the middleware path).

On every read endpoint that depends on identity:
- `GET /api/pr/{ref}/draft`
- `GET /api/inbox`
- `GET /api/pr/{ref}/...` (all PR-detail reads)
- `GET /api/capabilities` (capabilities can vary per account in v2)

Not on:
- `GET /api/preferences` / `POST /api/preferences` — UI prefs are cross-account.
- Static asset routes.

### 6.2 `AccountKeyMiddleware`

Sits next to `SessionTokenMiddleware` and `OriginCheckMiddleware`. Reads `X-PRism-Account-Key`:

| Header value | v1 behavior | v2 behavior |
|---|---|---|
| Absent | Default to `"default"`. Pass through. | 400 Bad Request — header is mandatory. |
| `"default"` | Pass through. | Pass through (v2 still has a "default" if user hasn't renamed). |
| Unknown / not in `config.github.accounts` | 400 Bad Request. | 400 Bad Request. |

The v1 default-to-`"default"` is a transitional courtesy. v2 makes it mandatory because clients will be aware of the dimension by then.

The middleware sets the resolved accountKey on `HttpContext.Items["PRismAccountKey"]` for downstream handlers.

### 6.3 SSE event payloads

Every event gains an `accountKey` field:

```jsonc
{ "type": "state-changed", "accountKey": "default", "prRef": "owner/repo/123", "sourceTabId": "...", "fieldsTouched": [...] }
{ "type": "draft-saved",   "accountKey": "default", "prRef": "owner/repo/123", ... }
{ "type": "inbox-updated", "accountKey": "default" }
```

Consumers (e.g., `useStateChangedSubscriber`) filter on `event.accountKey === expectedAccountKey`. v1 expectedAccountKey is `"default"`.

### 6.4 Frontend `apiClient`

Injects `X-PRism-Account-Key: 'default'` on every request, baked into the wrapper analogous to `X-Request-Id`. The constant lives in one place. v2 replaces the constant with a runtime-resolved value from the active account context.

## 7. v2 user-facing model (sketch — to be expanded by v2 brainstorm)

The v1 scaffold is shaped to support a **unified inbox with account badges** as the v2 default. This section captures the design intent so v1 doesn't accidentally constrain it; v2's brainstorm will ratify or revise.

**Inbox model (recommended for v2):**
- All accounts' PRs in one merged list.
- Each row is badged with its account (`pratyush@github.com`, `pratyush@github.acmecorp.com`, etc.).
- Backend polls accounts in parallel; merges results before serving the inbox endpoint.
- Rate-limit budgets are per-account (each PAT has its own GitHub Search 30/min and Core 5000/hour budgets).

**Account add/remove (v2):**
- Settings page surfaces a list of registered accounts.
- "Add account" flow re-uses the Setup screen: pick a host, paste a PAT, validate, name the account (default name: `${login}@${host}`).
- "Remove account" deletes the account's `AccountState`, removes its token from `PRism.tokens.cache`'s map, removes its config entry, and stops its poller.

**URL-paste routing (v2):**
- If only one registered account's host matches the pasted URL, route there.
- If multiple match (two PATs against the same host), prompt the user to pick. No silent fallback — silent routing creates auth-blast-radius bugs.

**Submit pipeline (v2):**
- Drafts submit via the account that authored them. The account is recorded on every draft (already true in v1 schema: drafts live under `AccountState.Reviews`).
- Cross-account draft moves are not supported. If a user wants to submit Account-A's draft as Account-B, they re-author it.

**Identity-change rules (v2):**
- Per-account `viewer.login` change → carry forward drafts (same identity in PRism's eyes), clear `pendingReviewId`/`threadId`/`replyCommentId` (host issues those server-side and may not honor them after a user rename in edge cases).
- Per-account host change → already covered by v1's host-change-between-launches modal, now scoped to the affected account.

**Single-instance enforcement** (already a P0+ backlog item per `docs/roadmap.md`): unchanged. Multi-account does NOT change the single-instance constraint. Two PRism processes still write the same `state.json` last-write-wins. The named-mutex / IPC fix is independent of multi-account.

## 8. Risks

### 8.1 Dead-weight risk

If v2 doesn't ship multi-account (e.g., dogfooding shows two-instance is fine, or the wedge moves), the scaffold is permanent code complexity for no user value.

**Mitigation:**
- Scaffold cost is bounded: ~5-7 day slice (S6 PR0).
- The shape is reversible — collapsing `AccountState` back to flat fields is a V4→V5 migration of similar size.
- The cost of *not* scaffolding and later needing it is strictly larger (full retrofit of every interface plus migration plus token-cache reshape under load).

The bet is on v2 shipping multi-account. My read is that it will: multi-account is table-stakes once people use the tool seriously across personal+work contexts. AI-seam-style scaffolding has worked for the analogous bet on AI providers.

### 8.2 Schema-level retrofit fatigue

Every state migration adds incremental risk: data loss on bug, complexity on read, version-drift across users. V3 just landed; V4 immediately after is the third migration in two slices.

**Mitigation:**
- Migration framework already exists (`AppStateMigrations.MigrateV2ToV3` pattern).
- V3→V4 is mechanical (move three keys under a new parent); no data transformation, no validation, no fallible computation.
- Test fixtures from V3 → V4 are easy to author (load V3 sample, assert V4 shape).

### 8.3 Forward-reference rot

The v1 scaffold names the `accountKey` dimension everywhere but exercises only `"default"`. Risk: v2 finds the dimension was shaped wrong (e.g., string was the wrong choice; should have been a typed `AccountKey` value object) and has to retrofit anyway.

**Mitigation:**
- The `accountKey` parameter is declared as a typed `AccountKey` record-struct (`public readonly record struct AccountKey(string Value)`) from day one, not a bare `string`. Future evolution within the type is a non-breaking change to callers.
- Builder pattern for typed access at v1 → eliminates "string vs typed" retrofit.

### 8.4 Convention drift on state-event-log

The convention "every `StateEvent.Fields` MUST include `accountKey`" relies on developer memory between now and the real `IStateEventLog` impl PR. Risk: convention forgotten.

**Mitigation:**
- Convention recorded in this spec.
- S6 PR0 ships an emit-site test that fails the build if any caller of `IStateEventLog.AppendAsync` omits `"accountKey"` from `Fields`.
- The test scans the codebase for `IStateEventLog`-typed call sites at compile time (Roslyn analyzer) or via reflection-based scan in a unit test (whichever is cheaper to author).

## 9. Testing

### 9.1 Migration tests (must exist)

- `AppStateMigrations.MigrateV3ToV4`: load V3 fixture → assert V4 shape, assert `accounts.default` contains all prior data, assert root-level orphan keys removed.
- `MigrateV3ToV4` idempotence: load V4 → no-op.
- `ConfigStore` migration: load `github.host` fixture → assert rewrite to `accounts[0]`, assert idempotent re-load.
- `TokenStore` migration: legacy single-string blob → JSON-map shape with one `"default"` key. Legacy missing → no-op. Legacy unparseable → surfaces as "re-validate at Setup."

### 9.2 Boundary tests (must exist)

- `IReviewService.{any method}` with `accountKey == null` → `ArgumentNullException` at boundary.
- `IReviewService.{any method}` with unknown `accountKey` → `UnknownAccountException`.
- `AccountKeyMiddleware` with `X-PRism-Account-Key: <unknown>` → 400.
- `AccountKeyMiddleware` with no header (v1) → defaults to `"default"`, passes through.
- `AccountKeyMiddleware` with `X-PRism-Account-Key: default` → passes through.

### 9.3 Round-trip tests

- Parameterized fixture: every state-mutating endpoint added in S3-S5 round-trips with `accountKey == "default"` end-to-end. Read-then-write-then-read returns identical state.

### 9.4 Convention tests

- Emit-site test: scan all `IStateEventLog.AppendAsync` calls; fail build if any pass a `Fields` dict without an `"accountKey"` key.
- Banned-API analyzer rule: any new method on `ITokenStore` / `IReviewService` / `IAppStateStore` lacking `accountKey` parameter fails the build.

## 10. Project standards updates

- `docs/spec/02-architecture.md` § "GitHub host configuration" — amend to describe `github.accounts: [...]` as the canonical shape; note the v1 single-entry constraint and the v2 multi-account expansion.
- `docs/spec/02-architecture.md` § "Changing `github.host` between launches" — amend to describe the per-account `LastConfiguredGithubHost` model.
- `docs/spec/05-non-goals.md` "Multi-host concurrency" row — amend to "Multi-host concurrency: scaffolded in v1 (single-account hardcoded); v2 ships runtime."
- `docs/roadmap.md` S6 row — add S6 PR0 to the front of S6's PR sequence.
- `.ai/docs/architectural-invariants.md` — add an invariant: "All identity-bearing surfaces (token store, review service, app state store, state-event-log entries, SSE events, mutating HTTP requests) take or carry an `accountKey` dimension. v1 hardcodes `"default"`; v2 populates from the active account."
- `.ai/docs/documentation-maintenance.md` — add a row for "multi-account scaffold changes" pointing at the architectural invariant.

## 11. Out-of-scope explicitly

- Settings page UX (S6 main work, not S6 PR0).
- Account add/remove flow (v2).
- Inbox aggregation logic (v2).
- Per-account rate-limit budgeting at runtime (v2; v1 has one account so the budget is the existing single-PAT budget).
- Per-account active-PR poller (v2).
- Cross-account draft moves (intentional non-feature).
- Single-instance enforcement (independent backlog item; multi-account does not unblock or block it).
- Multi-platform (still a non-goal; multi-account is multi-PAT-on-GitHub, not multi-provider).

## 12. Open questions for user review

1. **`AccountKey` as record-struct vs bare string.** I've recommended record-struct for type-safety against accidental string mixing (e.g., passing a `prRefStr` where an `accountKey` was expected). Cost: minor verbosity at call sites (`new AccountKey("default")`). Worth it?
2. **`AccountKeyMiddleware` v1 default behavior.** I've defaulted missing-header to `"default"`. Alternative: require the header from day one in v1, force the frontend to send it from S6 PR0 ship date. Cost: stricter contract, no transitional courtesy. Benefit: v1 is closer to v2's contract, fewer "but in v1 …" caveats in v2 brainstorm.
3. **Banned-API analyzer scope.** I've scoped it to the three core interfaces. Should it also cover `HostUrlResolver` and any future identity-bearing API?
4. **State-event-log emit-site test approach.** Roslyn analyzer (build-time, more upfront work, perfect coverage) vs. reflection-based unit test (test-time, cheaper to author, catches at PR-time not edit-time). Recommendation: reflection-based — analyzers are heavyweight for one-off conventions.

These are real open calls. I'll commit to defaults during writing-plans if you don't pull on them.
