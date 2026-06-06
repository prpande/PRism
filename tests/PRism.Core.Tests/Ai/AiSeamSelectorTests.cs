using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamSelectorTests
{
    private static AiSeamSelector BuildSelector(AiModeState state, bool liveAvailable = false, bool withRealSummarizer = false)
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
        var real = new Dictionary<Type, object>();
        if (withRealSummarizer) real[typeof(IPrSummarizer)] = new PlaceholderPrSummarizer(); // stand-in "real" for the test
        return new AiSeamSelector(state, noop, placeholder, real, () => liveAvailable);
    }

    [Fact]
    public void Off_resolves_Noop()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Off });
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Preview_resolves_Placeholder()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Preview });
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Live_with_no_real_impl_resolves_Noop_never_Placeholder()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_but_unavailable_resolves_Noop()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: false, withRealSummarizer: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_and_available_resolves_real()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: true, withRealSummarizer: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_observes_runtime_mode_flips()
    {
        var state = new AiModeState { Mode = AiMode.Off };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
        state.Mode = AiMode.Preview;
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_throws_when_seam_is_not_registered()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Off });
        Action act = () => sut.Resolve<IComposerAssistant>();
        act.Should().Throw<InvalidOperationException>().WithMessage("*IComposerAssistant*not registered*");
    }
}
