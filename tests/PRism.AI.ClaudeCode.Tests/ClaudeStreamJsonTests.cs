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
