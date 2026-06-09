using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamSelectorGateTests
{
    private sealed class FakeSummarizer : IPrSummarizer
    {
        public Task<PRism.AI.Contracts.Dtos.PrSummary?> SummarizeAsync(PRism.Core.Contracts.PrReference pr, CancellationToken ct)
            => Task.FromResult<PRism.AI.Contracts.Dtos.PrSummary?>(null);
    }

    private static AiSeamSelector Build(AiMode mode, AiConsentState consent, AiFeatureState features, object realSummarizer)
    {
        var noop = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new PRism.AI.Contracts.Noop.NoopPrSummarizer() };
        var placeholder = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new PRism.AI.Placeholder.PlaceholderPrSummarizer() };
        var real = new Dictionary<Type, object> { [typeof(IPrSummarizer)] = realSummarizer };
        return new AiSeamSelector(new AiModeState { Mode = mode }, noop, placeholder, real, consent, features);
    }

    [Fact]
    public void Live_Registered_NoConsent_ResolvesNoop()
    {
        var sel = Build(AiMode.Live, new AiConsentState(), new AiFeatureState(AiFeaturesConfig.AllOn), new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<PRism.AI.Contracts.Noop.NoopPrSummarizer>();
    }

    [Fact]
    public void Live_Registered_Consented_FeatureOn_ResolvesReal()
    {
        var consent = new AiConsentState();
        consent.Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));
        var sel = Build(AiMode.Live, consent, new AiFeatureState(AiFeaturesConfig.AllOn), new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<FakeSummarizer>();
    }

    [Fact]
    public void Live_Consented_FeatureOff_ResolvesNoop()
    {
        var consent = new AiConsentState();
        consent.Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));
        var features = new AiFeatureState(new AiFeaturesConfig(new Dictionary<string, bool> { ["summary"] = false }));
        var sel = Build(AiMode.Live, consent, features, new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<PRism.AI.Contracts.Noop.NoopPrSummarizer>();
    }

    [Fact]
    public void Preview_FeatureOff_ResolvesNoop_NotPlaceholder()
    {
        var features = new AiFeatureState(new AiFeaturesConfig(new Dictionary<string, bool> { ["summary"] = false }));
        var sel = Build(AiMode.Preview, new AiConsentState(), features, new FakeSummarizer());
        sel.Resolve<IPrSummarizer>().Should().BeOfType<PRism.AI.Contracts.Noop.NoopPrSummarizer>();
    }
}
