using System.Net;
using System.Net.Sockets;
using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class PortSelectorTests
{
    [Fact]
    public void SelectFirstAvailable_returns_a_port_in_the_default_range()
    {
        var port = PortSelector.SelectFirstAvailable();
        port.Should().BeInRange(5180, 5199);
    }

    [Fact]
    public void SelectFirstAvailable_skips_in_use_ports()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 5180);
        listener.Start();
        try
        {
            var port = PortSelector.SelectFirstAvailable();
            port.Should().NotBe(5180);
            port.Should().BeInRange(5181, 5199);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void SelectFirstAvailable_throws_when_range_is_exhausted()
    {
        var listeners = new List<TcpListener>();
        try
        {
            for (var p = 5180; p <= 5199; p++)
            {
                var l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                listeners.Add(l);
            }
            Action act = () => PortSelector.SelectFirstAvailable();
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
}
