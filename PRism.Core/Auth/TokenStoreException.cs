namespace PRism.Core.Auth;

public enum TokenStoreFailure
{
    KeychainLibraryMissing,
    KeychainAgentUnavailable,
    Generic,
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
