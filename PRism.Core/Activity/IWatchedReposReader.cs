using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws — returns empty + Degraded.
public interface IWatchedReposReader
{
    Task<WatchedReposResult> ReadAsync(CancellationToken ct);
}
