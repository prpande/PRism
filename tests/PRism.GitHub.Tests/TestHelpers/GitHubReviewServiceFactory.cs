namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Builds a <see cref="GitHubReviewService"/> over a fake transport for the canonical
/// github.com test setup: an <c>api.github.com/</c> base address, the <c>https://github.com</c>
/// host, and a <c>ghp_test</c> token. The vast majority of the service's tests share this exact
/// wiring; they previously each declared an identical local <c>NewService(handler)</c> helper.
/// <para>
/// Host-parameterized tests (multi-host credential validation, PR-URL parsing) and the
/// DI-built validate-skip test construct the service directly — they vary the host / ApiBase
/// (via <c>HostUrlResolver.ApiBase</c>) and are intentionally not served by this factory.
/// </para>
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
}
