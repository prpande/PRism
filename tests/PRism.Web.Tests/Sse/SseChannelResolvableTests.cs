using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Web.Sse;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Sse;

// Task 5 — DI resolvability smoke test. Guards that the production container injects the two
// new optional ctor params (IActivePrCache, IImmediateRefresh) into SseChannel without
// throwing, even though they are declared optional. Both are registered singletons, so .NET
// DI will resolve and inject them rather than defaulting to null.
public class SseChannelResolvableTests
{
    [Fact]
    public void SseChannel_resolves_without_throwing_from_production_container()
    {
        using var factory = new PRismWebApplicationFactory();
        var channel = factory.Services.GetRequiredService<SseChannel>();
        channel.Should().NotBeNull();
    }
}
