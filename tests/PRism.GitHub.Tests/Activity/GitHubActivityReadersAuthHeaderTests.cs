using System.Net;
using System.Text;
using FluentAssertions;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

/// <summary>
/// Security regression cover for the Phase 2 Activity readers
/// (<see cref="GitHubNotificationsReader"/>, <see cref="GitHubWatchedReposReader"/>),
/// which send the PAT as an <c>Authorization: Bearer</c> header to the named
/// <c>"github"</c> <see cref="System.Net.Http.HttpClient"/>.
/// <para>
/// Two guarantees are pinned here, mirroring <see cref="GitHubReviewServiceAuthHeaderTests"/>:
/// </para>
/// <list type="number">
/// <item>The Bearer token IS attached on the outgoing request (so authed endpoints work;
/// without it private repos 404 and the anonymous 60/hr limit is burned).</item>
/// <item>The header is OMITTED — not sent as a malformed <c>Bearer </c> — when the token
/// store has no token yet.</item>
/// </list>
/// <para>
/// The complementary "the PAT is never logged" guarantee is <b>structural</b>: the
/// <c>"github"</c> client pipeline has no header-logging <see cref="System.Net.Http.DelegatingHandler"/>.
/// The only handler ever attached to that client is <c>TestFailureInjectionHandler</c>
/// (Test env + <c>PRISM_E2E_REAL_INJECT=1</c> only — never production), and it reads only the
/// request <em>body</em> to sniff the GraphQL field name; it never touches
/// <c>request.Headers.Authorization</c>. If a future contributor adds a diagnostic
/// header-logging handler, the captured-header assertions below remain the canary that the
/// readers route their PAT through the inspected pipeline.
/// </para>
/// </summary>
public sealed class GitHubActivityReadersAuthHeaderTests
{
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public List<string?> AuthValues { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            ArgumentNullException.ThrowIfNull(req);
            AuthValues.Add(req.Headers.Authorization?.Parameter);
            // Both readers parse a JSON array; "[]" is a valid empty payload either reader accepts.
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("[]", Encoding.UTF8, "application/json"),
            });
        }
    }

    private static FakeHttpClientFactory Factory(HttpMessageHandler handler) =>
        new(handler, new Uri("https://api.github.com/"));

    private static GitHubNotificationsReader Notifications(HttpMessageHandler handler, Func<Task<string?>>? readToken = null) =>
        new(Factory(handler), readToken ?? (() => Task.FromResult<string?>("ghp_test")));

    private static GitHubWatchedReposReader Watched(HttpMessageHandler handler, Func<Task<string?>>? readToken = null) =>
        new(Factory(handler), readToken ?? (() => Task.FromResult<string?>("ghp_test")));

    [Fact]
    public async Task NotificationsReader_attaches_bearer_token()
    {
        var handler = new CapturingHandler();
        await Notifications(handler).ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);

        handler.AuthValues.Should().HaveCount(1);
        handler.AuthValues[0].Should().Be("ghp_test",
            because: "the /notifications call must carry the Bearer token");
    }

    [Fact]
    public async Task WatchedReposReader_attaches_bearer_token()
    {
        var handler = new CapturingHandler();
        await Watched(handler).ReadAsync(CancellationToken.None);

        handler.AuthValues.Should().HaveCount(1);
        handler.AuthValues[0].Should().Be("ghp_test",
            because: "the /user/subscriptions call must carry the Bearer token");
    }

    [Fact]
    public async Task NotificationsReader_omits_authorization_when_token_is_null()
    {
        // Defensive: an unseeded token store must omit the header rather than send a
        // malformed `Bearer ` value.
        var handler = new CapturingHandler();
        await Notifications(handler, readToken: () => Task.FromResult<string?>(null))
            .ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);

        handler.AuthValues.Should().ContainSingle().Which.Should().BeNull();
    }

    [Fact]
    public async Task WatchedReposReader_omits_authorization_when_token_is_null()
    {
        var handler = new CapturingHandler();
        await Watched(handler, readToken: () => Task.FromResult<string?>(null))
            .ReadAsync(CancellationToken.None);

        handler.AuthValues.Should().ContainSingle().Which.Should().BeNull();
    }
}
