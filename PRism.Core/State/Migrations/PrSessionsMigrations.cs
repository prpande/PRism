using System.Text.Json;
using System.Text.Json.Nodes;

namespace PRism.Core.State.Migrations;

internal static class PrSessionsMigrations
{
    public static void RenameReviewSessionsToReviews(JsonObject root)
    {
        // Idempotent: skip if already renamed (half-migrated v3 file from a crashed write).
        if (root["reviews"] is not null) return;

        var sessionsNode = root["review-sessions"];
        if (sessionsNode is null)
        {
            // Materialize an empty wrap so the deserializer doesn't choke on a missing field.
            root["reviews"] = new JsonObject { ["sessions"] = new JsonObject() };
            return;
        }

        if (sessionsNode is not JsonObject sessionsObj)
            throw new JsonException("state.json 'review-sessions' must be a JSON object");

        // Detach so we can re-attach under the new parent.
        root.Remove("review-sessions");
        // sessionsObj was detached by Remove() so we can hand it directly to the new parent.
        root["reviews"] = new JsonObject { ["sessions"] = sessionsObj };
    }

    public static void AddV3DraftCollections(JsonObject root)
    {
        var sessions = root["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) return;

        foreach (var entry in sessions)
        {
            if (entry.Value is not JsonObject sessionObj) continue;

            if (sessionObj["draft-comments"] is null)
                sessionObj["draft-comments"] = new JsonArray();
            else if (sessionObj["draft-comments"] is not JsonArray)
                throw new JsonException(
                    $"state.json reviews.sessions['{entry.Key}'].draft-comments must be a JSON array");

            if (sessionObj["draft-replies"] is null)
                sessionObj["draft-replies"] = new JsonArray();
            else if (sessionObj["draft-replies"] is not JsonArray)
                throw new JsonException(
                    $"state.json reviews.sessions['{entry.Key}'].draft-replies must be a JSON array");

            if (sessionObj["draft-summary-markdown"] is null)
                sessionObj["draft-summary-markdown"] = JsonValue.Create((string?)null);

            if (sessionObj["draft-verdict"] is null)
                sessionObj["draft-verdict"] = JsonValue.Create((string?)null);

            if (sessionObj["draft-verdict-status"] is null)
                sessionObj["draft-verdict-status"] = "draft";
        }

        NormalizeSessionKeysToSlashForm(sessions);
    }

    private static void NormalizeSessionKeysToSlashForm(JsonObject sessions)
    {
        // Two-pass: collect all '#' keys, then rewrite. Avoids modifying the dict while iterating.
        var hashKeys = new List<string>();
        foreach (var entry in sessions)
        {
            if (entry.Key.Contains('#', StringComparison.Ordinal)) hashKeys.Add(entry.Key);
        }

        foreach (var hashKey in hashKeys)
        {
            var slashKey = hashKey.Replace('#', '/');
            // Collision policy: slash-form wins; drop the # entry (its bookkeeping will be
            // repopulated on the next inbox poll).
            if (sessions.ContainsKey(slashKey))
            {
                sessions.Remove(hashKey);
                continue;
            }

            var value = sessions[hashKey];
            sessions.Remove(hashKey);
            sessions[slashKey] = value?.DeepClone();
        }
    }
}
