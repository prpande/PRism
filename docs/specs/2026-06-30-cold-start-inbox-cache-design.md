# Cold-start inbox + activity-rail cache — design (#619)

**Status:** draft — round-1 `ce-doc-review` applied (§13); awaiting human spec gate (B1)
**Issue:** [#619](https://github.com/prpande/PRism/issues/619) — `Cold-start inbox cache: persist last-known-good snapshot, rehydrate on launch (stale-while-revalidate, no empty first paint)`
**Tier / Risk:** T3 / gated B1 (`needs-design` — the staleness affordance needs a human eyeball; identity-keyed persistence is surfaced for the gate)
**Author:** Claude Code executor
**Review:** round-1 `ce-doc-review` (coherence, feasibility, adversarial, security-lens, design-lens, product-lens, scope-guardian) — dispositions in §13. A round-2 pass runs on request.
**Scope note:** the issue names the inbox; covering the **activity rail** as a second cache was added at the **issue owner's explicit request** ("this also applies to the activity rail sections as well") — it is sanctioned scope, not drift (§3.3, §12 decision 1).
**Related:** #505 (progressive recency-staged loading — complementary; §8); #664 (`AppStateStore` `_current` cache — the persistence pattern this mirrors); #663/#678 (inbox lock-held scan — context for §5.1's outside-the-lock write).

## 1. Problem

On every app restart the inbox and the activity rail paint **nothing real** until the
first live GitHub round-trip completes:

- **Inbox.** `InboxRefreshOrchestrator` holds its snapshot in a single in-memory field
  `private InboxSnapshot? _current` (`InboxRefreshOrchestrator.cs:29`), lost on process
  exit. The first `GET /api/inbox` blocks on `WaitForFirstSnapshotAsync` until
  `InboxPoller`'s first `RefreshAsync` finishes — the slow part of cold start (sections
  query + batch hydration + CI fan-out + AI). The frontend shows `InboxSkeleton` for the
  whole window (`InboxPage.tsx:115`, gated on `isLoading && !data`).
- **Activity rail.** `ActivityProvider` holds its feed in an in-memory 60s-TTL field
  `volatile CacheEntry? _cache` (`ActivityProvider.cs:28`), also lost on exit. `GET
  /api/activity` refetches three GitHub reads + a timeline enrichment pass on first call;
  the rail shows its skeleton until then (`ActivityRail.tsx:210`).

We had a perfectly good list and feed a moment ago when the app last closed. The user
stares at content-less surfaces every launch.

## 2. Goal / non-goals

**Goal.** Persist the last-known-good **inbox snapshot** and **activity feed** to the
data dir and rehydrate them on startup *before* the first live fetch, so both surfaces
paint real prior data **as soon as identity is confirmed** (one fast validation call, not
the full inbox refresh), marked **stale / refreshing**, then reconcile in place once the
live fetch lands (stale-while-revalidate). No skeleton-only first paint when a prior cache
exists for the **current identity**.

**Non-goals.**
- **No frontend localStorage / sessionStorage cache.** Rejected as primary in the issue:
  the backend GET would still return empty initially, producing a stale(FE)→empty(BE)→live
  flicker. Backend persistence is the single source of truth. A thin FE pre-GET cache is a
  possible *future* layer, not in scope (§9 deferral D1).
- **No change to the GitHub fetch path, poll cadence, or refresh logic.** This caches the
  *result*; #505 stages the *fetch*. They compose (§8).
- **No restructuring of existing wire fields.** We add **one new boolean per response**
  (`stale` on `InboxResponse` and `ActivityResponse`) to drive the refreshing affordance —
  see §9. (An earlier draft claimed "no new wire fields"; design-lens review (§13 D1)
  showed `lastRefreshedAt` alone cannot signal the *refreshing* half of the contract, so
  the minimal `stale` flag is required.)
- **No migration of the persisted caches.** They are **disposable**: any problem (missing,
  corrupt, wrong version, identity mismatch, host mismatch, structurally invalid) → discard
  → today's empty-then-fetch. We never migrate or quarantine-and-resave (unlike
  `AppStateStore`); the next refresh overwrites.
- **No interface changes** to `IInboxRefreshOrchestrator`, `IActivityProvider`. (The
  *concrete* `InboxRefreshOrchestrator` surface grows by one method, `TryRehydrate`, and the
  orchestrator is now dual-registered — see §5.2 / §13 F2. The interfaces are untouched.)

## 3. Architecture — one shared helper, two integrations

The persistence logic is identical for both caches: an on-disk envelope stamped with a
schema version and the owner identity, an atomic write, and a load that validates version +
identity + integrity and returns "miss" on any failure. That non-trivial core lives **once**
in a generic helper; two thin per-subsystem integrations wire the write hook and the
rehydrate hook.

### 3.1 `IdentityKeyedFileCache<T>` (new, `PRism.Core/Storage/`) — addresses issue constraint #3 (schema versioning + corruption safety)

```csharp
public sealed class IdentityKeyedFileCache<T> where T : class
{
    public IdentityKeyedFileCache(string path, int schemaVersion,
        Func<T, bool>? isStructurallyValid = null, ILogger? log = null);

    // Serialize {version, owner-login, owner-host, payload}; temp-write; AtomicFileMove.
    // Best-effort: never throws to the caller (logs + swallows) — a cache write must not
    // break a refresh. Writes are serialized: at most one in-flight (see §5.1 coalescing).
    public Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct);

    // Returns payload iff ALL hold: file exists; parses; version == schemaVersion;
    // owner-login equals identity.Login (OrdinalIgnoreCase); owner-host equals
    // identity.Host (OrdinalIgnoreCase); isStructurallyValid(payload) (default: non-null).
    // Otherwise null (→ cold start). Never throws: parse/IO errors are caught as a miss.
    public T? TryLoad(CacheIdentity identity);

    public Task EvictAsync(CancellationToken ct);   // best-effort delete; never throws
}

public readonly record struct CacheIdentity(string Login, string Host);
```

On-disk envelope (serialized with `JsonSerializerOptionsFactory.Storage` — kebab-case
property names, **no** dictionary-key policy so section ids / PrIds round-trip verbatim,
kebab `JsonStringEnumConverter` so `CiStatus`/`MergeReadiness`/`ActivitySource`/`ActivityVerb`
round-trip):

```jsonc
{ "version": 1, "owner-login": "octocat", "owner-host": "github.com", "payload": { /* T */ } }
```

Mechanics reused verbatim from the store pattern: temp file `"{path}.tmp-{guid:N}"` →
`File.WriteAllTextAsync` → `AtomicFileMove.MoveAsync` (the Windows AV/indexer-lock retry
helper). `TryLoad` reads with `FileShare.Read`.

**Disposability — corruption / version / structural safety (constraint #3).** `TryLoad`
returns `null` on: missing file, parse error, schema-version mismatch (older **or** future),
identity mismatch (login **or** host), **or `isStructurallyValid(payload)` returning false**.
The structural check is the guard against a *parses-into-garbage* payload — e.g. a future
contributor changes `InboxSnapshot`'s shape but forgets to bump `schemaVersion`, and an old
payload deserializes under STJ with a defaulted/null `Sections`. Without the check that
semantically-broken snapshot would rehydrate as `_current` and risk an NPE in the SSE/diff
path (§13 A3). The inbox validator requires non-null `Sections`/`Enrichments`; the activity
validator requires non-null `Items`. There is **no** quarantine-and-resave (unlike
`AppStateStore`) because losing a disposable cache costs nothing — the next refresh
overwrites.

**No `FileSystemWatcher`** — see §6 for the single-writer invariant this rests on.

**Why a shared helper (the one new abstraction).** Two consumers, each needing
{atomic-write, version stamp, login+host identity gate, corruption/structural→miss}, is
enough non-trivial duplication to extract once rather than copy-pasting the validation ladder
into two stores. **Both consumers are in scope** (the rail is owner-sanctioned, see scope
note). **Fallback if the gate splits the rail to a follow-up:** the inbox-only path collapses
the generic to a dedicated `InboxSnapshotStore` (mirroring `AppStateStore`, no generic
parameter); the abstraction is justified by two shipping consumers, not one (§13 scope).

### 3.2 Inbox integration — `InboxSnapshotCache` + `InboxCacheRehydrator`

- **Store wiring.** `services.AddSingleton(sp => new IdentityKeyedFileCache<InboxSnapshot>(
  Path.Combine(dataDir, "inbox-snapshot.json"), InboxCacheVersion, isStructurallyValid: …))`
  inside `AddPrismCore` (mirrors how every store closes over `dataDir`; there is no
  `IDataDir` abstraction). Injected into the orchestrator's factory and into the rehydrator.
- **Orchestrator dual-registration (§13 F2).** Today the orchestrator is registered **only**
  as `IInboxRefreshOrchestrator`. The rehydrator must call the new concrete `TryRehydrate`,
  so we dual-register the concrete type exactly like `InboxPoller`/`ActivePrPoller`
  (`ServiceCollectionExtensions.cs:129-135`): `AddSingleton<InboxRefreshOrchestrator>(…)` +
  `AddSingleton<IInboxRefreshOrchestrator>(sp => sp.GetRequiredService<InboxRefreshOrchestrator>())`,
  and inject the concrete type into `InboxCacheRehydrator`.
- **Write hook (§5.1).** In `RefreshAsync`, after the snapshot commits, **and** at the
  enrichment-ready mutation site, schedule a save outside `_writerLock`, fire-and-forget with
  latest-wins coalescing.
- **Rehydrate hook (§5.2).** A new `IHostedService` `InboxCacheRehydrator`, registered
  **after** `ViewerLoginHydrator` and **before** `InboxPoller`.

### 3.3 Activity integration — write-through + rehydrate inside `ActivityProvider`

The rail has no orchestrator/hosted-service split; `ActivityProvider` owns both its cache
and its identity-reset (`Reset()`). So both hooks live inside it. **`ActivityProvider` gains
an `IViewerLoginProvider` dependency** (it has none today) plus the config GitHub host, to
build its `CacheIdentity` — without this the identity gate is not symmetric with the inbox
path (§13 feasibility residual).

- **Store wiring.** `IdentityKeyedFileCache<ActivityResponse>` over
  `Path.Combine(dataDir, "activity-feed.json")`, injected into `ActivityProvider`.
- **Write hook.** After `_cache = new CacheEntry(response, …)` (`ActivityProvider.cs:117`),
  fire-and-forget `SaveAsync(response, identity, ct)` — **gated on the same generation check**
  the in-memory cache-set uses (`Volatile.Read(ref _generation) == gen`,
  `ActivityProvider.cs:116`), so a feed built under an about-to-rotate identity is not
  persisted (§13 feasibility residual).
- **Rehydrate hook.** On the **first** `GetActivityAsync` cache miss (process start), before
  the GitHub fan-out, attempt `TryLoad(identity)`. On a hit, seed `_cache` with the rehydrated
  response but **stamp `CacheEntry.At` already-expired** (e.g. `At = now - Ttl`), not `now`,
  and mark it stale. This is load-bearing (§13 F1): `GetActivityAsync` serves from `_cache`
  while `now - At < 60s TTL`, and the FE only re-polls every 90s, so seeding `At = now` would
  turn the next poll into a cache **hit** and defer the live fetch up to ~90s. An expired `At`
  makes the *next* `GetActivityAsync` a miss that fetches live, while *this* call still returns
  the stale rows immediately. (`CacheEntry.At` = freshness; `ActivityResponse.GeneratedAt` =
  display age — they are different fields.) A rehydrate-once guard ensures we only read disk on
  the genuine cold miss, not on every TTL expiry.
- **Identity reset.** `Reset()` (generation bump on token rotation, `ActivityProvider.cs:130`)
  also calls `cache.EvictAsync` so a rotated identity cannot rehydrate a prior feed.

## 4. Identity keying & security (issue constraint #2)

The cache key is **(viewer login, GitHub host)** — `IViewerLoginProvider.Get()`
(`PRism.Core/Auth/IViewerLoginProvider.cs`) plus the configured host (`config.Current.Github.Host`
/ the validated host from `ValidateCredentialsAsync`). The token store holds a single opaque
PAT keyed by `AccountKeys.Default` and does **not** know the username; identity (login) only
materializes after `ValidateCredentialsAsync`. So the key must be the post-validation
(login, host), never anything read straight from the token store.

**Host is part of the key (§13 SEC2).** PRism supports host reconfiguration (the
`host-change-resolution` path). If a user switches github.com → an enterprise GHES instance
and holds the **same username** on both, keying on login alone would rehydrate one host's PR
data into the other host's session. Requiring **both** `owner-login` and `owner-host` to match
(OrdinalIgnoreCase) closes this. Because `owner-host` is a new required envelope field, the
schema version starts at 1 and any host-less legacy file is a version/parse miss anyway.

**Confirm-before-rehydrate ordering (the load-bearing rule).** `ViewerLoginHydrator` is an
`IHostedService` whose `StartAsync` *awaits* `ValidateCredentialsAsync` and, on success, calls
`_loginCache.Set(login)`. Hosted-service `StartAsync` runs sequentially in registration order.
`InboxCacheRehydrator` is registered **after** it, so by the time the rehydrator runs the login
is already set (valid token) or still empty (no/invalid/revoked token). The rehydrator therefore:

- **identity present** → `TryLoad(identity)`; rehydrate iff login **and** host match.
- **login empty** (missing token, validation failed, **offline launch**, revoked token) →
  **skip** rehydration → today's empty-then-fetch.

We **never** rehydrate optimistically before identity is confirmed, so a restart under a
different or revoked token can never paint the previous user's inbox — satisfying "never
rehydrate the previous user's inbox" literally, not "show then evict." The activity rehydrate
path applies the same gate.

> **Open decision for the gate — OFFLINE LAUNCH (§13 A1).** The confirm-before-rehydrate rule
> means an **offline** launch (or GitHub outage / VPN-not-up / transient 401) skips rehydration
> and shows the empty first paint — i.e. the feature delivers *least* exactly when the network
> is down, which is when "we had a good list a moment ago" matters *most*. Two options:
> **(a) v1 = offline-shows-empty** [author's current lean]: strictly privacy-safe (we never show
> data we couldn't re-confirm the owner of), simplest. **(b) offline-rehydrate via a
> last-validated-identity stamp**: persist `(login, host)` separately, written **only** after a
> successful `ValidateCredentialsAsync`; on a launch where validation fails but a token is
> present and the cache's `(owner-login, owner-host)` equals the last-validated stamp, rehydrate
> (we trust the last-confirmed identity since we cannot re-confirm offline). Delivers the value
> when it matters most; the cost is that offline we cannot detect a *revoked* token, so we'd show
> the last-confirmed user's data offline (a weak threat: offline the app can do nothing online,
> and the data dir is OS-account-protected). **Recommendation: ship (a) for v1, keep (b) as
> deferral D2 with this mechanism spelled out.** Confirm at the gate.

**Threat model.** The "different user" risk is a shared data dir on one machine. The token in
the store determines identity; a swapped token validates to a different login → cache mismatch
→ discard. A revoked token fails validation → login empty → skip. Both covered by the
post-validation gate. The **viewer = token-owner** premise is sound (the GitHub `viewer` query
returns the token's own login; adversarial review confirmed this is not a spoofable mismatch).

**Runtime identity change.** `/api/auth/replace` publishes `IdentityChanged`
(`AuthEndpoints.cs:383`) and calls `inboxPoller.RequestImmediateRefresh()`. We subscribe to
`IdentityChanged` and **evict both cache files**. The write path stamps the **captured** identity
(§5.1), so even a coalesced write that flushes *after* an eviction writes a file correctly
attributed to the *old* identity — which the next different-identity launch rejects at the gate.
This is what makes the evict/write race benign (§13 SEC1).

**At-rest exposure (§13 security residual — framing corrected).** The cache files are plaintext
JSON in the data dir, joining the **same unprotected tier as `state.json` and `config.json`**
(not the keychain-protected PAT, which is MSAL/OS-keychain-backed). `state.json` already holds
sensitive PR draft content, so the *tier* is not new — but these files materially widen what
lives there to include PR titles, CI states, reviewer membership, and **AI enrichment summaries**
(which may summarize confidential PR discussions). This is acceptable given the single-writer,
OS-account-owned data dir, but is documented explicitly rather than inherited by analogy.

**#433 is unrelated.** #433 (cold-start stale *session cookie* → 401) is a `no-store` header
fix on the HTML cookie-stamping branch — a different surface from snapshot persistence.

## 5. Inbox data flow

### 5.1 Write path — write-on-meaningful-change, outside the lock, serialized + coalesced

`RefreshAsync` runs its whole body under `_writerLock`, which **already** spans network I/O —
the documented lock-contention lever (#663/#678 context). We must **not** add disk I/O under
that lock. So:

1. **Capture identity with the snapshot (§13 SEC1).** Under the lock, after the snapshot
   commits, capture `(snapshot, CacheIdentity(login, host))` **as a pair** — reading the login
   *now*, at capture time, not at flush time. This is the load-bearing fix for the
   identity-change-races-a-pending-write leak: if the login were re-read at flush time, a token
   swap between capture and flush could stamp the *old* snapshot under the *new* login, which the
   identity gate would then wrongly accept. Closing over the captured identity makes every file
   correctly attributed to the identity that owned the snapshot.
2. **Two write triggers (§13 A2 — the layout-shift fix).** Schedule a coalesced write when
   **either**: (a) `ComputeDiff(prior, next).Changed` is true (a core change), **or** (b) the
   enrichment-ready mutation lands (`OnInboxEnrichmentsReady`, `InboxRefreshOrchestrator.cs:727`,
   which patches `_current` with settled AI). `ComputeDiff` is **enrichment-blind**, so trigger
   (a) alone would persist a snapshot whose AI chips are still blank (AI settles seconds after
   the core refresh commits); on the next launch those blank chips would *pop in* on the first
   refresh — the exact layout shift §5.3 cites as the reason to persist AI at all. Trigger (b)
   flushes the settled-AI snapshot so the persisted copy carries real chips. (Writing on *every*
   tick is still avoided: an unchanged tick with no new enrichment writes nothing.)
3. **Serialized, latest-wins coalescing (§13 A6).** The cache writer keeps a single in-flight
   write; a newer `(snapshot, identity)` pair **replaces any queued-but-unstarted** write and
   starts **after** the in-flight one completes. This prevents an older slow write (mid
   `AtomicFileMove` retry) from landing *after* a newer one and leaving stale bytes. Combined with
   the captured-identity stamp (step 1), a post-eviction flush is correctly-attributed-stale and
   harmless.
4. The write is **fire-and-forget and best-effort** — `SaveAsync` never throws to the refresh
   path; a failed write logs and is dropped (`_current` is authoritative; the next changed tick
   retries).

### 5.2 Rehydrate path — set `_current`, complete the first-snapshot gate, force-notify the first revalidation

New concrete orchestrator method (interface unchanged; see §3.2 dual-registration):

```csharp
// Called once, by InboxCacheRehydrator, before the poller's first RefreshAsync.
// No-op if a snapshot already exists (a refresh beat us). Sets the rehydrated snapshot
// as _current, completes _firstSnapshotTcs so GET /api/inbox returns immediately, and
// arms a one-shot "force-notify the next refresh" flag so the stale label always clears.
public void TryRehydrate(InboxSnapshot snapshot);
```

It takes `_writerLock`, and **only if `_current is null`** does `Volatile.Write(ref _current,
snapshot)` + `_firstSnapshotTcs.TrySetResult()` + set a `_rehydratedAwaitingRevalidate` flag.
The null-guard makes it lose harmlessly to a refresh that already committed. After this,
`GET /api/inbox` returns the rehydrated snapshot (with `stale: true`, §9) without waiting on the
network.

**Force-notify the first post-rehydrate refresh (§13 feasibility residual — silent-stale-label
bug).** The poller's first `RefreshAsync` after a rehydrate may yield `diff.Changed == false`
(the rehydrated snapshot already equals live). Today the `InboxUpdated` publish is gated on
`diff.Changed` (`InboxRefreshOrchestrator.cs:346`), so a no-change first refresh fires **no**
SSE → the FE never refetches → the `stale` flag and "Updated 3h ago" label never clear (the user
is told "refreshing" forever). `RefreshAsync` already has a `forceNotify` parameter; when
`_rehydratedAwaitingRevalidate` is set, the first refresh runs with `forceNotify: true` and then
clears the flag — so an `InboxUpdated` always fires on the first revalidation, the FE refetches,
`stale` flips to false, and the label flips to "just now" even when nothing changed.

**`ComputeDiff` cold-start semantics shift (verify — §10).** With a non-null rehydrated
`_current`, the first refresh diffs against the rehydrated snapshot instead of `null`.
`ComputeDiff(null, next)` reports "everything new" (`InboxRefreshOrchestrator.cs:435`);
`ComputeDiff(rehydrated, next)` reports only the genuine delta. Desirable (no spurious
"everything new" every launch) but it changes the first post-launch `InboxUpdated` payload. §10
requires checking any FE consumer that keys behavior off the first `InboxUpdated` (e.g. an
unread / "N new" banner) before merge.

### 5.3 What is persisted (issue constraint #4 — decision: **everything, uniform staleness**)

The **entire `InboxSnapshot`** is persisted: `Sections` (all `PrInboxItem` fields), `Ci`
status, `Enrichments` (AI category chip + hover summary), `AiEnrichmentSettled`,
`CiProbeComplete`, `LastRefreshedAt`. Rationale: stale-while-revalidate's contract is "all of
this is last-known-good, not live"; once that holds, an AI chip is carried under the same
staleness affordance as the title or comment count. Selectively dropping AI would create a
half-stale view (stale CI glyph next to a blank chip that pops in on refresh — visible layout
shift) for no correctness gain — **provided the persisted snapshot actually carries settled AI**,
which §5.1 trigger (b) guarantees. The issue's "re-derive AI" lean was considered and rejected at
the gate (§12 decision 2).

> **Open decision for the gate — STALE AI JUDGMENTS UNDER A UNIFORM LIGHT LABEL (§13
> product-lens P2 / adversarial P3).** "Persist everything" + "no max-age cap" (§12 decision 5)
> + the light affordance (option A, §9) *compound* into a worst case the doc must own: a weeks-old
> AI category/risk summary ("safe to merge", "needs attention") can paint as confidently as a
> 3-minute-old one, under one fixed "Updated 3w ago" label, with no per-item "as of" marker. A
> stale *number* reads as obviously old; a stale natural-language AI *judgment* carries
> implied-current authority a user may act on (deprioritize / approve / skip) in the seconds before
> the live refresh re-enriches. **Mitigations in this design:** the view-level "Updated <age>"
> label marks *all* fields including AI as N-old; the forced first-revalidation (§5.2) re-enriches
> within seconds of launch; and the option-C escalation (§9) is now **tied to staleness magnitude**
> — if the real-token mockup shows the uniform label is too weak for the very-stale tail, escalate
> to a stronger signal *scaled by cache age* (e.g. a "Stale" pill when the cache is older than a
> threshold), not a blanket change. **Recommendation: keep persist-everything + uniform label;
> validate the very-stale tail specifically at mockup time.** Confirm at the gate.

**`PrInboxItem.Description` is `[JsonIgnore]`** (`PrInboxItem.cs:30`) and drops on write →
rehydrates `null`. **Harmless and intentional**: Description is PR-body text not shown in the
inbox row (hence `[JsonIgnore]`), so omitting it keeps the cache lean. Its only use is the #410
AI content-token guard (`InboxEnrichmentContent.Token(Title, Description)`); on the first
post-launch refresh the rehydrated `prior.Description == null` makes the token compare "changed"
→ re-enrich, which we do on refresh **anyway**. So it costs at most one already-expected
re-enrichment. (Do **not** add a separate storage DTO to carry Description — §12 decision 4.)

## 6. Correctness — single-writer & disposability

> **Invariant (conditional on the `Program.cs` bootstrap).** Each cache file has a single live
> writer **per data dir, given the `LockfileManager` lock acquired in `Program.cs`**, and the
> cache is **disposable** — any read failure degrades to today's cold start, never to a crash or
> to serving another identity's data.

- **Single writer — and its boundary (§13 A5).** `LockfileManager.Acquire(dataDir, …)`
  (`Program.cs:232`) holds `state.json.lock` for the process lifetime and refuses a second live
  backend per data dir. The orchestrator (singleton) is the sole writer of
  `inbox-snapshot.json`; `ActivityProvider` (singleton) is the sole writer of
  `activity-feed.json`. **This invariant is `Program.cs`-scoped, not intrinsic to the cache:**
  any host that composes the container without that bootstrap gets no cross-process guarantee.
  In practice (a) the desktop sidecar launches `PRism.Web` through the **same `Program.cs`** (so
  it is covered — to be re-verified during implementation), and (b) tests use **private per-test
  data dirs** (`PRismWebApplicationFactory`), so no two writers share a dir. The
  no-`FileSystemWatcher` decision rests on this; `AtomicFileMove` prevents *torn* files but not
  *lost updates*, so a shared-dir-without-lock launch path would be a correctness bug — flagged
  here so any future embedding re-checks it.
- **Disposable read.** `TryLoad` returns `null` on missing / parse error / version mismatch /
  identity (login or host) mismatch / structural-invalidity. No quarantine file, no resave.
- **Immutability.** `InboxSnapshot` and `ActivityResponse` are `sealed record`s over read-only
  collections; the rehydrated reference is shared read-only, like `ConfigStore.Current`.
- **No persisted-schema coupling.** These are *new, separate* files; they do not touch
  `state.json`, `config.json`, or the token cache, so existing migration/versioning is untouched.

## 7. Component & file inventory

| Change | File(s) | Note |
|--------|---------|------|
| **New** generic cache | `PRism.Core/Storage/IdentityKeyedFileCache.cs` (+ `CacheIdentity`) | §3.1 |
| **New** inbox rehydrator | `PRism.Core/Inbox/InboxCacheRehydrator.cs` (`IHostedService`) | §3.2 |
| **Edit** orchestrator | `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` | add `TryRehydrate` + force-notify flag (§5.2); capture-identity write hooks at the commit + enrichment-ready sites (§5.1) |
| **Edit** activity provider | `PRism.Core/Activity/ActivityProvider.cs` | inject `IViewerLoginProvider` + host; write-through (gen-gated) + rehydrate-with-expired-`At` + evict-on-`Reset` (§3.3) |
| **Edit** DI | `PRism.Core/.../ServiceCollectionExtensions.cs` | two cache singletons; dual-register orchestrator; hosted-service order `ViewerLoginHydrator → InboxCacheRehydrator → InboxPoller` |
| **Edit** wire DTOs | `PRism.Web/Endpoints/InboxDtos.cs`, the activity response | add `stale: bool` (§9) |
| **Edit** identity-change evict | `PRism.Web/Endpoints/AuthEndpoints.cs` (or an `IdentityChanged` subscriber) | evict both cache files (§4) |
| **Edit** FE types + inbox | `frontend/src/api/types.ts`, `pages/InboxPage.tsx`, `components/Inbox/*`, `hooks/useInbox*.ts` | `stale`-driven LoadingBar + "Updated <age>" label + aria + failure-while-stale (§9) |
| **Edit** FE rail | `frontend/src/components/ActivityRail/*`, `hooks/useActivity.ts` | `stale`-driven immediate refetch + header swap (§9) |

On-disk: `inbox-snapshot.json`, `activity-feed.json` in the data dir.

## 8. Relationship to #505 (progressive recency-staged loading)

#505 stages the *fetch* (24h → 7d → rest) to cut time-to-first-live-data; this caches the
*result* to remove the empty first paint entirely. They compose: on launch the rehydrated cache
paints last-known-good immediately (this issue), and #505's staged refresh then *layers over* the
cached data — each stage's `ComputeDiff` reconciles against the rehydrated `_current` rather than
racing it for first paint. No ordering conflict: the rehydrator runs before the poller; #505 only
changes what the poller fetches. Building #619 first gives #505 a non-empty base to stage onto.

## 9. Frontend affordance (issue constraint #1 — option A, with a backend `stale` flag)

The chosen affordance (option A) is **a refreshing signal + an "Updated <age>" label, no
whole-list dimming**. Whole-list dimming (B) was rejected (heavy every-launch signal, new pattern,
cold-start/background asymmetry); a "Stale" pill (C) is the escalation path, now tied to staleness
magnitude (§5.3).

**Why a backend `stale` flag is required (§13 D1 — the core affordance fix).** An earlier draft
claimed the existing `LoadingBar active={isLoading || isRefreshing}` would signal "refreshing".
It does **not**: `useInbox` calls `setIsLoading(false)` immediately on *any* successful GET
(including the rehydrated stale one), and `isRefreshing` is true only during a **manual** refresh.
So the bar would go inactive the instant stale data paints, leaving it sitting there with no
refreshing signal for the 5–30s backend revalidate — "never presented as live" unmet. The FE has
no way to know a background refresh is in flight without a backend signal. So:

- **Backend.** Add `stale: bool` to `InboxResponse` and `ActivityResponse`. It is **true** while
  the served data is the rehydrated, not-yet-revalidated cache, and **false** once the first live
  refresh since launch completes. Inbox: `_rehydratedAwaitingRevalidate` (set by `TryRehydrate`,
  cleared when the forced first revalidation commits, §5.2). Activity: set when the rehydrated feed
  is served, cleared when a live fetch replaces it.

**Inbox FE.**
- Cold-start branch: when `data` exists (rehydrated or live), **render content**, not the
  skeleton; skeleton only when there is genuinely no `data`.
- When `data.stale` is true: show the `LoadingBar` active, render an **"Updated <age>"** label in
  `InboxToolbar`/`FilterBar` from `data.lastRefreshedAt` + the existing `formatAge` util, and fire
  an **aria-live announcement** ("Showing saved inbox from <age> ago, refreshing…") **on stale
  onset** — the existing `role=status` regions only announce on refresh *completion*, so SR users
  currently get no signal that they've landed on stale content (§13 D2). When `stale` flips false
  (the forced first revalidation's `InboxUpdated` → refetch), the bar clears, the label flips to
  "Updated just now", and a completion announcement fires.
- **Age label ticker (§13 D4).** `formatAge` is computed at render time; without a periodic
  re-render "Updated just now" would freeze. Drive the label off a lightweight ~60s ticker so the
  age stays honest while idle (the whole point is honesty about staleness).
- **Failure-while-stale UX (§13 D5).** If the first revalidation persistently fails (offline /
  revoked mid-session), no `InboxUpdated` fires, `useInboxUpdates` swallows the error, and the
  blocking `ErrorModal` is skipped because `data` is non-null — so stale data would sit forever
  with a perpetual "refreshing" signal. Define a **non-blocking** failure state: after the first
  revalidation fails, keep the stale rows but replace the "refreshing" affordance with a
  "Couldn't refresh — showing saved data" indicator + a manual-retry path (Refresh button is the
  recovery). Do not fall back to the empty/skeleton or the blocking modal when stale data exists.

**Activity rail FE.**
- The rail paints its rehydrated rows immediately (its skeleton already clears when data is
  present, `useActivity.ts:45`).
- **Prompt revalidation (§13 F1 + D1).** `useActivity` polls every 90s, so without a nudge the
  live rail data wouldn't arrive for up to 90s after the stale paint. When the response has
  `stale: true`, `useActivity` schedules an **immediate** refetch (not the 90s tick); the backend's
  expired-`At` seed (§3.3) makes that refetch a live fetch. Show a rail refreshing indicator while
  `stale` is true.
- **The "last 24h" header is factually wrong on stale data (§13 D3).** `ActivityRail.tsx:199`
  hardcodes "last 24h", but rehydrated rows cover the *previous* session's 24h window and can read
  "3d ago" — contradicting "never presented as live". When the rail response is `stale`, **suppress
  or replace** the "last 24h" header (e.g. "saved · refreshing") until live data lands; restore it
  when `stale` flips false.

**Visual sign-off.** The exact treatment (label placement, copy, weight, the age-scaled
escalation threshold) is validated with a **real-token mockup in both themes** before the B1
visual-assert gate — prose here fixes the *approach* (A + the `stale` flag), not the pixels.

**Deferrals.**
- **D1 — FE pre-GET cache (sessionStorage).** Out of scope; only meaningful layered on the
  backend cache. File a follow-up if the post-backend first paint still shows a perceptible gap.
- **D2 — Offline rehydrate via last-validated-identity stamp.** Out of scope for v1 (§4 open
  decision); the mechanism is spelled out there for a future enhancement.

## 10. Cross-tier / consumer checks (must clear before PR)

- **First `InboxUpdated` payload (§5.2).** Grep FE consumers of the inbox SSE/`InboxUpdated` for
  behavior keyed off the *first* post-launch event or a "N new / everything-new" banner; confirm
  the shift from "everything new" to "real delta" doesn't regress it.
  (`check-frontend-consumers-on-wire-shape-change` discipline.)
- **`stale` flag consumers.** New wire field on both responses — update the FE TS types
  (`InboxResponse`, `ActivityResponse`) and any e2e route-mock / `as any` body in `frontend/e2e`
  that constructs these responses, so a strict locator / type check doesn't trip
  (`nonoptional-wire-field-escapes-e2e-route-mocks` discipline).
- **Serialization round-trip (§11).** STJ seam on both records: `IReadOnlyDictionary` /
  `IReadOnlyList` deserialize to concrete types; `AiEnrichmentSettled` read-only computed getter
  round-trips via its `init` normalizer; kebab enums round-trip.

## 11. Test plan (TDD — non-bug/feature: new tests authored test-first)

**`IdentityKeyedFileCache<T>` (new `tests/PRism.Core.Tests/Storage/IdentityKeyedFileCacheTests.cs`):**
1. Round-trip: `SaveAsync(payload, id)` then `TryLoad(id)` returns an equal payload — for both
   `InboxSnapshot` (populated `Sections`, `Enrichments`, **a non-empty `AiEnrichmentSettled` set**
   to exercise the computed-getter `init` normalizer end-to-end (§13 scope residual), kebab
   `CiStatus`/`MergeReadiness`) and `ActivityResponse` (kebab `ActivitySource`/`ActivityVerb`).
2. Login mismatch → miss; host mismatch → miss; both-match → hit (login OrdinalIgnoreCase).
3. Missing file → `null`.
4. Corrupt file (truncated / non-JSON) → `null`, no throw, file left as-is.
5. Wrong schema version (older and future) → `null`.
6. **Structurally-invalid payload** (parses, version+identity match, but `isStructurallyValid`
   returns false — e.g. null `Sections`) → `null` (§13 A3).
7. `SaveAsync` never throws under a simulated `AtomicFileMove` failure; caller sees no exception.
8. `EvictAsync` removes the file; subsequent `TryLoad` → `null`.

**Inbox integration (`tests/PRism.Core.Tests/Inbox/…`):**
9. `TryRehydrate` on a `null`-`_current` orchestrator sets `Current`, completes the first-snapshot
   gate (`WaitForFirstSnapshotAsync` returns without a refresh), and arms the force-notify flag.
10. `TryRehydrate` no-ops when `_current` is already set (a refresh won) — live data retained.
11. **Force-notify first revalidation (§13 feasibility residual):** after a rehydrate, a first
    `RefreshAsync` yielding `diff.Changed == false` still publishes `InboxUpdated` (force-notify),
    and the flag is cleared so subsequent no-change refreshes are silent.
12. **Write triggers (§13 A2 + A6):** a `Changed == true` refresh writes; a no-change tick with no
    new enrichment does **not** write; an **enrichment-ready** mutation with no core change **does**
    write (settled-AI flush). Assert via a recording cache; latest-wins coalescing collapses a burst
    to one write and never lands an older write after a newer one.
13. **Captured-identity stamp (§13 SEC1):** a snapshot captured under login A, then an identity
    change to B before the coalesced write flushes, persists a file stamped **A** (not B); a later
    `TryLoad(B)` misses.
14. The first `RefreshAsync` after a rehydrate diffs against the rehydrated snapshot (real delta),
    not "everything new" (§5.2 semantics shift).

**Rehydrator hosted service:**
15. Valid identity + matching-identity cache file → rehydrates; login empty (no token) → skips;
    mismatched login **or** host → skips.

**Activity integration:**
16. First `GetActivityAsync` cold miss with a present, matching-identity cache rehydrates `_cache`
    with an **expired `At`** and returns it without the GitHub fan-out (fake readers assert
    not-called on the rehydrate path); the **next** `GetActivityAsync` is a miss that fetches live
    (§13 F1).
17. The activity `SaveAsync` is generation-gated: a write scheduled under a since-rotated generation
    does not persist (§13 feasibility residual).
18. `Reset()` evicts the persisted feed (post-reset cold miss does not rehydrate the old feed).

**Frontend (`frontend` vitest):**
19. Inbox renders content + active `LoadingBar` + "Updated <age>" label when `data.stale` is true;
    renders skeleton only when `!data`; clears bar/label when `stale` flips false.
20. Stale-onset aria announcement fires when `stale` is first true (§13 D2).
21. Failure-while-stale: a failed first revalidation shows the non-blocking "couldn't refresh"
    indicator, retains stale rows, does not show the skeleton/ErrorModal (§13 D5).
22. Activity rail: `stale` response triggers an immediate refetch and swaps the "last 24h" header
    for the stale treatment; restores it when `stale` flips false (§13 D3 + F1).
    *(Run the **full** FE suite after the `aria`/skeleton-branch change — skeleton/`aria`
    regressions have bitten before.)*

**E2E (Playwright, prod project):**
23. Cold start with a seeded `inbox-snapshot.json` + `activity-feed.json` (matching identity): the
    inbox paints PR rows and the rail paints activity rows with **no** skeleton, the refreshing
    signal shows, then live data reconciles and the signal clears. Seed via the data-dir fixture
    (not a route mock) so the rehydrate path is exercised end to end.

Plus: full existing inbox / activity / submit / FE suites stay green.

## 12. Decisions (resolved) — confirm at the gate

1. **Shared `IdentityKeyedFileCache<T>` vs two standalone stores.** **Resolved: shared helper**
   (two owner-sanctioned consumers). Fallback if the gate splits the rail out: dedicated
   `InboxSnapshotStore` (§3.1).
2. **Persist everything vs re-derive AI (constraint #4).** **Resolved: persist everything, uniform
   staleness** — contingent on §5.1 trigger (b) flushing settled AI so the layout-shift rationale
   actually holds. See the §5.3 open decision for the stale-AI-judgment caveat to reaffirm.
3. **Write triggers.** **Resolved:** write on core `diff.Changed` **or** enrichment-ready; serialized
   latest-wins coalescing. (Round-1 review corrected the earlier "diff.Changed only", which would
   persist blank AI chips.)
4. **Don't persist `Description`.** **Accepted.** `[JsonIgnore]` stands; rehydrated `null` costs at
   most one already-expected re-enrichment.
5. **No hard max-age cap on rehydration.** **Accepted** (re-confirmed with the issue author): an
   honest "Updated 3w ago" beats an empty inbox. **Residual (documented, §13 security):** an aged
   cache may show PR rows for repos the user has since lost access to — visible under the staleness
   label until the first live refresh drops them; a data-residency note for regulated environments,
   not an access-control gap (the user once had access).
6. **Affordance = refreshing signal (backend `stale` flag) + "Updated <age>" label, no dimming
   (option A).** **Resolved** (§9). Round-1 review added the `stale` flag (the existing `LoadingBar`
   wiring could not signal the refreshing window) and the option-C escalation is age-scaled.
7. **Identity key = (login, host).** **Resolved** (§13 SEC2): host added to the envelope + gate.
8. **Offline launch.** **Open — gate decision** (§4): recommend v1 = offline-shows-empty; D2 keeps
   the last-validated-stamp escape hatch.

## 13. ce-doc-review dispositions — round 1 (7 personas)

Adjudicated with `receiving-code-review` rigor (verified each against the code; not accepted
blindly). Disposition = Applied (doc revised) / Surfaced (gate decision) / Accepted-residual /
Skipped.

| # | Reviewer | Finding | Sev/Conf | Disposition |
|---|----------|---------|----------|-------------|
| SEC1 | security | Login read at flush time miskeys old snapshot under new identity | P1/75 | **Applied** — capture `(snapshot, identity)` at capture time (§5.1.1); makes the evict/write race benign. |
| D1 | design | `LoadingBar` inactive during the stale→live window (no refreshing signal) | P1/100 | **Applied** — backend `stale` flag on both responses drives the bar/label/aria (§9); relaxed the "no new wire fields" non-goal. |
| A2 | adversarial | persist-AI vs write-on-change contradiction → blank chips pop in | P2/75 | **Applied** — added enrichment-ready write trigger (§5.1.2); §5.3 rationale now holds. |
| F1 | feasibility | Activity rehydrate seeding `At=now` suppresses revalidation ~90s | P2/75 | **Applied** — seed expired `At` (§3.3). |
| F2 | feasibility | `TryRehydrate` unreachable without dual-registration | P2/75 | **Applied** — dual-register the concrete orchestrator (§3.2); §2 notes the concrete surface grows. |
| SEC2 | security | GitHub host absent from identity key → cross-host rehydration | P2/75 | **Applied** — `owner-host` in envelope + gate (§4). |
| D2 | design | Stale-onset lacks aria announcement | P2/75 | **Applied** — announce on stale onset (§9). |
| D3 | design | Rail "last 24h" header factually wrong on stale data | P2/75 | **Applied** — suppress/replace header when `stale` (§9). |
| PROD1 | product | Stale AI judgments shown at full confidence under light label + no cap | P2/75 | **Surfaced** (§5.3 open decision) + **Applied** (age-scaled escalation, forced re-enrich). Decision unchanged; doc now owns the compounded case. |
| A1 | adversarial | Offline launch defeats the core goal | P2/75 | **Surfaced** (§4 open decision) + **Applied** (honest tradeoff stated; D2 mechanism spelled out). Recommend v1 offline-empty. |
| F-res1 | feasibility | No-change first refresh leaves stale label, no SSE | (residual) | **Applied** — force-notify the first post-rehydrate revalidation (§5.2). |
| F-res2 | feasibility | Activity `SaveAsync` not generation-gated | (residual) | **Applied** — gate the save on the generation check (§3.3). |
| F-res3 | feasibility/adv | `ActivityProvider` has no `IViewerLoginProvider` | (residual) | **Applied** — inject it (§3.3). |
| A3 | adversarial | Parses-into-garbage on unbumped version | P3/50 | **Applied** — `isStructurallyValid` guard in `TryLoad` (§3.1). |
| A5 | adversarial | Sole-writer invariant is `Program.cs`-scoped, stated as intrinsic | P3/50 | **Applied** — §6 restated as conditional; sidecar + test-dir notes. |
| A6 | adversarial | Coalescing writer ignores in-flight out-of-order completion | P3/50 | **Applied** — serialize writes, one in-flight (§5.1.3). |
| D4 | design | Age label freezes without a ticker | P3/50 | **Applied** — ~60s ticker (§9). |
| D5 | design | No UX when background refresh persistently fails | P3/50 | **Applied** — non-blocking failure-while-stale state (§9). |
| A4 | adversarial | Single label under-signals stale AI | P3/50 | **Merged into PROD1** (same theme; §5.3). |
| COH1 | coherence | Constraint #3 unlabeled | P3/50 | **Applied** — §3.1/§6 now labeled constraint #3. |
| SCOPE1 | scope | Abstraction premise depends on both consumers shipping | P2/75 | **Applied** — recorded rail is owner-sanctioned + stated the dedicated-store fallback (§3.1). |
| SCOPE2/PROD2 | scope/product | Rail extends beyond issue scope | P3/50 | **Applied** — scope note in header + §3.3 records the explicit owner request. |
| SEC-res | security | "no new at-rest exposure" framing conflates protected/unprotected tiers | (residual) | **Applied** — §4 framing corrected (compared to `state.json` plaintext tier; AI summaries noted). |
| SEC-res2 | security | Aged cache shows PRs for repos user lost access to | (residual) | **Accepted-residual** — documented under §12 decision 5. |
| SCOPE-res | scope | `AiEnrichmentSettled` round-trip test must use a non-empty set | (residual) | **Applied** — test 1 strengthened (§11). |
| F-res / SCOPE-res | both | ComputeDiff first-`InboxUpdated` consumer check | (residual) | **Already present** (§10) — retained and strengthened. |

_Round-2 `ce-doc-review` runs on request (the round-1 revisions are substantial; per the repo's
one-pass rule a second pass is not run silently)._
