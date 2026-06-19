using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamSelectorTests
{
    // A distinct instance placed in the real bag so a test can assert real-bag selection by IDENTITY
    // (BeSameAs). The placeholder bag holds a DIFFERENT instance of the same type, so a type-only
    // assertion could not tell the real bag from the placeholder bag apart.
    private static readonly PlaceholderPrSummarizer RealSummarizerStandIn = new();

    /// <summary>
    /// Builds a selector. <paramref name="consented"/> replaces the old <c>liveAvailable</c> bool:
    /// false (default) → empty AiConsentState → Live stays Noop; true → consent set to Claude/"1"
    /// → Live can resolve real when a real seam is registered and the feature is on.
    /// </summary>
    private static AiSeamSelector BuildSelector(AiModeState state, bool consented = false, bool withRealSummarizer = false)
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
        if (withRealSummarizer) real[typeof(IPrSummarizer)] = RealSummarizerStandIn; // distinct real-bag instance (see field comment)

        var consentState = new AiConsentState();
        if (consented)
            consentState.Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));

        return new AiSeamSelector(state, noop, placeholder, real, consentState, new AiFeatureState(AiFeaturesConfig.AllOn));
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
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, consented: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_but_unavailable_resolves_Noop()
    {
        // consented: false → no consent → Live collapses to Noop even though real seam is registered
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, consented: false, withRealSummarizer: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_and_available_resolves_real()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, consented: true, withRealSummarizer: true);
        // Assert by IDENTITY, not type: the placeholder bag holds a different PlaceholderPrSummarizer
        // instance, so BeSameAs proves the REAL bag was selected (a type-only check could not).
        sut.Resolve<IPrSummarizer>().Should().BeSameAs(RealSummarizerStandIn);
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
