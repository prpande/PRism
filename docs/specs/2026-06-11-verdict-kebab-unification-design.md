# Verdict wire-format unification — kebab-case cutover (#318)

**Date:** 2026-06-11
**Issue:** #318 (epic #317, Theme A — Wire format & Web API consistency)
**Tier / Risk:** T2 / gated B2 (kebab-enum architectural invariant + `POST /submit` input surface). Cutover strategy settled with owner at the gate: **hard cutover, no migration window.**

## Problem

The three-valued review-verdict concept crosses the HTTP API in three casings:

| Path | Casing today | Source |
|------|-------------|--------|
| `GET /draft` (read) | kebab (`request-changes`) | `DraftVerdict` via shared `JsonStringEnumConverter` |
| `PUT /draft` (write operand) | camelCase (`requestChanges`) | hand-rolled string check, `PrDraftEndpoints.cs:532` + parse `:230-235` |
| `POST /submit` (write operand) | PascalCase (`RequestChanges`) | hand-rolled switch, `PrSubmitEndpoints.TryParseVerdict :564-573` |

A client cannot echo back what `GET` returned. The frontend pays with two types (`DraftVerdict` kebab + `Verdict` Pascal) and two shims (`verdictToWire`, `verdictToSubmitWire`). Separately, `PRism.Core.Contracts/Verdict.cs` is a third member-identical enum **referenced by nothing in production** (only its own test), while `SubmitEvent` — the enum the pipeline actually uses — has no wire-format test.

This is a live violation of the `architectural-invariants.md` rule: *all JSON enums round-trip as kebab-case via the single converter.*

## Goal / Acceptance criteria

1. `PUT /draft` and `POST /submit` accept **exactly** the strings `GET /draft` returns: `approve`, `request-changes`, `comment`.
2. A **single canonical kebab parse** governs both write paths — no per-endpoint *divergent* casing switches remain. (Reframed from the issue's "no hand-rolled switch": the shared kebab converter is permissive — it accepts PascalCase/camelCase/integer inputs — so it cannot deliver AC#1's *exact* rejection. A strict exact-match parse on the canonical kebab strings is the mechanism; the epic's target is the three *divergent* copies, which this collapses to one casing.)
3. `PRism.Core.Contracts/Verdict.cs` deleted; `VerdictSerializationTests` retargeted at `SubmitEvent` (kebab round-trip pinned).
4. Frontend collapses to the single kebab `DraftVerdict` type; `Verdict` type, `verdictToWire`, and `verdictToSubmitWire` deleted.
5. The structured `verdict-invalid` error contract is preserved on both paths (an invalid operand returns `{code/error: "verdict-invalid"}` 400, not a generic model-binding 400).

**Out of scope (deferred, separate decision):** SSE § 18.2 PascalCase `Step`/`Status` fields (issue's optional item #4). **Known residual:** this leaves the SSE channel as a deliberate, documented exception to the kebab-enum invariant after #318 ships — #318 unifies the *verdict request/response* surface, not every wire enum. Flagged so a later reader doesn't assume the invariant is fully restored. `SubmitEvent` and `DraftVerdict` stay as **two** enums — they live in different layers (Submit pipeline vs State); the issue only deletes the *dead* third enum, not merging the two live ones. Merging would couple `Core.State` to `Core.Submit` for no wire benefit.

## Design decision: hard cutover (settled at gate)

PRism ships frontend+backend as one unit (desktop bundle / single web serve). There is no independent API consumer that could send a legacy casing. The only theoretical window is a browser tab held open across a server restart in web mode — single-user local tool, recoverable by refresh. A migration window means a *dated compat branch* accepting legacy casings: drift-prone dead weight, the antithesis of this cleanup. **No compat branch.**

**Persisted-schema note (B2 clearance):** this change touches only *transient wire-input parsing*. `DraftVerdict` in `state.json` already serializes kebab via the shared converter and is **not** modified. No `state.json` migration; existing persisted drafts are unaffected.

## Approach

### Backend — `PRism.Web` (strict kebab exact-match — Option B, settled at gate)

Why not the shared converter: `JsonSerializerOptionsFactory.Api` registers `new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())` — the two-arg ctor, so `allowIntegerValues` defaults `true`, and `JsonStringEnumConverter` matches enum member names case-insensitively regardless of `PropertyNameCaseInsensitive=false`. Empirically (net10.0) it accepts `RequestChanges`, `requestChanges`, `APPROVE`, and the numeric-ordinal **string tokens** `"0"/"1"/"2"` (and, on the draft path's raw `JsonElement`, the JSON numbers `0/1/2`). That violates AC#1 ("accept exactly") and widens the B2 submit input surface. So the parse is an explicit kebab allowlist that rejects everything else.

**`PrSubmitEndpoints.TryParseVerdict` (`:564-573`)** — replace the PascalCase switch with the canonical kebab switch:

```csharp
private static bool TryParseVerdict(string? s, out SubmitEvent verdict)
{
    verdict = s switch
    {
        "approve"         => SubmitEvent.Approve,
        "request-changes" => SubmitEvent.RequestChanges,
        "comment"         => SubmitEvent.Comment,
        _                 => default,
    };
    return s is "approve" or "request-changes" or "comment";
}
```

Exact ordinal match — `RequestChanges`, `"1"`, `APPROVE`, null all return false. Caller at `:112-113` still returns the `verdict-invalid` `SubmitErrorDto` 400, **and its message is updated** to name the kebab values (see below).

**`PrDraftEndpoints` draftVerdict** — the operand is a `JsonElement value`. Collapse the camelCase validate (`:528-535`) and the camelCase apply parse (`:226-236`) onto the same canonical kebab strings:
- Validate path: `value.ValueKind == Null` → ok (explicit clear); else read `value.ValueKind == String ? value.GetString() : null` and reject (`BadRequest({ error = "verdict-invalid" })`) unless it is one of `approve` / `request-changes` / `comment`. The explicit `ValueKind == String` check **preserves** the current guard (`:531`) that blocks non-string tokens — a JSON integer `{value: 1}` stays rejected.
- Apply path: replace the `GetString() switch { "approve" / "requestChanges" / "comment" }` with a switch on the same three **kebab** strings → `DraftVerdict`. Keep the `_ => throw InvalidOperationException("verdict already validated")` default arm as defensive code — it is unreachable because the validate path already rejected any non-kebab/non-null operand, but it documents the invariant and guards against a future caller that skips validation.

Both paths now accept exactly the three kebab strings.

**Caller error message (`PrSubmitEndpoints :113`)** — change `"verdict must be Approve, RequestChanges, or Comment."` → `"verdict must be approve, request-changes, or comment."` so a 400'd client is told the casing that actually works.

### Backend — `PRism.Core.Contracts`

- Delete `PRism.Core.Contracts/Verdict.cs`.
- Retarget `tests/PRism.Core.Tests/Contracts/VerdictSerializationTests.cs` at `SubmitEvent` (assert kebab round-trip: `approve` / `request-changes` / `comment`, serialize **and** deserialize). Rename class to `SubmitEventSerializationTests` for clarity.

### Frontend — `frontend/src/api`

- `submit.ts`: **change the `submitReview` signature** `(prRef, verdict: Verdict)` → `(prRef, verdict: DraftVerdict)` and post the kebab value directly (drop the `Verdict` import). Delete `verdictToSubmitWire` (and its `submit-api.test.ts` describe block).
- `types.ts`: delete `export type Verdict` (`:503`) and the stale comment at `:500-502` (which describes the now-removed PascalCase submit casing); keep `DraftVerdict` as the single verdict type.
- `draft.ts`: delete `verdictToWire`; `verdictPatchValue` returns the kebab value unchanged (`v === null ? null : v`) — or inline it. Delete the stale comment at `:20-23` describing camelCase PUT validation.
- Call sites: `PrHeader.tsx:250`, `SubmitDialog.tsx:342` — drop the `verdictToSubmitWire(...)` wrapper, pass the kebab verdict straight through. Remove the now-unused imports. `tsc -b` catches any dangling `Verdict` reference.

### Tests to update

- **Backend:** `PrSubmitEndpointsTests` (the valid-verdict happy path now sends `request-changes` not `RequestChanges`; the `verdict-invalid` case keeps a bogus operand). `PrDraftEndpointTests` / `PrDraftEndpointsVerdictClearTests` / `DraftRaceTests` (any that send `requestChanges` → `request-changes`). `AppStateRoundTripTests` unaffected (persistence unchanged). New: `SubmitEventSerializationTests`.
- **Frontend:** `submit-api.test.ts` (delete the `verdictToSubmitWire` describe block; assert `submitReview` posts `{verdict:'request-changes'}`). `PrHeader.test.tsx` (mock no longer needs `verdictToSubmitWire`).

## Test plan (TDD order)

1. **Backend wire pin (new):** `SubmitEventSerializationTests` — `SubmitEvent` round-trips kebab. (Red: enum has no test; Green after retarget.)
2. **Submit accepts kebab, rejects legacy/int:** posts `{verdict:'request-changes'}` → 200/started; `{verdict:'RequestChanges'}` → 400 `verdict-invalid`; `{verdict:'1'}` → 400 (no integer-ordinal acceptance). Proves the cutover rejects the old casing.
3. **Draft accepts kebab, rejects legacy/non-string:** `PUT /draft` with `draftVerdict:'request-changes'` applies; `'requestChanges'` → 400; numeric `draftVerdict: 1` (JSON number) → 400 (the `ValueKind == String` guard holds).
4. **Frontend wire:** `submitReview('request-changes')` posts kebab body; `serializePatch` emits kebab `draftVerdict`.
5. Delete-and-retarget done; full backend + frontend suites green; `tsc -b` clean (no dangling `Verdict`/shim refs).

## Risks

- **Missed call site** of a deleted shim/type → caught by `tsc -b` (project typecheck) and the backend compiler (`TreatWarningsAsErrors`).
- **An e2e/test fixture** still sending legacy casing → now 400s; the test sweep above plus a repo-wide grep for `RequestChanges`/`requestChanges` string literals before PR catches stragglers.

## Doc-review dispositions (1× ce-doc-review, 2026-06-11)

| # | Reviewer | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | feasibility / adversarial(P0) / security | Converter parse accepts PascalCase/camelCase/integers — AC#1 false, cutover not provable, B2 input-surface widened | **Applied** — switched the whole mechanism to a strict kebab allowlist (Option B, owner-confirmed at gate). Negative tests now valid; integer/non-string rejected. |
| 2 | coherence / adversarial / security | `:113` error message still names PascalCase verdicts | **Applied** — message updated to kebab values. |
| 3 | coherence | Stale FE comments (`draft.ts :20-23`, `types.ts :500-502`) describe pre-cutover casing | **Applied** — both scrubbed in the Approach. |
| 4 | coherence | `submitReview` signature change buried as a parenthetical | **Applied** — now a first-class bullet. |
| 5 | feasibility | `PrSubmitEndpoints` lacks `Api`/`using PRism.Core.Json` | **Skipped (moot)** — Option B uses a plain `switch`, no `Api` reference in the submit file. |
| 6 | security | Draft path drops the `ValueKind == String` guard | **Applied** — guard explicitly preserved in the validate path. |
| 7 | adversarial(50) | SSE §18.2 deferral leaves a residual invariant gap unflagged | **Applied** — residual gap called out in Out-of-scope. |
| 8 | adversarial (residual) | B2 persisted-state clearance | **Confirmed** — independently verified state.json uses `Storage` options (already kebab); no migration. |
| — | adversarial (residual) | Keep `SubmitEvent` + `DraftVerdict` as two enums | **No change** — reviewers agreed; merging would couple Core.State↔Core.Submit; epic targets only the dead third enum. |
