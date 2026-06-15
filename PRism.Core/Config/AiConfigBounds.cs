namespace PRism.Core.Config;

/// <summary>
/// Single source of truth for the AI numeric-knob bounds (#496). Lives in PRism.Core so both
/// <see cref="ConfigStore"/> (write-clamp) and the PRism.Web composition root (read-clamp in the
/// timeout DI factory + the GET DTO) can reference it without a layering inversion. Both knobs are
/// clamped on write AND on every read so a hand-edited config.json that bypasses PatchAsync cannot
/// land an out-of-range value at a consumption site.
///
/// NOTE the cap asymmetry — two distinct cap-clamp semantics, single-sourced here so they cannot drift:
/// - <see cref="ClampCap"/> is the WRITE path (a user explicitly typed a value in the UI/POST, always
///   &gt;= 1): floors to <see cref="MinCap"/> (1).
/// - <see cref="ClampCapForRead"/> is the READ/DISPLAY path (a RAW persisted value, which a hand-edited
///   config.json can leave at 0 or negative): a non-positive value means "absent / legacy" and defaults
///   to <see cref="DefaultCap"/> (10), NOT the min 1; otherwise upper-bounds to <see cref="MaxCap"/>.
///   Both the annotator (read) and the GET DTO (display) call this so the shown value == the effective
///   value even for the legacy-0 corner.
/// </summary>
public static class AiConfigBounds
{
    public const int MinTimeout = 30;
    public const int MaxTimeout = 600;
    public const int MinCap = 1;
    public const int MaxCap = 50;
    public const int DefaultCap = 10;

    public static int ClampTimeout(int seconds) => Math.Clamp(seconds, MinTimeout, MaxTimeout);
    public static int ClampCap(int cap) => Math.Clamp(cap, MinCap, MaxCap);

    // Read/display semantics: non-positive (absent/legacy) → DefaultCap (10); otherwise cap at MaxCap (50).
    // Single source for the annotator's read-clamp AND the GET DTO's display-clamp so they cannot disagree.
    public static int ClampCapForRead(int cap) => cap <= 0 ? DefaultCap : Math.Min(cap, MaxCap);
}
