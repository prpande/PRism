using System.Net.Http;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Tests.PrDetail;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Auth;

// Login-cache behavior of ViewerLoginHydrator, in real-collaborator style
// (FakeTokenStore / StubReviewAuth / InMemoryViewerLoginProvider + FakeConfigStore).
// Migrated from the former Moq-based PRism.Web.Tests/Hosting/ViewerLoginHydratorTests.cs:
// ViewerLoginHydrator is a Core class, so it is tested in exactly one project. The
// config-write side effect is pinned separately by ViewerLoginHydratorConfigWriteTests.
public class ViewerLoginHydratorTests
{
    [Fact]
    public async Task StartAsync_when_validation_throws_leaves_login_empty()
    {
        var tokens = new FakeTokenStore(hasToken: true);
        var review = new StubReviewAuth(new HttpRequestException("network down"));
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(
            tokens, review, loginCache, new FakeConfigStore(), NullLogger<ViewerLoginHydrator>.Instance);

        // Must not throw — startup is forgiving; the next /api/auth/connect or refresh tick recovers.
        await hydrator.StartAsync(CancellationToken.None);

        loginCache.Get().Should().Be("");
    }

    [Fact]
    public async Task StartAsync_does_not_clobber_existing_login()
    {
        var tokens = new FakeTokenStore(hasToken: true);
        // throwOnValidate proves ValidateCredentialsAsync is never reached: if the
        // hydrator tried to validate (and clobber), this would throw and fail the test.
        var review = new StubReviewAuth(throwOnValidate: true);
        var loginCache = new InMemoryViewerLoginProvider();
        loginCache.Set("already-logged-in"); // simulate /api/auth/connect winning the race

        var hydrator = new ViewerLoginHydrator(
            tokens, review, loginCache, new FakeConfigStore(), NullLogger<ViewerLoginHydrator>.Instance);

        await hydrator.StartAsync(CancellationToken.None);

        loginCache.Get().Should().Be("already-logged-in");
    }

    [Fact]
    public async Task StartAsync_propagates_cancellation()
    {
        var tokens = new FakeTokenStore(hasToken: true);
        var review = new StubReviewAuth(new OperationCanceledException());
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(
            tokens, review, loginCache, new FakeConfigStore(), NullLogger<ViewerLoginHydrator>.Instance);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Func<Task> act = () => hydrator.StartAsync(cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
