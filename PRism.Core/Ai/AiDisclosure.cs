namespace PRism.Core.Ai;

/// <summary>Egress-disclosure version (spec §5). Bumping invalidates stored consent (the predicate
/// compares against this). A "material change" — recipient, data categories, or retention/usage terms —
/// warrants a bump; copy-editing does not. See the change-control rule in the spec.</summary>
public static class AiDisclosure
{
    public const string CurrentVersion = "1";
}
