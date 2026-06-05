using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ServiceRegistrationTests
{
    [Fact]
    public void Resolves_provider_probe_and_tracker_as_singletons()
    {
        var usageDir = Path.Combine(Path.GetTempPath(), "prism-reg-test-usage");
        var services = new ServiceCollection();
        services.AddPrismClaudeCode(
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp\cwd" },
            usageDir: usageDir);
        using var sp = services.BuildServiceProvider(validateScopes: true);

        sp.GetService<ILlmProvider>().Should().BeOfType<ClaudeCodeLlmProvider>();
        sp.GetService<ILlmAvailabilityProbe>().Should().BeOfType<ClaudeCodeAvailabilityProbe>();
        sp.GetService<ITokenUsageTracker>().Should().BeOfType<JsonlTokenUsageTracker>();
        sp.GetRequiredService<ILlmProvider>().Should().BeSameAs(sp.GetRequiredService<ILlmProvider>());
    }

    [Theory]
    [InlineData("S-1-5-18")]   // LocalSystem
    [InlineData("S-1-5-19")]   // LocalService
    [InlineData("S-1-5-20")]   // NetworkService
    [InlineData("S-1-5-82-3006107028-1145531768-4053964996-2616680499-3146583024")]  // app pool
    public void IsServiceSid_true_for_service_accounts(string sid)
        => ClaudeIdentity.IsServiceSid(sid).Should().BeTrue();

    [Theory]
    [InlineData("S-1-5-21-1004336348-1177238915-682003330-1001")]  // normal user
    [InlineData("S-1-5-21-1111111111-2222222222-3333333333-500")]  // built-in admin (still interactive)
    public void IsServiceSid_false_for_interactive_users(string sid)
        => ClaudeIdentity.IsServiceSid(sid).Should().BeFalse();

    [Fact]
    public void Identity_delegate_evaluates_without_throwing_on_this_host()
    {
        // The real delegate must evaluate on any supported OS without throwing (host-independent smoke).
        var act = () => ClaudeIdentity.SameOsUserAsCredentialStore();
        act.Should().NotThrow();
    }
}
