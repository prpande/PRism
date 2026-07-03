using FluentAssertions;
using Microsoft.AspNetCore.Http;
using PRism.Web.Endpoints;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #666 — the tab-id CSRF gate is single-sourced in TabStamps (previously copy-pasted verbatim
// across five mutating endpoints). These assert the load-bearing gate directly so a future
// endpoint copying a neighbour can't silently narrow it; the per-endpoint 4xx envelopes are
// covered by each endpoint's own integration tests.
public class TabStampsTests
{
    [Theory]
    [InlineData("tab-test")]
    [InlineData("a")]
    [InlineData("A1_-")]
    [InlineData("0123456789012345678901234567890123456789012345678901234567890123")] // exactly 64
    public void IsValidTabId_accepts_well_formed_ids(string tabId) =>
        TabStamps.IsValidTabId(tabId).Should().BeTrue();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("tab with space")]
    [InlineData("tab/with/slash")]
    [InlineData("../../etc/passwd")]
    [InlineData("tab.dot")]
    [InlineData("tab!")]
    [InlineData("café")] // non-ASCII
    [InlineData("01234567890123456789012345678901234567890123456789012345678901234")] // 65 → too long
    public void IsValidTabId_rejects_missing_or_out_of_allowlist_ids(string? tabId) =>
        TabStamps.IsValidTabId(tabId).Should().BeFalse();

    [Fact]
    public void TryValidateTabId_returns_true_and_outputs_the_exact_header_value()
    {
        var request = new DefaultHttpContext().Request;
        request.Headers[TabStamps.TabIdHeader] = "tab-test";

        TabStamps.TryValidateTabId(request, out var tabId).Should().BeTrue();
        tabId.Should().Be("tab-test");
    }

    [Fact]
    public void TryValidateTabId_returns_false_with_empty_out_when_header_absent()
    {
        var request = new DefaultHttpContext().Request;

        TabStamps.TryValidateTabId(request, out var tabId).Should().BeFalse();
        tabId.Should().BeEmpty();
    }

    [Theory]
    [InlineData("tab with space")]
    [InlineData("tab/with/slash")]
    [InlineData("../../etc/passwd")]
    public void TryValidateTabId_returns_false_when_header_out_of_allowlist(string headerValue)
    {
        var request = new DefaultHttpContext().Request;
        request.Headers[TabStamps.TabIdHeader] = headerValue;

        TabStamps.TryValidateTabId(request, out _).Should().BeFalse();
    }
}
