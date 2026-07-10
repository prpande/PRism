using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using PRism.Core;
using PRism.Core.Activity;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.GitHub;

namespace PRism.Web.Endpoints;

internal static class PrDetailEndpoints
{
    public static IEndpointRouteBuilder MapPrDetail(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}",
            async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
            {
                var snapshot = await loader.LoadAsync(new PrReference(owner, repo, number), ct).ConfigureAwait(false);
                if (snapshot is null)
                    return Results.Problem(type: "/pr/not-found", statusCode: 404);
                return Results.Ok(snapshot.Detail);
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/diff",
            async (string owner, string repo, int number,
                   [FromQuery] string? range,
                   PrDetailLoader loader, CancellationToken ct) =>
            {
                if (string.IsNullOrEmpty(range))
                    return Results.Problem(type: "/diff/missing-range", statusCode: 422);

                var parts = range.Split("..");
                if (parts.Length != 2 || !IsValidGitOid(parts[0]) || !IsValidGitOid(parts[1]))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                try
                {
                    var diff = await loader.GetOrFetchDiffAsync(prRef, new DiffRangeRequest(parts[0], parts[1]), ct)
                        .ConfigureAwait(false);
                    return Results.Ok(diff);
                }
                catch (RangeUnreachableException)
                {
                    // The requested (base..head) pair is no longer addressable on GitHub
                    // (force-push GC'd the commits). Spec § 5.1: render the typed message,
                    // not a 500. 422 Unprocessable is consistent with the /file endpoint's
                    // other typed 422s in this file. The frontend branches on this `type`
                    // to show "this diff is unavailable" instead of the generic error banner.
                    return Results.Problem(type: "/diff/range-unreachable", statusCode: 422);
                }
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/file",
            async (string owner, string repo, int number,
                   [FromQuery] string? path, [FromQuery] string? sha,
                   PrDetailLoader loader, IPrReader review, CancellationToken ct) =>
            {
                if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(sha))
                    return Results.Problem(type: "/file/missing-params", statusCode: 422);
                // Validate sha consistently with /diff?range=. GitHub would reject malformed
                // SHAs anyway, but rejecting at the edge avoids an unnecessary REST round-trip.
                if (!IsValidGitOid(sha))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);

                // #510: authorize against the diff memo, NOT a live snapshot. The diff memo is
                // content-addressed by (prRef, range) and is never evicted by background
                // activity — the poller head/comment-count change, comment post-now,
                // root-comment post, and draft submit all call Invalidate, which drops only the
                // per-(prRef,headSha,gen) snapshot (see PrDetailLoader). Serving file content
                // needs only the sha (GetFileContentAsync fetches the blob directly), so the
                // common "expand a file I'm already viewing" path must not dead-end on a
                // snapshot the background machinery dropped out from under it.
                if (!loader.IsPathInAnyCachedDiff(prRef, path))
                {
                    // Path is outside any diff visited this session. Classifying it
                    // (truncation-window vs not-in-diff) needs the canonical base..head range,
                    // which lives on the snapshot. #510: re-hydrate on demand if a background
                    // event evicted the snapshot, rather than surfacing the manual-reload
                    // /file/snapshot-evicted dead-end. Only surface snapshot-evicted when
                    // re-hydration also fails (LoadAsync => null: the PR no longer exists).
                    var snapshot = await loader.GetOrLoadSnapshotAsync(prRef, ct).ConfigureAwait(false);
                    if (snapshot is null)
                        return Results.Problem(type: "/file/snapshot-evicted", statusCode: 422);

                    // Determine whether the canonical (base..head) diff was truncated; if it
                    // was, the path may legitimately be in the PR's diff but landed outside
                    // the cached file list. Spec § 8.
                    // RangeUnreachableException: the canonical base..head range is no longer
                    // addressable on GitHub (force-push GC'd the commits). Map to the same
                    // typed 422 the /diff endpoint returns — the frontend branches on this
                    // `type` to show "this diff is unavailable". Scoped narrowly to this
                    // one call so other exceptions still propagate.
                    var canonicalRange = new DiffRangeRequest(snapshot.Detail.Pr.BaseSha, snapshot.Detail.Pr.HeadSha);
                    DiffDto canonical;
                    try
                    {
                        canonical = await loader.GetOrFetchDiffAsync(prRef, canonicalRange, ct).ConfigureAwait(false);
                    }
                    catch (RangeUnreachableException)
                    {
                        return Results.Problem(type: "/diff/range-unreachable", statusCode: 422);
                    }
                    var problemType = canonical.Truncated ? "/file/truncation-window" : "/file/not-in-diff";
                    return Results.Problem(type: problemType, statusCode: 422);
                }

                var result = await review.GetFileContentAsync(prRef, path, sha, ct).ConfigureAwait(false);
                return result.Status switch
                {
                    // text/plain regardless of extension — the diff pane and the markdown view
                    // both render server content client-side. Setting text/markdown for `.md`
                    // would change browser auto-rendering and break the toggle between
                    // rendered-markdown and raw-diff views the spec requires.
                    FileContentStatus.Ok        => Results.Text(result.Content!, "text/plain"),
                    FileContentStatus.NotFound  => Results.Problem(type: "/file/missing", statusCode: 404),
                    FileContentStatus.TooLarge  => Results.Problem(type: "/file/too-large", statusCode: 413),
                    FileContentStatus.Binary    => Results.Problem(type: "/file/binary", statusCode: 415),
                    FileContentStatus.NotInDiff => Results.Problem(type: "/file/not-in-diff", statusCode: 422),
                    _                           => Results.Problem(statusCode: 500),
                };
            });

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/mark-viewed",
            async (string owner, string repo, int number,
                   MarkViewedRequest body,
                   HttpContext httpContext,
                   PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
            {
                if (stateStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                // Validate X-PRism-Tab-Id header (TabStamps § 3 allowlist). Missing or
                // out-of-allowlist values get the distinct /viewed/tab-id-missing 422 (vs the
                // snapshot/stale-sha 422s above) so the frontend can surface a "your browser tab
                // is in an unexpected state, reload" toast for the wire-up regression case without
                // conflating it with PR-detail staleness.
                if (!TabStamps.TryValidateTabId(httpContext.Request, out var tabId))
                    return Results.Problem(type: "/viewed/tab-id-missing", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                // Unlike /file and /files/viewed, this path does NOT re-hydrate an evicted snapshot —
                // not because re-hydration would mask a stale head (it would not: LoadAsync re-reads
                // the live detail head, so the 409 below still fires), but because it does not need to.
                // usePrDetail fires this fire-and-forget from inside getPrDetail's .then(), i.e.
                // immediately after the GET that warmed the snapshot, so its eviction window is a
                // narrow race rather than a window the user can sit in.
                var snapshot = loader.TryGetCachedSnapshot(prRef);
                if (snapshot is null)
                    return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
                if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                var key = $"{owner}/{repo}/{number}";
                try
                {
                    await stateStore.UpdateAsync(state =>
                    {
                        var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? PrDraftEndpoints.NewEmptySession();

                        // Write the caller's tab stamp; TabStamps.Write caps at
                        // TabStamps.MaxTabStamps entries by evicting the oldest StampedAtUtc. The
                        // cap protects against state.json bloat if a misbehaving extension or test
                        // fixture keeps minting fresh tab ids.
                        var tabStamps = TabStamps.Write(session.TabStamps, tabId, body.HeadSha, DateTime.UtcNow);

                        // Session-flat LastSeenCommentId is the inbox unread-badge anchor;
                        // monotone guard prevents a stale per-tab value from rewinding the
                        // high-water (two tabs at different PR-detail polls can drift, but the
                        // user-facing unread badge must never increase).
                        var newSeen = MonotonicCommentId.Max(session.LastSeenCommentId, body.MaxCommentId);

                        var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with
                        {
                            TabStamps = tabStamps,
                            LastSeenCommentId = newSeen,
                        };
                        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
                    }, ct).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
                {
                    // TOCTOU: another process wrote a future-version state.json between the
                    // pre-check above and AppStateStore acquiring its gate. Surface the
                    // canonical 423 so the frontend's read-only-mode banner fires instead of
                    // a generic 500. AppStateStore.UpdateAsync uses this exception shape
                    // exclusively for the read-only refusal.
                    return Results.Problem(type: "/state/read-only", statusCode: 423);
                }

                return Results.NoContent();
            }).WithMetadata(new RequestSizeLimitAttribute(EndpointExtensions.MutatingBodyCapBytes));   // P2.3 — 16 KiB cap

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/files/viewed",
            async (string owner, string repo, int number,
                   FileViewedRequest body,
                   PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
            {
                if (stateStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                // Spec § 8: "path > 4096 bytes" — UTF-8 byte count, not C# char count, so
                // a 4096-char string of multi-byte CJK characters can't bypass the cap.
                if (string.IsNullOrEmpty(body.Path))
                    return Results.Problem(type: "/viewed/path-invalid", statusCode: 422);
                if (Encoding.UTF8.GetByteCount(body.Path) > 4096)
                    return Results.Problem(type: "/viewed/path-too-long", statusCode: 422);

                var canonical = CanonicalizePath(body.Path);
                if (canonical is null)
                    return Results.Problem(type: "/viewed/path-invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                // Re-hydrate an evicted snapshot rather than refusing the write (#510's /file fix,
                // applied here). The ActivePrPoller evicts on its own CommentCountChanged tick —
                // which fires for the user's OWN inline comment and has no client reload behind it —
                // so the snapshot stayed gone while the user sat on the PR and every checkbox
                // silently rolled back. Re-hydration cannot launder a stale mark: LoadAsync re-reads
                // the live DETAIL head (the same head the frontend stamped from GET /api/pr), so a
                // body stamped at a superseded head still fails the equality check below with 409.
                var snapshot = await loader.GetOrLoadSnapshotAsync(prRef, ct).ConfigureAwait(false);
                if (snapshot is null)
                    return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
                if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                if (!loader.IsPathInAnyCachedDiff(prRef, canonical))
                    return Results.Problem(type: "/viewed/path-not-in-diff", statusCode: 422);

                var key = $"{owner}/{repo}/{number}";
                IResult? capExceeded = null;
                try
                {
                    await stateStore.UpdateAsync(state =>
                    {
                        var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? PrDraftEndpoints.NewEmptySession();
                        // #605 item F — prune superseded-SHA entries on write. The map is path→head-SHA;
                        // stale-head entries (from prior iterations) otherwise accumulate toward the
                        // 10000 cap and round-trip in full to the frontend. body.HeadSha was already
                        // verified equal to the current snapshot head above, so it is the live head;
                        // keep only entries recorded at it. The FE already filters to head-matched
                        // entries (useFileViewState.ts), so this is a pure size win with no visible
                        // behavior change. Pruning before the cap check also lets the pruned size, not
                        // the stale-bloated size, gate the cap.
                        var viewedFiles = session.ViewedFiles
                            .Where(kv => string.Equals(kv.Value, body.HeadSha, StringComparison.Ordinal))
                            .ToDictionary(kv => kv.Key, kv => kv.Value);

                        if (body.Viewed)
                        {
                            if (viewedFiles.Count >= 10000 && !viewedFiles.ContainsKey(canonical))
                            {
                                capExceeded = Results.Problem(type: "/viewed/cap-exceeded", statusCode: 422);
                                return state;
                            }
                            viewedFiles[canonical] = body.HeadSha;
                        }
                        else
                        {
                            viewedFiles.Remove(canonical);
                        }

                        var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with { ViewedFiles = viewedFiles };
                        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
                    }, ct).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
                {
                    // Same TOCTOU recovery as mark-viewed above.
                    return Results.Problem(type: "/state/read-only", statusCode: 423);
                }

                return capExceeded ?? Results.NoContent();
            }).WithMetadata(new RequestSizeLimitAttribute(EndpointExtensions.MutatingBodyCapBytes));

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/checks",
            async (string owner, string repo, int number,
                   [FromQuery] string? sha,
                   IPrChecksReader checks, CancellationToken ct) =>
            {
                // Validate path params (owner/repo, which form the GitHub REST path) BEFORE the
                // query param (sha), so the trust boundary reads outermost-first (security S1).
                if (!SharedRegexes.OwnerRepo().IsMatch(owner) || !SharedRegexes.OwnerRepo().IsMatch(repo))
                    return Results.Problem(type: "/owner-repo/invalid", statusCode: 422);
                if (string.IsNullOrEmpty(sha))
                    return Results.Problem(type: "/checks/missing-sha", statusCode: 422);
                if (!IsValidGitOid(sha))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var result = await checks.ReadAsync(prRef, sha, ct).ConfigureAwait(false);
                return Results.Ok(result);
            });

        // Unified newest-first PR activity timeline (#620). pageSize is fixed server-side —
        // not client-bound — so a caller can't request an oversized page. Degraded reads
        // surface as 502 rather than a false-empty 200 (see TimelinePage.Degraded).
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/timeline",
            async (string owner, string repo, int number,
                   [FromQuery] string? cursor,
                   IPrTimelineFeedReader timeline, CancellationToken ct) =>
            {
                if (!SharedRegexes.OwnerRepo().IsMatch(owner) || !SharedRegexes.OwnerRepo().IsMatch(repo))
                    return Results.Problem(type: "/owner-repo/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var page = await timeline.ReadPageAsync(prRef, cursor, pageSize: 30, ct).ConfigureAwait(false);
                if (page.Degraded)
                    return Results.Problem(type: "/timeline/upstream-unavailable", statusCode: 502);
                return Results.Ok(page);
            });

        // Re-run a single check (#636). Write path; inherits OriginCheckMiddleware +
        // SessionTokenMiddleware from the pipeline like every other mutation. Same
        // outermost-first validation order as the GET above (owner/repo before sha).
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/checks/{checkRunId:long}/rerun",
            async (string owner, string repo, int number, long checkRunId,
                   [FromQuery] string? sha,
                   IPrChecksRerunner rerunner, CancellationToken ct) =>
            {
                if (!SharedRegexes.OwnerRepo().IsMatch(owner) || !SharedRegexes.OwnerRepo().IsMatch(repo))
                    return Results.Problem(type: "/owner-repo/invalid", statusCode: 422);
                if (string.IsNullOrEmpty(sha))
                    return Results.Problem(type: "/checks/missing-sha", statusCode: 422);
                if (!IsValidGitOid(sha))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var result = await rerunner.RerunAsync(prRef, checkRunId, sha, ct).ConfigureAwait(false);
                return Results.Ok(result); // ambient API JsonSerializerOptions → kebab enum
            });

        return app;
    }

    private static bool IsValidGitOid(string s) =>
        // SHA-1 (40 hex) or SHA-256 (64 hex). Anything else → 422 /sha/invalid.
        SharedRegexes.Sha40().IsMatch(s) || SharedRegexes.Sha64().IsMatch(s);

    private static string? CanonicalizePath(string path)
    {
        // Spec § 8 — 7-rule canonicalization. Inputs arrive post-URL-decode (ASP.NET decodes
        // %2E etc. before model binding); rules apply to the decoded form.
        //   1. Any segment equals ".." or "."
        //   2. Empty path
        //   3. Leading "/"
        //   4. Trailing "/"
        //   5. NUL byte (subsumed by C0 control-char check)
        //   6. C0/C1 control chars (U+0000..U+001F or U+007F..U+009F)
        //   7. Backslash
        //   + NFC byte-length mismatch (defends against decomposed-Unicode allowlist bypass)
        if (string.IsNullOrEmpty(path)) return null;
        if (path.StartsWith('/') || path.EndsWith('/')) return null;
        if (path.Contains('\\', StringComparison.Ordinal)) return null;
        foreach (var c in path)
        {
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return null;
        }
        var segments = path.Split('/');
        foreach (var s in segments)
        {
            // Reject `..`, `.`, AND empty segments — `src//Foo.cs` has an empty segment
            // that wouldn't appear in any real GitHub diff entry, so closing the gap keeps
            // the validator's contract tight.
            if (s.Length == 0 || s == ".." || s == ".") return null;
        }

        var nfc = path.Normalize(NormalizationForm.FormC);
        if (Encoding.UTF8.GetByteCount(nfc) != Encoding.UTF8.GetByteCount(path)) return null;
        return nfc;
    }
}
