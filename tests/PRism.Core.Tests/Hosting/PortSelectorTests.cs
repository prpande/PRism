using System.Net;
using System.Net.Sockets;
using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class PortSelectorTests
{
    // These tests exercise the selection ALGORITHM over a dynamically-discovered,
    // isolated high port range — NOT the production 5180-5199 band. Binding real
    // ports in 5180-5199 made the suite collide with any running PRism app (or a
    // parallel agent's app) on those ports, which is exactly the parallelism #217
    // is meant to enable. A constants test pins the production range separately,
    // so the contract is still covered without an environment dependency.

    [Fact]
    public void Default_range_is_5180_to_5199()
    {
        PortSelector.DefaultFrom.Should().Be(5180);
        PortSelector.DefaultTo.Should().Be(5199);
    }

    [Fact]
    public void SelectFirstAvailable_returns_the_lowest_free_port_in_the_range()
    {
        var basePort = FindFreeRange(3);
        var port = PortSelector.SelectFirstAvailable(basePort, basePort + 2);
        port.Should().Be(basePort);
    }

    [Fact]
    public void SelectFirstAvailable_skips_in_use_ports()
    {
        var basePort = FindFreeRange(2);
        using var listener = new TcpListener(IPAddress.Loopback, basePort);
        listener.Start();
        try
        {
            var port = PortSelector.SelectFirstAvailable(basePort, basePort + 1);
            port.Should().Be(basePort + 1);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void SelectFirstAvailable_throws_when_range_is_exhausted()
    {
        var basePort = FindFreeRange(2);
        var listeners = new List<TcpListener>();
        try
        {
            for (var p = basePort; p <= basePort + 1; p++)
            {
                var l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                listeners.Add(l);
            }
            Action act = () => PortSelector.SelectFirstAvailable(basePort, basePort + 1);
            act.Should().Throw<PortRangeExhaustedException>();
        }
        finally
        {
            foreach (var l in listeners)
            {
                l.Stop();
                l.Dispose();
            }
        }
    }

    // Scan high, randomized ports for `count` contiguous free ones so the test is
    // immune to whatever holds the production band (e.g. a parallel agent's app).
    private static int FindFreeRange(int count)
    {
        for (var attempt = 0; attempt < 500; attempt++)
        {
            // Guid-hash start (not Random — CA5394) spreads the scan base across
            // 20000-54999 so concurrent test processes rarely pick the same block.
            var basePort = 20000 + ((Guid.NewGuid().GetHashCode() & 0x7FFFFFFF) % 35000);
            if (basePort + count - 1 > 65535)
            {
                continue;
            }
            var allFree = true;
            for (var p = basePort; p < basePort + count; p++)
            {
                if (!IsFree(p))
                {
                    allFree = false;
                    break;
                }
            }
            if (allFree)
            {
                return basePort;
            }
        }
        throw new InvalidOperationException($"Could not find {count} contiguous free ports for the test.");
    }

    private static bool IsFree(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
