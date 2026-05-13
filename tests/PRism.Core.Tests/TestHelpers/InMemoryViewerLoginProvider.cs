using PRism.Core.Auth;

namespace PRism.Core.Tests.TestHelpers;

internal sealed class InMemoryViewerLoginProvider : IViewerLoginProvider
{
    private string _login = string.Empty;
    public string Get() => _login;
    public void Set(string login) => _login = login;
}
