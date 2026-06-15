using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.ClaudeCode;
using PRism.Core.Config;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Ai;

public class ProviderTimeoutWiringTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public ProviderTimeoutWiringTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task TimeoutProvider_reflects_a_config_patch_clamped()
    {
        using var scope = _factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        var store = sp.GetRequiredService<IConfigStore>();
        var options = sp.GetRequiredService<ClaudeCodeProviderOptions>();

        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 300 }, default);
        options.TimeoutProvider().Should().Be(TimeSpan.FromSeconds(300));

        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 5000 }, default);
        options.TimeoutProvider().Should().Be(TimeSpan.FromSeconds(600));
    }
}
