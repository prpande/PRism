using System.Collections.Immutable;

using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

// Shared in-memory state for the four split test fakes (FakeReviewAuth / FakePrDiscovery /
// FakePrReader / FakeReviewSubmitter). Mirrors the ADR-S5-1 capability split on the test
// side: each fake delegates to this one DI-singleton store so they collaborate on a single
// scenario state. Replaces the consolidated FakeReviewService from S4.
//
// Scope: per the plan deferrals, scenario data is inlined in C# rather than loaded from
// frontend/e2e/fixtures/*.json — for the E2E specs this slice ships, schema + parsing
// overhead per fixture isn't worth it. Future scenarios can refactor to JSON.
//
// Thread-safety: mutation is rare (one /test/advance-head per E2E test step) and reads
// vastly outnumber writes; a single lock (Gate) for simplicity. Fakes that read more than
// one field together must hold Gate across the read so the view doesn't tear.
internal sealed class FakeReviewBackingStore
{
    // The canonical scenario PR. All E2E specs use this reference.
    public static readonly PrReference Scenario = new("acme", "api", 123);

    // The PR's base sha is fixed across iterations. Head sha advances per iteration.
    public const string BaseSha = "ba5e0000000000000000000000000000000000ba";
    private const string Sha1 = "1111111111111111111111111111111111111111";
    private const string Sha2 = "2222222222222222222222222222222222222222";
    private const string Sha3 = "3333333333333333333333333333333333333333";

    // src/Calc.cs at three iteration heads. Lines split by \n; reconciliation
    // pipeline matches on whole-line content. Calc3 is also the diff fallback for
    // a head sha that AdvanceHead didn't seed file content for.
    public const string Calc1 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n}\n";
    public const string Calc2 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Sub(int a, int b) => a - b;\n  public static int Mul(int a, int b) => a * b;\n}\n";
    public const string Calc3 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Sub(int a, int b) => a - b;\n  public static int Mul(int a, int b) => a * b;\n  public static int Div(int a, int b) => a / b;\n  public static int Mod(int a, int b) => a % b;\n}\n";

    internal sealed record FileContentChange(string Path, string Content);

    // Immutable so the shared statics can't be mutated through their array contents.
    public static readonly ImmutableArray<string> ChangedFiles = ImmutableArray.Create("src/Calc.cs");
    public static readonly ImmutableArray<string> AuthScopes = ImmutableArray.Create("repo");

    // Lock guarding every mutable field below. Public so the fakes can hold it across
    // multi-field reads.
    public object Gate { get; } = new();

    public string CurrentHeadSha { get; private set; }
    public DateTimeOffset Now { get; private set; }

    // PR open/closed/merged state. Mutated by POST /test/set-pr-state
    // to drive the closed/merged bulk-discard surface (PR5: DiscardAllDraftsButton mounts only when
    // the PR is no longer open). Surfaced by FakePrReader.GetPrDetailAsync + PollActivePrAsync.
    public PrState PrState { get; private set; }
    public bool IsClosed => PrState == PrState.Closed;
    public bool IsMerged => PrState == PrState.Merged;

    // #501 e2e-only. When true, FakePrReader / FakeSectionQueryRunner emit IsDraft=true,
    // driving the header glyph+marker and the inbox draft chip in baselines.
    public bool IsDraftPr { get; private set; }

    // (path, sha) → file content. Populated for each (path, sha) the reconciliation
    // pipeline might query. AdvanceHead adds new (path, newHead) entries.
    public Dictionary<(string Path, string Sha), string> FileContent { get; } = new();

    // Reachable shas. Force-push test scenarios drop earlier shas via SetCommitReachable
    // to simulate rewritten history.
    public HashSet<string> ReachableShas { get; } = new(StringComparer.Ordinal);

    // Iterations + commits returned by GetPrDetailAsync / GetTimelineAsync. Mutated by
    // AdvanceHead to append a new iteration.
    public List<IterationDto> Iterations { get; } = new();
    public List<CommitDto> Commits { get; } = new();

    // #214 e2e-only: extra file PATHS appended to the diff's file list so the file-TREE
    // overflows horizontally (the canonical single short path `src/Calc.cs` never does).
    // GetDiffAsync emits a trivial single-line FileChange per path. Set via
    // POST /test/seed-tree-files; cleared by Reset. Touches no production surface.
    public List<string> ExtraTreeFiles { get; } = new();

    // #285 e2e-only: when true, FakeSectionQueryRunner returns the scenario PR in the
    // "review-requested" section so the inbox is non-empty. Default OFF so existing
    // parity-baseline specs keep their empty inbox and baselines don't shift. Toggled
    // ON by POST /test/seed-inbox (which also fires RefreshAsync), reset by Reset().
    public bool InboxSeeded { get; private set; }

    public FakeReviewBackingStore()
    {
        // Initial-state assignments happen inside Reset(); ctor stays a thin delegate.
        // CurrentHeadSha / PrState need a non-null seed for the null-safety analyzer, so Reset()
        // is the single source of truth for the canonical initial state.
        CurrentHeadSha = string.Empty;
        PrState = PrState.Open;
        Reset();
    }

    // Hard-resets all mutable state back to the initial 3-iteration scenario. Called by
    // POST /test/reset between Playwright specs so each test starts from a known baseline
    // (the backend process is long-running across an entire `npx playwright test` run).
    public void Reset()
    {
        lock (Gate)
        {
            Now = DateTimeOffset.UtcNow;
            CurrentHeadSha = Sha3;
            PrState = PrState.Open;

            FileContent.Clear();
            // BaseSha: src/Calc.cs is TREATED AS empty content at BaseSha for the
            // purposes of split-mode whole-file expansion's parallel head+base fetch.
            // The file did not exist at the PR's base in canonical PRism semantics
            // (the FileChange.status is 'added' on the iteration-1 diff, so there's
            // no real base content); we seed an empty entry rather than omitting the
            // key so that GetFileContentAsync returns Ok(empty) instead of NotFound,
            // letting the parity Playwright capture run without surfacing the
            // failure banner. If a future test needs to model a true base-side
            // missing file, omit the key (Copilot iter-1).
            FileContent[("src/Calc.cs", BaseSha)] = string.Empty;
            FileContent[("src/Calc.cs", Sha1)] = Calc1;
            FileContent[("src/Calc.cs", Sha2)] = Calc2;
            FileContent[("src/Calc.cs", Sha3)] = Calc3;

            ReachableShas.Clear();
            ReachableShas.Add(BaseSha);
            ReachableShas.Add(Sha1);
            ReachableShas.Add(Sha2);
            ReachableShas.Add(Sha3);

            Commits.Clear();
            Commits.Add(new CommitDto(Sha1, "Add Calc.Add", Now.AddMinutes(-30), 4, 0));
            Commits.Add(new CommitDto(Sha2, "Add Sub + Mul", Now.AddMinutes(-20), 2, 0));
            Commits.Add(new CommitDto(Sha3, "Add Div + Mod", Now.AddMinutes(-10), 2, 0));

            Iterations.Clear();
            Iterations.Add(new IterationDto(1, BaseSha, Sha1, new List<CommitDto> { Commits[0] }, true));
            Iterations.Add(new IterationDto(2, Sha1, Sha2, new List<CommitDto> { Commits[1] }, true));
            Iterations.Add(new IterationDto(3, Sha2, Sha3, new List<CommitDto> { Commits[2] }, true));

            ExtraTreeFiles.Clear();
            InboxSeeded = false;
            IsDraftPr = false;
        }
    }

    // #285 e2e-only. Sets InboxSeeded so FakeSectionQueryRunner returns the scenario PR.
    // Called by POST /test/seed-inbox; Reset() clears it so a prior seeded test doesn't
    // leak its PR into subsequent specs.
    public void SeedInbox()
    {
        lock (Gate) { InboxSeeded = true; }
    }

    // Appends a new iteration (head shifts from current to newHeadSha) with the supplied
    // file content. Each file change adds a (path, newHeadSha) entry to FileContent; the
    // prior (path, oldHead) entries stay for reconciliation probes against the now-stale
    // anchored shas.
    public void AdvanceHead(string newHeadSha, IReadOnlyList<FileContentChange> fileChanges)
    {
        ArgumentNullException.ThrowIfNull(newHeadSha);
        ArgumentNullException.ThrowIfNull(fileChanges);
        lock (Gate)
        {
            var oldHead = CurrentHeadSha;
            CurrentHeadSha = newHeadSha;
            ReachableShas.Add(newHeadSha);
            foreach (var fc in fileChanges)
            {
                FileContent[(fc.Path, newHeadSha)] = fc.Content;
            }
            Now = Now.AddMinutes(5);
            var commit = new CommitDto(newHeadSha, $"Advance to {newHeadSha[..7]}", Now, 1, 0);
            Commits.Add(commit);
            Iterations.Add(new IterationDto(
                Iterations.Count + 1, oldHead, newHeadSha, new List<CommitDto> { commit }, true));
        }
    }

    // #214 e2e-only. Replaces the extra-tree-files list emitted by GetDiffAsync.
    public void SetExtraTreeFiles(IReadOnlyList<string> paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        lock (Gate)
        {
            ExtraTreeFiles.Clear();
            ExtraTreeFiles.AddRange(paths);
        }
    }

    // Force-push fallback simulation. When `false`, GetCommitAsync(prRef, sha) returns null
    // — the reconciliation pipeline treats that as "history rewrote" and enters
    // ForcePushFallback (every draft anchored at that sha goes Stale).
    public void SetCommitReachable(string sha, bool reachable)
    {
        ArgumentNullException.ThrowIfNull(sha);
        lock (Gate)
        {
            if (reachable) ReachableShas.Add(sha);
            else ReachableShas.Remove(sha);
        }
    }

    // Sets the PR's open/closed/merged state. "OPEN" leaves the demo flow as-is; "CLOSED" / "MERGED"
    // make PrDetailDto.Pr.IsClosed/IsMerged true so the frontend swaps the (disabled) Submit button
    // for the bulk-discard surface (PR5).
    public void SetPrState(string state)
    {
        ArgumentException.ThrowIfNullOrEmpty(state);
        PrState parsed = state.ToUpperInvariant() switch
        {
            "OPEN" => PrState.Open,
            "CLOSED" => PrState.Closed,
            "MERGED" => PrState.Merged,
            _ => throw new ArgumentException(
                $"Unknown PR state '{state}'; expected OPEN | CLOSED | MERGED.", nameof(state)),
        };
        lock (Gate) PrState = parsed;
    }

    // #501 e2e-only. Flags the scenario PR as a draft so FakePrReader / FakeSectionQueryRunner
    // emit IsDraft=true, driving the header glyph+marker and the inbox draft chip in baselines.
    public void SetDraft(bool isDraft)
    {
        lock (Gate) IsDraftPr = isDraft;
    }
}
