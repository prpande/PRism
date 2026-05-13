using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AccountKeysTests
{
    [Fact]
    public void Default_is_the_literal_default_string()
    {
        AccountKeys.Default.Should().Be("default");
    }
}
