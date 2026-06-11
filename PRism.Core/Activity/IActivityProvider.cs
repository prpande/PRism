using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

public interface IActivityProvider
{
    Task<ActivityResponse> GetActivityAsync(CancellationToken ct);

    // Invalidates the cached feed so the next GetActivityAsync rebuilds from scratch.
    // Called on token-commit paths (auth/replace) so a rotated identity never serves a
    // feed built under the prior token. Must be non-blocking (see ActivityProvider.Reset).
    void Reset();
}
