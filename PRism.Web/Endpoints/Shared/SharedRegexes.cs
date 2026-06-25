using System.Text.RegularExpressions;

namespace PRism.Web.Endpoints;

internal static partial class SharedRegexes
{
    [GeneratedRegex("^[0-9a-fA-F]{40}$")]
    internal static partial Regex Sha40();

    [GeneratedRegex("^[0-9a-fA-F]{64}$")]
    internal static partial Regex Sha64();

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,100}$")]
    internal static partial Regex OwnerRepo();
}
