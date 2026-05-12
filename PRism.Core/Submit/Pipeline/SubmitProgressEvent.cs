namespace PRism.Core.Submit.Pipeline;

// Progress signal emitted by SubmitPipeline via IProgress<SubmitProgressEvent>. The endpoint
// layer (PR3) wraps an IProgress impl that projects these to `submit-progress` SSE events; the
// pipeline core never references SSE directly (spec § 5.1). Done/Total are the per-step fan-out
// counters (drafts attached / total drafts, etc.); ErrorMessage is set only on Failed.
public sealed record SubmitProgressEvent(
    SubmitStep Step,
    SubmitStepStatus Status,
    int Done,
    int Total,
    string? ErrorMessage = null);
