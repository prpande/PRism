using PRism.Core.Auth;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class ViewerLoginProviderTests
{
    [Fact]
    public void Get_returns_empty_string_before_any_Set()
    {
        var provider = new ViewerLoginProvider();

        provider.Get().Should().Be(string.Empty);
    }

    [Fact]
    public void Get_after_Set_reads_the_set_value()
    {
        var provider = new ViewerLoginProvider();

        provider.Set("octocat");

        provider.Get().Should().Be("octocat");
    }

    [Fact]
    public void Get_after_multiple_Sets_returns_most_recent_value()
    {
        var provider = new ViewerLoginProvider();

        provider.Set("first");
        provider.Set("second");
        provider.Set("third");

        provider.Get().Should().Be("third");
    }

    [Fact]
    public async Task Concurrent_Set_and_Get_does_not_throw_or_return_unexpected_value()
    {
        var provider = new ViewerLoginProvider();
        var allowed = new HashSet<string> { string.Empty, "alice", "bob" };

        // Seed with a known value so Get observers always see one of the allowed strings.
        provider.Set("alice");

        // Fire 100 concurrent Sets and 100 concurrent Gets across two parallel loops.
        // This won't deterministically reproduce a memory-visibility race, but it acts as
        // a regression smoke test that the API holds under concurrent use.
        var setTask = Task.Run(() =>
            Parallel.For(0, 100, i =>
            {
                provider.Set((i % 2 == 0) ? "alice" : "bob");
            }));

        var observed = new System.Collections.Concurrent.ConcurrentBag<string>();
        var getTask = Task.Run(() =>
            Parallel.For(0, 100, _ =>
            {
                observed.Add(provider.Get());
            }));

        await Task.WhenAll(setTask, getTask);

        observed.Should().NotBeEmpty();
        observed.Should().OnlyContain(v => allowed.Contains(v));
        provider.Get().Should().BeOneOf("alice", "bob");
    }
}
