using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws on transport/429/403/5xx — returns empty + Degraded.
// Mirrors GitHubCiFailingDetector's degrade-don't-throw contract.
public interface IReceivedEventsReader
{
    Task<ReceivedEventsResult> ReadAsync(CancellationToken ct);
}
