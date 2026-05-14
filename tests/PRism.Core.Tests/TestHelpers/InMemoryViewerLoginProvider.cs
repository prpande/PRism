using PRism.Core.Auth;

namespace PRism.Core.Tests.TestHelpers;

// Hydrator/auth-flow tests assume FSW + ConfigStore.Changed subscribers are
// idempotent (the production-side AiPreviewState subscriber is). If a future
// test exercises a non-idempotent subscriber, the tests using this provider
// + ConfigStore will need a Task.Delay drain between writes and assertions
// (see ConfigStoreMigrationTests.SetDefaultAccountLoginAsync_concurrent_with
// _PatchAsync_preserves_both_writes for the established pattern).
internal sealed class InMemoryViewerLoginProvider : IViewerLoginProvider
{
    private string _login = string.Empty;
    public string Get() => _login;
    public void Set(string login) => _login = login;
}
