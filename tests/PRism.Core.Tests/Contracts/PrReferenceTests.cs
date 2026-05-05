using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrReferenceTests
{
    [Fact]
    public void ToString_renders_owner_repo_number_form()
    {
        var r = new PrReference("acme", "api-server", 123);
        r.ToString().Should().Be("acme/api-server/123");
    }

    [Fact]
    public void Equality_is_value_based()
    {
        new PrReference("a", "b", 1).Should().Be(new PrReference("a", "b", 1));
        new PrReference("a", "b", 1).Should().NotBe(new PrReference("a", "b", 2));
    }

    [Fact]
    public void PrId_uses_owner_slash_repo_hash_number_form()
    {
        var r = new PrReference("acme", "api", 42);
        r.PrId.Should().Be("acme/api#42");
    }

    [Fact]
    public void ToString_uses_owner_slash_repo_slash_number_for_logging()
    {
        var r = new PrReference("acme", "api", 42);
        r.ToString().Should().Be("acme/api/42");
    }
}
