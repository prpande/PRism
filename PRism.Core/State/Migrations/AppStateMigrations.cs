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

    public static JsonObject MigrateV5ToV6(JsonObject root)
    {
        // Cross-tab stamp poisoning fix — per-tab TabStamps map replaces session-flat
        // last-viewed-head-sha. The migration drops the legacy key and seeds an empty
        // tab-stamps object; the next mark-viewed call from any tab populates it. Spec § 4.
        //
        // Idempotency vs partial-rollback discrimination, mirroring V4→V5:
        //   - V6 file passed in by mistake (sessions already have tab-stamps, no legacy key):
        //     just bump version. Idempotent.
        //   - Partial-rollback / hand-edit (a session has BOTH last-viewed-head-sha AND
        //     tab-stamps): refuse to silently pick one. Surface JsonException → quarantine.
        //
        // Iterates EVERY account's sessions, not just accounts.default. V5 introduced the
        // multi-account container; this migration must respect the same shape even though
        // v1 only writes the default account in practice — a future-version file demoted
        // here would otherwise leak its non-default accounts past the migration.
        if (root["accounts"] is not JsonObject accounts)
        {
            root["version"] = 6;
            return root;
        }

        foreach (var (_, accountNode) in accounts)
        {
            var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
            if (sessions is null) continue;

            foreach (var (_, sessionNode) in sessions)
            {
                if (sessionNode is not JsonObject session) continue;

                var hasLegacy = session["last-viewed-head-sha"] is not null;
                var hasNew = session["tab-stamps"] is JsonObject;

                if (hasLegacy && hasNew)
                    throw new System.Text.Json.JsonException(
                        "state.json session has both legacy last-viewed-head-sha AND a tab-stamps key. " +
                        "This indicates a partial rollback from a future version or a hand-edit gone wrong. " +
                        "Quarantining and re-Setup is safer than guessing which set wins.");

                session.Remove("last-viewed-head-sha");
                if (!hasNew) session["tab-stamps"] = new JsonObject();
            }
        }

        root["version"] = 6;
        return root;
    }

    public static JsonObject MigrateV6ToV7(JsonObject root)
    {
        // PR-root Post + submit-discard slice — lifts the legacy DraftSummaryMarkdown JSON
        // key into a synthesized PR-root DraftComment row (side == "pr", file-path == null).
        // After this migration the dedicated field is removed; the only producer of root-body
        // drafts is the unified DraftComment shape.
        //
        // Iterates every account (V5 multi-account shape), not just default.
        //
        // Two-pass:
        //   1. Scan-only partial-rollback discriminator (precedent: V4→V5, V5→V6). If any
        //      session has BOTH a non-empty draft-summary-markdown AND a PR-root draft
        //      carrying posted-comment-id, throw — that combination indicates a V7+ file
        //      rolled back to V6 then re-upgraded, and the lift would silently merge a body
        //      that was already posted. Quarantine instead of guessing.
        //   2. Lift pass — collapse duplicate PR-root drafts (deterministic by id sort) and
        //      either append the summary onto the surviving draft or synthesize a new one.
        if (root["accounts"] is not JsonObject accounts)
        {
            root["version"] = 7;
            return root;
        }

        // Pass 1: pre-scan only — no mutations.
        foreach (var (accountKey, accountNode) in accounts)
        {
            var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
            if (sessions is null) continue;
            foreach (var (sessionKey, sessionNode) in sessions)
            {
                if (sessionNode is not JsonObject session) continue;
                var summaryNode = session["draft-summary-markdown"];
                var summary = summaryNode is JsonValue sv ? sv.GetValue<string?>() : null;
                if (string.IsNullOrEmpty(summary?.Trim())) continue;
                if (session["draft-comments"] is not JsonArray drafts) continue;
                foreach (var draftNode in drafts)
                {
                    if (draftNode is not JsonObject d) continue;
                    if (d["side"] is not JsonValue sideVal || sideVal.GetValue<string?>() != "pr") continue;
                    if (IsNonNullFilePath($"{accountKey}/{sessionKey}", d["file-path"])) continue;
                    if (d["posted-comment-id"] is JsonValue pcv && pcv.GetValue<long?>() is not null)
                        throw new System.Text.Json.JsonException(
                            $"state.json session {accountKey}/{sessionKey} has draft-summary-markdown set " +
                            "AND a PR-root draft carrying posted-comment-id. Looks like a V7→V6 partial rollback; quarantining.");
                }
            }
        }

        // Pass 2: lift.
        foreach (var (_, accountNode) in accounts)
        {
            var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
            if (sessions is null) continue;
            foreach (var (sessionKey, sessionNode) in sessions)
            {
                if (sessionNode is not JsonObject session) continue;
                LiftSummaryIntoPrRootDraft(sessionKey, session);
            }
        }

        root["version"] = 7;
        return root;
    }

    // PR-root discriminator helper for the V6→V7 file-path check (shared by pass 1 + pass 2).
    //
    //   - file-path missing OR JSON null  → returns false (treated as PR-root; intended behavior,
    //     consistent across both passes).
    //   - file-path is a non-null STRING  → returns true (a file-anchored draft; skip — not PR-root).
    //   - file-path is a non-null, NON-STRING JSON value (e.g. a number from a future/hand-edited
    //     state) → throw JsonException to quarantine, rather than letting GetValue<string?>() throw
    //     the less-actionable InvalidOperationException. Matches the line-~226 draft-comments
    //     shape-check quarantine convention.
    private static bool IsNonNullFilePath(string contextTag, JsonNode? filePathNode)
    {
        if (filePathNode is null) return false; // missing property OR JSON null → PR-root
        if (filePathNode is JsonValue fpv && fpv.GetValueKind() == System.Text.Json.JsonValueKind.String)
            return true;
        throw new System.Text.Json.JsonException(
            $"state.json reviews.sessions['{contextTag}'] PR-root-candidate draft has a non-string file-path (V6→V7); quarantining.");
    }

    private static void LiftSummaryIntoPrRootDraft(string sessionKey, JsonObject session)
    {
        var summaryNode = session["draft-summary-markdown"];
        var summary = summaryNode is JsonValue sv ? sv.GetValue<string?>() : null;
        var trimmed = summary?.Trim() ?? "";

        // Defensive shape check (precedent: PrSessionsMigrations.AddV3DraftCollections:41-43).
        if (session["draft-comments"] is { } draftsNode && draftsNode is not JsonArray)
            throw new System.Text.Json.JsonException(
                $"state.json reviews.sessions['{sessionKey}'].draft-comments must be a JSON array (V6→V7)");

        var drafts = (session["draft-comments"] as JsonArray) ?? new JsonArray();

        // Collect PR-root drafts (side == "pr" AND file-path == null). #324 — this operates on raw
        // JSON pre-deserialization, so it can't call the typed DraftComment.IsPrRoot (FilePath-only).
        // It is a *superset-restriction* of IsPrRoot, not identical: line-number-agnostic (so no
        // both-null over-specification) but additionally gated on side == "pr". The two agree on
        // historical data only because every persisted PR-root row carries side == "pr".
        var prRoots = new List<JsonObject>();
        foreach (var n in drafts)
        {
            if (n is not JsonObject d) continue;
            if (d["side"] is not JsonValue sideVal || sideVal.GetValue<string?>() != "pr") continue;
            if (IsNonNullFilePath(sessionKey, d["file-path"])) continue;
            prRoots.Add(d);
        }

        // Collapse multiples (defensive — composer hydration shadows duplicates today, but a
        // test endpoint or hand-edit could produce them). Deterministic order by id (ordinal).
        // Survivor is the LAST entry in the sorted list; earlier entries get merged into its
        // body with a visible marker so an investigator can trace what was folded.
        if (prRoots.Count > 1)
        {
            prRoots = prRoots.OrderBy(d => d["id"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
            var survivor = prRoots[^1];
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < prRoots.Count - 1; i++)
            {
                var ns = prRoots[i];
                sb.Append("<!-- migrated from previously-shadowed draft ");
                sb.Append(ns["id"]!.GetValue<string>());
                sb.Append(" -->\n\n");
                sb.Append(ns["body-markdown"]?.GetValue<string>() ?? "");
                sb.Append("\n\n");
                drafts.Remove(ns);
            }
            sb.Append(survivor["body-markdown"]?.GetValue<string>() ?? "");
            survivor["body-markdown"] = sb.ToString();
            prRoots = new List<JsonObject> { survivor };
        }

        // Lift summary (if any).
        if (trimmed.Length > 0)
        {
            if (prRoots.Count == 1)
            {
                var existing = prRoots[0]["body-markdown"]?.GetValue<string>() ?? "";
                prRoots[0]["body-markdown"] = existing.Length > 0
                    ? existing + "\n\n" + summary
                    : summary;
            }
            else
            {
                var synthesized = new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString(),
                    ["file-path"] = null,
                    ["line-number"] = null,
                    ["side"] = "pr",
                    ["anchored-sha"] = null,
                    ["anchored-line-content"] = null,
                    ["body-markdown"] = summary,
                    ["status"] = "Draft",
                    ["is-overridden-stale"] = false,
                    ["thread-id"] = null,
                    ["posted-comment-id"] = null,
                    ["posted-body-snapshot"] = null,
                };
                drafts.Add(synthesized);
                session["draft-comments"] = drafts;
            }
        }

        session.Remove("draft-summary-markdown");
    }
}
