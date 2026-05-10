namespace PRism.Core.Reconciliation;

internal static class WhitespaceInsignificantExtensions
{
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rs",
        ".rb", ".cpp", ".h", ".html", ".css", ".json", ".md", ".txt",
        ".sh", ".sql"
    };

    public static bool IsAllowed(string filePath)
    {
        var ext = Path.GetExtension(filePath);
        return !string.IsNullOrEmpty(ext) && Allowed.Contains(ext);
    }
}
