# Claude Code streaming provider (P0-1b Slice 2 / #478) — design

- **Issue:** [#478 — [AI] P0-1b — Claude Code streaming provider (stream-json subprocess)](https://github.com/prpande/PRism/issues/478)
- **Parent root:** #404. **Slice 1 (contracts) shipped** on V2 (PR #480, merge `a251c0e7`). This slice implements the real provider behind those contracts.
- **Base branch:** `V2`. **Tier/risk:** T3, **gated B2** (subprocess + egress).
- **Seeds:** the Slice-1 spec §5 design brief + the [#478 carry-forward acceptance criteria](https://github.com/prpande/PRism/issues/478) + the **empirically verified wire format** in § 9 below.

## 1. Problem & context

Slice 1 shipped the streaming seam (`IStreamingLlmProvider` / `IStreamingLlmSession` / `LlmEvent` / `StreamingSessionOptions`) with a dark `NoopStreamingLlmProvider`. This slice implements the real provider that drives the `claude` CLI as a **persistent multi-turn stream-json session** — the substrate PR chat (#412) builds on.

The one-shot `ClaudeCodeLlmProvider` shells out per call via `ICliProcessRunner.RunAsync` (run-to-completion). A streaming session needs a **persistent subprocess** with live stdin/stdout, which that seam cannot express.

**De-risked empirically (§ 9).** The stream-json wire format is officially undocumented (Anthropic issues #24594/#24612). Rather than build on guesses, the format was captured directly from `claude` v2.1.177 via bounded probes; § 9 records the verified shapes. The persistent multi-turn model (one process, one `result` per user turn, stable session id) is **confirmed**, validating the Slice-1 turn-termination invariant.

## 2. Scope & non-goals

**In scope:**
- New persistent-pipe process seam `IStreamingCliProcess` + `SystemStreamingCliProcess` (the only new `System.Diagnostics` class; mirrors `SystemCliProcessRunner`'s isolation).
- `ClaudeCodeStreamingProvider : IStreamingLlmProvider` + `ClaudeCodeStreamingSession : IStreamingLlmSession`.
- Background stdout reader → bounded `Channel<LlmEvent>` (cap 1024, `Wait`); NDJSON line parser mapping stream-json events → `LlmEvent`.
- `SendUserTurnAsync`, `Events`, `ProviderSessionId`, dispose-within-2s, `EndCleanlyAsync`.
- The deferred recoverable-error event: add `LlmTurnError` to the Contracts `LlmEvent` hierarchy (the subtype Slice 1 promised "defined empirically in Slice 2").
- Real-provider registration in `AddPrismClaudeCode` (the Slice-1 `TryAdd` default then no-ops).
- **A minimal wire-drift guard** (§ 9.1) so a CLI format change surfaces as an observable signal instead of silent empty turns — pulled into this slice, not the deferred CLI-compat suite, because #412/#414 consume the format at runtime.
- All [#478 carry-forward acceptance criteria](https://github.com/prpande/PRism/issues/478).

**Out of scope / deferred:**
- `--resume` / cross-restart (Slice 3 / #479) — including the `ResumeSessionId` field.
- `AddDirs`/`--add-dir` repo access (later repo-access slice) and `McpConfigPath` (P0-7).
- Any feature consuming the session (chat #412, hunk-stream #414).
- Automated tests that spawn the real `claude` binary — per repo convention, real-CLI invocation is **manual P1 validation**; automated tests use a fake `IStreamingCliProcess`.

## 3. Architecture

```
ClaudeCodeStreamingProvider.StartSession(opts)          // provider holds an injected IStreamingCliProcessFactory
  └─ builds args (§9 flags) + env allowlist → StreamingProcessSpec
  └─ factory.Start(spec)  →  IStreamingCliProcess        // persistent process, redirected stdin/stdout
  └─ returns ClaudeCodeStreamingSession(process)
        ├─ background Task: read process.StdoutLines → parse NDJSON → map → Channel<LlmEvent>.Writer (Wait)
        │                   AND, on the turn-terminal `result`, trip the current turn's completion signal (below)
        ├─ Events            => channel.Reader.ReadAllAsync()                  // single consumer, single pass
        ├─ ProviderSessionId <- captured from system/init event
        ├─ SendUserTurnAsync -> set turnInFlight + new TaskCompletionSource; write one user NDJSON line to stdin (concurrent)
        ├─ turn completion    <- a per-turn TaskCompletionSource the reader trips when it maps LlmTurnComplete
        │                        (NOT observed by draining the channel — a 2nd reader would steal events from Events)
        ├─ EndCleanlyAsync   -> await the in-flight turn's completion signal, close stdin, await exit
        └─ DisposeAsync      -> cancel + KillTree, ensure exit <2s
```

**Turn-completion signal — decoupled from the channel.** The session must observe "the current turn ended" *without* reading `Events`, because `Events` is a single-consumer / single-pass channel the external caller drains — a second reader inside `EndCleanlyAsync` or the `turnInFlight` bookkeeping would steal events from that caller. The reader task therefore trips a per-turn `TaskCompletionSource` when it parses the turn-terminal `result`. `SendUserTurnAsync` allocates the TCS and sets `turnInFlight`; the reader's trip clears `turnInFlight` and is exactly what `EndCleanlyAsync` awaits. This resolves the feasibility tension that `EndCleanlyAsync` "awaits the current turn's result" while the result is itself an item on the single-reader channel.

Three ordering/construction requirements make this correct (each is a load-bearing invariant, not an implementation nicety):
- **Trip BEFORE the blocking channel-write.** On the terminal `result` the reader must `TrySetResult` on the TCS **before** it `WriteAsync`es the `LlmTurnComplete` into the bounded channel. The channel write uses `Wait` (below) and can block on a stalled consumer; if the reader wrote first and tripped second, a stalled consumer would block the write, the TCS would never trip, and `EndCleanlyAsync` would hang until `gracefulTimeout` — the very deadlock this decoupling exists to remove. Trip-first publishes completion off the blockable path.
- **`TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)`.** Otherwise the reader thread inlines `EndCleanlyAsync`'s continuation (stdin-close / await-exit) onto itself, stalling the stdout drain.
- **One TCS per turn, published with a memory barrier.** `SendUserTurnAsync` (caller thread) writes the field the reader (background thread) trips; the `turnInFlight` gate serializes turns, but the field handoff is still cross-thread — guard it (e.g. `Volatile`/lock) rather than relying on the gate alone.

**`EndCleanlyAsync` with no turn in flight (zero-turns / already-completed).** When `turnInFlight` is false there is no per-turn TCS to await. `EndCleanlyAsync` instead awaits **session init** (the `system/init` line that sets `ProviderSessionId`), then closes stdin and awaits exit, returning `LastTurnEndedCleanly=true` with the captured non-empty `ProviderSessionId` — honoring the Slice-1 contract that a cleanly ended session *with zero turns sent* still returns a non-empty id. Wiring `EndCleanlyAsync` to await only the in-flight TCS would NRE / hang on a session that never sent a turn.

**Back-pressure semantics — the `Wait` policy.** The single reader writes mapped events into the bounded channel with `BoundedChannelFullMode.Wait`. If the consumer stops draining `Events` mid-turn, the channel fills at cap 1024 and the reader blocks on the write — transiently halting its drain of the child's stdout, so the child blocks on its stdout write. This is **normal, recoverable back-pressure**: it clears the instant the consumer reads again. The only non-recoverable shape is a consumer that abandons the session without disposing it *and* never reads again — a misuse, bounded by `DisposeAsync` (KillTree) and `EndCleanlyAsync`'s `gracefulTimeout`. On forced end / dispose the reader may itself be blocked on a full-channel `Wait` write: KillTree breaks the pipe (the next `ReadLineAsync` faults) **and** the session completes the channel writer / cancels the reader's linked CT, so a reader blocked on the write is released rather than leaking. Because the turn-completion signal is tripped **before** that blockable write, a stalled consumer never blocks `EndCleanlyAsync` from observing a turn that already produced its `result`. (Memory is bounded by the cap; liveness of shutdown is bounded by the two timeouts — neither relies on the consumer being prompt.)

**`IStreamingCliProcess` seam** (testable; keeps `System.Diagnostics` in one class). It exists **solely for test-double injection** — `SystemStreamingCliProcess` is the only planned real implementor; the interface is **not** an extension point for additional providers (do not build indirection on top of it):
```csharp
public interface IStreamingCliProcessFactory
{
    IStreamingCliProcess Start(StreamingProcessSpec spec);   // spawns the persistent process
}

public interface IStreamingCliProcess : IAsyncDisposable
{
    IAsyncEnumerable<string> StdoutLines { get; }            // line-delimited stdout; loops StandardOutput.ReadLineAsync (NOT BeginOutputReadLine — that buffers and cannot stream per-line)
    Task WriteLineAsync(string line, CancellationToken ct);  // append one NDJSON line to stdin
    Task CloseStdinAsync();                                  // signal clean end
    Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct);  // returns exit code; kills tree on timeout
}
```
`StreamingProcessSpec` mirrors the one-shot `ProcessSpec` record's fields — `FileName`, `Arguments` (`IReadOnlyList<string>`), `Environment` (the allowlisted dictionary), `WorkingDirectory` — **minus** the one-shot `StdinText`/`Timeout` (stdin is live; there is no single per-call timeout). Tests inject a fake factory (scripted stdout lines, recorded stdin writes); the parser/session logic is verified without spawning. `SystemStreamingCliProcess` is the real impl, validated manually (§ 8).

## 4. Event mapping (verified against § 9)

| stream-json line | → `LlmEvent` |
|---|---|
| `type=system, subtype=init` | (no event) capture `.session_id` → `ProviderSessionId` |
| `type=stream_event, .event.type=content_block_delta, .event.delta.type=text_delta` | `LlmTextDelta(.event.delta.text)` |
| `type=assistant`, a `.message.content[]` block of `.type=tool_use` | `LlmToolUse(name=.name, input=.input)` — sourced from the **one complete** `tool_use` block on the `assistant` event (input is a full parsed object). The streaming `content_block_start`/`input_json_delta` tool framing is **ignored** in Slice 2: incremental input accumulation is a stateful sub-protocol no Slice-2 consumer needs, deferred to the consuming slice (#414/#412). Emit `LlmToolUse` **exactly once** per tool call. **CAPTURED (§ 9):** a tool turn *does* emit the `assistant` block with the complete `input`, **and** `--include-partial-messages` *also* streams a competing `content_block_start`/`input_json_delta` representation (empty `input:{}` then accumulated) — so sourcing from the `assistant` block and ignoring the streaming framing is exactly what keeps "exactly once". A single user turn may loop internally (tool call → answer = `num_turns:2`) yet still produce **one** `result`; the `LlmToolUse` streams *within* that one turn, before its `LlmTurnComplete`. |
| `type=result, is_error=false` | `LlmTurnComplete(FullText=.result, tokens=.usage.*, cost=.total_cost_usd)` |
| `type=result, is_error=true` | `LlmTurnError(Message, Code)` **then** `LlmTurnComplete(...)` (informational event precedes the terminal — honors the Slice-1 contract). **`is_error` is the only reliable error boolean** — `subtype` is `"success"` on some errors (§ 9). `Code` = `subtype` when it is not `"success"` (e.g. `error_max_turns`), else `api_error_status` (e.g. `404`). `.result` **may be absent** on error (`error_max_turns` omits it) → see § 5.6. |
| `type=assistant` / `type=message*` `text`/`thinking` blocks, `content_block_start/stop`, `message_start/delta/stop`, `signature_delta`, `rate_limit_event`, other `system` | ignored in Slice 2. **Text is taken only from `stream_event` `text_delta` — the `assistant`/`message` events carry a duplicate full copy of the same text (empirically confirmed, § 9); mapping both would double-count the turn's text.** `rate_limit_event` is advisory (turn still completes `success` — § 9); the open hierarchy lets consumers ignore the rest. |
| process exits with no `result` for the in-flight turn / nonzero exit / broken pipe | **throw `LlmProviderException`** from `Events` enumeration (unrecoverable session death) |

**Token mapping** (matches one-shot `LlmResult`): `InputTokens=.usage.input_tokens`, `OutputTokens=.usage.output_tokens`, `CacheReadInputTokens=.usage.cache_read_input_tokens`, `EstimatedCostUsd=.total_cost_usd`.

**Turn-termination liveness (every `type=result` resolves the turn).** Any line with `type=result` — `is_error=false`, `is_error=true`, or a shape the parser only partially recognizes — **must** trip the turn's completion TCS and clear `turnInFlight`. The parser never silently drops a `result` line: if a `result` arrives whose shape it cannot map at all (missing `.result`/`.usage` etc.), it treats that as **unrecoverable** (throw `LlmProviderException` from `Events`, § 5.1) rather than ignoring it — because a `result` that neither completes nor throws would leave the TCS un-tripped and hang `EndCleanlyAsync` until `gracefulTimeout`. This closes the liveness hole where an unmappable `result` shape (a future CLI change, or an error variant beyond the two captured in § 9) could otherwise strand the turn.

## 5. Open-fork resolutions (the design decisions Slice 1 left to here)

1. **Recoverable vs unrecoverable taxonomy.** Recoverable = a terminal `result` arrives for the turn with `is_error=true` (**the turn** failed cleanly) → emit `LlmTurnError` (informational) then `LlmTurnComplete`. Unrecoverable = the process dies / pipe breaks / a turn yields **no** `result` → throw from `Events`. The axis is *did the turn get a terminal `result`*, **not** *is the session still usable* — empirically (§ 9) both captured error turns (`api_error 404`, `error_max_turns`) emitted a `result` **and** then the process exited. So a recoverable (turn-level) error can still be followed by process exit: the reader emits the turn's `LlmTurnError`+`LlmTurnComplete`, then stdout EOF ends `Events` normally, and the *next* `SendUserTurnAsync` fails because the process is gone (session liveness is observed from process state, never inferred from `is_error`). This matches the wire reality (§ 9) and the Slice-1 turn-termination invariant exactly.
2. **`LlmTurnError` shape.** `public sealed record LlmTurnError(string Message, string? Code) : LlmEvent;` added to `LlmEvent.cs`. Informational, non-terminal (always followed by `LlmTurnComplete` in the same turn). `Code` = `result.subtype` when it is not the literal `"success"` (e.g. `error_max_turns`), else `result.api_error_status` rendered as a string (e.g. `"404"`) — because `subtype` is empirically `"success"` even on an API-error turn (§ 9), so it cannot be trusted as the error code on its own. `Message` = `.result` when present, else a synthesized message from `Code` (`.result` is absent on `error_max_turns`).
3. **`EndCleanlyAsync` `ct` semantics.** A cancelled `ct` means "abandon the graceful wait now": stop waiting for the current turn's `result`, force-terminate (KillTree), and return `LastTurnEndedCleanly=false`. It does **not** throw `OperationCanceledException` — `EndCleanlyAsync` is a best-effort shutdown, so cancellation degrades to forced-end rather than propagating. (Distinct from `SendUserTurnAsync`/`Events`, where `ct`/abandonment surfaces normally.)
4. **`SendUserTurnAsync` ordering enforcement.** The session tracks a `turnInFlight` flag set on send, cleared when the reader maps the turn-terminal `result` (which always yields a `LlmTurnComplete`, on **both** the success and the `is_error=true` path — so the flag clears regardless of turn outcome). A second send while in flight throws `InvalidOperationException` **synchronously** (before writing to stdin) — content provably not enqueued, session usable (Slice-1 contract).
5. **`--verbose` is mandatory** (empirically required, § 9) and is always passed.
6. **Error-path `LlmTurnComplete` semantics.** On an `is_error=true` turn the reader emits `LlmTurnError` then `LlmTurnComplete` — but a consumer following the forward-compat rule ("ignore unrecognized subtypes") sees only the `LlmTurnComplete` and must not render an error string as if it were the answer. Resolution (now **empirically grounded**, § 9): `LlmTurnComplete.FullText` = `.result` **when present** — on an API-error turn `.result` is the CLI's human-readable error message (*"There's an issue with the selected model…"*), **not** assistant prose — and **`""` when `.result` is absent** (the `error_max_turns` shape has no `.result` field; the parser must not assume it exists). Tokens/cost map from `.usage`/`.total_cost_usd` whatever they report (`0` on the API-error turn, non-zero on `error_max_turns`). The preceding `LlmTurnError` is the authoritative failure signal; consumers treat any turn that emitted `LlmTurnError` as failed irrespective of `FullText`.
7. **Dispose / end racing an in-flight stdin write.** `SendUserTurnAsync` writes the user line to stdin **concurrently** (so a line larger than the OS pipe buffer cannot deadlock — same rationale as `SystemCliProcessRunner`). If `DisposeAsync` (KillTree) or a forced `EndCleanlyAsync` fires while that write is mid-flight, killing the child breaks the pipe and the write surfaces an `IOException`. Resolution: mirror the one-shot runner — the session retains the write `Task` and, on dispose/forced-end, awaits it inside a drain helper that **swallows `IOException`** (broken pipe = child already gone); the process end-state already reflects the real outcome. `DisposeAsync` is idempotent and never propagates the broken-pipe exception.

## 6. Security (carries the § 7 Slice-1 invariants)

- **Env allowlist:** reuse `ClaudeCliEnvironment.BuildAllowlisted()` verbatim; **a Slice-2 test asserts parity** (not assumed by inheritance, per the carry-forward). Parity proves the two slices agree but **not** that the allowlist is leak-free, so a second test asserts **completeness**: enumerate `BuildAllowlisted()`'s output and assert no key matches a credential-bearing pattern (`GITHUB_TOKEN`, `GH_TOKEN`, `*_PAT`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_CREDENTIAL`). This runs in CI, where those variables are actually injected, so ambient leakage to the egress-capable `claude` subprocess is caught.
- **No `--bare`**, `--output-format stream-json`.
- **User-turn line is JSON-serialized, never concatenated.** The `{"type":"user",…,"text":"<prompt>"}` stdin line is produced by a JSON serializer (`System.Text.Json`), never string interpolation — so untrusted prompt content (PR/diff text from #412/#414) containing quotes, newlines, or null bytes cannot break out of the `text` field and forge a second NDJSON frame or inject a control event. A test feeds a prompt containing `"`, `\n`, and `}{"type":"user"…` and asserts exactly one well-formed frame is written.
- **`WorkingDirectory` confinement (canonical-path check, symlinks resolved).** The operator-sanctioned base dir is supplied to the provider at construction (a per-PR worktree root in server context, or the app data dir for the desktop/local context — the host picks one at startup; the provider does not invent it). Before spawn, the provider resolves **both** the caller's `WorkingDirectory` and the base to a real, symlink-free absolute path, then rejects any working dir whose resolved form is not under the resolved base. **`Path.GetFullPath` alone is insufficient — it only normalizes `..` *lexically* and does NOT resolve symlinks**, so a symlink `<base>/link → /etc` would pass a `GetFullPath` prefix check while the spawned `claude` reads `/etc`. The check therefore combines `Path.GetFullPath` (lexical `..` collapse) **with** OS symlink resolution — `Directory.ResolveLinkTarget(path, returnFinalTarget: true)` (net6+; null return = not a link, use the GetFullPath result) — on both paths before the prefix comparison. Confinement matters because the spawned `claude` inherits this dir as the implicit root for its read-only built-in file tools. Tests cover a `..`-traversal path **and** a symlink fixture pointing outside the base (asserting the symlink is actually resolved and rejected, not lexically passed).
- **Default-deny tools (deny list pinned here, not deferred).** Spawn always passes a **hardcoded `--disallowedTools` constant** covering `Bash`, `computer-use`, and every file-write/edit tool, plus `--allowedTools` limited to a fixed read-only built-in set (+ MCP tools when P0-7 lands). Caller `AllowedTools`/`DisallowedTools` are **merged additively**: a caller may further restrict but **cannot remove** an entry from the hardcoded deny list (deny wins on conflict), and `Bash`/`computer-use`/file-write are **never** added to `--allowedTools` regardless of caller input. The concrete tool identifiers are enumerated from the `init` event's `tools` array (§ 9) and pinned in the implementation as a constant; the CLI-compat follow-up re-checks them on upgrade. A unit test asserts the spawned spec always contains the deny entries for `Bash` and a file-write tool **regardless of** what `AllowedTools` the caller passes. **The CLI's flag precedence between `--allowedTools` and `--disallowedTools` is undocumented (§ 9), so the unit test only proves the spec data structure, not runtime enforcement** — manual P1 validation (§ 7) must empirically confirm `--disallowedTools` wins (spawn a turn that would invoke `Bash` with `Bash` named in both lists and confirm it is denied). Defense-in-depth: because `Bash` is never placed in `--allowedTools`, a deny-loses precedence would still leave it un-allowed.
- **`AppendSystemPrompt` is operator-config-sourced, not per-call untrusted input.** It is passed via `--append-system-prompt` and carries operator-authored system text, **not** the untrusted PR/diff content (that flows through the user turn, above). Content sanitization of the system prompt is out of scope here (PR3 gate); this slice's obligation is only that callers cannot smuggle untrusted per-call content into this flag — documented as a single-spawn window. (If a future consumer wants to surface user text into the system prompt, that is the consumer's sanitization obligation, gated at PR3.)
- No credential/PAT passed to `claude`.

## 7. Testing strategy

Fake-`IStreamingCliProcess` unit tests (no real spawn):
- **Parser/mapping:** scripted stdout (real § 9 samples in `.scratch` as fixtures) → assert the `LlmEvent` sequence: init→id captured; text_delta→`LlmTextDelta`; `assistant` tool_use block→one `LlmToolUse`; `result`→`LlmTurnComplete` with correct tokens/cost. The `is_error`→`LlmTurnError` then `LlmTurnComplete` case uses a **hand-authored** fixture (no `is_error=true` was captured, § 9) per the § 5.6 designed shape.
- **Text not double-counted:** a fixture carrying both `stream_event` `text_delta`s and the duplicate `assistant` full-message text → exactly one `LlmTextDelta` per delta, none from the `assistant` copy.
- **Multi-turn:** two scripted turns → two `LlmTurnComplete`s, one stable `ProviderSessionId`, **and per-turn token/cost asserted distinct** (turn N's `.usage`/cost not leaked into turn N+1).
- **Turn-completion decoupling:** with a live `Events` consumer draining the channel, `EndCleanlyAsync` observes turn completion via the TCS **without** the consumer losing any event (assert the consumer's received sequence is complete).
- **Trip-before-write (stalled consumer):** with a consumer that does **not** drain `Events` so the channel is full at the terminal `result`, `EndCleanlyAsync` still returns `true` promptly (the TCS tripped before the blocking write) — guards against the trip-after-write deadlock regression.
- **Sequential enforcement (carry-forward):** `SendUserTurnAsync` throws `InvalidOperationException` synchronously while a turn is in flight; content not written to the fake's stdin; session still usable. `turnInFlight` clears on **both** success and `is_error` turns (second send succeeds after either).
- **`ProviderSessionId` temporal (carry-forward):** empty before init line; non-empty after.
- **Unrecoverable death:** fake signals process exit mid-turn → `Events` enumeration throws `LlmProviderException`.
- **Back-pressure:** a blocked consumer stalls the reader at channel capacity (assert no unbounded growth) — bounded via cap 1024 `Wait`; on resume the consumer receives the buffered events in order (recoverable, not a deadlock).
- **`EndCleanlyAsync`:** clean (await completion, `true`) vs timeout (`false`) vs cancelled-`ct` (forced-end `false`, no throw) vs **zero turns sent** (awaits init only → `true`, non-empty `ProviderSessionId`).
- **`DisposeAsync`:** cancels + requests KillTree; idempotent; **dispose racing an in-flight stdin write** drains the write and swallows the broken-pipe `IOException` (no exception escapes dispose).
- **User-turn framing:** a prompt containing `"`, `\n`, and a literal `}{"type":"user"…` is JSON-serialized into **exactly one** well-formed NDJSON frame (no frame-break / control-event injection).
- **WorkingDirectory confinement:** a `..`-traversal path and a symlink fixture pointing outside the base are **rejected** before spawn — the symlink test asserts the link is *resolved* (`Directory.ResolveLinkTarget`) and rejected, not lexically passed by `Path.GetFullPath`.
- **Tool deny list is unconditional:** the spawned spec always carries the deny entries for `Bash` and a file-write tool **even when** caller `AllowedTools` names `Bash` (deny wins).
- **Drift guard (§ 9.1):** an unmappable `init`/`result` fixture logs the unrecognized-envelope `warn`; a turn with a terminal `result` but zero `text_delta`s logs the suspect `warn`; a mismatched live CLI version logs the version `warn`-and-continue.
- **Registration:** `AddPrismClaudeCode` resolves `IStreamingLlmProvider` → `ClaudeCodeStreamingProvider` (real wins over the Slice-1 `TryAdd` Noop default); singleton.
- **Env-allowlist parity + completeness (carry-forward):** the spawned spec's env equals `ClaudeCliEnvironment.BuildAllowlisted()`; **and** no allowlisted key matches a credential-bearing pattern (`GITHUB_TOKEN`/`GH_TOKEN`/`*_PAT`/`*_SECRET`/`*_KEY`/`*_PASSWORD`/`*_CREDENTIAL`), run under CI env.

The wire shapes the fakes assert against are now **captured** (§ 9: text-equivalence, both `is_error` shapes, `tool_use`) — the § 9 raw outputs become the fixture corpus. Manual P1 confirms the end-to-end real-spawn behavior the fakes cannot, plus the one item still unverified (flag precedence):

**Manual P1 validation** (real `claude`, documented in PR Proof):
- a multi-sentence turn emits ≥1 `LlmTextDelta` + one `LlmTurnComplete` with `FullText` == concatenated deltas (regression-checks the § 9 equivalence on the target machine);
- an `is_error=true` turn (invalid `--model`) emits `LlmTurnError`(Code=`"404"`) then `LlmTurnComplete`, and an `error_max_turns` turn emits `LlmTurnError`(Code=`error_max_turns`) then `LlmTurnComplete` with `FullText=""`;
- a tool-requiring turn emits exactly one `LlmToolUse` (from the `assistant` block, streaming form suppressed) within a single turn;
- **flag-precedence (still unverified):** spawn with `Bash` named in **both** `--allowedTools` and `--disallowedTools` on a turn that would shell out, and confirm `Bash` is denied (closes the § 6 undocumented-precedence assumption — the only § 9 shape not yet captured);
- dispose mid-generation exits the process <2s;
- uninstalled CLI → provider stays dark.

## 8. Exit criteria
- [ ] `IStreamingCliProcessFactory` + `IStreamingCliProcess` + `SystemStreamingCliProcess`; `StreamingProcessSpec`; `ClaudeCodeStreamingProvider`/`Session`; `LlmTurnError` added to contracts.
- [ ] Turn-completion TCS decoupled from the channel; back-pressure semantics (§ 3) implemented; wire-drift guard (§ 9.1) shipped.
- [ ] Real-provider registration in `AddPrismClaudeCode`; Slice-1 `TryAdd` default no-ops (test).
- [ ] All § 7 unit tests green (incl. security: canonical-path confinement, unconditional deny list, JSON-framed user turn, env completeness); full backend suite green; secrets scan clean.
- [ ] Manual real-CLI validation recorded in the PR `## Proof` — incl. the `FullText`==deltas check and one provoked `is_error` turn (§ 7).
- [ ] 2× `ce-doc-review` dispositions recorded; owner B2 gate cleared.
- [ ] #478 carry-forward checklist fully addressed (the items the real provider can now test).

## 9. Empirical wire format — verified against `claude` v2.1.177 (2026-06-14)

Captured via bounded probes (raw outputs preserved in `.scratch/`, gitignored). **Officially undocumented — this is the ground truth this slice builds on; re-verify on CLI upgrades (the spec's CLI-compatibility-suite follow-up).**

**Invocation (flags):**
```
claude -p --verbose --input-format stream-json --output-format stream-json \
  --include-partial-messages --model <model> --append-system-prompt <sys> \
  [--allowedTools ...] [--disallowedTools ...]
```
- `--verbose` is **required** with `--print --output-format stream-json` (CLI errors otherwise).

**Input (stdin, one NDJSON line per user turn):**
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

**Output (stdout, NDJSON), verified samples:**
```json
{"type":"system","subtype":"init","session_id":"fd63a7f1-...", ... "tools":[...], "model":...}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}
{"type":"result","subtype":"success","is_error":false,"result":"hello",
 "total_cost_usd":0.0375,"usage":{"input_tokens":10,"output_tokens":142,"cache_read_input_tokens":21105},
 "num_turns":1,"stop_reason":...,"session_id":"fd63a7f1-..."}
```
Also observed: `assistant` (full message, `.message.content[]` of `thinking`/`text`), `message_start/message_delta/message_stop` and `content_block_start/stop` framing inside `stream_event`, `thinking_delta`/`signature_delta` (extended-thinking deltas), and a `rate_limit_event` (advisory; turn still completed `success`). **The `assistant`/`message` full-message lines duplicate the same `text` already delivered via `stream_event` `text_delta` — confirmed by inspection — which is why § 4 maps text from the deltas only and ignores the full-message copy (else the turn's text doubles).**

**`result` ↔ deltas equivalence (VERIFIED).** On a multi-sentence turn (probe 3: *"Write exactly three short sentences about the color blue"*) `.result` equals the concatenation of the turn's three `text_delta`s **character-for-character**, with the `thinking`/`signature_delta` blocks correctly excluded from the text path. So `FullText=.result` is a safe stand-in for the streamed deltas, not an assumption.

**`is_error=true` shape (VERIFIED, two distinct shapes).** Two error turns were provoked:
- **API error** (probe 4a, `--model <invalid>`): `{"subtype":"success","is_error":true,"api_error_status":404,"result":"There's an issue with the selected model …","total_cost_usd":0,"usage":{…zeros}}` — note `subtype` is `"success"` despite `is_error:true`; the real code is `api_error_status`.
- **Agent error** (probe 4b, `--max-turns 1` on a tool prompt): `{"subtype":"error_max_turns","is_error":true,` **no `result` key**`,"api_error_status":null,"total_cost_usd":0.31,"usage":{…}}` — here `subtype` carries the code and `.result` is absent.
Both then exited the process (exit 1). This is the empirical basis for § 5.1 (turn-level error ≠ session alive), § 4 (`is_error` is the authoritative boolean; `Code` = non-`"success"` `subtype` else `api_error_status`), and § 5.6 (`.result` may be absent → `FullText=""`).

**`tool_use` shape (VERIFIED).** A tool turn (probe 5: *"Use the Read tool to read .scratch/tiny.txt"*, `--allowedTools Read`) emitted the complete block on the `assistant` event — `{"type":"assistant","message":{…"content":[{"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"…"}}]}}` — **and** a parallel streaming representation inside `stream_event` (`content_block_start` with `input:{}` then `input_json_delta` accumulation). Sourcing from the `assistant` block and ignoring the streaming form yields exactly one `LlmToolUse`. The turn looped internally (`num_turns:2`: tool call → answer) but produced **one** `result` (`is_error:false`, `result:"ABC123-XYZ"`).

**Multi-turn (the load-bearing confirmation):** two user lines on one stdin → **two `result` events** (`num_turns:1` each), **one `session_id`** across both → a single persistent process serves sequential turns; **`result` is per-turn and terminal**. Closing stdin after a turn → process exits 0 (clean end).

### 9.1 Wire-drift guard (shipped in this slice)

The § 7 fixtures freeze the v2.1.177 shapes, so the unit suite stays green even after the live CLI changes a field — production parsing would then silently stop emitting `LlmTextDelta` and consumers would render **empty turns with no failure signal**. To make drift observable without waiting for the deferred CLI-compat suite, this slice ships a minimal guard, both halves cheap:

1. **Version assertion at session start.** The provider records the probed CLI version (`2.1.177`) as a constant and, on the first spawn (or via `claude --version` at startup), logs a loud `warn`-and-continue when the live version differs — a breadcrumb that points at § 9 re-verification when a downstream feature later misbehaves.
2. **Unrecognized-envelope diagnostic.** When the parser sees an `init`- or `result`-position line whose shape it cannot map (missing the fields § 4 depends on), it logs a structured `warn` rather than silently dropping it — so a rename on those two **load-bearing** lines surfaces as a signal. The turn-termination liveness rule (§ 4) already hard-fails an unmappable `result`, so that half is enforced, not just logged.
3. **Zero-output suspect heuristic (the text-path backstop).** A rename on the `text_delta` path lands on a `stream_event` line, which § 4 otherwise *ignores* — so the parser cannot distinguish a renamed delta from a legitimately-ignored `message_delta`/`signature_delta`, and item 2 does **not** catch it. The only backstop is: a turn that produced a terminal `result` **and** emitted zero `LlmTextDelta` **and** zero `LlmToolUse` is logged as suspect (the tool-only and zero-and-tool cases are excluded so normal tool turns don't false-fire). **Be honest about the limit:** this is heuristic, not reliable — a partial rename that still matches *some* deltas slips it. The real guarantee for the text path is the **manual § 9 re-verification on CLI upgrade** (item 1's version `warn` is the trigger to do it); §9.1's in-process checks are a cheap early-warning, not a substitute.

These guards cover the gap the recoverable/unrecoverable taxonomy (§ 5.1) does not: the "process alive, `result` arrives, but intermediate shapes changed → deltas dropped" case falls in neither bucket and would otherwise complete "successfully" with degraded content. Items 1+2 make `init`/`result` drift loud; item 3 makes text-path drift *detectable-but-not-guaranteed*, deferring the hard guarantee to the version-gated re-verify.

## 10. Risk & gates
T3, gated B2 (subprocess/egress). Owner reviews this spec before plan/impl. `ce-doc-review` 2× is the machine sign-off; human merge is the boundary. Real-CLI behavior can shift on Anthropic CLI updates — § 9 must be re-verified then (tracked CLI-compat follow-up).
