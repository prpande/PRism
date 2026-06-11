using System.Collections.Concurrent;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class InboxCacheEvictionTests
{
    private static PrReference Pr(int n) => new("o", "r", n);

    [Fact]
    public void Prunes_keys_whose_PrReference_is_absent_from_live()
    {
        var cache = new ConcurrentDictionary<(PrReference, string), int>();
        cache[(Pr(1), "sha")] = 1;
        cache[(Pr(2), "sha")] = 2;

        InboxCacheEviction.PruneAbsent(cache, new HashSet<PrReference> { Pr(1) });

        cache.ContainsKey((Pr(1), "sha")).Should().BeTrue();
        cache.ContainsKey((Pr(2), "sha")).Should().BeFalse();
    }

    [Fact]
    public void Empty_live_set_prunes_everything()
    {
        var cache = new ConcurrentDictionary<(PrReference, DateTimeOffset), int>();
        cache[(Pr(1), DateTimeOffset.UnixEpoch)] = 1;

        InboxCacheEviction.PruneAbsent(cache, new HashSet<PrReference>());

        cache.Should().BeEmpty();
    }
}
