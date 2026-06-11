# #319 — Shared Endpoints Seam (submit/comment/draft family)

**Issue:** #319 (part of the 2026-06 code-quality review epic #317)
**Tier:** T3 (cross-cutting; mechanical but wide)
**Risk:** gated B2 — touches submit-pipeline endpoint files and persisted-session upsert plumbing
**Worktree:** `D:\src\PRism-319`, branch `feature/319-endpoints-shared-seam`
**Date:** 2026-06-11

---

## 1. Problem

The `PRism.Web/Endpoints/` submit/comment/draft family grew by copy-paste. Error
mapping, the subscribed-guard, JSON-body parsing, session upsert, path/SHA
validation, tab-stamp writes, and body-size caps each exist in 3–7 copies, **with
measurable drift in several groups**. The drift is not cosmetic:

- One JSON-parse site (`PreferencesEndpoints.cs:19`) forgot the `catch (JsonException)`
  every sibling has, so a malformed body 500s today instead of returning a structured 400.
- The subscribed-guard returns **401 in six handlers and 404 in one** for the same
  condition. The 401 is globally loaded: `frontend/src/api/client.ts:75-77` dispatches
  `prism-auth-rejected` on **any** 401, which flips `authInvalidated` and redirects to
  `/setup` (the #312 re-auth surface). A not-subscribed 401 therefore *latently masquerades
  as token-death* — semantically wrong, even if near-unreachable in normal flow.
- Two path validators disagree on char-count vs UTF-8 byte-count caps; two SHA regexes
  disagree on case (a `GET /diff?range=` accepts an uppercase SHA that `POST /reload` 422s).

A small `Endpoints/Shared/` seam removes ~200 duplicated lines and most of the drift risk.

## 2. Goals / Non-Goals

**Goals**

- One definition each for: GitHub error mapping, subscribed-guard, JSON-body read,
  session upsert, path validation, SHA regex, tab-stamp write, body cap.
- Eliminate the three concrete behavior bugs the drift created (preferences 500,
  not-subscribed re-auth trip, SHA case mismatch).
- Unify status codes for the three drifted conditions (no-session, not-subscribed,
  discard-success).

**Non-Goals**

- **Error-envelope convergence.** Five envelope conventions coexist (ProblemDetails,
  `{error}`, `SubmitErrorDto`, `{ok,error}`, plain text). This spec unifies **mechanics
  and status codes only**, never the envelope bodies — that is where the per-endpoint
  frontend `.code`/`.kind` parsers live, and it is tracked separately in #198. Each call
  site keeps its current error body.
- UI-side error-surface changes.
- Any change to `SubmitPipeline`'s submit transport or atomic-submit semantics.

## 3. Guiding constraint: unify mechanics + status, not envelopes

The frontend parsers branch on the error **`.code` string** (submit/comment/root-comment),
a discriminated **`.kind`** union (`sendPatch`/reload), or nothing (discard, preferences).
None branch on the numeric status of the changing conditions — **except** the global
`401 → prism-auth-rejected` interceptor, which is the one wire fact that drives the
not-subscribed decision. Therefore:

- Duplicated **mechanics** (parse + catch + root-kind check, the error switch, the
  dict-upsert, the stamp+evict loop) are extracted to one definition.
- Drifted **status numbers** are aligned to one value per condition.
- **Envelope bodies stay per-site.** Where a shared helper would otherwise force a single
  body, the helper returns a *result the caller maps to its own DTO* (see seam #3).

## 4. Architecture

New folder `PRism.Web/Endpoints/Shared/` (namespace `PRism.Web.Endpoints`, matching every
existing endpoint file). All seams are **static helpers / extension methods** — no DI, no
`IEndpointFilter`. Rationale: the codebase has **zero** `IEndpointFilter` usage, and
`Program.cs:232-238` documents *why* (filters run after parameter binding, by which point
`IHttpMaxRequestBodySizeFeature` is read-only). Static helpers also match the existing
pattern — each endpoint class already holds private `static` helpers.

One change lands in Core: `AppState.WithSession(key, session)` as an instance method beside
`WithDefaultReviews` in `PRism.Core/State/AppState.cs`.

## 5. The eight seams

### Seam 1 — `GitHubErrorMapper`

`PRism.Web/Endpoints/Shared/GitHubErrorMapper.cs`

```csharp
internal static class GitHubErrorMapper
{
    // Pure: map a GitHub transport exception to the sanitized client DTO.
    internal static SubmitErrorDto Map(Exception ex)
    {
        var (code, message) = (ex as HttpRequestException)?.StatusCode switch
        {
            HttpStatusCode.Forbidden          => ("github-forbidden", "GitHub rejected the request (forbidden). Check your token's permissions."),
            HttpStatusCode.Unauthorized       => ("github-unauthorized", "GitHub authentication failed. Reconnect your account."),
            HttpStatusCode.UnprocessableEntity => ("github-validation-error", "GitHub rejected the request as invalid."),
            _                                  => ("github-network-error", "Couldn't reach GitHub. Try again."),
        };
        return new SubmitErrorDto(code, message);
    }

    internal static IResult ToResult(Exception ex) =>
        Results.Json(Map(ex), statusCode: StatusCodes.Status502BadGateway);
}
```

**Replaces:** the triplicated `switch` in `PrSubmitEndpoints.cs:626-639`,
`PrRootCommentEndpoints.cs:209-223`, `PrCommentEndpoints.cs:126-137`. Accepts `Exception`
(superset of the three signatures) and casts internally — this matches `PrCommentEndpoints`'
existing generic-`Exception` shape and is a no-op for the `HttpRequestException` callers.

**Stays per-site:** the surrounding `catch` blocks and their **logging**. Each class logs via
its own `LoggerMessage`-generated delegate (`s_ownDiscardGitHubFailed`, `s_rootCommentFailed`,
`s_commentPostFailed`), and `PrSubmitEndpoints`' discard path has a `404 → already-gone`
special case before mapping. Extracting only the pure map keeps logging and control flow
intact while deleting the duplicated switch. Catch sites change from `MapGithubError(hre)` /
inline-switch to `GitHubErrorMapper.ToResult(ex)`.

### Seam 2 — `RequireSubscribed`

`PRism.Web/Endpoints/Shared/RequireSubscribed.cs`

```csharp
internal static class RequireSubscribed
{
    // null  => subscribed, proceed.
    // non-null => 403 result the caller returns immediately.
    internal static IResult? Check(IActivePrCache cache, PrRef prRef) =>
        cache.IsSubscribed(prRef)
            ? null
            : Results.Json(new SubmitErrorDto("not-subscribed",
                "Subscribe to this PR before making changes."),
                statusCode: StatusCodes.Status403Forbidden);
}
```

**Replaces:** the 401 guards at `PrSubmitEndpoints.cs:109,308,418,523`,
`PrRootCommentEndpoints.cs:61`, `PrCommentEndpoints.cs:43`,
`PrDraftsDiscardAllEndpoint.cs:46`, and the divergent 404 `PatchOutcome.NotSubscribed`
mapping at `PrDraftEndpoints.cs:187`.

**Status decision: 403.** Authenticated-but-not-permitted is precisely 403. It is *not* 401
(which trips the global re-auth redirect — wrong for not-subscribed) and not 404 (which
implies the resource is absent). Call-site usage: `if (RequireSubscribed.Check(cache, prRef)
is { } r) return r;`.

**Body decision:** `SubmitErrorDto("not-subscribed", …)`. Six sites currently emit code
`"unauthorized"` with per-verb messages ("before submitting/discarding/posting"); one emits
`{error:"not-subscribed"}`. The unified body drops the per-verb nicety for one definition.
**Pre-finalization check (plan task):** grep the frontend for any branch on
`.code === "unauthorized"` or `"not-subscribed"`; the audit found the submit/comment parsers
read `.code` only to surface a message (no equality branch) and the draft path branches on
`.kind`, so this is expected SAFE — but it is verified, not assumed, before the seam lands.

### Seam 3 — `HttpJson.TryReadJsonObjectAsync`

`PRism.Web/Endpoints/Shared/HttpJson.cs`

```csharp
internal enum JsonReadError { None, InvalidJson, NotObject }

internal readonly record struct JsonObjectReadResult(JsonDocument? Document, JsonReadError Error);

internal static class HttpJson
{
    // Reads the request body as a JSON object. On success Document is non-null and the
    // caller owns its disposal. On failure Document is null and Error says why; the caller
    // maps Error to its OWN error DTO so existing envelopes are preserved.
    internal static async Task<JsonObjectReadResult> TryReadJsonObjectAsync(HttpContext ctx, CancellationToken ct)
    {
        JsonDocument doc;
        try
        {
            doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return new JsonObjectReadResult(null, JsonReadError.InvalidJson);
        }
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            doc.Dispose();
            return new JsonObjectReadResult(null, JsonReadError.NotObject);
        }
        return new JsonObjectReadResult(doc, JsonReadError.None);
    }
}
```

**Replaces the duplicated mechanics** (parse + `catch (JsonException)` + root-kind guard) at
`AuthEndpoints.cs:43-52,179-193`, `PrDraftEndpoints.cs:83-96`, and adds the missing catch to
`PreferencesEndpoints.cs:19`. **Each caller maps `Error` to its own DTO** so bodies are
preserved:

- `AuthEndpoints` (connect): `InvalidJson → BadRequest(new AuthConnectError(false, "invalid-json"))`.
- `AuthEndpoints` (host-change): `InvalidJson → BadRequest(new HostChangeError("invalid-json"))`.
- `PrDraftEndpoints`: `InvalidJson | NotObject → BadRequest(new { error = "patch-body-missing" })`
  (it currently collapses both to that body — preserved).
- `PreferencesEndpoints`: `InvalidJson → BadRequest(new PreferencesError("invalid-json"))`
  (**new** — this is the bug fix, AC §9); `NotObject → BadRequest(new PreferencesError(
  "body must be a JSON object"))` (its existing body, now routed through the helper).

This satisfies "one definition of JSON-body read" (the mechanics) without forcing envelope
unification.

### Seam 4 — `AppState.WithSession`

`PRism.Core/State/AppState.cs` (instance method, beside `WithDefaultReviews`)

```csharp
public AppState WithSession(string sessionKey, ReviewSessionState session)
{
    var sessions = new Dictionary<string, ReviewSessionState>(Reviews.Sessions) { [sessionKey] = session };
    return WithDefaultReviews(Reviews with { Sessions = sessions });
}
```

**Replaces:** the identical private `WithSession` helpers at `PrSubmitEndpoints.cs:610-614`,
`PrRootCommentEndpoints.cs:198-202`, `PrCommentEndpoints.cs:176-180`, and the inline upserts
at `PrDraftEndpoints.cs:158-162` and `PrReloadEndpoints.cs:185-189`.

**SubmitPipeline:** `SubmitPipeline.cs` carries its own field-overlay upsert pattern. The plan
verifies whether its dict-upsert is byte-equivalent; if it is, it folds in, if it diverges
(field-level overlay rather than whole-session replace), it is left untouched and noted. Not
load-bearing for the seam — the five endpoint copies are the guaranteed win.

### Seam 5 — `PathValidation`

`PRism.Web/Endpoints/Shared/PathValidation.cs`

Adopts `PrDetailEndpoints.CanonicalizePath` (`:273-304`) as the single definition:
**UTF-8 byte-count** cap, **segment-split** `..`/`.` rejection (not substring matching), C0/C1
control-char rejection, backslash rejection, and the **NFC byte-length-mismatch** guard
(defends against decomposed-Unicode allowlist bypass). Returns the NFC-normalized canonical
string, or `null` if invalid.

```csharp
internal static class PathValidation
{
    internal static string? Canonicalize(string path) { /* PrDetail's 7-rule body, verbatim */ }
}
```

**Replaces** `PrDraftEndpoints.IsCanonicalFilePath` (`:558-570`), which used char-count,
substring `"/../"` matching, and a different NFC rule. `PrDraftEndpoints` treats `null` as
invalid (mapping to its existing error body). **Behavior change (AC §9):** draft-side path
validation moves char-count → byte-count + segment-split. Regression test exercises a
multi-byte path. The `Encoding.UTF8.GetByteCount(body.Path) > 4096` length cap at the
`/viewed` call site (`PrDetailEndpoints.cs:199-200`) stays at the call site; the draft side
adopts the same byte-count length rule.

### Seam 6 — `SharedRegexes`

`PRism.Web/Endpoints/Shared/SharedRegexes.cs`

```csharp
internal static partial class SharedRegexes
{
    [GeneratedRegex("^[0-9a-fA-F]{40}$")] internal static partial Regex Sha40();
    [GeneratedRegex("^[0-9a-fA-F]{64}$")] internal static partial Regex Sha64();
}
```

**Replaces** the lowercase-only `new Regex("^[0-9a-f]{40}$", Compiled)` pairs at
`PrDraftEndpoints.cs:15-16` and `PrReloadEndpoints.cs:15-16`; `PrDetailEndpoints.cs:260-264`
already uses the case-insensitive `[GeneratedRegex]` form and switches to the shared one.

**Behavior change:** `POST /reload` and the draft side now **accept an uppercase SHA** they
previously 422'd. This is a *loosening* — every currently-valid (lowercase) input still
passes, and the frontend only ever sends the lowercase head SHA it received from the API, so
nothing that worked stops working. Case rule standardized on case-insensitive (the existing
`PrDetailEndpoints` rule), per AC §9.

### Seam 7 — `TabStamps`

`PRism.Web/Endpoints/Shared/TabStamps.cs`

```csharp
internal static class TabStamps
{
    internal const string TabIdHeader = "X-PRism-Tab-Id";
    internal const int MaxTabStamps = 8;

    // Writes/updates the stamp for tabId, then evicts the oldest while over the cap.
    internal static Dictionary<string, TabStamp> Write(
        IReadOnlyDictionary<string, TabStamp> existing, string tabId, string headSha, DateTime nowUtc)
    {
        var stamps = existing.ToDictionary(kv => kv.Key, kv => kv.Value);
        stamps[tabId] = new TabStamp(headSha, nowUtc);
        while (stamps.Count > MaxTabStamps)
        {
            var oldest = stamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
            stamps.Remove(oldest);
        }
        return stamps;
    }
}
```

**Replaces** the stamp+evict-over-8 blocks at `PrDetailEndpoints.cs:151-157`,
`PrReloadEndpoints.cs:169-175`, `TestHooks/TestEndpoints.cs:272-279` (killing the test-hook
drift), the bare literal `8` ×3, and the `"X-PRism-Tab-Id"` literal at
`PrSubmitEndpoints.cs:120`, `PrDetailEndpoints.cs:130`, `PrDraftEndpoints.cs:81`,
`PrReloadEndpoints.cs:63`. `nowUtc` is passed in (callers pass `DateTime.UtcNow`) to keep the
helper pure and testable. The `if (count > 8)` becomes `while (count > MaxTabStamps)` —
behavior-identical for the single-insert call pattern (count can exceed the cap by at most one).

### Seam 8 — `WithBodyCap()` (conditional)

`PRism.Web/Endpoints/Shared/EndpointExtensions.cs`

```csharp
internal const int MutatingBodyCapBytes = 16 * 1024; // 16 KiB — spec value, single source

internal static RouteHandlerBuilder WithBodyCap(this RouteHandlerBuilder builder) =>
    builder.WithMetadata(new RequestSizeLimitAttribute(MutatingBodyCapBytes));
```

**Replaces** the `Program.cs:251-295` `UseWhen` predicate that enumerates endpoint path
suffixes (every new mutating endpoint must remember to join the list). Each mutating endpoint
gains `.WithBodyCap()`; `PrDetailEndpoints.cs:185,251` already proves the metadata mechanism
works in production. The `16 * 1024` / `16384` literals collapse to one constant.

**Conditional on the 413 test (AC §9, Risk §7).** `Program.cs:232-238` chose middleware over
filters deliberately: filters run after binding, by which point `MaxRequestBodySize` is
read-only, and the `UseWhen` branch also short-circuits with **413** on `ContentLength > Cap`
before the read. The migration must preserve the **413** contract. `RequestSizeLimitAttribute`
as routing metadata is honored by the framework before body read (PrDetail relies on it), so
this is expected to hold — but it is **gated behind an explicit "oversized body → 413" test**.
If 413 cannot be preserved via metadata for an endpoint, **that endpoint stays on the
predicate** and the predicate shrinks to the unmigrated set rather than disappearing. The seam
is not allowed to silently downgrade 413 → 500.

## 6. Status-code unification (the three drifted conditions)

| Condition | Before | After | Frontend |
|-----------|--------|-------|----------|
| not-subscribed | 401 ×6 (`SubmitErrorDto unauthorized`) / 404 ×1 (`{error:not-subscribed}`) | **403** `SubmitErrorDto("not-subscribed", …)` | branches on `.code`/`.kind`, not status; **removes** the wrong 401→`/setup` redirect |
| no-session | 400 `no-session` (submit) / 404 `session-not-found` (reload) | **404** each keeps its own body | submit parser reads `.code`; reload branches 409 only — both SAFE |
| discard-success | 200 empty (foreign) / 204 (own) | **204** | client treats 200/204 identically (`client.ts:87`) |

Envelopes are **not** unified — only the status number. `no-session` keeps `submit`'s
`SubmitErrorDto("no-session", …)` body and `reload`'s `{error:"session-not-found"}` body;
only `submit`'s status moves 400 → 404.

## 7. Risks

| Risk | Mitigation |
|------|-----------|
| **Body-cap 413 contract** (seam #8) | Explicit oversized→413 regression test; endpoint falls back to the predicate if metadata can't preserve 413. Highest-risk seam. |
| not-subscribed body change breaks an FE `.code` branch | Plan task greps the frontend for `.code === "unauthorized"`/`"not-subscribed"` before the seam lands; audit says SAFE (no equality branch) but verified not assumed. |
| SubmitPipeline upsert diverges from `WithSession` | Verified in plan; left untouched if not byte-equivalent. |
| GraphQL/transport untouched | Seam #1 extracts only the error switch; no submit-transport change (keeps #320's byte-identity intact). |
| Path byte-count change rejects a previously-valid draft path | Only multi-byte paths near the 4096 boundary differ; regression test covers multi-byte; normal ASCII paths identical. |

## 8. Testing

- **Red-on-main regression** (AC §9): `POST /api/preferences` with a malformed body returns
  **400 `invalid-json`** (fails on `main` today — 500).
- not-subscribed → **403** for submit, comment, root-comment, drafts/discard-all, and the
  draft `markAllRead` path.
- no-session (submit) → **404**; discard (foreign) → **204**.
- Draft path validation with a **multi-byte** input (byte-count semantics).
- SHA: `POST /reload` accepts an **uppercase** 40-hex SHA.
- Seam #8: **oversized body → 413** for a migrated mutating endpoint.
- Behavior-preserving seams (1,3,4,5,7): existing `PRism.Web` / `PRism.Core` / `PRism.GitHub`
  suites stay green.
- Frontend: untouched by design (envelopes preserved); the not-subscribed `.code` grep is a
  verification step, not a code change.

## 9. Acceptance criteria

- [ ] One definition each for: GitHub error mapping, subscribed-guard, JSON-body read,
      session upsert, path validation, SHA regex, tab-stamp write, body cap.
- [ ] `POST /api/preferences` returns 400 `invalid-json` on malformed body (regression test
      red-on-main).
- [ ] Draft-side path validation uses byte-count semantics (test with multi-byte input).
- [ ] One status code per semantic condition: not-subscribed → 403, no-session → 404,
      discard-success → 204.
- [ ] `Program.cs` suffix-list predicate removed in favor of endpoint metadata (or shrunk to
      the unmigrated set if any endpoint can't preserve 413).
- [ ] SHA regex case rule unified (case-insensitive, `[GeneratedRegex]`).
- [ ] Tab-stamp write + `X-PRism-Tab-Id` header + cap (8) each defined once, including the
      test hook.
- [ ] Full `dotnet test` green; no frontend `.code`/`.kind` parser regression.

## 10. Out of scope / follow-ups

- Error-envelope convergence → #198.
- `SubmitPipeline` upsert fold-in is opportunistic (only if byte-equivalent).
- The per-verb not-subscribed messages ("before submitting/discarding") collapse to one
  generic message; if a per-verb message proves worth keeping, it is a trivial follow-up.

## 11. Doc-review dispositions

_(Filled after `ce-doc-review`.)_
