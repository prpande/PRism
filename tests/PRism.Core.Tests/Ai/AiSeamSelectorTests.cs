using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class AiSeamSelectorTests
{
    private static AiSeamSelector BuildSelector(AiPreviewState state)
    {
        var noop = new Dictionary<Type, object>
        {
            [typeof(IPrSummarizer)] = new NoopPrSummarizer(),
            [typeof(IInboxRanker)] = new NoopInboxRanker(),
        };
        var placeholder = new Dictionary<Type, object>
        {
            [typeof(IPrSummarizer)] = new PlaceholderPrSummarizer(),
            [typeof(IInboxRanker)] = new PlaceholderInboxRanker(),
        };
        return new AiSeamSelector(state, noop, placeholder);
    }

    [Fact]
    public void Resolve_returns_Noop_when_aiPreview_is_off()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Resolve_returns_Placeholder_when_aiPreview_is_on()
    {
        var state = new AiPreviewState { IsOn = true };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_observes_runtime_flips()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();

        state.IsOn = true;
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_throws_when_seam_is_not_registered()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        Action act = () => sut.Resolve<IComposerAssistant>();
        act.Should().Throw<InvalidOperationException>().WithMessage("*IComposerAssistant*not registered*");
    }
}
