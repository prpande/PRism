using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Observability;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class ClaudeCodeInboxItemEnricherTests
{
    private static PrInboxItem Item(int n, string title, string? desc, bool draft = false) => new(
        new PrReference("octo", "repo", n), title, "octo", "octo/repo",
        DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 1, 0, 0, 0, 0, "sha",
        CiStatus.None, null, null, IsDraft: draft, Description: desc);

    private static AiConsentState Consented()
    {
        var c = new AiConsentState();
        c.Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));
        return c;
    }

    private sealed class FakeLlmProvider : ILlmProvider
    {
        private readonly string[] _responses;
        private readonly Exception? _throw;
        public FakeLlmProvider(params string[] responses) => _responses = responses;
        private FakeLlmProvider(Exception ex) { _throw = ex; _responses = Array.Empty<string>(); }
        public static FakeLlmProvider Throwing(Exception ex) => new(ex);
        public int CallCount { get; private set; }
        public string? LastUserContent { get; private set; }
        public string? LastSystemPrompt { get; private set; }
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            CallCount++;
            LastUserContent = request.UserContent;
            LastSystemPrompt = request.SystemPrompt;
            if (_throw is not null) throw _throw;
            // Surface a retry-logic bug loudly: a test configures exactly the responses it expects
            // to be consumed, so an extra call is a defect — not a reason to silently replay the last.
            if (CallCount > _responses.Length)
                throw new InvalidOperationException(
                    $"FakeLlmProvider called {CallCount} times but only {_responses.Length} response(s) configured.");
            return Task.FromResult(new LlmResult(_responses[CallCount - 1], 100, 20, 0, 89414, 0.01m));
        }
    }
    private sealed class FakeTokenUsageTracker : ITokenUsageTracker
    {
        public List<TokenUsageRecord> Records { get; } = new();
        public Task RecordAsync(TokenUsageRecord record, CancellationToken ct) { Records.Add(record); return Task.CompletedTask; }
    }
    private sealed class FakeAiInteractionLog : IAiInteractionLog
    {
        public List<AiInteractionRecord> Records { get; } = new();
        public void Record(AiInteractionRecord record) => Records.Add(record);
    }
    private sealed class CapturingBus : IReviewEventBus
    {
        public List<object> Published { get; } = new();
        public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent => Published.Add(evt!);
        public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent => new Noop();
        private sealed class Noop : IDisposable { public void Dispose() { } }
    }

    /// <summary>
    /// A gated LLM provider whose CompleteAsync blocks until the test releases it.
    /// Exposes <see cref="Entered"/> so the test can await "runner reached the provider"
    /// before disposing — guaranteeing the runner is past its entry ThrowIfCancellationRequested.
    /// </summary>
    private sealed class GatedLlmProvider : ILlmProvider
    {
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<string> _gate = new(TaskCreationOptions.RunContinuationsAsynchronously);

        /// Completes when CompleteAsync has been entered (runner is mid-flight at the provider).
        public Task Entered => _entered.Task;

        /// Unblocks CompleteAsync with the given JSON response.
        public void Release(string json) => _gate.TrySetResult(json);

        public async Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            _entered.TrySetResult();
            var json = await _gate.Task.ConfigureAwait(false);
            return new LlmResult(json, 100, 20, 0, 89414, 0.01m);
        }
    }

    private static ClaudeCodeInboxItemEnricher Build(ILlmProvider provider) => new(
        provider, new FakeTokenUsageTracker(), new FakeAiInteractionLog(), new CapturingBus(),
        Consented(), NullLogger<ClaudeCodeInboxItemEnricher>.Instance);

    private static ClaudeCodeInboxItemEnricher BuildWithBus(ILlmProvider provider, CapturingBus bus,
        AiConsentState? consent = null) => new(
        provider, new FakeTokenUsageTracker(), new FakeAiInteractionLog(), bus,
        consent ?? Consented(), NullLogger<ClaudeCodeInboxItemEnricher>.Instance);

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

    [Fact]
    public async Task EnrichBatch_parses_and_normalizes_categories()
    {
        var provider = new FakeLlmProvider(
            """[{"prId":"octo/repo#1","category":"feature"},{"prId":"octo/repo#2","category":"Other"}]""");
        var sut = Build(provider);

        var result = await sut.EnrichBatchAsync(new[] { Item(1, "Add login", "x"), Item(2, "misc", "") }, default);

        result.Single(e => e.PrId == "octo/repo#1").CategoryChip.Should().Be("Feature");
        result.Single(e => e.PrId == "octo/repo#2").CategoryChip.Should().BeNull();
        provider.CallCount.Should().Be(1);
    }

    [Fact]
    public async Task EnrichBatch_records_cache_creation_input_tokens_in_both_sinks()
    {
        // #379: the cold-call input volume billed as cache-creation must reach BOTH the budget tracker
        // and the audit log for the batch enrichment call.
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"fix"}]""");
        var tracker = new FakeTokenUsageTracker();
        var log = new FakeAiInteractionLog();
        var sut = new ClaudeCodeInboxItemEnricher(
            provider, tracker, log, new CapturingBus(),
            Consented(), NullLogger<ClaudeCodeInboxItemEnricher>.Instance);

        await sut.EnrichBatchAsync(new[] { Item(1, "Fix crash", "x") }, default);

        tracker.Records.Should().ContainSingle().Which.CacheCreationInputTokens.Should().Be(89414);
        log.Records.Should().Contain(r =>
            r.Outcome == AiInteractionOutcome.Ok && r.CacheCreationInputTokens == 89414);
    }

    [Fact]
    public async Task EnrichBatch_parses_fenced_json_on_first_call()
    {
        // Live-validation finding (#410): the real claude-code CLI wraps the array in a
        // ```json markdown fence despite the "ONLY JSON" instruction, so a strict
        // JsonDocument.Parse on the whole reply throws and every chip comes back null.
        // The parser must extract the first JSON array, and a fenced-but-valid first reply
        // must NOT trigger the retry.
        var provider = new FakeLlmProvider(
            "```json\n[{\"prId\":\"octo/repo#1\",\"category\":\"fix\"}]\n```");
        var sut = Build(provider);

        var result = await sut.EnrichBatchAsync(new[] { Item(1, "Fix crash", "x") }, default);

        result.Single().CategoryChip.Should().Be("Bug fix");
        provider.CallCount.Should().Be(1);
    }

    [Fact]
    public async Task EnrichBatch_parses_json_with_prose_preamble()
    {
        // Defense for the other shape LLMs emit: a sentence before the array.
        var provider = new FakeLlmProvider(
            """Here is the categorization: [{"prId":"octo/repo#1","category":"docs"}]""");
        var sut = Build(provider);

        var result = await sut.EnrichBatchAsync(new[] { Item(1, "Update guide", "x") }, default);

        result.Single().CategoryChip.Should().Be("Docs");
        provider.CallCount.Should().Be(1);
    }

    [Fact]
    public async Task EnrichBatch_retries_once_on_garbage_then_succeeds()
    {
        var provider = new FakeLlmProvider("not json", """[{"prId":"octo/repo#1","category":"fix"}]""");
        var sut = Build(provider);

        var result = await sut.EnrichBatchAsync(new[] { Item(1, "Fix crash", "x") }, default);

        result.Single().CategoryChip.Should().Be("Bug fix");
        provider.CallCount.Should().Be(2);
    }

    [Fact]
    public async Task EnrichBatch_wraps_title_and_description_as_data_regions()
    {
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"docs"}]""");
        var sut = Build(provider);

        await sut.EnrichBatchAsync(new[] { Item(1, "Update guide", "Edits the README.") }, default);

        provider.LastUserContent.Should().Contain("<pr_title>").And.Contain("<pr_description>");
        provider.LastSystemPrompt.Should().Contain("untrusted");
    }

    [Fact]
    public async Task EnrichBatch_surfaces_provider_failure_to_caller()
    {
        var provider = FakeLlmProvider.Throwing(new LlmProviderException("boom"));
        var sut = Build(provider);

        var act = async () => await sut.EnrichBatchAsync(new[] { Item(1, "x", "y") }, default);

        await act.Should().ThrowAsync<LlmProviderException>();
    }

    [Fact]
    public async Task EnrichAsync_returns_empty_on_cold_cache_then_publishes_on_background_completion()
    {
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"feature"}]""");
        var bus = new CapturingBus();
        var sut = BuildWithBus(provider, bus);

        var immediate = await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);
        immediate.Should().BeEmpty();

        await sut.DrainPendingAsync();

        var published = bus.Published.OfType<InboxEnrichmentsReady>().Single();
        var r = published.Results.Single();
        r.CategoryChip.Should().Be("Feature");
        r.ContentToken.Should().Be(InboxEnrichmentContent.Token("Add X", "desc"));
    }

    [Fact]
    public async Task EnrichAsync_serves_cache_and_skips_LLM_on_unchanged_content()
    {
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"feature"}]""");
        var sut = BuildWithBus(provider, new CapturingBus());

        await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);
        await sut.DrainPendingAsync();
        var second = await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") with { HeadSha = "newsha" } }, default);

        second.Single().CategoryChip.Should().Be("Feature");
        provider.CallCount.Should().Be(1);
    }

    [Fact]
    public async Task EnrichAsync_reenriches_when_description_changes()
    {
        var provider = new FakeLlmProvider(
            """[{"prId":"octo/repo#1","category":"feature"}]""",
            """[{"prId":"octo/repo#1","category":"docs"}]""");
        var sut = BuildWithBus(provider, new CapturingBus());

        await sut.EnrichAsync(new[] { Item(1, "Add X", "v1") }, default);
        await sut.DrainPendingAsync();
        await sut.EnrichAsync(new[] { Item(1, "Add X", "v2 edited") }, default);
        await sut.DrainPendingAsync();

        provider.CallCount.Should().Be(2);
    }

    [Fact]
    public async Task EnrichAsync_does_not_cache_on_provider_failure_and_does_not_throw()
    {
        var provider = FakeLlmProvider.Throwing(new LlmProviderException("boom"));
        var bus = new CapturingBus();
        var sut = BuildWithBus(provider, bus);

        var result = await sut.EnrichAsync(new[] { Item(1, "x", "y") }, default);
        result.Should().BeEmpty();
        await sut.DrainPendingAsync();

        bus.Published.OfType<InboxEnrichmentsReady>().Should().BeEmpty(); // soft-fail: nothing published
    }

    [Fact]
    public async Task EnrichAsync_aborts_before_egress_when_consent_revoked_midflight()
    {
        var consent = new AiConsentState(); // not consented
        var provider = new FakeLlmProvider("""[{"prId":"octo/repo#1","category":"feature"}]""");
        var bus = new CapturingBus();
        var sut = BuildWithBus(provider, bus, consent);

        await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);
        await sut.DrainPendingAsync();

        provider.CallCount.Should().Be(0);                 // no egress
        bus.Published.Should().BeEmpty();                  // no publish
    }

    [Fact]
    public async Task EnrichAsync_does_not_publish_when_disposed_before_batch_completes()
    {
        var gate = new GatedLlmProvider();
        var bus = new CapturingBus();
        var sut = BuildWithBus(gate, bus);

        await sut.EnrichAsync(new[] { Item(1, "Add X", "desc") }, default);
        await gate.Entered;            // runner is now awaiting the provider, mid-flight (no sleep)

        sut.Dispose();                 // cancels the CTS while the batch is in flight
        gate.Release("""[{"prId":"octo/repo#1","category":"feature"}]""");

        await sut.DrainPendingAsync(); // must NOT throw; awaits the (RanToCompletion) batch
        bus.Published.Should().BeEmpty();   // shutdown suppressed the publish
    }
}
