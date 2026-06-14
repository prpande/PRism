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
