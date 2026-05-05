namespace PRism.Core.Config;

public sealed class ConfigPatchException : Exception
{
    public ConfigPatchException() : base() { }
    public ConfigPatchException(string message) : base(message) { }
    public ConfigPatchException(string message, Exception inner) : base(message, inner) { }
}
