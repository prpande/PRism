using System.Collections.Generic;
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AiFeaturesConfigTests
{
    [Fact]
    public void With_updates_one_key_and_preserves_the_rest()
    {
        var updated = AiFeaturesConfig.AllOn.With("summary", false);

        updated.Enabled["summary"].Should().BeFalse();
        updated.Enabled["fileFocus"].Should().BeTrue();
        updated.Enabled["inboxEnrichment"].Should().BeTrue();
        updated.Enabled.Count.Should().Be(AiFeaturesConfig.AllOn.Enabled.Count);
    }

    [Fact]
    public void With_does_not_mutate_the_source()
    {
        var source = AiFeaturesConfig.AllOn;
        _ = source.With("summary", false);
        source.Enabled["summary"].Should().BeTrue();
    }

    [Fact]
    public void With_uses_ordinal_comparer_so_casing_is_distinct()
    {
        var updated = AiFeaturesConfig.AllOn.With("summary", false);
        // Ordinal: "Summary" is a different key, so the original lower-case stays false-set
        // and the differently-cased lookup misses (would throw KeyNotFound on indexer).
        updated.Enabled.ContainsKey("Summary").Should().BeFalse();
    }
}
