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
        $"{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{t}\"}}}}}}";
    private static string Result(string txt) =>
        $"{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{txt}\",\"total_cost_usd\":0.01,\"usage\":{{\"input_tokens\":1,\"output_tokens\":2,\"cache_read_input_tokens\":3}}}}";

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

    [Fact]
    public async Task ProviderSessionId_is_empty_before_init_then_set_after(/* spec §7 temporal carry-forward */)
    {
        var proc = new FakeStreamingCliProcess();
        await using var session = new ClaudeCodeStreamingSession(proc);

        session.ProviderSessionId.Should().BeEmpty();   // empty before any init line arrives

        proc.EmitLine(Init);
        // Poll briefly: the reader sets _providerSessionId asynchronously after parsing Init.
        // Do NOT fixed-delay — poll the observable condition so this is deterministic on slow CI.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (session.ProviderSessionId.Length == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        session.ProviderSessionId.Should().Be("sess-1");
        proc.EndStdout();
    }
}
