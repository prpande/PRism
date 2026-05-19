using System;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Web.Logging;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Logging;

// Asserts the FileLoggerExtensions Test-env gate can be overridden by the
// PRISM_FILE_LOGGER_FORCE=1 env var. Without the override, the existing xUnit
// safety (preventing per-test writer-task storms) is preserved.
//
// Pinned to the EnvVarSensitive collection (DisableParallelization = true) so
// that process-scoped PRISM_FILE_LOGGER_FORCE mutations cannot be observed by
// FileLoggerIntegrationTests running concurrently.
[Collection("EnvVarSensitive")]
public sealed class FileLoggerGateOverrideTests : IDisposable
{
    private readonly string? _originalForceValue;

    public FileLoggerGateOverrideTests()
    {
        _originalForceValue = Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE");
    }

    public void Dispose()
    {
        // Restore the env var to its original state so this test doesn't leak into siblings.
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", _originalForceValue);
        GC.SuppressFinalize(this);
    }

    [Fact]
    public void T_INV_7a_gate_blocks_FileLoggerProvider_in_Test_env_when_override_unset()
    {
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", null);

        using var factory = new PRismWebApplicationFactory();
        using var client = factory.CreateClient();

        var provider = factory.Services.GetService<FileLoggerProvider>();
        provider.Should().BeNull(
            "in Test env without the override env var, the FileLoggerProvider must NOT register");
    }

    [Fact]
    public void T_INV_7b_gate_admits_FileLoggerProvider_in_Test_env_when_override_set()
    {
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", "1");

        using var factory = new PRismWebApplicationFactory();
        using var client = factory.CreateClient();

        var provider = factory.Services.GetService<FileLoggerProvider>();
        provider.Should().NotBeNull(
            "in Test env with PRISM_FILE_LOGGER_FORCE=1, the FileLoggerProvider must register");
    }
}
