using FluentAssertions;
using PRism.Core.Events;
using Xunit;

namespace PRism.Core.Tests.Events;

public class IdentityChangedTests
{
    [Fact]
    public void Construct_StoresFields()
    {
        var evt = new IdentityChanged("default", "alice", "bob");
        evt.AccountKey.Should().Be("default");
        evt.PriorLogin.Should().Be("alice");
        evt.NewLogin.Should().Be("bob");
    }

    [Fact]
    public void ImplementsIReviewEvent()
    {
        IReviewEvent evt = new IdentityChanged("default", "alice", "bob");
        evt.Should().NotBeNull();
    }
}
