using System.Runtime.CompilerServices;

namespace PRism.GitHub.Tests.Integration.Helpers;

/// <summary>
/// Resolves absolute paths to fixture files under
/// <c>tests/PRism.GitHub.Tests.Integration/Fixtures/</c>. Uses <see cref="CallerFilePathAttribute"/>
/// from this file's own location to anchor the resolution at the source-tree path
/// regardless of where the test runner's <c>bin/</c> output lives — so capture mode writes
/// to the checked-in fixture and assert mode reads from the same path, even when the
/// runner copies the file to <c>bin/Release/.../Fixtures/</c> via <c>PreserveNewest</c>.
/// </summary>
public static class FixturePathResolver
{
    /// <summary>Absolute path to <c>Fixtures/{fileName}</c> in the test project's source tree.</summary>
    public static string GetFixturePath(string fileName) =>
        Path.GetFullPath(Path.Combine(SourceDir(), "..", "Fixtures", fileName));

    private static string SourceDir([CallerFilePath] string callerFilePath = "") =>
        Path.GetDirectoryName(callerFilePath)
            ?? throw new InvalidOperationException("CallerFilePath did not resolve");
}
