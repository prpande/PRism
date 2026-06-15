using FluentAssertions;
using PRism.AI.ClaudeCode;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public class LlmProviderExceptionTimedOutTests
{
    [Fact]
    public void Three_arg_ctor_defaults_TimedOut_false() =>
        new LlmProviderException("msg", stderr: "", exitCode: 1).TimedOut.Should().BeFalse();

    [Fact]
    public void Timed_out_flag_is_settable_true() =>
        new LlmProviderException("timed out", stderr: "", exitCode: -1, timedOut: true)
            .TimedOut.Should().BeTrue();

    [Fact]
    public void Framework_ctors_default_TimedOut_false()
    {
        new LlmProviderException().TimedOut.Should().BeFalse();
        new LlmProviderException("m").TimedOut.Should().BeFalse();
        new LlmProviderException("m", new InvalidOperationException()).TimedOut.Should().BeFalse();
    }
}
