namespace PRism.Core.Time;

public interface IClock
{
    DateTime UtcNow { get; }
}
