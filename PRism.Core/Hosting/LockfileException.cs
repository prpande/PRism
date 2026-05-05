namespace PRism.Core.Hosting;

public enum LockfileFailure { AnotherInstanceRunning }

public sealed class LockfileException : Exception
{
    public LockfileException() : base() { }
    public LockfileException(string message) : base(message) { }
    public LockfileException(string message, Exception inner) : base(message, inner) { }
    public LockfileException(LockfileFailure reason, string message) : base(message) { Reason = reason; }
    public LockfileFailure Reason { get; }
}
