using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Auth;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubAuthHealthHandlerTests
{
    private static HttpRequestMessage Req(bool auth = true, bool skip = false, string url = "https://api.github.com/user")
    {
        var r = new HttpRequestMessage(HttpMethod.Get, url);
        if (auth) r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "t");
        if (skip) r.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);
        return r;
    }

    private static async Task<HttpResponseMessage> Send(IGitHubCredentialHealth health, HttpStatusCode status, HttpRequestMessage req)
    {
        var handler = new GitHubAuthHealthHandler(health) { InnerHandler = new StubHandler(status) };
        var invoker = new HttpMessageInvoker(handler);
        return await invoker.SendAsync(req, CancellationToken.None);
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        public StubHandler(HttpStatusCode status) => _status = status;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(_status));
    }

    [Fact]
    public async Task TwoConsecutive401s_FlipInvalid()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.Unauthorized, Req());
        Assert.True(h.IsInvalid);
    }

    [Fact]
    public async Task Single401_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task Success_ClearsInvalid()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.OK, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task NoAuthHeader_Ignored()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req(auth: false));
        await Send(h, HttpStatusCode.Unauthorized, Req(auth: false));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task SkipOption_Ignored()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req(skip: true));
        await Send(h, HttpStatusCode.Unauthorized, Req(skip: true));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task NonGitHubDotComHost_Ignored()
    {
        var h = new GitHubCredentialHealth();
        var url = "https://github.example.com/api/v3/user";
        await Send(h, HttpStatusCode.Unauthorized, Req(url: url));
        await Send(h, HttpStatusCode.Unauthorized, Req(url: url));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task Forbidden_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Forbidden, Req());
        await Send(h, HttpStatusCode.Forbidden, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task EpochChangedDuringRequest_401Ignored()
    {
        var h = new GitHubCredentialHealth();
        var handler = new GitHubAuthHealthHandler(h) { InnerHandler = new BumpThenStatusHandler(h, HttpStatusCode.Unauthorized) };
        var invoker = new HttpMessageInvoker(handler);
        await invoker.SendAsync(Req(), CancellationToken.None);
        await invoker.SendAsync(Req(), CancellationToken.None);
        Assert.False(h.IsInvalid); // both 401s arrived under a bumped epoch -> ignored
    }

    private sealed class BumpThenStatusHandler : HttpMessageHandler
    {
        private readonly IGitHubCredentialHealth _h;
        private readonly HttpStatusCode _status;
        public BumpThenStatusHandler(IGitHubCredentialHealth h, HttpStatusCode status) { _h = h; _status = status; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            _h.BumpEpoch(); // epoch moves between the handler's capture-before and check-after
            return Task.FromResult(new HttpResponseMessage(_status));
        }
    }
}
