using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiCapabilityResolverTests
{
    private static readonly AiCapabilityResolver EmptyP0 = new(new HashSet<Type>());

    [Fact]
    public void Off_all_flags_false_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Off, LlmAvailability.Ok);
        caps.Summary.Should().BeFalse();
        caps.InboxRanking.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Off, LlmAvailability.Ok).Should().Be("none");
    }

    [Fact]
    public void Preview_all_flags_true_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Preview, LlmAvailability.Ok);
        caps.Summary.Should().BeTrue();
        caps.HunkAnnotations.Should().BeTrue();
        caps.InboxRanking.Should().BeTrue();
        AiCapabilityResolver.DisabledReason(AiMode.Preview, LlmAvailability.Ok).Should().Be("none");
    }

    [Fact]
    public void Live_in_P0_all_flags_false_and_surfaces_probe_reason()
    {
        var unavailable = LlmAvailability.Unavailable("cli-not-installed");
        var caps = EmptyP0.Resolve(AiMode.Live, unavailable);
        caps.Summary.Should().BeFalse(); // no real impl registered in P0
        AiCapabilityResolver.DisabledReason(AiMode.Live, unavailable).Should().Be("cli-not-installed");
    }

    [Fact]
    public void Live_with_a_registered_live_seam_and_available_lights_only_that_flag()
    {
        var resolver = new AiCapabilityResolver(new HashSet<Type> { typeof(IPrSummarizer) });
        var caps = resolver.Resolve(AiMode.Live, LlmAvailability.Ok);
        caps.Summary.Should().BeTrue();
        caps.FileFocus.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Ok).Should().Be("none");
    }
}
