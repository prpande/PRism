using PRism.Core.Auth;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class GitHubCredentialHealthTests
{
    [Fact]
    public void StartsValid()
    {
        var h = new GitHubCredentialHealth();
        Assert.False(h.IsInvalid);
        Assert.Equal(0, h.Epoch);
    }

    [Fact]
    public void SingleFailure_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        Assert.False(h.IsInvalid); // threshold is 2 consecutive
    }

    [Fact]
    public void TwoConsecutiveFailures_Flip()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.RecordAuthFailure();
        Assert.True(h.IsInvalid);
    }

    [Fact]
    public void SuccessBetweenFailures_ResetsCounter()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.MarkValid();
        h.RecordAuthFailure();
        Assert.False(h.IsInvalid); // counter reset by the 2xx
    }

    [Fact]
    public void MarkValid_ClearsInvalid()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.RecordAuthFailure();
        Assert.True(h.IsInvalid);
        h.MarkValid();
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public void BumpEpoch_Increments()
    {
        var h = new GitHubCredentialHealth();
        h.BumpEpoch();
        Assert.Equal(1, h.Epoch);
    }
}
