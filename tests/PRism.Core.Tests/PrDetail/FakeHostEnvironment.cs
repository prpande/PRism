using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace PRism.Core.Tests.PrDetail;

// Minimal IHostEnvironment stub for unit tests that construct ActivePrPoller
// directly (no DI container). The poller only uses env.IsEnvironment(...) to
// decide whether to honor the PRISM_POLLER_CADENCE_SECONDS override; the
// other properties are required by the interface but unused.
internal sealed class FakeHostEnvironment : IHostEnvironment
{
    public FakeHostEnvironment(string environmentName)
    {
        EnvironmentName = environmentName;
        ApplicationName = "test";
        ContentRootPath = AppContext.BaseDirectory;
        ContentRootFileProvider = new NullFileProvider();
    }

    public string EnvironmentName { get; set; }
    public string ApplicationName { get; set; }
    public string ContentRootPath { get; set; }
    public IFileProvider ContentRootFileProvider { get; set; }
}
