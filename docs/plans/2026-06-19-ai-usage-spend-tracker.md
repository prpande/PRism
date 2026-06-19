# AI Usage & Spend Tracker Implementation Plan (#517)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface already-recorded AI usage (tokens + estimated cost) as a user-facing dashboard nested under AI Settings, aggregated by feature and by PR, with cache savings — backed by a durable, rotation-resilient rollup of `ai-interactions.log`.

**Architecture:** A periodic `IHostedService` byte-offset tailer folds new `ai-interactions.log` lines into an in-memory bucket store (grain = UTC-hour × Component × PrRef), atomically persisted to `{dataDir}/llm-usage/usage-rollup.json`. A `GET /api/ai/usage?window=` endpoint aggregates the in-memory buckets (no log I/O on the request path) into an `AiUsageReport` DTO. The frontend adds an "AI Usage" pane as a nested child of the AI settings nav item. One in-scope change to the AI record path: the inbox enricher emits a `CacheHit` audit record on its cache-hit branch so the cache hit-rate covers all four seams.

**Tech Stack:** .NET 10 / C# (minimal APIs, `IHostedService`, System.Text.Json `JsonNode`), React + Vite + TypeScript (vitest, Playwright), CSS modules.

**Source spec:** `docs/specs/2026-06-19-ai-usage-spend-tracker-design.md` (all section refs `§N` below point there).

## Global Constraints

- **Branch base: V2** (not `main`). This is V2 AI-roadmap work (epic #423). Raise PRs with `--base V2`.
- **TDD is mandatory** (`.ai/docs/development-process.md`): write the failing test, watch it fail, then implement. No production code without a failing test first.
- **Backend tests:** xUnit + FluentAssertions. No `Microsoft.Extensions.Time.Testing` reference exists — use a hand-rolled `TimeProvider` stub (mirror `ManualTimeProvider` in `CachedLlmAvailabilityProbeTests.cs`).
- **Audit-log writes are non-fatal by contract** (`IAiInteractionLog`): a record write must never throw into an AI call. The enricher change (Task A1) preserves this.
- **Metadata only:** `AiInteractionRecord` never carries prompt/response content. Do not add content fields.
- **Wire JSON is camelCase** with a camelCase `JsonStringEnumConverter` (host `JsonSerializerOptionsFactory.Api` for the endpoint; `JsonlAiInteractionLog.Json` for reading the log). Match it exactly.
- **Frontend:** run `npm run lint` (prettier `--check` gates CI) and `npx prettier --write` new files before staging. ESLint `no-unused-vars` ignores `_`-prefixed names.
- **Cost copy:** never the word "spent." Use "estimated equivalent cost (rate-card)" framing (§ decision 6). The headline provider is a subscription.
- **One long build/test command at a time, foreground, timeout ≥ 300000ms.**
- **Pre-push checklist** (`.ai/docs/development-process.md`) runs verbatim before any push.

### Files created / modified (decomposition map)

Backend (`PRism.Web` unless noted):
- `Ai/AiInteractionLogReader.cs` — *new*. Byte-offset reader over `ai-interactions.log`.
- `Ai/AiUsageRollupStore.cs` — *new*. In-memory buckets + atomic persist/load; the read source.
- `Ai/AiUsageRollupTailer.cs` — *new*. `IHostedService` timer; folds new lines each tick.
- `Ai/AiUsageAggregator.cs` — *new*. Pure buckets → `AiUsageReport`.
- `Ai/AiUsageReport.cs` — *new*. DTO records (§4.6).
- `Ai/ClaudeCodeInboxItemEnricher.cs` — *modify* (`:87`). Emit `CacheHit` on cache-hit branch.
- `Endpoints/AiEndpoints.cs` — *modify*. Add `GET /api/ai/usage`.
- `Program.cs` — *modify* (~line 100). Register store + hosted tailer.

Frontend (`frontend/src` unless noted):
- `utils/formatUsage.ts` + `utils/formatUsage.test.ts` — *new*. Cost/token formatters.
- `api/types.ts` — *modify*. `AiUsageReport` + sub-interfaces.
- `api/aiUsage.ts` — *new*. `getAiUsage(window)`.
- `components/Settings/panes/AiUsagePane.tsx` + `.test.tsx` — *new*.
- `components/Settings/panes/AiUsagePane.module.css` — *new*.
- `components/Settings/SettingsNav.tsx` — *modify*. Nested AI children + auto-expand.
- `components/Settings/SettingsNav.test.tsx` — *new*.
- `components/Settings/SettingsModalRoutes.tsx` — *modify*. `ai/usage` route.
- `e2e/ai-usage.spec.ts` — *new*. Nav auto-expand + pane render.

### PR split (decided per §8)

Two PRs: **PR-1 = Phase A + Phase B** (backend rollup substrate + endpoint, base V2), **PR-2 = Phase C** (frontend, base V2, opened after PR-1 merges so the endpoint exists to mock against). This is a **gated** issue — the human spec/plan gates are retained and `ce-doc-review` is **not** a substitute sign-off here.

---

## Phase A — Record-path emission + rollup substrate

### Task A1: Inbox-enricher `CacheHit` emission (§4.0)

**Files:**
- Modify: `PRism.Web/Ai/ClaudeCodeInboxItemEnricher.cs:79-101` (the `EnrichAsync` cache-hit branch at `:87`)
- Test: `tests/PRism.Web.Tests/Ai/ClaudeCodeInboxItemEnricherTests.cs`

**Interfaces:**
- Consumes: `IAiInteractionLog.Record(AiInteractionRecord)`, `AiInteractionOutcome.CacheHit`, `PrInboxItem.Reference` (a `PrReference` whose `.ToString()`/`PrId` is the canonical id), the field `_interactionLog` already injected.
- Produces: nothing new consumed downstream — this is a behavior change to an existing component. The emitted record shape (`Component="inboxEnrichment"`, `PrRef=item.Reference.PrId`, `Outcome=CacheHit`, `Egressed=false`) is what Task A3's fold counts.

The existing tests build the enricher with a `FakeAiInteractionLog` *inside* `Build`/`BuildWithBus` (not exposed). Add a builder overload that returns the log so the new test can assert on it.

- [ ] **Step 1: Write the failing test**

Add to `ClaudeCodeInboxItemEnricherTests.cs` (alongside the existing `Build*` helpers):

```csharp
    private static (ClaudeCodeInboxItemEnricher Sut, FakeAiInteractionLog Log) BuildWithLog(
        ILlmProvider provider)
    {
        var log = new FakeAiInteractionLog();
        var sut = new ClaudeCodeInboxItemEnricher(
            provider, new FakeTokenUsageTracker(), log, new CapturingBus(),
            Consented(), NullLogger<ClaudeCodeInboxItemEnricher>.Instance);
        return (sut, log);
    }

    [Fact]
    public async Task EnrichAsync_records_CacheHit_audit_record_on_cache_serve()
    {
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"feature"}]""");
        var (sut, log) = BuildWithLog(provider);

        // First call populates the cache via the background batch.
        await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);
        await sut.DrainPendingAsync();
        var okCount = log.Records.Count(r => r.Outcome == AiInteractionOutcome.Ok);

        // Second call with identical (Reference, Title, Description) is a cache hit.
        var second = await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);

        second.Single().CategoryChip.Should().Be("Feature");
        provider.CallCount.Should().Be(1); // no extra egress
        var cacheHits = log.Records
            .Where(r => r.Outcome == AiInteractionOutcome.CacheHit).ToList();
        cacheHits.Should().ContainSingle();
        cacheHits[0].Component.Should().Be("inboxEnrichment");
        cacheHits[0].PrRef.Should().Be("octo/repo#1"); // per-item PrRef, NOT "batch"
        cacheHits[0].Egressed.Should().BeFalse();
        cacheHits[0].EstimatedCostUsd.Should().BeNull();
        log.Records.Count(r => r.Outcome == AiInteractionOutcome.Ok).Should().Be(okCount); // no new Ok
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ClaudeCodeInboxItemEnricherTests.EnrichAsync_records_CacheHit_audit_record_on_cache_serve"`
Expected: FAIL — `cacheHits` is empty (the cache-hit branch records nothing today).

- [ ] **Step 3: Write minimal implementation**

In `ClaudeCodeInboxItemEnricher.cs`, the live cache-hit branch is a **single line** — `if (_cache.TryGetValue(key, out var hit)) cached.Add(hit);` with the `else if` on the next line. Replace **both** lines, converting the `if` into a braced block:

```csharp
            var key = KeyOf(i);
            if (_cache.TryGetValue(key, out var hit))
            {
                cached.Add(hit);
                // §4.0 — record a CacheHit so the usage rollup's hit-rate covers this seam too.
                // Per-item PrRef (the enricher's cache is per-item), unlike the batched Ok records
                // which use PrRef="batch". Mirrors the other three seams' cache-hit emission.
                _interactionLog.Record(new AiInteractionRecord(
                    Component: ComponentName, ProviderId: ClaudeProviderId, Model: EnrichmentModel,
                    PrRef: i.Reference.PrId, HeadSha: null,
                    Outcome: AiInteractionOutcome.CacheHit, Egressed: false));
            }
            else if (_inflight.TryAdd(key, 0)) misses.Add(i); // claim the in-flight slot
            // else: already in flight in another batch — it will publish later
```

(`IAiInteractionLog.Record` is non-fatal by contract, so no try/catch is needed here — `JsonlAiInteractionLog` swallows write failures internally.)

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ClaudeCodeInboxItemEnricherTests"`
Expected: PASS (new test + all existing enricher tests green).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/ClaudeCodeInboxItemEnricher.cs tests/PRism.Web.Tests/Ai/ClaudeCodeInboxItemEnricherTests.cs
git commit -m "feat(ai): emit CacheHit audit record from inbox enricher (#517 §4.0)"
```

---

### Task A2: `AiInteractionLogReader` (§4.3)

**Files:**
- Create: `PRism.Web/Ai/AiInteractionLogReader.cs`
- Test: `tests/PRism.Web.Tests/Ai/AiInteractionLogReaderTests.cs`

**Interfaces:**
- Consumes: `AiInteractionRecord` (`PRism.AI.Contracts.Observability`), the camelCase + enum `JsonSerializerOptions` (re-declared locally, identical to `JsonlAiInteractionLog.Json`).
- Produces (relied on by Task A4 tailer):
  - `readonly record struct LogEntry(DateTimeOffset Timestamp, AiInteractionRecord Record);`
  - `static (IReadOnlyList<LogEntry> Entries, long NewOffset) ReadFrom(string filePath, long startOffset);`
  - Contract: returns entries for every **complete** line at/after `startOffset`; `NewOffset` = byte position at the end of the last complete line consumed (== `startOffset` when nothing complete was read); missing file → empty + `startOffset` unchanged; malformed/partial lines are skipped and **do not** advance the offset past them.

- [ ] **Step 1: Write the failing test**

Create `AiInteractionLogReaderTests.cs`:

```csharp
using System.Text;
using FluentAssertions;
using PRism.AI.Contracts.Observability;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiInteractionLogReaderTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-reader-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "ai-interactions.log");

    public AiInteractionLogReaderTests() => Directory.CreateDirectory(_dir);

    // Mirrors JsonlAiInteractionLog's wire format: a leading "timestamp" then camelCase record fields.
    private static string Line(string timestampIso, string component, string outcome, string prRef,
        long? inputTokens = null) =>
        inputTokens is null
            ? $$"""{"timestamp":"{{timestampIso}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"{{outcome}}","egressed":false}"""
            : $$"""{"timestamp":"{{timestampIso}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"{{outcome}}","egressed":true,"inputTokens":{{inputTokens}}}""";

    private void Write(params string[] lines) =>
        File.WriteAllText(LogPath, string.Join(Environment.NewLine, lines) + Environment.NewLine);

    [Fact]
    public void ReadFrom_missing_file_returns_empty_and_unchanged_offset()
    {
        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);
        entries.Should().BeEmpty();
        newOffset.Should().Be(0);
    }

    [Fact]
    public void ReadFrom_zero_offset_reads_all_complete_lines_with_timestamp_and_record()
    {
        Write(
            Line("2026-06-19T10:15:00.0000000+00:00", "summary", "ok", "o/r#1", inputTokens: 100),
            Line("2026-06-19T11:30:00.0000000+00:00", "fileFocus", "cacheHit", "o/r#2"));

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().HaveCount(2);
        entries[0].Timestamp.Should().Be(new DateTimeOffset(2026, 6, 19, 10, 15, 0, TimeSpan.Zero));
        entries[0].Record.Component.Should().Be("summary");
        entries[0].Record.Outcome.Should().Be(AiInteractionOutcome.Ok);
        entries[0].Record.InputTokens.Should().Be(100);
        entries[1].Record.Outcome.Should().Be(AiInteractionOutcome.CacheHit);
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_nonzero_offset_reads_only_new_lines()
    {
        Write(Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100));
        var firstLen = new FileInfo(LogPath).Length;
        File.AppendAllText(LogPath,
            Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200) + Environment.NewLine);

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, firstLen);

        entries.Should().ContainSingle();
        entries[0].Record.PrRef.Should().Be("o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_partial_trailing_line_is_not_consumed_and_offset_stops_before_it()
    {
        var complete = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        // A complete line + newline, then a half-written line with NO trailing newline.
        File.WriteAllText(LogPath, complete + Environment.NewLine + """{"timestamp":"2026-06-19T11""");
        var expectedOffset = Encoding.UTF8.GetByteCount(complete + Environment.NewLine);

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().ContainSingle();
        newOffset.Should().Be(expectedOffset); // stops at end of the complete line
    }

    [Fact]
    public void ReadFrom_malformed_complete_line_is_skipped_but_offset_advances_past_it()
    {
        var good = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        Write(good, "this is not json", Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200));

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().HaveCount(2); // the two valid lines; the garbage line skipped
        entries.Select(e => e.Record.PrRef).Should().Equal("o/r#1", "o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length); // a COMPLETE garbage line still advances
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiInteractionLogReaderTests"`
Expected: FAIL — `AiInteractionLogReader` does not exist (compile error).

- [ ] **Step 3: Write minimal implementation**

Create `AiInteractionLogReader.cs`:

```csharp
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using PRism.AI.Contracts.Observability;

namespace PRism.Web.Ai;

/// <summary>Reads <c>ai-interactions.log</c> lines starting at a byte offset, returning each
/// complete line's leading <c>timestamp</c> + deserialized <see cref="AiInteractionRecord"/> and the
/// new byte offset (end of the last COMPLETE line consumed). A partial trailing line (mid-append) is
/// left for the next read and the offset stops before it; a complete-but-malformed line is skipped
/// (record dropped) but still advances the offset past it. Used only by <see cref="AiUsageRollupTailer"/>.
/// Uses the same camelCase + enum options <see cref="JsonlAiInteractionLog"/> writes with.</summary>
internal static class AiInteractionLogReader
{
    internal readonly record struct LogEntry(DateTimeOffset Timestamp, AiInteractionRecord Record);

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static (IReadOnlyList<LogEntry> Entries, long NewOffset) ReadFrom(string filePath, long startOffset)
    {
        if (!File.Exists(filePath)) return (Array.Empty<LogEntry>(), startOffset);

        var entries = new List<LogEntry>();
        var offset = startOffset;

        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (startOffset > stream.Length) return (Array.Empty<LogEntry>(), startOffset); // caller handles truncation
        stream.Seek(startOffset, SeekOrigin.Begin);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            // ReadLine returns a non-null string for the final chunk even when it had NO terminator
            // (a partial mid-write line). Detect that: if the stream position is at EOF AND the raw
            // bytes we just consumed were not newline-terminated, this is a partial line — stop without
            // advancing past it.
            var consumedBytes = Encoding.UTF8.GetByteCount(line);
            var atEof = stream.Position >= stream.Length && reader.EndOfStream;
            var terminated = !atEof || EndsWithNewline(filePath, offset + consumedBytes);
            if (!terminated) break; // partial trailing line — leave for next tick, offset unchanged past it

            var lineBytesWithTerminator = NextLineByteLength(filePath, offset);
            if (TryParse(line, out var entry)) entries.Add(entry);
            offset += lineBytesWithTerminator; // advance past complete line (even if it failed to parse)
        }

        return (entries, offset);
    }

    private static bool TryParse(string line, out LogEntry entry)
    {
        entry = default;
        if (string.IsNullOrWhiteSpace(line)) return false;
        try
        {
            var node = JsonNode.Parse(line)?.AsObject();
            if (node is null) return false;
            var ts = node["timestamp"]?.GetValue<string>();
            if (ts is null || !DateTimeOffset.TryParse(ts, out var when)) return false;
            var record = node.Deserialize<AiInteractionRecord>(Json);
            if (record is null) return false;
            entry = new LogEntry(when, record);
            return true;
        }
        catch (JsonException) { return false; }
        catch (FormatException) { return false; }
    }

    // Byte length of the line beginning at byteOffset, INCLUDING its terminator.
    private static long NextLineByteLength(string filePath, long byteOffset)
    {
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        fs.Seek(byteOffset, SeekOrigin.Begin);
        long count = 0;
        int b;
        while ((b = fs.ReadByte()) != -1)
        {
            count++;
            if (b == '\n') break; // covers both "\n" and "\r\n"
        }
        return count;
    }

    private static bool EndsWithNewline(string filePath, long byteOffsetAfterText)
    {
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (byteOffsetAfterText >= fs.Length) return false;
        fs.Seek(byteOffsetAfterText, SeekOrigin.Begin);
        var b = fs.ReadByte();
        return b == '\n' || b == '\r';
    }
}
```

> **Implementer note (altitude):** the byte-accounting above re-reads the file to measure line lengths, which is correct but does extra I/O. If the green tests pass and you see a cleaner single-pass approach (e.g. read the whole new region into a byte buffer once, split on `\n`, track whether the final segment was newline-terminated, and compute offsets from segment byte lengths), refactor to that in Step 4's refactor phase **while keeping every test green**. The test contract — complete vs. partial trailing line, skip-but-advance on malformed, offset == end of last complete line — is the spec; the implementation detail is not.

> **Edge case — torn final line can stall the offset (documented; optional V1 hardening):** the partial-trailing-line guard defers a non-newline-terminated final line to the next tick. If a crash tears a write (line bytes flushed, terminator never written), that line's terminator never arrives — the reader re-defers the same bytes every tick and the offset never advances, silently under-counting all *subsequent* lines once writing resumes. This is rare (the audit sink writes `line + Environment.NewLine` in one `File.AppendAllText` call, so a tear requires a crash mid-flush). Tracked as an accepted V1 limitation; the cheap mitigation (deferred to a follow-up) is in Task A4's tick: if the file length is unchanged across N consecutive ticks while a partial line blocks the offset, log a warning and skip past the orphaned bytes to EOF.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiInteractionLogReaderTests"`
Expected: PASS (all 5). If green, optionally refactor per the note, re-running to stay green.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/AiInteractionLogReader.cs tests/PRism.Web.Tests/Ai/AiInteractionLogReaderTests.cs
git commit -m "feat(ai): add byte-offset AiInteractionLogReader (#517 §4.3)"
```

---

### Task A3: `AiUsageRollupStore` (§4.1)

**Files:**
- Create: `PRism.Web/Ai/AiUsageRollupStore.cs`
- Test: `tests/PRism.Web.Tests/Ai/AiUsageRollupStoreTests.cs`

**Interfaces:**
- Consumes: `AiInteractionLogReader.LogEntry`, `AiInteractionRecord`, `AiInteractionOutcome`, `TimeProvider`.
- Produces (relied on by Task A4 tailer + Task B2 aggregator):
  - `internal sealed record UsageBucket(long HourEpoch, string Component, string PrRef, long InputTokens, long OutputTokens, long CacheReadInputTokens, long CacheCreationInputTokens, decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);`
  - `long TailOffset { get; }` and `bool IsDirty { get; }`
  - `void Load();` — read `usage-rollup.json`; corrupt/missing → empty store at offset 0.
  - `void Fold(in AiInteractionLogReader.LogEntry entry);` — update the (hour, component, prRef) bucket; marks dirty.
  - `void Advance(long newOffset, long sourceLength);` — set offset + source length; marks dirty if changed.
  - `void Reset();` — clear buckets, offset 0; marks dirty (truncation rebuild).
  - `void Persist();` — atomic temp+rename of `{ buckets, tailOffset, sourceLength }`; clears dirty.
  - `IReadOnlyList<UsageBucket> SnapshotBuckets();` — copy under lock (for the aggregator/endpoint).

> **Deviation from spec §4.1 (documented):** §4.1 says set an explicit owner ACL on Windows. The sibling `JsonlTokenUsageTracker` sets **no** Windows ACL — it relies on the OS-default per-user `dataDir` ACL and only `chmod 700`s on POSIX. The rollup file lives in that same already-restricted `llm-usage` directory. This task mirrors the sibling exactly (POSIX `chmod 700` on the dir; Windows no-op) rather than introduce Windows ACL code that exists nowhere else in the repo. Permissions are therefore inherited from the dir, which the token tracker already restricts.

ProviderCalls/CacheHits counting is **by `Outcome`, not `Egressed`** (§4.1): `ProviderCalls = count(Ok) + count(ProviderError)`; `CacheHits = count(CacheHit)`; `Fallback` is folded for durability but contributes 0 to ProviderCalls and 0 cost.

- [ ] **Step 1: Write the failing test**

Create `AiUsageRollupStoreTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.Contracts.Observability;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageRollupStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-rollup-" + Guid.NewGuid().ToString("N"));

    private AiUsageRollupStore NewStore() => new(_dir, TimeProvider.System);

    private static AiInteractionLogReader.LogEntry Entry(
        string component, string prRef, AiInteractionOutcome outcome, bool egressed,
        long hour, long input = 0, decimal? cost = null) =>
        new(new DateTimeOffset(2026, 6, 19, (int)hour, 0, 0, TimeSpan.Zero),
            new AiInteractionRecord(component, "claude-code", "m", prRef, null, outcome, egressed,
                InputTokens: input == 0 ? null : input, EstimatedCostUsd: cost));

    [Fact]
    public void Fold_aggregates_into_one_bucket_per_hour_component_pr()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 50, cost: 0.02m));

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.InputTokens.Should().Be(150);
        bucket.EstimatedCostUsd.Should().Be(0.03m);
        bucket.ProviderCalls.Should().Be(2);
    }

    [Fact]
    public void Fold_separates_buckets_by_hour_and_by_pr()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 11, input: 100)); // diff hour
        store.Fold(Entry("summary", "o/r#2", AiInteractionOutcome.Ok, true, 10, input: 100)); // diff pr
        store.SnapshotBuckets().Should().HaveCount(3);
    }

    [Fact]
    public void ProviderCalls_counts_Ok_and_ProviderError_by_outcome_not_egressed()
    {
        // A fallback scenario: 2 Ok attempts + 1 Fallback, ALL Egressed:true. Counting by Egressed
        // would yield 3; counting by Outcome correctly yields 2 provider calls.
        var store = NewStore();
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Fallback, true, 10)); // synthetic

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.ProviderCalls.Should().Be(2);
        bucket.EstimatedCostUsd.Should().Be(0.02m); // fallback carries no cost
        bucket.CacheHits.Should().Be(0);
    }

    [Fact]
    public void ProviderError_is_a_provider_call_with_zero_cost_and_CacheHit_is_separate()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.ProviderError, true, 10));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.CacheHit, false, 10));

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.ProviderCalls.Should().Be(1);
        bucket.CacheHits.Should().Be(1);
        bucket.EstimatedCostUsd.Should().Be(0m);
    }

    [Fact]
    public void Persist_then_Load_roundtrips_buckets_and_offset()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.05m));
        store.Advance(newOffset: 4096, sourceLength: 4096);
        store.Persist();

        var reloaded = NewStore();
        reloaded.Load();
        reloaded.TailOffset.Should().Be(4096);
        var bucket = reloaded.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.InputTokens.Should().Be(100);
        bucket.EstimatedCostUsd.Should().Be(0.05m);
    }

    [Fact]
    public void Load_on_missing_or_corrupt_file_yields_empty_store_at_offset_zero()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "usage-rollup.json"), "{ this is not valid json");
        var store = NewStore();
        store.Load();
        store.SnapshotBuckets().Should().BeEmpty();
        store.TailOffset.Should().Be(0);
    }

    [Fact]
    public void Reset_clears_buckets_and_offset()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.Advance(100, 100);
        store.Reset();
        store.SnapshotBuckets().Should().BeEmpty();
        store.TailOffset.Should().Be(0);
    }

    [Fact]
    public void IsDirty_is_set_by_Fold_and_cleared_by_Persist()
    {
        var store = NewStore();
        store.IsDirty.Should().BeFalse();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.IsDirty.Should().BeTrue();
        store.Persist();
        store.IsDirty.Should().BeFalse();
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageRollupStoreTests"`
Expected: FAIL — `AiUsageRollupStore` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `AiUsageRollupStore.cs`:

```csharp
using System.Text.Json;

namespace PRism.Web.Ai;

/// <summary>In-memory rollup of AI usage, grain = (UTC-hour, Component, PrRef), persisted atomically
/// to <c>usage-rollup.json</c> alongside the byte offset into <c>ai-interactions.log</c> that the
/// buckets reflect. The authoritative read source for the usage endpoint — the aggregator reads
/// <see cref="SnapshotBuckets"/>, never the log. Single logical writer (the tailer timer); a lock
/// guards every mutation + snapshot so the request thread can read concurrently. Counts are by
/// <c>Outcome</c> (NOT <c>Egressed</c>): ProviderCalls = Ok+ProviderError, CacheHits = CacheHit,
/// Fallback folded but neither a provider call nor cost-bearing (§4.1).</summary>
internal sealed class AiUsageRollupStore
{
    internal sealed record UsageBucket(
        long HourEpoch, string Component, string PrRef,
        long InputTokens, long OutputTokens, long CacheReadInputTokens, long CacheCreationInputTokens,
        decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);

    private sealed record Snapshot(long TailOffset, long SourceLength, IReadOnlyList<UsageBucket> Buckets);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _dir;
    private readonly string _path;
    private readonly TimeProvider _clock; // reserved for future time-based pruning; keeps ctor parity with the tailer
    private readonly object _gate = new();
    private readonly Dictionary<(long, string, string), UsageBucket> _buckets = new();
    private long _tailOffset;
    private long _sourceLength;
    private bool _dirty;

    public AiUsageRollupStore(string usageDir, TimeProvider clock)
    {
        ArgumentException.ThrowIfNullOrEmpty(usageDir);
        _dir = usageDir;
        _clock = clock;
        _path = Path.Combine(usageDir, "usage-rollup.json");
    }

    public long TailOffset { get { lock (_gate) return _tailOffset; } }
    public bool IsDirty { get { lock (_gate) return _dirty; } }

    public void Load()
    {
        lock (_gate)
        {
            _buckets.Clear();
            _tailOffset = 0;
            _sourceLength = 0;
            _dirty = false;
            if (!File.Exists(_path)) return;
            try
            {
                var snap = JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(_path), Json);
                if (snap is null) return;
                _tailOffset = snap.TailOffset;
                _sourceLength = snap.SourceLength;
                foreach (var b in snap.Buckets)
                    _buckets[(b.HourEpoch, b.Component, b.PrRef)] = b;
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                // Corrupt/unreadable → empty store at offset 0; the tailer's first tick rebuilds.
                _buckets.Clear();
                _tailOffset = 0;
                _sourceLength = 0;
            }
        }
    }

    public void Fold(in AiInteractionLogReader.LogEntry entry)
    {
        var r = entry.Record;
        var hourEpoch = entry.Timestamp.ToUniversalTime().ToUnixTimeSeconds() / 3600;
        var key = (hourEpoch, r.Component, r.PrRef);
        var isProviderCall = r.Outcome is AiInteractionOutcome.Ok or AiInteractionOutcome.ProviderError;
        var isCacheHit = r.Outcome is AiInteractionOutcome.CacheHit;

        lock (_gate)
        {
            var b = _buckets.TryGetValue(key, out var existing)
                ? existing
                : new UsageBucket(hourEpoch, r.Component, r.PrRef, 0, 0, 0, 0, 0m, 0, 0);
            _buckets[key] = b with
            {
                InputTokens = b.InputTokens + (r.InputTokens ?? 0),
                OutputTokens = b.OutputTokens + (r.OutputTokens ?? 0),
                CacheReadInputTokens = b.CacheReadInputTokens + (r.CacheReadInputTokens ?? 0),
                CacheCreationInputTokens = b.CacheCreationInputTokens + (r.CacheCreationInputTokens ?? 0),
                EstimatedCostUsd = b.EstimatedCostUsd + (r.EstimatedCostUsd ?? 0m),
                ProviderCalls = b.ProviderCalls + (isProviderCall ? 1 : 0),
                CacheHits = b.CacheHits + (isCacheHit ? 1 : 0),
            };
            _dirty = true;
        }
    }

    public void Advance(long newOffset, long sourceLength)
    {
        lock (_gate)
        {
            if (newOffset != _tailOffset || sourceLength != _sourceLength) _dirty = true;
            _tailOffset = newOffset;
            _sourceLength = sourceLength;
        }
    }

    public void Reset()
    {
        lock (_gate)
        {
            _buckets.Clear();
            _tailOffset = 0;
            _sourceLength = 0;
            _dirty = true;
        }
    }

    public void Persist()
    {
        lock (_gate)
        {
            EnsureDir();
            var snap = new Snapshot(_tailOffset, _sourceLength, _buckets.Values.ToList());
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(snap, Json));
            File.Move(tmp, _path, overwrite: true); // atomic replace: buckets + offset stay consistent
            _dirty = false;
        }
    }

    public IReadOnlyList<UsageBucket> SnapshotBuckets()
    {
        lock (_gate) return _buckets.Values.ToList();
    }

    private void EnsureDir()
    {
        Directory.CreateDirectory(_dir);
        if (!OperatingSystem.IsWindows())
        {
            // POSIX owner-only (rwx------), mirroring JsonlTokenUsageTracker. Windows relies on the
            // OS-default per-user dataDir ACL (the token tracker does the same — no ACL code there).
            File.SetUnixFileMode(_dir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageRollupStoreTests"`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/AiUsageRollupStore.cs tests/PRism.Web.Tests/Ai/AiUsageRollupStoreTests.cs
git commit -m "feat(ai): add durable AiUsageRollupStore (#517 §4.1)"
```

---

### Task A4: `AiUsageRollupTailer` hosted service + DI wiring (§4.2)

**Files:**
- Create: `PRism.Web/Ai/AiUsageRollupTailer.cs`
- Modify: `PRism.Web/Program.cs` (~line 100, after `builder.Services.AddPrismAi();`)
- Test: `tests/PRism.Web.Tests/Ai/AiUsageRollupTailerTests.cs`

**Interfaces:**
- Consumes: `AiUsageRollupStore` (Task A3), `AiInteractionLogReader.ReadFrom` (Task A2), `TimeProvider`, `ILogger<AiUsageRollupTailer>`, `IHostedService`.
- Produces: `internal async Task TickAsync(CancellationToken ct)` — the unit-testable core (read + fold + truncation-check + persist-if-dirty). `StartAsync` loads + launches the loop without blocking on backfill; `StopAsync` does one final tick.

- [ ] **Step 1: Write the failing test**

Create `AiUsageRollupTailerTests.cs`:

```csharp
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageRollupTailerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-tailer-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "ai-interactions.log");

    public AiUsageRollupTailerTests() => Directory.CreateDirectory(_dir);

    private AiUsageRollupStore NewStore() => new(_dir, TimeProvider.System);
    private AiUsageRollupTailer NewTailer(AiUsageRollupStore store) =>
        new(store, LogPath, TimeProvider.System, NullLogger<AiUsageRollupTailer>.Instance);

    private static string OkLine(string ts, string component, string prRef, long input) =>
        $$"""{"timestamp":"{{ts}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"ok","egressed":true,"inputTokens":{{input}},"estimatedCostUsd":0.01}""";

    private void WriteLog(params string[] lines) =>
        File.WriteAllText(LogPath, string.Join(Environment.NewLine, lines) + Environment.NewLine);

    [Fact]
    public async Task Tick_folds_new_lines_and_advances_offset()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        var tailer = NewTailer(store);

        await tailer.TickAsync(default);

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100);
        store.TailOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public async Task Tick_after_crash_before_persist_does_not_double_count()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store1 = NewStore();
        await NewTailer(store1).TickAsync(default); // folds + persists

        // Simulate a crash: in-memory state lost. A fresh store loads from the PERSISTED offset.
        var store2 = NewStore();
        store2.Load();
        await NewTailer(store2).TickAsync(default); // re-tick over the same (already-consumed) file

        store2.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100); // not 200
    }

    [Fact]
    public async Task Tick_rebuilds_from_zero_when_file_shrinks_below_offset()
    {
        WriteLog(
            OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100),
            OkLine("2026-06-19T11:00:00.0000000+00:00", "summary", "o/r#2", 200));
        var store = NewStore();
        await NewTailer(store).TickAsync(default);
        store.TailOffset.Should().BeGreaterThan(0);

        // Truncate the log to a single, shorter line — file length < persisted offset.
        WriteLog(OkLine("2026-06-19T12:00:00.0000000+00:00", "summary", "o/r#3", 50));
        await NewTailer(store).TickAsync(default);

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(50); // rebuilt
    }

    [Fact]
    public async Task Tick_does_not_persist_when_nothing_new()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        await NewTailer(store).TickAsync(default); // persists once
        var rollupPath = Path.Combine(_dir, "usage-rollup.json");
        var firstWrite = File.GetLastWriteTimeUtc(rollupPath);

        await NewTailer(store).TickAsync(default); // nothing new → must not rewrite
        store.IsDirty.Should().BeFalse();
        File.GetLastWriteTimeUtc(rollupPath).Should().Be(firstWrite);
    }

    [Fact]
    public async Task StopAsync_does_a_final_tick()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        var tailer = NewTailer(store);
        await tailer.StartAsync(default); // loads; does not block on backfill
        await tailer.StopAsync(default);  // final tick folds the line

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageRollupTailerTests"`
Expected: FAIL — `AiUsageRollupTailer` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `AiUsageRollupTailer.cs`:

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PRism.Web.Ai;

/// <summary>Periodic byte-offset tailer that folds new <c>ai-interactions.log</c> lines into
/// <see cref="AiUsageRollupStore"/>. Fully decoupled from the AI record path — nothing it does can
/// fail an AI call. Cursor is a byte offset (no clock dependency, no same-timestamp ties); single
/// writer (this timer). Startup does NOT block on backfill: the first tick runs in the loop. Bounds
/// dashboard staleness to ≤ the tick interval (§4.2).</summary>
internal sealed partial class AiUsageRollupTailer : IHostedService, IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);

    private readonly AiUsageRollupStore _store;
    private readonly string _logPath;
    private readonly TimeProvider _clock;
    private readonly ILogger<AiUsageRollupTailer> _logger;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    public AiUsageRollupTailer(AiUsageRollupStore store, string logPath, TimeProvider clock,
        ILogger<AiUsageRollupTailer> logger)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentException.ThrowIfNullOrEmpty(logPath);
        _store = store;
        _logPath = logPath;
        _clock = clock;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _store.Load();
        _loop = Task.Run(() => RunLoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask; // do NOT await the loop — backfill happens in the background
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _cts.Cancel();
        if (_loop is not null)
        {
            try { await _loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        try { await TickAsync(cancellationToken).ConfigureAwait(false); } // final tick so shutdown leaves it current
        catch (OperationCanceledException) { }
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(Interval, _clock);
        do
        {
            try { await TickAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { Log.TickFailed(_logger, ex); } // never let the loop die on a transient IO error
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    internal Task TickAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var fileLength = File.Exists(_logPath) ? new FileInfo(_logPath).Length : 0;

        // Truncation / shrink (or future rotation): file shorter than where we last read → rebuild.
        if (fileLength < _store.TailOffset)
        {
            Log.Truncated(_logger, _store.TailOffset, fileLength);
            _store.Reset();
        }

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(_logPath, _store.TailOffset);
        foreach (var entry in entries) _store.Fold(entry);
        _store.Advance(newOffset, fileLength);

        if (_store.IsDirty) _store.Persist(); // persist offset + buckets atomically, only when changed
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _cts.Cancel();
        _cts.Dispose();
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "ai-usage rollup: tick failed (non-fatal; will retry next interval)")]
        internal static partial void TickFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning,
            Message = "ai-usage rollup: log shrank (offset {Offset} > length {Length}); rebuilding from 0")]
        internal static partial void Truncated(ILogger logger, long offset, long length);
    }
}
```

> **Note on `PeriodicTimer(Interval, _clock)`:** the `TimeProvider` overload of `PeriodicTimer` exists on .NET 8+. The loop is not unit-tested for timing (the tests drive `TickAsync` directly); `StartAsync`/`StopAsync` are covered without waiting on a real interval.

> **Edge case — concurrent read during a truncation rebuild (documented; conf-50 FYI):** `TickAsync` is not atomic across `Reset()` → re-fold. On a truncation rebuild, a `GET /api/ai/usage` that calls `SnapshotBuckets()` between `Reset()` (buckets cleared) and the end of the re-fold observes a partially-rebuilt store and under-reports for that one tick. The window is a single rebuild tick and self-heals on the next read; truncation is the rare path (`ai-interactions.log` does not rotate). Accepted for V1 (matches the spec's "bounded staleness" acceptance, §6). Optional hardening if it ever matters: build the rebuilt bucket set in a local dictionary and swap it into the store under a single lock, so a concurrent snapshot never sees the cleared-but-not-refilled intermediate.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageRollupTailerTests"`
Expected: PASS (all 5).

- [ ] **Step 5: Wire DI in Program.cs**

In `Program.cs`, immediately after `builder.Services.AddPrismAi();` (line 99) and before `builder.Services.AddPrismWeb();`, add:

```csharp
// #517 — durable AI-usage rollup. The store is the read source for GET /api/ai/usage; the tailer
// folds new ai-interactions.log lines into it on a 60s timer (fully decoupled from the AI record
// path). llmUsageDir holds the rollup file (same owner-restricted dir as token-usage.jsonl); the
// log lives under LogsPathInfo.Path (= dataDir/logs), where JsonlAiInteractionLog writes it.
builder.Services.AddSingleton(sp => new PRism.Web.Ai.AiUsageRollupStore(llmUsageDir, TimeProvider.System));
builder.Services.AddHostedService(sp => new PRism.Web.Ai.AiUsageRollupTailer(
    sp.GetRequiredService<PRism.Web.Ai.AiUsageRollupStore>(),
    Path.Combine(sp.GetRequiredService<PRism.Web.Logging.LogsPathInfo>().Path, "ai-interactions.log"),
    TimeProvider.System,
    sp.GetRequiredService<ILogger<PRism.Web.Ai.AiUsageRollupTailer>>()));
```

- [ ] **Step 6: Verify the whole project still builds + host starts**

Run: `dotnet build PRism.Web`
Expected: Build succeeded. (The hosted service registers; DI graph resolves — `AiUsageRollupStore` is a singleton, `LogsPathInfo` is already registered at line 57.)

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Ai/AiUsageRollupTailer.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Ai/AiUsageRollupTailerTests.cs
git commit -m "feat(ai): add AiUsageRollupTailer hosted service + DI wiring (#517 §4.2)"
```

---

## Phase B — Read side (aggregator + DTO + endpoint)

### Task B1: `AiUsageReport` DTO (§4.6)

**Files:**
- Create: `PRism.Web/Ai/AiUsageReport.cs`

**Interfaces:**
- Produces (relied on by Tasks B2, B3, and mirrored by frontend Task C2): the records exactly as in §4.6.

This task has no behavior, so it has no standalone test — it is exercised by Task B2's aggregator tests (which construct/return these records) and B3's endpoint tests. Per TDD, the failing test that motivates these types is **B2 Step 1**; create this file as the minimal type definitions needed to make B2 compile. (Folded into B2's cycle: write B2's test first, watch it fail to compile, then add this file + the aggregator.)

- [ ] **Step 1: Create the DTO file**

Create `AiUsageReport.cs`:

```csharp
namespace PRism.Web.Ai;

/// <summary>Aggregated AI usage for a window, served by GET /api/ai/usage (§4.6). Cost is a
/// provider-estimated rate-card figure, NOT a literal charge (the provider is a subscription).</summary>
public sealed record AiUsageReport(
    string Window,                       // echoes "24h" | "7d" | "30d" | "all"
    DateTimeOffset GeneratedAt,
    AiUsageTotals Totals,
    IReadOnlyList<AiUsageFeatureRow> ByFeature,
    IReadOnlyList<AiUsagePrRow> ByPr,    // top 20 by cost (+ "batch" always); see TotalPrCount
    int TotalPrCount,                    // total distinct PrRefs in window (for "+N more")
    AiCacheStats Cache,
    IReadOnlyList<AiUsageTrendBucket> Trend);

public sealed record AiUsageTotals(
    long InputTokens, long OutputTokens, long CacheReadInputTokens, long CacheCreationInputTokens,
    long TotalTokens,                    // sum of all four kinds = total provider activity for the window
    decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);

public sealed record AiUsageFeatureRow(
    string Component, string DisplayName, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

public sealed record AiUsagePrRow(
    string PrRef, string DisplayLabel, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

public sealed record AiCacheStats(int CacheHits, int ProviderCalls, double HitRate);

public sealed record AiUsageTrendBucket(
    DateTimeOffset BucketStart, string Granularity, decimal EstimatedCostUsd, long TotalTokens);
```

(Commit is folded into Task B2's commit, since this file alone does nothing.)

---

### Task B2: `AiUsageAggregator` (§4.4)

**Files:**
- Create: `PRism.Web/Ai/AiUsageAggregator.cs`
- Create (B1): `PRism.Web/Ai/AiUsageReport.cs`
- Test: `tests/PRism.Web.Tests/Ai/AiUsageAggregatorTests.cs`

**Interfaces:**
- Consumes: `AiUsageRollupStore.UsageBucket` (Task A3), the DTO records (B1).
- Produces: `static AiUsageReport Aggregate(IReadOnlyCollection<AiUsageRollupStore.UsageBucket> buckets, string window, DateTimeOffset now);`
  - Window filter: `24h` = bucket hour ≥ now−24h; `7d`/`30d` = trailing N days; `all`/unknown = no filter.
  - ByFeature: group by Component → display name (table in §2; unknown → raw Component), sort by cost desc.
  - ByPr: group by PrRef; sort by cost desc; cap top 20 by cost; `TotalPrCount` = distinct PrRefs in window; `"batch"` row (label "Inbox (batched)") always included even past the cap.
  - Cache: `HitRate = CacheHits / (CacheHits + ProviderCalls)`, 0 when denominator 0.
  - Trend: hourly for 24h; daily for 7d/30d/all; weekly for `all` when span > 90 days.

- [ ] **Step 1: Write the failing test**

Create `AiUsageAggregatorTests.cs`:

```csharp
using FluentAssertions;
using PRism.Web.Ai;
using Xunit;
using Bucket = PRism.Web.Ai.AiUsageRollupStore.UsageBucket;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageAggregatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 6, 19, 12, 0, 0, TimeSpan.Zero);

    private static long HourEpoch(DateTimeOffset when) => when.ToUnixTimeSeconds() / 3600;

    private static Bucket B(string component, string prRef, DateTimeOffset hour,
        long input = 0, decimal cost = 0m, int providerCalls = 0, int cacheHits = 0) =>
        new(HourEpoch(hour), component, prRef, input, 0, 0, 0, cost, providerCalls, cacheHits);

    [Fact]
    public void Aggregate_24h_excludes_buckets_older_than_24h()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 100, cost: 0.05m, providerCalls: 1),
            B("summary", "o/r#2", Now.AddHours(-30), input: 999, cost: 9.99m, providerCalls: 1), // outside 24h
        };
        var report = AiUsageAggregator.Aggregate(buckets, "24h", Now);

        report.Window.Should().Be("24h");
        report.Totals.TotalTokens.Should().Be(100);
        report.Totals.EstimatedCostUsd.Should().Be(0.05m);
        report.Totals.ProviderCalls.Should().Be(1);
    }

    [Fact]
    public void Aggregate_all_window_includes_everything()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 100, cost: 0.05m, providerCalls: 1),
            B("summary", "o/r#2", Now.AddDays(-200), input: 50, cost: 0.02m, providerCalls: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "all", Now);
        report.Totals.TotalTokens.Should().Be(150);
    }

    [Fact]
    public void Aggregate_byFeature_maps_display_names_and_sorts_by_cost_desc()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
            B("fileFocus", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.50m, providerCalls: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);

        report.ByFeature[0].Component.Should().Be("fileFocus");
        report.ByFeature[0].DisplayName.Should().Be("File Focus");
        report.ByFeature[1].DisplayName.Should().Be("PR Summary");
    }

    [Fact]
    public void Aggregate_unknown_component_passes_through_with_raw_name()
    {
        var buckets = new[] { B("futureSeam", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1) };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);
        report.ByFeature.Should().ContainSingle().Which.DisplayName.Should().Be("futureSeam");
    }

    [Fact]
    public void Aggregate_byPr_caps_top_20_but_always_includes_batch_and_reports_total_count()
    {
        var buckets = new List<Bucket>();
        for (var i = 0; i < 25; i++)
            buckets.Add(B("summary", $"o/r#{i}", Now.AddHours(-1), input: 10, cost: (i + 1) * 0.01m, providerCalls: 1));
        // A cheap batch row that would fall outside the top-20-by-cost cut.
        buckets.Add(B("inboxEnrichment", "batch", Now.AddHours(-1), input: 1, cost: 0.0001m, providerCalls: 1));

        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);

        report.TotalPrCount.Should().Be(26);
        report.ByPr.Should().HaveCountLessOrEqualTo(21); // 20 + the always-included batch
        report.ByPr.Should().Contain(r => r.PrRef == "batch");
        report.ByPr.Single(r => r.PrRef == "batch").DisplayLabel.Should().Be("Inbox (batched)");
    }

    [Fact]
    public void Aggregate_cache_hitRate_is_zero_when_no_activity()
    {
        var report = AiUsageAggregator.Aggregate(Array.Empty<Bucket>(), "7d", Now);
        report.Cache.HitRate.Should().Be(0);
        report.Totals.TotalTokens.Should().Be(0);
        report.ByFeature.Should().BeEmpty();
        report.ByPr.Should().BeEmpty();
    }

    [Fact]
    public void Aggregate_cache_hitRate_uses_hits_over_hits_plus_provider_calls()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), providerCalls: 3, cacheHits: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);
        report.Cache.CacheHits.Should().Be(1);
        report.Cache.ProviderCalls.Should().Be(3);
        report.Cache.HitRate.Should().BeApproximately(0.25, 0.0001); // 1 / (1 + 3)
    }

    [Fact]
    public void Aggregate_trend_is_hourly_for_24h_and_daily_for_7d()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
            B("summary", "o/r#1", Now.AddHours(-2), input: 10, cost: 0.01m, providerCalls: 1),
        };
        AiUsageAggregator.Aggregate(buckets, "24h", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "hour");
        AiUsageAggregator.Aggregate(buckets, "7d", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "day");
    }

    [Fact]
    public void Aggregate_trend_is_weekly_for_all_when_span_exceeds_90_days()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddDays(-120), input: 10, cost: 0.01m, providerCalls: 1),
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
        };
        AiUsageAggregator.Aggregate(buckets, "all", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "week");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageAggregatorTests"`
Expected: FAIL — `AiUsageAggregator` and the DTO types do not exist (compile error). Create `AiUsageReport.cs` (Task B1) now so the test compiles to a runtime failure, then proceed.

- [ ] **Step 3: Write minimal implementation**

Create `AiUsageReport.cs` per Task B1 (if not already), then create `AiUsageAggregator.cs`:

```csharp
using Bucket = PRism.Web.Ai.AiUsageRollupStore.UsageBucket;

namespace PRism.Web.Ai;

/// <summary>Pure projection of rollup buckets into an <see cref="AiUsageReport"/> for a window.
/// No I/O — trivially unit-testable (§4.4). Counts (ProviderCalls/CacheHits) are pre-aggregated in
/// the buckets by Outcome (§4.1); this layer only sums and pivots.</summary>
internal static class AiUsageAggregator
{
    private const string BatchRef = "batch";
    private const int ByPrCap = 20;

    private static readonly Dictionary<string, string> DisplayNames = new(StringComparer.Ordinal)
    {
        ["summary"] = "PR Summary",
        ["fileFocus"] = "File Focus",
        ["hunkAnnotations"] = "Hunk Annotations",
        ["inboxEnrichment"] = "Inbox Enrichment",
    };

    public static AiUsageReport Aggregate(
        IReadOnlyCollection<Bucket> buckets, string window, DateTimeOffset now)
    {
        var normalized = Normalize(window);
        var filtered = Filter(buckets, normalized, now);

        var totals = BuildTotals(filtered);
        var byFeature = BuildByFeature(filtered);
        var (byPr, totalPrCount) = BuildByPr(filtered);
        var cache = new AiCacheStats(totals.CacheHits, totals.ProviderCalls,
            totals.CacheHits + totals.ProviderCalls == 0
                ? 0
                : (double)totals.CacheHits / (totals.CacheHits + totals.ProviderCalls));
        var trend = BuildTrend(filtered, normalized, now);

        return new AiUsageReport(normalized, now, totals, byFeature, byPr, totalPrCount, cache, trend);
    }

    private static string Normalize(string? window) =>
        window?.ToLowerInvariant() switch { "24h" => "24h", "30d" => "30d", "all" => "all", _ => "7d" };

    private static List<Bucket> Filter(IReadOnlyCollection<Bucket> buckets, string window, DateTimeOffset now)
    {
        DateTimeOffset? cutoff = window switch
        {
            "24h" => now.AddHours(-24),
            "7d" => now.AddDays(-7),
            "30d" => now.AddDays(-30),
            _ => null, // all
        };
        if (cutoff is null) return buckets.ToList();
        var cutoffHour = cutoff.Value.ToUnixTimeSeconds() / 3600;
        return buckets.Where(b => b.HourEpoch >= cutoffHour).ToList();
    }

    private static long Tokens(Bucket b) =>
        b.InputTokens + b.OutputTokens + b.CacheReadInputTokens + b.CacheCreationInputTokens;

    private static AiUsageTotals BuildTotals(List<Bucket> b) => new(
        InputTokens: b.Sum(x => x.InputTokens),
        OutputTokens: b.Sum(x => x.OutputTokens),
        CacheReadInputTokens: b.Sum(x => x.CacheReadInputTokens),
        CacheCreationInputTokens: b.Sum(x => x.CacheCreationInputTokens),
        TotalTokens: b.Sum(Tokens),
        EstimatedCostUsd: b.Sum(x => x.EstimatedCostUsd),
        ProviderCalls: b.Sum(x => x.ProviderCalls),
        CacheHits: b.Sum(x => x.CacheHits));

    private static List<AiUsageFeatureRow> BuildByFeature(List<Bucket> b) =>
        b.GroupBy(x => x.Component, StringComparer.Ordinal)
         .Select(g => new AiUsageFeatureRow(
             g.Key,
             DisplayNames.TryGetValue(g.Key, out var name) ? name : g.Key,
             g.Sum(Tokens), g.Sum(x => x.EstimatedCostUsd), g.Sum(x => x.ProviderCalls)))
         .OrderByDescending(r => r.EstimatedCostUsd)
         .ToList();

    private static (List<AiUsagePrRow> Rows, int Total) BuildByPr(List<Bucket> b)
    {
        var grouped = b.GroupBy(x => x.PrRef, StringComparer.Ordinal)
            .Select(g => new AiUsagePrRow(
                g.Key,
                g.Key == BatchRef ? "Inbox (batched)" : g.Key,
                g.Sum(Tokens), g.Sum(x => x.EstimatedCostUsd), g.Sum(x => x.ProviderCalls)))
            .OrderByDescending(r => r.EstimatedCostUsd)
            .ToList();

        var total = grouped.Count;
        var top = grouped.Take(ByPrCap).ToList();
        // Always include the "batch" row even if the cap excluded it.
        if (top.All(r => r.PrRef != BatchRef))
        {
            var batch = grouped.FirstOrDefault(r => r.PrRef == BatchRef);
            if (batch is not null) top.Add(batch);
        }
        return (top, total);
    }

    private static List<AiUsageTrendBucket> BuildTrend(List<Bucket> b, string window, DateTimeOffset now)
    {
        if (b.Count == 0) return new List<AiUsageTrendBucket>();

        var granularity = window switch
        {
            "24h" => "hour",
            "all" => SpanExceeds90Days(b) ? "week" : "day",
            _ => "day",
        };

        IEnumerable<IGrouping<DateTimeOffset, Bucket>> groups = granularity switch
        {
            "hour" => b.GroupBy(x => HourStart(x.HourEpoch)),
            "week" => b.GroupBy(x => WeekStart(HourStart(x.HourEpoch))),
            _ => b.GroupBy(x => HourStart(x.HourEpoch).Date.ToDateTimeOffset()), // day
        };

        return groups
            .Select(g => new AiUsageTrendBucket(g.Key, granularity, g.Sum(x => x.EstimatedCostUsd), g.Sum(Tokens)))
            .OrderBy(t => t.BucketStart)
            .ToList();
    }

    private static bool SpanExceeds90Days(List<Bucket> b)
    {
        var min = b.Min(x => x.HourEpoch);
        var max = b.Max(x => x.HourEpoch);
        return (max - min) / 24 > 90; // hours → days
    }

    private static DateTimeOffset HourStart(long hourEpoch) =>
        DateTimeOffset.FromUnixTimeSeconds(hourEpoch * 3600);

    private static DateTimeOffset WeekStart(DateTimeOffset when)
    {
        var date = when.UtcDateTime.Date;
        var delta = (7 + (int)date.DayOfWeek - (int)DayOfWeek.Monday) % 7;
        return new DateTimeOffset(date.AddDays(-delta), TimeSpan.Zero);
    }
}

internal static class TrendDateExtensions
{
    public static DateTimeOffset ToDateTimeOffset(this DateTime date) =>
        new(DateTime.SpecifyKind(date, DateTimeKind.Utc), TimeSpan.Zero);
}
```

> **Implementer note:** `OnlyContain` in the trend tests passes vacuously on an empty sequence; the daily/weekly tests above seed ≥1 bucket so the granularity assertion is non-vacuous. Keep it that way if you add cases.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageAggregatorTests"`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/AiUsageReport.cs PRism.Web/Ai/AiUsageAggregator.cs tests/PRism.Web.Tests/Ai/AiUsageAggregatorTests.cs
git commit -m "feat(ai): add AiUsageReport DTO + AiUsageAggregator (#517 §4.4, §4.6)"
```

---

### Task B3: `GET /api/ai/usage` endpoint (§4.5)

**Files:**
- Modify: `PRism.Web/Endpoints/AiEndpoints.cs` (add the route inside `MapAi`, after the draft-suggestions route at `:72`)
- Test: `tests/PRism.Web.Tests/Endpoints/AiUsageEndpointTests.cs`

**Interfaces:**
- Consumes: `AiUsageRollupStore` (resolved from DI in the handler), `AiUsageAggregator.Aggregate`, `TimeProvider` (for `now`).
- Produces: `GET /api/ai/usage?window=` → always `200 AiUsageReport`. Auth via the global `SessionTokenMiddleware` (no per-route attribute — matches siblings). Not gated on AI mode.

- [ ] **Step 1: Write the failing test**

Create `AiUsageEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class AiUsageEndpointTests
{
    [Fact]
    public async Task Get_ai_usage_returns_200_empty_report_when_no_usage_recorded()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("window").GetString().Should().Be("7d"); // default
        body.GetProperty("totals").GetProperty("totalTokens").GetInt64().Should().Be(0);
        body.GetProperty("byFeature").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Get_ai_usage_echoes_validated_window_and_defaults_invalid()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=24h", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("24h");

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=bogus", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("7d"); // invalid → default
    }

    [Fact]
    public async Task Get_ai_usage_is_not_gated_on_ai_mode_off()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK); // 200, NOT 204 — past usage shows even when AI off
    }

    [Fact]
    public async Task Get_ai_usage_requires_session_auth()
    {
        using var factory = new PRismWebApplicationFactory();
        // No session token → exercises the global SessionTokenMiddleware. Use the factory's dedicated
        // unauthenticated-client helper (the established pattern; plain CreateClient injects a token).
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
```

> **Confirmed against the codebase:** `SessionTokenMiddleware` is registered globally (`Program.cs:253`, `app.UseMiddleware<SessionTokenMiddleware>()`) ahead of `MapAi`, returns **`401 Unauthorized`** for an `/api/*` request with no session token, and is bypassed only under the Development environment (existing global policy, not specific to this route). `CreateUnauthenticatedClient()` is the established factory helper for this case (used by e.g. `EventsSubscriptionsEndpointTests`, `HtmlResponseCookieTests`). Keep `HttpStatusCode.Unauthorized`.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageEndpointTests"`
Expected: FAIL — `/api/ai/usage` returns 404 (route not mapped).

- [ ] **Step 3: Write minimal implementation**

In `AiEndpoints.cs`, add `using PRism.Web.Ai;` at the top, then inside `MapAi` after the draft-suggestions `MapGet` block (before `return app;`):

```csharp
        // #517 — aggregated AI usage & spend over the durable rollup. Auth is the GLOBAL
        // SessionTokenMiddleware (no per-route attribute, like the sibling AI endpoints). Deliberately
        // NOT gated on AI mode (decision 9): past usage is worth showing even when AI is currently Off.
        // Always 200 — an empty report (zeros + empty arrays) when no usage has been recorded yet
        // (incl. before the first tail tick). No log I/O on the request path — reads the in-memory store.
        app.MapGet("/api/ai/usage",
            (string? window, AiUsageRollupStore store) =>
                Results.Ok(AiUsageAggregator.Aggregate(
                    store.SnapshotBuckets(), window ?? "7d", DateTimeOffset.UtcNow)));
```

> The handler uses `DateTimeOffset.UtcNow` directly (no `TimeProvider` injection) to match the minimal-API style of the sibling endpoints, which do not thread a clock. The aggregator is independently tested with an injected `now`, so the endpoint needs no clock seam.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AiUsageEndpointTests"`
Expected: PASS (all 4; adjust the auth-status assertion per the Step-1 note if needed).

- [ ] **Step 5: Run the full backend suite for the touched projects**

Run: `dotnet test tests/PRism.Web.Tests`
Expected: All green (new tests + no regressions in the AI/endpoint suites).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/AiEndpoints.cs tests/PRism.Web.Tests/Endpoints/AiUsageEndpointTests.cs
git commit -m "feat(ai): add GET /api/ai/usage endpoint (#517 §4.5)"
```

**→ PR-1 (Phases A+B) is complete here.** Run the pre-push checklist, `/simplify`, then open with `--base V2`.

---

## Phase C — Frontend (nested nav + usage pane)

> Open PR-2 after PR-1 merges to V2 so `/api/ai/usage` exists. All frontend commands run from `frontend/`.

### Task C1: Number-formatting helpers (§5.2)

**Files:**
- Create: `frontend/src/utils/formatUsage.ts`
- Test: `frontend/src/utils/formatUsage.test.ts`

**Interfaces:**
- Produces (used by Task C3): `formatCost(usd: number): string` — 4 dp when `0 < |usd| < 0.01` (e.g. `$0.0012`), 2 dp otherwise (incl. exactly 0 → `$0.00`); `formatTokens(count: number): string` — locale thousands, no abbreviation.

No shared formatter exists in the frontend today (confirmed), so this is a new shared util.

- [ ] **Step 1: Write the failing test**

Create `formatUsage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens } from './formatUsage';

describe('formatCost', () => {
  it('renders sub-cent costs with 4 decimals so they do not read as $0.00', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(0.0001)).toBe('$0.0001');
  });
  it('renders cents-and-up with 2 decimals', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(1234.5)).toBe('$1,234.50');
  });
  it('renders exactly zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('formatTokens', () => {
  it('uses thousands separators with no abbreviation', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/utils/formatUsage.test.ts`
Expected: FAIL — `./formatUsage` cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

Create `formatUsage.ts`:

```ts
// #517 — shared usage formatters. A naive 2-dp cost format renders real sub-cent figures as
// "$0.00", reading as "AI is free"; use 4 dp below a cent. Token counts stay well under 10M, so
// no abbreviation — locale thousands separators only.

export function formatCost(usd: number): string {
  const sub = usd !== 0 && Math.abs(usd) < 0.01;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: sub ? 4 : 2,
    maximumFractionDigits: sub ? 4 : 2,
  }).format(usd);
}

export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/utils/formatUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && npx prettier --write src/utils/formatUsage.ts src/utils/formatUsage.test.ts
git add frontend/src/utils/formatUsage.ts frontend/src/utils/formatUsage.test.ts
git commit -m "feat(ai): add shared usage cost/token formatters (#517 §5.2)"
```

---

### Task C2: `AiUsageReport` types + `getAiUsage` helper (§5.3)

**Files:**
- Modify: `frontend/src/api/types.ts` (append the usage interfaces)
- Create: `frontend/src/api/aiUsage.ts`

**Interfaces:**
- Produces (used by Task C3):
  - TS interfaces mirroring the backend DTO (§4.6), camelCase.
  - `export type AiUsageWindow = '24h' | '7d' | '30d' | 'all';`
  - `export function getAiUsage(window: AiUsageWindow): Promise<AiUsageReport>;`

- [ ] **Step 1: Add the types**

Append to `types.ts`:

```ts
// #517 — AI usage & spend. Mirrors PRism.Web/Ai/AiUsageReport.cs (camelCase wire shape).
export type AiUsageWindow = '24h' | '7d' | '30d' | 'all';

export interface AiUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
  cacheHits: number;
}

export interface AiUsageFeatureRow {
  component: string;
  displayName: string;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
}

export interface AiUsagePrRow {
  prRef: string;
  displayLabel: string;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
}

export interface AiCacheStats {
  cacheHits: number;
  providerCalls: number;
  hitRate: number;
}

export interface AiUsageTrendBucket {
  bucketStart: string;
  granularity: string;
  estimatedCostUsd: number;
  totalTokens: number;
}

export interface AiUsageReport {
  window: string;
  generatedAt: string;
  totals: AiUsageTotals;
  byFeature: AiUsageFeatureRow[];
  byPr: AiUsagePrRow[];
  totalPrCount: number;
  cache: AiCacheStats;
  trend: AiUsageTrendBucket[];
}
```

- [ ] **Step 2: Add the fetch helper**

Create `aiUsage.ts`:

```ts
import { apiClient } from './client';
import type { AiUsageReport, AiUsageWindow } from './types';

// The endpoint always returns 200 with a (possibly empty) report — never 204. A network/5xx
// failure throws (ApiError or a fetch error); the pane catches it and shows the error state.
export function getAiUsage(window: AiUsageWindow): Promise<AiUsageReport> {
  return apiClient.get<AiUsageReport>(`/api/ai/usage?window=${window}`);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors. (Use `tsc -b`, not `tsc --noEmit` — the latter is vacuous under this repo's project references.)

- [ ] **Step 4: Commit**

```bash
cd frontend && npx prettier --write src/api/types.ts src/api/aiUsage.ts
git add frontend/src/api/types.ts frontend/src/api/aiUsage.ts
git commit -m "feat(ai): add AiUsageReport types + getAiUsage client (#517 §5.3)"
```

---

### Task C3: `AiUsagePane` component + states (§5.2, §5.3)

**Files:**
- Create: `frontend/src/components/Settings/panes/AiUsagePane.tsx`
- Create: `frontend/src/components/Settings/panes/AiUsagePane.module.css`
- Test: `frontend/src/components/Settings/panes/AiUsagePane.test.tsx`

**Interfaces:**
- Consumes: `getAiUsage` (C2), `formatCost`/`formatTokens` (C1), `AiUsageReport`/`AiUsageWindow` types, `SegmentedControl` (`../../controls/SegmentedControl`, the same control `AiPane` uses), `pane` styles (`./Pane.module.css`) for head/title, local module for the layout.
- Produces: `export function AiUsagePane(): JSX.Element;` (used by Task C4's route).

Layout per §5.2: window control → headline card → trend bars → by-feature table → cache stat → by-PR drill-down. States per §5.3: cold skeleton, stale-while-loading on window switch, empty, error+retry. The trend container is `aria-hidden` with a visually-hidden summary.

- [ ] **Step 1: Write the failing test**

Create `AiUsagePane.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiUsagePane } from './AiUsagePane';
import * as api from '../../../api/aiUsage';
import type { AiUsageReport } from '../../../api/types';

function report(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    window: '7d',
    generatedAt: '2026-06-19T12:00:00Z',
    totals: {
      inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 5000,
      totalTokens: 6200, estimatedCostUsd: 0.0012, providerCalls: 3, cacheHits: 1,
    },
    byFeature: [
      { component: 'summary', displayName: 'PR Summary', totalTokens: 6200, estimatedCostUsd: 0.0012, providerCalls: 3 },
    ],
    byPr: [
      { prRef: 'batch', displayLabel: 'Inbox (batched)', totalTokens: 100, estimatedCostUsd: 0.0001, providerCalls: 1 },
    ],
    totalPrCount: 1,
    cache: { cacheHits: 1, providerCalls: 3, hitRate: 0.25 },
    trend: [
      { bucketStart: '2026-06-18T00:00:00Z', granularity: 'day', estimatedCostUsd: 0.0012, totalTokens: 6200 },
    ],
    ...over,
  };
}

describe('AiUsagePane', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the headline cost with sub-cent precision and the by-feature table', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(report());
    render(<AiUsagePane />);

    expect(await screen.findByText('$0.0012')).toBeInTheDocument(); // not $0.00
    const table = screen.getByRole('table', { name: /by feature/i });
    expect(within(table).getByText('PR Summary')).toBeInTheDocument();
  });

  it('shows the empty state when no usage is recorded', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(
      report({
        totals: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, providerCalls: 0, cacheHits: 0 },
        byFeature: [], byPr: [], totalPrCount: 0, trend: [],
        cache: { cacheHits: 0, providerCalls: 0, hitRate: 0 },
      }),
    );
    render(<AiUsagePane />);
    expect(await screen.findByText('No AI usage recorded yet.')).toBeInTheDocument();
  });

  it('shows the error state with a Try again button that refetches', async () => {
    const spy = vi.spyOn(api, 'getAiUsage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(report());
    render(<AiUsagePane />);

    expect(await screen.findByText('Could not load usage data.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('$0.0012')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous data visible while a window switch loads (stale-while-loading)', async () => {
    let resolveSecond: (r: AiUsageReport) => void = () => {};
    const spy = vi.spyOn(api, 'getAiUsage')
      .mockResolvedValueOnce(report())
      .mockImplementationOnce(() => new Promise<AiUsageReport>((res) => { resolveSecond = res; }));
    render(<AiUsagePane />);
    await screen.findByText('$0.0012');

    await userEvent.click(screen.getByRole('radio', { name: '30d' }));
    // Old data still on screen while the 30d fetch is in flight.
    expect(screen.getByText('$0.0012')).toBeInTheDocument();

    resolveSecond(report({ window: '30d', totals: { ...report().totals, estimatedCostUsd: 9.5 } }));
    await waitFor(() => expect(screen.getByText('$9.50')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('30d');
  });

  it('renders the by-PR "Inbox (batched)" row when the drill-down is expanded', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(report());
    render(<AiUsagePane />);
    await screen.findByText('$0.0012');

    await userEvent.click(screen.getByRole('button', { name: /by pr/i }));
    expect(screen.getByText('Inbox (batched)')).toBeInTheDocument();
  });

  it('keeps the appended "Inbox (batched)" row visible with >20 PRs (no client re-slice)', async () => {
    // Backend caps at top-20-by-cost then appends batch as the 21st row; client must not re-slice.
    const priced = Array.from({ length: 20 }, (_, i) => ({
      prRef: `o/r#${i}`, displayLabel: `o/r#${i}`, totalTokens: 10, estimatedCostUsd: (i + 1) * 0.01, providerCalls: 1,
    }));
    const batch = { prRef: 'batch', displayLabel: 'Inbox (batched)', totalTokens: 5, estimatedCostUsd: 0.0001, providerCalls: 1 };
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(report({ byPr: [...priced, batch], totalPrCount: 26 }));
    render(<AiUsagePane />);
    await screen.findByText('$0.0012');

    await userEvent.click(screen.getByRole('button', { name: /by pr/i }));
    expect(screen.getByText('Inbox (batched)')).toBeInTheDocument(); // would be dropped by a .slice(0,20)
    expect(screen.getByText(/showing 21 of 26 PRs/i)).toBeInTheDocument();
  });

  it('shows the cache stat (not the empty state) for a cache-only window', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(
      report({
        totals: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, providerCalls: 0, cacheHits: 4 },
        byFeature: [], byPr: [], totalPrCount: 0, trend: [],
        cache: { cacheHits: 4, providerCalls: 0, hitRate: 1 },
      }),
    );
    render(<AiUsagePane />);
    expect(await screen.findByText(/served from cache/i)).toBeInTheDocument();
    expect(screen.queryByText('No AI usage recorded yet.')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/panes/AiUsagePane.test.tsx`
Expected: FAIL — `AiUsagePane` does not exist.

- [ ] **Step 3: Write the CSS module**

Create `AiUsagePane.module.css`:

```css
/* position:relative so the .sr-only trend summary's containing block is this pane, not <html>
   (repo .sr-only is position:absolute; top:0; left:0 — see memory reference_sr_only_abspos_page_scroll). */
.pane {
  position: relative;
}
.card {
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 16px;
  margin: 14px 0;
}
.headlineCost {
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.headlineSub {
  color: var(--text-3);
  font-size: var(--text-xs);
  margin-top: 4px;
}
.trend {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 64px;
  margin: 14px 0;
}
.bar {
  flex: 1 1 auto;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  min-height: 2px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.table th {
  text-align: left;
  color: var(--text-3);
  font-weight: 500;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-1);
}
.table td {
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in oklab, var(--border-1) 55%, transparent);
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.skeletonBar,
.skeletonRow {
  background: var(--surface-3);
  border-radius: var(--radius-1);
  animation: pulse 1.4s ease-in-out infinite;
}
.skeletonBar { flex: 1 1 auto; height: 50%; }
.skeletonRow { height: 28px; margin: 4px 0; }
.loadingControl { opacity: 0.6; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
```

- [ ] **Step 4: Write the component**

Create `AiUsagePane.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAiUsage } from '../../../api/aiUsage';
import type { AiUsageReport, AiUsageWindow } from '../../../api/types';
import { formatCost, formatTokens } from '../../../utils/formatUsage';
import { SegmentedControl } from '../../controls/SegmentedControl';
import pane from './Pane.module.css';
import styles from './AiUsagePane.module.css';

const WINDOWS: { value: AiUsageWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

type Status = 'cold' | 'loading' | 'ready' | 'error';

export function AiUsagePane() {
  const [window, setWindow] = useState<AiUsageWindow>('7d');
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [status, setStatus] = useState<Status>('cold');
  const reqId = useRef(0);

  const load = useCallback((w: AiUsageWindow) => {
    const id = ++reqId.current;
    // Already showing data → keep it visible with a loading cue on switch; otherwise cold skeleton.
    setStatus((prev) => (prev === 'ready' || prev === 'loading' ? 'loading' : 'cold'));
    getAiUsage(w)
      .then((r) => {
        if (id !== reqId.current) return; // a newer request superseded this one
        setReport(r);
        setStatus('ready');
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setStatus('error');
      });
  }, []); // stable — no `report` dependency, so no stale closure on the retry path

  useEffect(() => { load(window); }, [window, load]);

  const onWindow = (w: AiUsageWindow) => { if (w !== window) setWindow(w); };

  // A cache-only window (cacheHits > 0, no tokens, no provider calls) is NOT empty — it must show
  // the cache stat, the one signal that matters most to a cache-heavy user.
  const isEmpty =
    report !== null &&
    report.totals.totalTokens === 0 &&
    report.totals.providerCalls === 0 &&
    report.totals.cacheHits === 0;

  return (
    <section className={styles.pane} aria-labelledby="ai-usage-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ai-usage-heading" className={pane.title}>AI Usage</h2>
          <p className={pane.sub}>Token usage and estimated equivalent cost, by feature and PR.</p>
        </div>
      </div>

      <div className={status === 'loading' ? styles.loadingControl : undefined}>
        <SegmentedControl
          label="Usage window"
          value={window}
          options={WINDOWS}
          disabled={status === 'loading'}
          onChange={(v) => onWindow(v as AiUsageWindow)}
        />
      </div>

      {status === 'cold' && <Skeleton />}
      {status === 'error' && (
        <div className={styles.card} role="alert">
          <p>Could not load usage data.</p>
          <button type="button" onClick={() => load(window)}>Try again</button>
        </div>
      )}
      {report !== null && (status === 'ready' || status === 'loading') && (
        isEmpty ? (
          <div className={styles.card}><p>No AI usage recorded yet.</p></div>
        ) : (
          <Report report={report} />
        )
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <>
      <div className={styles.card}><div className={styles.skeletonRow} style={{ width: '40%' }} /></div>
      <div className={styles.trend} aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => <div key={i} className={styles.skeletonBar} />)}
      </div>
      <div className={styles.card}>
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className={styles.skeletonRow} />)}
      </div>
    </>
  );
}

function Report({ report }: { report: AiUsageReport }) {
  const [showPrs, setShowPrs] = useState(false);
  // Bar height, tooltip, and the SR summary ALL track cost so the tallest bar IS the highest-spend
  // bucket. Scaling height to tokens while the tooltip/summary report cost would let the tallest bar
  // disagree with "highest spend" (cache-read tokens are cheap; output costs more than input).
  const max = Math.max(0.0001, ...report.trend.map((t) => t.estimatedCostUsd));
  const peak = report.trend.reduce<AiUsageReport['trend'][number] | null>(
    (a, b) => (a === null || b.estimatedCostUsd > a.estimatedCostUsd ? b : a), null);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <>
      <div className={styles.card}>
        <div className={styles.headlineCost}>{formatCost(report.totals.estimatedCostUsd)}</div>
        <div>{formatTokens(report.totals.totalTokens)} tokens</div>
        <div className={styles.headlineSub}>
          Estimated API-equivalent cost — for reference only; PRism uses a Claude subscription, not
          pay-per-token billing.
        </div>
      </div>

      {/* Decorative bars; the precise data lives in the tables below. Height tracks cost. */}
      <div className={styles.trend} aria-hidden="true">
        {report.trend.map((t) => (
          <div
            key={t.bucketStart}
            className={styles.bar}
            style={{ height: `${Math.round((t.estimatedCostUsd / max) * 100)}%` }}
            title={`${fmtDate(t.bucketStart)}: ${formatCost(t.estimatedCostUsd)}`}
          />
        ))}
      </div>
      {/* Omit the SR summary when there is no spend to announce (e.g. a cache-only window). */}
      {peak && peak.estimatedCostUsd > 0 && (
        <p className="sr-only">Highest spend: {fmtDate(peak.bucketStart)}, {formatCost(peak.estimatedCostUsd)}.</p>
      )}

      <table className={styles.table} aria-label="Usage by feature">
        <thead>
          <tr><th>Feature</th><th className={styles.num}>Calls</th><th className={styles.num}>Tokens</th><th className={styles.num}>Est. cost</th></tr>
        </thead>
        <tbody>
          {report.byFeature.map((f) => (
            <tr key={f.component}>
              <td>{f.displayName}</td>
              <td className={styles.num}>{formatTokens(f.providerCalls)}</td>
              <td className={styles.num}>{formatTokens(f.totalTokens)}</td>
              <td className={styles.num}>{formatCost(f.estimatedCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.card}>
        Cache hit-rate: {Math.round(report.cache.hitRate * 100)}% —{' '}
        {formatTokens(report.cache.cacheHits)} calls served from cache.
      </div>

      <div className={styles.card}>
        <button type="button" aria-expanded={showPrs} onClick={() => setShowPrs((v) => !v)}>
          By PR ({report.totalPrCount})
        </button>
        {showPrs && (
          <>
            {/* Render report.byPr VERBATIM — the backend already capped at top-20-by-cost AND appended
                the "batch" row past the cap (§4.4). Re-slicing here (e.g. .slice(0, 20)) would drop
                exactly that appended "Inbox (batched)" row, violating AC §10. */}
            <table className={styles.table} aria-label="Usage by PR">
              <thead>
                <tr><th>PR</th><th className={styles.num}>Tokens</th><th className={styles.num}>Est. cost</th></tr>
              </thead>
              <tbody>
                {report.byPr.map((p) => (
                  <tr key={p.prRef}>
                    <td>{p.displayLabel}</td>
                    <td className={styles.num}>{formatTokens(p.totalTokens)}</td>
                    <td className={styles.num}>{formatCost(p.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Honest truncation note — the payload is capped server-side, so there is no "show all"
                to fetch. Static "+N more", matching the §4.6 DTO comment (TotalPrCount "for +N more"). */}
            {report.totalPrCount > report.byPr.length && (
              <p className={styles.headlineSub}>
                Showing {report.byPr.length} of {report.totalPrCount} PRs (top by cost).
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
```

> **Implementer notes (verified against the codebase):** (1) `SegmentedControl` (`frontend/src/components/controls/SegmentedControl.tsx`) takes `label: string` (wired internally to the radiogroup's `aria-label`), `options: readonly {value,label}[]`, `value`, `onChange`, and `disabled?` — the props above match exactly; it renders `radio` roles, so `getByRole('radio', { name: '30d' })` resolves. Do **not** pass `aria-label` (not a prop). (2) `.sr-only` is defined in `frontend/src/styles/tokens.css` as `position:absolute; top:0; left:0; …` — that is why `.pane` adds `position: relative` (above), so the SR summary's containing block is the pane rather than `<html>` (memory: `reference_sr_only_abspos_page_scroll`). (3) When expanding **By PR**, move keyboard focus to the revealed table (add a `ref` + `tabIndex={-1}` on the `<table>` and `.focus()` it on expand) so a keyboard user lands on the new content instead of tabbing from the button through it.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/panes/AiUsagePane.test.tsx`
Expected: PASS (all 5). Fix any `SegmentedControl`/`sr-only` API mismatches surfaced here.

- [ ] **Step 6: Commit**

```bash
cd frontend && npx prettier --write src/components/Settings/panes/AiUsagePane.tsx src/components/Settings/panes/AiUsagePane.module.css src/components/Settings/panes/AiUsagePane.test.tsx
git add frontend/src/components/Settings/panes/AiUsagePane.tsx frontend/src/components/Settings/panes/AiUsagePane.module.css frontend/src/components/Settings/panes/AiUsagePane.test.tsx
git commit -m "feat(ai): add AiUsagePane with loading/empty/error states (#517 §5.2)"
```

---

### Task C4: Nested AI nav + `/settings/ai/usage` route (§5.1)

**Files:**
- Modify: `frontend/src/components/Settings/SettingsNav.tsx`
- Create: `frontend/src/components/Settings/SettingsNav.test.tsx`
- Modify: `frontend/src/components/Settings/SettingsModalRoutes.tsx` (add the `ai/usage` route)

**Interfaces:**
- Consumes: `useLocation`, existing `SettingsLink`, `styles` (`SettingsModal.module.css`), `AiMarker`, `AiUsagePane` (C3).
- Produces: the AI nav item renders two children (**Configuration** → `/settings/ai`, **Usage** → `/settings/ai/usage`) whenever any `/settings/ai*` route is active; AI parent shows active style while a child is current; navigating away collapses the children.

The current matcher (`current = pathname.replace(/^\/settings\/?/, '')`, then `current === i.section`) breaks for `/settings/ai/usage` (yields `ai/usage`). Change the AI item to match on a `/settings/ai` **prefix** and render children when active.

- [ ] **Step 1: Write the failing test**

Create `SettingsNav.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SettingsNav } from './SettingsNav';

// AiMarker pulls in AI-gate hooks; stub it to a no-op for an isolated nav test.
vi.mock('../Ai/AiMarker', () => ({ AiMarker: () => null }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsNav />
    </MemoryRouter>,
  );
}

describe('SettingsNav AI nesting', () => {
  it('shows AI children only when an /settings/ai* route is active', () => {
    renderAt('/settings/appearance');
    expect(screen.queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();

    renderAt('/settings/ai');
    expect(screen.getByRole('link', { name: 'Configuration' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usage' })).toBeInTheDocument();
  });

  it('marks Usage as current when on /settings/ai/usage', () => {
    renderAt('/settings/ai/usage');
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    // The AI parent reflects the active section too.
    expect(screen.getByRole('link', { name: /^AI/ })).toHaveAttribute('aria-current', 'page');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsNav.test.tsx`
Expected: FAIL — no "Usage"/"Configuration" child links exist yet.

- [ ] **Step 3: Modify `SettingsNav.tsx`**

Replace the component with the nested-AI version (preserving the existing structure + CSS classes):

```tsx
import { useLocation } from 'react-router-dom';
import { AiMarker } from '../Ai/AiMarker';
import { SettingsLink } from './SettingsLink';
import styles from './SettingsModal.module.css';

interface NavItem {
  section: string;
  label: string;
}
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  { section: 'ai', label: 'AI' },
  { section: 'inbox', label: 'Inbox' },
  { section: 'github-connection', label: 'GitHub Connection' },
];
const SYSTEM: NavItem[] = [{ section: 'system', label: 'Files & logs' }];

// AI sub-pages, rendered beneath the AI parent whenever an /settings/ai* route is active.
const AI_CHILDREN: { path: string; label: string }[] = [
  { path: '/settings/ai', label: 'Configuration' },
  { path: '/settings/ai/usage', label: 'Usage' },
];

function Item({ section, label, active }: NavItem & { active: boolean }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={active ? 'page' : undefined}
    >
      {label}
      {section === 'ai' && <AiMarker variant="inline" decorative />}
    </SettingsLink>
  );
}

export function SettingsNav() {
  const { pathname } = useLocation();
  const current = pathname.replace(/^\/settings\/?/, '') || 'appearance';
  // The AI section is active for /settings/ai AND any /settings/ai/* child.
  const aiActive = current === 'ai' || current.startsWith('ai/');
  // The Configuration child is "current" only at exactly /settings/ai (not a descendant).
  const childActive = (childPath: string) =>
    childPath === '/settings/ai' ? current === 'ai' : pathname === childPath;

  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {PRIMARY.map((i) => {
        const active = i.section === 'ai' ? aiActive : current === i.section;
        return (
          <div key={i.section}>
            <Item {...i} active={active} />
            {i.section === 'ai' && aiActive && (
              <div className={styles.navChildren}>
                {AI_CHILDREN.map((c) => (
                  <SettingsLink
                    key={c.path}
                    to={c.path}
                    className={
                      childActive(c.path)
                        ? `${styles.navChild} ${styles.navChildOn}`
                        : styles.navChild
                    }
                    aria-current={childActive(c.path) ? 'page' : undefined}
                  >
                    {c.label}
                  </SettingsLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className={styles.navDivider} role="presentation" />
      <div className={styles.navGroup} role="group" aria-label="System">
        <div className={styles.navGroupLabel} aria-hidden="true">System</div>
        {SYSTEM.map((i) => (
          <Item key={i.section} {...i} active={current === i.section} />
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Add child-nav CSS**

Append to `frontend/src/components/Settings/SettingsModal.module.css` (mirroring `.navItem`/`.navItemOn` but indented):

```css
.navChildren {
  display: flex;
  flex-direction: column;
  margin: 2px 0 2px 12px;
  padding-left: 8px;
  border-left: 1px solid var(--border-1);
}
.navChild {
  display: flex;
  align-items: center;
  padding: 7px 11px;
  border-radius: var(--radius-2);
  color: var(--text-2);
  font-size: var(--text-sm);
  margin-bottom: 2px;
}
.navChild:hover {
  background: var(--surface-3);
  color: var(--text-1);
}
.navChild:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: -2px;
}
.navChildOn {
  background: var(--accent-soft);
  color: var(--text-1);
  font-weight: 500;
}
```

- [ ] **Step 5: Add the route in `SettingsModalRoutes.tsx`**

Add the import and the nested route (after `<Route path="ai" element={<AiPane />} />`):

```tsx
import { AiUsagePane } from './panes/AiUsagePane';
```
```tsx
        <Route path="ai" element={<AiPane />} />
        <Route path="ai/usage" element={<AiUsagePane />} />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsNav.test.tsx && npx tsc -b`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Commit**

```bash
cd frontend && npx prettier --write src/components/Settings/SettingsNav.tsx src/components/Settings/SettingsNav.test.tsx src/components/Settings/SettingsModalRoutes.tsx src/components/Settings/SettingsModal.module.css
git add frontend/src/components/Settings/SettingsNav.tsx frontend/src/components/Settings/SettingsNav.test.tsx frontend/src/components/Settings/SettingsModalRoutes.tsx frontend/src/components/Settings/SettingsModal.module.css
git commit -m "feat(ai): nest Usage under the AI settings nav item (#517 §5.1)"
```

---

### Task C5: e2e — AI nav auto-expand + Usage pane render (§7 frontend)

**Files:**
- Create: `frontend/e2e/helpers/settings.ts` (extract the shared mock helper — see Step 0)
- Modify: `frontend/e2e/ai-settings-tab.spec.ts`, `frontend/e2e/settings-flow.spec.ts` (import the extracted helper instead of their local copies)
- Create: `frontend/e2e/ai-usage.spec.ts`
- (Expect) settings screenshot baselines rebaseline ×2 platforms — mechanical (§7).

**Interfaces:**
- Consumes: the extracted `setupSettingsMocks(page)` helper (Step 0), plus a new `/api/ai/usage` route mock added inline in this spec.

> **Why Step 0:** `setupSettingsMocks` does **not** exist as a shared module today — it is a non-exported `async function` defined *locally and independently* inside both `ai-settings-tab.spec.ts` and `settings-flow.spec.ts` (verified). Importing `from './helpers/settings'` would fail to resolve. Step 0 lifts the one in `ai-settings-tab.spec.ts` into a shared, exported helper and repoints both existing specs at it (DRY), so this spec can import it for real.

- [ ] **Step 0: Extract the shared settings-mock helper**

Move the `setupSettingsMocks` function body out of `ai-settings-tab.spec.ts` into a new `frontend/e2e/helpers/settings.ts` as an `export async function setupSettingsMocks(page: import('@playwright/test').Page)` (carry over the `./fixtures/preferences` imports it depends on — e.g. `authedAuthState`, `makeDefaultPreferences`). Replace the local definitions in both `ai-settings-tab.spec.ts` and `settings-flow.spec.ts` with `import { setupSettingsMocks } from './helpers/settings';`.

- [ ] **Step 0 verification: existing settings e2e still pass**

Run: `cd frontend && npx playwright test e2e/ai-settings-tab.spec.ts e2e/settings-flow.spec.ts --project=prod`
Expected: PASS (pure extraction — no behavior change). Commit this extraction separately:

```bash
cd frontend && npx prettier --write e2e/helpers/settings.ts e2e/ai-settings-tab.spec.ts e2e/settings-flow.spec.ts
git add frontend/e2e/helpers/settings.ts frontend/e2e/ai-settings-tab.spec.ts frontend/e2e/settings-flow.spec.ts
git commit -m "refactor(e2e): extract shared setupSettingsMocks helper (#517 prep)"
```

- [ ] **Step 1: Write the spec**

Create `ai-usage.spec.ts` (mirror the nav-click + mock pattern in `ai-settings-tab.spec.ts`):

```ts
import { test, expect } from '@playwright/test';
import { setupSettingsMocks } from './helpers/settings'; // the helper extracted in Step 0

const USAGE = {
  window: '7d',
  generatedAt: '2026-06-19T12:00:00Z',
  totals: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 5000, totalTokens: 6200, estimatedCostUsd: 0.0012, providerCalls: 3, cacheHits: 1 },
  byFeature: [{ component: 'summary', displayName: 'PR Summary', totalTokens: 6200, estimatedCostUsd: 0.0012, providerCalls: 3 }],
  byPr: [{ prRef: 'batch', displayLabel: 'Inbox (batched)', totalTokens: 100, estimatedCostUsd: 0.0001, providerCalls: 1 }],
  totalPrCount: 1,
  cache: { cacheHits: 1, providerCalls: 3, hitRate: 0.25 },
  trend: [{ bucketStart: '2026-06-18T00:00:00Z', granularity: 'day', estimatedCostUsd: 0.0012, totalTokens: 6200 }],
};

test('ai-usage: AI nav auto-expands and routes to the Usage pane', async ({ page }) => {
  test.setTimeout(60_000);
  await setupSettingsMocks(page);
  await page.route('**/api/ai/usage**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USAGE) }));

  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // AI is active → children visible.
  await expect(dialog.getByRole('link', { name: 'Usage' })).toBeVisible();
  await dialog.getByRole('link', { name: 'Usage' }).click();

  await expect(page.getByRole('heading', { name: 'AI Usage', level: 2 })).toBeVisible();
  await expect(page.getByText('$0.0012')).toBeVisible(); // sub-cent headline, not $0.00
});
```

> **Implementer note:** the inline `/api/ai/usage` route mock completes the surface on top of `setupSettingsMocks` (which stubs `/api/preferences` + auth state). Run scenario specs with `--project=prod` (the dev project can't run them — memory: `dev Playwright project can't run scenario specs`); if the runner-instance issue bites, invoke `./node_modules/.bin/playwright` rather than `npx playwright`.

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx playwright test e2e/ai-usage.spec.ts --project=prod`
Expected: PASS. (Run the local binary, not `npx playwright`, if the runner-instance issue bites: `./node_modules/.bin/playwright test …`.)

- [ ] **Step 3: Rebaseline settings screenshots if a visual/parity spec covers the settings nav**

Grep for existing settings visual baselines before assuming none break:

Run: `cd frontend && npx playwright test --project=prod --grep "settings" --update-snapshots` (only if a settings visual spec exists and the new nav child shifts its layout — this is the expected mechanical rebaseline noted in §7).
Expected: updated baseline PNGs for the settings nav, ×2 platforms. Regenerate the Linux baseline via the CI artifact if local is Windows (`reference_regen_linux_parity_baseline_via_ci_artifact`).

- [ ] **Step 4: Commit**

```bash
cd frontend && npx prettier --write e2e/ai-usage.spec.ts
git add frontend/e2e/ai-usage.spec.ts frontend/e2e/**/*.png
git commit -m "test(ai): e2e AI nav auto-expand + Usage pane (#517 §7)"
```

**→ PR-2 (Phase C) is complete here.** Run the pre-push checklist + `/simplify`, then open with `--base V2`.

---

## Self-Review

**1. Spec coverage:**
- §4.0 enricher CacheHit → Task A1 ✓
- §4.1 rollup store → Task A3 ✓
- §4.2 tailer → Task A4 ✓
- §4.3 reader → Task A2 ✓
- §4.4 aggregator → Task B2 ✓
- §4.5 endpoint → Task B3 ✓
- §4.6 DTO → Task B1 (folded into B2) ✓
- §5.1 nested nav → Task C4 ✓
- §5.2 pane layout + number formatting → C1 (formatters) + C3 (layout) ✓
- §5.3 data + states → Task C3 (cold/stale/empty/error) ✓
- §6 edge cases → covered across A2 (partial/malformed lines), A3 (corrupt file, Outcome counting), A4 (truncation, crash-before-persist), B3 (empty 200, not-gated) ✓
- §7 tests → each task is TDD with the spec's named cases ✓
- §10 ACs: user-facing view (C3) ✓; by-feature + by-PR (B2/C3) ✓; cache across 4 seams (A1 + B2) ✓; subscription framing (C3 copy) ✓; accuracy gated on #379 + truncation safety net (A4) ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" left. Every code step has complete code. Implementer notes flag *verification* points (real `SegmentedControl` prop names, `sr-only` class, auth status code, e2e helper path) rather than leaving logic unwritten — these are "confirm against the live API" checks, not deferred implementation.

**3. Type consistency:**
- `AiInteractionLogReader.LogEntry` (struct) produced by A2, consumed by A3 `Fold(in LogEntry)` and A4 ✓
- `AiUsageRollupStore.UsageBucket` produced by A3, consumed by B2 aggregator (`using Bucket = …`) ✓
- `AiUsageReport` + sub-records identical between B1 (C#) and C2 (TS, camelCase) ✓
- `AiUsageWindow` union (`'24h'|'7d'|'30d'|'all'`) consistent across C2/C3 and the backend's `Normalize` allow-list ✓
- Store API names (`Load`/`Fold`/`Advance`/`Reset`/`Persist`/`SnapshotBuckets`/`TailOffset`/`IsDirty`) used identically in A3 (def), A4 (consumer) ✓
- `getAiUsage(window)` signature identical in C2 (def) and C3/C5 (consumers) ✓

One documented deviation from the spec (Windows ACL → mirror `JsonlTokenUsageTracker`'s no-op, Task A3 note) is recorded inline per the project's "document plan deviations durably" practice.

---

## ce-doc-review (machine pass) — dispositions

A 6-persona machine review (coherence, feasibility, design-lens, security-lens, scope-guardian, adversarial) ran on this plan. Applied findings (folded into the tasks above):

- **Applied — `SegmentedControl` prop is `label`, not `aria-label`** (feasibility + design-lens, conf 100). Verified against `SegmentedControl.tsx`; the original code would not compile. Task C3 now passes `label="Usage window"`.
- **Applied — `.sr-only` needs a positioned ancestor** (design-lens, conf 100). Verified against `tokens.css` + memory `reference_sr_only_abspos_page_scroll`. Task C3 adds `.pane { position: relative }`.
- **Applied — frontend `.slice(0,20)` dropped the appended "batch" row** (adversarial, conf 75). A real AC §10 violation invisible to the 1-row test fixture. Task C3 renders `report.byPr` verbatim + a 21-row regression test.
- **Applied — cache-only window rendered as the empty state** (adversarial, conf 75). `isEmpty` now includes `cacheHits === 0` + a cache-only regression test.
- **Applied — "Show all N PRs" was a dead button** (design-lens + adversarial, conf 75). The capped payload can't satisfy it; replaced with a static "Showing N of M PRs (top by cost)" note (matches the §4.6 "+N more" intent).
- **Applied — trend bars scaled to tokens while tooltip/summary used cost** (adversarial, conf 75). All three now track cost; SR summary gated on cost > 0 and renders a human-readable date.
- **Applied — `disabled` not passed to the control during loading** (design-lens, conf 75). Added `disabled={status==='loading'}`.
- **Applied — invalid `role="group"` on the nav-children link list** (design-lens, conf 75). Removed; the parent `<nav>` is the landmark.
- **Applied — fabricated e2e helper import** (feasibility, conf 100). `setupSettingsMocks` is a per-spec local function; Task C5 now extracts it to a shared `helpers/settings.ts` (Step 0).
- **Applied — auth-status / unauthenticated-client pattern** (coherence + security-lens). Verified `SessionTokenMiddleware` → 401; Task B3 uses the established `CreateUnauthenticatedClient()`.
- **Applied — stable `load` (no stale closure)**, **single-line enricher branch clarified**, **`NotBeEmpty()` guards on vacuous `OnlyContain` trend assertions**, and two **documented FYI edge-cases** (torn-final-line stall; concurrent read during truncation rebuild) with optional hardening noted.
- **Discarded — scope-guardian's findings**: that reviewer hallucinated a different plan (cited "U-A1–U-A5", "top-5 PR contributors", "(day,model)/(week,model)" buckets, "52-week/2-year retention" — none in this document). Its evidence quotes do not appear in the plan, so all findings fail the evidence gate. Its two incidental technical points (reader re-read I/O; Windows `File.Move` atomicity) were independently checked by feasibility/adversarial and confirmed non-issues.

**One finding deferred to the owner (NOT silently resolved) — Windows ACL (security-lens, P2, conf 75):** the spec §4.1 commits to "owner-restricted dir ACL on Windows … set explicitly on create," but this plan (Task A3) mirrors the sibling `JsonlTokenUsageTracker`, which sets **no** explicit Windows ACL (it relies on the OS-default per-user `dataDir` ACL; the rollup lives in that same dir). The sibling-parity justification is arguably circular. This is a security commitment you approved in the spec, so it is your call — see the question raised alongside this plan.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-19-ai-usage-spend-tracker.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
