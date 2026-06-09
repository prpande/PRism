using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiCapabilityResolverConsentTests
{
    private static AiCapabilityResolver WithSummarizer()
        => new(new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new object() });

    [Fact]
    public void Live_Available_NoConsent_SummaryFalse_ReasonConsentRequired()
    {
        var r = WithSummarizer();
        r.Resolve(AiMode.Live, LlmAvailability.Ok, consented: false).Summary.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Ok, consented: false)
            .Should().Be("consent-required");
    }

    [Fact]
    public void Live_Available_Consented_SummaryTrue_ReasonNone()
    {
        var r = WithSummarizer();
        r.Resolve(AiMode.Live, LlmAvailability.Ok, consented: true).Summary.Should().BeTrue();
        AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Ok, consented: true).Should().Be("none");
    }

    [Fact]
    public void Live_ProbeUnavailable_AndUnconsented_ProviderReasonWins()
        => AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Unavailable("not-installed"), consented: false)
            .Should().Be("not-installed");
}
