using System.Net;
using System.Net.Sockets;

namespace PRism.Core.Hosting;

public static class PortSelector
{
    public const int DefaultFrom = 5180;
    public const int DefaultTo = 5199;

    public static int SelectFirstAvailable(int from = DefaultFrom, int to = DefaultTo)
    {
        for (var port = from; port <= to; port++)
        {
            if (IsPortFree(port)) return port;
        }
        throw new PortRangeExhaustedException(from, to);
    }

    private static bool IsPortFree(int port)
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
