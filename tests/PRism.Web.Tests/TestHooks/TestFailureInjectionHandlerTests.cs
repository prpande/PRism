using System.Net;
using System.Text;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class TestFailureInjectionHandlerTests
{
    // The handler chain ends with this stub so we can assert pass-through and observe
    // whether the inner SendAsync ran (proxy for "the real GitHub call would have landed").
    private sealed class StubInnerHandler : HttpMessageHandler
    {
        public int CallCount { get; private set; }
        public HttpResponseMessage Response { get; set; } = new(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"data":{}}""", Encoding.UTF8, "application/json"),
        };

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            CallCount++;
            return Task.FromResult(Response);
        }
    }

    private static HttpRequestMessage Mutation(string body) => new(HttpMethod.Post, "https://api.github.com/graphql")
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    // The simplest realistic GraphQL POST body PRism emits.
    private const string AddThreadBody = """
        {
          "query": "\n            mutation($prReviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {\n              addPullRequestReviewThread(input: { pullRequestReviewId: $prReviewId, body: $body, path: $path, line: $line, side: $side }) {\n                thread { id }\n              }\n            }\n          ",
          "variables": {"prReviewId":"PRR_1","body":"x","path":"src/Calc.cs","line":3,"side":"RIGHT"}
        }
        """;

    [Fact]
    public async Task PreEffect_ThrowsBeforeInner()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("pre"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.SendAsync(Mutation(AddThreadBody)));
        Assert.Equal(0, stub.CallCount);   // inner did NOT run
    }

    [Fact]
    public async Task PostEffect_ThrowsAfterInnerRan()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("post"), afterEffect: true);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.SendAsync(Mutation(AddThreadBody)));
        Assert.Equal(1, stub.CallCount);   // inner DID run (simulated lost-response window)
    }

    [Fact]
    public async Task NoArm_PassesThrough()
    {
        var injector = new RealTransportFailureInjector();
        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }

    [Fact]
    public async Task ArmForDifferentField_DoesNotMatch()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("submitPullRequestReview", new HttpRequestException("wrong"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));   // addPullRequestReviewThread body
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }

    [Fact]
    public async Task PrefixCollision_AddThread_DoesNotConsumeAddThreadReply_Arm()
    {
        // addPullRequestReviewThread is a STRICT PREFIX of addPullRequestReviewThreadReply.
        // A naive .Contains() impl would match both. Verify identifier-boundary parsing.
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThreadReply", new HttpRequestException("wrong"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));   // body's field name is addPullRequestReviewThread
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
        // The Reply arm is still pending (not consumed by the prefix-matching call).
        Assert.True(injector.TryConsume("addPullRequestReviewThreadReply", afterEffectWanted: false, out _));
    }

    [Fact]
    public async Task NonGraphQLBody_PassesThrough_SafeAgainstMalformedJson()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("anything", new HttpRequestException("should not fire"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation("not json at all"));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }
}
