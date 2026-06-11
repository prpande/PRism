using FluentAssertions;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubRestContractExceptionTests
{
    [Fact]
    public void Carries_message()
        => new GitHubRestContractException("boom").Message.Should().Be("boom");

    [Fact]
    public void Is_not_an_HttpRequestException()
        => new GitHubRestContractException("x").Should().NotBeAssignableTo<HttpRequestException>();
}
