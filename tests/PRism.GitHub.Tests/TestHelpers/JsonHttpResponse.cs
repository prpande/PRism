using System.Net;
using System.Text;

namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Builds an <see cref="HttpResponseMessage"/> carrying a UTF-8 <c>application/json</c> string
/// body — the response shape every fake GitHub transport returns. Several inbox-read tests each
/// declared a byte-identical local <c>Respond(code, body)</c> helper; this is the shared form.
/// </summary>
internal static class JsonHttpResponse
{
    public static HttpResponseMessage Create(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
