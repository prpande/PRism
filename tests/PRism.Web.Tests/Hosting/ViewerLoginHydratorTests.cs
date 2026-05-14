using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Web.Tests.Hosting;

public class ViewerLoginHydratorTests
{
    [Fact]
    public async Task StartAsync_with_stored_token_calls_ValidateCredentials_and_sets_login()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var review = new Mock<IReviewAuth>();
        review.Setup(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()))
              .ReturnsAsync(new AuthValidationResult(true, "octocat", new[] { "repo" }, AuthValidationError.None, null));

        var loginProvider = new ViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        await hydrator.StartAsync(CancellationToken.None);

        loginProvider.Get().Should().Be("octocat");
        review.Verify(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task StartAsync_with_no_token_does_not_call_ValidateCredentials()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(false);

        var review = new Mock<IReviewAuth>(MockBehavior.Strict);

        var loginProvider = new ViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        await hydrator.StartAsync(CancellationToken.None);

        loginProvider.Get().Should().Be("");
        review.Verify(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task StartAsync_with_invalid_token_leaves_login_empty()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var review = new Mock<IReviewAuth>();
        review.Setup(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()))
              .ReturnsAsync(new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "rejected"));

        var loginProvider = new ViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        await hydrator.StartAsync(CancellationToken.None);

        loginProvider.Get().Should().Be("");
    }

    [Fact]
    public async Task StartAsync_when_ValidateCredentials_throws_leaves_login_empty()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var review = new Mock<IReviewAuth>();
        review.Setup(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()))
              .ThrowsAsync(new HttpRequestException("network down"));

        var loginProvider = new ViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        // Must not throw — startup is forgiving; the next /api/auth/connect or refresh tick can recover.
        await hydrator.StartAsync(CancellationToken.None);

        loginProvider.Get().Should().Be("");
    }

    [Fact]
    public async Task StartAsync_does_not_clobber_existing_login()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var review = new Mock<IReviewAuth>(MockBehavior.Strict);

        var loginProvider = new ViewerLoginProvider();
        loginProvider.Set("already-logged-in"); // simulate /api/auth/connect winning the race

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        await hydrator.StartAsync(CancellationToken.None);

        loginProvider.Get().Should().Be("already-logged-in");
        review.Verify(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task StartAsync_propagates_cancellation()
    {
        var tokens = new Mock<ITokenStore>();
        tokens.Setup(t => t.HasTokenAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var review = new Mock<IReviewAuth>();
        review.Setup(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()))
              .ThrowsAsync(new OperationCanceledException());

        var loginProvider = new ViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens.Object, review.Object, loginProvider, new Mock<IConfigStore>().Object, NullLogger<ViewerLoginHydrator>.Instance);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Func<Task> act = () => hydrator.StartAsync(cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
