using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

// Captures every request's body / method / path for assertion, and replays a FIFO queue of
// scripted responses. Submit-pipeline GraphQL methods make one or two calls per operation
// (e.g. resolve PR node ID, then run the mutation), so tests typically enqueue two responses
// and assert against RequestBodies[^1] / LastRequestBody.
//
// Tests that only care about behavior on a single response shape can use FakeHttpMessageHandler.Returns;
// tests that need to inspect the outgoing GraphQL payload use this.
internal sealed class RecordingHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, string Body)> _responses;

    public List<string?> RequestBodies { get; } = new();
    public List<HttpMethod> RequestMethods { get; } = new();
    public List<string?> RequestPaths { get; } = new();

    public string? LastRequestBody => RequestBodies.Count > 0 ? RequestBodies[^1] : null;
    public HttpMethod? LastRequestMethod => RequestMethods.Count > 0 ? RequestMethods[^1] : null;
    public string? LastRequestPath => RequestPaths.Count > 0 ? RequestPaths[^1] : null;
    public int RequestCount => RequestBodies.Count;

    public RecordingHttpMessageHandler(HttpStatusCode status, string responseBody)
        : this(new[] { (status, responseBody) }) { }

    public RecordingHttpMessageHandler(IEnumerable<(HttpStatusCode Status, string Body)> responses)
        => _responses = new Queue<(HttpStatusCode, string)>(responses);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequestMethods.Add(request.Method);
        RequestPaths.Add(request.RequestUri?.AbsolutePath);
        RequestBodies.Add(request.Content is null
            ? null
            : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));

        if (_responses.Count == 0)
        {
            throw new InvalidOperationException(
                $"RecordingHttpMessageHandler ran out of scripted responses on request #{RequestBodies.Count}. " +
                "Enqueue one response per expected HTTP call.");
        }

        var (status, body) = _responses.Dequeue();
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
    }
}
