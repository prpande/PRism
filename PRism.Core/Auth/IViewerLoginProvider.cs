using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Auth;

[SuppressMessage("Naming", "CA1716:Identifiers should not match keywords",
    Justification = "Get/Set are idiomatic for this simple provider; the interface is internal-facing and not exposed to VB consumers.")]
public interface IViewerLoginProvider
{
    string Get();
    void Set(string login);
}

public sealed class ViewerLoginProvider : IViewerLoginProvider
{
    private string _login = "";
    public string Get() => _login;
    public void Set(string login) => _login = login;
}
