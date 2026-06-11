using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #312 Task 7 — endpoint integration tests for the mid-session re-auth surface.
// Detection through the real handler is proven by Task 5
// (Validate_WithoutSkip_LatchesAfterTwo). These tests prove (a) /api/auth/state
// SURFACES the singleton latch and (b) the latch-clear on replace is validation-gated:
// a bad replace cannot clear it (mandatory-valid), a good replace DOES clear it
// (proving MarkValid() is actually called on the success path — without this last
// test a dropped MarkValid() would still pass everything else).
public class CredentialHealthEndpointTests
{
#pragma warning disable CA1812 // System.Text.Json instantiates via reflection — analyzer can't see the use.
    private sealed record AuthStateDto(bool HasToken, string Host, object? HostMismatch, bool GithubCredentialInvalid);
#pragma warning restore CA1812

    [Fact]
    public async Task State_DefaultsToValid()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.False(state!.GithubCredentialInvalid);
    }

    [Fact]
    public async Task State_ReflectsInvalidLatch()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.True(state!.GithubCredentialInvalid);
    }

    [Fact]
    public async Task Replace_WithInvalidToken_DoesNotClearLatch()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(
                new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "bad")),
        };
        var client = factory.CreateClient();
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();
        Assert.True(health.IsInvalid);

        var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.True(state!.GithubCredentialInvalid);
    }

    [Fact]
    public async Task Replace_WithValidToken_ClearsLatch()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(
                new AuthValidationResult(true, "octocat", null, null, null)),
        };
        var client = factory.CreateClient();
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();
        Assert.True(health.IsInvalid);

        var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
        resp.EnsureSuccessStatusCode();

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.False(state!.GithubCredentialInvalid);
    }
}
