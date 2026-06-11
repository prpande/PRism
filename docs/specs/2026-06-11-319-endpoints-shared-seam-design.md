# #319 — Shared Endpoints Seam (submit/comment/draft family)

**Issue:** #319 (part of the 2026-06 code-quality review epic #317)
**Tier:** T3 (cross-cutting; mechanical but wide)
**Risk:** gated B2 — touches submit-pipeline endpoint files and persisted-session upsert plumbing
**Worktree:** `D:\src\PRism-319`, branch `feature/319-endpoints-shared-seam`
**Date:** 2026-06-11

> **Revision note (post ce-doc-review).** The first draft assumed the not-subscribed
> status change was frontend-invisible. A reviewer panel found that false: the submit
> parser equality-branches on the error **code** string (`PrHeader.tsx` `case 'unauthorized'`),
> and the draft path derives its `.kind` discriminator **from the status number**
> (404 → `draft-not-found`). This revision changes only the **status number** (401 → 403)
> while keeping the body **code `"unauthorized"`**, and **excludes** the draft `markAllRead`
> path from the 403 unification (it stays 404). See §3, Seam 2, §6, §11.

---

## 1. Problem

The `PRism.Web/Endpoints/` submit/comment/draft family grew by copy-paste. Error
mapping, the subscribed-guard, JSON-body parsing, session upsert, path/SHA validation,
tab-stamp writes, and body-size caps each exist in 3–7 copies, **with measurable drift in
several groups**. The drift is not cosmetic:

- One JSON-parse site (`PreferencesEndpoints.cs:19`) forgot the `catch (JsonException)`
  every sibling has, so a malformed body 500s today instead of returning a structured 400.
- The subscribed-guard returns **401 in six handlers and 404 in one** for the same
  condition. The 401 is globally loaded: `frontend/src/api/client.ts:75-77` dispatches
  `prism-auth-rejected` on **any** 401, which flips `authInvalidated` and redirects to
  `/setup` (the #312 re-auth surface). A not-subscribed 401 therefore *latently masquerades
  as token-death* — semantically wrong.
- Two path validators disagree on char-count vs UTF-8 byte-count caps; two SHA regexes
  disagree on case (a `GET /diff?range=` accepts an uppercase SHA that `POST /reload` 422s).

A small `Endpoints/Shared/` seam removes ~200 duplicated lines and most of the drift risk.

## 2. Goals / Non-Goals

**Goals**

- One definition each for: GitHub error mapping, subscribed-guard, session upsert, path
  validation, SHA regex, tab-stamp write, and the JSON-body read for the `pr/*` +
  `preferences` family.
- Eliminate the concrete behavior bugs the drift created (preferences 500, not-subscribed
  re-auth trip, SHA case mismatch).
- Unify status codes for the drifted conditions (not-subscribed, no-session, discard-success)
  **by status number only**.

**Non-Goals**

- **Error-envelope and error-code convergence.** Five envelope conventions coexist
  (ProblemDetails, `{error}`, `SubmitErrorDto`, `{ok,error}`, plain text). This spec changes
  **status numbers only** and keeps every existing error **code string** and body shape —
  that is where the per-endpoint frontend `.code`/`.kind` parsers live. Envelope convergence
  is tracked separately in #198. **The one carve-out** that the status change touches a body:
  none — see Seam 2 (code `"unauthorized"` is preserved; the draft `markAllRead`
  `{error:"not-subscribed"}` body and its 404 status both stay).
- **AuthEndpoints JSON-read dedup.** `AuthEndpoints` already has the `catch (JsonException)`
  + non-object-root guard on every parse site (no bug), with bespoke auth error DTOs.
  Routing auth-token-handling code through a new shared helper for zero bug-fix is incidental
  risk on a sensitive surface; deferred to a follow-up (§10).
- UI-side error-surface changes.
- Any change to `SubmitPipeline`'s submit transport or atomic-submit semantics.

## 3. Guiding constraint: change status numbers only; never codes, bodies, or kinds

The frontend parsers branch on the error **`.code` string** (submit/comment/root-comment —
including a literal `case 'unauthorized':` in `PrHeader.tsx`), a discriminated **`.kind`**
union that `sendPatch` **derives from the HTTP status number** (reload/draft: 404 →
`draft-not-found`/`session-not-found`, 409 → conflict kinds, else → `other`), or nothing
(discard, preferences). The global `401 → prism-auth-rejected` interceptor is a fourth
consumer.

Two consequences the first draft missed, now load-bearing:

1. **The code string is a contract.** Changing a not-subscribed body code from `"unauthorized"`
   to `"not-subscribed"` would fall out of `KNOWN_SUBMIT_ERROR_CODES` and degrade the tailored
   `PrHeader` toast to the raw server string. → **Keep code `"unauthorized"`; move only the
   status 401 → 403.**
2. **For the draft pipeline, `.kind` *is* the status.** Changing the draft `markAllRead`
   not-subscribed response from 404 to 403 would flip `sendPatch`'s derived kind from
   `draft-not-found` to `other`, changing which consumer branch runs. → **The draft
   `markAllRead` not-subscribed path stays 404 `{error:"not-subscribed"}`, unchanged.** It is
   a structurally different return path (a `PatchOutcome`, mapped through the patch-outcome
   switch), not a submit-family guard, so excluding it is consistent, not a gap.

Therefore: extract duplicated **mechanics**; align drifted **status numbers**; **never** touch
an error code, body shape, or `.kind`-deriving status that a frontend parser reads.

## 4. Architecture

New folder `PRism.Web/Endpoints/Shared/` (namespace `PRism.Web.Endpoints`, matching every
existing endpoint file). All seams are **static helpers / extension methods** — no DI, no
`IEndpointFilter`. Rationale: the codebase has **zero** `IEndpointFilter` usage, and
`Program.cs:232-238` documents *why* (filters run after parameter binding, by which point
`IHttpMaxRequestBodySizeFeature` is read-only). Static helpers also match the existing
pattern — each endpoint class already holds private `static` helpers.

One change lands in Core: `AppState.WithSession(key, session)` as an instance method beside
`WithDefaultReviews` in `PRism.Core/State/AppState.cs`.

## 5. The seams

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

**Stays per-site:** the surrounding `catch` blocks and their **logging** (per-class
`LoggerMessage` delegates), and `PrSubmitEndpoints`' discard `catch (HttpRequestException hre)
when (hre.StatusCode == NotFound)` already-gone clause (a *separate, earlier-ordered* catch —
unaffected by the mapper signature change). Catch sites change from `MapGithubError(hre)` /
inline-switch to `GitHubErrorMapper.ToResult(ex)`.

### Seam 2 — `RequireSubscribed`

`PRism.Web/Endpoints/Shared/RequireSubscribed.cs`

```csharp
internal static class RequireSubscribed
{
    // null  => subscribed, proceed.
    // non-null => 403 result the caller returns immediately.
    // Code stays "unauthorized" (an existing KNOWN_SUBMIT_ERROR_CODES value the FE maps);
    // only the status moves 401 -> 403.
    internal static IResult? Check(IActivePrCache cache, PrRef prRef) =>
        cache.IsSubscribed(prRef)
            ? null
            : Results.Json(new SubmitErrorDto("unauthorized",
                "Subscribe to this PR before making changes."),
                statusCode: StatusCodes.Status403Forbidden);
}
```

**Replaces:** the 401 guards at `PrSubmitEndpoints.cs:109,308,418,523`,
`PrRootCommentEndpoints.cs:61`, `PrCommentEndpoints.cs:43`, `PrDraftsDiscardAllEndpoint.cs:46`
— **six submit-family sites**. Call-site usage:
`if (RequireSubscribed.Check(cache, prRef) is { } r) return r;`.

**Status decision: 401 → 403.** Authenticated-but-not-permitted is precisely 403. It is *not*
401 (which trips the global re-auth redirect — wrong for not-subscribed). The body **code
`"unauthorized"` is preserved** — `PrHeader.tsx` `case 'unauthorized'` keeps showing its
tailored toast, and the comment composer keeps showing the server message (now the generic
"Subscribe to this PR before making changes." — a copy change, same meaning, not a contract
change). The per-verb messages ("before submitting/discarding/posting") collapse to one
generic message; `PrHeader` never displayed them (it maps the code), and the composer copy
stays accurate.

**Excluded — `PrDraftEndpoints.cs:187` `PatchOutcome.NotSubscribed` → 404
`{error:"not-subscribed"}` stays as-is.** It flows through the draft patch-outcome switch into
`sendPatch`, whose `.kind` is derived from the status number; changing 404 → 403 would flip
the FE consumer branch (§3.2). Folding it in was never structurally clean (different return
shape). Documented as a deliberate carve-out, not a gap. **If the owner wants true single-code
unification**, it requires a coordinated FE change in `sendPatch` (map 403 → a not-subscribed
kind) + the consumer — out of scope here, notable in §10.

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

**Scope: `PreferencesEndpoints.cs:19` (the bug) + `PrDraftEndpoints.cs:83-96` (the one
mechanical duplicate).** `AuthEndpoints` is **excluded** — its three parse sites already carry
the catch + root-kind guard (no bug) and use bespoke auth DTOs; routing auth code through a
new helper is incidental risk for zero fix (§2 Non-Goals, §10 follow-up). Each in-scope caller
maps `Error` to its own DTO so bodies are preserved:

- `PrDraftEndpoints`: `InvalidJson | NotObject → BadRequest(new { error = "patch-body-missing" })`
  (it currently collapses both to that body — preserved).
- `PreferencesEndpoints`: `InvalidJson → BadRequest(new PreferencesError("invalid-json"))`
  (**new** — the bug fix, AC §9); `NotObject → BadRequest(new PreferencesError(
  "body must be a JSON object"))` (its existing body, now routed through the helper).

This satisfies "one definition of JSON-body read" for the `pr/*` + `preferences` family
without forcing envelope unification or touching auth.

### Seam 4 — `AppState.WithSession`

`PRism.Core/State/AppState.cs` (instance method, beside `WithDefaultReviews`)

```csharp
/// <summary>
/// Upserts a review session keyed by the canonical session key (owner/repo/number,
/// the same key shape used by Reviews.Sessions elsewhere). Returns a new AppState; does
/// not mutate. Callers MUST use the canonical key or the session becomes unreachable.
/// </summary>
public AppState WithSession(string sessionKey, ReviewSessionState session)
{
    var sessions = new Dictionary<string, ReviewSessionState>(Reviews.Sessions) { [sessionKey] = session };
    return WithDefaultReviews(Reviews with { Sessions = sessions });
}
```

**Replaces:** the identical private `WithSession` helpers at `PrSubmitEndpoints.cs:610-614`,
`PrRootCommentEndpoints.cs:198-202`, `PrCommentEndpoints.cs:176-180`, and the inline upserts at
`PrDraftEndpoints.cs:158-162`, `PrReloadEndpoints.cs:185-189`, **and
`PrDraftsDiscardAllEndpoint.cs:63-64`** (a sixth inline copy the first draft missed) — six
sites total.

**SubmitPipeline:** `SubmitPipeline.cs` carries its own field-overlay upsert. It is **out of
scope** for this seam — its pattern (re-read current session, edit one field) differs from the
whole-session replace, and folding it in is not a guaranteed win. Stated as out-of-scope (§10),
not "opportunistic." The six endpoint copies are the deliverable.

### Seam 5 — `PathValidation`

`PRism.Web/Endpoints/Shared/PathValidation.cs`

Adopts `PrDetailEndpoints.CanonicalizePath` (`:273-304`) as the single definition:
**UTF-8 byte-count** cap, **segment-split** `..`/`.` rejection (strictly stronger than
PrDraft's substring `"/../"` match — it also rejects a bare `..` segment), C0/C1 control-char
rejection, backslash rejection, empty-segment rejection, and the **NFC byte-length-mismatch**
guard. Returns the NFC-normalized canonical string, or `null` if invalid. Security note: the
adopted validator rejects a **superset** of what PrDraft rejected — no traversal input that
PrDraft blocked becomes accepted.

```csharp
internal static class PathValidation
{
    internal static string? Canonicalize(string path) { /* PrDetail's 7-rule body, verbatim */ }
}
```

**Replaces** `PrDraftEndpoints.IsCanonicalFilePath` (`:558-570`). `PrDraftEndpoints` treats
`null` as invalid (mapping to its existing error body). **Behavior change (AC §9):** draft-side
path validation moves char-count → byte-count + segment-split. Regression test exercises a
multi-byte path. The `Encoding.UTF8.GetByteCount(body.Path) > 4096` length cap stays at the
`/viewed` call site (`PrDetailEndpoints.cs:199-200`); the draft side adopts the same byte-count
rule.

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
already uses the case-insensitive `[GeneratedRegex]` form and switches to the shared one. Call
sites (`PrReloadEndpoints.cs:79`, `PrDraftEndpoints.cs:462`) use `Sha40.IsMatch`/`Sha64.IsMatch`,
which `SharedRegexes.Sha40()`/`Sha64()` substitute for.

**Behavior change:** `POST /reload` and the draft side now **accept an uppercase SHA** they
previously 422'd. This is a *loosening* — every currently-valid (lowercase) input still passes,
the regex stays anchored `^…$` (no injection surface), and the frontend only ever sends the
lowercase head SHA it received from the API. Case rule standardized on case-insensitive, per
AC §9. **Note:** `PrReloadEndpoint`'s SHA-rejection test asserts the old reject — see §8
test-migration.

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
helper pure and testable. `if (count > 8)` becomes `while (count > MaxTabStamps)` —
behavior-identical for the single-insert pattern (count exceeds the cap by at most one).

### Seam 8 — body-cap constant unification (+ best-effort metadata migration)

`PRism.Web/Endpoints/Shared/EndpointExtensions.cs`

**Primary deliverable: a single source for the cap value.** The `16 * 1024` at
`Program.cs:274` and the `16384` ×2 at `PrDetailEndpoints.cs:185,251` are the same spec value
as three unconnected literals. They collapse to one constant:

```csharp
internal const int MutatingBodyCapBytes = 16 * 1024; // 16 KiB — single source of truth
```

**Predicate removal is best-effort, gated on a 413 test — and expected NOT to fully land.**
The first draft claimed `PrDetailEndpoints.cs:185,251` "prove the metadata mechanism works in
production." It does not: those two routes carry `RequestSizeLimitAttribute(16384)` but are
**absent from the `Program.cs` predicate and have no oversized-body 413 test**, and
`RequestSizeLimitTests.cs` documents that the attribute **"doesn't fire pre-binding for
minimal-API endpoints"** — which is precisely why the middleware exists. Every passing 413
today (submit/reload/draft/feedback) comes from the middleware's Content-Length pre-check, not
from attribute metadata.

Therefore seam #8 does **not** assume `.WithBodyCap()` metadata can replace the middleware. The
plan adds an explicit **"oversized body → 413"** test for a candidate endpoint; the migration
proceeds **only** for endpoints that pass it. Per the evidence above, the expected outcome is
that the **middleware predicate is retained** and the win is the constant unification, not
predicate removal. The seam is **never** allowed to silently downgrade a 413 to a 500 or to
leave a mutating endpoint with no cap (see §7).

## 6. Status-code unification (status numbers only)

| Condition | Before | After | Why safe |
|-----------|--------|-------|----------|
| not-subscribed (submit family: submit, comment, root-comment, drafts/discard-all) | 401 (`SubmitErrorDto "unauthorized"`) | **403**, **code `"unauthorized"` kept**, body message genericized | FE maps code `"unauthorized"` (`PrHeader case`); status not branched on except the global 401 interceptor, which 403 correctly avoids |
| not-subscribed (draft `markAllRead`) | 404 `{error:"not-subscribed"}` | **unchanged (404)** | `sendPatch` derives `.kind` from status; changing it flips the FE branch (§3.2) — deliberately excluded |
| no-session (submit **and** root-comment) | 400 `no-session` | **404** (body code `"no-session"` kept) | submit/root-comment parsers read `.code`, not status |
| no-session (reload) | 404 `session-not-found` | unchanged (404) | already 404 |
| discard-success (foreign discard-all) | 200 empty | **204** | client treats 200/204 identically (`client.ts:87`) |
| discard-success (own discard) | 204 | unchanged (204) | already 204 |

**Three no-session emitters, not two.** `PrSubmitEndpoints.cs:129` **and**
`PrRootCommentEndpoints.cs:100-101` both emit `SubmitErrorDto("no-session", …)` at 400; both
move to 404. `PrReloadEndpoints.cs:94` is already 404. Each keeps its own body; only the status
aligns.

Codes, bodies, and `.kind`-deriving statuses are **not** touched — only the status numbers in
the table above move.

## 7. Risks

| Risk | Mitigation |
|------|-----------|
| **Body-cap (seam #8)** | Constant-unification is the committed win; metadata migration gated behind an oversized→413 test and expected to leave the middleware predicate in place. The seam may not remove unbounded-body exposure on any endpoint: the plan verifies **every** mutating endpoint (incl. `comment/post` and `preferences`, both absent from today's predicate) ends with cap coverage via the predicate. No endpoint may fall through both mechanisms. |
| not-subscribed FE regression | Resolved by design: status-only 401→403, code `"unauthorized"` preserved, `markAllRead` 404 untouched. Plan still greps the FE for `case 'unauthorized'` / `KNOWN_SUBMIT_ERROR_CODES` membership / `=== 'unauthorized'` to confirm no site degrades. |
| Existing tests encode the old contract | §8 enumerates the test-migration set; the plan separates contract-encoding edits from accidental breakage. |
| Path byte-count rejects a previously-valid draft path | Only multi-byte paths near the 4096 boundary differ; the adopted validator rejects a superset of traversal inputs (no security regression); regression test covers multi-byte. |
| `markAllRead` 404 SessionToken-auth vs not-subscribed conflation | `PrDraftEndpointTests` `Missing_session_token_returns_401` is the SessionToken **auth** 401, NOT the not-subscribed guard — must not be swept to 403. Called out in §8. |
| GraphQL/transport untouched | Seam #1 extracts only the error switch; no submit-transport change (keeps #320's byte-identity intact). |

## 8. Testing

**New / changed assertions (behavior deltas):**

- **Red-on-main regression** (AC §9): `POST /api/preferences` with a malformed body returns
  **400 `invalid-json`** (fails on `main` today — 500).
- not-subscribed → **403** (code `"unauthorized"`) for submit, comment, root-comment,
  drafts/discard-all. `markAllRead` stays **404** (assert unchanged).
- no-session → **404** for submit **and** root-comment (reload already 404).
- discard (foreign discard-all) → **204**.
- Draft path validation with a **multi-byte** input (byte-count semantics).
- SHA: `POST /reload` accepts an **uppercase** 40-hex SHA.
- Seam #8: **oversized body → 413** for the candidate endpoint (gate for metadata migration);
  plus a coverage check that no mutating endpoint is uncapped.

**Tests that must change (encode the old contract — intended red, then updated):**

- `PrSubmitDiscardEndpointTests.cs:188-190` — asserts 401 + code `"unauthorized"` (test named
  `*_returns_401`) → **403**, code unchanged; rename.
- `PrCommentEndpointTests.cs:237-239` — 401 not-subscribed → **403**.
- `PrRootCommentEndpointTests.cs:259` — 401 not-subscribed → **403**.
- `PrSubmitEndpointsTests.cs:289-290` — 400 + `"no-session"` → **404**, code unchanged.
- `PrRootCommentEndpointTests` no-session (the 400 + `"no-session"` assertion) → **404**.
- `PrDraftsDiscardAllEndpointTests.cs:35` — asserts 200/OK on the foreign discard-all → **204**.
- `PrReloadEndpoint` SHA-reject test — uppercase SHA now **accepted** (flip the reject case).
- **Do NOT touch** `PrDraftEndpointTests.cs:86` `Missing_session_token_returns_401`
  (SessionToken auth 401, unrelated to not-subscribed).

**Behavior-preserving seams (1, 3-draft side, 4, 5-mechanics, 7):** existing `PRism.Web` /
`PRism.Core` / `PRism.GitHub` suites stay green except the contract-encoding tests listed above.

**Frontend:** no code change. The `case 'unauthorized'` grep is a verification step.

## 9. Acceptance criteria

- [ ] One definition each for: GitHub error mapping, subscribed-guard, session upsert, path
      validation, SHA regex, tab-stamp write, and JSON-body read (`pr/*` + `preferences`).
- [ ] `POST /api/preferences` returns 400 `invalid-json` on malformed body (regression test
      red-on-main).
- [ ] Draft-side path validation uses byte-count semantics (test with multi-byte input).
- [ ] Status numbers unified: not-subscribed (submit family) → 403 with code `"unauthorized"`
      preserved; no-session (submit + root-comment) → 404; discard-success → 204. Draft
      `markAllRead` stays 404 (documented carve-out).
- [ ] Body-cap value defined once (`MutatingBodyCapBytes`); every mutating endpoint retains
      413 coverage; `Program.cs` predicate removed **only** for endpoints whose oversized→413
      test passes (expected: predicate retained, constant unified).
- [ ] SHA regex case rule unified (case-insensitive, `[GeneratedRegex]`).
- [ ] Tab-stamp write + `X-PRism-Tab-Id` header + cap (8) each defined once, including the
      test hook.
- [ ] Full `dotnet test` green (with the §8 contract-encoding tests updated); no frontend
      `.code`/`.kind` parser regression.

## 10. Out of scope / follow-ups

- Error-envelope and error-code convergence → #198.
- **`AuthEndpoints` JSON-read dedup** — deferred; already correct, sensitive surface, no bug.
- **`SubmitPipeline` session-upsert fold-in** — out of scope (field-overlay vs whole-session
  replace; not a guaranteed win).
- **True single-code not-subscribed unification** (folding draft `markAllRead` into 403) —
  deferred; needs a coordinated `sendPatch` `.kind` mapping + consumer change.
- The per-verb not-subscribed messages collapse to one generic message; trivially restorable
  if a per-verb message proves worth keeping.

## 11. Doc-review dispositions (round 1 — `ce-doc-review`, 5 personas)

Findings judged with `receiving-code-review` rigor. **Applied** = spec changed; **Rejected** =
not applied, with reason.

- **APPLIED — FE `.code`/`.kind` branching claim was false (security-lens + adversarial, conf
  100).** `PrHeader case 'unauthorized'` + `KNOWN_SUBMIT_ERROR_CODES` membership, and `sendPatch`
  `.kind` derived from status. Resolution: status-only 401→403, **keep code `"unauthorized"`**,
  **exclude `markAllRead`** (stays 404). Rewrote §3, Seam 2, §6.
- **APPLIED — existing backend tests encode the old contract (adversarial, conf 100).** §8 now
  has a "Tests that must change" subsection enumerating each file:line, plus the do-not-touch
  SessionToken-401 test.
- **APPLIED — seam #8 "metadata proves it works" inverted (feasibility, conf 100).** Reframed
  seam #8: constant-unification is the committed win; predicate removal is best-effort and
  expected NOT to land (per `RequestSizeLimitTests.cs`). AC §9 updated.
- **APPLIED — 6th session-upsert site omitted (scope-guardian, conf 100, safe_auto).** Added
  `PrDraftsDiscardAllEndpoint.cs:63-64` to Seam 4.
- **APPLIED — 3rd no-session emitter omitted (scope-guardian, conf 75).** `PrRootCommentEndpoints.cs:100-101`
  added to the no-session → 404 migration (§6, §8).
- **APPLIED — seam #3 over-captured bug-free Auth sites (scope-guardian, conf 75).** Tightened
  Seam 3 to `Preferences` + `PrDraft`; `AuthEndpoints` dedup deferred (§2, §10).
- **APPLIED — SubmitPipeline fold-in was under-specified "opportunistic" (adversarial, conf 75).**
  Moved to explicit out-of-scope (§10) instead of a runtime decision.
- **APPLIED — "near-unreachable" understated a real flow (adversarial, conf 50, FYI).** Dropped
  the "near-unreachable" framing; §1 states the semantic wrongness without claiming the flow is
  unreachable.
- **APPLIED — AppState.WithSession key-format misuse risk (scope-guardian, residual).** Added an
  XML-doc comment specifying the canonical key shape.
- **REJECTED — split into two PRs (adversarial + scope-guardian, conf 75, manual).** The split's
  value was reviewability (separating must-scrutinize from mechanical). This revision shrank the
  behavior surface to **status-number changes only** (no code/body/envelope/`.kind` changes
  anywhere, `markAllRead` untouched, seam #8 mostly constant-only), and §8 now delineates the
  exact contract-encoding edits. A gated reviewer can separate the ~6 status-number edits from
  mechanical churn via the §8 list without paying the cost of two PRs churning the same files.
  Surfaced to the owner as a decision; will split if the owner prefers.
