using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class ConfigStoreServiceRegistrationTests
{
    // ConfigStore's ILogger<ConfigStore> ctor param is optional (NullLogger fallback), so AddPrismCore
    // must resolve IConfigStore even when the caller registered no logging. The DI factory therefore
    // resolves the logger with GetService (nullable), not GetRequiredService — otherwise a bare
    // AddPrismCore container (common in unit tests) throws "No service for type ILogger<ConfigStore>"
    // when IConfigStore is first resolved. Regression guard for #323 item 4c.
    [Fact]
    public void AddPrismCore_resolves_IConfigStore_without_a_logging_registration()
    {
        using var dir = new TempDataDir();
        using var provider = new ServiceCollection().AddPrismCore(dir.Path).BuildServiceProvider();

        var resolve = () => provider.GetRequiredService<IConfigStore>();

        resolve.Should().NotThrow("the optional ILogger<ConfigStore> seam must not make logging a hard DI dependency");
        resolve().Should().NotBeNull();
    }
}
