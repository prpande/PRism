# Desktop sidecar lifecycle hardening (#336)

**Status:** spec — B2 gate passed 2026-06-12; **Finding-2 model: B (per-phase named budget)** chosen by owner (preserves ~30s cold-start headroom, #282)
**Issue:** [#336](https://github.com/prpande/PRism/issues/336) (epic [#317](https://github.com/prpande/PRism/issues/317))
**Tier / Risk:** T2 — gated B2 (touches `desktop/src/sidecar.ts`, a desktop-sidecar seam per `.ai/docs/issue-resolution-workflow.md`).

## Problem

Three lifecycle defects in `desktop/src/sidecar.ts` / `ports.ts`, all verified against
source and now pinned by red-on-main tests:

1. **Chunk-boundary port truncation (Medium).** `readPortFromStdout` parses every element
   of `buf.split(/\r?\n/)`, including the trailing *partial* line, and `parsePortFromLine`'s
   regex has no end anchor. If a stdout chunk boundary lands inside the port digits
   (`…:51` + `83 (dataDir…)`), the first chunk parses as port **51**; the shell then
   health-polls the wrong port until the startup timeout and dies with a generic error.
2. **Startup timeout silently doubles (Medium).** `opts.startTimeoutMs ?? 15000` is
   duplicated at two *sequential* phases (port-read, then health-poll), so a single
   `startTimeoutMs: 15000` is really a ~30s ceiling. The magic `15000` (and the SIGKILL
   grace `5000`, stderr tail `8192`) are inline literals.
3. **`stopChild` stalls on signal-killed children (Low).** The guard `if (child.exitCode
   !== null) return;` misses a child terminated by a signal (`exitCode === null`,
   `signalCode` set). `kill("SIGTERM")` no-ops on the corpse, `'exit'` never re-emits, and
   quit blocks the full 5s SIGKILL grace.

## Acceptance criteria

- [x] Red-on-main unit test: a port line split mid-digits across two chunks parses the
      **correct** port (5183, not 51). *(done — `sidecar-lifecycle.unit.test.ts`)*
- [x] Named constants for the three magic values (`DEFAULT_PHASE_TIMEOUT_MS`, `KILL_GRACE_MS`,
      `STDERR_TAIL_BYTES`); the startup-timeout semantics documented as a **per-phase budget**
      (model B, chosen at the gate — see Finding 2).
- [x] Signal-killed child no longer stalls quit (unit-testable with a fake child). *(done)*
- [x] `desktop && npm run test:unit` green (35/35).

## Approach

### Finding 1 — consume only complete lines

Retain the trailing partial line across chunks so `parsePortFromLine` only ever sees a
complete, newline-terminated line:

```ts
const onData = (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  const lines = buf.split(/\r?\n/);
  buf = lines.pop()!;            // keep the partial tail for the next chunk
  for (const line of lines) { … }
};
```

The real listening line is `Console.WriteLine`-emitted (`Program.cs:204`,
`PRism listening on http://{host}:{port} (dataDir: {dir})`), so it always arrives
newline-terminated — complete-line buffering is sufficient. A truncated `…:51` partial
now stays in `buf` until its newline arrives and is never parsed.

**Dependency (documented):** buffering rests on the `Console.WriteLine` trailing-newline
guarantee. If the emit ever changed to `Console.Write` (no newline), the final line would
strand and the handshake would time out. This is acceptable — the same `Program.cs:204`
line is the parser's whole contract already, and `ports.unit.test.ts` pins the format.

**Regex guard considered and rejected.** The issue suggested also adding a non-digit
anchor (`(\d+)(?=\D)`) as belt-and-suspenders. Dropped: complete-line buffering already
makes a truncated partial unreachable, so the anchor guards nothing extra, and it would
couple the parser to the port always being followed by a suffix — a future format change
(e.g. a `--quiet` mode dropping the ` (dataDir…)` tail) would turn a valid port into a
`null` parse and a generic timeout. The `match` regex stays as-is.

### Finding 2 — startup-timeout model *(design choice — THE gate decision)*

The issue frames the duplicated `15000` as "silently doubles" and wants the option name to
mean a single budget. Adversarial review surfaced the counter-point: the "doubling" is also
**accidental cold-start headroom**. `main.ts` (the only caller) passes no override, so the
effective ceiling today is ~30s — a full 15s for the backend to *bind* its port, then a
fresh 15s to health-poll. The #282 cold-start regime (cold .NET JIT, AV scan, contended
disk on a cold desktop) is exactly when port-bind is slow but the backend is then healthy.
Collapsing to a single 15s total would fail a boot where the port arrives at 14s and
health-poll then gets ~1s — a real reliability regression, sold as a definitional win.

Three shapes; **I recommend B** (preserves headroom; the issue's stated preference for a
single budget is outweighed by the cold-start risk you own via #282):

- **B — per-phase named budgets (recommended).** Hoist a named
  `DEFAULT_PHASE_TIMEOUT_MS = 15000`; pass it to each phase as today. Document explicitly
  that the budget is **per startup phase** (port-read, then health-poll), so a single
  config value caps each phase, not the total. Fixes the duplicated literal and the
  *undocumented* semantics (no longer "silent") with **zero behavior change** — the ~30s
  effective ceiling and its cold-start headroom are preserved exactly.
- **A-wide — single shared budget, default 30s.** Compute `deadline = Date.now() + budget`
  once (`DEFAULT_START_TIMEOUT_MS = 30000`), pass *remaining* time to each phase. Gives the
  honest "one total budget" semantics the issue wanted *and* preserves the ~30s ceiling.
  Cost: a slow port-read eats into the health-poll's share (vs B, where health always gets
  a fresh 15s), and it does change the per-phase distribution.
- **A-15s — single shared budget, default 15s.** Matches the option name literally but
  **tightens 30s→15s total** — the cold-start regression above. Not recommended.

Also hoist `KILL_GRACE_MS = 5000` and `STDERR_TAIL_BYTES = 8192` regardless of which model.

The Finding-2 unit test shape depends on this choice and is written after the gate.

### Finding 3 — guard on signalCode too

```ts
if (child.exitCode !== null || child.signalCode !== null) return;
```

A child already dead by signal returns immediately instead of waiting out the SIGKILL grace.

## Out of scope

No change to the spawn contract (`planSpawn`), the env-var sidecar activation, stderr drain,
or the Core-side `PortSelector`/`ParentLivenessProbe` (the duplication there is inherent —
the shell only parses the emitted line and health-gates `/api/health`).

## Test plan

- `sidecar-lifecycle.unit.test.ts` (done, red-on-main captured): chunk-split port → 5183
  (was 51); whole-line control still parses; signal-killed child → no re-kill (was
  `['SIGTERM']`); normal-exit child → no-op.
- `ports.unit.test.ts`: unchanged (the regex is not modified — see Finding 1).
- **[Deferred — pending the Finding-2 gate decision]** Finding-2 timeout test: shape depends
  on B vs A-wide vs A-15s. For B, assert each phase receives `DEFAULT_PHASE_TIMEOUT_MS`; for
  A-wide/A-15s, assert the two phases share one deadline (injected clock / spy on the
  timeout args).
