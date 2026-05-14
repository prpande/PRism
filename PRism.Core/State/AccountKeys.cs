namespace PRism.Core.State;

/// <summary>
/// Single source of truth for the v1 account key. v1 ships single-account
/// with this literal; v2 introduces UUID generation alongside (or rekeys
/// this literal at first v2 launch — see spec § 3).
/// </summary>
/// <remarks>
/// <para>
/// <b>Wire-format coupling.</b> The constant value MUST equal the on-disk JSON
/// key string used in <c>state.json</c>'s <c>accounts.{key}</c> and
/// <c>config.json</c>'s <c>github.accounts[].id</c>. They aren't just stylistically
/// linked — they're semantically equal in v1. Migration code (<c>AppStateMigrations
/// .MigrateV4ToV5</c>, <c>AppStateStore.EnsureCurrentShape</c>, <c>ConfigStore</c>'s
/// legacy-shape rewrite) reads this constant for the JSON-key access; if the
/// constant value ever changes without a corresponding wire-format migration,
/// existing on-disk files become unreadable.
/// </para>
/// <para>
/// If a future v2 wants to rename the in-memory account key (e.g., to a UUID at
/// first v2 launch per spec § 3) WITHOUT rewriting on-disk files, the JSON-key
/// access sites would need to use a separate wire-format constant
/// (e.g., <c>AccountKeys.WireDefault = "default"</c>) while the in-memory key
/// adopts the new value. v1 does not split the two; v2 brainstorm decides.
/// </para>
/// </remarks>
public static class AccountKeys
{
    public const string Default = "default";
}
