using System.Text.Json.Nodes;

namespace PRism.Core.State.Migrations;

internal static class AppStateMigrations
{
    public static JsonObject MigrateV1ToV2(JsonObject root)
    {
        var sessionsNode = root["review-sessions"];
        if (sessionsNode is not null)
        {
            if (sessionsNode is not JsonObject sessions)
                throw new System.Text.Json.JsonException(
                    "state.json 'review-sessions' must be a JSON object");

            foreach (var sessionEntry in sessions)
            {
                if (sessionEntry.Value is JsonObject obj && obj["viewed-files"] is null)
                    obj["viewed-files"] = new JsonObject();
            }
        }
        root["version"] = 2;
        return root;
    }

    public static JsonObject MigrateV2ToV3(JsonObject root)
    {
        PrSessionsMigrations.RenameReviewSessionsToReviews(root);
        PrSessionsMigrations.AddV3DraftCollections(root);
        root["version"] = 3;
        return root;
    }
}
