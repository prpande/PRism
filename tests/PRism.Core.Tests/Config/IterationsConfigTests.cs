using System.Text.Json;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Config;

// Q5 — `iterations.clusteringDisabled` is the calibration-failure escape hatch.
// When set, PrDetailLoader emits ClusteringQuality.Low for every PR and the frontend
// renders CommitMultiSelectPicker instead of IterationTabStrip. Spec § 6.4 + § 7.2.1.
public class IterationsConfigTests
{
    [Fact]
    public void Default_ClusteringDisabled_is_false()
    {
        AppConfig.Default.Iterations.ClusteringDisabled.Should().BeFalse();
    }

    [Fact]
    public void Round_trip_serializes_ClusteringDisabled_as_kebab_case_clustering_disabled()
    {
        var config = AppConfig.Default with
        {
            Iterations = AppConfig.Default.Iterations with { ClusteringDisabled = true }
        };

        var json = JsonSerializer.Serialize(config, JsonSerializerOptionsFactory.Storage);
        json.Should().Contain("\"clustering-disabled\":true");

        var roundTrip = JsonSerializer.Deserialize<AppConfig>(json, JsonSerializerOptionsFactory.Storage)!;
        roundTrip.Iterations.ClusteringDisabled.Should().BeTrue();
    }
}
