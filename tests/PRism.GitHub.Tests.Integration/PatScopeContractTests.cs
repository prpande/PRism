using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

[Trait("Category", "Integration")]
public class PatScopeContractTests : IClassFixture<LiveGitHubFixture>
{
    private readonly LiveGitHubFixture _fixture;
    public PatScopeContractTests(LiveGitHubFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ValidateCredentialsAsync_returns_ok_with_login_for_test_pat()
    {
        // Spec § 5 row 7e — fitness smoke (NOT scope-shape). No scope-equality assertion works
        // for both fine-grained PATs (no X-OAuth-Scopes header, Scopes is empty) and classic PATs
        // (different scope namespace). See FEAS-R2-1/2 round-2 findings.

        // Assertion (a): credential validates and returns Ok with a non-empty Login.
        AuthValidationResult result = await _fixture.Auth.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeTrue($"validation failed with: {result.ErrorDetail}");
        result.Login.Should().NotBeNullOrWhiteSpace("ViewerLogin is load-bearing for the suite");

        // Assertion (b): one live read against prpande/PRism succeeds — confirms repo
        // authorization, not just credential format. Goes through IPrReader so we exercise
        // the same code path the corpus tests use; a 401/403 here surfaces as the same
        // exception shape the corpus tests would hit, so PAT-fitness failure is consistent
        // across the suite. PollActivePrAsync returns a non-nullable ActivePrPollSnapshot,
        // so a structural NotBeNull check would always pass — instead assert HeadSha is
        // non-empty, which only holds if the GraphQL round-trip actually returned data.
        var poll = await _fixture.Reader.PollActivePrAsync(
            new PrReference("prpande", "PRism", 1), CancellationToken.None);
        poll.HeadSha.Should().NotBeNullOrWhiteSpace(
            "PAT must authorize a read against prpande/PRism PR #1 — non-empty HeadSha proves a real GraphQL round-trip");
    }
}
