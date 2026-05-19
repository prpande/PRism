using System.Text.Json;
using System.Text.Json.Nodes;

namespace PRism.GitHub.Tests.Integration.Helpers;

/// <summary>
/// Applies the spec § 7 category rule to a captured GraphQL response as an ALLOWLIST
/// (not a denylist — spec § 7 mandates this for security). Listed fields survive;
/// everything else is stripped to null. New GraphQL fields default to stripped — adding
/// them is an explicit, reviewable change to AllowedFieldNames below.
///
///   KEPT (structural + enum + count + presence indicators): see AllowedFieldNames.
///   STRIPPED: every field not on the allowlist (freeform text, identity, URLs, anything new).
/// </summary>
public static class FixtureStripAllowlist
{
    // Allowlist of FIELD NAMES (not JSON-pointer paths). Applied recursively — a kept field
    // name kept at every level it appears. This matches the spec § 7 category rule's "Kept"
    // bullet:
    //   - Structural enums:        state, reviewType, mergeable, mergeStateStatus, __typename
    //   - Structural identifiers:  oid, headRefOid, baseRefOid, beforeCommit, afterCommit
    //   - Structural counts:       totalCount, changedFiles, additions, deletions
    //   - Structural booleans:     isDraft, isResolved, hasNextPage
    //   - Structural numbering:    number, line
    //   - Structural envelopes:    pageInfo, endCursor (cursor IS opaque schema-shape, not PII)
    //   - Structural containers:   repository, pullRequest, comments, reviews, reviewThreads, commits,
    //                              timelineItems, nodes, commit, data
    //   - Structural pathing:      path, headRefName, baseRefName
    //   - Structural timestamps:   createdAt, closedAt, mergedAt, committedDate, submittedAt,
    //                              lastEditedAt
    // EVERYTHING NOT IN THIS SET is stripped — title, body, message, login, email, name,
    // avatarUrl, url, databaseId, id, etc. all become null.
    private static readonly HashSet<string> AllowedFieldNames = new(StringComparer.Ordinal)
    {
        // Container/envelope fields — must survive so the differ can walk into them
        "data", "repository", "pullRequest", "comments", "reviews", "reviewThreads", "commits",
        "timelineItems", "nodes", "edges", "node", "commit", "pageInfo",
        // Identifier fields that carry structural meaning (SHAs, type discriminators)
        "__typename", "oid", "headRefOid", "baseRefOid", "beforeCommit", "afterCommit",
        // Enum-valued and boolean structural fields
        "state", "reviewType", "mergeable", "mergeStateStatus", "isDraft", "isResolved",
        "hasNextPage",
        // Count/numeric structural fields
        "totalCount", "changedFiles", "additions", "deletions", "number", "line",
        // Path/name fields that describe SHAPE (file paths in diffs, branch names) — these
        // are not personally identifying, they describe the repo structure
        "path", "headRefName", "baseRefName",
        // Cursor — opaque schema-shape, not PII
        "endCursor",
        // Timestamp fields — structural; the differ uses these to assert presence
        "createdAt", "closedAt", "mergedAt", "committedDate", "submittedAt", "lastEditedAt",
    };

    public static JsonNode? Apply(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => StripObject(element),
            JsonValueKind.Array  => StripArray(element),
            JsonValueKind.String => JsonValue.Create(element.GetString()),
            JsonValueKind.Number => JsonNode.Parse(element.GetRawText())!,
            JsonValueKind.True   => JsonValue.Create(true),
            JsonValueKind.False  => JsonValue.Create(false),
            JsonValueKind.Null   => null,
            _ => throw new InvalidOperationException($"Unhandled JsonValueKind {element.ValueKind}"),
        };
    }

    private static JsonObject StripObject(JsonElement obj)
    {
        var result = new JsonObject();
        foreach (var prop in obj.EnumerateObject())
        {
            if (AllowedFieldNames.Contains(prop.Name))
            {
                // Allowed: recurse with stripping still applied at deeper levels.
                result[prop.Name] = Apply(prop.Value);
            }
            else
            {
                // Not allowlisted: preserve the field's presence (so the differ doesn't flag
                // it as removed) but replace its content with null. The shape-drift detector
                // cares about shape, not value.
                result[prop.Name] = null;
            }
        }
        return result;
    }

    private static JsonArray StripArray(JsonElement arr)
    {
        var result = new JsonArray();
        foreach (var item in arr.EnumerateArray())
            result.Add(Apply(item));
        return result;
    }
}
