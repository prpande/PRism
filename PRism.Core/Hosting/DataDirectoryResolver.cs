namespace PRism.Core.Hosting;

public static class DataDirectoryResolver
{
    public static string Resolve(string? root = null)
    {
        var baseDir = root ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dataDir = Path.Combine(baseDir, "PRism");
        Directory.CreateDirectory(dataDir);
        return dataDir;
    }
}
