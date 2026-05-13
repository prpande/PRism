using FluentAssertions;
using PRism.Core.Auth;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class TokenStoreReshapeTests
{
    [Fact]
    public async Task ReadAsync_returns_null_when_cache_file_missing()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().BeNull();
    }

    [Fact]
    public async Task ReadAsync_unwraps_versioned_json_map_to_default_pat()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        await store.WriteTransientAsync("ghp_abc", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);

        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_abc");
        // On-disk shape is the versioned map.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"version\":1");
        raw.Should().Contain("\"default\":\"ghp_abc\"");
    }

    [Fact]
    public async Task ReadAsync_migrates_legacy_bare_pat_blob_to_versioned_map_on_first_read()
    {
        using var dir = new TempDataDir();
        // Write a legacy-shape cache: BARE PAT bytes — no surrounding quotes. This is what the
        // pre-S6-PR0 CommitAsync wrote via `Encoding.UTF8.GetBytes(_transient)`. The
        // ce-doc-review feasibility + adversarial reviewers caught that the original plan-draft
        // fixture was JSON-quoted (`"\"ghp_legacy\""`), which does NOT match real legacy bytes;
        // testing with quoted bytes hid the migration bug.
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"), "ghp_legacy_ghp_legacy");

        var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_legacy_ghp_legacy");

        // After the read, the cache is rewritten to the versioned shape.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"version\":1");
        raw.Should().Contain("\"default\":\"ghp_legacy_ghp_legacy\"");
    }

    [Fact]
    public async Task ReadAsync_migrates_legacy_quoted_pat_blob_too_for_hand_edited_safety()
    {
        // Defensive: a curious admin who hand-edited PRism.tokens.cache might have JSON-quoted
        // the PAT. Both shapes should migrate cleanly. (This case rounds-trips through
        // JsonNode.Parse as JsonValue<string>, which the branch-2 detector also accepts.)
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"), "\"ghp_quoted_legacy\"");

        var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_quoted_legacy");
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"default\":\"ghp_quoted_legacy\"");
    }

    [Fact]
    public async Task ReadAsync_future_version_cache_throws_TokenStoreException_with_clear_message_and_does_not_overwrite()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        var original = "{\"version\":2,\"tokens\":{\"default\":\"ghp_future\"}}";
        await File.WriteAllTextAsync(path, original);

        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        Func<Task> act = () => store.ReadAsync(CancellationToken.None);

        var ex = await act.Should().ThrowAsync<TokenStoreException>();
        ex.Which.Failure.Should().Be(TokenStoreFailure.FutureVersionCache);
        ex.Which.Message.Should().Contain("downgraded");

        // The file is left intact — read-only mode never writes.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(original);
    }

    [Fact]
    public async Task CommitAsync_after_future_version_ReadAsync_refuses_to_overwrite_the_v2_cache()
    {
        // ce-doc-review security finding 2 + adversarial finding 7: a v1 binary that has seen a
        // future-version cache MUST refuse subsequent CommitAsync calls. Without this guard,
        // WriteTransient+Commit between a Setup retry would silently overwrite a v2 cache (and
        // destroy any v2-added second-account PAT). The state.json store has the analogous
        // IsReadOnlyMode flag; the token store needs parity.
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        var original = "{\"version\":2,\"tokens\":{\"default\":\"ghp_v2_default\",\"secondary\":\"ghp_v2_second\"}}";
        await File.WriteAllTextAsync(path, original);

        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        // ReadAsync sets the read-only flag.
        await store.Invoking(s => s.ReadAsync(CancellationToken.None))
            .Should().ThrowAsync<TokenStoreException>();

        // Now stage a new candidate token and try to commit. The guard must refuse.
        await store.WriteTransientAsync("ghp_v1_freshly_set", CancellationToken.None);
        Func<Task> commit = () => store.CommitAsync(CancellationToken.None);

        var commitEx = await commit.Should().ThrowAsync<TokenStoreException>();
        commitEx.Which.Failure.Should().Be(TokenStoreFailure.FutureVersionCache);

        // File still intact — v2 cache preserved.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(original);
    }

    [Theory]
    [InlineData("{\"version\":0,\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"version\":null,\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"version\":\"one\",\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"version\":1,\"tokens\":{}}")]
    public async Task ReadAsync_invalid_version_discriminator_or_missing_default_throws_TokenStoreException_and_does_not_overwrite(string fileContents)
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        await File.WriteAllTextAsync(path, fileContents);

        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        Func<Task> act = () => store.ReadAsync(CancellationToken.None);

        var ex = await act.Should().ThrowAsync<TokenStoreException>();
        ex.Which.Failure.Should().Be(TokenStoreFailure.CorruptCache);

        // File preserved — surfacing "re-validate at Setup" must NOT overwrite.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(fileContents);
    }
}
