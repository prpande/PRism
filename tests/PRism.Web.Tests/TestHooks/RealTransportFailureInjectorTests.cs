using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class RealTransportFailureInjectorTests
{
    [Fact]
    public void TryConsume_Pre_ReturnsArmedException_AndConsumes()
    {
        var injector = new RealTransportFailureInjector();
        var ex = new HttpRequestException("simulated");
        injector.InjectFailure("addPullRequestReviewThread", ex, afterEffect: false);

        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out var taken));
        Assert.Same(ex, taken);

        // One-shot: second call returns false.
        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
    }

    [Fact]
    public void TryConsume_AfterEffectMismatch_DoesNotConsume()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("simulated"), afterEffect: true);

        // Arming an afterEffect=true should NOT be consumed by an afterEffectWanted=false probe.
        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
        // Still armed for the matching probe.
        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: true, out _));
    }

    [Fact]
    public void TryConsume_DifferentFieldName_DoesNotMatch()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("simulated"), afterEffect: false);

        Assert.False(injector.TryConsume("submitPullRequestReview", afterEffectWanted: false, out _));
    }

    [Fact]
    public void Reset_ClearsAllArmedFailures()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("a"), afterEffect: false);
        injector.InjectFailure("submitPullRequestReview", new HttpRequestException("b"), afterEffect: true);

        injector.Reset();

        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
        Assert.False(injector.TryConsume("submitPullRequestReview", afterEffectWanted: true, out _));
    }
}
