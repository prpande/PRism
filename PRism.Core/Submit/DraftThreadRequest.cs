namespace PRism.Core.Submit;

// A single new review thread to attach to a pending review (GraphQL addPullRequestReviewThread).
// SubmitPipeline builds this from a DraftComment: it injects the <!-- prism:client-id:<DraftId> -->
// marker (with unclosed-fence re-closing) into BodyMarkdown before constructing the request, so the
// adapter never sees — or has to reason about — the user-visible body. See spec § 4.
public sealed record DraftThreadRequest(
    string DraftId,           // identifies the source DraftComment; the injected marker echoes this
    string BodyMarkdown,      // already includes the <!-- prism:client-id:<DraftId> --> footer
    string FilePath,
    int LineNumber,
    string Side,              // GraphQL DiffSide: "LEFT" or "RIGHT"
    // Reserved for multi-line / range comments — both fields stay null in PoC scope.
    // Multi-line is deferred to a focused later slice or P4 (see the deferrals sidecar:
    // "[Defer] Multi-line / range comments"). Pipeline call sites wire null here today;
    // do not plumb these through from the composer or populate them from draft state.
    int? StartLine = null,
    string? StartSide = null);
