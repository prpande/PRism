using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiCapabilityResolverTests
{
    private static AiFeatureState AllFeaturesOn() => new(AiFeaturesConfig.AllOn);
    private static readonly AiCapabilityResolver EmptyP0 = new(new Dictionary<Type, object>(), new AiFeatureState(AiFeaturesConfig.AllOn));

    [Fact]
    public void Off_all_flags_false_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Off, LlmAvailability.Ok, consented: true);
        caps.Summary.Should().BeFalse();
        caps.InboxRanking.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Off, LlmAvailability.Ok, consented: true).Should().Be("none");
    }

    [Fact]
    public void Preview_all_flags_true_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Preview, LlmAvailability.Ok, consented: true);
        caps.Summary.Should().BeTrue();
        caps.HunkAnnotations.Should().BeTrue();
        caps.InboxRanking.Should().BeTrue();
        AiCapabilityResolver.DisabledReason(AiMode.Preview, LlmAvailability.Ok, consented: true).Should().Be("none");
    }

    [Fact]
    public void Live_in_P0_all_flags_false_and_surfaces_probe_reason()
    {
        var unavailable = LlmAvailability.Unavailable("cli-not-installed");
        // consented:true so probe-unavailability is the unambiguous driver of all-flags-false here
        // (the P0 story is "CLI not installed", not "user hasn't consented").
        var caps = EmptyP0.Resolve(AiMode.Live, unavailable, consented: true);
        caps.Summary.Should().BeFalse(); // no real impl registered in P0
        AiCapabilityResolver.DisabledReason(AiMode.Live, unavailable, consented: true).Should().Be("cli-not-installed");
    }

    [Fact]
    public void Live_with_a_registered_live_seam_and_available_lights_only_that_flag()
    {
        var resolver = new AiCapabilityResolver(new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new object() }, AllFeaturesOn());
        var caps = resolver.Resolve(AiMode.Live, LlmAvailability.Ok, consented: true);
        caps.Summary.Should().BeTrue();
        caps.FileFocus.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Ok, consented: true).Should().Be("none");
    }

    [Fact]
    public void Ctor_throws_on_null_live_seams()
    {
        // Matches the codebase ThrowIfNull-in-ctor convention; a null from DI/misconfig must fail fast
        // rather than NRE later inside Resolve (PR #250 review).
        Action act = () => _ = new AiCapabilityResolver(null!, AllFeaturesOn());
        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Resolve_reflects_live_seams_added_after_construction()
    {
        // Guards against snapshotting the live-seam set at construction (PR #250 review): the resolver
        // must read the SAME live dictionary the AiSeamSelector holds (shared by reference in
        // composition), so when P1 registers the first real impl, the capability flag and the resolved
        // seam light up together. A snapshot (e.g. realSeams.Keys.ToHashSet()) would freeze P0's empty
        // set and this test's post-construction addition would never be observed.
        var realSeams = new Dictionary<Type, object>();
        var resolver = new AiCapabilityResolver(realSeams, AllFeaturesOn());

        resolver.Resolve(AiMode.Live, LlmAvailability.Ok, consented: true).Summary.Should().BeFalse(); // empty: nothing live yet

        realSeams[typeof(IPrSummarizer)] = new object(); // P1 registers a real impl into the shared dict

        resolver.Resolve(AiMode.Live, LlmAvailability.Ok, consented: true).Summary.Should().BeTrue(); // resolver reflects it live
    }

    [Fact]
    public void User_disabled_feature_forces_its_flag_false_in_Preview()
    {
        // Lockstep with AiSeamSelector (which returns Noop for a disabled feature even in Preview):
        // a config-disabled feature must NOT report as an available capability. Other flags stay on.
        var features = new AiFeatureState(new AiFeaturesConfig(
            new Dictionary<string, bool> { ["summary"] = false }));
        var resolver = new AiCapabilityResolver(new Dictionary<Type, object>(), features);

        var caps = resolver.Resolve(AiMode.Preview, LlmAvailability.Ok, consented: true);

        caps.Summary.Should().BeFalse();        // user-disabled → not available
        caps.HunkAnnotations.Should().BeTrue(); // other features unaffected (fail-open on absent keys)
    }

    [Fact]
    public void User_disabled_feature_forces_its_flag_false_in_Live_even_when_registered_and_available()
    {
        var features = new AiFeatureState(new AiFeaturesConfig(
            new Dictionary<string, bool> { ["summary"] = false }));
        var resolver = new AiCapabilityResolver(
            new Dictionary<Type, object> { [typeof(IPrSummarizer)] = new object() }, features);

        resolver.Resolve(AiMode.Live, LlmAvailability.Ok, consented: true).Summary.Should().BeFalse();
    }
}
