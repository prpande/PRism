using Microsoft.Identity.Client.Extensions.Msal;
using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PRism.Core.State;

namespace PRism.Core.Auth;

public sealed class TokenStore : ITokenStore
{
    private const string CacheFileName = "PRism.tokens.cache";
    private const string ServiceName = "PRism";
    private const string AccountName = "github-pat";

    // S6 PR0 — versioned JSON map shape: { "version": 1, "tokens": { "default": "<pat>" } }.
    // Bump CurrentVersion when the on-disk shape changes; the load path treats version >
    // CurrentVersion as a downgrade signal (sets IsReadOnlyMode + throws FutureVersionCache).
    private const int CurrentVersion = 1;

    // Real legacy caches (pre-S6-PR0) contain bare PAT bytes written via
    // Encoding.UTF8.GetBytes(_transient). The character class below matches GitHub PAT
    // tokens (classic `ghp_*` + fine-grained `github_pat_*`); the 20-255 length window is
    // wide enough to cover both varieties and any future GitHub PAT format that stays in
    // the base62 + underscore + hyphen alphabet. ce-doc-review caught that the original
    // plan-draft heuristic (`trimmed[0] == '"'`) only fired for hand-edited JSON-quoted
    // caches and left every real legacy user falling through to CorruptCache on first read.
    private static readonly Regex LegacyPatPattern =
        new(@"^[A-Za-z0-9_\-]{20,255}$", RegexOptions.Compiled);

    private readonly string _cacheDir;
    private readonly bool _useFileCacheForTests;
    private MsalCacheHelper? _helper;
    private string? _transient;
    private string? _transientLogin;

    // Parity with AppStateStore.IsReadOnlyMode: once ParseCacheFileBytes detects a future-
    // version cache, every subsequent CommitAsync refuses to write. Without this, the
    // WriteTransient+Commit path during a Setup retry would overwrite a v2 cache with a
    // v1-shape map containing only the "default" entry, silently destroying any v2-added
    // per-account PATs. ce-doc-review security finding 2 promoted this from a P2-deferred
    // risk to a P0-enforced guard.
    private bool _isReadOnlyMode;

    public TokenStore(string dataDir, bool useFileCacheForTests = false)
    {
        _cacheDir = dataDir;
        _useFileCacheForTests = useFileCacheForTests;
    }

    public bool IsReadOnlyMode => _isReadOnlyMode;

    [SuppressMessage("Design", "CA1031:Do not catch general exception types",
        Justification = "Catch-all is intentional: any keychain failure must be mapped to TokenStoreFailure.Generic so callers see a uniform error surface.")]
    private async Task<MsalCacheHelper> GetHelperAsync()
    {
        if (_helper is not null) return _helper;
        try
        {
            var props = new StorageCreationPropertiesBuilder(CacheFileName, _cacheDir);
            if (_useFileCacheForTests)
            {
                // WithUnprotectedFile is mutually exclusive with the Linux/Mac keyring options,
                // so the test path skips them entirely.
                props.WithUnprotectedFile();
            }
            else
            {
                props
                    .WithMacKeyChain(serviceName: ServiceName, accountName: AccountName)
                    .WithLinuxKeyring(
                        schemaName: "com.prism.tokens",
                        collection: MsalCacheHelper.LinuxKeyRingDefaultCollection,
                        secretLabel: "PRism GitHub PAT",
                        attribute1: new KeyValuePair<string, string>("Service", ServiceName),
                        attribute2: new KeyValuePair<string, string>("Account", AccountName));
            }
            _helper = await MsalCacheHelper.CreateAsync(props.Build()).ConfigureAwait(false);
            return _helper;
        }
        catch (DllNotFoundException ex)
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainLibraryMissing,
                "OS keychain library not installed. Install libsecret-1 (apt install libsecret-1-0 / dnf install libsecret), then restart PRism.", ex);
        }
        catch (Exception ex) when (ex.Message.Contains("DBus", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("no provider", StringComparison.OrdinalIgnoreCase))
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainAgentUnavailable,
                "OS keychain library is installed but no keyring agent is running. Start gnome-keyring-daemon or kwalletd, then restart PRism. Common on WSL and minimal sessions.", ex);
        }
        catch (Exception ex)
        {
            throw new TokenStoreException(TokenStoreFailure.Generic,
                $"OS keychain returned an error: {ex.Message}", ex);
        }
    }

    public async Task<bool> HasTokenAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync().ConfigureAwait(false);
        var bytes = helper.LoadUnencryptedTokenCache();
        return bytes.Length > 0;
    }

    public async Task<string?> ReadAsync(CancellationToken ct)
    {
        // Transient takes precedence so PAT validation between WriteTransientAsync and Commit/Rollback
        // sees the candidate token. Without this, the connect endpoint would always validate against null.
        if (_transient is not null) return _transient;
        var helper = await GetHelperAsync().ConfigureAwait(false);
        var bytes = helper.LoadUnencryptedTokenCache();
        if (bytes.Length == 0) return null;

        var raw = Encoding.UTF8.GetString(bytes);
        return ParseCacheFileBytes(raw, helper);
    }

    private string ParseCacheFileBytes(string raw, MsalCacheHelper helper)
    {
        var trimmed = raw.Trim();

        // Branch 2 — Legacy single-PAT blob (the ONLY shape pre-S6-PR0 ever wrote on disk).
        // Two flavors to accept:
        //   (a) bare PAT bytes: `ghp_xxx...` — what the real pre-S6-PR0 binary wrote.
        //   (b) JSON-quoted PAT: `"ghp_xxx..."` — a hand-edited safety net.
        // Either shape: wrap as the versioned map and write back via MSAL (same protection
        // level as CommitAsync — keychain on desktop, WithUnprotectedFile only in test mode).
        JsonNode? parsedFirstPass = null;
        bool isBareLegacyPat = LegacyPatPattern.IsMatch(trimmed);
        if (!isBareLegacyPat)
        {
            try { parsedFirstPass = JsonNode.Parse(raw); }
            catch (JsonException) { /* fall through */ }
        }

        string? legacyPat = null;
        if (isBareLegacyPat)
        {
            legacyPat = trimmed;
        }
        else if (parsedFirstPass is JsonValue jv && jv.TryGetValue<string>(out var quoted) && !string.IsNullOrEmpty(quoted))
        {
            legacyPat = quoted;
        }
        if (legacyPat is not null)
        {
            var migrated = SerializeVersionedMap(legacyPat);
            helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(migrated));
            return legacyPat;
        }

        // Branches 3/4/5 — Versioned-map shape (or future-version, or invalid discriminator).
        // If parsedFirstPass already produced a JsonObject, reuse it; otherwise re-parse so
        // failures map onto CorruptCache.
        JsonNode? root = parsedFirstPass;
        if (root is null)
        {
            try { root = JsonNode.Parse(raw); }
            catch (JsonException ex)
            {
                throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                    "PRism.tokens.cache is unparseable. Re-validate the PAT at Setup.", ex);
            }
        }
        if (root is not JsonObject obj)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache root must be a JSON object. Re-validate the PAT at Setup.");
        }
        var versionNode = obj["version"];
        if (versionNode is null)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache is missing the `version` discriminator. Re-validate the PAT at Setup.");
        }
        int version;
        try
        {
            version = versionNode.GetValue<int>();
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or OverflowException)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache `version` field is not an integer. Re-validate the PAT at Setup.", ex);
        }

        if (version < 1)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache `version` is {version}, which is not a recognized format. Re-validate the PAT at Setup.");
        }
        if (version > CurrentVersion)
        {
            // Branch 4 — future-version. Set read-only flag BEFORE throwing so CommitAsync also
            // refuses (parity with AppStateStore.IsReadOnlyMode). The file is preserved.
            _isReadOnlyMode = true;
            throw new TokenStoreException(TokenStoreFailure.FutureVersionCache,
                "PRism was downgraded; upgrade or wipe PRism.tokens.cache.");
        }

        // Branch 3 — versioned-map at the current version. Pluck the default account's PAT.
        var tokensNode = obj["tokens"];
        if (tokensNode is not JsonObject tokens)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache `tokens` field is missing or not a JSON object. Re-validate the PAT at Setup.");
        }
        var defaultNode = tokens[AccountKeys.Default];
        if (defaultNode is null)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache has no `tokens.{AccountKeys.Default}` entry. Re-validate the PAT at Setup.");
        }

        // Same defensive pattern as the version-discriminator branch above (lines 178-186):
        // a hand-edited or corrupt cache with a non-string `tokens.default` value (e.g.,
        // {"version":1,"tokens":{"default":42}} or {"default":null}) makes
        // `JsonNode.GetValue<string>()` throw `InvalidOperationException`, which would
        // propagate out of ReadAsync rather than surfacing as the documented
        // `TokenStoreException(CorruptCache)`. Map it to the correct contract. Caught by
        // Copilot post-open code review on PR #53.
        string? pat;
        try
        {
            pat = defaultNode.GetValue<string>();
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache `tokens.{AccountKeys.Default}` is not a string. Re-validate the PAT at Setup.", ex);
        }

        if (string.IsNullOrEmpty(pat))
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache `tokens.{AccountKeys.Default}` is empty. Re-validate the PAT at Setup.");
        }
        return pat;
    }

    private static string SerializeVersionedMap(string defaultPat)
    {
        var root = new JsonObject
        {
            ["version"] = CurrentVersion,
            ["tokens"] = new JsonObject
            {
                [AccountKeys.Default] = defaultPat
            }
        };
        return root.ToJsonString();
    }

    public Task WriteTransientAsync(string token, CancellationToken ct)
    {
        _transient = token;
        // Clear any prior login from a previous attempt — the caller will set it after re-validation.
        _transientLogin = null;
        return Task.CompletedTask;
    }

    public Task SetTransientLoginAsync(string login, CancellationToken ct)
    {
        _transientLogin = login;
        return Task.CompletedTask;
    }

    public Task<string?> ReadTransientLoginAsync(CancellationToken ct) => Task.FromResult(_transientLogin);

    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transient is null) throw new InvalidOperationException("No transient token to commit.");

        // Two-layer read-only-mode check:
        //
        // (1) The cached _isReadOnlyMode flag set by a prior ParseCacheFileBytes (via
        //     ReadAsync against the persisted cache, typically from ViewerLoginHydrator
        //     .StartAsync at process startup). This is the fast path.
        //
        // (2) A defensive re-read of the on-disk cache, parsed for version. The Setup
        //     flow calls WriteTransientAsync(pat) FIRST, then ValidateCredentialsAsync →
        //     ReadAsync, which short-circuits on `_transient is not null` and skips
        //     ParseCacheFileBytes entirely. So if Setup is the FIRST code path to touch
        //     the cache (e.g., ViewerLoginHydrator was lazy-loaded, never invoked, or
        //     short-circuited because _loginCache was already populated by an earlier
        //     /api/auth/connect), the persisted future-version cache wouldn't have
        //     been parsed and _isReadOnlyMode would still be false. Without (2), the
        //     SaveUnencryptedTokenCache below would silently overwrite a v2 cache —
        //     exactly the silent-v2-PAT-destruction window the spec § 4.3 read-only
        //     guard is supposed to close. Caught by claude[bot] post-open code review
        //     on PR #53.
        if (_isReadOnlyMode)
        {
            // Once ReadAsync has seen a future-version cache, never overwrite.
            throw new TokenStoreException(TokenStoreFailure.FutureVersionCache,
                "PRism was downgraded and the cache is in read-only mode. " +
                "Upgrade or wipe PRism.tokens.cache before connecting.");
        }

        var helper = await GetHelperAsync().ConfigureAwait(false);

        // Defensive layer (2): re-read the on-disk cache and check its version
        // independently of whether ReadAsync was ever called. Cheap (one disk read,
        // one JsonNode.Parse on a small payload).
        var existingBytes = helper.LoadUnencryptedTokenCache();
        if (existingBytes.Length > 0)
        {
            var existingRaw = Encoding.UTF8.GetString(existingBytes);
            if (TryDetectFutureVersionCache(existingRaw))
            {
                _isReadOnlyMode = true;  // sticky for any subsequent CommitAsync calls
                throw new TokenStoreException(TokenStoreFailure.FutureVersionCache,
                    "PRism was downgraded and the cache is in read-only mode. " +
                    "Upgrade or wipe PRism.tokens.cache before connecting.");
            }
        }

        var payload = SerializeVersionedMap(_transient);
        helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(payload));
        _transient = null;
        _transientLogin = null;
    }

    // Lightweight version probe used by CommitAsync's defensive read-only check. Returns
    // true ONLY if the on-disk bytes parse as `{"version": <int>}` with version >
    // CurrentVersion. Any parse failure / non-object root / missing version / non-integer
    // version / version <= CurrentVersion returns false — those cases either (a) are
    // legitimate caches we can overwrite (versioned at current, or legacy bare PAT) or
    // (b) will surface via the ParseCacheFileBytes path on the next ReadAsync. The probe
    // is intentionally narrower than ParseCacheFileBytes: its only job is to NOT
    // overwrite a cache that's clearly newer than this binary understands.
    private static bool TryDetectFutureVersionCache(string raw)
    {
        var trimmed = raw.Trim();
        if (LegacyPatPattern.IsMatch(trimmed)) return false;  // legacy bare PAT — not future
        try
        {
            if (JsonNode.Parse(raw) is JsonObject obj
                && obj["version"] is JsonNode versionNode
                && versionNode.GetValue<int>() > CurrentVersion)
            {
                return true;
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException or OverflowException)
        {
            // Any parse failure → not a recognizable future-version shape; let the
            // existing ParseCacheFileBytes path classify it on next ReadAsync.
        }
        return false;
    }

    public Task RollbackTransientAsync(CancellationToken ct)
    {
        _transient = null;
        _transientLogin = null;
        return Task.CompletedTask;
    }

    public async Task ClearAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync().ConfigureAwait(false);
        // MsalCacheHelper.Clear is obsoleted to discourage MSAL apps from blowing away an account
        // cache — but PRism stores a single opaque PAT (not MSAL accounts), so deleting the
        // persisted blob is the intended operation.
#pragma warning disable CS0618 // Type or member is obsolete
        helper.Clear();
#pragma warning restore CS0618
    }
}
