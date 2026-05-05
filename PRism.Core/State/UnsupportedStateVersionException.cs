namespace PRism.Core.State;

public sealed class UnsupportedStateVersionException : Exception
{
    public int Version { get; }

    public UnsupportedStateVersionException()
        : base("state.json was written by an unsupported version of PRism.")
    {
    }

    public UnsupportedStateVersionException(string message)
        : base(message)
    {
    }

    public UnsupportedStateVersionException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public UnsupportedStateVersionException(int version)
        : base($"state.json was written by a newer version of PRism (v{version}). Use that version or delete state.json.")
    {
        Version = version;
    }
}
