using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Submit.Pipeline;

namespace PRism.Web.Submit;

// Bridges the SubmitPipeline's progress channel (IProgress<SubmitProgressEvent> — pure
// PRism.Core, no SSE awareness) to the IReviewEventBus, which SseChannel fans out as the
// `submit-progress` SSE event. Constructed per submit request inside the endpoint (the
// PrReference is per-call); not a DI singleton.
internal sealed class SseSubmitProgressBridge : IProgress<SubmitProgressEvent>
{
    private readonly PrReference _prRef;
    private readonly IReviewEventBus _bus;

    public SseSubmitProgressBridge(PrReference prRef, IReviewEventBus bus)
    {
        _prRef = prRef ?? throw new ArgumentNullException(nameof(prRef));
        _bus = bus ?? throw new ArgumentNullException(nameof(bus));
    }

    public void Report(SubmitProgressEvent value)
    {
        ArgumentNullException.ThrowIfNull(value);
        _bus.Publish(new SubmitProgressBusEvent(
            PrRef: _prRef,
            Step: value.Step,
            Status: value.Status,
            Done: value.Done,
            Total: value.Total,
            ErrorMessage: value.ErrorMessage));
    }
}
