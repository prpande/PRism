namespace PRism.Core.Tests.TestHelpers;

public sealed class TempDataDir : IDisposable
{
    public string Path { get; }
    public TempDataDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path);
    }
    public void Dispose()
    {
        try
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
        catch (IOException) { /* best-effort */ }
        catch (UnauthorizedAccessException) { /* best-effort */ }
    }
}
