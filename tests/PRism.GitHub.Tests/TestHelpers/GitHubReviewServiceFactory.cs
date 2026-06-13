namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Canonical github.com test wiring for <see cref="GitHubReviewService"/>: an
/// <c>api.github.com/</c> base address, the <c>https://github.com</c> host, and a
/// <c>ghp_test</c> token. Host-parameterized constructions (multi-host credential validation,
/// PR-URL parsing) and the DI-built validate-skip test vary the host / ApiBase and are
/// intentionally not served here.
/// </summary>
internal static class GitHubReviewServiceFactory
{
    /// <param name="handler">The fake transport the service's <see cref="HttpClient"/>s ride.</param>
    /// <param name="readToken">
    /// Overrides the token callback; defaults to returning <c>"ghp_test"</c>. Only the
    /// auth-header regression suite needs a custom callback.
    /// </param>
    public static GitHubReviewService Create(
        HttpMessageHandler handler,
        Func<Task<string?>>? readToken = null) =>
        new(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            readToken ?? (() => Task.FromResult<string?>("ghp_test")),
            "https://github.com");

    /// <summary>
    /// Canonical github.com wiring for <see cref="GitHubReviewSubmitter"/> — same fake
    /// transport, <c>api.github.com/</c> base, <c>https://github.com</c> host, <c>ghp_test</c>
    /// token as <see cref="Create"/>. Used by the submit/comment suites after the #321 PR2 split.
    /// </summary>
    public static GitHubReviewSubmitter CreateSubmitter(
        HttpMessageHandler handler,
        Func<Task<string?>>? readToken = null) =>
        new(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            readToken ?? (() => Task.FromResult<string?>("ghp_test")),
            "https://github.com");
}
