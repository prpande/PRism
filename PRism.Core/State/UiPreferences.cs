namespace PRism.Core.State;

public sealed record UiPreferences(DiffMode DiffMode)
{
    public static UiPreferences Default { get; } = new(DiffMode: DiffMode.SideBySide);
}

public enum DiffMode
{
    SideBySide,
    Unified,
}
