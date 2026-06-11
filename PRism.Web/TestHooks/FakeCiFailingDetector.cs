using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Web.TestHooks;

// Test-only ICiFailingDetector — reports no CI, complete. Never hits GitHub.
internal sealed class FakeCiFailingDetector : ICiFailingDetector
{
    public Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
    {
        ArgumentNullException.ThrowIfNull(items);
        return Task.FromResult(new CiDetectResult(
            items.Select(i => (i, CiStatus.None)).ToList(), Complete: true));
    }
}
