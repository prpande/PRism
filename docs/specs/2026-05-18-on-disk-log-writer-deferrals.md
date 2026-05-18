---
source-doc: docs/specs/2026-05-18-on-disk-log-writer-design.md
created: 2026-05-18
last-updated: 2026-05-18
status: open
revisions:
  - 2026-05-18: brainstorm pass — initial deferrals from the design session (universal decorator, size-based rotation, NDJSON, scope dispatch, exception-message regex, hot-reload, flush-batching). Source-of-truth for each entry is the design doc § 11.
  - 2026-05-18: ce-doc-review pass 1 applied — four new deferrals added (Serilog as alternative, run.ps1-tee as alternative, Playwright Test-env file-sink hook, dedicated stderr-replacement self-diagnostic file). Two new "[Decision] not applied" entries added (PL-3/PL-5 regex-over-formatter alternative — rejected; PL-1/PL-2 premise-evidence acceptance — recorded as deliberate choice). One "[Risk]" entry tightened: § 12.6 PR #55 body double-write path.
  - 2026-05-18: ce-doc-review pass 2 applied — two material new defects landed in the design doc (post-Build `AddProvider` wiring inverted to pre-Build with internal env-gate; `EmitSessionStartLine` reordered after `OpenAppendStream`). Smaller fixes also applied (broad catch in LogTemplateFormatter; ScrubFieldName scoped internal; counter-race acknowledged; coherence references cleaned). Two new "[Risk]" entries added below (SEC-6 session-start PII when logs are shared; SEC-7 compile-time RetentionDays as operational-security constraint).
---

# Deferrals — On-disk log writer for PRism.Web

Decisions weighed during the brainstorm pass that did not land in the v1 slice. Severity tag, date, rationale, and revisit trigger per the standing format. The applied design lives in [`2026-05-18-on-disk-log-writer-design.md`](2026-05-18-on-disk-log-writer-design.md); this sidecar records the *not-applied* set so future readers see what was considered and why it was deferred.

---

## Brainstorm-time deferrals

### [Defer] Factory-level `ILogger`-wrapping decorator for universal redaction across Console + Debug + future providers

- **Source:** Brainstorm 2026-05-18 (Q5 design fork — file-sink-only vs factory-level decorator).
- **Severity:** P2.
- **Date:** 2026-05-18.
- **Reason:** The original S3 PR5 deferral (`docs/plans/2026-05-06-s3-pr-detail-read-deferrals.md:169`) asks for a factory-level decorator that intercepts every structured-log scope across every provider. That shape requires owning a small template formatter to re-run `{Name}`/`{Name:format}`/`{Name,alignment}`/`{{`/`}}` substitution against scrubbed values plus a substitute state-wrapper type, because `LoggerMessage.Define`'s strongly-typed state struct's `IReadOnlyList<KV>` projection is read-only and can't be mutated in place. Estimated cost: ~200 LOC of template-substitution machinery on top of the file sink. The load-bearing post-mortem vector ("user closed run.ps1, only the disk artifact remains") is fully closed by file-sink-internal redaction. Console-leak-while-user-tails is a speculative threat model for a single-user local PoC where the console reader IS the user, in their own terminal, on their own machine. YAGNI argues for the narrower slice. **The S3 PR5 deferral therefore remains partially open — file is covered; console is not.**
- **Revisit when:** The threat model expands (multi-user, networked deployment, or a console reader other than the user), OR a future log site needs the redaction at console-time for a reason that the file sink can't satisfy, OR a real incident is reported where a structured-arg PAT leaked through console output.
- **Where the gap lives in code:** The file sink ships full redaction; Console + Debug providers continue to rely on call-site discipline. The discipline is "do not pass a PAT-shaped value as a structured arg outside of the `pat` / `token` field names" — auditable via `git grep` on the existing `LoggerMessage.Define` sites.

### [Defer] Size-based rotation / total-disk-cap retention

- **Source:** Brainstorm 2026-05-18 (Q3 — retention policy).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** v1 uses date-based rotation (one file per day) + N-day retention (default 14). A 100MB+ chatty day on a single-user PoC is implausible at the current event rate (PR #55's structured delegates plus the 16 existing `LoggerMessage.Define` sites, dominated by the active-PR poller and SSE channel — all bounded). If a debug-flood day ever hits, the user can grep + delete; the slice's drop-count signal would surface the symptom. Adding size-based rotation now would be premature complexity — file rotation midnight at local time is predictable and matches operator intuition.
- **Revisit when:** A debug-flood day produces a >100MB log file in dogfooding, OR a teammate reports the data directory growing beyond their tolerance.

### [Defer] NDJSON / structured machine-parseable format

- **Source:** Brainstorm 2026-05-18 (Q1 — format).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** v1 ships plain text (timestamp + category + level + message + indented exception). The load-bearing use cases are (a) `gh issue` paste-friendliness (plain text wins) and (b) human grep + skim during local-dev introspection (plain text wins). NDJSON is the right format for machine-parseable triage tools, but no such tool exists or is on the roadmap. Adding NDJSON now would lock the slice into a format choice without a concrete consumer.
- **Revisit when:** A triage / aggregation tool emerges that needs structured input. Likely candidates: a log-search CLI that filters by category + level, or a future hosted-deployment scenario that ships logs to a backend system.

### [Defer] `BeginScope<TState>` dispatch into the file sink

- **Source:** Brainstorm 2026-05-18 (design § 4.2 — `FileLogger.BeginScope`).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** v1 returns `NullScope.Instance` (no-op). No PRism log site currently writes scope context that downstream readers consume — the 16 `LoggerMessage.Define` sites pass all relevant data as structured args, not scoped state. Implementing scope dispatch into the file sink would require a thread-local stack of active scopes + serialisation into each event line, none of which has a consumer.
- **Revisit when:** A PRism log site adds `using (logger.BeginScope("processing {PrRef}", prRef)) { ... }` and a reader (operator or test) needs the scope context in the file output. The fix is mechanical at that point.

### [Defer] Regex-based PAT-shape scrub of `Exception.Message` / `Exception.StackTrace`

- **Source:** Brainstorm 2026-05-18 (Q4 — decorator scope).
- **Severity:** P3 (forward-looking defensive).
- **Date:** 2026-05-18.
- **Reason:** v1 redacts by *field name* — the structured-arg key has to match `BlockedFieldNames` to trigger redaction. A future call site that does `throw new InvalidOperationException($"failed with PAT {pat}")` would leak the PAT through `ex.Message`, which lands in the `ExceptionString` field of the `FileLogEvent` and is written verbatim. The existing discipline ("never put a PAT in an exception message") is auditable via `git grep 'throw.*pat'`. Adding a regex pass (`^ghp_[A-Za-z0-9_]{36,}$` etc.) over exception messages + stack traces would cost CPU per log event and introduces false-positive risk (any 40-character alphanumeric string could match a PAT-shape regex). The trade — call-site discipline plus auditability vs. defense-in-depth at every log event — favours discipline for the PoC.
- **Revisit when:** A real incident surfaces a PAT-in-exception-message leak, OR a future slice introduces a code path that produces user-controlled exception strings that could include credentials (e.g., an OAuth flow with error messages from the IdP).

### [Defer] Hot-reload of `FileLoggerOptions`

- **Source:** Brainstorm 2026-05-18 (design § 4.1 — options snapshot at construction).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** `FileLoggerProvider` captures `FileLoggerOptions` at construction (not `IOptionsMonitor<T>`). Changing `RetentionDays` or `ChannelCapacity` requires a host restart. Hot-reload would mean restarting the writer task on options change (channel must be re-created at a new capacity; retention sweep must re-run with the new window), which adds non-trivial state-machine complexity for a config surface no PRism deployment currently uses.
- **Revisit when:** A deployment scenario emerges that warrants dynamic config — e.g., a hosted multi-tenant setting where retention is per-tenant configurable. Out of PoC scope.

### [Defer] Flush-batching for throughput

- **Source:** Brainstorm 2026-05-18 (design § 6 — flush cadence).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** v1 calls `FlushAsync()` after every event. The trade is "host crash loses at most the in-flight event" (good) vs throughput (bounded by the disk's `fsync` rate). At PRism's single-user PoC event rate (dominated by 2-5 events/s under steady load) the per-event flush is invisible; under a debug-flood the channel drops (capacity 1024) before flush latency becomes the bottleneck. Batching (e.g., flush every N events or every T ms) would protect throughput on a debug-flood but lose more events on crash.
- **Revisit when:** Dogfooding measures the per-event flush as the dominant latency on a real workload, OR a future deployment scenario has a sustained event rate where the channel fills before the flush completes.

### [Defer] Serilog (or NLog) with a destructuring policy / filter enricher

- **Source:** ce-doc-review pass 1 (PL-3, PL-5, ADV-8 — three personas agree this alternative was not considered in the original draft).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** `Serilog.Sinks.File` + a `Filter.With<IEventFilter>` enricher would implement the field-name redaction in ~50 LOC of config and inherit Serilog's mature rolling / retention / shared-read behavior. Rejected because (i) PRism has zero third-party logging dependencies today and the "minimum new dependencies" discipline is asserted across the architectural-readiness doc; (ii) Serilog's enricher contract differs in shape from `SensitiveFieldScrubber`, so adopting Serilog means either keeping our scrubber plus writing a Serilog adapter (two abstractions doing the same job) or replacing the scrubber entirely and breaking `PrDraftsDiscardAllEndpoint.cs:97`. Documented at design § 1.2 alternative (b).
- **Revisit when:** Maintenance trade flips — e.g., the slice grows to need NDJSON + size-based rotation + scope dispatch simultaneously, at which point Serilog's mature feature set may dominate the hand-written sink + parser + retention sweep.

### [Defer] `run.ps1` `Tee-Object` to file (zero in-process code)

- **Source:** ce-doc-review pass 1 (ADV-8).
- **Severity:** P4 (advisory; never going to land but worth recording).
- **Date:** 2026-05-18.
- **Reason:** Modifying `run.ps1` to `.\Program.exe | Tee-Object -FilePath logs\prism-$(Get-Date -F yyyy-MM-dd).log` solves the load-bearing case ("user closed run.ps1, diagnostic is gone") for free, zero code. Rejected at design § 1.2 alternative (c) because (i) `run.ps1` is the developer-launch path only — `dotnet run`, IDE, Playwright, CI all bypass it; (ii) redaction can't be added at the tee layer without forking the console formatter into PowerShell post-processing; (iii) console formatter output strips structured-arg keys, so the field-name scrub the slice depends on becomes impossible to perform at this layer.
- **Revisit when:** N/A — alternative is structurally inferior for the cases the slice actually targets.

### [Defer] Playwright env-var hook for opt-in file-sink under Test environment

- **Source:** ce-doc-review pass 1 — surfaced by FEAS-2 / ADV-6 mitigation.
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** v1 gates `Program.cs` file-sink registration on `!IsEnvironment("Test")` to sidestep 111 × `WebApplicationFactory` instances × parallel xUnit workers × 2-second drain budget. Playwright real-flow specs (`PRISM_E2E_REAL_INJECT=1`) also run under `ASPNETCORE_ENVIRONMENT=Test` and therefore lose backend log capture during real-flow incidents. The fix is small: extend the gate to `!IsEnvironment("Test") || Env("PRism__FileSink__ForceEnable") == "1"` and have `playwright.real.config.ts` set the env var. v1 leaves it unwired; the integration tests in § 8.3 already opt in via explicit DI registration with `Guid`-named temp DataDirs (no env-var needed there).
- **Revisit when:** A real-flow Playwright incident requires backend log capture that the production stdout isn't sufficient for. The fix is a one-line gate extension + a `playwright.real.config.ts` env-var line.

### [Defer] Dedicated stderr-replacement self-diagnostic file

- **Source:** ce-doc-review pass 1 (ADV-7).
- **Severity:** P3 (forward-looking defensive).
- **Date:** 2026-05-18.
- **Reason:** v1's writer-task self-diagnostics (write failures, retention failures, parser failures) go to `Console.Error.WriteLine`. The recursion-safety claim ("the writer task never calls ILogger") depends on no provider capturing stderr. PRism today registers Console + Debug + File providers; none capture stderr. A future provider that does (e.g., Application Insights agent, container log-driver injection, OpenTelemetry stderr-tailer) would reintroduce the recursion the spec defends against. The clean fix is a dedicated `<dataDir>/logs/prism-selfdiag.log` FileStream that the writer task writes to directly, no ILogger involvement. v1 accepts the risk on the basis that the current architecture has no stderr-capturing provider and adding one is a non-trivial future change that would surface this concern explicitly.
- **Revisit when:** A new `ILoggerProvider` is registered that captures stderr, OR a real recursion incident is reported.

### [Defer] Cross-process log aggregation

- **Source:** Brainstorm 2026-05-18 (design § 2 non-goals).
- **Severity:** P4 (advisory).
- **Date:** 2026-05-18.
- **Reason:** PRism's `LockfileManager.Acquire` already guarantees one PRism.Web process per data directory; multi-process aggregation isn't a concern. The slice's `FileStream(FileMode.Append, FileAccess.Write, FileShare.Read)` allows a *reader* in another process (e.g., `Get-Content -Wait`) but not a second writer.
- **Revisit when:** N/A unless the single-process invariant is lifted (which would be a much bigger architectural shift than this slice).

---

## Forward-looking residual risks

Items the implementer should keep an eye on. Not deferred decisions — known hazards the spec can't pre-empt.

### [Risk] PR #55 log delegates touch live identifiers via `body` / `responseBody` arg names

- **Source:** Brainstorm 2026-05-18 (design § 12.6).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** PR #55 added `s_graphqlSubmitFailed`, `s_graphqlReadFailed`, `s_graphqlTransportFailed`, `s_graphqlSubmitNoData` in `PRism.GitHub/GitHubReviewService*.cs`. These delegates accept an error-body string (truncated to 1024 chars). The body may contain GitHub-supplied identifiers — PR numbers, commit SHAs, comment IDs. None of these are PRism's blocked field names. A future GitHub error-format change could include `login`-shape strings (a username inside an error message) or even PAT-shape strings (extremely unlikely but not impossible — e.g., a GitHub bug echoing the auth header into an error response). The slice's scrub-by-field-name approach would *not* catch these because the body lands in a structured arg conventionally named `body` or `responseBody`, both of which the existing P2.8 carve-out explicitly keeps unredacted for debuggability.
- **Mitigation in v1:** None code-side. The trade — body redaction vs body debuggability — was made in spec § 6.2 P2.8 (S3 PR5) and is honoured here.
- **Revisit when:** A real incident surfaces a leak through `body` / `responseBody`, OR the regex-based exception-message scrub (deferred above) lands and the body scrub becomes part of the same pass.

### [Risk] `LogTemplateFormatter` parser surface area

- **Source:** Brainstorm 2026-05-18 (design § 12.3).
- **Severity:** P2 (testing scope).
- **Date:** 2026-05-18.
- **Reason:** The M.E.Logging template grammar (`{Name}`, `{Name:format}`, `{Name,alignment}`, `{Name,alignment:format}`, `{{`, `}}`) is documented but the parser must handle every edge case the framework's own formatter handles, otherwise a PRism log line that formats correctly in console output could format wrong in the file. The spec § 8.2 test suite enumerates the cases. The implementation MAY internally delegate to `string.Format` with a positional re-map (named → indexed via dictionary key ordering) to lean on the BCL's well-tested format engine; the test contract stays the same either way.
- **Mitigation:** `LogTemplateFormatterTests` is exhaustive on the documented grammar. Add a regression test for any new case found during implementation.
- **Revisit when:** A PRism log site uses a template feature the parser doesn't handle, OR `LoggerMessage.Define`'s source-gen output starts producing template features the parser doesn't recognise (unlikely without a `Microsoft.Extensions.Logging` major-version bump).

### [Risk] Drain-timeout-on-shutdown elides events on a slow disk

- **Source:** Brainstorm 2026-05-18 (design § 12.4).
- **Severity:** P3.
- **Date:** 2026-05-18.
- **Reason:** The 2-second drain timeout on `Dispose` means a slow disk could leave the tail of the channel un-persisted. Accepted: 2s is generous for the steady-state flow; a sustained-2s-flush per event would indicate disk-level pathology where the broader system has bigger problems. The dropped-count and write-failure counters surface the symptom in the shutdown stderr summary.
- **Mitigation:** Test `Shutdown_FlushesPendingEvents_BeforeStreamClose` pins the contract under fast-disk conditions. A slow-disk regression would surface as a test failure under CI when the runner happens to be slow — at which point the timeout would be re-evaluated.
- **Revisit when:** A CI run flakes on the shutdown-drain test, OR a real-incident report mentions "shutdown lost my last few log lines."

---

### [Risk] Session-start line emits processId + assembly version — both travel off-machine when log excerpts are shared in a `gh issue`

- **Source:** ce-doc-review pass 2 (SEC-6).
- **Severity:** P3 (informational).
- **Date:** 2026-05-18.
- **Reason:** `EmitSessionStartLine` writes `session started, processId=<N>, version=<assembly version>` as the first event in each file. The processId is per-run and harmless in isolation but is a correlation key against OS-level audit logs (Windows Security Event Log, ETW) for any reader who has them. The version string is a fingerprinting signal — an attacker who knows a specific build has a known vulnerability can target users who pasted version-tagged log excerpts. Both fields land in any `gh issue` body when a user pastes log lines, leaving the user's machine. Neither is PII in the classic sense; both are system metadata.
- **Mitigation in v1:** None code-side. The risk only materializes on voluntary log-sharing, and the diagnostic value (which build was running, which process) outweighs the redaction value at the current threat model. Captured here so a future contributor doesn't add hostname / username / directory paths to the session-start line without security review.
- **Revisit when:** A future site adds machine-identifying fields to the session-start line, OR a real incident demonstrates the version-fingerprinting risk.

### [Risk] `FileLoggerConstants.RetentionDays` is compile-time — no operational path to lower retention in a security-hardening sweep

- **Source:** ce-doc-review pass 2 (SEC-7).
- **Severity:** P3 (informational).
- **Date:** 2026-05-18.
- **Reason:** § 4.5 uses compile-time constants (`RetentionDays = 14`). If a future audit concludes the 14-day window represents unnecessary retention of diagnostic data (GitHub usernames, PR identifiers — all in the carve-out per § 6.2), the corrective action requires editing source, building, and shipping a new binary. The "hot-reload of file-sink constants" deferral (§ 11) frames this as a config-convenience concern; the security framing was not previously named. For a PoC with one developer, the trade is fine; the constraint is acknowledged here so a future security reviewer is not surprised.
- **Mitigation in v1:** None — the compile-time approach is the deliberate choice. PRism's release cadence makes a recompile-to-reduce-retention realistic.
- **Revisit when:** A security audit concludes 14 days is too long for the data category, OR a deployment scenario emerges where retention is per-tenant configurable.

## Considered alternatives, decided not to apply

### [Decision considered, not applied] Regex-over-formatter scrub instead of structured-arg redaction

- **Source:** ce-doc-review pass 1 (PL-3, PL-5).
- **Severity:** Decision noted, not deferred.
- **Date:** 2026-05-18.
- **Alternative:** Call `formatter(state, exception)` directly (matching what every other provider receives), then run a regex pass over the formatted string to redact PAT-shape and blocked-field-name patterns (e.g., `Regex.Replace($"(?<=\\b(pat|token|login)\\s*[=:]\\s*)\\S+", "[REDACTED]")`). Estimated ~50 LOC vs the chosen path's ~200 LOC of formatter + scrubber-split + tests.
- **Why rejected:** (i) Loses by-name precision — substring matches like `pat` inside `compat` trigger redaction; word-boundary regex helps but is fragile against new blocked field names. (ii) The console formatter's output is implementation-defined; if M.E.Logging changes how it serializes structured args (e.g., switches the `key: value` separator), the regex breaks silently. (iii) The chosen `string.Format` positional re-map path is comparable in LOC once you count the tests both paths need. (iv) Future scope-dispatch / NDJSON deferrals are easier to extend from the structured-arg path than from the regex path.
- **Revisit when:** N/A — the structured-arg path's precision is the design's load-bearing property. Only revisit if a real maintenance pain emerges from the formatter abstraction.

### [Decision considered, not applied] Adding an operator-flow acceptance check to § 14

- **Source:** ce-doc-review pass 1 (PL-2).
- **Severity:** Decision noted, not deferred.
- **Date:** 2026-05-18.
- **Alternative:** Add an acceptance criterion that requires "take a known-failure run, close the terminal, then have a teammate use only the .log file to identify the failure cause without re-running" as part of slice completion.
- **Why rejected:** The post-mortem flow is implicit in the slice's goal; making it a binding acceptance test would gate the slice on a hypothetical second-engineer-on-the-team scenario PRism doesn't have. The session-start marker (ADV-9, applied) + the integration test's redaction assertion are the actionable parts of the same concern. If a real second-engineer triage incident shows the file is unreadable, that's the trigger to revisit — same shape as the other deferrals.
- **Revisit when:** A teammate joins PRism development and a real incident triage exercises this path.

### [Decision considered, not applied] Premise re-evidencing — naming a second concrete failure mode

- **Source:** ce-doc-review pass 1 (PL-1).
- **Severity:** Decision noted, not deferred.
- **Date:** 2026-05-18.
- **Alternative:** Defer the slice until a second concrete incident (besides PR #55) demonstrates the absence of on-disk logs blocked diagnosis, per the original S5 deferral's "Revisit when: next time a user reports a failure that needs server-side diagnosis."
- **Why rejected:** The user is the sole engineer and triggered this slice intentionally; the work was scheduled as part of the post-S6-PR0 cleanup window. PR #55 IS one concrete instance — the spec doesn't lean on "this happens recurrently" but on "when it happens we want the data." The premise hold under that framing. Recording the choice so future readers see the decision wasn't unexamined.
- **Revisit when:** N/A.

## How this doc evolves

When a deferred item is implemented, strike its `## [Defer]` heading and add a closing rationale + landing-PR reference. New deferrals from `ce-doc-review`, planning, or implementation passes append under the matching section. Don't delete entries — the temporal record is the value.

The applied design lives in [`2026-05-18-on-disk-log-writer-design.md`](2026-05-18-on-disk-log-writer-design.md) § 11; this sidecar is the durable per-decision record for the entries listed there.
