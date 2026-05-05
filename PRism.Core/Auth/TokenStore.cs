using Microsoft.Identity.Client.Extensions.Msal;
using System.Diagnostics.CodeAnalysis;
using System.Text;

namespace PRism.Core.Auth;

public sealed class TokenStore : ITokenStore
{
    private const string CacheFileName = "PRism.tokens.cache";
    private const string ServiceName = "PRism";
    private const string AccountName = "github-pat";

    private readonly string _cacheDir;
    private readonly bool _useFileCacheForTests;
    private MsalCacheHelper? _helper;
    private string? _transient;

    public TokenStore(string dataDir, bool useFileCacheForTests = false)
    {
        _cacheDir = dataDir;
        _useFileCacheForTests = useFileCacheForTests;
    }

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
        var helper = await GetHelperAsync().ConfigureAwait(false);
        var bytes = helper.LoadUnencryptedTokenCache();
        return bytes.Length == 0 ? null : Encoding.UTF8.GetString(bytes);
    }

    public Task WriteTransientAsync(string token, CancellationToken ct)
    {
        _transient = token;
        return Task.CompletedTask;
    }

    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transient is null) throw new InvalidOperationException("No transient token to commit.");
        var helper = await GetHelperAsync().ConfigureAwait(false);
        helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(_transient));
        _transient = null;
    }

    public Task RollbackTransientAsync(CancellationToken ct)
    {
        _transient = null;
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
