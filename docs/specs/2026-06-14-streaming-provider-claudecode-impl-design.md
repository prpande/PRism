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
- All [#478 carry-forward acceptance criteria](https://github.com/prpande/PRism/issues/478).

**Out of scope / deferred:**
- `--resume` / cross-restart (Slice 3 / #479) — including the `ResumeSessionId` field.
- `AddDirs`/`--add-dir` repo access (later repo-access slice) and `McpConfigPath` (P0-7).
- Any feature consuming the session (chat #412, hunk-stream #414).
- Automated tests that spawn the real `claude` binary — per repo convention, real-CLI invocation is **manual P1 validation**; automated tests use a fake `IStreamingCliProcess`.

## 3. Architecture

```
ClaudeCodeStreamingProvider.StartSession(opts)
  └─ builds args (§9 flags) + env allowlist + ProcessSpec-like StreamingProcessSpec
  └─ IStreamingCliProcess.Start(spec)         // persistent process, redirected stdin/stdout
  └─ returns ClaudeCodeStreamingSession
        ├─ background Task: read stdout lines → parse NDJSON → map → Channel<LlmEvent>.Writer (Wait)
        ├─ Events  => channel.Reader.ReadAllAsync()
        ├─ ProviderSessionId  <- captured from system/init event
        ├─ SendUserTurnAsync  -> write one user NDJSON line to stdin (concurrent write)
        ├─ EndCleanlyAsync    -> await current turn's result, close stdin, await exit
        └─ DisposeAsync       -> cancel + KillTree, ensure exit <2s
```

**`IStreamingCliProcess` seam** (testable; keeps `System.Diagnostics` in one class):
```csharp
public interface IStreamingCliProcess : IAsyncDisposable
{
    IAsyncEnumerable<string> StdoutLines { get; }   // line-delimited stdout
    Task WriteLineAsync(string line, CancellationToken ct);  // append one NDJSON line to stdin
    Task CloseStdinAsync();                          // signal clean end
    Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct);  // returns exit code; kills tree on timeout
}
```
Tests inject a fake (scripted stdout lines, recorded stdin writes); the parser/session logic is verified without spawning. `SystemStreamingCliProcess` is the real impl, validated manually (§ 8).

## 4. Event mapping (verified against § 9)

| stream-json line | → `LlmEvent` |
|---|---|
| `type=system, subtype=init` | (no event) capture `.session_id` → `ProviderSessionId` |
| `type=stream_event, .event.type=content_block_delta, .event.delta.type=text_delta` | `LlmTextDelta(.event.delta.text)` |
| `type=stream_event, .event.type=content_block_start, .content_block.type=tool_use` (+ `input_json_delta` accumulation, or the `assistant` event's full `tool_use` block) | `LlmToolUse(name, input)` |
| `type=result, is_error=false` | `LlmTurnComplete(FullText=.result, tokens=.usage.*, cost=.total_cost_usd)` |
| `type=result, is_error=true` | `LlmTurnError(Message, Code=.subtype/.api_error_status)` **then** `LlmTurnComplete(...)` (informational event precedes the terminal — honors the Slice-1 contract) |
| other `system` / `rate_limit_event` / `assistant` / `message_*` framing | ignored in Slice 2 (open hierarchy lets consumers ignore; `rate_limit_event` is advisory, turn still completes — observed in § 9) |
| process exits with no `result` for the in-flight turn / nonzero exit / broken pipe | **throw `LlmProviderException`** from `Events` enumeration (unrecoverable session death) |

**Token mapping** (matches one-shot `LlmResult`): `InputTokens=.usage.input_tokens`, `OutputTokens=.usage.output_tokens`, `CacheReadInputTokens=.usage.cache_read_input_tokens`, `EstimatedCostUsd=.total_cost_usd`.

## 5. Open-fork resolutions (the design decisions Slice 1 left to here)

1. **Recoverable vs unrecoverable taxonomy.** Recoverable = a `result` arrives with `is_error=true` (the turn terminated, session still alive) → emit `LlmTurnError` (informational) then `LlmTurnComplete`. Unrecoverable = the process dies / pipe breaks / a turn yields no `result` → throw from `Events`. This matches the wire reality (§ 9) and the Slice-1 turn-termination invariant exactly.
2. **`LlmTurnError` shape.** `public sealed record LlmTurnError(string Message, string? Code) : LlmEvent;` added to `LlmEvent.cs`. Informational, non-terminal (always followed by `LlmTurnComplete` in the same turn). `Code` carries `result.subtype` (e.g. `error_max_turns`) or `api_error_status`.
3. **`EndCleanlyAsync` `ct` semantics.** A cancelled `ct` means "abandon the graceful wait now": stop waiting for the current turn's `result`, force-terminate (KillTree), and return `LastTurnEndedCleanly=false`. It does **not** throw `OperationCanceledException` — `EndCleanlyAsync` is a best-effort shutdown, so cancellation degrades to forced-end rather than propagating. (Distinct from `SendUserTurnAsync`/`Events`, where `ct`/abandonment surfaces normally.)
4. **`SendUserTurnAsync` ordering enforcement.** The session tracks a `turnInFlight` flag set on send, cleared on the turn's `LlmTurnComplete`. A second send while in flight throws `InvalidOperationException` **synchronously** (before writing to stdin) — content provably not enqueued, session usable (Slice-1 contract).
5. **`--verbose` is mandatory** (empirically required, § 9) and is always passed.

## 6. Security (carries the § 7 Slice-1 invariants)

- **Env allowlist:** reuse `ClaudeCliEnvironment.BuildAllowlisted()` verbatim; **a Slice-2 test asserts parity** (not assumed by inheritance, per the carry-forward).
- **No `--bare`**, `--output-format stream-json`.
- **`WorkingDirectory` confinement:** the provider rejects a `WorkingDirectory` outside the operator-sanctioned base dir (per-PR worktree root or app data dir) before spawn.
- **Default-deny tools:** spawn with tools disallowed; server-side allowlist permits only a fixed read-only built-in set (+ MCP tools when P0-7 lands) and force-denies `Bash`, `computer-use`, and file-write tools regardless of caller `AllowedTools`. Concrete lists pinned from the CLI tool manifest at implementation time (the `init` event's `tools` array enumerates available tool names — see § 9).
- **`AppendSystemPrompt`** passed via `--append-system-prompt`; not sanitized here (PR3 gate); single-spawn window documented.
- No credential/PAT passed to `claude`.

## 7. Testing strategy

Fake-`IStreamingCliProcess` unit tests (no real spawn):
- **Parser/mapping:** scripted stdout (real § 9 samples in `.scratch` as fixtures) → assert the `LlmEvent` sequence: init→id captured; text_delta→`LlmTextDelta`; `result`→`LlmTurnComplete` with correct tokens/cost; `is_error` result→`LlmTurnError` then `LlmTurnComplete`.
- **Multi-turn:** two scripted turns → two `LlmTurnComplete`s, one stable `ProviderSessionId`.
- **Sequential enforcement (carry-forward):** `SendUserTurnAsync` throws `InvalidOperationException` synchronously while a turn is in flight; content not written to the fake's stdin; session still usable.
- **`ProviderSessionId` temporal (carry-forward):** empty before init line; non-empty after.
- **Unrecoverable death:** fake signals process exit mid-turn → `Events` enumeration throws `LlmProviderException`.
- **Back-pressure:** a blocked consumer stalls the reader at channel capacity (assert no unbounded growth) — bounded via cap 1024 `Wait`.
- **`EndCleanlyAsync`:** clean (await result, `true`) vs timeout (`false`) vs cancelled-`ct` (forced-end `false`, no throw).
- **`DisposeAsync`:** cancels + requests KillTree; idempotent.
- **Registration:** `AddPrismClaudeCode` resolves `IStreamingLlmProvider` → `ClaudeCodeStreamingProvider` (real wins over the Slice-1 `TryAdd` Noop default); singleton.
- **Env-allowlist parity (carry-forward):** the spawned spec's env equals `ClaudeCliEnvironment.BuildAllowlisted()`.

**Manual P1 validation** (real `claude`, documented in PR Proof): a "say hello" turn emits ≥1 `LlmTextDelta` + one `LlmTurnComplete`; dispose mid-generation exits the process <2s; uninstalled CLI → provider stays dark.

## 8. Exit criteria
- [ ] `IStreamingCliProcess` + `SystemStreamingCliProcess`; `ClaudeCodeStreamingProvider`/`Session`; `LlmTurnError` added to contracts.
- [ ] Real-provider registration in `AddPrismClaudeCode`; Slice-1 `TryAdd` default no-ops (test).
- [ ] All § 7 unit tests green; full backend suite green; secrets scan clean.
- [ ] Manual real-CLI validation recorded in the PR `## Proof`.
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
Also observed: `assistant` (full message, `.message.content[]` of `thinking`/`text`), `message_start/message_delta/message_stop` and `content_block_start/stop` framing inside `stream_event`, and a `rate_limit_event` (advisory; turn still completed `success`).

**Multi-turn (the load-bearing confirmation):** two user lines on one stdin → **two `result` events** (`num_turns:1` each), **one `session_id`** across both → a single persistent process serves sequential turns; **`result` is per-turn and terminal**. Closing stdin after a turn → process exits 0 (clean end).

## 10. Risk & gates
T3, gated B2 (subprocess/egress). Owner reviews this spec before plan/impl. `ce-doc-review` 2× is the machine sign-off; human merge is the boundary. Real-CLI behavior can shift on Anthropic CLI updates — § 9 must be re-verified then (tracked CLI-compat follow-up).
