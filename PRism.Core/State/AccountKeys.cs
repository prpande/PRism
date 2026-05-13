namespace PRism.Core.State;

/// <summary>
/// Single source of truth for the v1 account key. v1 ships single-account
/// with this literal; v2 introduces UUID generation alongside (or rekeys
/// this literal at first v2 launch — see spec § 3).
/// </summary>
public static class AccountKeys
{
    public const string Default = "default";
}
