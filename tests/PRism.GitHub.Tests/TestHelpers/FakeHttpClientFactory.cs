namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Test double for IHttpClientFactory. Returns a fresh <see cref="HttpClient"/> wrapper
/// on each <see cref="CreateClient"/> call, sharing the same underlying handler.
/// <para>
/// Production code disposes the wrapper via <c>using var http = factory.CreateClient(...)</c>.
/// Setting <c>disposeHandler: false</c> ensures those disposals do not tear down the shared
/// handler, so subsequent <see cref="CreateClient"/> calls continue to work.
/// </para>
/// </summary>
internal sealed class FakeHttpClientFactory : IHttpClientFactory
{
    private readonly HttpMessageHandler _handler;
    private readonly Uri _baseAddress;

    public FakeHttpClientFactory(HttpMessageHandler handler, Uri baseAddress)
    {
        _handler = handler;
        _baseAddress = baseAddress;
    }

    /// <summary>
    /// Returns a new <see cref="HttpClient"/> wrapper each time; the underlying handler is shared.
    /// </summary>
    public HttpClient CreateClient(string name) =>
        new(_handler, disposeHandler: false) { BaseAddress = _baseAddress };
}
