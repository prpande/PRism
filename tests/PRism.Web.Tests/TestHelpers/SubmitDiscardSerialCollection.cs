namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// xUnit collection definition that serialises PrSubmitDiscardEndpointTests so that
/// its mutation of the global mutable static <c>DiscardTimeouts.LockAcquireTimeout</c>
/// (used to make the 504 path testable without a real 30-second wait) cannot race against
/// any other test class that might exercise the /submit/discard endpoint concurrently.
/// </summary>
[CollectionDefinition("SubmitDiscardSerial", DisableParallelization = true)]
#pragma warning disable CA1711 // 'Collection' suffix is xUnit's idiomatic naming for [CollectionDefinition] types
public sealed class SubmitDiscardSerialCollection { }
#pragma warning restore CA1711
