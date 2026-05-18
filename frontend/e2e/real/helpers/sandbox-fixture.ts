// Per-fixture metadata recorded in fixtures.json (locally generated, gitignored).
// One entry per fixture name (happy / foreign / lost-response / stale-oid). Fields
// are populated by setup-real-e2e-fixtures.ts (Task 11) and consumed by every spec.
export interface SandboxFixture {
  name: 'happy' | 'foreign' | 'lost-response' | 'stale-oid';
  branch: string; // e.g. "e2e-real-happy-fixture-pratyush"
  prNumber: number;
  prNodeId: string;
  baseOid: string; // commit at which the fixture branch was seeded
  anchorFile: string; // e.g. "src/Calc.cs" — file in the diff specs can comment on
  anchorLine: number;
}
