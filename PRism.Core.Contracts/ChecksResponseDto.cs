using System.Collections.Generic;

namespace PRism.Core.Contracts;

public sealed record ChecksResponseDto(
    IReadOnlyList<CheckDto> Checks,
    string HeadSha,             // echoes the requested SHA (coherence dedup, see spec § Head-SHA model)
    DegradedReason Degraded);   // None = complete; Auth before Transient when sources disagree
