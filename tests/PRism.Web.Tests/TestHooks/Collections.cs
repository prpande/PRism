using Xunit;

namespace PRism.Web.Tests.TestHooks;

// Serializes test classes that mutate process-wide env vars. xUnit parallelizes test classes
// by default; without a shared CollectionDefinition, RealInjectAppFactory and
// ProgramMutexCheckTests can race on PRISM_E2E_REAL_INJECT / PRISM_E2E_FAKE_REVIEW.
[CollectionDefinition("EnvVarMutating", DisableParallelization = true)]
#pragma warning disable CA1711 // 'Collection' suffix is xUnit's idiomatic naming for [CollectionDefinition] types
public sealed class EnvVarMutatingCollection { }
#pragma warning restore CA1711
