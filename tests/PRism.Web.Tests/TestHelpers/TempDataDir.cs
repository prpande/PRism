using System.IO;

namespace PRism.Web.Tests.TestHelpers;

// One spelling of the per-test temp data directory: a "{prefix}-{guid}" folder under the
// system temp path. Callers own the directory's lifecycle (creation/cleanup) — this only
// computes a collision-free path. The FileLogger* tests deliberately use bare-GUID paths
// (no PRism prefix) and are intentionally NOT routed through here.
internal static class TempDataDir
{
    public static string Create(string prefix) =>
        Path.Combine(Path.GetTempPath(), $"{prefix}-{Guid.NewGuid():N}");
}
