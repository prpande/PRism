namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// xUnit collection definition that serialises all member test classes so that
/// process-scoped environment-variable mutations (e.g. PRISM_FILE_LOGGER_FORCE)
/// set by one class cannot be observed by a sibling class that also instantiates
/// PRismWebApplicationFactory.
/// </summary>
[CollectionDefinition("EnvVarSensitive", DisableParallelization = true)]
public sealed class EnvVarSensitiveFixture { }
