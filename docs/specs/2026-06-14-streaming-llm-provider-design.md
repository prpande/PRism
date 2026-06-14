# Streaming LLM provider (P0-1b / #404) — design

- **Issue:** [#404 — [AI] P0-1b — Streaming LLM provider (stream-json session)](https://github.com/prpande/PRism/issues/404)
- **Roadmap:** backlog `01-P0-foundations.md` § P0-1 (streaming-path bullets); seam contract in `spec/04-ai-seam-architecture.md` § "`ILlmProvider` and `IStreamingLlmProvider`".
- **Base branch:** `V2` (AI feature track), not `main`.
- **Tier / risk:** T3, **gated** (B2 — AI foundation seam + subprocess/egress lifecycle; `needs-design`). The owner reviews this spec before the plan/implementation of any subprocess-bearing slice.

## 1. Problem & context

`ILlmProvider` is one-shot **by design** — its own doc comment states *"A streaming/chat provider (v3) is deliberately NOT defined here."* V2 shipped only the one-shot path (`ClaudeCodeLlmProvider.CompleteAsync` over `claude -p --output-format json`). Every sustained-conversation feature — PR chat (#412, the headline v2-AI feature) and the lazy/streamed per-hunk annotation UX (#414) — needs a **streaming session**: a persistent `claude` subprocess driven over `--input-format stream-json --output-format stream-json`, emitting incremental events the backend relays to the UI.

This is **P0-1b**, the unshipped streaming subset of P0-1. It is the long pole for chat and a prerequisite (with #405 GitRepoCloneService and #406 MCP server) for chat-with-repo-access.

**Why slice it.** The full streaming path is large and carries two distinct sources of risk: (a) persistent-pipe subprocess lifecycle (back-pressure, cancellation, graceful end), and (b) an **empirically undocumented** `claude --resume` behavior (verification-notes § C4) that gates cross-restart chat resume. Bundling both into one PR produces an un-reviewable, high-risk change. Instead we land the **contract first** (small, pure, low-risk — unblocks #414/#412 targeting), then the implementation and the `--resume` probe as separate, contained child issues.

## 2. Scope & non-goals

**In scope — this PR (Slice 1):**
- Net-new streaming contracts in `PRism.AI.Contracts/Provider/`: `IStreamingLlmProvider`, `IStreamingLlmSession`, `StreamingSessionOptions`, the `LlmEvent` hierarchy, `SessionEndState`.
- A `NoopStreamingLlmProvider` / `NoopStreamingLlmSession` reference implementation, registered **dark** (no consumer resolves it yet) so the seam is resolvable and test-doublable, and so Slice 2's real provider has a clean override point.
- Unit tests pinning the Noop's contract behavior and the dark registration.

**Out of scope — tracked as child issues / deferrals (§ 8–10):**
- The Claude Code streaming implementation (subprocess, channel, parser) — **Slice 2**, child issue.
- The C4 `--resume` empirical probe + cross-restart decision — **Slice 3**, child issue/spike.
- Any feature seam consuming streaming (chat #412, lazy hunk load #414). #414 ships its one-shot version now against the existing `ILlmProvider`; it converges with streaming only at its later streamed-load slice.
- Frontend / SSE relay of stream events — a chat-feature concern, not this substrate.
- A second substrate (Ollama, Anthropic API). The contract is **shaped for Claude Code** (see § 4.2); multi-substrate is aspirational and explicitly out of scope.

## 3. Decomposition (roadmap & tracking)

| Slice | Deliverable | Risk | Where |
|-------|-------------|------|-------|
| **1 — Contracts** | `IStreamingLlmProvider` + `IStreamingLlmSession` + `StreamingSessionOptions` + `LlmEvent` hierarchy + `SessionEndState`; dark `NoopStreamingLlmProvider`. Pure contract, no subprocess. | Low (B2 by virtue of being an AI foundation seam, but no runtime egress) | **This PR** |
| **2 — Claude Code impl** | Persistent-pipe process seam; `ClaudeCodeStreamingProvider`; background stdout reader → bounded `Channel<LlmEvent>` (cap 1024, `Wait`); stream-json parser; `SendUserTurnAsync`; `Events`; dispose-cancels-within-2s; `EndCleanlyAsync`. | High (subprocess + egress) | Child issue |
| **3 — `--resume` probe** | Run verification-notes § C4 clean-end resume probe; record which of three outcomes holds; pin the P2-2 cross-restart resume UX and the `ResumeSessionId` contract semantics accordingly. | Medium (empirical gate; documents, doesn't ship a feature) | Child issue / spike |

Slices are **sequential**: 2 depends on 1; 3 depends on 2 (the probe drives a live session). Slice 1 is independently mergeable and immediately useful as a compile target for #414/#412 design.

## 4. Slice 1 — streaming contracts

### 4.1 Interface & DTO listing (as shipped this PR)

All in namespace `PRism.AI.Contracts.Provider`.

```csharp
/// <summary>Sustained, multi-turn streaming LLM session factory. The v3 counterpart to the
/// one-shot <see cref="ILlmProvider"/>. v2 ships one impl (Claude Code, Slice 2); the dark default
/// is <see cref="Noop.NoopStreamingLlmProvider"/>.</summary>
public interface IStreamingLlmProvider
{
    IStreamingLlmSession StartSession(StreamingSessionOptions options);
}

/// <summary>One live streaming conversation. Caller drives turns with
/// <see cref="SendUserTurnAsync"/> and reads incremental output from <see cref="Events"/>.
/// Disposal cancels any in-flight generation and tears down the underlying session.</summary>
public interface IStreamingLlmSession : IAsyncDisposable
{
    /// <summary>The underlying provider's session id — load-bearing for cross-restart resume
    /// (Slice 3 pins the exact `--resume` semantics; see § 6). TEMPORAL CONTRACT: it is populated
    /// from the provider's init event and is non-empty by the time the first caller-observable
    /// <see cref="Events"/> item of the first turn arrives. (A caller cannot observe the internal
    /// init read; the earliest it can read a guaranteed-valid id off this property is after that
    /// first <see cref="Events"/> item — which for a zero-delta turn is the terminal
    /// <see cref="LlmTurnComplete"/> — or, most simply, from <see cref="SessionEndState.ProviderSessionId"/>.)
    /// It is empty ONLY if the session never reached init (the process failed to start), which is
    /// always paired with <c>LastTurnEndedCleanly = false</c>; callers must not persist an empty id.</summary>
    string ProviderSessionId { get; }

    /// <summary>Submit one user turn. Turns are STRICTLY SEQUENTIAL: the session processes one turn
    /// at a time, so a caller MUST await the prior turn's <see cref="LlmTurnComplete"/> on
    /// <see cref="Events"/> before calling this again. Pipelined/concurrent turns are not supported.
    /// If called before the prior turn completes, the implementation throws
    /// <see cref="InvalidOperationException"/> SYNCHRONOUSLY (it does not return a faulted Task), so
    /// the rejected content is guaranteed NOT enqueued and the session REMAINS USABLE — the caller
    /// may await the in-flight turn's <see cref="LlmTurnComplete"/> and retry. This is distinct from
    /// the unrecoverable-death throw on <see cref="Events"/>. The sequential model is what lets the
    /// un-tagged <see cref="Events"/> stream be unambiguous (see <see cref="Events"/>).</summary>
    Task SendUserTurnAsync(string content, CancellationToken ct);

    /// <summary>One event stream for the session's lifetime, in arrival order. Because turns are
    /// strictly sequential, every <see cref="LlmTextDelta"/> / <see cref="LlmToolUse"/> between two
    /// <see cref="LlmTurnComplete"/> events belongs to the turn opened by the most recent
    /// <see cref="SendUserTurnAsync"/>. TURN-TERMINATION INVARIANT: EVERY turn — including one that
    /// fails recoverably — ends with exactly one <see cref="LlmTurnComplete"/>; that is the
    /// consumer's turn-loop terminal condition. ERROR MODEL: throwing from enumeration is reserved
    /// for UNRECOVERABLE session death (e.g. the subprocess died) — it terminates the session (the
    /// provider chooses the exception type; Claude Code throws its `LlmProviderException`, which the
    /// Contracts layer does not name). RECOVERABLE per-turn failures (a model/tool error that leaves
    /// the session usable) are deliberately NOT modeled in Slice 1: they will arrive as an additional
    /// *informational* <see cref="LlmEvent"/> subtype defined empirically in Slice 2 that PRECEDES
    /// the turn's terminal <see cref="LlmTurnComplete"/> — it NEVER replaces it. So a consumer that
    /// ignores unrecognized subtypes (which it MUST, for forward-compat) still terminates the turn on
    /// <see cref="LlmTurnComplete"/> rather than hanging.</summary>
    IAsyncEnumerable<LlmEvent> Events { get; }

    /// <summary>End the session at a turn boundary: wait for the current turn's
    /// <see cref="LlmTurnComplete"/> (up to <paramref name="gracefulTimeout"/>), then signal the
    /// underlying session a clean exit and COMPLETE the <see cref="Events"/> enumeration (a
    /// concurrent reader's `await foreach` ends normally). It awaits session init first, so a cleanly
    /// ended session — EVEN ONE WITH ZERO TURNS SENT — returns a non-empty
    /// <see cref="SessionEndState.ProviderSessionId"/>. On a clean boundary returns
    /// <c>LastTurnEndedCleanly = true</c>; on timeout, or a session that never initialized, falls
    /// back to forced termination and returns <c>false</c> (then, and only then, the id may be empty).
    /// The boolean reports only that a clean turn boundary was reached — whether that makes the
    /// session resumable is PROVISIONAL pending the Slice-3 § C4 probe (§ 6).
    /// <see cref="IAsyncDisposable.DisposeAsync"/> remains required after this call and is an
    /// idempotent no-op.</summary>
    Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct);
}

public sealed record SessionEndState(bool LastTurnEndedCleanly, string ProviderSessionId);

/// <summary>Per-session options. SHAPED FOR CLAUDE CODE (see § 4.2). Null fields fall back to the
/// provider's configured defaults. Trimmed to the fields a Slice-1/Slice-2 consumer actually needs;
/// fields whose only consumer is a later slice are DEFERRED (added when that slice lands — see below
/// and § 4.3).</summary>
public sealed record StreamingSessionOptions(
    string? Model = null,                 // --model; null => provider's configured default
    string? AppendSystemPrompt = null,    // --append-system-prompt; NOT sanitized here (PR3's gate, § 7)
    string? WorkingDirectory = null,      // session cwd; null => provider default (stable, non-git)
    IReadOnlyList<string>? AllowedTools = null,    // --allowedTools (Slice-2 chat tool-gating)
    IReadOnlyList<string>? DisallowedTools = null); // --disallowedTools
// DEFERRED — each is a nullable optional param appended at the end when the slice that introduces
// its first consumer lands, so the addition is source-non-breaking for existing callers:
//   • AddDirs (IReadOnlyList<string>, --add-dir)   — repo-access "state 2"; no consumer in slices 1–3.
//   • ResumeSessionId (string, --resume <id>)      — added in Slice 3 once § C4 pins its semantics.
//   • McpConfigPath (string, --mcp-config)         — added with the P0-7 MCP server.

/// <summary>A streaming event. Open hierarchy (NOT sealed) — consumers switch on known subtypes
/// with a default arm so a future subtype (e.g. an error event) is non-breaking.</summary>
public abstract record LlmEvent;

/// <summary>Incremental assistant text.</summary>
public sealed record LlmTextDelta(string Text) : LlmEvent;

/// <summary>The model invoked a tool. <paramref name="Input"/> is the raw tool input as reported
/// by the provider; the host does not interpret it for non-MCP tools.</summary>
public sealed record LlmToolUse(string ToolName, JsonElement Input) : LlmEvent;

/// <summary>Terminal event for one turn: the assembled full text plus usage. Token fields are
/// FLATTENED to match the shipped one-shot <see cref="LlmResult"/> (see § 4.3).</summary>
public sealed record LlmTurnComplete(
    string FullText,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    decimal EstimatedCostUsd) : LlmEvent;
```

### 4.2 Honest framing — the contract is shaped for Claude Code

Carried verbatim from `spec/04-ai-seam-architecture.md`: `AddDirs`, `AllowedTools`, `DisallowedTools`, `ResumeSessionId`, `McpConfigPath` are Claude-Code concepts. A future `AnthropicApiLlmProvider`/`OllamaLlmProvider` would ignore most of them. **v2's shipped substrate is Claude Code**; the substrate-neutral interface *name* is aspirational. If a second substrate ever ships (Ollama, P4-N4), `StreamingSessionOptions` refactors into a substrate-specific discriminated union — a coordinated `PRism.Core` change ahead of that substrate, consistent with the per-feature reshape policy. Documented now so the reshape is not surprising. **Not built now.**

### 4.3 Contract reconciliation — three calls (drift from the year-old sketch)

The spec sketch in `04-ai-seam-architecture.md` predates what P0-1 actually shipped. We reconcile to **shipped reality**, not the sketch:

1. **Terminal event renamed `LlmResult` → `LlmTurnComplete`.** The shipped one-shot result is already `LlmResult(Text, InputTokens, OutputTokens, CacheReadInputTokens, EstimatedCostUsd)` in this same namespace; the sketch's `LlmResult : LlmEvent` would be a hard name collision. `LlmTurnComplete` also reads correctly as a per-turn streaming signal (a session has many).

2. **No `ProviderId` on the interface.** The sketch put `ProviderId` on both provider interfaces; the shipped `ILlmProvider` dropped it in favor of the `ProviderCapabilityDescriptor` / `ClaudeProviderDescriptor` pattern. The streaming interface follows the shipped convention — provider identity lives on the descriptor, not the seam.

3. **Flattened token fields (no phantom `TokenUsage` record); session fields added.** The sketch's `LlmResult(FullText, TokenUsage?)` references a `TokenUsage` record that **does not exist** in shipped code (the one-shot flattened the fields onto `LlmResult`, and `TokenUsageRecord` is a tracker-only shape). Inventing a parallel token model is exactly the drift to avoid, so `LlmTurnComplete` flattens **the same four *token* fields** as `LlmResult` (`InputTokens/OutputTokens/CacheReadInputTokens/EstimatedCostUsd`). The "match shipped `LlmResult`" claim is about those token fields, **not** the text field name: `LlmTurnComplete.FullText` is deliberately *not* called `Text`, because in a streaming context it must read distinctly from `LlmTextDelta.Text` (a partial chunk) — `FullText` is the assembled whole-turn text. (A shared token value-object reused by both records is a deliberate non-goal here: it would require editing the shipped/tested `LlmResult`, out of scope for a contract-only slice — a possible future tidy.) Separately, `StreamingSessionOptions` gains `Model` + `AppendSystemPrompt`: the one-shot supplies these per-call via `LlmRequest`, but a streaming session has no per-call request object, so they belong on the session options.

4. **Collections are `IReadOnlyList<string>`, not `string[]`.** The sketch typed `AllowedTools`/`DisallowedTools` as `string[]`; the contract uses `IReadOnlyList<string>` to enforce immutability at the seam boundary (a caller cannot mutate an array the provider holds).

5. **`StreamingSessionOptions` is trimmed to its Slice-1/Slice-2 consumers.** Doc-review (scope-guardian + product-lens + adversarial) converged on this: shipping option fields whose only consumer is a *later* slice freezes unvalidated surface into a foundation seam that #412/#414 compile against. `AddDirs` (repo-access state 2) and `McpConfigPath` (P0-7 MCP server) have **no consumer in slices 1–3**, and `ResumeSessionId`'s semantics are **empirically unknown until the Slice-3 § C4 probe** — so all three are deferred. They are nullable optional record params appended at the end when their slice lands, which is source-non-breaking for existing callers, so #412/#414 lose nothing by their absence now. Kept: `Model`, `AppendSystemPrompt`, `WorkingDirectory` (Slice-2 subprocess needs them) and `AllowedTools`/`DisallowedTools` — the latter are the session's **default-deny tool-restriction lever**, the streaming analogue of the one-shot's `--tools ""`; Slice 2's impl needs them to spawn safely (tools off by default), so they are core substrate, not a chat-only field like `AddDirs`.

### 4.4 Noop reference implementation + dark registration

`PRism.AI.Contracts/Noop/NoopStreamingLlmProvider.cs`:
- `NoopStreamingLlmProvider.StartSession` returns a `NoopStreamingLlmSession`.
- `NoopStreamingLlmSession`: `ProviderSessionId` returns a constant (`"noop-session"`); `SendUserTurnAsync` is a no-op; `Events` yields an empty async sequence; `EndCleanlyAsync` returns `new SessionEndState(true, ProviderSessionId)`; `DisposeAsync` is a no-op.

**Registration (dark).** Register `IStreamingLlmProvider → NoopStreamingLlmProvider` as the default singleton via a **dedicated registration that Slice 2 replaces in place** — it rewrites that one registration line to point at the real provider, rather than adding a second competing registration. This sidesteps an ordering trap doc-review (feasibility) caught against the live wiring: in `Program.cs`, `AddPrismClaudeCode` runs (line 78) *before* `AddPrismAi` → `AddNoopSeams` (line 81), so registering the streaming Noop inside `AddNoopSeams` would land it *after* a real provider added to `AddPrismClaudeCode`, and last-registration-wins would make the **Noop win** — the real streaming provider would silently never run. A single authoritative registration site (no second `AddSingleton` for the same interface) makes the order moot. This matches the intent of `04-ai-seam-architecture.md` line 851 (`AddSingleton<IStreamingLlmProvider, NoopStreamingLlmProvider>()` as the default) and § "v2 replaces the Noop registration." The seam-selector path that routes the per-feature `Noop*` services is **not** involved — the provider is an infra seam, not a flag-selected feature seam. Exact site (a new `AddStreamingProviderDefault` extension vs. folding the default into the method that will later host the real provider) is finalized during TDD; either way it is one registration line, asserted by the registration test.

### 4.5 Testing strategy (Slice 1)

Pure-contract slice, so tests pin behavior + wiring, not subprocess I/O:
- `NoopStreamingLlmSession.Events` completes empty; `EndCleanlyAsync` returns `LastTurnEndedCleanly = true` with the constant session id; `SendUserTurnAsync` / `DisposeAsync` complete without throwing.
- Registration test: the DI container resolves `IStreamingLlmProvider` to `NoopStreamingLlmProvider` by default (mirrors the existing `ServiceRegistrationTests` pattern).
- A compile-time "consumer" assertion is unnecessary — the interface existing is the deliverable; #414/#412 target it in their own PRs.

## 5. Slice 2 — Claude Code streaming implementation (child-issue design brief)

> **Scope note.** This section is an **informational design brief for the Slice-2 child issue**, not part of this spec's review/sign-off scope. Nothing here ships in this PR; it is re-reviewed at the child-issue gate. It exists so the child issue and the next session start from a complete design.

- **New persistent-pipe process seam.** The shipped `ICliProcessRunner.RunAsync(ProcessSpec, ct)` is run-to-completion (captures stdout, returns once) and cannot express a live session. Slice 2 adds a sibling seam (e.g. `IStreamingCliProcess` with `StdinWriter` + an stdout line stream + `KillTree`/`WaitForExit`), keeping `System.Diagnostics` isolated to one class exactly as `SystemCliProcessRunner` does today.
- **Security parity with the one-shot provider.** Reuse `ClaudeCliEnvironment.BuildAllowlisted()` (env allowlist excluding `ANTHROPIC_*`, proxy vars, `CLAUDE_CONFIG_DIR`), never `--bare`, `--output-format stream-json`. Tool access is gated via `AllowedTools`/`DisallowedTools` (not the one-shot's `--tools ""`); `--add-dir` repo access (`AddDirs`) is the later repo-access slice's concern, not Slice 2's.
- **Concrete tool cap (Slice-2 acceptance criteria, per § 7 invariant).** Default-deny: spawn with tools disallowed (the streaming analogue of the one-shot `--tools ""`). The server-side allowlist permits only MCP-registered tools plus a fixed read-only built-in set; it force-denies dangerous built-ins (at minimum `Bash`, `computer-use`, and file-write tools) regardless of any caller-supplied `AllowedTools`. The authoritative permitted/denied lists are pinned in the Slice-2 child issue (derived from the Claude Code tool manifest at implementation time), and `ClaudeCliEnvironment.BuildAllowlisted()` parity is a Slice-2 acceptance test, not assumed by inheritance.
- **Bounded channel + back-pressure.** Background reader parses line-delimited stream-json from stdout into `Channel<LlmEvent>` (cap 1024, `BoundedChannelFullMode.Wait`). The bound is load-bearing: a blocked consumer back-pressures the reader and stalls the subprocess on its stdout write — preferable to unbounded buffering that would OOM the backend on runaway output.
- **stream-json mapping.** Map CLI event kinds → `LlmTextDelta` / `LlmToolUse` / `LlmTurnComplete`; capture `ProviderSessionId` from the init/system event; surface fatal errors by throwing `LlmProviderException` from the `Events` enumeration.
- **`SendUserTurnAsync`.** Serialize a stream-json user message to the persistent stdin, concurrently (never block the timeout), reusing the deadlock-avoidance discipline from `SystemCliProcessRunner.WriteStdinAsync`.
- **Disposal within 2s.** `DisposeAsync` cancels the in-flight call and kills the process tree; acceptance: process exits within 2 seconds (backlog P0-1 criterion).
- **`EndCleanlyAsync`.** Wait for the current turn's `LlmTurnComplete` up to `gracefulTimeout`, close stdin, await exit; set `LastTurnEndedCleanly` accordingly.
- **Availability / capability** reuse `ClaudeCodeAvailabilityProbe` and `ClaudeProviderDescriptor` (no new descriptor axis).
- **Manual validation** against the real `claude` binary (the one-shot provider's tests don't spawn; real invocation is validated manually in P1). Acceptance: a "say hello" turn emits ≥1 `LlmTextDelta` and one `LlmTurnComplete`.

## 6. Slice 3 — C4 `--resume` empirical probe (child issue / spike)

Not built in this PR. The **load-bearing empirical gate** for cross-restart chat resume (P2-2 / #412). Per verification-notes § C4, run the clean-end resume probe against the real CLI:

1. Start a stream-json session; send a turn; capture `LlmTurnComplete`.
2. Close stdin; await exit; capture `ProviderSessionId`.
3. `claude -p --resume <id>` with the same flags; send a follow-up referencing the prior turn ("what did I just ask?"); verify recall.

Record **which of three outcomes** holds (full-context resume / session-id-only / resume-fails) in the project README and pin the P2-2 "Resumed your chat" UX + the `ResumeSessionId` contract semantics accordingly. The dangling-`tool_use` resume probe and the CLI-update-survival probe are forward-compat (non-gating) and stay tracked but unrun.

## 7. Security & egress

- Slice 1 ships **no runtime egress** — pure types + a Noop that does nothing. No subprocess, no network, no filesystem.
- Slices 2–3 (subprocess) inherit the one-shot provider's security invariants verbatim: env allowlist (no `ANTHROPIC_*`/proxy/`CLAUDE_CONFIG_DIR` leakage), no `--bare`, PAT/credential never passed to `claude`. Egress review happens at those child-issue gates, not here.
- **Contract-level invariants the tool/path/session fields must carry** (recorded now as firm requirements so the introducing slice's gate enforces them; concrete enumerations live in the child-issue acceptance criteria, per doc-review security-lens + scope-guardian):
  - **`AppendSystemPrompt` is not sanitized at the provider** — same as the one-shot's `LlmRequest.SystemPrompt` (PR3's sanitization gate owns user-edited instruction content). STREAMING-SPECIFIC: because a session is spawned once, `--append-system-prompt` is evaluated at session-start only — the sanitization window does NOT reopen per turn (unlike the one-shot's per-call window). A caller MUST NOT route content whose source can mutate after spawn (e.g. a PR description) through `AppendSystemPrompt`; if the source changes, the session must be torn down and re-spawned, not resumed.
  - **Path confinement (incl. the *shipped* `WorkingDirectory`)** — `WorkingDirectory` (ships in Slice 1) and, when they land, `AddDirs`/`McpConfigPath` MUST be confined to an operator-sanctioned base directory (the per-PR clone/worktree root, or the app data dir) and anything resolving outside it rejected, rather than passed verbatim to the subprocess cwd / `--add-dir` / `--mcp-config`. An unconfined cwd or dir is a model-readable-filesystem vector; an unconfined mcp path is an attacker-controlled-MCP-server vector. Enforcement lands in Slice 2 (Slice 1 ships only a Noop), but the invariant binds the Slice-2 gate — `WorkingDirectory` is **not** exempt just because it shipped early.
  - **Tool allowlist cap** — `AllowedTools` is not a blank check: Slice 2 MUST enforce a server-side allowlist cap plus a forced-deny set that callers cannot override. The concrete permitted/denied sets are defined in the Slice-2 child issue's acceptance criteria (examples in § 5), not frozen here.
  - **Session-id scoping** — `ProviderSessionId` / a future `ResumeSessionId` are user-/PR-scoped opaque values: never stored in shared state, never returned to a caller who did not originate the session. Ownership verification for any `--resume` path is enforced at the **application service layer** (the component mapping an incoming request to a resume call), not at `IStreamingLlmProvider`/`IStreamingLlmSession`, and is an explicit acceptance criterion of the Slice-3 child issue.
- Token discipline (v2-ai-effort.md § 7) is unchanged: recovery on failure is a deliberate user action (no auto-retry), and every consuming feature carries a backend-enforced `userEnabled` toggle. The streaming substrate adds no auto-retry.

## 8. Tracked deferrals

- **Dangling-`tool_use` `--resume` probe** — forward-compat, non-gating (sessions ending uncleanly fall through to fresh-with-injection). Tracked in Slice 3's issue as an unchecked box.
- **CLI-compatibility test suite** (spec line 823) — assert `--version` shape + stream-json event schema on CI against the latest CLI; P3 follow-up, separate issue.
- **`StreamingSessionOptions` → substrate discriminated-union refactor** — only if a 2nd substrate (Ollama, P4-N4) ships. Documented in § 4.2; no issue until that substrate is scheduled.
- **Shared token value-object** reused by `LlmResult` + `LlmTurnComplete` — a tidy that requires touching shipped code; optional, not scheduled.
- **Deferred `StreamingSessionOptions` fields** (§ 4.3 point 5): `AddDirs` (added by the repo-access slice), `ResumeSessionId` (added by Slice 3 once § C4 resolves), `McpConfigPath` (added with P0-7). Each is a non-breaking appended optional param.

## 9. Risk classification & gates

- **Tier:** T3. **Risk:** B2 (AI foundation seam; subprocess/egress in Slices 2–3) + `needs-design`. **Gated** — the owner reviews this spec/approach before the plan and before any subprocess-bearing slice.
- Slice 1 itself touches no egress and adds only contracts + a dark Noop, but it remains owner-gated because it sets the foundation seam shape that chat depends on.
- The human merge is the safety boundary; `ce-doc-review` (2×, T3) is the machine sign-off recorded in the PR `## Proof`.

## 10. Exit criteria (this PR — Slice 1)

**What this slice does and does not retire (per doc-review product-lens).** Slice 1 retires *"the streaming seam does not exist for #412/#414 to design and compile against"* and *"Core gets reshaped later to add it."* It does **not** retire *"the seam shape is correct"* — only a real implementation (Slice 2) and a real consumer exercise the shape under load. The contract is therefore shaped conservatively (strictly-sequential turns, open event hierarchy, deferred unconsumed fields) so that the corrections most likely to surface in Slice 2 are *additive* (a new `LlmEvent` subtype, an appended option field) rather than breaking changes to a seam consumers already target.


- [ ] Streaming contracts compile in `PRism.AI.Contracts/Provider/` with the reconciled shapes (§ 4.1, § 4.3).
- [ ] `NoopStreamingLlmProvider`/`NoopStreamingLlmSession` implemented and registered dark; DI resolves `IStreamingLlmProvider`.
- [ ] Unit tests green (Noop contract behavior + registration).
- [ ] Full backend build + test suite green; secrets scan clean.
- [ ] Child issues filed for Slice 2 and Slice 3, linked under #404, with the § 5 / § 6 detail.
- [ ] 2× `ce-doc-review` dispositions recorded in the PR `## Proof`; owner spec gate cleared.

## 11. Child issues to file (after spec sign-off)

- **Slice 2 — "[AI] P0-1b — Claude Code streaming provider (stream-json subprocess)"** — `area:ai`, `ai:foundation`; body = § 5 + acceptance from backlog P0-1; depends on this PR; blocks #412.
- **Slice 3 — "[AI] P0-1b — `claude --resume` clean-end empirical probe (C4 gate)"** — `area:ai`, `ai:foundation`; body = § 6; depends on Slice 2; gates #412 cross-restart resume. Adds the deferred `ResumeSessionId` field to `StreamingSessionOptions` once the probe pins its semantics.

Both cross-linked from #404; #404 stays open as the roadmap root until all slices land.
