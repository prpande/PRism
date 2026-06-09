using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiStateHolderSeedTests
{
    [Fact]
    public void Holders_SeedFromConfig_AndExposeDefaults()
    {
        var consent = new AiConsentState();
        consent.IsConsented("claude-code", "1").Should().BeFalse();   // default None
        consent.Set(new AiConsentConfig("claude-code", "1", DateTimeOffset.UtcNow));
        consent.IsConsented("claude-code", "1").Should().BeTrue();    // exact match
        consent.IsConsented("other-provider", "1").Should().BeFalse();// provider mismatch => false
        consent.IsConsented("claude-code", "2").Should().BeFalse();   // version mismatch => false

        var features = new AiFeatureState(AiFeaturesConfig.AllOn);
        features.IsEnabled("summary").Should().BeTrue();
        features.IsEnabled("unknown-key").Should().BeTrue();          // unknown => enabled (fail-open default-on)
    }
}
