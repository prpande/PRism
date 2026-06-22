# Claude CLI Discovery & Runtime Resolution (macOS robustness)

**Date:** 2026-06-22
**Status:** Design — pending human review (machine `ce-doc-review` pass applied; dispositions in §11)
**Scope:** `PRism.AI.ClaudeCode` (+ a thin Web composition change). No frontend, no wire-shape change.

## 1. Problem

PRism shells out to the `claude` CLI to power its AI seams. Every spawn site resolves the
executable by the **bare name `"claude"`** (`ClaudeCodeProviderOptions.ClaudeExecutable`, default
`"claude"`) against the child process's `PATH`, and builds the child env from a static allowlist
(`ClaudeCliEnvironment.BuildAllowlisted()`), copying `PATH` from the sidecar's own environment.

On the desktop build the process tree is **Electron main → .NET sidecar → `claude`**, and the
sidecar's `PATH` is, transitively, Electron's `process.env.PATH` (`desktop/src/sidecar.ts`,
`planSpawn`: `PATH: process.env.PATH ?? ""`).

This works on Windows (GUI processes inherit the full user+system `PATH` from the registry) but
**breaks on macOS specifically in the shipped `.app`**: a `.app` launched from Finder/Dock receives
the minimal launchd `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), which contains none of the locations
where `claude` installs. The probe then returns `cli-not-installed` even though `claude` works fine
in the user's terminal.

**The trap:** dev runs (`npm run`-launched Electron) inherit the full shell `PATH`, so AI works in
development and only the packaged `.app` launched from Finder hits the minimal `PATH`. The failure is
invisible until a real install.

### 1.1 The two install topologies

| | Topology 1 — native installer | Topology 2 — npm global |
|---|---|---|
| `claude` location | `~/.local/bin/claude` (self-contained binary) | symlink in the npm global bin dir → `…/@anthropic-ai/claude-code/cli.js` |
| External `node`? | **No** — single self-contained executable | **Yes** — shebang `#!/usr/bin/env node`; exec needs `node` on `PATH` |
| Bin dir variability | fixed (`~/.local/bin`) | wildly variable: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm/versions/node/<v>/bin`, `~/.local/state/fnm_multishells/<id>/bin`, `~/.volta/bin` (shim), `~/.asdf/shims` (shim), `~/Library/pnpm`, … |
| Extra env to exec | none | shim managers (volta/asdf) need their own vars (`VOLTA_HOME`, `ASDF_DIR`, …) |

**Why a filesystem path-probe is insufficient:** finding the `claude` *file* does not mean it will
*run*. For Topology 2 the `env node` shebang needs `node`'s dir on `PATH`, and shim managers
additionally need their own env vars — which the security allowlist excludes. A probe that finds
`~/.volta/bin/claude` but hands it the allowlisted env gets `env: node: No such file or directory`.

**The unifying insight:** the user's login shell already has an environment under which both
`claude` and `node` resolve *and execute* — that is how the user runs `claude` in their terminal. So
the robust signal is to **reproduce the login-shell environment**, then **prove the binary resolves
and executes** by running `claude --version` under the exact env we will use for real calls.

**What that proof does and does not cover (scope-bounding — do not overclaim).** A `claude --version`
exit 0 proves **resolution + executability**: the path resolves, `node` is reachable for the npm
shebang, and any shim env is sufficient to launch the process. It does **not** prove a real `claude
-p` completion will succeed — it never touches the credential store, the network, the
subscription/Agent-SDK credit state, `--json-schema`, or `--tools ""`. Login/credit/network
viability remains the **liveness tier's** job (the existing `claude --version`-based probe and its
`not-logged-in`/`unknown` reason codes), which is orthogonal to discovery. Discovery removes only the
"binary can't be found or can't launch" failure class; it deliberately leaves the existing
availability semantics untouched. (Empirical check deferred to §9: confirm `claude --version` on an
npm install actually execs `node` rather than short-circuiting before node resolution — the one claim
the node-reachability guarantee rests on.)

## 2. Goals / non-goals

### 2.1 Goals
- Resolve and run `claude` on macOS regardless of install topology, **without user intervention**.
- **Discover once, persist, reuse** — pay the (expensive) login-shell capture at most once per
  successful discovery; subsequent launches read the persisted result.
- Self-heal: a moved/uninstalled binary **or a persisted env that no longer launches the binary**
  (e.g. a node-manager version swap) triggers re-discovery; a user who installs `claude` later
  recovers automatically (never permanently stranded).
- Preserve every existing substrate security invariant (no credential/redirect vars in the child
  env; allowlist-only; identity assertion unchanged).
- **Zero behavior change on Windows** and in existing tests.

### 2.2 Non-goals
- Windows path resolution (already works; discovery is OS-gated off).
- Changing the AI mode model, consent, or any wire contract.
- Supporting `claude` invoked through a shell *alias/function* (we resolve a real executable path).
- Defending against an attacker who can already write to the user's own `PATH` directories (same
  trust model as today — see §8).

## 3. Architecture — where discovery runs

**Decision: the .NET sidecar owns discovery** (vs. an Electron-side `fix-path`, or a layered split).
It is the single chokepoint that already owns the env allowlist and `ClaudeExecutable`, it covers
**both** the packaged `.app` and the browser-tab/dev build, its persisted state lands naturally in
the dataDir it already uses, and it is unit-testable in the existing .NET suite. The Electron layer's
minimal `PATH` becomes irrelevant because the sidecar self-discovers.

### 3.1 Components (new unless noted)

All in `PRism.AI.ClaudeCode`, mirroring the existing `ICliProcessRunner`/`FakeCliProcessRunner` seam
so everything except the OS adapter is unit-testable.

| Unit | Responsibility | CI-testable |
|---|---|---|
| `IClaudeCliLocator` / `ClaudeCliLocator` | Orchestrate resolution: read persisted record → identity + self-heal check → (cold) run discovery → validate by executing `claude --version` → persist. Returns `ResolvedCli{ ExecutablePath, Environment }` or `NotFound(reasonCode)`. Single-flighted + memoized. | ✅ (fakes) |
| `ILoginShellEnvironmentReader` / `SystemLoginShellEnvironmentReader` | Spawn `$SHELL -ilc` with a **cleared** env block (§4) and return the captured env + `command -v claude`. The only new class touching the login shell; the sentinel parse is a private method tested through it (no standalone parser class). | ❌ manual P1 (logic via private-method tests) |
| `JsonClaudeCliStateStore` (concrete, internal) | Read/write the persisted record in the dataDir, atomic write, file `600` + dir `700` (mirrors `JsonlTokenUsageTracker`). No interface — `ClaudeCliLocator` is the only consumer; tests use a temp dir. | ✅ (temp dir) |
| `ClaudeCliEnvironment` (existing) | Gains a **manager-var allowlist** + explicit credential/redirect exclusions; the POSIX path matches keys **case-sensitively**. Windows/fallback path unchanged. | ✅ |
| `ClaudeCliResolution` (record) | `ResolvedCli` (`ExecutablePath`, `IReadOnlyDictionary<string,string> Environment`) and `NotFound(reasonCode)`. | ✅ |

### 3.2 Integration seam

The one-shot provider (`ClaudeCodeLlmProvider`) and the availability probe
(`ClaudeCodeAvailabilityProbe`) are async and **call `IClaudeCliLocator.ResolveAsync(ct)` directly**,
replacing their direct reads of `options.ClaudeExecutable` + `ClaudeCliEnvironment.BuildAllowlisted()`
when building the `ProcessSpec`.

The streaming provider is different: `IStreamingLlmProvider.StartSession(StreamingSessionOptions)` is
**synchronous and takes no `CancellationToken`** (`PRism.AI.Contracts/Provider/IStreamingLlmProvider.cs`).
It therefore **resolves upstream**: the resolved `(ExecutablePath, Environment)` is obtained by the
caller (or via an async pre-resolve step) *before* `StartSession` runs, and passed into the spec
build — `StartSession` itself does not `await`. The plan resolves the exact wiring (resolve-then-start
vs. a cached resolved value on the provider); the requirement here is only that the streaming
`StreamingProcessSpec` is built from the locator's resolved invocation, not from the static helpers.

**`NotFound` handling and reason codes.** On `NotFound`, the one-shot/streaming providers throw
`LlmProviderException` (as the existing `Win32Exception` path does today). The availability probe maps
the locator's `NotFound(reasonCode)` onto the `LlmAvailability` reason-code vocabulary
(`ClaudeReasonCodes`): a clean "no `claude` anywhere" → `cli-not-installed`; a discovery that ran but
could not produce a launchable binary (non-POSIX shell + ladder miss, manager-var gap) → a **new
`CliDiscoveryFailed`** code, so logs and any future UI can distinguish *not installed* from *installed
but not discoverable*. Login/credit failures continue to surface via the existing
`not-logged-in`/`unknown` codes from the liveness tier — discovery does not touch them.

## 4. Discovery mechanism (Unix only)

Cold discovery runs when Live mode is active and no valid persisted record exists. It is triggered
**off the request path** (§7), so the latency below is never paid synchronously inside a user-facing
probe.

1. **Resolve the shell:** `$SHELL`, falling back `/bin/zsh` → `/bin/bash` → `/bin/sh`.
2. **Capture login-shell env** with a hard timeout (`DiscoveryTimeout`, default 10s, matching
   `ProbeTimeout`; a timeout is logged and falls to the ladder in step 5). The reader spawns the shell
   with a **cleared** env block (`psi.Environment.Clear()`, exactly as `SystemCliProcessRunner` does
   for `claude`) carrying **only** the minimum needed to locate the shell and its rc files —
   `HOME`, `USER`/`LOGNAME`, `TMPDIR`. The rc files then reconstruct the user's full environment from
   scratch; that reconstruction *is* the signal. Clearing first guarantees no sidecar-inherited var
   (a stray `ANTHROPIC_*`, proxy, or `CLAUDE_CONFIG_DIR` in a future deployment) can survive into the
   rc execution or the captured env block.
   ```
   <shell> -ilc 'printf "%s\n" "$S1"; command -v claude; printf "%s\n" "$S2"; /usr/bin/env; printf "%s\n" "$S3"'
   ```
   - `$S1/$S2/$S3` are **per-invocation random sentinels** (passed via the cleared env), so neither rc
     banner/MOTD noise nor a third-party rc script echoing a fixed marker can corrupt the parse.
   - Capturing the full `env` (not just `PATH`) yields manager vars (`VOLTA_HOME`, `ASDF_DIR`,
     `FNM_*`, …) needed for shim topologies in one shot.
3. **Pick a candidate** `claude` path: the `command -v claude` result **if it is an absolute path to
   an existing file**; otherwise resolve `claude` against the captured `PATH`. A non-path result
   (alias/function/builtin) is treated as no candidate.
4. **Validate by executing.** Run `claude --version` (timeout = `ProbeTimeout`, 10s) with the
   candidate path + the **filtered** env (§5). Exit 0 proves **resolution + executability** (per the
   scope-bound in §1 — not credential/credit viability). On success → persist (§6) and return
   `ResolvedCli`.
5. **Degradation ladder** if step 2 fails (non-POSIX shell, rc error, timeout) or yields no working
   `claude`: probe well-known native-installer locations in order — `~/.local/bin/claude`,
   `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` — each **re-validated by executing**
   `--version`. This rescues the native topology (no node needed); npm-on-non-POSIX-shell is the
   residual gap and surfaces as `CliDiscoveryFailed` (logged). If nothing validates → `NotFound`.

A login shell is spawned **at most once per discovery**; this is the cost the persistence in §6
amortizes.

## 5. Env security filtering (allowlist-only, case-sensitive on POSIX)

The child env handed to `claude` is built **allowlist-only** (never denylist), consistent with
today's philosophy:

- Copy from the captured login-shell env **only** keys in (`base allowlist` ∪ `manager-var
  allowlist`). `PATH` is taken from the captured env. **POSIX matching is case-sensitive**
  (`StringComparer.Ordinal`) — env vars are case-sensitive on POSIX, so `nvm_dir` must not be treated
  as `NVM_DIR`, and a case-collision must never admit an unlisted var on a future allowlist
  expansion. (The Windows path keeps `OrdinalIgnoreCase`, matching OS semantics; it is unchanged.)
- **Base allowlist** (existing): `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `LANG`,
  `LC_ALL`. Add `TMPDIR` (the macOS/Unix temp var the current list omits).
- **Manager-var allowlist** (new, vetted, **path-pointing only**): `NVM_DIR`, `VOLTA_HOME`,
  `ASDF_DIR`, `ASDF_DATA_DIR`, `FNM_DIR`, `N_PREFIX`, `NPM_CONFIG_PREFIX`, `PNPM_HOME`. (Expandable
  under the review gate in §10.)
- **Never allowlisted (documented exclusions, defense-in-depth over the allowlist-only default):**
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` (auth/redirect),
  `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (egress routing/side-channel),
  `CLAUDE_CONFIG_DIR` (credential redirect), and **`NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`** (can inject
  modules into / redirect TLS for the `node` that runs an npm-installed `claude`). These are listed
  explicitly so a future allowlist expansion cannot quietly admit them. Arbitrary npm per-registry
  auth tokens (`NPM_CONFIG_//registry…/:_authToken`) do not match `NPM_CONFIG_PREFIX` and are excluded.

If a *needed* manager var is missing from the allowlist, step 4's exec-validation **fails loudly**
and the cause is logged — diagnosable and expandable over time — rather than silently shipping a
broken env.

## 6. Persistence & self-heal — asymmetric policy

**Only positive results are written to disk, and only the minimum needed to rebuild the env.** The
record (dataDir, file mode `600` in a `700` dir, written atomically via temp-file + rename so a
crash/concurrent read never sees a partial file):

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "executablePath": "/Users/x/.local/bin/claude",
  "path": "/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  "managerVars": { "VOLTA_HOME": "/Users/x/.volta" },
  "cliVersion": "2.1.177",
  "discoveredAt": "2026-06-22T00:00:00Z",
  "discoverySource": "login-shell"
}
```

The **full child env is NOT persisted** — only `path` + the strictly-required `managerVars` (the
path-pointing subset). On load, the locator rebuilds the allowlisted child env from `path` +
`managerVars` through the same §5 filter, so the on-disk file can never carry a value that was not
reviewed for on-disk storage, and the env the child sees always reflects the current allowlist.

- **Positive = sticky, but env-validated, not just path-validated.** On resolve: require
  `platform` == current OS, the **identity invariant holds** (`ClaudeIdentity.SameOsUserAsCredentialStore()`,
  run on *both* the warm-reuse and cold-discovery paths so a shared/synced dataDir can't reuse another
  user's record), **and** `executablePath` exists on disk. Self-heal — **discard the record and
  re-discover** — when any of: the path vanished (uninstall), the identity check fails, **or a spawn
  attempt under the persisted env fails with an executable-not-found signature** (`Win32Exception` /
  `env: node: No such file or directory`). The last case closes the node-manager-swap gap: a
  version-manager change leaves the `claude` shim in place while the pinned `path`'s `node` is gone —
  path-existence alone would wrongly keep reusing a dead env, so the exec-not-found signal from the
  next spawn (liveness or real call) is itself a re-discovery trigger.
- **Negative = in-memory TTL only, never persisted.** Discovery only ever runs in Live mode
  (Off/Preview never reach the provider, and **Preview is the default**), so a "not installed" user is
  already in an active-misconfiguration state they want resolved fast. A short in-memory TTL
  (`NegativeTtl`, default 30s) means a restart re-discovers and a mid-session install recovers within
  the TTL, with **zero** risk of a permanently-stranded "AI unavailable." The disk record stays
  positive-only.

## 7. Lifecycle, concurrency, latency, Windows

- **Eager on Live-entry, off the request path.** Discovery is kicked off as a background task when AI
  mode becomes (or starts as) Live — *not* lazily inside the first request-path probe. The first
  `/api/capabilities` probe after Live-entry either finds resolution already complete, or sees it
  in-flight and returns the existing "probing / unavailable" affordance until it lands (the FE already
  renders this from the current reason-code path). This removes the worst-case **first-probe latency
  of `DiscoveryTimeout + ProbeTimeout` (~20s)** from the user-facing request that the lazy-on-focus
  design would have incurred (`useCapabilities` refetches on every window focus).
- **Single-flight.** Resolution is guarded by a `SemaphoreSlim(1,1)` with double-check (same pattern
  as `CachedLlmAvailabilityProbe`) so the eager trigger and any concurrent probe never spawn N login
  shells. A cancelled first-caller releases the gate without writing a result; the next waiter
  re-checks the cache and proceeds.
- **Two tiers, one owner per concern, no compounding TTLs.** *Resolution tier* (this design): the
  locator owns find+persist and the **sole** negative-TTL (`NegativeTtl`). *Liveness tier* (existing):
  `CachedLlmAvailabilityProbe`'s ~30s TTL bounds the `claude --version` liveness re-probe, which
  **reuses the resolved invocation and never re-discovers.** To avoid the two caches composing into a
  ~60s recovery, the outer liveness cache must **not** independently extend a `cli-not-installed` /
  `CliDiscoveryFailed` result beyond the locator's negative state: a `NotFound` is surfaced as a
  short-lived availability result keyed to the locator's TTL, not memoized for a fresh 30s on top. The
  plan states this contract explicitly. "Binary later broke / logged out" is still caught cheaply by
  the liveness tier; "binary moved / env stale" is caught by §6 self-heal.
- **Windows = exact no-op.** `ResolveAsync` is `OperatingSystem.IsWindows()`-gated: it returns the
  inherited invocation (bare-name `"claude"` + today's `BuildAllowlisted()`). Windows behavior and all
  existing tests are unchanged. (`TMPDIR` joins the shared base allowlist but is a no-op on Windows,
  which sets `TEMP`/`TMP` instead — `BuildAllowlisted` simply skips the unset key.)

## 8. Risks (on the record)

- A login-shell spawn can hang on a pathological rc → the timeout in §4.2 is mandatory.
- Non-POSIX shells (fish/nu) may not honor `-ilc`/the snippet → §4.5 degradation ladder covers the
  native topology; npm-on-non-POSIX-shell is the residual gap, surfaced as `CliDiscoveryFailed`.
- **PATH-shadowing (accepted residual risk).** The captured `PATH` includes user-writable dirs
  (`~/.local/bin`, version-manager bin dirs); a `claude`/`node` planted there is executed at validate
  time and persisted across restarts. This is the **same trust model as today** — `ClaudeCodeProviderOptions`
  already documents "PATH is treated as trusted here," and an attacker who can write to the user's own
  bin dirs already controls the user account. Persistence *widens the window* (a hijacked entry
  survives until self-heal); we accept this rather than adding world-writable-dir stat checks
  inconsistent with the existing posture. Re-evaluate only if PRism ever runs elevated.
- **macOS-specific, validate on a real Mac in P1 (not CI-testable):** a notarized / hardened-runtime
  `.app` whose sidecar spawns a login shell and the `claude` binary. No entitlement *should* be needed
  for child-process spawn, but TCC/Gatekeeper behavior is confirmed empirically — same posture as the
  existing classes "validated manually in P1, not in CI." If Gatekeeper blocks child-shell spawn for a
  notarized `.app`, the §4.5 native-path ladder (no shell spawn) is the fallback that must still work.
- A shared/synced dataDir (iCloud/Dropbox home) could surface another machine's record; the `platform`
  + identity guards (§6) catch cross-OS and cross-user cases, but two same-OS same-user machines with
  different installs would each pass — low probability, and self-heal's exec-validation catches a
  wrong path on first spawn.

## 9. Testing strategy

Mirrors the existing `ICliProcessRunner` + fake pattern. Unit-testable (TDD) with fakes:

- `ClaudeCliLocator` orchestration: cold discovery happy path (both topologies, via a fake shell
  reader returning canned env blocks); self-heal on vanished path; **self-heal on exec-not-found under
  persisted env** (node-manager-swap case); negative TTL expiry; single-flight (one discovery under
  concurrent callers); identity-fail rejects a warm record; Windows no-op passthrough;
  cross-platform record ignored.
- Env filtering: captured env → allowlisted child env; credential/redirect/`NODE_OPTIONS` stripped;
  manager vars retained; `TMPDIR` added; **case-sensitive POSIX matching** (`nvm_dir` ≠ `NVM_DIR`).
- `JsonClaudeCliStateStore`: round-trip, atomic write (no partial file on interrupt), file `600` /
  dir `700`, corrupt/foreign-platform record ignored (re-discover, don't throw), **env rebuilt from
  `path`+`managerVars` on load** (full env never read from disk).
- Sentinel parser (private): env block extracted past banner noise; per-invocation sentinel collision
  resistance; missing/garbled block → no candidate; non-absolute `command -v` result → no candidate.

Manual P1 (real Mac, not CI): `SystemLoginShellEnvironmentReader` against zsh/bash + a real `claude`
install of **each** topology (native + an npm/nvm install), launched from a packaged `.app` from
Finder; the notarized/hardened-runtime check (§8); and the §1 empirical question — confirm `claude
--version` on an **npm/nvm** install actually execs `node` (so exit 0 genuinely proves
node-reachability) and that `fnm`/`asdf` export the vars the manager-var allowlist relies on in a
non-interactive-hook login shell.

## 10. Out of scope / follow-ups

- Surfacing a richer "found via X / not found because Y" diagnostic in Settings → AI (current design
  keeps the existing reason-code vocabulary + the new `CliDiscoveryFailed`; a UI surface is a separate
  slice). If that slice surfaces `discoverySource` over the API it is a wire-shape add — flagged now so
  the deferred slice plans the DTO change rather than treating it as breaking.
- **Manager-var allowlist expansion gate:** adding a var requires a named reviewer confirming it is
  path-pointing only and cannot carry a credential or redirect egress (any new var is persisted to disk
  and passed to the child). Driven by logged `CliDiscoveryFailed` validation failures.
- Electron-side `fix-path` is intentionally **not** done — superseded by sidecar-owned discovery.

## 11. Review dispositions — 2026-06-22 `ce-doc-review`

Five personas (coherence, feasibility, security-lens, scope-guardian, adversarial). Every finding and
its action:

**Applied**
- *Adversarial P1 — "exit 0 is the whole proof" overclaim:* narrowed in §1/§4.4 to resolution+executability; credential/credit explicitly the liveness tier's job.
- *Adversarial P1 — first-Live latency on request path:* §7 now triggers discovery eagerly on Live-entry, off the request path; latency budget stated.
- *Adversarial + Scope-guardian P1 — self-heal blind to broken node behind present shim:* §6 self-heal extended to exec-not-found-under-persisted-env.
- *Security P0 — persisted env could carry sensitive vars:* §6 now persists only `path`+`managerVars` and rebuilds the env on load; never writes the full env dict.
- *Security P1 — login-shell inherits un-filtered parent env:* §4.2 clears the env, passes only `HOME`/`USER`/`TMPDIR`.
- *Security P1 — case-sensitive POSIX allowlist:* §5 specifies `StringComparer.Ordinal` on POSIX.
- *Security P2 — `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`/`NO_PROXY` exclusions; file `600`; atomic write; identity check on warm path:* all added (§5, §6).
- *Scope-guardian — `CliDiscoveryFailed` reason code; drop `IClaudeCliStateStore` interface; sentinel as private method; `DiscoveryTimeout`→10s; `TMPDIR` Windows no-op note:* applied (§3.1, §4, §7).
- *Feasibility P2 — streaming `StartSession` is sync/CT-less:* §3.2 resolves the streaming invocation upstream of `StartSession`.
- *Coherence P1/P2 — `§7` reason-code ref + nonexistent `§2.1`:* §3.2 now describes reason-code mapping inline; §2 subsections labeled §2.1/§2.2.
- *Security residual — per-invocation sentinels:* §4.2 uses random per-invocation sentinels.

**Skipped (with reason)**
- *Security P1 — world-writable-dir stat check on the captured PATH:* mechanism skipped as over-engineering inconsistent with the existing "PATH is trusted" posture; the residual risk is instead documented as accepted in §8.

**Deferred to plan/P1 (not design-altering)**
- Exact streaming resolve-then-start wiring (§3.2); empirical node-exec + fnm/asdf var checks (§9);
  manager-var review-gate mechanics (§10); shared-dataDir same-user edge (§8 noted).
