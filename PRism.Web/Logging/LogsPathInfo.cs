namespace PRism.Web.Logging;

// Singleton carrying the absolute logs directory derived from the host's dataDir.
// Registered in Program.cs BEFORE AddPRismFileLogger so the GET /api/preferences
// handler (S6 PR1, spec § 2.4) can surface the path without taking a dependency on
// FileLoggerProvider — which is intentionally not registered under Test env unless
// PRISM_FILE_LOGGER_FORCE=1 (FileLoggerExtensions.cs:30-32). Sourcing logsPath
// independently from `Path.Combine(dataDir, "logs")` matches AddPRismFileLogger's
// internal derivation. Dual-derivation invariant is asserted by
// PreferencesLogsPathDualDerivationTests so drift bites the test, not the user
// (deferral sidecar `[Risk] LogsPathInfo singleton — dual-derivation invariant`).
internal sealed record LogsPathInfo(string Path);
