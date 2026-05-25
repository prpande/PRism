---
source-doc: docs/specs/2026-05-15-s6-polish-and-distribution-design.md
plan-doc: docs/plans/2026-05-15-s6-polish-and-distribution.md
created: 2026-05-23
last-updated: 2026-05-23
status: open
revisions:
  - 2026-05-23: created during the 2026-05-23 spec amendment pass to record one deferral surfaced by the drift review against PRs #55–#65.
---

# Deferrals — S6 polish and distribution

Decisions that surfaced during the 2026-05-23 amendment pass and were intentionally NOT absorbed into the S6 spec. Each entry names the source, severity (P0 = blocks merge, P1 = revisit before v2, P2 = noted for posterity, P3 = advisory only — no implementation action required), date, rationale, and the trigger that should reopen the decision.

The 2026-05-23 amendment pass itself folded its other findings directly into the spec (see § 15.1 of the design doc); this sidecar captures the items that were considered and explicitly deferred.

---

## Plan-time / amendment-time deferrals

### [Decision] Real-flow Playwright Replace-token spec deferred

- **Source:** 2026-05-23 amendment pass (cross-reference against PR #58 which shipped the real-flow harness against `prpande/prism-sandbox`).
- **Severity:** P2 — additive coverage, not blocking. The existing standard Playwright specs in § 11.4 (`replace-token-same-login.spec.ts`, `replace-token-different-login.spec.ts`, `replace-token-submit-in-flight.spec.ts`) already exercise the identity-change rule against fixture-controlled GitHub responses.
- **Date:** 2026-05-23
- **Reason considered:** PR #58's real-flow harness provides the strongest possible signal — live-GitHub validation against `prpande/prism-sandbox` PRs. Identity-change is exactly the kind of cross-cutting rule (Node IDs cleared, drafts preserved, foreign-pending-review path triggered on next submit) where a real-flow spec would catch wire-shape regressions the standard Playwright specs can't.
- **Why deferred:**
  - **Sandbox topology gap.** The real-flow harness today uses a single sandbox account (`prpande`'s PAT). A meaningful "different login" Replace-token spec needs a SECOND distinct GitHub account to swap to. Creating + maintaining that account is a real ongoing cost (PAT rotation, sandbox-PR access ACLs, leak-discipline for the second token in `fixtures.json`).
  - **Diminishing return vs. cost.** The standard Playwright specs in § 11.4 already mock the GraphQL boundary and assert the in-process identity-change rule end-to-end. The marginal bug a real-flow spec would catch is a GraphQL-wire-contract mismatch (the bug class PR #65 found for `pr-updated`) on the auth surface specifically — Replace token doesn't issue many GraphQL calls relative to the submit pipeline (one `viewer` query via `ValidateCredentialsAsync` and that's it). Catch rate is genuinely hard to estimate; PR #65 showed wire-shape risk is proportional to coverage gaps, not call volume, so the framing here is "smaller wire surface than submit-pipeline, combined with second-account cost, defers the spec" rather than a confident "low catch rate" claim.
  - **PR #58 precedent.** The real-flow suite ships with `retries: 0` and a 3-consecutive-green-runs pre-merge gate per `docs/e2e/real-flow.md`. Adding a fourth spec to the suite increases the suite's per-run wall-time AND the per-spec flake budget proportionally. Real-flow specs are expensive — each one must clear a "would this catch a bug the standard spec can't?" bar.
- **Revisit when:**
  - A second sandbox account becomes available (cost of standing up + rotating the PAT amortizes across enough specs).
  - A real-flow regression appears on the auth surface (validation, replace-token, identity-change) that the standard Playwright specs missed — that's evidence the real-flow lens IS catching something standard tests don't.
  - Multi-account v2 work begins — at that point the harness almost certainly needs a second-account flow anyway, and Replace-token becomes a free rider on that infrastructure.
- **Where the gap lives in code:** Nowhere — this is a not-added spec. The amendment doc § 15.3 references this deferral by name.

---

## Forward-looking residual risks for the implementer

Items the implementing engineer should keep an eye on during Phase 1 execution.

### [Risk] `LogsPathOptions` registration coupling to `FileLoggerProvider`

- **Where:** § 2.4's `logsPath` exposure assumes the `/api/preferences` GET handler can read the configured `logsDir` without duplicating the platform-path derivation. The spec sketch suggests `IOptions<LogsPathOptions>` or a static `LogsPathAccessor`; the implementer should pick whichever fits PR #63's existing `FileLoggerProvider` registration shape best, NOT add a second derivation of `<LocalApplicationData>/PRism/logs`.
- **Mitigation:** During PR1 implementation, grep for where `FileLoggerProvider` is constructed in `Program.cs` (or `ServiceCollectionExtensions`) and read the `logsDir` from the same source. Adding a second `Path.Combine(...)` would risk divergence if the dataDir convention ever changes.
- **Severity:** P2 (test-pinned — the amendment's § 11.1 test "logsPath matches the `logsDir` `FileLoggerProvider` was constructed with" catches divergence).

### [Risk] `POST /api/auth/replace` is absent from the 16 KiB body-size-cap predicate

- **Source:** 2026-05-23 ce-doc-review security-lens pass.
- **Severity:** P3 (advisory — localhost-only threat model, mild DoS).
- **Date:** 2026-05-23
- **Where:** `PRism.Web/Program.cs:165-193` defines a `UseWhen` predicate that applies a 16 KiB body cap to mutating endpoints (`/api/events/subscriptions`, `PUT /api/pr/*/draft`, `POST /api/pr/*/reload`, `/submit`, `/submit/foreign-pending-review/*`, `/drafts/discard-all`). The new `POST /api/auth/replace` is not covered. An attacker who has obtained a session token can POST an arbitrarily large body, causing `JsonDocument.ParseAsync` to buffer the full payload before the PAT field is read.
- **Mitigation in v1:** None code-side. The threat model is localhost-only, so the realistic attacker is another localhost process or a browser extension with session-cookie access — both already have higher-impact paths available. The legitimate payload is ~40 chars (a PAT), so the cap would be ~99.9% headroom.
- **Revisit when:** PR2 implementer is wiring the endpoint — they can add `/api/auth/replace` (and arguably `/api/auth/*` as a class) to the `UseWhen` predicate as a one-line consistency fix without elevating this to a P0 blocker. Capture-and-fix rather than defer-and-track.
- **Severity rationale:** P3 because the threat model genuinely doesn't justify a code change before PR2 lands; treating this as a P0 would manufacture urgency for a 1-line consistency fix.

### [Risk] Existing `AuthEndpoints.cs` `LoggerMessage` methods silently redact GitHub login (forensic gap)

- **Source:** 2026-05-23 ce-doc-review security-lens pass.
- **Severity:** P2 (forensic visibility gap in existing code; not a disclosure risk — scrubber over-redacts, doesn't leak).
- **Date:** 2026-05-23
- **Where:** `PRism.Web/Endpoints/AuthEndpoints.cs:178` (`ConnectValidatedWithWarning`), `:180` (`ConnectCommitted`), `:188` (`CommitSucceeded`) — all three `[LoggerMessage]` source-generator methods declare a parameter named `login`. The `LoggerMessage` source generator emits the parameter name verbatim as the structured-log field key; `SensitiveFieldScrubber.BlockedFieldNames` includes `"login"` and matches case-insensitively (verified `SensitiveFieldScrubber.cs:41`). These three log lines therefore write `[REDACTED]` for the login value today.
- **Direction of harm:** the scrubber over-redacts — it does NOT leak; the bug is forensic completeness, not data disclosure. A maintainer grepping `<dataDir>/logs/` for `/api/auth/connect` outcomes sees `[REDACTED]` instead of the validated login, breaking the same "where did this token end up" reconstruction the S6 identity-change log was designed to support.
- **Mitigation in v1:** Out of scope for the S6 amendment (which is reviewing the polish-and-distribution spec). The fix is mechanical: rename the parameters to `validatedLogin` / `committedLogin` (3 one-line changes), or add a comment explicitly accepting the redaction as intentional. The S6 PR2 implementer is the natural owner of the fix since they'll be in the same file adding `LogIdentityChanged` with `priorLogin` / `newLogin` — extending the rename to the existing three sites is a one-commit follow-up.
- **Revisit when:** PR2 implementation begins; folding the rename into the same commit avoids a separate PR for three parameter renames.

### [Risk] LoggerMessage template-name discipline

- **Where:** § 3.6's amendment warns that any future call site emitting a bare `{login}` template argument would be silently redacted by `SensitiveFieldScrubber`. The current `LogIdentityChanged` argument names (`priorLogin`, `newLogin`) are safe, but a developer adding "log when validation succeeds" might intuitively pick `{login}`.
- **Mitigation:** No code change required in S6. Add a single line to `.ai/docs/behavioral-guidelines.md` or `CLAUDE.md` noting "if you need to log a GitHub login, pick a qualified name (priorLogin, newLogin, validatedLogin) — bare `{login}` is auto-redacted." Out of scope for S6; capture as a v2 backlog or behavioral-guidelines amendment.
- **Severity:** P3 (advisory).

---

## Note on the deferrals format

This sidecar mirrors the format of [`2026-05-11-s5-submit-pipeline-deferrals.md`](2026-05-11-s5-submit-pipeline-deferrals.md) and [`2026-05-10-multi-account-scaffold-deferrals.md`](2026-05-10-multi-account-scaffold-deferrals.md): `[Decision]` and `[Risk]` entries with severity, date, reason, revisit-trigger, where-the-gap-lives.
