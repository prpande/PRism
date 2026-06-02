using Microsoft.AspNetCore.Http;
using PRism.Web.Middleware;

namespace PRism.Web.Tests.Middleware;

public class HostHeaderCheckMiddlewareTests
{
    private static async Task<int> Run(string host, bool enforced)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers.Host = host;
        var called = false;
        var mw = new HostHeaderCheckMiddleware(_ => { called = true; return Task.CompletedTask; }, enforced);
        await mw.InvokeAsync(ctx);
        return called ? 200 : ctx.Response.StatusCode;
    }

    [Theory]
    [InlineData("127.0.0.1:5180")]
    [InlineData("127.0.0.1")]
    [InlineData("[::1]:5180")]
    public async Task LoopbackHost_PassesThrough(string host)
        => Assert.Equal(200, await Run(host, enforced: true));

    [Theory]
    [InlineData("evil.example.com")]
    [InlineData("evil.example.com:5180")]
    [InlineData("attacker.tld")]
    public async Task NonLoopbackHost_Rejected403(string host)
        => Assert.Equal(403, await Run(host, enforced: true));

    [Fact]
    public async Task WhenNotEnforced_AllHostsPass()
        => Assert.Equal(200, await Run("evil.example.com", enforced: false));
}
