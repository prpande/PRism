using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AccountStateTests
{
    [Fact]
    public void Default_has_empty_reviews_empty_repo_clone_map_null_workspace_mtime_and_null_host()
    {
        var defaultState = AccountState.Default;

        defaultState.Reviews.Sessions.Should().BeEmpty();
        defaultState.AiState.RepoCloneMap.Should().BeEmpty();
        defaultState.AiState.WorkspaceMtimeAtLastEnumeration.Should().BeNull();
        defaultState.LastConfiguredGithubHost.Should().BeNull();
    }

    [Fact]
    public void Default_is_a_stable_singleton_reference()
    {
        // ReadOnlyDictionary wrapping inside PrSessionsState.Empty already prevents
        // mutation; this test pins the singleton-instance shape so any future change
        // that switches to a fresh-instance-per-call accessor fails fast (matches
        // the AppState.Default pattern and prevents the shared-mutable-backing-store
        // regression PrSessionsState.Empty's doc-comment calls out).
        AccountState.Default.Should().BeSameAs(AccountState.Default);
    }
}
