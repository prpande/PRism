using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.Ai;
using PRism.Core.Json;
using PRism.Core.State;
using PRism.Core.Storage;

namespace PRism.Core.Config;

public sealed class ConfigStore : IConfigStore, IDisposable
{
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private FileSystemWatcher? _watcher;
    private AppConfig _current = AppConfig.Default;
    // Allowlist + expected-type table for PatchAsync. The bare `theme` / `accent` / `aiPreview`
    // / `density` keys are the legacy S0+S1 wire shape (under `ui.*` in config.json but flat
    // on the wire); preserved for back-compat with the existing POST /api/preferences
    // single-field contract. `density` was added in PR9b alongside the same UiConfig sub-record.
    // `contentScale` was added in #135 alongside UiConfig.ContentScale, following the same bare-`ui.*`-key pattern.
    // The dotted-path `inbox.sections.*` keys (S6 PR1) map onto InboxSectionsConfig in
    // AppConfig.cs — canonical section set documented in docs/spec/03-poc-features.md § 11.
    //
    // The expected-type table is the SOURCE OF TRUTH for the allowlist — if a key is here, it
    // is allowed; otherwise it is rejected. Per-key type validation runs before the switch
    // arms so a malformed payload (e.g., `{ "aiPreview": "true" }` from a misbehaving client,
    // or PreferencesEndpoints' default-null fallback on numbers/objects/arrays) produces a
    // clean ConfigPatchException → 400 from the endpoint, NOT an InvalidCastException → 500
    // (the old `(string)value!` path) or a silent `Convert.ToBoolean(null) == false` flip
    // (the old `Convert.ToBoolean` path). Caught by Copilot review on PR #69.
    private enum ConfigFieldType { String, Bool, Int }

    private static readonly Dictionary<string, ConfigFieldType> _allowedFields =
        new(StringComparer.Ordinal)
        {
            ["theme"]                            = ConfigFieldType.String,
            ["accent"]                           = ConfigFieldType.String,
            ["aiPreview"]                        = ConfigFieldType.Bool,    // legacy FE toggle — translated to ui.ai.mode below
            ["ui.ai.mode"]                       = ConfigFieldType.String,  // tri-state (off|preview|live)
            ["density"]                          = ConfigFieldType.String,
            ["contentScale"]                     = ConfigFieldType.String,
            ["inbox.sections.review-requested"]  = ConfigFieldType.Bool,
            ["inbox.sections.awaiting-author"]   = ConfigFieldType.Bool,
            ["inbox.sections.authored-by-me"]    = ConfigFieldType.Bool,
            ["inbox.sections.mentioned"]         = ConfigFieldType.Bool,
            ["inbox.sections.recently-closed"]   = ConfigFieldType.Bool,
            ["inbox.defaultSort"]                = ConfigFieldType.String,
            ["inbox.sectionOrder"]               = ConfigFieldType.String,
            // #137 additive activity-rail extra bot logins (comma-separated, free-form —
            // no permutation constraint, unlike sectionOrder). Config/API-configurable;
            // Settings UI deferred to #316. Apply-switch arm lives in PatchAsync below.
            ["inbox.knownBots"]                  = ConfigFieldType.String,
            // #283 dedicated non-AI flag gating the activity rail (default OFF). #137 wired
            // the rail to real /api/activity data + a Settings toggle. Apply-switch arm below.
            ["inbox.showActivityRail"]           = ConfigFieldType.Bool,
            // #219 toggle: group the Inbox by repo (default) vs flat. Apply-switch arm below.
            ["inbox.groupByRepo"]                = ConfigFieldType.Bool,
            // #496 AI Settings tab — user-configurable numeric knobs. Clamped on write
            // (AiConfigBounds) in the apply switch below; surfaced + read-clamped in PRism.Web.
            ["ui.ai.providerTimeoutSeconds"]     = ConfigFieldType.Int,
            ["ui.ai.hunkAnnotationCap"]          = ConfigFieldType.Int,
            // #525 best-effort summary character cap. Clamped on write (AiConfigBounds.ClampSummaryChars)
            // in the apply switch below; surfaced + read-clamped in PRism.Web and fed hot into the summarizer.
            ["ui.ai.summaryMaxChars"]            = ConfigFieldType.Int,
            // #485 UX-suppression flag for the first-run AI onboarding overlay. Set once by the FE
            // after the user dismisses the dialog; never read by any AI seam or egress gate.
            ["ui.ai.onboardingSeen"]             = ConfigFieldType.Bool,
        };

    // #262 PR3: inbox.defaultSort is a string-typed key with a CLOSED value set (unlike
    // theme/accent/density, which accept any string — Deviation 6). The pre-gate validation
    // below rejects an out-of-set value with a ConfigPatchException so the endpoint returns
    // 400 rather than persisting a sort the frontend can't render.
    private static readonly HashSet<string> _allowedSorts =
        new(StringComparer.Ordinal) { "updated", "pushed", "diff", "comments" };

    // #275: inbox.sectionOrder is a string-typed key whose value must be a permutation
    // of exactly these four work-section ids (recently-closed is pinned in the frontend
    // and never part of the persisted order). Validated BEFORE the gate so a malformed
    // value returns 400, not a persisted order the frontend can't render coherently.
    // Keep in sync with the frontend SSOT CANONICAL_WORK_ORDER in
    // frontend/src/components/Inbox/sectionOrder.ts — if a 5th work section is ever
    // added it must be added in both places (and the default in AppConfig.SectionOrder).
    private static readonly string[] _workSectionIds =
        { "review-requested", "awaiting-author", "authored-by-me", "mentioned" };

    public ConfigStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "config.json");
    }

    public AppConfig Current => _current;
    public string ConfigPath => _path;
    public Exception? LastLoadError { get; private set; }
    public event EventHandler<ConfigChangedEventArgs>? Changed;

    private void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(_current));

    public async Task InitAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ReadFromDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        TryStartWatcher();
    }

    public async Task SetDefaultAccountLoginAsync(string login, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(login);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var accounts = _current.Github.Accounts.ToList();
            if (accounts.Count == 0)
            {
                // Defensive: a misshapen config that somehow reached this point gets a fresh
                // default-account entry rather than tripping IndexOutOfRange. The on-disk write
                // below persists the seeded shape.
                accounts.Add(new GithubAccountConfig(
                    Id: AccountKeys.Default,
                    Host: AppConfig.Default.Github.Host,
                    Login: login,
                    LocalWorkspace: null));
            }
            else
            {
                accounts[0] = accounts[0] with { Login = login };
            }
            _current = _current with { Github = new GithubConfig(accounts) };
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        RaiseChanged();
    }

    public async Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(providerId);
        ArgumentException.ThrowIfNullOrEmpty(disclosureVersion);

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ai = _current.Ui.Ai with
            {
                Consent = new AiConsentConfig(providerId, disclosureVersion, DateTimeOffset.UtcNow),
            };
            _current = _current with { Ui = _current.Ui with { Ai = ai } };
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        RaiseChanged();
    }

    public async Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(patch);
        if (patch.Count != 1)
            throw new ConfigPatchException("patch must contain exactly one field");
        var (key, value) = patch.Single();
        if (!_allowedFields.TryGetValue(key, out var expectedType))
            throw new ConfigPatchException($"unknown field: {key}");

        // Per-key type validation BEFORE the gate so a malformed payload returns 400
        // (via the endpoint's existing ConfigPatchException → BadRequest mapping) rather
        // than crashing in the cast / silently flipping a bool. Two value shapes are
        // rejected for boolean fields: null (the endpoint's fallback for unsupported
        // JsonValueKinds) and any non-bool primitive. For string fields, null and any
        // non-string primitive are rejected. Caught by Copilot review on PR #69.
        switch (expectedType)
        {
            case ConfigFieldType.String when value is not string:
                throw new ConfigPatchException(
                    $"field '{key}' expects a string value (got {DescribeValue(value)})");
            case ConfigFieldType.Bool when value is not bool:
                throw new ConfigPatchException(
                    $"field '{key}' expects a bool value (got {DescribeValue(value)})");
            case ConfigFieldType.Int when value is not int:
                throw new ConfigPatchException(
                    $"field '{key}' expects an integer value (got {DescribeValue(value)})");
        }

        // Closed-set value validation BEFORE the gate (mirrors the per-key type check above).
        // The switch already guaranteed `value is string` for inbox.defaultSort, so the cast
        // is safe. Reject an unknown sort with a clear message naming the field. (#262 PR3.)
        if (key == "inbox.defaultSort" && !_allowedSorts.Contains((string)value!))
            throw new ConfigPatchException(
                $"field 'inbox.defaultSort' expects one of updated|pushed|diff|comments (got '{(string)value!}')");

        if (key == "inbox.sectionOrder")
        {
            // TrimEntries (tolerate surrounding spaces) but NOT RemoveEmptyEntries:
            // an empty segment from a trailing/leading/double comma must survive so the
            // count check rejects it. Dropping empties would silently accept (and persist)
            // a malformed string like "a,b,c,d," — violating strict-write. (Copilot PR #303.)
            var ids = ((string)value!).Split(',', StringSplitOptions.TrimEntries);
            var ordered = new HashSet<string>(ids, StringComparer.Ordinal);
            if (ids.Length != _workSectionIds.Length
                || ordered.Count != ids.Length
                || !_workSectionIds.All(ordered.Contains))
            {
                throw new ConfigPatchException(
                    "field 'inbox.sectionOrder' expects a comma-separated permutation of the four " +
                    "work-section ids (review-requested, awaiting-author, authored-by-me, mentioned)");
            }
        }

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ui = _current.Ui;
            var sections = _current.Inbox.Sections;
            _current = key switch
            {
                "theme"     => _current with { Ui = ui with { Theme  = (string)value! } },
                "accent"    => _current with { Ui = ui with { Accent = (string)value! } },
                "aiPreview"  => _current with { Ui = ui with { Ai = ui.Ai with { Mode = (bool)value! ? AiMode.Preview : AiMode.Off } } },
                "ui.ai.mode" => _current with { Ui = ui with { Ai = ui.Ai with { Mode = ParseAiMode((string)value!) } } },
                "density"   => _current with { Ui = ui with { Density = (string)value! } },
                "contentScale" => _current with { Ui = ui with { ContentScale = (string)value! } },
                "inbox.sections.review-requested" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { ReviewRequested = (bool)value! } } },
                "inbox.sections.awaiting-author" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { AwaitingAuthor  = (bool)value! } } },
                "inbox.sections.authored-by-me" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { AuthoredByMe    = (bool)value! } } },
                "inbox.sections.mentioned" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { Mentioned       = (bool)value! } } },
                "inbox.sections.recently-closed" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { RecentlyClosed  = (bool)value! } } },
                "inbox.defaultSort" =>
                    _current with { Inbox = _current.Inbox with { DefaultSort = (string)value! } },
                "inbox.sectionOrder" =>
                    _current with { Inbox = _current.Inbox with { SectionOrder = (string)value! } },
                "inbox.knownBots" =>
                    _current with { Inbox = _current.Inbox with { KnownBots = ((string?)value ?? "").Trim() } },
                "inbox.showActivityRail" =>
                    _current with { Inbox = _current.Inbox with { ShowActivityRail = (bool)value! } },
                "inbox.groupByRepo" =>
                    _current with { Inbox = _current.Inbox with { GroupByRepo = (bool)value! } },
                "ui.ai.providerTimeoutSeconds" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { ProviderTimeoutSeconds = AiConfigBounds.ClampTimeout((int)value!) } } },
                "ui.ai.hunkAnnotationCap" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { HunkAnnotationCap = AiConfigBounds.ClampCap((int)value!) } } },
                "ui.ai.summaryMaxChars" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { SummaryMaxChars = AiConfigBounds.ClampSummaryChars((int)value!) } } },
                "ui.ai.onboardingSeen" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { OnboardingSeen = (bool)value! } } },
                _ => throw new ConfigPatchException($"unknown field: {key}")
            };
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        RaiseChanged();
    }

    // Format the rejected value's type for the ConfigPatchException message. Used by
    // PatchAsync's per-key type-validation block — the message reaches the caller via
    // the endpoint's BadRequest mapping, so keep it short and free of secret material
    // (we only describe the type, never the value contents).
    private static string DescribeValue(object? value) => value switch
    {
        null      => "null",
        string    => "string",
        bool      => "bool",
        var other => other.GetType().Name,
    };

    // Parse the `ui.ai.mode` string patch value into AiMode. An unknown value throws
    // ConfigPatchException (→ 400 via the endpoint mapping). Deliberately does NOT echo the
    // user-supplied `value` in the message — matches DescribeValue's redaction discipline.
    // Uses OrdinalIgnoreCase comparison rather than `value.ToLowerInvariant() switch` because
    // CA1308 (analyzers AllEnabledByDefault + TWAE) rejects ToLowerInvariant for normalization;
    // OrdinalIgnoreCase is the codebase's string-comparison idiom (e.g. ActivePrPoller,
    // SubmitPipeline) and is case-insensitive without allocating a lowercased string. The
    // hardcoded off/preview/live strings stay in lockstep with the on-disk kebab serialization
    // only while AiMode members remain single words (kebab == lowercase); a future multi-word
    // member (e.g. "live-read-only") must match KebabCaseJsonNamingPolicy here and the wire projection.
    private static AiMode ParseAiMode(string value)
    {
        if (string.Equals(value, "off", StringComparison.OrdinalIgnoreCase))
            return AiMode.Off;
        if (string.Equals(value, "preview", StringComparison.OrdinalIgnoreCase))
            return AiMode.Preview;
        if (string.Equals(value, "live", StringComparison.OrdinalIgnoreCase))
            return AiMode.Live;
        throw new ConfigPatchException("ui.ai.mode must be one of: off, preview, live.");  // do NOT echo `value`
    }

    private async Task ReadFromDiskAsync(CancellationToken ct)
    {
        if (!File.Exists(_path))
        {
            _current = AppConfig.Default;
            await WriteToDiskAsync(ct).ConfigureAwait(false);
            LastLoadError = null;
            return;
        }
        try
        {
            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

            // S6 PR0 — legacy-shape rewrite. If the on-disk config still has the pre-S6 shape
            // (`github.host` / `github.local-workspace` directly under github, no accounts list),
            // rewrite it to the new accounts shape before deserialization. This is a JsonNode-
            // level rewrite (no strongly-typed AppConfig allocated yet) so we can rewrite without
            // tripping the new GithubConfig constructor mismatch. The atomic-rename write below
            // ensures partial writes can't leave the file with both shapes.
            var rootNode = JsonNode.Parse(raw, documentOptions: new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip
            });
            // Defensive type-checked legacy-shape extraction. The original draft used
            // `hostNode.GetValue<string>()` directly, which throws InvalidOperationException
            // on type mismatch (e.g., a hand-edited `"host": 42` or `"local-workspace": []`).
            // The catch below covers only JsonException / IOException / UnauthorizedAccess
            // Exception, so an InvalidOperationException would escape ReadFromDiskAsync /
            // InitAsync and crash startup. Pre-S6 deserialization raised JsonException for
            // the same mistyped values and was absorbed into LastLoadError; the migration
            // shim must preserve that startup-doesn't-crash invariant. Solution: extract
            // both fields via TryGetValue<string>; on type mismatch, skip the rewrite and
            // let the strongly-typed Deserialize below surface the shape through the
            // existing JsonException catch. Caught by Copilot post-open code review (PR #53).
            bool rewritten = TryRewriteLegacyGithubShape(rootNode);
            rewritten |= TryRewriteLegacyAiPreviewShape(rootNode);
            if (rewritten)
            {
                raw = rootNode!.ToJsonString();
            }

            var parsed = JsonSerializer.Deserialize<AppConfig>(raw, JsonSerializerOptionsFactory.Storage);
            if (parsed is null)
            {
                _current = AppConfig.Default;
                LastLoadError = null;
                return;
            }

            // Backfill any sub-record that's null on disk. Older config.json files (or
            // partial configs in tests) can lack entire top-level sections; without these
            // guards, a positional record's missing constructor argument deserializes to
            // null and DI factories that read e.g. config.Current.Ui.AiPreview throw.
            // The Inbox guard has an extra level: legacy S0+S1 files have the inbox key but
            // lack inbox.sections / inbox.deduplicate, so Sections can be null even when
            // Inbox itself is present — in that case preserve ShowHiddenScopeFooter.
            parsed = parsed with
            {
                Polling    = parsed.Polling    ?? AppConfig.Default.Polling,
                Inbox      = parsed.Inbox is null
                                ? AppConfig.Default.Inbox
                                : parsed.Inbox.Sections is null
                                    ? AppConfig.Default.Inbox with { ShowHiddenScopeFooter = parsed.Inbox.ShowHiddenScopeFooter }
                                    : parsed.Inbox,
                Review     = parsed.Review     ?? AppConfig.Default.Review,
                Iterations = parsed.Iterations ?? AppConfig.Default.Iterations,
                Logging    = parsed.Logging    ?? AppConfig.Default.Logging,
                Ui         = parsed.Ui         ?? AppConfig.Default.Ui,
                Github     = parsed.Github     ?? AppConfig.Default.Github,
                Llm        = parsed.Llm        ?? AppConfig.Default.Llm,
            };

            // Defensive: a partial on-disk shape with `github: {}` deserializes to a
            // GithubConfig with a null/empty Accounts list. Backfill the default-account entry
            // so the delegate property `config.Github.Host` doesn't NRE/IndexOutOfRange on
            // `Accounts[0]`. Symmetric to the per-sub-record null backfill above; the only
            // reason it's separate is the check is on a nested property, not the sub-record itself.
            if (parsed.Github.Accounts is null || parsed.Github.Accounts.Count == 0)
            {
                parsed = parsed with { Github = AppConfig.Default.Github };
            }

            // Nested backfill: a legacy `ui.ai` with `mode` only (post-PR2 shape) deserializes
            // Consent/Features to null. The AiConsentState/AiFeatureState DI seeds read them, so
            // backfill defaults. Symmetric to the Inbox.Sections nested backfill above.
            if (parsed.Ui.Ai is null)
            {
                parsed = parsed with { Ui = parsed.Ui with { Ai = AppConfig.Default.Ui.Ai } };
            }
            else
            {
                var ai = parsed.Ui.Ai;
                if (ai.Consent is null || ai.Features is null)
                {
                    parsed = parsed with { Ui = parsed.Ui with { Ai = ai with
                    {
                        Consent  = ai.Consent  ?? AppConfig.Default.Ui.Ai.Consent,
                        Features = ai.Features ?? AppConfig.Default.Ui.Ai.Features,
                    } } };
                }
            }

            _current = parsed;
            LastLoadError = null;

            // If we rewrote the legacy shape, persist the new shape to disk so subsequent loads
            // skip the rewrite path. Atomic-rename via WriteToDiskAsync.
            if (rewritten)
            {
                await WriteToDiskAsync(ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            LastLoadError = ex;
            _current = AppConfig.Default;
            // do NOT overwrite the broken file
        }
    }

    private async Task WriteToDiskAsync(CancellationToken ct)
    {
        var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(_current, JsonSerializerOptionsFactory.Storage);
        await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
        await AtomicFileMove.MoveAsync(temp, _path, ct).ConfigureAwait(false);
    }

    // Legacy-shape detection for pre-S6 configs (`github.host` / `github.local-workspace`
    // directly under `github`, no `accounts` list). Three outcomes:
    //   - No match (already V5, no `host` key, structurally different): return false,
    //     tree untouched.
    //   - Match with valid string types: rewrite tree in place, return true.
    //   - Match-shape but type mismatch (host or local-workspace present but not a string,
    //     e.g., a hand-edited `"host": 42`): throw JsonException. The caller's catch
    //     clause records it into LastLoadError and falls back to AppConfig.Default —
    //     same surface as pre-S6 deserialization for the same corruption. Without this
    //     the original `hostNode.GetValue<string>()` would have thrown
    //     InvalidOperationException, which the catch does NOT cover, escaping startup.
    //     Caught by Copilot post-open code review (PR #53).
    private static bool TryRewriteLegacyGithubShape(JsonNode? rootNode)
    {
        if (rootNode is not JsonObject rootObj
            || rootObj["github"] is not JsonObject github
            || github["accounts"] is not null
            || github["host"] is null)
        {
            return false;
        }

        // host present but non-string → this is a legacy-shape config (host key exists at
        // the github level) with a malformed value. Surface as JsonException — same error
        // class pre-S6 deserialization would have raised for the same payload.
        if (github["host"] is not JsonValue hostValue
            || !hostValue.TryGetValue<string>(out var host))
        {
            throw new JsonException(
                "config.json `github.host` must be a string when no `accounts` list is present " +
                "(legacy single-host shape).");
        }

        // local-workspace is optional. Missing key → null. Present key with non-string
        // type → JsonException (same rationale as above). Present string → use it.
        string? localWorkspace = null;
        var localWorkspaceNode = github["local-workspace"];
        if (localWorkspaceNode is not null)
        {
            if (localWorkspaceNode is not JsonValue localValue
                || !localValue.TryGetValue<string>(out var lw))
            {
                throw new JsonException(
                    "config.json `github.local-workspace` must be a string or null when no " +
                    "`accounts` list is present (legacy single-host shape).");
            }
            localWorkspace = lw;
        }

        var account = new JsonObject
        {
            ["id"] = AccountKeys.Default,
            ["host"] = host,
            ["login"] = null,
            ["local-workspace"] = localWorkspace,
        };
        github.Remove("host");
        github.Remove("local-workspace");
        github["accounts"] = new JsonArray(account);
        return true;
    }

    /// <summary>
    /// Migrates the pre-v2 <c>ui.ai-preview</c> (bool) into the v2 <c>ui.ai.mode</c> nested shape
    /// (true → "preview", false → "off"). Defensive per PR #53: a non-bool value is left untouched
    /// so Deserialize/backfill handles it (never throws InvalidOperationException out of the catch).
    /// Returns true if it rewrote the node (caller persists back).
    /// </summary>
    private static bool TryRewriteLegacyAiPreviewShape(JsonNode? rootNode)
    {
        if (rootNode is not JsonObject root) return false;
        if (root["ui"] is not JsonObject ui) return false;
        if (ui["ai-preview"] is not JsonValue legacy) return false;
        if (ui["ai"] is JsonObject already && already["mode"] is JsonValue modeVal && modeVal.TryGetValue<string>(out _)) { ui.Remove("ai-preview"); return true; } // already migrated (has a real STRING mode); drop the stale key. A non-string mode (e.g. 42/null) is NOT "migrated" — fall through and rebuild from the legacy bool so ai-preview intent survives (PR #242 review).
        if (!legacy.TryGetValue<bool>(out var on)) return false;             // non-bool → leave for the Default fallback
        // A present-but-incomplete ui["ai"] — a malformed non-object (e.g. a JSON string) OR an empty/mode-less object
        // ({}) — is NOT short-circuited above; it falls through to the overwrite below and is rebuilt from the legacy
        // bool, so a corrupt OR empty `ai` value cannot silently discard the user's ai-preview intent
        // (ce-doc-review rounds 1+2, adversarial edge cases). The round-1 `is JsonObject` check missed the empty-{} case.

        ui["ai"] = new JsonObject { ["mode"] = on ? "preview" : "off" };
        ui.Remove("ai-preview");
        return true;
    }

    private void TryStartWatcher()
    {
        try
        {
            var dir = Path.GetDirectoryName(_path)!;
            _watcher = new FileSystemWatcher(dir, "config.json")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = true
            };
            _watcher.Changed += OnFileChanged;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            // FSW failed to register; degrade silently — mtime-poll fallback intentionally out of S0+S1.
            LastLoadError = ex;
        }
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e)
    {
        // Fire-and-forget reload; exceptions are swallowed inside HandleFileChangedAsync.
        _ = HandleFileChangedAsync();
    }

    private async Task HandleFileChangedAsync()
    {
        try
        {
            await Task.Delay(100).ConfigureAwait(false); // debounce save flurry
            await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                await ReadFromDiskAsync(CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
            RaiseChanged();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ObjectDisposedException)
        {
            LastLoadError = ex;
        }
    }

    public void Dispose()
    {
        if (_watcher is not null)
        {
            _watcher.Changed -= OnFileChanged;
            _watcher.Dispose();
        }
        _gate.Dispose();
    }
}
