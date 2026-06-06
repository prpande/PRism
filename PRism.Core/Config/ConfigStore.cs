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
    private enum ConfigFieldType { String, Bool }

    private static readonly Dictionary<string, ConfigFieldType> _allowedFields =
        new(StringComparer.Ordinal)
        {
            ["theme"]                            = ConfigFieldType.String,
            ["accent"]                           = ConfigFieldType.String,
            ["aiPreview"]                        = ConfigFieldType.Bool,    // legacy FE toggle — translated to ui.ai.mode below
            ["ui.ai.mode"]                       = ConfigFieldType.String,  // tri-state (off|preview|live)
            ["density"]                          = ConfigFieldType.String,
            ["inbox.sections.review-requested"]  = ConfigFieldType.Bool,
            ["inbox.sections.awaiting-author"]   = ConfigFieldType.Bool,
            ["inbox.sections.authored-by-me"]    = ConfigFieldType.Bool,
            ["inbox.sections.mentioned"]         = ConfigFieldType.Bool,
            ["inbox.sections.ci-failing"]        = ConfigFieldType.Bool,
            ["inbox.sections.recently-closed"]   = ConfigFieldType.Bool,
        };

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
                "inbox.sections.review-requested" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { ReviewRequested = (bool)value! } } },
                "inbox.sections.awaiting-author" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { AwaitingAuthor  = (bool)value! } } },
                "inbox.sections.authored-by-me" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { AuthoredByMe    = (bool)value! } } },
                "inbox.sections.mentioned" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { Mentioned       = (bool)value! } } },
                "inbox.sections.ci-failing" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { CiFailing       = (bool)value! } } },
                "inbox.sections.recently-closed" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { RecentlyClosed  = (bool)value! } } },
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

            // Nested backfill: an old config with `ui` present but no `ai` key deserializes
            // Ui.Ai to null. The AiPreviewState DI seed reads Ui.Ai.Mode, so without this
            // guard a legacy config would NRE at startup. Symmetric to the Inbox.Sections
            // backfill above; the check is on a nested property, not the sub-record itself.
            if (parsed.Ui.Ai is null)
            {
                parsed = parsed with { Ui = parsed.Ui with { Ai = AppConfig.Default.Ui.Ai } };
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
