using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

public interface IActivityProvider
{
    Task<ActivityResponse> GetActivityAsync(CancellationToken ct);
}
