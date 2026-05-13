namespace PRism.Core.Auth;

public enum TokenStoreFailure
{
    KeychainLibraryMissing,
    KeychainAgentUnavailable,
    Generic,
    // S6 PR0 — cache file's `version` field is greater than the binary's CurrentVersion.
    // Throwing this also sets TokenStore.IsReadOnlyMode = true so CommitAsync refuses subsequent writes.
    FutureVersionCache,
    // S6 PR0 — cache file is unparseable JSON, missing a usable `version`, or otherwise structurally invalid.
    // The file is preserved (no overwrite); caller surfaces "re-validate at Setup".
    CorruptCache,
}

public sealed class TokenStoreException : Exception
{
    public TokenStoreException() : base() { }
    public TokenStoreException(string message) : base(message) { }
    public TokenStoreException(string message, Exception inner) : base(message, inner) { }
    public TokenStoreException(TokenStoreFailure failure, string message, Exception? inner = null)
        : base(message, inner) { Failure = failure; }
    public TokenStoreFailure Failure { get; }
}
