using System.Diagnostics.CodeAnalysis;

using PRism.Core.Reconciliation.Pipeline.Steps;
using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline;

public sealed class DraftReconciliationPipeline
{
    [SuppressMessage("Performance", "CA1822:Mark members as static",
        Justification = "Pipeline is the DI seam consumed by PR3's reload endpoint; instance method preserves the registration shape even though the current implementation is stateless.")]
    public async Task<ReconciliationResult> ReconcileAsync(
        ReviewSessionState session,
        string newHeadSha,
        IFileContentSource fileSource,
        CancellationToken ct,
        IReadOnlyDictionary<string, string>? renames = null,
        IReadOnlySet<string>? deletedPaths = null,
        string? callerTabId = null)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentException.ThrowIfNullOrEmpty(newHeadSha);
        ArgumentNullException.ThrowIfNull(fileSource);

        renames ??= new Dictionary<string, string>();
        deletedPaths ??= new HashSet<string>();

        // Override-on-head-shift clearing per spec § 3.2 — "the override only applies to one
        // anchor state." Spec wording places this in the apply-result step (Phase 2 of § 3.3);
        // the plan moves it to the pipeline so the result DTO carries the cleared flag back to
        // the apply step. Behavior is equivalent.
        //
        // Three-branch head-shift derivation (spec § 5.4):
        //   1. callerTabId provided AND session.TabStamps[callerTabId] exists → compare that
        //      tab's HeadSha against newHeadSha. This is the per-tab gate: only the caller's
        //      own stamp can produce a head shift for them.
        //   2. session.TabStamps is empty → no stamp exists yet (first reload). Not a shift.
        //   3. Fallback: callerTabId is null OR the caller has no stamp but other tabs do.
        //      Use the most-recent stamp across all tabs as the head-shift baseline. This is
        //      a transitional safety net for reload paths that haven't been threaded with a
        //      tab id yet; once Task 5 + Task 10 are complete every real reload carries a
        //      callerTabId, and the fallback only fires for pipeline unit tests with no tab.
        var sessionHeadShaForShift = HeadShaForShift(session, callerTabId);
        bool headShifted = sessionHeadShaForShift is not null && sessionHeadShaForShift != newHeadSha;
        if (headShifted)
        {
            session = session with
            {
                DraftComments = session.DraftComments
                    .Select(d => d.IsOverriddenStale ? d with { IsOverriddenStale = false } : d)
                    .ToList(),
                DraftReplies = session.DraftReplies
                    .Select(r => r.IsOverriddenStale ? r with { IsOverriddenStale = false } : r)
                    .ToList(),
            };
        }

        // Per-call caches. The file cache value type is nullable so a null fetch (file
        // doesn't exist at SHA) is recorded and not re-fetched if multiple drafts on the
        // same missing (filePath, sha) appear in the session — relevant once PR3 wires
        // ReviewServiceFileContentSource against GitHub.
        var fileCache = new Dictionary<(string, string), string?>();
        var reachabilityCache = new Dictionary<string, bool>();

        var reconciledDrafts = new List<ReconciledDraft>();
        foreach (var draft in session.DraftComments)
        {
            // PR-root drafts (no anchor) pass through. Their override flag — whether cleared
            // above by head-shift or carried in fresh — is observationally inert because
            // PR-root drafts can never become Stale through reconciliation. #324 — consume the
            // canonical FilePath-only predicate (DraftComment.IsPrRoot); this is the discriminator
            // this comment historically documented as "the only field that distinguishes them".
            if (draft.IsPrRoot)
            {
                reconciledDrafts.Add(new ReconciledDraft(
                    Id: draft.Id,
                    Status: draft.Status,
                    ResolvedFilePath: null,
                    ResolvedLineNumber: null,
                    ResolvedAnchoredSha: draft.AnchoredSha,
                    AlternateMatchCount: 0,
                    StaleReason: null,
                    ForcePushFallbackTriggered: false,
                    IsOverriddenStale: draft.IsOverriddenStale));
                continue;
            }

            // Defensive null-anchor guard. The ReviewSessionState schema permits null on
            // AnchoredSha / AnchoredLineContent / LineNumber for PR-root drafts (FilePath
            // is the only field that distinguishes them), so a malformed line-anchored
            // draft (FilePath set + any anchor field null) would crash the per-draft body
            // via the ! null-forgiving operators on the standard / force-push paths. Treat
            // as Stale (NoMatch) to keep the per-draft loop isolated — the user can re-anchor
            // manually. Preserve draft.FilePath and draft.LineNumber so PR3's apply step
            // renders the Stale row at the user's original location.
            if (draft.AnchoredSha is null || draft.AnchoredLineContent is null || draft.LineNumber is null)
            {
                reconciledDrafts.Add(MakeStale(
                    draft,
                    StaleReason.NoMatch,
                    forcePush: false,
                    resolvedFilePath: draft.FilePath,
                    resolvedLineNumber: draft.LineNumber));
                continue;
            }

            try
            {
                // Step 1: file resolution (rename / delete / exists).
                var fileResult = FileResolution.Resolve(draft.FilePath, renames, deletedPaths);
                if (!fileResult.Resolved)
                {
                    // File deleted from the PR. Preserve draft.FilePath (the old path the
                    // user anchored to) and draft.LineNumber so PR3 can render the stale
                    // row at the deletion site instead of mistaking it for a PR-root draft.
                    reconciledDrafts.Add(MakeStale(
                        draft,
                        fileResult.StaleReason!.Value,
                        forcePush: false,
                        resolvedFilePath: draft.FilePath,
                        resolvedLineNumber: draft.LineNumber));
                    continue;
                }

                // Step 2: SHA reachability probe (against the draft's anchored SHA, not the new head).
                bool reachable = await GetCachedReachable(draft.AnchoredSha, fileSource, reachabilityCache, ct).ConfigureAwait(false);

                string? newContent = await GetCachedContent(
                    fileResult.ResolvedPath!, newHeadSha, fileSource, fileCache, ct).ConfigureAwait(false);

                if (newContent is null)
                {
                    // File doesn't exist at newHeadSha — covers the "deleted at this SHA but not in
                    // the renames map" case (e.g., file was added then removed in a series of pushes
                    // without being in this PR's rename list). Preserve the resolved path (the
                    // post-rename location, if any) and the original line so PR3 can render
                    // the stale row at the user's anchor target.
                    reconciledDrafts.Add(MakeStale(
                        draft,
                        StaleReason.FileDeleted,
                        forcePush: !reachable,
                        resolvedFilePath: fileResult.ResolvedPath,
                        resolvedLineNumber: draft.LineNumber));
                    continue;
                }

                if (!reachable)
                {
                    // Force-push fallback: anchored SHA is gone from the commit graph. Override does
                    // not apply — anchor reasoning is broken — so IsOverriddenStale is cleared.
                    var fb = ForcePushFallback.Apply(newContent, draft.AnchoredLineContent, fileResult.ResolvedPath!);
                    reconciledDrafts.Add(new ReconciledDraft(
                        Id: draft.Id,
                        Status: fb.Status,
                        ResolvedFilePath: fb.Status == DraftStatus.Stale ? null : fileResult.ResolvedPath,
                        ResolvedLineNumber: fb.ResolvedLine,
                        ResolvedAnchoredSha: fb.Status == DraftStatus.Stale ? draft.AnchoredSha : newHeadSha,
                        AlternateMatchCount: 0,
                        StaleReason: fb.StaleReason,
                        ForcePushFallbackTriggered: true,
                        IsOverriddenStale: false));
                    continue;
                }

                // Standard path: line matching + classification against the seven-row matrix.
                var matches = LineMatching.Compute(newContent, draft.LineNumber.Value, draft.AnchoredLineContent, fileResult.ResolvedPath!);
                var cls = Classifier.Classify(matches, draft.LineNumber.Value);

                // Override gate: the matrix said Stale but the user previously clicked "Keep anyway"
                // and the head has not shifted (otherwise the override was already cleared above).
                // Short-circuit to Draft and preserve the override. If the matrix did NOT say Stale,
                // the override is no longer needed (content re-anchors cleanly) — clear it.
                DraftStatus finalStatus = cls.Status;
                bool overrideStillSet = false;
                if (cls.Status == DraftStatus.Stale && draft.IsOverriddenStale)
                {
                    finalStatus = DraftStatus.Draft;
                    overrideStillSet = true;
                }

                reconciledDrafts.Add(new ReconciledDraft(
                    Id: draft.Id,
                    Status: finalStatus,
                    ResolvedFilePath: fileResult.ResolvedPath,
                    ResolvedLineNumber: cls.ResolvedLine,
                    ResolvedAnchoredSha: newHeadSha,
                    AlternateMatchCount: cls.AlternateMatchCount,
                    StaleReason: finalStatus == DraftStatus.Stale ? cls.StaleReason : null,
                    ForcePushFallbackTriggered: false,
                    IsOverriddenStale: overrideStillSet));
            }
            catch (OperationCanceledException)
            {
                // Cooperative cancellation — propagate.
                throw;
            }
#pragma warning disable CA1031 // Do not catch general exception types
            catch (Exception)
#pragma warning restore CA1031
            {
                // Per-draft isolation at the IFileContentSource boundary. PR3 wires the
                // adapter to GitHub; transient failures (network, rate-limit, deserialize)
                // on draft N should not abort reconciliation for the other N-1 drafts.
                // Treat as Stale (NoMatch) — the user re-anchors or retries Reload manually.
                // Preserve original location metadata so PR3 renders the row in place.
                reconciledDrafts.Add(MakeStale(
                    draft,
                    StaleReason.NoMatch,
                    forcePush: false,
                    resolvedFilePath: draft.FilePath,
                    resolvedLineNumber: draft.LineNumber));
            }
        }

        // Replies — PR2 scope: pass-through. PR3 wires existingThreadIds to detect
        // ParentThreadDeleted (parent thread deleted out-of-band → Stale).
        var reconciledReplies = session.DraftReplies
            .Select(r => new ReconciledReply(r.Id, r.Status, null, r.IsOverriddenStale))
            .ToList();

        // Verdict reconcile: head shifted while a verdict was set → user must re-confirm.
        // Mirrors the override head-shift derivation above (HeadShaForShift) for the same
        // first-reload-doesn't-count and three-branch reasons. Currently unreachable through
        // normal user flow (verdict requires viewing the PR which sets a stamp), but keeping
        // the two head-shift checks symmetric prevents the asymmetric pattern from becoming a
        // latent trap when downstream tasks evolve the endpoint.
        bool verdictHeadShifted = headShifted;   // reuse the same derivation; identical semantics
        var verdictOutcome =
            session.DraftVerdict is not null && verdictHeadShifted
                ? VerdictReconcileOutcome.NeedsReconfirm
                : VerdictReconcileOutcome.Unchanged;

        return new ReconciliationResult(reconciledDrafts, reconciledReplies, verdictOutcome);
    }

    // Spec § 5.4 — three-branch head-shift baseline. Encapsulated as a static helper so the
    // override and verdict checks share exactly one definition and the branch comments stay in
    // one place.
    private static string? HeadShaForShift(ReviewSessionState session, string? callerTabId)
    {
        // Branch 1: caller's tab has a stamp → that's the baseline.
        if (callerTabId is not null && session.TabStamps.TryGetValue(callerTabId, out var stamp))
            return stamp.HeadSha;

        // Branch 2: no stamps at all → first reload, no head to shift from.
        if (session.TabStamps.Count == 0)
            return null;

        // Branch 3: caller has no stamp but other tabs do → fall back to the most recent
        // across all tabs. Transitional for pipeline unit tests and any reload path that
        // hasn't been threaded with a callerTabId yet (Tasks 5 + 10 close those gaps).
        return session.TabStamps
            .Values
            .OrderByDescending(s => s.StampedAtUtc)
            .FirstOrDefault()?.HeadSha;
    }

    private static ReconciledDraft MakeStale(
        DraftComment draft,
        StaleReason reason,
        bool forcePush,
        string? resolvedFilePath,
        int? resolvedLineNumber)
        => new(
            Id: draft.Id,
            Status: DraftStatus.Stale,
            ResolvedFilePath: resolvedFilePath,
            ResolvedLineNumber: resolvedLineNumber,
            ResolvedAnchoredSha: draft.AnchoredSha,
            AlternateMatchCount: 0,
            StaleReason: reason,
            ForcePushFallbackTriggered: forcePush,
            IsOverriddenStale: false);

    private static async Task<string?> GetCachedContent(
        string filePath, string sha,
        IFileContentSource source,
        Dictionary<(string, string), string?> cache,
        CancellationToken ct)
    {
        if (cache.TryGetValue((filePath, sha), out var cached)) return cached;
        var fetched = await source.GetAsync(filePath, sha, ct).ConfigureAwait(false);
        cache[(filePath, sha)] = fetched;
        return fetched;
    }

    private static async Task<bool> GetCachedReachable(
        string sha,
        IFileContentSource source,
        Dictionary<string, bool> cache,
        CancellationToken ct)
    {
        if (cache.TryGetValue(sha, out var cached)) return cached;
        var reachable = await source.IsCommitReachableAsync(sha, ct).ConfigureAwait(false);
        cache[sha] = reachable;
        return reachable;
    }
}
