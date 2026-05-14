using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class ViewerLoginHydratorConfigWriteTests
{
    [Fact]
    public async Task StartAsync_writes_validated_login_into_config_accounts_default_login()
    {
        using var dir = new TempDataDir();
        // Seed config with the new accounts shape but null login.
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": null, "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: true);
        var review = new StubReviewAuth(new AuthValidationResult(Ok: true, Login: "alice", Scopes: null, Error: null, ErrorDetail: null));
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        loginCache.Get().Should().Be("alice");
        config.Current.Github.Accounts[0].Login.Should().Be("alice");
    }

    [Fact]
    public async Task StartAsync_does_not_clobber_config_login_when_no_token_present()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "preserved-login", "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: false);
        var review = new StubReviewAuth(throwOnValidate: true);  // would throw if called
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        // No token → ValidateCredentialsAsync never runs → config.login stays as-is.
        config.Current.Github.Accounts[0].Login.Should().Be("preserved-login");
    }

    [Fact]
    public async Task StartAsync_does_not_overwrite_config_login_when_validation_fails()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "stale-login", "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: true);
        var review = new StubReviewAuth(new AuthValidationResult(Ok: false, Login: null, Scopes: null, Error: AuthValidationError.InvalidToken, ErrorDetail: null));
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        // Validation rejected → the existing (potentially stale) login stays; user must reauth at Setup.
        config.Current.Github.Accounts[0].Login.Should().Be("stale-login");
    }
}
