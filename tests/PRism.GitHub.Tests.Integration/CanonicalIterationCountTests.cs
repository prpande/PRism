using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

// Sibling strict-equality tests for the ranged corpus PRs. Run only via:
//   dotnet test --filter "Canonical=Strict"
// Spec § 9.7 + § 10 silent-drift bullet. The .runsettings filter excludes Canonical=Strict
// from default `dotnet test`; the standard Category=Integration filter must use the AND-form
// `Category=Integration&Canonical!=Strict` to keep them out of routine runs.
//
// Canonical values are constants at the class top so the test method names stay generic.
// A coefficient retune that shifts a canonical only changes the constant, not the name.
[Trait("Canonical", "Strict")]
[Trait("Category", "Integration")]
public class CanonicalIterationCountTests : IClassFixture<LiveGitHubFixture>
{
    // Update these constants when the algorithm's canonical iteration counts shift.
    private const int Pr16Canonical = 1;
    private const int Pr19Canonical = 3;

    private readonly LiveGitHubFixture _fixture;
    public CanonicalIterationCountTests(LiveGitHubFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Pr16_iteration_count_matches_captured_canonical()
    {
        var dto = await _fixture.LoadPrDetailAsync(FrozenPrCorpus.Pr16);
        dto.Iterations!.Count.Should().Be(Pr16Canonical,
            "Canonical value for PR #16; range [1,2] absorbs tuning, this asserts the current truth");
    }

    [Fact]
    public async Task Pr19_iteration_count_matches_captured_canonical()
    {
        var dto = await _fixture.LoadPrDetailAsync(FrozenPrCorpus.Pr19);
        dto.Iterations!.Count.Should().Be(Pr19Canonical,
            "Canonical value for PR #19; range [2,3] absorbs tuning, this asserts the current truth");
    }
}
