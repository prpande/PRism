using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Contracts;
using PRism.Web.Submit;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class SubmitInFlightEndpointTests
{
    [Fact]
    public async Task GET_inFlight_EmptyRegistry_ReturnsFalse()
    {
        using var factory = new PRismWebApplicationFactory();
        using var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/submit/in-flight", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<SubmitInFlightResponseDto>();
        body.Should().NotBeNull();
        body!.InFlight.Should().BeFalse();
        body.PrRef.Should().BeNull();
    }

    [Fact]
    public async Task GET_inFlight_LockHeld_ReturnsTrueWithRef()
    {
        using var factory = new PRismWebApplicationFactory();
        var registry = factory.Services.GetRequiredService<SubmitLockRegistry>();
        await using var handle = await registry.TryAcquireAsync(
            new PrReference("octocat", "Hello-World", 1),
            TimeSpan.Zero,
            CancellationToken.None);
        handle.Should().NotBeNull();

        using var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/submit/in-flight", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<SubmitInFlightResponseDto>();
        body.Should().NotBeNull();
        body!.InFlight.Should().BeTrue();
        body.PrRef.Should().Be("octocat/Hello-World/1");
    }

    // Mirror of the internal SubmitInFlightResponse wire record (deserialized via
    // JsonSerializerOptionsFactory.Api → camelCase → property names align).
    public sealed record SubmitInFlightResponseDto(bool InFlight, string? PrRef);
}
