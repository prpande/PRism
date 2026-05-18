---
source-doc: docs/specs/2026-05-18-on-disk-log-writer-design.md
created: 2026-05-18
last-updated: 2026-05-18
status: open
revisions:
  - 2026-05-18: brainstorm pass — initial deferrals from the design session (universal decorator, size-based rotation, NDJSON, scope dispatch, exception-message regex, hot-reload, flush-batching). Source-of-truth for each entry is the design doc § 11.
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

## How this doc evolves

When a deferred item is implemented, strike its `## [Defer]` heading and add a closing rationale + landing-PR reference. New deferrals from `ce-doc-review`, planning, or implementation passes append under the matching section. Don't delete entries — the temporal record is the value.

The applied design lives in [`2026-05-18-on-disk-log-writer-design.md`](2026-05-18-on-disk-log-writer-design.md) § 11; this sidecar is the durable per-decision record for the entries listed there.
