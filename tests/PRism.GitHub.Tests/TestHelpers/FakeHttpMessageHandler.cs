using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

public sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) { _responder = responder; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => Task.FromResult(_responder(request));

    public static FakeHttpMessageHandler Returns(HttpStatusCode status, string? body = null, IReadOnlyDictionary<string, string>? headers = null)
        => new(_ =>
        {
            var resp = new HttpResponseMessage(status);
            if (body is not null) resp.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            if (headers is not null)
                foreach (var (k, v) in headers)
                    resp.Headers.TryAddWithoutValidation(k, v);
            return resp;
        });

    public static FakeHttpMessageHandler Throws(Exception ex) => new(_ => throw ex);
}
