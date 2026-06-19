namespace PRism.Core.Contracts;

// Viewer's submitted-review verdict. Serialized kebab-case (approved / changes-requested /
// commented) by the JsonStringEnumConverter(KebabCaseJsonNamingPolicy) on
// JsonSerializerOptionsFactory.Api. Output-only — DISMISSED/PENDING are never surfaced
// (excluded at selection), so they are not enum members.
public enum ReviewState
{
    Approved,
    ChangesRequested,
    Commented,
}
