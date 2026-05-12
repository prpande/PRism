using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Submit;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Submit;

public class SseSubmitProgressBridgeTests
{
    [Fact]
    public void Report_publishes_SubmitProgressBusEvent_with_prRef_step_status_and_counts()
    {
        var bus = new FakeReviewEventBus();
        var bridge = new SseSubmitProgressBridge(new PrReference("o", "r", 7), bus);

        bridge.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Started, 0, 4));

        var published = Assert.Single(bus.Published);
        var ev = Assert.IsType<SubmitProgressBusEvent>(published);
        Assert.Equal(new PrReference("o", "r", 7), ev.PrRef);
        Assert.Equal(SubmitStep.AttachThreads, ev.Step);
        Assert.Equal(SubmitStepStatus.Started, ev.Status);
        Assert.Equal(0, ev.Done);
        Assert.Equal(4, ev.Total);
        Assert.Null(ev.ErrorMessage);
    }

    [Fact]
    public void Report_carries_error_message_on_failed_step()
    {
        var bus = new FakeReviewEventBus();
        var bridge = new SseSubmitProgressBridge(new PrReference("o", "r", 1), bus);

        bridge.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Failed, 0, 0, ErrorMessage: "kaput"));

        var ev = Assert.IsType<SubmitProgressBusEvent>(Assert.Single(bus.Published));
        Assert.Equal(SubmitStepStatus.Failed, ev.Status);
        Assert.Equal("kaput", ev.ErrorMessage);
    }
}
