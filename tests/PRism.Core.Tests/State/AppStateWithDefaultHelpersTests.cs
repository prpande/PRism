using System.Collections.Immutable;
using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateWithDefaultHelpersTests
{
    [Fact]
    public void WithDefaultReviews_returns_new_state_with_default_accounts_reviews_replaced()
    {
        var newReviews = new PrSessionsState(new Dictionary<string, ReviewSessionState>
        {
            ["owner/repo/1"] = new ReviewSessionState(
                TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("abc", DateTime.UtcNow.AddMinutes(-1)) },
                LastSeenCommentId: null,
                PendingReviewId: null,
                PendingReviewCommitOid: null,
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: System.Array.Empty<DraftComment>(),
                DraftReplies: System.Array.Empty<DraftReply>(),
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft)
        });

        var updated = AppState.Default.WithDefaultReviews(newReviews);

        updated.Reviews.Sessions.Should().ContainKey("owner/repo/1");
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(newReviews);
        // Other account-state fields preserved.
        updated.Accounts[AccountKeys.Default].AiState.Should().BeSameAs(AppState.Default.Accounts[AccountKeys.Default].AiState);
        updated.Accounts[AccountKeys.Default].LastConfiguredGithubHost.Should().BeNull();
        // Top-level fields preserved.
        updated.UiPreferences.Should().BeSameAs(AppState.Default.UiPreferences);
        updated.Version.Should().Be(AppState.Default.Version);
    }

    [Fact]
    public void WithDefaultAiState_returns_new_state_with_default_accounts_ai_state_replaced()
    {
        var newAi = new AiState(
            new Dictionary<string, RepoCloneEntry> { ["owner/repo"] = new RepoCloneEntry("/tmp/clone", "user") },
            new System.DateTime(2026, 5, 10, 0, 0, 0, System.DateTimeKind.Utc));

        var updated = AppState.Default.WithDefaultAiState(newAi);

        updated.AiState.Should().BeSameAs(newAi);
        updated.Accounts[AccountKeys.Default].AiState.Should().BeSameAs(newAi);
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(PrSessionsState.Empty);
    }

    [Fact]
    public void WithDefaultLastConfiguredGithubHost_returns_new_state_with_field_replaced()
    {
        var updated = AppState.Default.WithDefaultLastConfiguredGithubHost("https://github.acme.local");

        updated.LastConfiguredGithubHost.Should().Be("https://github.acme.local");
        updated.Accounts[AccountKeys.Default].LastConfiguredGithubHost.Should().Be("https://github.acme.local");
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(PrSessionsState.Empty);
    }

    [Fact]
    public void Read_delegate_properties_return_default_accounts_subfields()
    {
        var state = AppState.Default;

        state.Reviews.Should().BeSameAs(state.Accounts[AccountKeys.Default].Reviews);
        state.AiState.Should().BeSameAs(state.Accounts[AccountKeys.Default].AiState);
        state.LastConfiguredGithubHost.Should().Be(state.Accounts[AccountKeys.Default].LastConfiguredGithubHost);
    }

    [Fact]
    public void WithSession_upserts_a_session_without_mutating_the_original()
    {
        var state = AppState.Default;
        var session = new ReviewSessionState(
            TabStamps: new Dictionary<string, TabStamp>(),
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: System.Array.Empty<DraftComment>(),
            DraftReplies: System.Array.Empty<DraftReply>(),
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var updated = state.WithSession("o/r/1", session);

        updated.Reviews.Sessions.Should().ContainKey("o/r/1");
        updated.Reviews.Sessions["o/r/1"].Should().BeSameAs(session);
        state.Reviews.Sessions.Should().NotContainKey("o/r/1"); // original unchanged (immutability)
    }

    [Fact]
    public void WithSession_overwrites_an_existing_key_and_preserves_siblings()
    {
        var first = new ReviewSessionState(
            TabStamps: new Dictionary<string, TabStamp>(),
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: System.Array.Empty<DraftComment>(),
            DraftReplies: System.Array.Empty<DraftReply>(),
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
        var second = new ReviewSessionState(
            TabStamps: new Dictionary<string, TabStamp>(),
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: System.Array.Empty<DraftComment>(),
            DraftReplies: System.Array.Empty<DraftReply>(),
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
        var state = AppState.Default.WithSession("o/r/1", first).WithSession("o/r/2", first);

        var updated = state.WithSession("o/r/1", second);

        updated.Reviews.Sessions["o/r/1"].Should().BeSameAs(second);
        updated.Reviews.Sessions["o/r/2"].Should().BeSameAs(first); // sibling preserved
    }
}
