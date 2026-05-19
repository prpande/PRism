---
status: Drafted
related_deferral: docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:944
worktree: ../prism-stale-oid (branch feat/stale-oid-banner)
---

# Stale-OID SSE/Reload-banner investigation — design

## 1. Frame

`s5-real-stale-commit-oid.spec.ts` is `test.skip`ed in `frontend/e2e/real/`. The Reload-PR banner never surfaces after `createCommitOnBranch` advances the fixture branch head, even at a 150s budget. Three of four real-flow specs ship and pass; this spec is the carry-forward of the deferral entry naming this failure.

This is an **investigation-led** spec. The spec does NOT commit to a fix. It captures: the diagnostic instrument needed to disambiguate three hypotheses (one production, two infra/timing); the methodology for capturing and reading the evidence; sketch-level fix branches per hypothesis; the test coverage shape per branch; and the un-skip mechanics.

After the spec PR merges, a separate investigation run produces a finding artifact at `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md` (this spec defines its required structure). `writing-plans` consumes the finding + the matching sketch in this spec; the fix lands in a per-hypothesis follow-up PR.

## 2. Scope

**In scope:**
- An `Information`-level diagnostic log delegate in `PRism.Core/PrDetail/ActivePrPoller.cs` capturing per-poll snapshot data.
- Two `Information`-level diagnostic log delegates in `PRism.Web/Sse/SseChannel.cs`: one for `OnActivePrUpdated` fan-out intent (Section 3.2), one for per-subscriber WriteAsync delivery outcome (Section 3.3).
- Investigation methodology — runbook, prediction, boundary map, disambiguation decision tree.
- Three hypotheses + per-hypothesis sketch-level fix branches.
- Test coverage matrix.
- Un-skip plan + budget bump mechanics (the harness changes carrying the un-skip in the per-hypothesis fix PR).
- Finding artifact specification.

**Out of scope:**
- The fix itself. Picked by the investigation outcome; designed by `writing-plans` over the finding + winning sketch.
- `ActivePrPoller._state` and `ActivePrCache` cleanup policies (orthogonal singleton-grows-forever concern).
- Any SSE channel architecture rework.
- Production-deployment concerns (PoC scope).

## 3. Diagnostic instrumentation

### 3.1 `ActivePrPoller` per-poll snapshot log

**Location:** `PRism.Core/PrDetail/ActivePrPoller.cs`. New `LoggerMessage.Define`-backed delegate alongside the existing `s_pollFailedLog` and `s_tickFailedLog` declarations near the bottom of the class.

**Signature:**

```csharp
private static readonly Action<ILogger, PrReference, string, string?, bool, bool, bool, Exception?> s_pollSnapshotLog =
    LoggerMessage.Define<PrReference, string, string?, bool, bool, bool>(
        LogLevel.Information,
        new EventId(3, "ActivePrPollSnapshot"),
        "Active-PR poll snapshot {PrRef}: head={HeadSha} prevHead={PrevHeadSha} firstPoll={FirstPoll} headChanged={HeadChanged} commentChanged={CommentChanged}");
```

**Call site:** in `TickAsync` (current code around line 127), emit immediately AFTER `firstPoll`/`headChanged`/`commentChanged` are computed and BEFORE the `_bus.Publish(new ActivePrUpdated(...))` branch. The log captures the exact state the poll-cycle decision was based on. Parameters: `prRef`, `snapshot.HeadSha`, `state.LastHeadSha` (still pre-update at this point), `firstPoll`, `headChanged`, `commentChanged`. Wrap in a non-trapping try/catch only if PRism's `LoggerMessage`-pattern existing usages do — verify by reading `s_pollFailedLog` call site convention.

**Log-level rationale:** `Information`, not `Debug`. The on-disk logger from PR #63 writes Information+ to file under the standard config; choosing Debug would require an investigation-time env edit that future readers might miss. Cost is one structured-log emit per active PR per poll-cycle; at production cadence 30s that is ~2880 lines/day/PR, ~50KB/day/PR — bounded by PR #63's 14-day retention sweep.

### 3.2 `SseChannel` fan-out log

**Location:** `PRism.Web/Sse/SseChannel.cs`. The `OnActivePrUpdated` handler at line 238 (the fan-out entry point for `ActivePrUpdated` events) gains a structured log emit before delivering to subscribers.

**Signature:**

```csharp
private static readonly Action<ILogger, string, PrReference, int, bool, bool, Exception?> s_sseActivePrFanoutLog =
    LoggerMessage.Define<string, PrReference, int, bool, bool>(
        LogLevel.Information,
        new EventId(4, "SseActivePrFanout"),
        "SSE fan-out {EventType} {PrRef}: subscribers={SubscriberCount} headShaChanged={HeadShaChanged} commentCountChanged={CommentCountChanged}");
```

**Call site:** at the top of `OnActivePrUpdated(ActivePrUpdated evt)` (line 238), before the per-subscriber WriteAsync loop. `SubscriberCount` is `_activeRegistry.SubscribersFor(evt.PrRef).Count` (or the equivalent `Count`-friendly accessor — verify by reading the existing fan-out code; if `SubscribersFor` returns a freshly-allocated `IReadOnlyCollection<string>`, prefer a one-time `.Count` rather than enumerating twice).

**Redaction:** `PrReference`, `HeadSha`, and event type strings are not in `SensitiveFieldScrubber`'s blocklist (verify when writing the implementation against `ScrubFieldName` config from PR #61). All log fields safe to emit unscrubbed.

**Removal policy:** both delegates are PERMANENT. They serve the broader "did the SSE pipeline behave correctly?" question, not just this investigation. The spec explicitly does NOT promise a revert.

### 3.3 `SseChannel` per-subscriber write outcome log

**Why a second delegate:** the Section 3.2 delegate fires inside `OnActivePrUpdated` BEFORE the per-subscriber `WriteAndEvictOnFailureAsync` loop. It captures intent-to-deliver, not delivered. The decision tree at Section 4.4 needs to distinguish "event reached the socket" from "event reached the page handler" (boundaries 5 vs 6). Without a second delegate, the eviction path (write-failure / cancellation / 5s write timeout) silently demotes the subscriber count without surfacing in the log — boundary 5 looks success-shaped even when subscribers missed the event.

**Location:** `PRism.Web/Sse/SseChannel.cs`, inside or adjacent to the existing `WriteAndEvictOnFailureAsync` (locate exact line during implementation — verify the success-path call site and the eviction call site so the delegate covers both).

**Signature:**

```csharp
private static readonly Action<ILogger, string, PrReference, string, bool, Exception?> s_sseActivePrDeliveryLog =
    LoggerMessage.Define<string, PrReference, string, bool>(
        LogLevel.Information,
        new EventId(5, "SseActivePrDelivery"),
        "SSE delivery {EventType} {PrRef} subscriber={SubscriberId} success={Success}");
```

**Call sites:** one on successful WriteAsync completion (Success=true), one on the eviction path (Success=false). The existing `s_writeFailedLog` (LogLevel.Debug) does not satisfy this — the on-disk logger from PR #63 filters Debug under the standard config, so the failure side is invisible to the investigation methodology.

### 3.4 Diagnostic-capture environment gate (precondition for the methodology)

**Critical precondition:** `PRism.Web/Logging/FileLoggerExtensions.cs:24` early-returns when `env.IsEnvironment("Test")` is true (preventing xUnit WebApplicationFactory tests from spinning up 100+ writer tasks against temp DataDirs). `frontend/playwright.real.config.ts:27` sets `ASPNETCORE_ENVIRONMENT='Test'` for the real-flow webServer process. **Under the runbook as written without intervention, the on-disk logger is silently disabled and Sections 3.1–3.3's delegates emit only to Console — they do NOT reach the `<DataDir>/logs/` file the investigation methodology promises.**

**Resolution — chosen approach (revised in ce-doc-review round 2):** lift the `FileLoggerExtensions` Test-env gate behind a new env var. The diagnostic-instrumentation PR makes a one-line production-code change:

```csharp
// Before (FileLoggerExtensions.cs:22-24):
public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir, IHostEnvironment env)
{
    if (env.IsEnvironment("Test")) return builder;

// After:
public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir, IHostEnvironment env)
{
    if (env.IsEnvironment("Test")
        && Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE") != "1")
        return builder;
```

`frontend/playwright.real.config.ts` sets `PRISM_FILE_LOGGER_FORCE=1` in the webServer env block. xUnit `WebApplicationFactory<Program>`-based tests don't set this env var, so they remain protected by the original gate. The on-disk `FileLoggerProvider` writes to `<DataDir>/logs/prism-yyyy-MM-dd.log` (per PR #63) under real-flow runs, with structured fields, drain semantics, and SensitiveFieldScrubber redaction.

**Why this approach over stdout-redirect:** round-1 originally chose to redirect backend stdout to a file because it appeared "purely test-harness, no production code change." ce-doc-review round 2 surfaced five distinct gotchas with the stdout approach: (1) Playwright `webServer.stdout: 'pipe'` does not expose a programmatic stream API — redirection has to embed in the command string, with cross-shell hazards on Windows PowerShell vs bash; (2) the default ASP.NET Console formatter emits two physical lines per log record, breaking line-per-record parsing assumptions; (3) Console logging has lossy shutdown semantics — log entries queued in `ConsoleLoggerProcessor` are dropped on abnormal backend exit, exactly the failure mode the methodology is designed to disambiguate; (4) stdout output bypasses `SensitiveFieldScrubber` because the scrubber is invoked only by `FileLoggerProvider`, not by `ConsoleLoggerProvider` — `AuthEndpoints.cs` Information-level `Login` field would emit unscrubbed PII to the captured file; (5) Playwright's existing `stdout: 'pipe'` consumes the stream for its reporter — replacing it conflicts with Playwright's webServer readiness contract. The FileLoggerProvider gate-lift addresses all five with a one-line `||` extension to an existing env-gate.

**Alternative considered (and rejected):** the stdout-redirect approach described above. Rejected per round-2 evidence.

**Implementation note for `writing-plans`:** the FileLoggerExtensions one-line change ships as part of the diagnostic-instrumentation PR (alongside the three log delegates and the playwright config env-var add). Without both, the runbook's "snapshot the on-disk log file" step has nothing to snapshot.

## 4. Investigation methodology (systematic-debugging four-phase)

### 4.1 Phase 1 — Reproduce-and-instrument runbook

1. From the worktree, locally edit `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:45` — change `test.skip` to `test`. **Do NOT commit this edit.** The un-skip ships only in the per-hypothesis fix PR, not the investigation PR.
2. The diagnostic-instrumentation PR sets `PRISM_FILE_LOGGER_FORCE=1` in `playwright.real.config.ts`'s webServer env block. With the round-2 production-code change to `FileLoggerExtensions.cs` (Section 3.4), the on-disk `FileLoggerProvider` activates under the real-flow Test env and writes structured events to `<DataDir>/logs/prism-yyyy-MM-dd.log`. `<DataDir>` is set by `playwright.real.config.ts:30` to `os.tmpdir()/PRism-e2e-real-${Date.now()}`. The runbook captures this path from the Playwright stdout banner at test start.
3. Run `npx playwright test --config=playwright.real.config.ts --grep "stale commit"` from `frontend/`. The on-disk logger writes per-poll snapshot lines and per-subscriber delivery lines to the log file under `<DataDir>/logs/`.
4. In a parallel shell, run `gh api repos/prpande/prism-sandbox/pulls/<staleFixturePrNumber>` at five points post-advanceHead (30s / 60s / 90s / 120s / 150s after the spec hits the advanceHead call). Save the `head.sha` field + timestamp from each response (NOT the full body — per Section 9.1, full responses contain `user.login` PII).

   **Measurement-contaminates-treatment caveat (ce-doc-review round 2):** each `gh api repos/.../pulls/{n}` snapshot probes the same REST endpoint that the courtesy poke (Section 6.1's `pokePrRestRecord`) targets and that the poller (`GitHubReviewService.cs:455 PollActivePrAsync`) reads. If the poke-or-snapshot has any acceleration effect on the PR-record cache, the boundary-1 measurements ARE candidate pokes. The investigator cannot strictly distinguish "GitHub propagated organically within budget" from "operator's measurement forced propagation." Mitigation: include a CONTROL run (no `advanceHead`, parallel `gh api` snapshots at the same cadence) so the operator can establish baseline cache-stability for `prpande/prism-sandbox`. If the control runs show identical `head.sha` across all five snapshots, propagation acceleration from the snapshot reads is unlikely; if not, treat boundary-1 as soft evidence.
5. After the test fails at the 30s `expect(reloadBanner).toBeVisible(...)` wait, snapshot three artifacts:
   - The on-disk log file at `<DataDir>/logs/prism-yyyy-MM-dd.log` (with the three new delegates emitting structured lines, redacted by `SensitiveFieldScrubber`).
   - The Playwright trace zip (anchors the exact `advanceHead` timestamp).
   - The five `gh api` response excerpts (timestamp + head.sha only).
6. **Repeat steps 2–5 for at least THREE independent runs.** A single run can misclassify intermittent failures.

   **Operationalization of "consistent across three runs" (round 2):** consistency is defined per-hypothesis. For H1: all three runs show `head=SHA-A` for ALL ticks AND no run's final tick reaches `head=SHA-B`. For H2: all three runs contain a tick with `head=SHA-B firstPoll=true` post-advanceHead. For H3: all three runs show `SubscriberCount=0` OR `Success=false` OR missing-trace at the head-change tick. If runs disagree on which signature dominates, classify as "intermittent — re-run with finer-grained instrumentation" per Section 10.2 and produce a follow-up investigation-2 spec.

   **SubscriberId → Playwright-tab mapping (round 2):** the `s_sseActivePrDeliveryLog` captures `SubscriberId`. The active Playwright tab's `SubscriberId` is observable from the Playwright trace's network panel — the `subscriber-assigned` SSE frame carries it. Cross-reference the trace's `subscriber-assigned` payload against the boundary-5b log lines to identify whether the head-change delivery reached the LIVE tab's subscriber or an orphan from a prior `page.goto` remount. This matters at decision tree step 3 / step 4: a successful delivery to an orphan that the live tab missed is still H3, not H4.

The test config sets `PRISM_POLLER_CADENCE_SECONDS=1` (`playwright.real.config.ts:31`), so the poller ticks every 1s — ~150 `s_pollSnapshotLog` lines per fixture PR per 150s budget. Each `_bus.Publish(ActivePrUpdated)` produces one `s_sseActivePrFanoutLog` line, and each per-subscriber WriteAsync produces one `s_sseActivePrDeliveryLog` line.

### 4.2 Phase 1 — Pre-investigation prediction (write BEFORE reading logs)

Desk-analysis priors based on reading `ActivePrPoller.cs`, `s5-real-stale-commit-oid.spec.ts`, and `useEventSource.tsx`:

- **H1 most likely (~70% prior).** The spec sequence (`page.goto` at lines 48, 54, 77 → mount, subscribe, first poll at t≈1s captures `SHA-A`) establishes `state.LastHeadSha=SHA-A` ~80s before `advanceHead` at line 98. The only way the second poll fails to detect `SHA-B` is if GitHub's `pulls/{n}` record hasn't reflected the branch-ref update. Free-tier sandbox propagation can exceed 150s.
- **H2 unlikely (~10% prior).** Would require `state.LastHeadSha=null` at a poll AFTER `advanceHead`. `_state[prRef]` is never cleared in code (only `GetOrAdd` writes; no `Remove`). The only way the field is null after t≈1s is if `_state[prRef]` was never written — contradicts the observed first-poll path.
- **H3 unlikely (~20% prior).** Would require a publish-during-rebind race. The last `page.goto` (line 77) completes ~21s before `advanceHead`; the EventSource and subscriber registration are stable at the moment the head-change event publishes.

**Record this prediction in the finding artifact (Section 9.4 of this spec) BEFORE reading the captured logs.** If logs contradict the prediction, that's information about something the desk analysis missed.

### 4.3 Phase 1 — Component-boundary evidence map

Six boundaries from "GitHub publishes a new commit" to "user sees a Reload banner". Each row maps to one evidence source and answers one question.

| # | Boundary | Evidence source | Question |
|---|----------|-----------------|----------|
| 1 | GitHub PR record (REST `pulls/{n}`) | Manual `gh api` snapshots at 30/60/90/120/150s | Does `head.sha` update reflect `SHA-B` within budget? |
| 2 | `PollActivePrAsync` returns to `TickAsync` | `s_pollSnapshotLog` line — `HeadSha` field | Does `snapshot.HeadSha` flip from `SHA-A` to `SHA-B`? |
| 3 | `state.LastHeadSha` at decision time | `s_pollSnapshotLog` line — `PrevHeadSha` field | Was `PrevHeadSha` non-null and `!= snapshot.HeadSha`? |
| 4 | `_bus.Publish(new ActivePrUpdated(...))` | `s_pollSnapshotLog` `HeadChanged=true` line implies publish | Did the publish happen with `HeadShaChanged=true`? |
| 5a | `SseChannel.OnActivePrUpdated` intent-to-deliver | `s_sseActivePrFanoutLog` line — `SubscriberCount` field | How many subscribers were on the registry at publish time? |
| 5b | `SseChannel` per-subscriber WriteAsync outcome | `s_sseActivePrDeliveryLog` line — `Success` field | Did the write actually reach the socket without eviction? |
| 6 | Frontend `useActivePrUpdates` handler | Playwright trace network frames (EventSource `data:` events) — see note below | Did the `pr-updated` event arrive in the page's `pr-updated` listener? |

**Boundary 6 evidence note:** browser-side instrumentation (a structured log emitted from `useActivePrUpdates.ts:29`'s `pr-updated` listener) is OUT OF SCOPE for the investigation PR. The boundary-6 evidence source is Playwright's trace zip — specifically, the EventSource SSE frames recorded in the network panel. If the boundary 5b log shows `Success=true` for the relevant subscriber but the Playwright trace network panel does not show the `data:` frame reaching the browser, that's enough to confirm a delivery gap (H3 or H4 territory). If the frame IS in the trace but no React state mutation follows, that's H4 (see Section 5.4). Future iterations may add a frontend instrumentation hook; not in scope for this spec.

### 4.4 Phase 1 — Per-hypothesis disambiguation signals + decision tree

**H1 confirmed if:**
- Boundary 2: `s_pollSnapshotLog` shows `head=SHA-A` for ALL ticks after `advanceHead` until either (a) eventual flip to `head=SHA-B` (lag bounded) or (b) end-of-capture without flip (lag exceeds 150s budget).
- Boundaries 3–6 all consistent (no event ever published).
- Cross-check: at least one of the five `gh api` snapshots returns `head.sha = SHA-A` at the timestamp matching the capture-end.

**H2 confirmed if:**
- Boundary 2: a tick AFTER `advanceHead` shows `head=SHA-B firstPoll=true prevHead=null headChanged=false`.
- Means `_state[prRef]` was empty at the moment the new head was first observed. Surprising — investigate WHY (race in BackgroundService start? Dict cleared by something not visible in current code reading?).

**H3 confirmed if:**
- Boundary 2: shows `head=SHA-B headChanged=true` (state.LastHeadSha was `SHA-A`).
- Boundary 4 implied by Boundary 2's `headChanged=true`.
- Boundary 5a: `s_sseActivePrFanoutLog` line shows `SubscriberCount=0` for that fan-out, OR shows `SubscriberCount>0` but boundary 5b's `s_sseActivePrDeliveryLog` shows `Success=false` for the relevant subscriber, OR shows `Success=true` but the Playwright trace network frames don't include the corresponding `data:` event.

**H4 confirmed if** (defined positively, not as fallback — see Section 5.4):
- Boundaries 2/4/5a/5b all consistent (event published, fan-out had subscribers, write succeeded), Playwright trace network frames show the `data:` event reached the browser, BUT no React state update follows.

**Decision tree:**
1. Does Boundary 2 ever show `head=SHA-B`? — NO → **H1**. — YES → step 2.
2. Does Boundary 2 show `firstPoll=true` at the same line? — YES → **H2** (including the backoff-recovery variant in Section 5.2). — NO → step 3.
3. Does Boundary 5a show `SubscriberCount=0`, OR boundary 5b show `Success=false`, OR Playwright trace show no `data:` event for the relevant tick? — YES → **H3**. — NO → step 4.
4. All boundary-2 / 4 / 5a / 5b evidence consistent + Playwright trace shows `data:` arrived + banner still missing → **H4 (frontend mount-race / handler)**. See Section 5.4 for the positive signature.

### 4.5 Phase 2 — Pattern analysis (working SSE flows as baseline)

Working SSE flows in PRism today:
- `submit-progress` events — successfully delivered in `s5-real-happy-path.spec.ts` and the foreign-pending and lost-response specs. Same SSE channel infrastructure as `pr-updated`.
- `state-changed` / `inbox-updated` — work across all four real-flow specs.
- `pr-updated` for COMMENT-count changes — not exercised by any real-flow spec today; an open coverage gap.

**Implication:** the SSE delivery channel works generally. The bug is specifically in the `pr-updated`/HEAD-change leg, OR in something specific to this leg's publishing flow (not the channel mechanics). The Pattern-2 finding rules out generic SSE-channel issues.

### 4.6 Phase 3 — Minimal test per hypothesis

Each hypothesis test = single variable, single observation:
- **H1 test:** bump the spec's banner-wait budget to 300s and re-run once. If the banner eventually appears, H1 confirmed; the timestamp at which it appeared bounds the actual propagation lag.
- **H2 test:** ruled in or out by Boundary 2 evidence alone (the `s_pollSnapshotLog` line either shows the `firstPoll=true head=SHA-B` signature or it doesn't). No separate code change needed.
- **H3 test:** ruled in or out by Boundary 5 evidence alone. No separate code change needed.

Phase-3 single-variable changes apply only AFTER the initial instrumented capture didn't disambiguate via the decision tree.

### 4.7 Phase 4 — Finding artifact + handoff

When disambiguation completes, write the finding artifact per Section 9 of this spec. Commit as a docs-only PR. Once merged, `writing-plans` runs with the finding + the matching sketch (Section 6 of this spec) as inputs, producing the per-hypothesis implementation plan that lands the fix + un-skip.

## 5. Three hypotheses

### 5.1 H1 — INFRA: GitHub PR record propagation lag

`PollActivePrAsync` (`PRism.GitHub/GitHubReviewService.cs:455`) reads `repos/{owner}/{repo}/pulls/{n}` — the PR record, not the branch ref. `createCommitOnBranch` updates the branch ref synchronously, but GitHub's PR record updates asynchronously. On free-tier sandboxes (`prpande/prism-sandbox`), the lag can exceed 150s.

**Signature in logs:** boundary-2 `head=SHA-A` for ALL post-advanceHead ticks; manual `gh api` snapshots agree.

**Production-code culpability:** none. PRism's poller is reading the documented contract; GitHub's contract has soft consistency on the PR record.

### 5.2 H2 — PRODUCTION: First-poll-after-subscribe loses head delta

`ActivePrPoller.TickAsync` at lines 123–127 computes `firstPoll = state.LastHeadSha is null && state.LastCommentCount is null`. If true, `headChanged` is false regardless of whether the head actually changed since a prior poll. The deferral entry frames this as: "if the spec's first poll for the fixture PR lands AFTER `advanceHead`, the head delta is silently lost."

Under the actual spec sequence, `_state[prRef]` is populated within ~1s of the first `page.goto` (long before `advanceHead`), so the literal H2 frame requires `_state[prRef]` to be empty at a tick AFTER `advanceHead` — which the current code doesn't directly produce.

**However, a backoff-recovery variant IS reachable:** if the FIRST poll attempt for this PR errors out (e.g., a transient 502 from GitHub during sandbox warm-up), `ActivePrPoller.cs:155-159` routes to `ApplyBackoff` without setting `LastHeadSha`/`LastCommentCount`. The backoff sets `NextRetryAt = now + 30s..300s` (lines 172-174) and the state's head fields remain null across the deferral. If `advanceHead` lands during that backoff window, the subsequent successful retry IS the first poll, with `firstPoll=true`, `snapshot.HeadSha=SHA-B`, `headChanged=false`. The `ActivePrUpdated` event publishes with `HeadShaChanged=false NewHeadSha=null`, `BannerRefresh.formatMessage` returns `''` (per BannerRefresh.tsx:55), banner never renders. Same observable outcome as the literal H2; same fix branch applies (Section 6.2 option b — render generic message on head mismatch).

**Signature in logs:** boundary-2 `head=SHA-B firstPoll=true prevHead=null` line at a tick post-advanceHead. The signature is identical for both H2 variants; disambiguation between literal-H2 and backoff-recovery-H2 is informational and not required for the fix (option b fix covers both).

**Production-code culpability:** the literal frame requires a `_state` reset path not visible in the current code; the backoff-recovery variant is reachable today.

### 5.3 H3 — Timing: SSE delivery during subscriberId rebind

The Playwright spec does three `page.goto` calls (lines 48, 54, 77). Each is a full SPA remount → new `EventSource` → new `subscriberId` → fresh subscription. If the head-change `ActivePrUpdated` event publishes between an OLD subscriber being deregistered and the NEW one being registered, the SSE channel has nobody to deliver to.

The spec sequence finishes its last `page.goto` ~21s before `advanceHead`, but the race window is NOT bounded only by `page.goto` distance: `useEventSource.tsx` runs a 35s silence-watchdog (`SILENCE_WATCHER_MS = 35_000` in `events.ts:71`) that fires a reconnect on any 35s gap in heartbeats. Reconnects also fire on EventSource `onerror` (network blip, Kestrel idle eviction, HTTP/2 stream reset, etc.). Each reconnect generates a new subscriberId and re-runs the subscribe POST. If `advanceHead` lands during a reconnect-induced subscribe-rebind window, the head-change event has no subscriber to deliver to.

**Signature in logs:** boundary-5a `SubscriberCount=0` at the head-change fan-out, OR boundary-5b `Success=false` on a write attempt, OR boundary-5b `Success=true` but the Playwright trace network frames show no `data:` event for the tick.

**Production-code culpability:** the SSE fan-out's "deliver to current subscribers" semantic is sound for live subscribers but doesn't handle the "subscriberId in transition" gap. The current diagnostic delegates capture intent (5a) and per-socket delivery (5b); EventSource reconnect events themselves are NOT instrumented in this spec — if logs implicate H3, a follow-up investigation MAY need EventSource open/close/ping logging added to `EventsEndpoints.cs`.

### 5.4 H4 — Frontend mount-race / handler

`useActivePrUpdates.ts:26` calls `setState(initial)` unconditionally inside the useEffect; `useActivePrUpdates.ts:29` attaches the `pr-updated` listener AFTER that reset. On every SPA remount triggered by `page.goto` (lines 48, 54, 77 of the spec), there is a window where: (a) the previous mount's `unsubscribe()` (line 63) has removed the listener, (b) `setState(initial)` has zeroed local state, (c) `stream.on('pr-updated', ...)` has not yet executed on the new mount. If a `pr-updated` event is dispatched during that window, `events.ts:150-160`'s `listeners[type]?.forEach` silently no-ops over the empty listener set — no warning, no React state change, no banner.

**Signature in logs:** boundaries 2/4/5a/5b all green (event published, fan-out had subscribers, write succeeded, `Success=true`), AND Playwright trace network frames show the `data:` event reached the browser, BUT no React state mutation follows the frame timestamp.

**Production-code culpability:** the React effect's ordering — reset BEFORE listener attach — opens a deterministic race for any event publishing during remount. The fix would be either to attach the listener before resetting state, or to dispatch a synthetic refresh after listener attach.

**Sketch added in round 2:** see Section 6.4 for the H4 fix sketch (React effect ordering + listener-pre-attach). The H4 case ships within this spec's planning surface; the deferral can close from H4 evidence per the un-skip mechanics in Section 8.

## 6. Sketch-level fix branches

Each sketch states production-code touchpoints, test-coverage shape, harness changes, and residual risk. No code-level pseudocode — that lives in `writing-plans` for the winning branch.

### 6.1 Branch H1 — INFRA propagation lag

- **Production code:** none.
- **Harness change in `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`:**
  - Line 110 — `timeout: 30_000` → `timeout: 60_000`.
  - Insert a courtesy REST poke between the `advanceHead(...)` call (line 98) and the `reloadBanner` declaration (line 109). **The poke MUST target the same REST endpoint the poller reads (`repos/{owner}/{repo}/pulls/{n}`), NOT GraphQL.** `pokePrRestRecord` in `helpers/gh-sandbox.ts:32-40` is a GraphQL query for `pullRequest.headRefOid` — it touches a different replica set and has no documented mechanism to influence the REST PR-record cache. Add a new helper `pokePrRestRecord(prNumber: number)` in `helpers/gh-sandbox.ts` that invokes `execFileSync('gh', ['api', `repos/${OWNER}/${REPO}/pulls/${prNumber}`])` and discards the result. Extend the spec file's import to include the new helper.
  - The poke is best-effort, not a guarantee — GitHub may cache the REST response per-region; a single GET may or may not invalidate. The spec frames it as "courtesy, possibly speculative" and leans on the 60s budget as the primary fix.
  - Note: this deviates from the brainstorm-time sketch which proposed reusing `getPrHeadOid`. Reviewer-bot caught the GraphQL-vs-REST surface mismatch; the REST helper (`pokePrRestRecord`) is the correct fix.
- **Test coverage:** no new unit tests (no production code change). The un-skipped real-flow spec is the only test.
- **Files touched:** `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` + `frontend/e2e/real/helpers/gh-sandbox.ts` (new `pokePrRestRecord` helper).
- **Residual risk:** if propagation lag exceeds 60s, the spec flakes. Mitigation surfaced in the finding artifact: if 60s flakes >5% during local three-consecutive-passes verification, bump to 90s with an explicit comment citing the H1-branch finding.

### 6.2 Branch H2 — PRODUCTION first-poll-after-subscribe (preferred: option b)

Preferred fix is option (b) from the deferral: change `BannerRefresh` to render a generic "PR has been updated — Reload to view" when `firstPoll && !headShaChanged && !commentChanged && latestHeadSha !== currentHeadSha`. Requires `ActivePrUpdated` events to ALWAYS carry the snapshot's HeadSha.

- **Production-code touchpoints:**
  - `PRism.Core/Events/ActivePrUpdated.cs` — new field `LatestHeadSha` (always populated).
  - `PRism.Core/PrDetail/ActivePrPoller.cs:129–134` — pass `snapshot.HeadSha` unconditionally as `LatestHeadSha`; current `NewHeadSha: headChanged ? snapshot.HeadSha : null` stays as-is for backward compatibility within the event.
  - `frontend/src/api/events.ts:25–30` — `PrUpdatedEvent.latestHeadSha: string`.
  - `frontend/src/hooks/useActivePrUpdates.ts:6–11` and the reducer at lines 31–35 — track `latestHeadSha`.
  - `frontend/src/components/PrDetail/BannerRefresh.tsx:43–62` — new render branch covering the mismatch case.
  - `frontend/src/pages/PrDetailPage.tsx:165–172` — wire `data?.pr.headSha` as the `currentHeadSha` prop and the tracked `latestHeadSha` as a new prop.
- **Alternative (option a from the deferral):** `ActivePrPoller` consults `IActivePrCache` on first poll for a prior head. **Caveat:** `IActivePrCache` is populated by the same poller after each successful tick, so under a normal startup sequence the cache is also empty on first poll. Option (a) only fixes a process-restart scenario, not the spec's failure. Option (b) preferred.
- **Test coverage:** T-H2-1 through T-H2-4 (see Section 7).
- **Residual risk:** schema change to `ActivePrUpdated` and `PrUpdatedEvent`. Minor — both ride within the same PR; no backcompat concerns (single PRism app, single deploy).
- **Backoff-variant budget risk (round 2):** if the backoff-recovery-H2 variant (Section 5.2) is the actual cause, `ActivePrPoller.ApplyBackoff` defers the next poll by 30–300s after the first-poll error. Even with option (b) shipped, the banner-render event is delayed by the backoff interval — potentially exceeding the 60s un-skip budget (Section 8.1). The option (b) fix renders the correct banner when the eventual successful poll arrives, but doesn't shorten the wait. Mitigation: if disambiguation confirms backoff-H2 specifically, the un-skip's banner-wait budget bumps to 120s (vs 60s for the H1 + literal-H2 cases) and an explicit comment cites the backoff interval. A deeper fix (first-error retry-after policy in `ApplyBackoff` itself) is out of scope; the budget bump is the proportional response.

### 6.3 Branch H3 — Reconcile-on-subscribe (preferred)

Preferred fix: when `useActivePrUpdates` POSTs the subscription, immediately fire a one-shot fetch of the PR snapshot and compare the head against the originally-loaded head; treat a mismatch as a synthetic `pr-updated` event.

- **Production-code touchpoints:**
  - `frontend/src/hooks/useActivePrUpdates.ts:41–58` — extend `subscribeLoop`: after the POST resolves, GET `/api/pr/{ref}/active-snapshot`; if the response head differs from initial loaded head, dispatch a synthetic event with `latestHeadSha` set. On 404 or `204 No Content`, take no action (no snapshot yet — wait for first poller tick).
  - New server endpoint in `PRism.Web/Endpoints/` (specific file determined during writing-plans — likely `PrDetailEndpoints.cs` since that's where existing per-PR reads live). Path `/api/pr/{owner}/{repo}/{number:int}/active-snapshot` (matches existing PrDetailEndpoints three-segment shape with `int` constraint on number). Contract is THREE-STATE: 200 with `{ headSha, observedAt }` when subscribed AND cache hit; 204 No Content when subscribed AND cache empty (poller hasn't completed its first tick yet — frontend treats as "wait, don't reconcile"); 404 when not subscribed (`!_subscribers.AnySubscribers(prRef)`). The two-state contract from the brainstorm-time sketch collapsed "subscribed-but-empty" into 404, which the frontend would interpret as "not subscribed" and skip reconciliation entirely — silently re-introducing the bug H3 exists to fix. Reviewer-bot caught this; three states are required.
  - **Auth/origin inheritance (corrected in round 2):** `PrDetailEndpoints.cs` does NOT use `MapGroup` — all existing routes are flat `app.MapGet`/`app.MapPost` registrations on the root `IEndpointRouteBuilder` (verified by reading the file). `SessionTokenMiddleware` is pipeline-global (`SessionTokenMiddleware.cs:59` short-circuits on `Path.StartsWithSegments("/api")` — covering all `/api/*` paths regardless of route group). So the new flat `app.MapGet("/api/pr/{owner}/{repo}/{number:int}/active-snapshot", ...)` inherits session-token enforcement via the pipeline, not via group membership. `OriginCheckMiddleware` covers POST/PUT/PATCH/DELETE only; GET endpoints carry no origin check, but this endpoint is read-only and returns no secrets — CSRF-class concerns don't apply in PoC scope. `writing-plans` registers the endpoint as a sibling flat `MapGet` adjacent to existing `PrDetailEndpoints.MapPrDetail` calls. Do NOT create a `MapGroup` wrapper — that adds positional risk relative to the global middleware pipeline.
- **Alternative (server-side kick):** when the subscription is registered, schedule an out-of-band immediate `PollActivePrAsync` for that PR, racing with the cadence ticker. Slightly increases GitHub API consumption but the kick is bounded (one call per subscribe). Documented but not preferred — reconcile-on-subscribe keeps the GitHub side untouched.
- **Test coverage:** T-H3-1 through T-H3-3 (see Section 7).
- **Residual risk:** the reconcile path doubles subscribe-time HTTP load (one POST + one GET per PR navigation). For PRism's single-active-PR scope, negligible.

### 6.4 Branch H4 — Frontend mount-race (added in round 2)

**Added per ce-doc-review round 2:** Section 5.4 defined H4 as a positively-identifiable hypothesis with concrete log signature. Round 2 also flagged that without an H4 sketch, the spec's "un-skip the test" success criterion is hypothesis-gated — if H4 wins, the deferral stays open. A minimal H4 sketch closes that gap.

Preferred fix: re-order the React effect in `useActivePrUpdates.ts:20-69` so that the `pr-updated` listener attaches BEFORE the `setState(initial)` reset. The minimal-but-correct shape: capture the pending state events, attach listener, then reset only the props-derived state. This guarantees any `pr-updated` event landing during the mount window is captured by the new listener instead of being dispatched into an empty listener set.

- **Production-code touchpoints:**
  - `frontend/src/hooks/useActivePrUpdates.ts:20-69` — move `stream.on('pr-updated', ...)` registration BEFORE `setState(initial)` AND before the subscribeLoop's async POST. Buffer any events that arrive between mount and the POST completing.
- **Alternative:** add a one-shot "missed events" fetch on subscribe — same shape as H3's reconcile-on-subscribe but tagged differently in the finding artifact. If both H3 and H4 fire, prefer the unified reconcile-on-subscribe fix from Section 6.3 (covers both cases).
- **Test coverage:**
  - T-H4-1 (vitest, `frontend/__tests__/hooks/useActivePrUpdates.test.ts`): assert that a `pr-updated` event dispatched during the mount window is captured (use a mocked `EventStreamHandle` that dispatches synchronously inside the mount's effect).
  - T-H4-2 (Playwright real-flow): un-skipped stale-OID spec.
- **Residual risk:** the React effect ordering change is small but touches a hook that's central to the PR detail page. Vitest coverage is the regression net.

### 6.5 Cross-branch invariants

- The un-skip ships in the same PR as the chosen fix.
- The 60s budget bump ships regardless of which branch wins — even H2/H3/H4 fixes inherit the resilience (with the backoff-H2 exception calling for 120s per Section 6.2).
- The diagnostic delegates from Section 3 stay in place; they're not removed by any of the fix branches.

## 7. Test coverage matrix

### 7.1 Tests in the spec PR (ship regardless of investigation outcome)

| ID | Tier | File | Asserts |
|----|------|------|---------|
| T-INV-1 | xUnit | `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs` | `s_pollSnapshotLog` fires exactly once per successful `PollActivePrAsync` per PR per tick; structured fields populated correctly (PrRef, HeadSha, PrevHeadSha, FirstPoll, HeadChanged, CommentChanged). |
| T-INV-2 | xUnit | same file | First tick after subscribe: `FirstPoll=true`, `PrevHeadSha=null`, `HeadChanged=false`. |
| T-INV-3 | xUnit | same file | Second tick when snapshot.HeadSha differs from state: `FirstPoll=false`, `PrevHeadSha=<SHA-A>`, `HeadChanged=true`. |
| T-INV-4 | xUnit | `tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs` (new file, sibling to existing `SseEventProjectionSubmitEventsTests.cs`) | `s_sseActivePrFanoutLog` fires per `OnActivePrUpdated` invocation; `SubscriberCount` matches the registry's `SubscribersFor(prRef).Count` at publish time. |
| T-INV-5 | xUnit | same file | Log captures `EventType` correctly for `ActivePrUpdated`; control case with zero subscribers logs `SubscriberCount=0` and does not throw. |
| T-INV-6 | xUnit | same file | `s_sseActivePrDeliveryLog` fires per per-subscriber WriteAsync; emits `Success=true` on successful write, `Success=false` on eviction-path (forced via fault-injecting `IBufferWriter` or equivalent). |
| T-INV-7 | xUnit integration | `tests/PRism.Web.Tests/Logging/FileLoggerGateOverrideTests.cs` (new file, sibling to existing `FileLoggerIntegrationTests.cs` from PR #63) | When `ASPNETCORE_ENVIRONMENT=Test` AND `PRISM_FILE_LOGGER_FORCE=1`, `AddPRismFileLogger` registers the `FileLoggerProvider` (asserted via `IServiceProvider.GetService<FileLoggerProvider>()` returning non-null). When `PRISM_FILE_LOGGER_FORCE` is unset, the provider is NOT registered (existing xUnit safety preserved). Guards the Section 3.4 gate-lift against silent regression. |

### 7.2 Tests in the H1 follow-up PR (test-harness only)

| ID | Tier | File | Asserts |
|----|------|------|---------|
| T-H1-1 | Playwright real-flow | `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` | Un-skipped. Budget 60s. Banner visible after `advanceHead` + courtesy `pokePrRestRecord` poke. |

### 7.3 Tests in the H2 follow-up PR (if H2 wins; option-b fix)

| ID | Tier | File | Asserts |
|----|------|------|---------|
| T-H2-1 | xUnit | `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs` | `ActivePrUpdated.LatestHeadSha` always populated from `snapshot.HeadSha`, even when `HeadShaChanged=false`. |
| T-H2-2 | vitest | `frontend/__tests__/components/PrDetail/BannerRefresh.test.tsx` | New render branch — when `firstPoll=true && !headShaChanged && !commentChanged && latestHeadSha !== currentHeadSha`, renders "PR has been updated — Reload to view" with Reload button. |
| T-H2-3 | vitest | `frontend/__tests__/hooks/useActivePrUpdates.test.ts` | Latest-head tracking — successive `pr-updated` events update `latestHeadSha` correctly; `clear()` resets it. |
| T-H2-4 | Playwright real-flow | `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` | Un-skipped. Budget 60s. Banner visible. |

### 7.4 Tests in the H3 follow-up PR (if H3 wins; reconcile-on-subscribe)

| ID | Tier | File | Asserts |
|----|------|------|---------|
| T-H3-1 | vitest | `frontend/__tests__/hooks/useActivePrUpdates.test.ts` | After `apiClient.post('/api/events/subscriptions', ...)` resolves, `apiClient.get('/api/pr/{ref}/active-snapshot')` fires; if response head differs from initial loaded head, a synthetic `pr-updated` is dispatched. |
| T-H3-2 | xUnit | `tests/PRism.Web.Tests/Endpoints/ActiveSnapshotEndpointTests.cs` (new file) | GET `/api/pr/{ref}/active-snapshot` returns 200 + cache contents when subscribed; 404 when not subscribed. |
| T-H3-3 | Playwright real-flow | `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` | Un-skipped. Budget 60s. Banner visible. |

### 7.5 Tests in the H4 follow-up PR (if H4 wins; React effect reorder — added in round 2)

| ID | Tier | File | Asserts |
|----|------|------|---------|
| T-H4-1 | vitest | `frontend/__tests__/hooks/useActivePrUpdates.test.ts` | A `pr-updated` event dispatched during the mount window (between effect-cleanup-on-unmount and effect-run-on-mount on a `prRef` change) is captured by the newly-attached listener; the React state reflects the event. |
| T-H4-2 | Playwright real-flow | `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` | Un-skipped. Budget 60s. Banner visible. |

### 7.6 Test cross-cutting rules

- All seven T-INV-* tests MUST be green before running the investigation. They guarantee the diagnostic delegates emit what the methodology expects them to AND that the FileLoggerExtensions gate-override (Section 3.4) works in Test env when `PRISM_FILE_LOGGER_FORCE=1`.
- The Playwright assertion is identical across all four branches (T-H1-1 ≡ T-H2-4 ≡ T-H3-3 ≡ T-H4-2) — the un-skip + budget bump shape is the same regardless of winner (with the backoff-H2 budget exception in Section 6.2).
- No test asserts which hypothesis caused the bug; the methodology + finding artifact carry that determination.

## 8. Un-skip plan + budget bump mechanics

The un-skip lands in the same PR as the per-hypothesis fix. This section specifies the exact diff and the pre-merge verification gate.

### 8.1 Spec file diff (in the fix PR, not the investigation PR)

- `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:1–19` — delete the 19-line DEFERRED comment block. Replace with a one-line citation: `// Banner-after-head-change regression net. See docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md for the disambiguation that drove the fix.`
- Same file, line 45 — `test.skip(...)` → `test(...)`. Strip the "(deferred — see ...)" suffix from the test name.
- Same file, line 110 — `timeout: 30_000` → `timeout: 60_000`. Inline comment update: `// 60s budget per H1 mitigation (see finding artifact); the per-hypothesis fix landed in the same PR keeps boundary-2 → boundary-5b evidence-clean.`
- Same file, between line 106 (close of `advanceHead` call block) and line 109 (`reloadBanner` declaration):
  ```ts
  // Courtesy GET on pulls/{n} — same REST endpoint the poller reads; may help freshness, may not. See finding artifact.
  pokePrRestRecord(staleFixture.prNumber);
  ```
  `pokePrRestRecord` is the new helper added in the H1 fix PR to `helpers/gh-sandbox.ts` (see Section 6.1). The spec file's existing import statement (`import { advanceHead, listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';`) extends to include `pokePrRestRecord` — one added name, no new import line.

  **The committed diff includes the poke call.** Section 8.2's verification gate (below) temporarily reverts this single line for the first three-run cycle to observe the without-poke behavior, then restores it for the second three-run cycle. Both cycles must pass before merge. The poke remains in the committed code; the without-poke verification is a workflow step, not a versioning concern.

### 8.2 Pre-merge verification gate

Runs BEFORE the un-skip PR opens. Required:
1. All seven T-INV-* tests green locally (instrumentation correctness + capture mechanism).
2. All H-branch tests green locally for the chosen branch (T-H1-1 / T-H2-* / T-H3-*).
3. The un-skipped Playwright spec runs green locally THREE consecutive times against `prpande/prism-sandbox`. Three consecutive passes is the flake-detection threshold; PRism's real-flow suite has `retries: 0` (`playwright.real.config.ts:39`), so any local flake during the three runs blocks merge until the budget or poke is re-tuned.
4. Three-consecutive-passes verification runs FIRST without the courtesy poke, then WITH the poke. Both green is the gate. (Mitigates risk 4 from Section 10.4.)
5. Full pre-push checklist per `.ai/docs/development-process.md` — `npm run lint`, `npm run build`, `dotnet build`, `dotnet test`. No exceptions.

### 8.3 Post-merge cleanup (in the same fix PR)

- `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:944` — append a "RESOLVED" line at the end of the entry: `**RESOLVED 2026-MM-DD:** see docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md and PR #<n>. Hypothesis <H1|H2|H3|H4> confirmed. Fix shipped; spec un-skipped.`
- A standing project memory entry once the investigation completes — matches the existing project memories pattern (`project_pr58_*`, `project_pr59_*`).

### 8.4 What does NOT change

- The other three real-flow specs.
- `playwright.real.config.ts` (cadence, env, webServer settings).
- The fixture in `frontend/e2e/real/fixtures.json`.

## 9. Finding artifact format

The investigation deliverable is ONE markdown file at `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md`. The spec specifies its structure so the investigator doesn't reinvent it.

### 9.1 Required header fields

- Investigation date (yyyy-mm-dd).
- Spec citation: `docs/specs/2026-05-19-stale-oid-banner-investigation-design.md` (this spec).
- Log capture path (absolute or relative-to-repo) — the redirected backend stdout file from `<e2eDataDir>/logs/prism-stdout-<runId>.log` (per Section 3.4; the on-disk `FileLoggerProvider` is disabled under Test env so the stdout-redirect is the capture path, NOT the `prism-yyyy-MM-dd.log` file shape from PR #63).
- Playwright trace zip path.
- `gh api` snapshot log — one line per snapshot. **Each line records `(timestamp, head.sha)` ONLY**, NOT the full API response. GitHub PR API responses include `user.login`, `head.repo.owner.login`, `requested_reviewers`, etc. — GitHub usernames are PII per the project's SensitiveFieldScrubber blocklist (entry added 2026-05-18). Committing raw responses into `docs/specs/` persists PII. The boundary-1 evidence the investigation needs is `head.sha` and timestamp; everything else is stripped before commit.

### 9.2 Required sections (in order)

1. **Executive verdict.** One sentence naming the winning hypothesis (H1/H2/H3/H4) and one sentence on the evidence that picked it.
2. **Boundary-table observations.** The six-row table from Section 4.3, every row populated with observed values from the captured run. Rows whose log signature didn't fire marked N/A with reason.
3. **Decision-tree walk.** Step-by-step trace through Section 4.4's decision tree, showing which branch was taken and why. Cite log line numbers.
4. **Pre-investigation prediction vs. outcome.** State the Section 4.2 priors and whether the outcome confirmed or violated them. Free-text "what desk analysis missed" if violated.
5. **Handoff to writing-plans.** Citation to the matching sketch in Section 6. State whether the sketch needs adjustment.
6. **Out-of-band findings.** Unexpected behavior captured in the logs that didn't drive disambiguation but matters for follow-up (spurious backoff fires, missing structured-log fields, GitHub rate-limit headers near the cap).

### 9.3 Hard rules

- Finding does NOT contain proposed fix code. Sketch lives in this spec; finding cites it.
- Length budget 1–2 pages (~400–800 words). Anything longer means new design decisions belong in `writing-plans`, not the finding.
- One `ce-doc-review` pass per project CLAUDE.md convention.

### 9.4 Where the prediction is recorded

The Section 4.2 prediction must appear in the finding's section 4 ("Pre-investigation prediction vs. outcome") verbatim, with the outcome appended. The prediction-recording step happens BEFORE log reading; the outcome-comparison step happens AFTER.

## 10. Out-of-scope, risks, future considerations

### 10.1 Out-of-scope for this spec and its follow-up PRs

- `ActivePrPoller._state` and `ActivePrCache` unbounded growth. Orthogonal singleton-grows-forever concern, not on the PoC critical path.
- SSE channel architecture rework (cookie-keyed routing, fan-out semantics). Investigation uses the channel as-is; H3 fix is reconcile-on-subscribe, not channel redesign.
- General reliability work on `IReviewEventBus`. Out-of-band findings may flag concerns; each becomes a separate follow-up spec.
- Production-deployment concerns (multi-user, scaling, rate-limit headroom).
- `IActivePrCache` cleanup policy.

### 10.2 Risk: investigation reaches no clear verdict

Log signatures partially fire across multiple hypotheses; decision tree ambiguous. **Mitigation:** the finding's Section 4 ("prediction vs. outcome") captures the ambiguity; `writing-plans` accepts "re-run with finer-grained instrumentation" as an outcome branch and produces a small follow-up investigation-2 spec rather than forcing a premature pick.

### 10.3 Risk: diagnostic delegate produces nuisance log volume

At cadence=30s with one active PR, ~2880 lines/day/PR; ~50KB/day/PR. PR #63's 14-day retention sweep bounds disk usage. Acceptable.

### 10.4 Risk: courtesy `pokePrRestRecord` poke masks H3

If H3 is the cause, the poke triggers a head-change event that publishes during the subscriberId-rebind window — masking the very bug just fixed. **Mitigation:** Section 8.2's verification gate runs three-consecutive-passes WITHOUT the poke first, then WITH the poke. Both green is the gate. If only "with poke" passes, the investigation must revisit whether H3 is actually fixed.

### 10.5 Risk: investigation surfaces H4 (frontend handler)

Section 4.4's decision tree calls this out as out-of-scope; finding artifact's Section 6 ("Out-of-band findings") surfaces the symptom and a new spec handles it. Doesn't block H1/H2/H3 resolution from blocking on a different bug.

### 10.6 Risk: implementation-time discovery of an SSE-fanout class deviation

This spec assumes `SseChannel.OnActivePrUpdated` at `PRism.Web/Sse/SseChannel.cs:238` is the fan-out site. Verified during spec writing. If `writing-plans` discovers further indirection (e.g., the fan-out branches via a helper), the delegate placement adjusts; the spec's diagnostic intent stays the same.

### 10.7 Future consideration: budget tuning

If H1 wins, the 60s budget is empirical. If real-flow CI flakes >5% post-shipping, raise to 90s with a comment citing the H1 finding. Track in the deferral entry's RESOLVED note.

### 10.8 Future consideration: diagnostic runbook generalization

The two diagnostic delegates may serve future SSE-related investigations. Worth a future doc-only PR moving "what to look for in the snapshot log" into a runbook under `.ai/docs/` if a second SSE bug ever hits.

### 10.9 Future consideration: memory entry on resolution

Add a project memory entry once the investigation completes, matching the existing pattern (`project_pr58_*`, etc.).

## 11. References

- Deferral entry: `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:944`
- Skipped test: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`
- Production code: `PRism.Core/PrDetail/ActivePrPoller.cs:115–135`, `PRism.GitHub/GitHubReviewService.cs:455`, `PRism.Web/Sse/SseChannel.cs:238`
- Frontend code: `frontend/src/components/PrDetail/BannerRefresh.tsx:43–62`, `frontend/src/hooks/useActivePrUpdates.ts`, `frontend/src/api/events.ts`, `frontend/src/hooks/useEventSource.tsx`
- On-disk logger (prerequisite, PR #63): merged 2026-05-19 (merge `3647cfe`); writes to `<DataDir>/logs/prism-yyyy-MM-dd.log`. **Disabled under `ASPNETCORE_ENVIRONMENT=Test`** (`FileLoggerExtensions.cs:24`) — the investigation's capture path is the stdout-redirect in `playwright.real.config.ts`, NOT the on-disk file. See Section 3.4.
- Test config: `frontend/playwright.real.config.ts:31` (cadence=1s), `:39` (retries=0).
- Helpers: `frontend/e2e/real/helpers/gh-sandbox.ts` (`pokePrRestRecord`, `advanceHead`).

## 12. Reviewer concerns noted but not acted on

`ce-doc-review` (2026-05-19) raised several findings that re-litigate design positions the user explicitly chose during the brainstorm framing pass (Q1–Q4 + Approach C selection). Per `superpowers:receiving-code-review` rigor, these are surfaced here visibly but NOT applied to the spec body. The user's brainstorm answers are the authoritative design positions.

- **(product-lens P1 / scope-guardian SG3) "Investigation-PR + finding + writing-plans round-trip is overhead for a sole-owner PoC."** The user explicitly chose Approach C (single spec + named finding artifact) over Approach A (implicit handoff) and Approach B (two-phase). The finding's "ship the diagnostic delegates + run locally + ship the winning fix in one PR" alternative IS Approach A, which the user rejected.
- **(product-lens P2 / scope-guardian SG2) "Permanent diagnostic delegates lack signal-to-noise justification."** Per Q1, the user chose to ship the log delegate as Information-level + permanent. The "remove after investigation" alternative was implicitly rejected.
- **(product-lens P3 / scope-guardian SG1) "H3 inclusion at 20% prior bloats matrix; defer until logs implicate."** Per Q2, the user chose three hypotheses over the deferral's two-hypothesis frame.
- **(product-lens P5) "H1 win is test-harness-only; cheap-probe BEFORE the investigation apparatus."** The methodology IS the cheap probe — Section 4.6's H1 test is "bump budget to 300s and re-run once." But running it inside the instrumented capture (with the delegates emitting) costs no more than running it standalone and produces strictly more evidence. Skip.
- **(scope-guardian SG4) "Section 10's nine sub-sections inflate the spec."** Sections 10.7–10.9 are intentional future-considerations per the user-approved Section 8 walk-through. Skip.
- **(adversarial A1) "H2 impossibility argument ignores registry-empty / GetOrAdd path."** The adversarial agent conflated `ActivePrPoller._state` (never cleared in code; persists across registry empties) with `ActivePrSubscriberRegistry._byPr` (does empty on subscriber drop). State persists across SPA remounts. The literal H2 frame remains improbable; the backoff-recovery variant (covered in A5 / applied to Section 5.2) is the real path. Skip A1 on merits.
- **(adversarial A2) "H3 race window analysis too narrow; SILENCE_WATCHER_MS reconnect."** Valid concern but the investigation methodology already requires three consecutive captures (per A4 / applied to Section 4.1) and the boundary 5b delivery log (per A8 / applied to Section 3.3) captures the per-write outcome. If H3 is implicated by intermittent boundary-5b `Success=false`, a follow-up investigation can add EventSource open/close logging. Section 5.3 now mentions the 35s watchdog; that's the right level of detail at spec time.
- **(adversarial A6) "Three-pass mitigation insufficient for intermittent H3."** Statistically true. PoC scope; the user's three-pass model (Q4) is the cadence. If real-flow CI flakes >5% post-merge, the residual-risk path in Section 6.1 + Section 10.7 applies. Skip the "require N≥10 runs" upgrade.
- **(adversarial A7) "Finding artifact 'no fix code' rule collides with sketch amendment."** Valid edge case. Documented here as the standing handoff rule: if the investigation surfaces a sketch-amendment-sized finding, the finding artifact MAY include a single bounded "sketch amendment" subsection (≤200 words, explicitly tagged) — `writing-plans` reads it as additional input. Spec Section 9 doesn't gain this clause; it lives here as the operating convention.

## 13. ce-doc-review pass — actions taken

`ce-doc-review` ran one pass on 2026-05-19 across six reviewers (coherence, feasibility, product-lens, security-lens, scope-guardian, adversarial). 34 findings total. Action summary:

**Applied (substantive):**
- **F1 (feasibility, P0, anchor 100)** — Added Section 3.4 + updated runbook (Section 4.1) for the on-disk-logger Test-env gate. The `FileLoggerProvider` from PR #63 is disabled under `ASPNETCORE_ENVIRONMENT=Test`; the investigation's capture path is now backend-stdout-redirect via a new `PRISM_E2E_LOG_TO_FILE` env-var guard. SHOWSTOPPER fix.
- **F2 (feasibility, P1, anchor 75)** — Replaced `getPrHeadOid` courtesy poke (GraphQL `pullRequest.headRefOid`) with a new REST-targeting helper `pokePrRestRecord` (Sections 6.1, 8.1). GraphQL and REST are different replica sets; the courtesy poke must target the same surface the poller reads.
- **F3 (feasibility, P2, anchor 100)** — Fixed log file naming (`PRism-YYYYMMDD.log` → `prism-yyyy-MM-dd.log`) in Sections 4.1 and 11.
- **F4 (feasibility, P2, anchor 75)** — Clarified `/api/pr/{ref}/active-snapshot` contract as three-state (200 with snapshot / 204 No Content / 404). The two-state contract masked the bug H3 exists to fix.
- **A3 + C2 (adversarial / coherence, P1, anchors 75 / 100)** — Added Section 5.4 H4 as a positively-defined hypothesis (mount-race in `useActivePrUpdates.ts:26-29`), removed the decision tree's "out-of-scope fallback" framing.
- **A4 (adversarial, P1, anchor 75)** — Updated Section 4.1 to require ≥3 consecutive captures with consistent boundary-2 signatures; intermittent failures classify as "re-run with finer-grained instrumentation".
- **A5 (adversarial, P2, anchor 75)** — Section 5.2 H2 now covers the backoff-recovery variant where `ApplyBackoff` defers retry beyond `advanceHead`, producing the literal H2 log signature from a reachable code path.
- **A8 (adversarial, P2, anchor 75)** — Added Section 3.3 second SseChannel delegate `s_sseActivePrDeliveryLog` for per-subscriber WriteAsync outcome (boundary 5b). The original delegate captured intent only.
- **C1 (coherence, P2, anchor 75)** — Section 8.1 + 8.2 clarified: the committed diff INCLUDES the poke; verification gate temporarily reverts it for the first three-run cycle, restores for the second. No versioning concern.
- **C4 (coherence, P2, anchor 75)** — Boundary 6 evidence source clarified to "Playwright trace network frames" — browser-side instrumentation is out of scope.
- **S1 (security-lens, P2, anchor 75)** — Section 6.3 H3 sketch gained an auth/origin inheritance note: endpoint must register inside the existing `/api/pr/{owner}/{repo}/{number:int}/` route group to inherit SessionTokenMiddleware.
- **S3 (security-lens, P3, anchor 50)** — Section 9.1 trims `gh api` snapshot capture to `(timestamp, head.sha)` only; raw responses contain GitHub login PII per the SensitiveFieldScrubber blocklist.

**Deferred (residual; see Section 12 for full rationale):**
- A1 (H2 impossibility argument) — skip on merits.
- A2 (SILENCE_WATCHER reconnect) — partially addressed via boundary 5b; full instrumentation deferred.
- A6 (N≥10 runs) — PoC scope; three-pass gate stands.
- A7 (sketch amendment rule) — captured as standing convention in Section 12.

**Skipped (re-litigates user-approved design positions):**
- P1, P2, P3, P5, SG1, SG2, SG3, SG4 — per Q1–Q4 + Approach C answers during the brainstorm framing pass.

**Skipped (advisory / FYI per anchor 50):**
- C3, C5, C6, C7, F5, P4, P6, S2, SG5 — minor noise; do not affect spec correctness.

### 13.1 ce-doc-review round 2 — actions taken

A second pass ran on 2026-05-19 at the user's explicit request. 21 round-2 findings total. Action summary:

**Applied (substantive):**
- **Stdout-redirect → FileLoggerExtensions gate-lift (cluster: F1-R2 / F2-R2 / A4-R2 / A5-R2 / S1-R2 / SG2-R2)** — round-1's stdout-redirect approach revealed FIVE distinct gotchas: (1) Playwright `webServer.stdout: 'pipe'` doesn't expose a programmatic stream API; (2) default ASP.NET Console formatter emits two physical lines per record, not one; (3) Console logger buffering drops log lines at crash time — exactly the failure moment the methodology needs to capture; (4) Console output bypasses `SensitiveFieldScrubber`, leaking `AuthEndpoints` `Login` PII; (5) Playwright's existing stdout pipe consumes the stream. Switched Section 3.4 to lift the `FileLoggerExtensions` Test-env gate behind `PRISM_FILE_LOGGER_FORCE=1` — one-line production code change addressing all five concerns. T-INV-7 reshaped to assert the gate-override behavior. **This reverses the round-1 design choice** because round-2 evidence tipped the balance.
- **C1-R2 / C2-R2 / C3-R2 / C4-R2 / SG3-R2 (stale-reference cleanup)** — Round-1's F2 fix introduced `pokePrRestRecord` in some sections but left `getPrHeadOid` references in Sections 7.2 (T-H1-1 assertion), 10.4 (risk title), 11 (References). All fixed. Section 8.2 "five T-INV-*" → "seven" (round-1 added T-INV-6 and T-INV-7 but didn't propagate the count). Section 2 Scope updated to say two delegates in SseChannel (Section 3.2 + 3.3), not one.
- **A1-R2 / F3-R2 (T-INV-7 trigger gap)** — T-INV-7 reshaped from a Playwright sanity spec to an xUnit gate-override test (`FileLoggerGateOverrideTests.cs`) that asserts the FileLoggerExtensions behavior directly with `IServiceProvider.GetService<FileLoggerProvider>()`. No subscription setup needed; no env-var-conditional gate problem.
- **A6-R2 (H4 has no sketch — deferral can't close from H4 evidence)** — Added Section 6.4 minimal H4 sketch (React effect reorder: attach `pr-updated` listener before `setState(initial)`) + T-H4-1 / T-H4-2 in new Section 7.5. Section 5.4 updated to point at the new sketch. RESOLVED template (Section 8.3) now includes H4.
- **A7-R2 (backoff-H2 budget risk)** — Section 6.2 gained a residual-risk paragraph: if backoff-H2 wins, budget bumps to 120s (vs 60s for other branches) because `ApplyBackoff` defers next poll by 30–300s.
- **A3-R2 (subscriber→tab mapping ambiguity)** — Section 4.1 step 6 gained a SubscriberId→Playwright-tab mapping procedure (cross-reference Playwright trace's `subscriber-assigned` payload against boundary-5b log lines).
- **A2-R2 (parallel `gh api` snapshots contaminate boundary-1)** — Section 4.1 step 4 gained a measurement-contaminates-treatment caveat + a recommendation to run a CONTROL pass (no advanceHead) to baseline.
- **A8-R2 ("consistent across three runs" undefined)** — Section 4.1 step 6 gained per-hypothesis operationalization of "consistent."
- **S2-R2 (route-group claim was factually wrong)** — Section 6.3 corrected: `PrDetailEndpoints.cs` uses flat `app.MapGet` calls, not `MapGroup`. `SessionTokenMiddleware` enforcement comes from pipeline-global path-prefix check, not from group membership. `writing-plans` instructed NOT to create a wrapper MapGroup.

**Skipped (re-litigation of round-1 / brainstorm decisions):**
- product-lens-R2: empty findings array — correct outcome per the user-rejection of P1-P6 in round 1.
- SG1-R2 (T-INV-7 too heavy as Playwright spec) — addressed by the gate-lift switch reshaping T-INV-7 into an xUnit test, not a Playwright spec.
- SG4-R2 (Sections 12/13 are meta-content) — kept; per project CLAUDE.md convention of visible-rejection logging.

**Deferred:**
- None — all substantive round-2 concerns either applied or skipped with reason.

---

**Spec self-review pass (placeholders / consistency / scope / ambiguity)** — completed 2026-05-19. Initial pass applied one fix (`getPrHeadOid` import claim in Sections 6.1 and 8.1; later replaced in round-2 with `pokePrRestRecord` per F2-R1). Subsequent `ce-doc-review` round 1 applied 12 substantive fixes (see Section 13); round 2 applied additional fixes including replacing the stdout-redirect approach with FileLoggerExtensions gate-lift (see Section 13).

**Status timeline:**
- 2026-05-19 — drafted, brainstorm sections 1–8 approved by user.
- 2026-05-19 — spec self-review completed; one consistency fix applied.
- 2026-05-19 — `ce-doc-review` round 1 run; 12 substantive findings applied, 4 deferred to Section 12, 8 skipped as user-decided-already, 9 skipped as FYI.
- 2026-05-19 — `ce-doc-review` round 2 run at user request; round-1 stdout-redirect approach reversed in favor of `FileLoggerExtensions` gate-lift (5 round-2 concerns resolved at once); H4 sketch added; stale `getPrHeadOid` references cleaned up; subscriber→tab mapping + boundary-1 contamination caveats added.
- 2026-05-19 — user review pending.
