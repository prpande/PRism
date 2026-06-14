# Claude Code streaming provider (P0-1b Slice 2 / #478) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the real `claude` CLI streaming provider behind the Slice-1 contracts — a persistent multi-turn stream-json subprocess surfaced as `IStreamingLlmProvider`/`IStreamingLlmSession`.

**Architecture:** A new `IStreamingCliProcess` seam (the only new `System.Diagnostics` class) keeps process I/O testable. A background reader parses NDJSON stdout lines (`ClaudeStreamJson`) into a bounded `Channel<LlmEvent>`; a per-turn `TaskCompletionSource` (tripped **before** the blocking channel write) decouples turn-completion from the channel so `EndCleanlyAsync` never deadlocks. The provider builds the arg/env/working-dir spec enforcing every security invariant, and registers in `AddPrismClaudeCode` (winning over the Slice-1 `TryAdd` Noop default).

**Tech Stack:** .NET 10, C#, xUnit + FluentAssertions + Moq, `System.Threading.Channels`, `System.Text.Json`. Base branch **V2**.

**Authoritative spec:** `docs/specs/2026-06-14-streaming-provider-claudecode-impl-design.md` (§7 test list and §8 exit criteria drive the unit breakdown). Wire shapes are empirically captured (spec §9) from `claude` v2.1.177; raw probes in `.scratch/` (gitignored) are the fixture corpus.

---

## File Structure

**Create (production — `PRism.AI.ClaudeCode/`):**
- `IStreamingCliProcess.cs` — `IStreamingCliProcessFactory`, `IStreamingCliProcess`, `StreamingProcessSpec`.
- `ClaudeStreamJson.cs` — pure NDJSON line parser: one stdout line → `ParsedLine` (Init / TextDelta / ToolUse / Result / Ignored). DTO-free (uses `JsonDocument`).
- `ClaudeCodeStreamingSession.cs` — `ClaudeCodeStreamingSession : IStreamingLlmSession` (channel, reader loop, per-turn TCS, init TCS, `SendUserTurnAsync`, `EndCleanlyAsync`, `DisposeAsync`).
- `ClaudeCodeStreamingProvider.cs` — `ClaudeCodeStreamingProvider : IStreamingLlmProvider` (arg build, tool deny-list, working-dir confinement, `factory.Start`).
- `SystemStreamingCliProcess.cs` — `SystemStreamingCliProcessFactory` + `SystemStreamingCliProcess` (real `System.Diagnostics`; manual-P1 validated).

**Modify (production):**
- `PRism.AI.Contracts/Provider/LlmEvent.cs` — add `LlmTurnError`.
- `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs` — register `IStreamingCliProcessFactory` + `IStreamingLlmProvider` → `ClaudeCodeStreamingProvider`.
- `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs` — add `StreamingModel` default (optional) — only if a default model is needed; otherwise unchanged.

**Create (tests):**
- `tests/PRism.AI.Contracts.Tests/Provider/LlmTurnErrorTests.cs`
- `tests/PRism.AI.ClaudeCode.Tests/FakeStreamingCliProcess.cs` — scripted-stdout / recorded-stdin test double + factory.
- `tests/PRism.AI.ClaudeCode.Tests/ClaudeStreamJsonTests.cs`
- `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingSessionTests.cs`
- `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingProviderTests.cs`
- `tests/PRism.AI.ClaudeCode.Tests/StreamingServiceRegistrationTests.cs`

**Naming pinned across tasks** (avoid drift): `IStreamingCliProcessFactory.Start(StreamingProcessSpec)`, `IStreamingCliProcess.StdoutLines` / `.WriteLineAsync` / `.CloseStdinAsync` / `.WaitForExitAsync`, `ClaudeStreamJson.Parse(string) → ParsedLine`, `ClaudeCodeStreamingSession`, `ClaudeCodeStreamingProvider`.

---

## Task 0: Project wiring (internals visibility, logging, test logger)

Three prerequisites the later tasks depend on (verified against the current tree: `PRism.AI.ClaudeCode` has **no** `InternalsVisibleTo`; `ILogger` needs an explicit package ref; `CapturingLogger<T>` exists only in `GitHub.Tests`/`Web.Tests`, not in `ClaudeCode.Tests`).

**Files:**
- Modify: `PRism.AI.ClaudeCode/PRism.AI.ClaudeCode.csproj`
- Modify: `tests/PRism.AI.ClaudeCode.Tests/PRism.AI.ClaudeCode.Tests.csproj`
- Create: `tests/PRism.AI.ClaudeCode.Tests/TestHelpers/CapturingLogger.cs`

- [ ] **Step 1: Add `InternalsVisibleTo` + `ILogger` package ref to the production csproj** (the env-parity test calls `internal ClaudeCliEnvironment`; the session takes an `ILogger`)

```xml
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.DependencyInjection.Abstractions" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" />
  </ItemGroup>
  <ItemGroup>
    <InternalsVisibleTo Include="PRism.AI.ClaudeCode.Tests" />
  </ItemGroup>
```

- [ ] **Step 2: Ensure the test csproj has Logging.Abstractions** (add if absent — it provides `NullLogger`/`ILogger`)

```xml
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" />
```

- [ ] **Step 3: Copy the existing `CapturingLogger<T>` into the ClaudeCode test project** (mirror `tests/PRism.GitHub.Tests/TestHelpers/CapturingLogger.cs` verbatim, only the namespace changes)

```csharp
using Microsoft.Extensions.Logging;

namespace PRism.AI.ClaudeCode.Tests.TestHelpers;

/// <summary>Minimal list-backed <see cref="ILogger{T}"/> for asserting emitted log entries.</summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    private readonly object _gate = new();
    public List<(LogLevel Level, string Message)> Entries { get; } = new();
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    { lock (_gate) Entries.Add((logLevel, formatter(state, exception))); }
}
```

- [ ] **Step 4: Build both projects to verify wiring**

Run: `dotnet build PRism.AI.ClaudeCode/PRism.AI.ClaudeCode.csproj && dotnet build tests/PRism.AI.ClaudeCode.Tests`
Expected: both succeed. (`Task 8` tests will `using PRism.AI.ClaudeCode.Tests.TestHelpers;`.)

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/PRism.AI.ClaudeCode.csproj tests/PRism.AI.ClaudeCode.Tests/
git commit -m "chore(#478): test wiring — InternalsVisibleTo, logging, CapturingLogger"
```

---

## Task 1: `LlmTurnError` contract event

**Files:**
- Modify: `PRism.AI.Contracts/Provider/LlmEvent.cs`
- Test: `tests/PRism.AI.Contracts.Tests/Provider/LlmTurnErrorTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using FluentAssertions;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.Contracts.Tests.Provider;

public sealed class LlmTurnErrorTests
{
    [Fact]
    public void Is_an_LlmEvent_with_message_and_optional_code()
    {
        LlmEvent evt = new LlmTurnError("boom", "error_max_turns");

        evt.Should().BeOfType<LlmTurnError>();
        var err = (LlmTurnError)evt;
        err.Message.Should().Be("boom");
        err.Code.Should().Be("error_max_turns");
    }

    [Fact]
    public void Code_is_nullable()
    {
        new LlmTurnError("boom", null).Code.Should().BeNull();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.Contracts.Tests --filter LlmTurnErrorTests`
Expected: FAIL — `LlmTurnError` does not exist (compile error).

- [ ] **Step 3: Add the record to `LlmEvent.cs`** (append after `LlmToolUse`, before `LlmTurnComplete`)

```csharp
/// <summary>An INFORMATIONAL recoverable error for the current turn (the turn still terminates with
/// exactly one <see cref="LlmTurnComplete"/> immediately after — this never replaces it). Defined
/// empirically in P0-1b Slice 2. <paramref name="Code"/> is the provider's error code:
/// the CLI <c>result.subtype</c> when it is not the literal <c>"success"</c> (e.g. <c>error_max_turns</c>),
/// else the <c>api_error_status</c> rendered as a string (e.g. <c>"404"</c>) — because the CLI emits
/// <c>subtype:"success"</c> even on an API-error turn, so subtype alone is not a reliable code.</summary>
public sealed record LlmTurnError(string Message, string? Code) : LlmEvent;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.Contracts.Tests --filter LlmTurnErrorTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.Contracts/Provider/LlmEvent.cs tests/PRism.AI.Contracts.Tests/Provider/LlmTurnErrorTests.cs
git commit -m "feat(#478): add LlmTurnError recoverable-error event to contracts"
```

---

## Task 2: `IStreamingCliProcess` seam + `StreamingProcessSpec` + fake double

**Files:**
- Create: `PRism.AI.ClaudeCode/IStreamingCliProcess.cs`
- Create: `tests/PRism.AI.ClaudeCode.Tests/FakeStreamingCliProcess.cs`

- [ ] **Step 1: Create the seam** (`IStreamingCliProcess.cs`)

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>Spawns the persistent streaming process. Exists SOLELY for test-double injection —
/// <see cref="SystemStreamingCliProcessFactory"/> is the only planned real implementor; do not treat
/// this as an extension point for additional providers.</summary>
public interface IStreamingCliProcessFactory
{
    IStreamingCliProcess Start(StreamingProcessSpec spec);
}

/// <summary>One persistent child process with redirected stdin/stdout. Mirrors
/// <see cref="SystemCliProcessRunner"/>'s isolation (env allowlist, KillTree) but for a long-lived
/// session rather than run-to-completion.</summary>
public interface IStreamingCliProcess : IAsyncDisposable
{
    /// <summary>Line-delimited stdout. The real impl loops <c>StandardOutput.ReadLineAsync</c>
    /// (NOT <c>BeginOutputReadLine</c>, which buffers and cannot stream per-line).</summary>
    IAsyncEnumerable<string> StdoutLines { get; }

    /// <summary>Append one NDJSON line (+newline) to the child's stdin.</summary>
    Task WriteLineAsync(string line, CancellationToken ct);

    /// <summary>Close the child's stdin — signals a clean end so the child exits 0 at the next boundary.</summary>
    Task CloseStdinAsync();

    /// <summary>Await exit up to <paramref name="timeout"/>; on timeout kill the process tree and
    /// return -1. Returns the exit code otherwise.</summary>
    Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct);
}

/// <summary>Mirrors <see cref="ProcessSpec"/> minus the one-shot <c>StdinText</c>/<c>Timeout</c>
/// (stdin is live; there is no single per-call timeout). <see cref="Environment"/> is an explicit
/// ALLOWLIST — the real impl does NOT inherit the parent env.</summary>
public sealed record StreamingProcessSpec(
    string FileName,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment,
    string WorkingDirectory);
```

- [ ] **Step 2: Create the fake double** (`FakeStreamingCliProcess.cs`)

```csharp
using System.Threading.Channels;

namespace PRism.AI.ClaudeCode.Tests;

/// <summary>Scripted streaming process for unit tests. The test pushes stdout lines via
/// <see cref="EmitLine"/> / <see cref="EmitLines"/> and ends the stream via <see cref="EndStdout"/>
/// (clean EOF) or <see cref="KillStdout"/> (faults the stream to simulate process death). Records
/// every stdin write in <see cref="StdinWrites"/>. Never spawns a process.</summary>
public sealed class FakeStreamingCliProcess : IStreamingCliProcess
{
    private readonly Channel<string> _stdout = Channel.CreateUnbounded<string>();
    public List<string> StdinWrites { get; } = new();
    public bool StdinClosed { get; private set; }
    public bool Disposed { get; private set; }
    public int ExitCodeToReturn { get; set; }
    public StreamingProcessSpec? Spec { get; }

    public FakeStreamingCliProcess(StreamingProcessSpec? spec = null) => Spec = spec;

    public void EmitLine(string line) => _stdout.Writer.TryWrite(line);
    public void EmitLines(params string[] lines) { foreach (var l in lines) _stdout.Writer.TryWrite(l); }
    public void EndStdout() => _stdout.Writer.TryComplete();
    public void KillStdout() => _stdout.Writer.TryComplete(new IOException("process died"));

    public IAsyncEnumerable<string> StdoutLines => _stdout.Reader.ReadAllAsync();

    public Task WriteLineAsync(string line, CancellationToken ct) { StdinWrites.Add(line); return Task.CompletedTask; }
    // Models the real CLI: closing stdin ends the session, so the child exits and stdout reaches EOF.
    public Task CloseStdinAsync() { StdinClosed = true; _stdout.Writer.TryComplete(); return Task.CompletedTask; }
    public Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct) => Task.FromResult(ExitCodeToReturn);
    public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
}

/// <summary>Factory returning a pre-built <see cref="FakeStreamingCliProcess"/> and capturing the spec.</summary>
public sealed class FakeStreamingCliProcessFactory : IStreamingCliProcessFactory
{
    private readonly FakeStreamingCliProcess _process;
    public StreamingProcessSpec? CapturedSpec { get; private set; }
    public FakeStreamingCliProcessFactory(FakeStreamingCliProcess process) => _process = process;
    public IStreamingCliProcess Start(StreamingProcessSpec spec) { CapturedSpec = spec; return _process; }
}
```

- [ ] **Step 3: Build to verify it compiles**

Run: `dotnet build tests/PRism.AI.ClaudeCode.Tests`
Expected: build succeeds (no test yet — these are scaffolding types used by Tasks 3-7).

- [ ] **Step 4: Commit**

```bash
git add PRism.AI.ClaudeCode/IStreamingCliProcess.cs tests/PRism.AI.ClaudeCode.Tests/FakeStreamingCliProcess.cs
git commit -m "feat(#478): add IStreamingCliProcess seam + fake test double"
```

---

## Task 3: `ClaudeStreamJson` NDJSON line parser

The parser is a pure function: one stdout line → `ParsedLine`. It owns the wire-shape knowledge (spec §4/§9). The session (Task 4) acts on the result. Tool input is **cloned** (the source `JsonDocument` is disposed per-line; `LlmToolUse.Input` must outlive it).

**Files:**
- Create: `PRism.AI.ClaudeCode/ClaudeStreamJson.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeStreamJsonTests.cs`

- [ ] **Step 1: Write the failing tests** (fixtures are the exact §9 shapes)

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeStreamJsonTests
{
    [Fact]
    public void Init_line_yields_session_id()
    {
        var p = ClaudeStreamJson.Parse(
            """{"type":"system","subtype":"init","session_id":"fd63a7f1","tools":[],"model":"m"}""");
        p.Kind.Should().Be(StreamLineKind.Init);
        p.SessionId.Should().Be("fd63a7f1");
    }

    [Fact]
    public void Text_delta_yields_text()
    {
        var p = ClaudeStreamJson.Parse(
            """{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}""");
        p.Kind.Should().Be(StreamLineKind.TextDelta);
        p.Text.Should().Be("hello");
    }

    [Fact]
    public void Success_result_yields_full_text_tokens_cost_not_error()
    {
        var p = ClaudeStreamJson.Parse(
            """{"type":"result","subtype":"success","is_error":false,"result":"hi","total_cost_usd":0.0375,"usage":{"input_tokens":10,"output_tokens":142,"cache_read_input_tokens":21105}}""");
        p.Kind.Should().Be(StreamLineKind.Result);
        p.Result!.IsError.Should().BeFalse();
        p.Result.FullText.Should().Be("hi");
        p.Result.InputTokens.Should().Be(10);
        p.Result.OutputTokens.Should().Be(142);
        p.Result.CacheReadInputTokens.Should().Be(21105);
        p.Result.EstimatedCostUsd.Should().Be(0.0375m);
    }

    [Fact]
    public void Api_error_result_code_is_status_not_success_subtype()
    {
        // Captured shape (probe 4a): subtype is "success" even though is_error is true.
        var p = ClaudeStreamJson.Parse(
            """{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"bad model","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}""");
        p.Result!.IsError.Should().BeTrue();
        p.Result.Code.Should().Be("404");            // NOT "success"
        p.Result.FullText.Should().Be("bad model");
    }

    [Fact]
    public void Max_turns_error_result_code_is_subtype_and_full_text_empty_when_absent()
    {
        // Captured shape (probe 4b): subtype carries the code, .result key is ABSENT.
        var p = ClaudeStreamJson.Parse(
            """{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":2,"total_cost_usd":0.31,"usage":{"input_tokens":17856,"output_tokens":141,"cache_read_input_tokens":20382}}""");
        p.Result!.IsError.Should().BeTrue();
        p.Result.Code.Should().Be("error_max_turns");
        p.Result.FullText.Should().Be("");           // absent .result -> ""
    }

    [Fact]
    public void Assistant_tool_use_block_yields_tool_use_with_cloned_input()
    {
        var p = ClaudeStreamJson.Parse(
            """{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"x.txt"}}]}}""");
        p.Kind.Should().Be(StreamLineKind.ToolUse);
        p.ToolName.Should().Be("Read");
        p.ToolInput!.Value.GetProperty("file_path").GetString().Should().Be("x.txt");
    }

    [Fact]
    public void Assistant_text_and_thinking_blocks_are_ignored_not_double_counted()
    {
        // assistant carries a full copy of text already delivered via text_delta -> must be ignored.
        var p = ClaudeStreamJson.Parse(
            """{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"},{"type":"thinking","thinking":"..."}]}}""");
        p.Kind.Should().Be(StreamLineKind.Ignored);
    }

    [Theory]
    [InlineData("""{"type":"rate_limit_event"}""")]
    [InlineData("""{"type":"stream_event","event":{"type":"message_start"}}""")]
    [InlineData("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"x"}}}""")]
    [InlineData("""{"type":"system","subtype":"other"}""")]
    public void Advisory_and_framing_lines_are_ignored(string line)
    {
        ClaudeStreamJson.Parse(line).Kind.Should().Be(StreamLineKind.Ignored);
    }

    [Fact]
    public void Unmappable_result_is_flagged_for_the_drift_guard()
    {
        // A result line missing the fields the mapping needs -> Result with Malformed=true (Task 8 guard).
        var p = ClaudeStreamJson.Parse("""{"type":"result","subtype":"weird_new_shape"}""");
        p.Kind.Should().Be(StreamLineKind.Result);
        p.Result!.Malformed.Should().BeTrue();
    }

    [Fact]
    public void Garbage_line_is_ignored_not_thrown()
    {
        ClaudeStreamJson.Parse("not json at all").Kind.Should().Be(StreamLineKind.Ignored);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --filter ClaudeStreamJsonTests`
Expected: FAIL — `ClaudeStreamJson` / `StreamLineKind` / `ParsedLine` do not exist.

- [ ] **Step 3: Implement `ClaudeStreamJson.cs`**

```csharp
using System.Text.Json;

namespace PRism.AI.ClaudeCode;

public enum StreamLineKind { Ignored, Init, TextDelta, ToolUse, Result }

/// <summary>One parsed stdout line. Only the field(s) for <see cref="Kind"/> are populated.</summary>
public sealed record ParsedLine(
    StreamLineKind Kind,
    string? SessionId = null,
    string? Text = null,
    string? ToolName = null,
    JsonElement? ToolInput = null,
    ResultLine? Result = null);

/// <summary>The terminal <c>result</c> line, mapped. <see cref="Malformed"/> = the line is a result
/// but its shape could not be mapped (drift signal; Task 8). On the error path <see cref="FullText"/>
/// is <c>.result</c> when present else <c>""</c>.</summary>
public sealed record ResultLine(
    bool IsError, string? Code, string FullText,
    int InputTokens, int OutputTokens, int CacheReadInputTokens, decimal EstimatedCostUsd,
    bool Malformed = false);

/// <summary>Pure NDJSON line parser for `claude` stream-json output (spec §4/§9). Never throws on a
/// malformed line — returns <see cref="StreamLineKind.Ignored"/> (or a <c>Malformed</c> result).</summary>
public static class ClaudeStreamJson
{
    public static ParsedLine Parse(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return new ParsedLine(StreamLineKind.Ignored);
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch (JsonException) { return new ParsedLine(StreamLineKind.Ignored); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeEl))
                return new ParsedLine(StreamLineKind.Ignored);

            switch (typeEl.GetString())
            {
                case "system":
                    return root.TryGetProperty("subtype", out var st) && st.GetString() == "init"
                        ? new ParsedLine(StreamLineKind.Init,
                            SessionId: root.TryGetProperty("session_id", out var sid) ? sid.GetString() : null)
                        : new ParsedLine(StreamLineKind.Ignored);

                case "stream_event":
                    return ParseStreamEvent(root);

                case "assistant":
                    return ParseAssistant(root);

                case "result":
                    return new ParsedLine(StreamLineKind.Result, Result: ParseResult(root));

                default:
                    return new ParsedLine(StreamLineKind.Ignored);
            }
        }
    }

    private static ParsedLine ParseStreamEvent(JsonElement root)
    {
        if (!root.TryGetProperty("event", out var ev) ||
            !ev.TryGetProperty("type", out var et) || et.GetString() != "content_block_delta" ||
            !ev.TryGetProperty("delta", out var delta) ||
            !delta.TryGetProperty("type", out var dt) || dt.GetString() != "text_delta" ||
            !delta.TryGetProperty("text", out var txt))
            return new ParsedLine(StreamLineKind.Ignored);
        return new ParsedLine(StreamLineKind.TextDelta, Text: txt.GetString());
    }

    private static ParsedLine ParseAssistant(JsonElement root)
    {
        // Source tool_use from the assistant block's first tool_use content; ignore text/thinking
        // (already delivered via text_delta — mapping them would double-count).
        if (root.TryGetProperty("message", out var msg) &&
            msg.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (block.TryGetProperty("type", out var bt) && bt.GetString() == "tool_use")
                {
                    var name = block.TryGetProperty("name", out var n) ? n.GetString() : null;
                    JsonElement? input = block.TryGetProperty("input", out var inp) ? inp.Clone() : null;
                    return new ParsedLine(StreamLineKind.ToolUse, ToolName: name, ToolInput: input);
                }
            }
        }
        return new ParsedLine(StreamLineKind.Ignored);
    }

    private static ResultLine ParseResult(JsonElement root)
    {
        if (!root.TryGetProperty("is_error", out var isErrEl) ||
            isErrEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            // A result we cannot even read is_error from -> malformed (drift).
            return new ResultLine(IsError: true, Code: null, FullText: "", 0, 0, 0, 0m, Malformed: true);

        var isError = isErrEl.GetBoolean();
        var fullText = root.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String
            ? r.GetString()! : "";
        var cost = root.TryGetProperty("total_cost_usd", out var c) && c.ValueKind == JsonValueKind.Number
            ? c.GetDecimal() : 0m;
        var (inTok, outTok, cacheTok) = ReadUsage(root);

        string? code = null;
        if (isError)
        {
            var subtype = root.TryGetProperty("subtype", out var s) ? s.GetString() : null;
            code = subtype is not null && subtype != "success"
                ? subtype
                : root.TryGetProperty("api_error_status", out var aes) && aes.ValueKind == JsonValueKind.Number
                    ? aes.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : subtype; // last resort: whatever subtype was
        }
        return new ResultLine(isError, code, fullText, inTok, outTok, cacheTok, cost);
    }

    private static (int, int, int) ReadUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return (0, 0, 0);
        int Get(string k) => u.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        return (Get("input_tokens"), Get("output_tokens"), Get("cache_read_input_tokens"));
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --filter ClaudeStreamJsonTests`
Expected: PASS (all). If `error_max_turns` test fails on `FullText`, confirm the `.result` key is absent in the fixture (it is) and `ParseResult` defaults to `""`.

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeStreamJson.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeStreamJsonTests.cs
git commit -m "feat(#478): add ClaudeStreamJson NDJSON line parser (verified shapes)"
```

---

## Task 4: `ClaudeCodeStreamingSession`

The session is the concurrency core. Build it in sub-tasks 4a–4f, each a green checkpoint. The session takes an already-started `IStreamingCliProcess`. Key invariants (spec §3): per-turn `TaskCompletionSource(RunContinuationsAsynchronously)` **tripped before** the blocking channel write; init TCS for `ProviderSessionId`/zero-turns `EndCleanlyAsync`; bounded `Channel<LlmEvent>` cap 1024 `Wait`; reader cancelled + writer completed on dispose.

**Files (all sub-tasks):**
- Create: `PRism.AI.ClaudeCode/ClaudeCodeStreamingSession.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingSessionTests.cs`

### Task 4a: Skeleton + reader loop + `Events` + text deltas + `ProviderSessionId`

- [ ] **Step 1: Write failing tests**

```csharp
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.ClaudeCode.Tests.TestHelpers;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeStreamingSessionTests
{
    private const string Init = """{"type":"system","subtype":"init","session_id":"sess-1"}""";
    private static string Delta(string t) =>
        $$"""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{{t}}"}}}""";
    private static string Result(string txt) =>
        $$"""{"type":"result","subtype":"success","is_error":false,"result":"{{txt}}","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3}}""";

    [Fact]
    public async Task Streams_text_deltas_then_turn_complete()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        proc.EmitLines(Init, Delta("he"), Delta("llo"), Result("hello"));
        proc.EndStdout();

        var events = new List<LlmEvent>();
        await foreach (var e in session.Events) events.Add(e);

        events.Should().HaveCount(3);
        events[0].Should().BeOfType<LlmTextDelta>().Which.Text.Should().Be("he");
        events[1].Should().BeOfType<LlmTextDelta>().Which.Text.Should().Be("llo");
        events[2].Should().BeOfType<LlmTurnComplete>().Which.FullText.Should().Be("hello");
        session.ProviderSessionId.Should().Be("sess-1");
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`ClaudeCodeStreamingSession` missing).
Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --filter ClaudeCodeStreamingSessionTests`

- [ ] **Step 3: Implement the skeleton + reader** (`ClaudeCodeStreamingSession.cs`)

```csharp
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

public sealed class ClaudeCodeStreamingSession : IStreamingLlmSession
{
    private readonly IStreamingCliProcess _process;
    private readonly ILogger<ClaudeCodeStreamingSession> _logger;   // drift-guard logging (Task 8)
    private readonly Channel<LlmEvent> _channel;
    private readonly CancellationTokenSource _readerCts = new();
    private readonly TaskCompletionSource _initTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _readerTask;

    private volatile string _providerSessionId = "";
    private volatile bool _turnInFlight;
    private TaskCompletionSource? _turnTcs;          // guarded by lock(_turnGate)
    private readonly object _turnGate = new();
    private int _turnTextCount, _turnToolCount;      // per-turn output counters (drift guard, Task 8)
    private int _disposed;

    public ClaudeCodeStreamingSession(IStreamingCliProcess process)
        : this(process, NullLogger<ClaudeCodeStreamingSession>.Instance) { }

    // channelCapacity is a TEST SEAM (default 1024). Tests set a small cap to deterministically
    // SATURATE the channel and exercise back-pressure / trip-before-write (Tasks 4d/4f) — the bug those
    // invariants guard only manifests when the channel is actually full.
    public ClaudeCodeStreamingSession(
        IStreamingCliProcess process,
        ILogger<ClaudeCodeStreamingSession> logger,
        int channelCapacity = 1024)
    {
        _process = process;
        _logger = logger;
        _channel = Channel.CreateBounded<LlmEvent>(new BoundedChannelOptions(channelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = true,
        });
        _readerTask = Task.Run(() => ReadLoopAsync(_readerCts.Token));
    }

    public string ProviderSessionId => _providerSessionId;
    public IAsyncEnumerable<LlmEvent> Events => _channel.Reader.ReadAllAsync();

    private async Task ReadLoopAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var line in _process.StdoutLines.WithCancellation(ct).ConfigureAwait(false))
            {
                var parsed = ClaudeStreamJson.Parse(line);
                switch (parsed.Kind)
                {
                    case StreamLineKind.Init:
                        _providerSessionId = parsed.SessionId ?? "";
                        _initTcs.TrySetResult();
                        break;
                    case StreamLineKind.TextDelta:
                        _turnTextCount++;
                        await _channel.Writer.WriteAsync(new LlmTextDelta(parsed.Text!), ct).ConfigureAwait(false);
                        break;
                    case StreamLineKind.ToolUse:
                        _turnToolCount++;
                        await _channel.Writer.WriteAsync(
                            new LlmToolUse(parsed.ToolName ?? "", parsed.ToolInput ?? default), ct).ConfigureAwait(false);
                        break;
                    case StreamLineKind.Result:
                        await CompleteTurnAsync(parsed.Result!, ct).ConfigureAwait(false);
                        break;
                }
            }
            // Clean stdout EOF.
            _initTcs.TrySetResult();            // unblock a zero-turn EndCleanly if init never arrived
            _channel.Writer.TryComplete();
        }
        catch (OperationCanceledException) { _channel.Writer.TryComplete(); }
        catch (ChannelClosedException) { /* writer completed during shutdown — expected */ }
        catch (Exception ex)                    // process death / pipe break -> unrecoverable
        {
            _initTcs.TrySetResult();
            _channel.Writer.TryComplete(new LlmProviderException(
                "claude streaming process died.", stderr: string.Empty, exitCode: -1, innerException: ex));
        }
    }

    // Slice 4a: SUCCESS PATH ONLY. The is_error branch is added in 4c (red-first); the malformed/drift
    // branch in Task 8. The terminal LlmTurnComplete is written with CancellationToken.None — NEVER the
    // reader CT — so a forced EndCleanly/Dispose that cancels the reader cannot drop the turn's terminal
    // event out from under a consumer still draining it. (A truly stalled consumer is released instead by
    // EndCleanly/Dispose completing the writer, which surfaces as ChannelClosedException, caught above.)
    private async Task CompleteTurnAsync(ResultLine r, CancellationToken ct)
    {
        // TRIP BEFORE the (potentially blocking) channel write — else a stalled consumer hangs EndCleanly.
        lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }

        await _channel.Writer.WriteAsync(new LlmTurnComplete(
            r.FullText, r.InputTokens, r.OutputTokens, r.CacheReadInputTokens, r.EstimatedCostUsd),
            CancellationToken.None).ConfigureAwait(false);
    }

    // SendUserTurnAsync / EndCleanlyAsync / DisposeAsync added in 4b/4d/4e.
    public Task SendUserTurnAsync(string content, CancellationToken ct) => throw new NotImplementedException();
    public Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct) => throw new NotImplementedException();

    // Minimal DisposeAsync so 4a's `await using` works; replaced by the full version in 4e. Do NOT leave throwing.
    public async ValueTask DisposeAsync()
    {
        _readerCts.Cancel();
        _channel.Writer.TryComplete();
        await _process.DisposeAsync().ConfigureAwait(false);
    }
}
```

- [ ] **Step 4: Run — expect PASS** for 4a test (with the minimal `DisposeAsync`).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCodeStreamingSession.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingSessionTests.cs
git commit -m "feat(#478): streaming session reader loop, text deltas, session id"
```

### Task 4b: `SendUserTurnAsync` (sequential enforcement)

- [ ] **Step 1: Add failing tests**

```csharp
    [Fact]
    public async Task Send_writes_one_json_user_line_to_stdin()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("hi \"there\"\nline2", CancellationToken.None);

        proc.StdinWrites.Should().HaveCount(1);
        // Must be JSON-serialized: exactly one frame, embedded quote/newline escaped.
        using var doc = JsonDocument.Parse(proc.StdinWrites[0]);
        doc.RootElement.GetProperty("type").GetString().Should().Be("user");
        doc.RootElement.GetProperty("message").GetProperty("content")[0]
            .GetProperty("text").GetString().Should().Be("hi \"there\"\nline2");
    }

    [Fact]
    public async Task Second_send_while_in_flight_throws_synchronously_and_does_not_write()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("first", CancellationToken.None);

        var act = () => session.SendUserTurnAsync("second", CancellationToken.None);
        await act.Should().ThrowAsync<InvalidOperationException>();
        proc.StdinWrites.Should().HaveCount(1);     // second NOT written
    }
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `SendUserTurnAsync`** (replace the stub)

```csharp
    private static readonly System.Text.Json.JsonSerializerOptions JsonOpts = new();

    public Task SendUserTurnAsync(string content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);
        lock (_turnGate)
        {
            if (_turnInFlight)
                throw new InvalidOperationException("A turn is already in flight; await its LlmTurnComplete first.");
            _turnInFlight = true;
            _turnTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _turnTextCount = 0; _turnToolCount = 0;     // reset per-turn output counters (drift guard)
        }
        var line = System.Text.Json.JsonSerializer.Serialize(new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text = content } } },
        }, JsonOpts);
        return _process.WriteLineAsync(line, ct);
    }
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(#478): SendUserTurnAsync with JSON framing + sequential guard`).

### Task 4c: error-path events + token isolation + multi-turn + turnInFlight clears on error

- [ ] **Step 1: Add failing tests**

```csharp
    private static string ErrResult(string subtype) =>
        $$"""{"type":"result","subtype":"{{subtype}}","is_error":true,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}""";

    [Fact]
    public async Task Error_turn_emits_turn_error_then_turn_complete()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        proc.EmitLines(Init, ErrResult("error_max_turns")); proc.EndStdout();

        var events = new List<LlmEvent>();
        await foreach (var e in session.Events) events.Add(e);

        events.Should().HaveCount(2);
        events[0].Should().BeOfType<LlmTurnError>().Which.Code.Should().Be("error_max_turns");
        events[1].Should().BeOfType<LlmTurnComplete>().Which.FullText.Should().Be("");
    }

    [Fact]
    public async Task Turn_in_flight_clears_on_error_so_next_send_succeeds()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("first", CancellationToken.None);
        proc.EmitLines(Init, ErrResult("error_max_turns"));

        // Drain until the turn completes, then a second send must not throw.
        await WaitForTurnComplete(session);
        var act = () => session.SendUserTurnAsync("second", CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Multi_turn_keeps_tokens_per_turn_and_one_session_id()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        proc.EmitLines(Init,
            """{"type":"result","subtype":"success","is_error":false,"result":"one","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0}}""",
            """{"type":"result","subtype":"success","is_error":false,"result":"two","total_cost_usd":0.02,"usage":{"input_tokens":2,"output_tokens":2,"cache_read_input_tokens":0}}""");
        proc.EndStdout();

        var completes = new List<LlmTurnComplete>();
        await foreach (var e in session.Events) if (e is LlmTurnComplete c) completes.Add(c);

        completes.Should().HaveCount(2);
        completes[0].FullText.Should().Be("one"); completes[0].InputTokens.Should().Be(1);
        completes[1].FullText.Should().Be("two"); completes[1].InputTokens.Should().Be(2);
        session.ProviderSessionId.Should().Be("sess-1");
    }

    // Helper: drain Events on a background task until the first LlmTurnComplete.
    private static async Task WaitForTurnComplete(IStreamingLlmSession s)
    {
        await foreach (var e in s.Events) if (e is LlmTurnComplete) return;
    }
```

> NOTE: `WaitForTurnComplete` consumes `Events`; in the second test the `EndStdout` is omitted so the foreach would hang after the turn. Guard it: the helper returns on the first `LlmTurnComplete` (it does not wait for channel completion), so it returns promptly. Keep one consumer only.

- [ ] **Step 2: Run — expect FAIL** (genuine red). 4a's `CompleteTurnAsync` is **success-only**, so `Error_turn_emits_turn_error_then_turn_complete` and `Turn_in_flight_clears_on_error...` fail (no `LlmTurnError` is emitted yet). The `Multi_turn...` test should already pass from 4a — that is fine (it pins existing success-path behavior).

- [ ] **Step 3: Add the is_error branch to `CompleteTurnAsync`** (the red-first addition). Insert the error emission BEFORE the terminal write, after the trip; both writes use `CancellationToken.None` (per 4a's terminal-write rule):

```csharp
    private async Task CompleteTurnAsync(ResultLine r, CancellationToken ct)
    {
        // TRIP BEFORE the (potentially blocking) channel write — else a stalled consumer hangs EndCleanly.
        lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }

        if (r.IsError)
        {
            await _channel.Writer.WriteAsync(
                new LlmTurnError(string.IsNullOrEmpty(r.FullText) ? (r.Code ?? "error") : r.FullText, r.Code),
                CancellationToken.None).ConfigureAwait(false);
        }
        await _channel.Writer.WriteAsync(new LlmTurnComplete(
            r.FullText, r.InputTokens, r.OutputTokens, r.CacheReadInputTokens, r.EstimatedCostUsd),
            CancellationToken.None).ConfigureAwait(false);
    }
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`test(#478): error-path, multi-turn token isolation, turn-clear-on-error`).

### Task 4d: `EndCleanlyAsync` (clean / timeout / cancelled / zero-turns / trip-before-write)

- [ ] **Step 1: Add failing tests**

```csharp
    [Fact]
    public async Task EndCleanly_zero_turns_awaits_init_returns_true_with_session_id()
    {
        var proc = new FakeStreamingCliProcess { ExitCodeToReturn = 0 };
        await using var session = new ClaudeCodeStreamingSession(proc);
        proc.EmitLines(Init);   // init arrives, no turns

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(5), CancellationToken.None);

        end.LastTurnEndedCleanly.Should().BeTrue();
        end.ProviderSessionId.Should().Be("sess-1");
        proc.StdinClosed.Should().BeTrue();
    }

    [Fact]
    public async Task EndCleanly_with_completed_turn_returns_true()
    {
        var proc = new FakeStreamingCliProcess { ExitCodeToReturn = 0 };
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("hi", CancellationToken.None);
        proc.EmitLines(Init, Result("hi"));

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        end.LastTurnEndedCleanly.Should().BeTrue();
    }

    [Fact]
    public async Task EndCleanly_stalled_consumer_trip_before_write_returns_clean()
    {
        // cap=1: the single Delta fills the channel, so when the terminal Result arrives the
        // LlmTurnComplete WRITE blocks. With NO consumer draining, EndCleanly can return clean (true)
        // ONLY if the TCS was tripped BEFORE that blocking write. Invert the trip/write order in
        // CompleteTurnAsync and this asserts FALSE (EndCleanly's TCS wait times out -> forced end).
        var proc = new FakeStreamingCliProcess { ExitCodeToReturn = 0 };
        await using var session = new ClaudeCodeStreamingSession(
            proc, NullLogger<ClaudeCodeStreamingSession>.Instance, channelCapacity: 1);
        await session.SendUserTurnAsync("hi", CancellationToken.None);
        proc.EmitLines(Init, Delta("x"), Result("hi"));   // Delta fills cap=1; the complete-write blocks

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
        end.LastTurnEndedCleanly.Should().BeTrue();        // FALSE if the trip came after the write
    }

    [Fact]
    public async Task EndCleanly_clean_path_delivers_terminal_event_to_a_draining_consumer()
    {
        // Regression guard for the cancel-race: the clean path must NOT cancel the reader and drop the
        // turn's terminal LlmTurnComplete out from under a consumer still draining.
        var proc = new FakeStreamingCliProcess { ExitCodeToReturn = 0 };
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("hi", CancellationToken.None);

        var received = new List<LlmEvent>();
        var draining = Task.Run(async () => { await foreach (var e in session.Events) received.Add(e); });
        proc.EmitLines(Init, Delta("a"), Result("ans"));

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        await draining;

        end.LastTurnEndedCleanly.Should().BeTrue();
        received.OfType<LlmTurnComplete>().Should().ContainSingle().Which.FullText.Should().Be("ans");
    }

    [Fact]
    public async Task EndCleanly_cancelled_ct_forces_end_without_throwing()
    {
        var proc = new FakeStreamingCliProcess { ExitCodeToReturn = -1 };
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("hi", CancellationToken.None);
        proc.EmitLines(Init);                    // turn never completes
        using var cts = new CancellationTokenSource(); await cts.CancelAsync();

        var end = await session.EndCleanlyAsync(TimeSpan.FromSeconds(5), cts.Token);
        end.LastTurnEndedCleanly.Should().BeFalse();   // forced-end, no throw
    }
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `EndCleanlyAsync`**

```csharp
    public async Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct)
    {
        // 1) Wait for the in-flight turn's completion (or init, if no turn) up to gracefulTimeout.
        Task waitOn;
        lock (_turnGate) waitOn = _turnInFlight && _turnTcs is not null ? _turnTcs.Task : _initTcs.Task;

        if (!await WaitBounded(waitOn, gracefulTimeout, ct).ConfigureAwait(false))
        {
            await ForceTerminateAsync().ConfigureAwait(false);     // timeout/cancel -> forced end, no throw
            return new SessionEndState(LastTurnEndedCleanly: false, ProviderSessionId: _providerSessionId);
        }

        // 2) Clean boundary: close stdin (child exits at the boundary), await exit.
        await _process.CloseStdinAsync().ConfigureAwait(false);
        var exit = await _process.WaitForExitAsync(gracefulTimeout, CancellationToken.None).ConfigureAwait(false);

        // 3) Let the reader drain to stdout-EOF and complete the channel ITSELF, so a consumer still
        //    draining receives the terminal LlmTurnComplete. Do NOT cancel the reader on the clean path —
        //    cancelling here would race the reader's terminal write (issued on CancellationToken.None) and,
        //    for a stalled consumer, drop it. Bound the wait; only force if the reader is wedged on a
        //    non-draining consumer (which has abandoned the stream anyway).
        if (!await WaitBounded(_readerTask, gracefulTimeout, CancellationToken.None).ConfigureAwait(false))
        {
            _readerCts.Cancel();
            _channel.Writer.TryComplete();
        }
        return new SessionEndState(LastTurnEndedCleanly: exit == 0, ProviderSessionId: _providerSessionId);
    }

    private static async Task<bool> WaitBounded(Task task, TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeout);
            var delay = Task.Delay(Timeout.Infinite, timeoutCts.Token);
            var winner = await Task.WhenAny(task, delay).ConfigureAwait(false);
            return winner == task;
        }
        catch (OperationCanceledException) { return false; }
    }

    private async Task ForceTerminateAsync()
    {
        _readerCts.Cancel();
        _channel.Writer.TryComplete();
        await _process.WaitForExitAsync(TimeSpan.FromSeconds(2), CancellationToken.None).ConfigureAwait(false);
    }
```

> The `_readerCts.Cancel()` releases a reader blocked on a full-channel write (the stalled-consumer case); `_channel.Writer.TryComplete()` ends any concurrent `Events` foreach normally.

- [ ] **Step 4: Run — expect PASS** (all 4d tests).
- [ ] **Step 5: Commit** (`feat(#478): EndCleanlyAsync clean/timeout/cancel/zero-turns`).

### Task 4e: `DisposeAsync` (idempotent, KillTree, drain-write)

- [ ] **Step 1: Add failing tests**

```csharp
    [Fact]
    public async Task Dispose_is_idempotent_and_disposes_process()
    {
        var proc = new FakeStreamingCliProcess();
        var session = new ClaudeCodeStreamingSession(proc);
        await session.DisposeAsync();
        await session.DisposeAsync();   // second call no-ops
        proc.Disposed.Should().BeTrue();
    }

    [Fact]
    public async Task Unrecoverable_death_throws_but_delivers_buffered_events_first()
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);
        await session.SendUserTurnAsync("hi", CancellationToken.None);
        proc.EmitLines(Init, Delta("partial"));
        proc.KillStdout();              // process dies mid-turn, no result

        var received = new List<LlmEvent>();
        var act = async () => { await foreach (var e in session.Events) received.Add(e); };
        await act.Should().ThrowAsync<LlmProviderException>();
        // No data loss before death: the buffered partial delta is delivered, THEN the throw surfaces.
        received.OfType<LlmTextDelta>().Should().ContainSingle().Which.Text.Should().Be("partial");
    }
```

- [ ] **Step 2: Run — expect FAIL** (full `DisposeAsync` not yet implemented; `Unrecoverable_death` should already pass from 4a's reader catch — confirm).

- [ ] **Step 3: Implement the full `DisposeAsync`** (replace the minimal one from 4a)

```csharp
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _readerCts.Cancel();
        _channel.Writer.TryComplete();
        try { await _readerTask.ConfigureAwait(false); } catch { /* reader teardown best-effort */ }
        await _process.DisposeAsync().ConfigureAwait(false);   // SystemStreamingCliProcess KillTrees here
        _readerCts.Dispose();
    }
```

- [ ] **Step 4: Run — expect PASS** (all session tests).
- [ ] **Step 5: Commit** (`feat(#478): DisposeAsync idempotent + KillTree; unrecoverable-death throw`).

### Task 4f: back-pressure bound

- [ ] **Step 1: Add failing test**

```csharp
    [Fact]
    public async Task Back_pressure_small_cap_preserves_all_events_in_order()
    {
        // cap=4 with 50 deltas guarantees the reader BLOCKS on WriteAsync (load >> cap) until the consumer
        // pulls — genuinely exercising the Wait policy (unlike a cap-1024 test the consumer never fills).
        // Asserts no drop / no reorder under sustained back-pressure, and the terminal event still arrives.
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(
            proc, NullLogger<ClaudeCodeStreamingSession>.Instance, channelCapacity: 4);
        proc.EmitLine(Init);
        for (var i = 0; i < 50; i++) proc.EmitLine(Delta(i.ToString()));
        proc.EmitLine(Result("done")); proc.EndStdout();

        var deltas = new List<string>();
        var sawComplete = false;
        await foreach (var e in session.Events)
        {
            if (e is LlmTextDelta d) deltas.Add(d.Text);
            if (e is LlmTurnComplete) sawComplete = true;
        }

        deltas.Should().HaveCount(50);
        deltas[0].Should().Be("0"); deltas[^1].Should().Be("49");   // order preserved, none dropped
        sawComplete.Should().BeTrue();
    }
```

- [ ] **Step 2: Run — expect PASS.** With cap=4 and 50 buffered deltas the reader provably parks on a full-channel `WriteAsync` between consumer pulls, so this exercises the `Wait` back-pressure path (not just FIFO ordering). If it hangs, the reader/consumer wiring is wrong — investigate before proceeding.
- [ ] **Step 3:** No production change expected (the bounded channel provides the behavior; this pins it under a forced-block load).
- [ ] **Step 4: Commit** (`test(#478): back-pressure under small cap preserves order, no drops`).

---

## Task 5: `ClaudeCodeStreamingProvider`

Builds args (spec §9), enforces security (spec §6): env allowlist, tool deny-list (additive, deny-wins, never-in-allow), working-dir confinement (canonical + symlink-resolved), `--verbose` mandatory. Calls `factory.Start`.

**Files:**
- Create: `PRism.AI.ClaudeCode/ClaudeCodeStreamingProvider.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingProviderTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeStreamingProviderTests
{
    private static (ClaudeCodeStreamingProvider, FakeStreamingCliProcessFactory) Build(string baseDir)
    {
        var proc = new FakeStreamingCliProcess();
        var factory = new FakeStreamingCliProcessFactory(proc);
        var options = new ClaudeCodeProviderOptions { WorkingDirectory = baseDir };
        return (new ClaudeCodeStreamingProvider(factory, options), factory);
    }

    [Fact]
    public void Spawns_with_required_streaming_flags_and_verbose()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(Model: "m"));

        var args = factory.CapturedSpec!.Arguments;
        args.Should().ContainInOrder("--output-format", "stream-json");
        args.Should().Contain("--verbose");
        args.Should().Contain("--input-format").And.Contain("stream-json");
        args.Should().NotContain("--bare");
        args.Should().ContainInOrder("--model", "m");
    }

    [Fact]
    public void Deny_list_is_unconditional_even_when_caller_allows_bash()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(AllowedTools: new[] { "Bash", "Read" }));

        var args = factory.CapturedSpec!.Arguments;
        var disallowed = ArgValue(args, "--disallowedTools");
        disallowed.Should().Contain("Bash").And.Contain("PowerShell");   // both shell-exec tools denied
        ArgValue(args, "--allowedTools").Should().NotContain("Bash");     // never in allow
    }

    [Fact]
    public void Env_is_the_shared_allowlist()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions());

        factory.CapturedSpec!.Environment.Keys.Should()
            .BeEquivalentTo(ClaudeCliEnvironment.BuildAllowlisted().Keys);
    }

    [Fact]
    public void Env_allowlist_definition_has_no_credential_pattern_keys()
    {
        // Assert on the STATIC allowlist (the filter DEFINITION), not the filtered output — asserting on
        // the output is vacuous (it can never contain a key the filter doesn't list). This catches a
        // future edit that adds a credential-bearing var to ClaudeCliEnvironment.Allowlist. (Needs the
        // Task-0 InternalsVisibleTo.)
        var bad = new[] { "TOKEN", "SECRET", "PAT", "PASSWORD", "CREDENTIAL", "KEY", "ANTHROPIC" };
        ClaudeCliEnvironment.Allowlist
            .Where(k => bad.Any(b => k.ToUpperInvariant().Contains(b)))
            .Should().BeEmpty();
    }

    [Fact]
    public void Existing_working_directory_outside_base_is_rejected()
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        var baseDir = Directory.CreateDirectory(Path.Combine(root, "base")).FullName;
        var outside = Directory.CreateDirectory(Path.Combine(root, "outside")).FullName;
        var (provider, _) = Build(baseDir);

        var act = () => provider.StartSession(new StreamingSessionOptions(WorkingDirectory: outside));
        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Nonexistent_working_directory_is_rejected()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, _) = Build(baseDir);
        var act = () => provider.StartSession(new StreamingSessionOptions(
            WorkingDirectory: Path.Combine(baseDir, "does-not-exist")));
        act.Should().Throw<ArgumentException>();   // rejected outright, not lexically normalized
    }

    [Fact]
    public void Subdirectory_under_base_is_allowed()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var sub = Directory.CreateDirectory(Path.Combine(baseDir, "sub")).FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(WorkingDirectory: sub));
        factory.CapturedSpec!.WorkingDirectory.Should().StartWith(Path.GetFullPath(baseDir));
    }

    [Fact]
    public void Null_working_directory_uses_the_canonical_base()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions());
        var viaNull = factory.CapturedSpec!.WorkingDirectory;
        // Self-consistent (avoids hardcoding GetFullPath, which differs from the symlink-resolved form on
        // macOS): passing the base explicitly resolves to the same canonical path the null case used.
        provider.StartSession(new StreamingSessionOptions(WorkingDirectory: baseDir));
        factory.CapturedSpec!.WorkingDirectory.Should().Be(viaNull);
        Directory.Exists(viaNull).Should().BeTrue();
    }

    private static string ArgValue(IReadOnlyList<string> args, string flag)
    {
        var i = args.ToList().IndexOf(flag);
        return i >= 0 && i + 1 < args.Count ? args[i + 1] : "";
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`ClaudeCodeStreamingProvider` missing).

- [ ] **Step 3: Implement `ClaudeCodeStreamingProvider.cs`**

```csharp
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>Real <see cref="IStreamingLlmProvider"/> over the persistent `claude` stream-json session.
/// Enforces every spec §6 invariant: env allowlist, unconditional tool deny-list, working-dir
/// confinement (canonical + symlink-resolved), mandatory <c>--verbose</c>.</summary>
public sealed class ClaudeCodeStreamingProvider(
    IStreamingCliProcessFactory factory, ClaudeCodeProviderOptions options) : IStreamingLlmProvider
{
    // Forced-deny: the write/exec-capable tools, taken from the PROBED v2.1.177 init `tools` array
    // (.scratch probe 5). NOTE there is NO "Computer"/"computer-use" tool in this CLI — do not ship a
    // phantom. `PowerShell` IS present (a Windows shell-exec tool) and MUST be denied alongside `Bash`.
    // `--allowedTools` restricted to the read-only set is the primary lever; this deny list is
    // belt-and-suspenders for exec/write. (Re-confirm against a fresh init line on CLI upgrade — § 9.1.)
    private static readonly string[] ForcedDeny =
        ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit"];
    private static readonly string[] DefaultAllow = ["Read", "Glob", "Grep"];

    public IStreamingLlmSession StartSession(StreamingSessionOptions options_)
    {
        ArgumentNullException.ThrowIfNull(options_);

        var workingDir = ConfineWorkingDirectory(options_.WorkingDirectory);
        var (allow, deny) = MergeTools(options_.AllowedTools, options_.DisallowedTools);

        var args = new List<string>
        {
            "-p", "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--allowedTools", string.Join(",", allow),
            "--disallowedTools", string.Join(",", deny),
        };
        if (options_.Model is not null) { args.Add("--model"); args.Add(options_.Model); }
        if (options_.AppendSystemPrompt is not null) { args.Add("--append-system-prompt"); args.Add(options_.AppendSystemPrompt); }

        var spec = new StreamingProcessSpec(
            FileName: options.ClaudeExecutable,
            Arguments: args,
            Environment: ClaudeCliEnvironment.BuildAllowlisted(),
            WorkingDirectory: workingDir);

        return new ClaudeCodeStreamingSession(factory.Start(spec));
    }

    private static (IReadOnlyList<string> allow, IReadOnlyList<string> deny) MergeTools(
        IReadOnlyList<string>? callerAllow, IReadOnlyList<string>? callerDeny)
    {
        // Deny wins: forced-deny ∪ caller-deny; allow = (default ∪ caller-allow) minus anything denied.
        var deny = new HashSet<string>(ForcedDeny, StringComparer.OrdinalIgnoreCase);
        if (callerDeny is not null) deny.UnionWith(callerDeny);
        var allow = new HashSet<string>(DefaultAllow, StringComparer.OrdinalIgnoreCase);
        if (callerAllow is not null) allow.UnionWith(callerAllow);
        allow.ExceptWith(deny);                       // never allow a denied tool
        return (allow.ToArray(), deny.ToArray());
    }

    private string ConfineWorkingDirectory(string? requested)
    {
        var baseReal = RealPath(options.WorkingDirectory);   // operator-configured base (must exist)
        if (requested is null) return baseReal;

        // Reject a non-existent requested dir OUTRIGHT — we will not lexically "normalize" a path whose
        // real location we cannot resolve. (Falling back to the lexical form is the parent-symlink-escape
        // hole: `<base>/link/nonexistent` would pass a lexical prefix check while `link` points outside.)
        if (!Directory.Exists(requested))
            throw new ArgumentException($"WorkingDirectory '{requested}' does not exist.");

        var real = RealPath(requested);
        var rel = Path.GetRelativePath(baseReal, real);
        if (rel == ".." || rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || Path.IsPathRooted(rel))
            throw new ArgumentException($"WorkingDirectory '{requested}' is outside the sanctioned base.");
        return real;
    }

    // Canonical REAL path. `Path.GetFullPath` collapses '..' LEXICALLY only; `ResolveLinkTarget` resolves
    // just the LEAF — so a symlinked PARENT would slip a lexical check. Resolve COMPONENT-BY-COMPONENT
    // (leaf, then recurse on the resolved parent) so an intermediate symlink is followed too. Callers
    // guarantee the path exists.
    private static string RealPath(string path)
    {
        var full = Path.GetFullPath(path);
        var resolved = Directory.ResolveLinkTarget(full, returnFinalTarget: true)?.FullName ?? full;
        var parent = Path.GetDirectoryName(resolved);
        if (parent is null || !Directory.Exists(parent)) return resolved;   // reached a root
        return Path.Combine(RealPath(parent), Path.GetFileName(resolved));
    }
}
```

> Tool identifiers (`Bash`, `Edit`, `Write`, `Glob`, …) are pinned from the §9 `init` `tools` array; confirm exact casing against a probe `init` line during implementation and adjust the two constants if needed (the test only requires `Bash` denied + not allowed).

- [ ] **Step 4: Run — expect PASS** (all provider tests). On Windows, `Directory.ResolveLinkTarget` on a non-link returns null → lexical form; the confinement test uses a `..` path so it is rejected lexically regardless.
- [ ] **Step 5: Commit** (`feat(#478): ClaudeCodeStreamingProvider — args, tool deny-list, dir confinement`).

---

## Task 6: `SystemStreamingCliProcess` (real impl — manual-P1 validated)

Mirrors `SystemCliProcessRunner` isolation but persistent. Unit tests cover only the OS-independent bits (env-clear, KillTree on dispose); the stream-json round-trip is **manual P1** (spec §7).

**Files:**
- Create: `PRism.AI.ClaudeCode/SystemStreamingCliProcess.cs`
- Test: add to `tests/PRism.AI.ClaudeCode.Tests/SystemCliProcessRunnerTests.cs` (a `[SkippableFact]` round-trip against `cmd`/`sh`).

- [ ] **Step 1: Write a failing OS-level test** (echo round-trip via the seam, like the existing runner test)

```csharp
    [Fact]
    public async Task Streaming_process_streams_stdout_lines_and_exits()
    {
        var factory = new SystemStreamingCliProcessFactory();
        var spec = new StreamingProcessSpec(
            FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
            Arguments: OperatingSystem.IsWindows()
                ? new[] { "/c", "echo line1& echo line2" }
                : new[] { "-c", "printf 'line1\\nline2\\n'" },
            Environment: new Dictionary<string, string> { ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "" },
            WorkingDirectory: Path.GetTempPath());

        await using var proc = factory.Start(spec);
        var lines = new List<string>();
        await foreach (var l in proc.StdoutLines) lines.Add(l.Trim());
        var exit = await proc.WaitForExitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);

        lines.Should().Contain("line1").And.Contain("line2");
        exit.Should().Be(0);
    }
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `SystemStreamingCliProcess.cs`** (mirror `SystemCliProcessRunner`: `psi.Environment.Clear()` then allowlist; redirect stdin/stdout; `ReadLineAsync` loop; KillTree on timeout/dispose)

```csharp
using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace PRism.AI.ClaudeCode;

public sealed class SystemStreamingCliProcessFactory : IStreamingCliProcessFactory
{
    public IStreamingCliProcess Start(StreamingProcessSpec spec) => SystemStreamingCliProcess.Start(spec);
}

/// <summary>The only persistent-session class touching <c>System.Diagnostics</c>. Env is the explicit
/// allowlist (parent block cleared). stdout is streamed line-by-line via <c>ReadLineAsync</c>.
/// Validated manually against the real `claude` binary (spec §7 P1), not in CI.</summary>
public sealed class SystemStreamingCliProcess : IStreamingCliProcess
{
    private readonly Process _process;
    private int _disposed;

    private SystemStreamingCliProcess(Process process) => _process = process;

    public static SystemStreamingCliProcess Start(StreamingProcessSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var psi = new ProcessStartInfo
        {
            FileName = spec.FileName,
            WorkingDirectory = spec.WorkingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in spec.Arguments) psi.ArgumentList.Add(a);
        psi.Environment.Clear();
        foreach (var (k, v) in spec.Environment) psi.Environment[k] = v;

        var process = new Process { StartInfo = psi };
        process.Start();
        return new SystemStreamingCliProcess(process);
    }

    public async IAsyncEnumerable<string> StdoutLines([EnumeratorCancellation] CancellationToken ct = default)
    {
        var reader = _process.StandardOutput;
        while (await reader.ReadLineAsync(ct).ConfigureAwait(false) is { } line)
            yield return line;
    }

    public Task WriteLineAsync(string line, CancellationToken ct) =>
        _process.StandardInput.WriteLineAsync(line.AsMemory(), ct);

    public Task CloseStdinAsync() { _process.StandardInput.Close(); return Task.CompletedTask; }

    public async Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        try { await _process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false); return _process.ExitCode; }
        catch (OperationCanceledException)
        {
            try { _process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return -1;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { if (!_process.HasExited) _process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        await Task.CompletedTask;
        _process.Dispose();
    }
}
```

- [ ] **Step 4: Run — expect PASS** (the echo round-trip).
- [ ] **Step 5: Commit** (`feat(#478): SystemStreamingCliProcess persistent process impl`).

---

## Task 7: Registration in `AddPrismClaudeCode`

**Files:**
- Modify: `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/StreamingServiceRegistrationTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class StreamingServiceRegistrationTests : IDisposable
{
    private readonly string _usageDir = Path.Combine(Path.GetTempPath(), "prism-streg-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void AddPrismClaudeCode_registers_real_streaming_provider_as_singleton()
    {
        var services = new ServiceCollection();
        services.AddPrismClaudeCode(new ClaudeCodeProviderOptions { WorkingDirectory = Path.GetTempPath() }, _usageDir);
        using var sp = services.BuildServiceProvider(validateScopes: true);

        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<ClaudeCodeStreamingProvider>();
        sp.GetRequiredService<IStreamingLlmProvider>().Should().BeSameAs(sp.GetRequiredService<IStreamingLlmProvider>());
    }

    [Fact]
    public void Real_streaming_provider_wins_over_the_slice1_noop_default()
    {
        // AddPrismClaudeCode runs before AddPrismAi in Program.cs; the TryAdd Noop default then no-ops.
        var services = new ServiceCollection();
        services.AddPrismClaudeCode(new ClaudeCodeProviderOptions { WorkingDirectory = Path.GetTempPath() }, _usageDir);
        services.AddStreamingProviderDefault();   // simulates AddPrismAi running afterwards

        using var sp = services.BuildServiceProvider();
        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<ClaudeCodeStreamingProvider>();
    }

    public void Dispose()
    {
        if (Directory.Exists(_usageDir)) Directory.Delete(_usageDir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add registrations to `AddPrismClaudeCode`** (after the `ILlmProvider` line)

```csharp
        services.AddSingleton<IStreamingCliProcessFactory, SystemStreamingCliProcessFactory>();
        services.AddSingleton<IStreamingLlmProvider>(sp => new ClaudeCodeStreamingProvider(
            sp.GetRequiredService<IStreamingCliProcessFactory>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>()));
```

- [ ] **Step 4: Run — expect PASS.** Also run the Slice-1 pinned test to confirm no regression:
Run: `dotnet test tests/PRism.AI.Contracts.Tests --filter StreamingProviderRegistrationTests`
Expected: still PASS.

- [ ] **Step 5: Commit** (`feat(#478): register real streaming provider in AddPrismClaudeCode`).

---

## Task 8: §9.1 wire-drift guard

Adds the observable drift signals (spec §9.1): a structured `warn` on an unmappable `init`/`result` line and on a terminal `result` with zero recognized `text_delta` **and** zero `LlmToolUse`. (Version-warn is folded into the provider when it first spawns; here we wire the parser/session diagnostics, which are unit-testable.) Use `Microsoft.Extensions.Logging.ILogger<ClaudeCodeStreamingSession>`; pass a captured logger in tests (the `KvCapturingLoggerProvider`/`CapturingLogger` test doubles already exist in the suite — reuse them).

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeStreamingSession.cs` (accept `ILogger`, log on `Malformed` result + zero-output turn).
- Test: add to `ClaudeCodeStreamingSessionTests.cs`.

- [ ] **Step 1: Add failing tests**

```csharp
    [Fact]
    public async Task Malformed_result_logs_warn_and_throws_unrecoverable()
    {
        var proc = new FakeStreamingCliProcess();
        var logger = new CapturingLogger<ClaudeCodeStreamingSession>();
        await using var session = new ClaudeCodeStreamingSession(proc, logger);
        proc.EmitLines(Init, """{"type":"result","subtype":"weird_new_shape"}""");

        var act = async () => { await foreach (var _ in session.Events) { } };
        await act.Should().ThrowAsync<LlmProviderException>();   // turn-termination liveness: unmappable result -> throw
        logger.Entries.Should().Contain(e => e.Level == LogLevel.Warning && e.Message.Contains("unrecognized"));
    }

    [Fact]
    public async Task Turn_with_no_text_and_no_tool_logs_suspect_warn()
    {
        var proc = new FakeStreamingCliProcess();
        var logger = new CapturingLogger<ClaudeCodeStreamingSession>();
        await using var session = new ClaudeCodeStreamingSession(proc, logger);
        proc.EmitLines(Init, Result("done"));   // success but zero text_delta, zero tool_use this turn
        proc.EndStdout();
        await foreach (var _ in session.Events) { }

        logger.Entries.Should().Contain(e => e.Level == LogLevel.Warning && e.Message.Contains("zero"));
    }
```

> `CapturingLogger<T>` was created in Task 0 (`tests/PRism.AI.ClaudeCode.Tests/TestHelpers/CapturingLogger.cs`) and the session test file already imports `PRism.AI.ClaudeCode.Tests.TestHelpers`. Its API is `.Entries` → `List<(LogLevel Level, string Message)>`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the two drift branches to `CompleteTurnAsync`.** The `ILogger` ctor param + `_logger` field, and the `_turnTextCount`/`_turnToolCount` counters (incremented in the reader's TextDelta/ToolUse arms, reset in `SendUserTurnAsync`) were ALL added in Tasks 4a/4b — **do not re-add them**. Insert only these two checks at the TOP of `CompleteTurnAsync`, before the trip/normal path:

```csharp
        if (r.Malformed)   // unmappable result -> unrecoverable (spec §4 turn-termination liveness)
        {
            _logger.LogWarning("claude stream-json: unrecognized result envelope shape — possible CLI drift (spec §9.1).");
            lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }   // resolve the turn
            _channel.Writer.TryComplete(new LlmProviderException(
                "claude streaming returned an unmappable result line.", stderr: string.Empty, exitCode: 0));
            return;
        }
        if (!r.IsError && _turnTextCount == 0 && _turnToolCount == 0)
            _logger.LogWarning("claude stream-json: turn completed with zero text and zero tool output — possible CLI drift (spec §9.1).");
```

- [ ] **Step 4: Run — expect PASS** (drift tests + all prior session tests).
- [ ] **Step 5: Commit** (`feat(#478): wire-drift guard — unmappable-result throw + zero-output warn`).

---

## Task 9: Full-suite green + manual P1 + PR

- [ ] **Step 1: Run the full backend suite**

Run: `dotnet test PRism.sln` (or the repo's pre-push backend command from `.ai/docs/development-process.md`)
Expected: all green, including the Slice-1 `StreamingProviderRegistrationTests` and the new files. Timeout ≥ 300000ms.

- [ ] **Step 2: Run `/simplify` on the diff** (quality pass before PR) and apply surviving fixes; commit separately.

- [ ] **Step 3: Manual P1 validation** (real `claude`; record outputs in the PR `## Proof`) — spec §7:
  - multi-sentence turn: ≥1 `LlmTextDelta` + one `LlmTurnComplete`, `FullText` == concatenated deltas;
  - invalid-`--model` turn → `LlmTurnError(Code="404")` then `LlmTurnComplete`; `--max-turns 1` tool turn → `LlmTurnError(Code="error_max_turns")` then `LlmTurnComplete` with `FullText=""`;
  - tool turn → exactly one `LlmToolUse`;
  - **flag-precedence:** `Bash` in both `--allowedTools` and `--disallowedTools` → denied;
  - dispose mid-generation exits < 2s; uninstalled CLI → provider stays dark.

- [ ] **Step 4: Secrets scan** — confirm no token/key/connection-string in the diff (BLOCKING).

- [ ] **Step 5: Open the PR (base V2)** via pr-autopilot. `## Proof` records: the 2× `ce-doc-review` dispositions (already in the spec commits), the empirical re-probe, the manual P1 results, and the secrets scan. **Drive to green-and-ready and STOP — owner merges (B2 gate; no auto-merge).**

---

## Self-Review (spec coverage)

| Spec §8 exit criterion | Task |
|---|---|
| `IStreamingCliProcessFactory`+`IStreamingCliProcess`+`SystemStreamingCliProcess`; `StreamingProcessSpec`; provider/session; `LlmTurnError` | 1, 2, 4, 5, 6 |
| Turn-completion TCS decoupled; back-pressure; drift guard | 4a/4d, 4f, 8 |
| Registration; Slice-1 `TryAdd` no-ops (test) | 7 |
| All §7 unit tests green (incl. security: canonical-path, deny list, JSON frame, env completeness) | 3, 4, 5, 8 |
| Manual real-CLI validation in Proof | 9 |
| 2× ce-doc-review dispositions + owner B2 | (done in spec commits) + 9 |
| #478 carry-forward checklist | 4b/4d (sequential, ProviderSessionId temporal, env parity) |

**Type-consistency check:** `IStreamingCliProcessFactory.Start(StreamingProcessSpec)`, `ClaudeStreamJson.Parse → ParsedLine/ResultLine`, `ClaudeCodeStreamingSession(IStreamingCliProcess[, ILogger])`, `ClaudeCodeStreamingProvider(IStreamingCliProcessFactory, ClaudeCodeProviderOptions)` — used identically across Tasks 2–8. No drift.
