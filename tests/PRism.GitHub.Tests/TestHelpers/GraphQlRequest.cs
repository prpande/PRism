namespace PRism.GitHub.Tests.TestHelpers;

// Shared helper for GraphQL request-body assertions: extracts the `query` field from a captured
// POST body (`{"query":"…","variables":{}}`). Used by the batch-reader byte-identity goldens and
// the GitHubGraphQL.RunAliasedBatchAsync dispatcher tests.
internal static class GraphQlRequest
{
    internal static string QueryOf(string? requestBody)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(requestBody!);
        return doc.RootElement.GetProperty("query").GetString()!;
    }
}
