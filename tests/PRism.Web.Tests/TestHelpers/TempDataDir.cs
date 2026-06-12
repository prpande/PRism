using System.IO;

namespace PRism.Web.Tests.TestHelpers;

// One spelling of the per-test temp data directory: a "{prefix}-{guid}" folder under the
// system temp path. NewPath only computes a collision-free path string — callers own the
// directory's lifecycle (Directory.CreateDirectory + cleanup). The FileLogger* tests
// deliberately use bare-GUID paths (no PRism prefix) and are intentionally NOT routed here.
internal static class TempDataDir
{
    public static string NewPath(string prefix) =>
        Path.Combine(Path.GetTempPath(), $"{prefix}-{Guid.NewGuid():N}");
}
