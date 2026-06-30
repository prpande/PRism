using System.Text.Json;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Activity;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Core.Tests.Storage;

// NOTE (round-1 feasibility residual): the SampleSnapshot helper below constructs PrInboxItem and
// PrReference positionally. Match the REAL record signatures when implementing — PrInboxItem has 15
// required positional params (Reference … LastSeenCommentId) then optional ones; PrReference is
// (Owner, Repo, Number) with a computed PrId. The compiler will flag any mismatch at TDD Step 4.

public sealed class IdentityKeyedFileCacheTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-cache-" + Guid.NewGuid().ToString("N"));
    private string Path0 => Path.Combine(_dir, "cache.json");

    public IdentityKeyedFileCacheTests() => Directory.CreateDirectory(_dir);
    public void Dispose()
    {
#pragma warning disable CA1031 // best-effort temp-dir cleanup in test teardown
        try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
#pragma warning restore CA1031
    }

    private static CacheIdentity Id(string login = "octocat", string host = "github.com") => new(login, host);

    private static InboxSnapshot SampleSnapshot()
    {
        var item = new PrInboxItem(
            new PrReference("octocat", "hello", 7), "Title", "octocat", "octocat/hello",
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 1, 1, 0, 1, 0, "deadbeef",
            CiStatus.Passing, null, null);
        var sections = new Dictionary<string, IReadOnlyList<PrInboxItem>> { ["mine"] = new[] { item } };
        var enrich = new Dictionary<string, InboxItemEnrichment>
        {
            [item.Reference.PrId] = new InboxItemEnrichment(item.Reference.PrId, "needs-review", null),
        };
        return new InboxSnapshot(sections, enrich, DateTimeOffset.UnixEpoch, CiProbeComplete: true,
            AiEnrichmentSettled: new HashSet<string>(StringComparer.Ordinal) { item.Reference.PrId });
    }

    private IdentityKeyedFileCache<InboxSnapshot> NewInboxCache(Func<InboxSnapshot, bool>? valid = null) =>
        new(Path0, schemaVersion: 1, isStructurallyValid: valid ?? (s => s.Sections is not null && s.Enrichments is not null));

    [Fact] // test 1 — round-trip incl. non-empty AiEnrichmentSettled + kebab enum
    public async Task SaveAsync_then_TryLoad_round_trips_payload()
    {
        var cache = NewInboxCache();
        var snap = SampleSnapshot();
        await cache.SaveAsync(snap, Id(), CancellationToken.None);
        var loaded = cache.TryLoad(Id());
        loaded.Should().NotBeNull();
        loaded!.Sections["mine"].Should().HaveCount(1);
        loaded.Enrichments.Values.Single().CategoryChip.Should().Be("needs-review");
        loaded.AiEnrichmentSettled.Should().ContainSingle();
        loaded.Sections["mine"][0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact] // test 1 (activity half, round-1 SCOPE-2) — ActivityResponse round-trip incl. kebab ActivitySource/ActivityVerb
    public async Task SaveAsync_then_TryLoad_round_trips_ActivityResponse_with_kebab_enums()
    {
        var cache = new IdentityKeyedFileCache<ActivityResponse>(
            Path.Combine(_dir, "activity.json"), schemaVersion: 1, isStructurallyValid: r => r.Items is not null);
        var resp = new ActivityResponse(
            new[]
            {
                new ActivityItem("alice", null, ActorIsBot: false, ActivityVerb.ReviewRequested,
                    "octocat/hello", 7, "Title", "https://github.com/octocat/hello/pull/7",
                    DateTimeOffset.UnixEpoch, ActivitySource.Notification),
            },
            DateTimeOffset.UnixEpoch,
            new ActivityDegradation(false, false, false),
            Array.Empty<WatchedRepoActivity>());
        await cache.SaveAsync(resp, Id(), CancellationToken.None);

        var loaded = cache.TryLoad(Id());
        loaded.Should().NotBeNull();
        loaded!.Items.Should().ContainSingle();
        loaded.Items[0].Verb.Should().Be(ActivityVerb.ReviewRequested);   // kebab "review-requested" round-trips
        loaded.Items[0].Source.Should().Be(ActivitySource.Notification);  // kebab "notification" round-trips
    }

    [Fact] // test 2 — login mismatch, host mismatch, both-match (login OrdinalIgnoreCase)
    public async Task TryLoad_gates_on_login_and_host()
    {
        var cache = NewInboxCache();
        await cache.SaveAsync(SampleSnapshot(), Id("octocat", "github.com"), CancellationToken.None);
        cache.TryLoad(Id("someone-else", "github.com")).Should().BeNull();
        cache.TryLoad(Id("octocat", "ghe.example.com")).Should().BeNull();
        cache.TryLoad(Id("OCTOCAT", "github.com")).Should().NotBeNull(); // login is OrdinalIgnoreCase
    }

    [Fact] // test 3 — missing file
    public void TryLoad_returns_null_when_file_absent() =>
        NewInboxCache().TryLoad(Id()).Should().BeNull();

    [Fact] // test 4 — corrupt file → null, no throw, file left as-is
    public async Task TryLoad_returns_null_on_corrupt_file_without_throwing()
    {
        await File.WriteAllTextAsync(Path0, "{ this is not valid json");
        var cache = NewInboxCache();
        cache.TryLoad(Id()).Should().BeNull();
        File.Exists(Path0).Should().BeTrue();
    }

    [Fact] // test 5 — wrong schema version (older AND future)
    public async Task TryLoad_returns_null_on_version_mismatch()
    {
        var v2 = new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 2);
        await v2.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 1).TryLoad(Id()).Should().BeNull(); // older reader
        new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 3).TryLoad(Id()).Should().BeNull(); // future reader
    }

    [Fact] // test 6 — structurally-invalid payload (parses + identity match, but invalid)
    public async Task TryLoad_returns_null_when_structurally_invalid()
    {
        var writer = NewInboxCache();
        await writer.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        var strict = NewInboxCache(valid: s => s.Sections.Count > 5); // never satisfied here
        strict.TryLoad(Id()).Should().BeNull();
    }

    [Fact] // test 7 — SaveAsync never throws even if the move target dir vanishes
    public async Task SaveAsync_never_throws_on_io_failure()
    {
        var badPath = Path.Combine(_dir, "no-such-subdir", "cache.json"); // parent dir does not exist
        var cache = new IdentityKeyedFileCache<InboxSnapshot>(badPath, schemaVersion: 1);
        var act = async () => await cache.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact] // test 8 — EvictAsync removes the file
    public async Task EvictAsync_removes_the_file()
    {
        var cache = NewInboxCache();
        await cache.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        File.Exists(Path0).Should().BeTrue();
        await cache.EvictAsync(CancellationToken.None);
        File.Exists(Path0).Should().BeFalse();
        cache.TryLoad(Id()).Should().BeNull();
    }
}
