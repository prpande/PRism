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

    public static JsonObject MigrateV3ToV4(JsonObject root)
    {
        // Additive-only: DraftComment.ThreadId defaults to absent (deserializes to null) on
        // existing entries. No per-session transform needed. The version bump documents the
        // schema change so downstream tooling can scan migrations chronologically (spec § 6).
        root["version"] = 4;
        return root;
    }

    public static JsonObject MigrateV4ToV5(JsonObject root)
    {
        // S6 PR0 — multi-account storage-shape scaffold. Moves reviews / ai-state /
        // last-configured-github-host out from the root and under accounts.default. The
        // single-account v1 runtime continues to behave byte-identically via AppState's
        // delegate read properties; v2 layers additional accounts on top of this shape.
        //
        // Idempotency vs partial-rollback discrimination:
        //   - V5 file passed in by mistake (no root-level reviews/ai-state/last-host): just
        //     bump version and return. Idempotent.
        //   - Partial-rollback / hand-edit (BOTH root-level reviews/ai-state/last-host AND a
        //     pre-existing accounts key): refuse to silently pick one set. Surface as
        //     JsonException so LoadCoreAsync's catch (JsonException) quarantines the file.
        //     Spec § 8.4 calls this out as "must commit a policy"; the safe v1 policy is
        //     "fail loud, quarantine, AppState.Default + re-Setup."
        var hasOrphanRoot = root["reviews"] is not null
                         || root["ai-state"] is not null
                         || root["last-configured-github-host"] is not null;
        if (root["accounts"] is JsonObject && !hasOrphanRoot)
        {
            root["version"] = 5;
            return root;
        }
        if (root["accounts"] is JsonObject && hasOrphanRoot)
        {
            throw new System.Text.Json.JsonException(
                "state.json has both root-level reviews/ai-state/last-configured-github-host AND an existing " +
                "accounts key. This indicates a partial rollback from a future version or a hand-edit gone " +
                "wrong. Quarantining and re-Setup is safer than guessing which set wins.");
        }

        var reviews = root["reviews"];
        var aiState = root["ai-state"];
        var lastHost = root["last-configured-github-host"];

        var defaultAccount = new JsonObject();
        // JsonNode parented values can't be reused as-is — deep-clone so the keys can be moved
        // under accounts.default without leaving torn references behind.
        defaultAccount["reviews"] = reviews?.DeepClone() ?? new JsonObject { ["sessions"] = new JsonObject() };
        defaultAccount["ai-state"] = aiState?.DeepClone() ?? new JsonObject
        {
            ["repo-clone-map"] = new JsonObject(),
            ["workspace-mtime-at-last-enumeration"] = null
        };
        // last-configured-github-host is nullable on the C# side; preserve null as an explicit
        // JSON null so the post-migration shape's deserializer doesn't trip on missing keys.
        // Deliberate: pre-V4 files with the field genuinely ABSENT (vs explicitly null) round-
        // trip to a present-but-null value, NOT a missing key. Always-present keeps the shape
        // uniform across the migrated population — don't "fix" this back to a conditional
        // assignment thinking the missing case should preserve absence.
        defaultAccount["last-configured-github-host"] = lastHost?.DeepClone();

        root.Remove("reviews");
        root.Remove("ai-state");
        root.Remove("last-configured-github-host");

        root["accounts"] = new JsonObject { [AccountKeys.Default] = defaultAccount };
        root["version"] = 5;
        return root;
    }
}
