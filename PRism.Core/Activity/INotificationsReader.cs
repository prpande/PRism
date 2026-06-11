using System;
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws on transport/429/403/5xx — returns empty + Degraded.
public interface INotificationsReader
{
    Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct);
}
