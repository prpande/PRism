using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamSelectorGateTests
{
    // The feature key the selector resolves for IPrSummarizer — derived from the same map the selector
    // uses, so a key rename stays consistent and can't make the feature-off cases silently fail-open.
    private static readonly string SummaryKey = AiSeamFeatureKeys.ForSeam(typeof(IPrSummarizer))!;

    private sealed class FakeSummarizer : IPrSummarizer
    {
        public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
            => Task.FromResult<PrSummary?>(null);
    }

    private static AiSeamSelector Build(AiMode mode, AiConsentState consent, AiFeatureState features, object realSummarizer)
    {
        var noop = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new NoopPrSummarizer() };
        var placeholder = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new PlaceholderPrSummarizer() };
        var real = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = realSummarizer };
        return new AiSeamSelector(new AiModeState { Mode = mode }, noop, placeholder, real, consent, features);
    }

    private static AiConsentState Consented()
    {
        var consent = new AiConsentState();
        consent.Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));
        return consent;
    }

    [Fact]
    public void Live_Registered_NoConsent_ResolvesNoop()
    {
        var sel = Build(AiMode.Live, new AiConsentState(), new AiFeatureState(AiFeaturesConfig.AllOn), new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_Registered_Consented_FeatureOn_ResolvesReal()
    {
        var real = new FakeSummarizer();
        var sel = Build(AiMode.Live, Consented(), new AiFeatureState(AiFeaturesConfig.AllOn), real);
        // BeSameAs (not BeOfType) to prove it resolved the REAL bag's instance, not a same-typed stand-in.
        sel.Resolve<IPrSummarizer>().Should().BeSameAs(real);
    }

    [Fact]
    public void Live_Consented_FeatureOff_ResolvesNoop()
    {
        var features = new AiFeatureState(new AiFeaturesConfig(new Dictionary<string, bool> { [SummaryKey] = false }));
        var sel = Build(AiMode.Live, Consented(), features, new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Preview_FeatureOff_ResolvesNoop_NotPlaceholder()
    {
        var features = new AiFeatureState(new AiFeaturesConfig(new Dictionary<string, bool> { [SummaryKey] = false }));
        var sel = Build(AiMode.Preview, new AiConsentState(), features, new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }
}
