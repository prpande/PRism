using System.Diagnostics;

namespace PRism.Core.Hosting;

/// <summary>
/// Recycle-resistant check that a parent process (the Electron shell) is still the
/// same live process. Captures the parent's start-time at arm-time; a later PID hit
/// with a different start-time means the PID was recycled — treated as "parent dead".
/// </summary>
public sealed class ParentLivenessProbe
{
    private readonly int _parentPid;
    private readonly DateTime _armedStart;
    private readonly Func<int, DateTime?> _startTimeOf;

    private ParentLivenessProbe(int parentPid, DateTime armedStart, Func<int, DateTime?> startTimeOf)
    {
        _parentPid = parentPid;
        _armedStart = armedStart;
        _startTimeOf = startTimeOf;
    }

    /// <summary>Arm against a parent PID. Returns null if the parent is already gone.</summary>
    public static ParentLivenessProbe? Arm(int parentPid, Func<int, DateTime?> startTimeOf)
    {
        ArgumentNullException.ThrowIfNull(startTimeOf);
        var start = startTimeOf(parentPid);
        return start is null ? null : new ParentLivenessProbe(parentPid, start.Value, startTimeOf);
    }

    /// <summary>Real-process accessor for production use.</summary>
    public static DateTime? StartTimeOfProcess(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.StartTime.ToUniversalTime();
        }
        catch (ArgumentException) { return null; }        // no such process
        catch (InvalidOperationException) { return null; } // exited between lookup and read
    }

    public bool IsParentAlive()
    {
        var now = _startTimeOf(_parentPid);
        return now is not null && now.Value == _armedStart;
    }
}
