using System.Text.Json;
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class InboxJsonGuardTests
{
    [Theory]
    [InlineData(typeof(KeyNotFoundException))]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(FormatException))]
    public void Recognizes_malformed_item_exception_types(Type t)
        => InboxJsonGuard.IsMalformedItem((Exception)Activator.CreateInstance(t)!).Should().BeTrue();

    [Fact]
    public void Recognizes_JsonException()
        => InboxJsonGuard.IsMalformedItem(new JsonException("x")).Should().BeTrue();

    [Theory]
    [InlineData(typeof(OperationCanceledException))]
    [InlineData(typeof(HttpRequestException))]
    public void Does_not_swallow_transport_or_cancellation(Type t)
        => InboxJsonGuard.IsMalformedItem((Exception)Activator.CreateInstance(t)!).Should().BeFalse();

    [Fact]
    public void Does_not_swallow_rate_limit()
        => InboxJsonGuard.IsMalformedItem(
            new RateLimitExceededException("x", TimeSpan.FromSeconds(1))).Should().BeFalse();
}
