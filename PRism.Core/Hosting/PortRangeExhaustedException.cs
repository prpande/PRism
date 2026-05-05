namespace PRism.Core.Hosting;

public sealed class PortRangeExhaustedException : Exception
{
    public PortRangeExhaustedException() : base() { }
    public PortRangeExhaustedException(string message) : base(message) { }
    public PortRangeExhaustedException(string message, Exception inner) : base(message, inner) { }
    public PortRangeExhaustedException(int from, int to)
        : base($"PRism couldn't claim a port. Stop the other instance(s) (check Task Manager / Activity Monitor for PRism) and try again. Range: {from}-{to}.") { }
}
