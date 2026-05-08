using FluentAssertions;
using Microsoft.Extensions.Hosting;
using PRism.Web.Middleware;

namespace PRism.Web.Tests.Middleware;

public class SessionTokenProviderTests
{
    [Fact]
    public void In_production_env_ignores_PRISM_DEV_FIXED_TOKEN_env_var()
    {
        // P2.30 — production-grade safety net. Even if PRISM_DEV_FIXED_TOKEN is set,
        // a non-Development host must use a fresh random token. Closes the path where
        // a stray env var on a deployed binary would lock in a guessable token.
        var original = Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        try
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", "this-must-be-ignored-in-production");
            var provider = new SessionTokenProvider(new FakeEnv("Production"));

            provider.Current.Should().NotBe("this-must-be-ignored-in-production");
            provider.Current.Length.Should().BeGreaterThan(20, "should be a random Base64 of 32 random bytes");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", original);
        }
    }

    [Fact]
    public void In_test_env_ignores_PRISM_DEV_FIXED_TOKEN_env_var()
    {
        // The Test environment is also non-Development, so the override must NOT apply.
        var original = Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        try
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", "still-ignored");
            var provider = new SessionTokenProvider(new FakeEnv("Test"));

            provider.Current.Should().NotBe("still-ignored");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", original);
        }
    }

    [Fact]
    public void In_development_env_with_env_override_uses_override()
    {
        var original = Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        try
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", "dev-fixed-abc");
            var provider = new SessionTokenProvider(new FakeEnv("Development"));

            provider.Current.Should().Be("dev-fixed-abc");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", original);
        }
    }

    [Fact]
    public void In_development_env_without_env_override_generates_random()
    {
        var original = Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        try
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", null);
            var p1 = new SessionTokenProvider(new FakeEnv("Development"));
            var p2 = new SessionTokenProvider(new FakeEnv("Development"));

            p1.Current.Should().NotBe(p2.Current, "two providers without env override should generate distinct random tokens");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN", original);
        }
    }

    private sealed class FakeEnv : IHostEnvironment
    {
        public FakeEnv(string envName) { EnvironmentName = envName; }
        public string EnvironmentName { get; set; }
        public string ApplicationName { get; set; } = "PRism.Web.Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
