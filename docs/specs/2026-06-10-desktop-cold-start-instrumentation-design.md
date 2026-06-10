# Desktop cold-start: reduce + instrument (#282 Part 1)

**Issue:** [#282](https://github.com/prpande/PRism/issues/282) — Portable EXE cold-start is ~1.5 min with no feedback.
**Tier:** T3 — Full (borderline T2/T3 → escalated up: genuinely-new logging behavior, cross-cutting desktop/build/docs).
**Risk:** gated **B2** (desktop sidecar seam — `bootstrap()` / `startSidecar` startup path). Spec gate fires **before** implementation; the human reviews the approach.
**Date:** 2026-06-10

## Problem

Launching the published desktop shell has an unacceptable cold-start (~1.5 min) with **no on-screen feedback** until the window appears — it reads as "broken," not "loading." The issue identifies five candidate cost regions:

1. Portable self-extraction to `%TEMP%` (pre-Electron, every launch).
2. SmartScreen / Defender scan of unsigned freshly-extracted files (pre-Electron, first run).
3. Electron main init (`whenReady`).
4. Sidecar spawn → port → health (`startSidecar`).
5. SPA load (`loadURL`).

The issue's own first instruction is **"profile where the time goes — don't guess,"** and both the splash (Part 2) and the compression decision depend on that attribution. The blocker: regions 1–2 are environmental and can only be measured on a **clean Windows machine with Defender on** — not reproducible on a developer box that has already seen these binaries.

## Decision frame (owner-locked, 2026-06-10)

Brainstorm settled four scope calls before this spec:

1. **Measurement:** apply high-confidence levers now; ship instrumentation; measure the rest on a clean VM later. (Do **not** stall the slice waiting on attribution we can't produce here.)
2. **Distribution (AC #4):** keep **both** `portable` + `nsis` targets at equal footing; document the cold-start tradeoff neutrally — no steering.
3. **.NET levers:** `PublishReadyToRun=true` **now** (unambiguous cold-start win); the `EnableCompressionInSingleFile` flip is **deferred to the clean-VM region-4 data** (dropping it ~doubles the sidecar binary, which *enlarges* the per-launch portable extraction — a measurement question, not a clear win).
4. **Issue scope:** this PR does Part 1 and **closes #282**; a separate **splash follow-up** issue is filed for Part 2.

## Scope

**In:**
- `PublishReadyToRun=true` on the sidecar publish.
- Shipping startup instrumentation that attributes **regions 3–5** and emits the process-creation→content-loaded total, so regions 1–2 are **derivable by subtraction** on any machine.
- A documented **measurement protocol**.
- Distribution docs (AC #4 caveat).

**Out (deferred; follow-ups filed):**
- The splash / loading indicator (Part 2) — gated on the clean-VM data showing a material post-`whenReady` gap.
- The `EnableCompressionInSingleFile` flip — gated on the region-4 number.
- Code-signing (region-2's only real fix) — no Authenticode cert available; documented as the known residual + the future fix.

**Explicit non-goal:** changing what the user sees during regions 1–2. A splash created inside Electron cannot cover pre-JS extraction/scan; only packaging (installer, signing) can, and both are out of this slice.

## Approach

### 1. Sidecar .NET lever — `PRism.Web/PRism.Web.csproj` (1 line)

Add `<PublishReadyToRun>true</PublishReadyToRun>` to the **existing** `Condition="'$(PublishProfile)' != ''"` PropertyGroup (the same group that already sets `PublishSingleFile` / `EnableCompressionInSingleFile` / `IncludeNativeLibrariesForSelfExtract`). It is publish-gated exactly like its siblings, so non-publish builds (the `dotnet build` / `dotnet test` inner loop) are unaffected.

- **Effect:** ships precompiled R2R images, cutting first-run JIT in region 4 (spawn→listening), at a modest binary-size increase.
- **Compatibility:** R2R composes with single-file self-contained publish; R2R images are RID-specific and the publish is already per-RID (`-r win-x64` / `-r osx-arm64`), so no new RID handling.
- **Verification:** a successful `dotnet publish` of the win-x64 single-file profile + the desktop pack smoke. This is a build property — **no unit test** (consistent with the existing single-file props, which are likewise build-verified, not unit-tested).
- **Keep** `EnableCompressionInSingleFile=true` unchanged — its flip is deferred (see Decision frame #3).

### 2. Startup instrumentation — new `desktop/src/startupTimings.ts` (pure, unit-tested)

A pure module: a phase recorder + an attribution/format pass. No Electron imports, no I/O — so it is `node:test`-unit-testable exactly like `planSpawn` / `parsePortFromLine`.

**Phases** (epoch-ms marks, in startup order):

| Phase | Marked when |
|-------|-------------|
| `moduleLoad` | at `main.ts` module import (earliest JS) |
| `whenReady` | first line of `bootstrap()` (after `app.whenReady()`) |
| `sidecarSpawn` | immediately before `startSidecar(...)` |
| `portReceived` | sidecar printed its port (`startSidecar` `onPortReceived` callback) |
| `healthOk` | health poll passed (`startSidecar` `onHealthy` callback) |
| `contentLoaded` | `await mainWindow.loadURL(...)` resolved |

**Clock:** marks use `Date.now()` (epoch), **injected** as `now: () => number` (default `Date.now`) for deterministic tests. Epoch (not `performance.now()`) is required so a mark can be differenced against `process.getCreationTime()` (which returns epoch ms). Over a ~minute startup on a normal machine, wall-clock skew is immaterial; noted as a caveat.

**Recorder API:**

```ts
export type Phase =
  | "moduleLoad" | "whenReady" | "sidecarSpawn"
  | "portReceived" | "healthOk" | "contentLoaded";

export interface StartupRecorder {
  mark(phase: Phase): void;          // first-write-wins; a second mark of the same phase is ignored
  marks(): ReadonlyMap<Phase, number>;
}
export function createStartupRecorder(now?: () => number): StartupRecorder;
```

`mark` is **idempotent (first-write-wins)** — a phase re-entered (e.g. a navigation that re-fires) keeps its original timestamp rather than corrupting the measurement.

**Attribution** — each region is `null` when either endpoint mark is absent (startup can fail partway; a partial line is still emitted):

```ts
export interface RegionAttribution {
  preJs: number | null;            // moduleLoad − processCreationTime (Chromium/Electron pre-JS init; null if getCreationTime null)
  electronInit: number | null;     // R3: whenReady − moduleLoad
  sidecarBoot: number | null;      // R4a: portReceived − sidecarSpawn
  healthPoll: number | null;       // R4b: healthOk − portReceived
  spaLoad: number | null;          // R5: contentLoaded − healthOk
  totalInstrumented: number | null;// contentLoaded − moduleLoad (all post-JS regions)
  procToContent: number | null;    // contentLoaded − processCreationTime (the subtraction anchor; null if getCreationTime null)
}
export function attribute(
  marks: ReadonlyMap<Phase, number>,
  processCreationTime: number | null,
): RegionAttribution;
```

**Formatter** — one structured, greppable line:

```ts
export function formatSummary(attr: RegionAttribution): string;
// e.g.  [startup] preJs=312 electronInit=44 sidecarBoot=2180 healthPoll=120 spaLoad=190 totalInstrumented=2735 procToContent=3047 (ms)
```

Null fields render as `n/a` (so a failed/partial startup still produces a parseable line).

### 3. Wiring into `desktop/src/main.ts` (thin glue, e2e-covered)

- **Module top** (before the single-instance gate): `const startup = createStartupRecorder(); startup.mark("moduleLoad");`
- **`bootstrap()` entry:** `startup.mark("whenReady");`
- **Before `startSidecar`:** `startup.mark("sidecarSpawn");`
- **Pass callbacks** to `startSidecar` (see §4): `onPortReceived: () => startup.mark("portReceived")`, `onHealthy: () => startup.mark("healthOk")`.
- **After `await mainWindow.loadURL(...)` resolves:** `startup.mark("contentLoaded"); emitStartupSummary();`
- **In the `catch`** (sidecar failed to start): call `emitStartupSummary()` before `app.quit()` — a failed cold-start is still measured (partial line).

`emitStartupSummary()` is a small main.ts helper that calls `attribute(startup.marks(), process.getCreationTime())` → `formatSummary(...)`, then:
- `console.log(line)` (dev console), **and**
- appends `line + "\n"` to `path.join(app.getPath("logs"), "startup.log")` (double-click launches have no console). The write is wrapped so a logging failure never aborts startup. `app.getPath("logs")` is created by Electron on demand (Windows: `%APPDATA%/PRism/logs`).

The file-write + `process.getCreationTime()` call live in main.ts (thin, Electron-bound) and are exercised by the e2e smoke, **not** unit-tested. All arithmetic lives in the pure module.

### 4. `startSidecar` timing hooks — `desktop/src/sidecar.ts` (2 optional callbacks)

Add to `SidecarOptions`:

```ts
  /** Fired once the sidecar prints its port (region 4a boundary). */
  onPortReceived?: () => void;
  /** Fired once the health poll passes (region 4b boundary). */
  onHealthy?: () => void;
```

`startSidecar` invokes `opts.onPortReceived?.()` immediately after `readPortFromStdout` resolves, and `opts.onHealthy?.()` immediately after `pollHealth` returns healthy. Pure-plan (`planSpawn`) is untouched. Callbacks are optional, so every existing caller/test compiles unchanged. They are wrapped/guarded so a throwing callback never converts a healthy startup into a failure.

### 5. Measurement protocol (documented in the spec + a short `desktop/` note)

This is **how regions 1–2 surface without instrumenting pre-JS code.** Let `C = process.getCreationTime()` (final Electron process creation), `L = contentLoaded`. The log line reports `procToContent = L − C` — everything from process creation to content visible, fully instrumented.

The tester records the **wall-clock total** `T` with a stopwatch: **double-click → window shows content**. Then:

> **regions 1–2 (portable extraction + AV scan + pre-process spawn) = T − procToContent**

- On the **NSIS-installed** path there is no portable extraction, so `T − procToContent` ≈ region 2 (AV) + spawn overhead.
- On the **portable** path, `T − procToContent` = extraction + AV.
- **Isolating region 1 specifically:** compare `T` for the two distributions on the same clean machine — the delta is the portable per-launch extraction cost.

Run on a clean Windows VM, Defender on, first-ever launch of the unsigned build. Record the numbers in the issue/PR (satisfies AC #1).

### 6. Distribution docs (AC #4) — `README.md`

A short subsection under the desktop/download guidance: both the installer (NSIS) and the portable `.exe` are offered; note that the portable EXE re-extracts the full app to `%TEMP%` on **every** launch (slower cold-start), while the installer unpacks once at install. State it as a tradeoff, neutrally — no recommendation steering (Decision frame #2). Cross-reference the unsigned-binary SmartScreen note already implied by `electron-builder.yml`.

### 7. Follow-ups (filed during/at PR time)

- **Splash / loading indicator (Part 2)** — new issue, `area:desktop`, `needs-design`. Notes: gated on the clean-VM data showing a material post-`whenReady` gap (regions 3–5); a splash can cover **only** regions 3–5, never the portable path's 1–2; implementation would show a lightweight "PRism is starting…" window on `whenReady` and swap to the main window on `contentLoaded`.
- **Compression-flip decision** — captured in the splash issue or its own note: revisit `EnableCompressionInSingleFile=false` once the region-4 `sidecarBoot` number is known, weighing the ~2× binary-size cost against the first-run decompression saving (and its enlargement of the portable extraction).

## Data flow

```
OS double-click ──▶ [R1 portable extract to %TEMP%] ──▶ [R2 AV scan] ──▶ process created (C)
   ──▶ [pre-JS Chromium init] ──▶ moduleLoad ──▶ whenReady ──▶ sidecarSpawn
   ──▶ portReceived ──▶ healthOk ──▶ contentLoaded (L) ──▶ window shows content
                                                       │
            instrumented: preJs, electronInit, sidecarBoot, healthPoll, spaLoad
            anchor: procToContent = L − C   ·   stopwatch: T = double-click → L
            derived:  regions 1–2 = T − procToContent
```

## Testing (TDD)

All new production code is written test-first (red → green). Units run under `desktop` `npm run test:unit` (`node:test`).

**`startupTimings.ts` (pure, fully unit-tested):**
- `createStartupRecorder` with an injected clock: `mark` records the injected time; `marks()` returns them.
- **First-write-wins:** marking the same phase twice keeps the first timestamp.
- `attribute` with a complete mark set + a `processCreationTime` → every region computes correctly (fixed numbers).
- `attribute` with a **missing** mid-phase (e.g. no `healthOk`) → `healthPoll` and `spaLoad` are `null`; the regions that don't depend on it still compute.
- `attribute` with `processCreationTime = null` → `preJs` and `procToContent` are `null`; `totalInstrumented` still computes.
- `formatSummary` → exact greppable line for a full attribution; `n/a` for null fields.

**`sidecar.ts`:** existing `planSpawn` units stay green (callbacks don't touch the pure plan). The `onPortReceived`/`onHealthy` ordering is exercised by the e2e smoke against the real sidecar (consistent with the house rule that units don't spawn processes).

**`main.ts` wiring + R2R:** the `_electron` Playwright smoke (`shell.e2e.ts`, local/manual) launches the real shell against a published sidecar and asserts a `[startup]` line is written to `app.getPath("logs")/startup.log`. R2R is verified by a successful publish + pack smoke.

## Definition of done → acceptance-criteria map

- **AC #1** (profile + attribute regions, numbers recorded) → instrumentation emits regions 3–5 + `procToContent`; the measurement protocol derives 1–2; numbers recorded in the PR from the clean-VM run.
- **AC #2** (startup reduced via highest-impact fix) → `PublishReadyToRun` applied; instrumentation makes the impact measurable; the dominant pre-JS region's fixes (installer-over-portable behavior, signing) are documented as the levers, with portable kept by owner decision.
- **AC #3** (splash if Part 1 insufficient) → **deferred** to the filed splash issue, gated on the clean-VM gap — consistent with "measure before building a splash that may not help."
- **AC #4** (distribution decided + documented) → both targets kept; tradeoff documented neutrally in README.
- **AC #5** (verified on a clean Windows machine, Defender on) → the measurement protocol is run there; numbers in the PR's `## Proof`.

## Behavioral notes / edge cases

- **Failed startup still measured:** the `catch` path emits a partial summary before quitting — a sidecar that never comes up is diagnosable from `startup.log`.
- **Logging never breaks startup:** the file append and `getCreationTime` are guarded; any failure is swallowed (startup proceeds, the line is best-effort).
- **`getCreationTime` may return `null`** on some platforms/builds → `preJs` / `procToContent` degrade to `n/a`; the post-JS regions remain. The protocol then falls back to `T − totalInstrumented` minus an un-instrumented pre-JS slice (less precise; noted).
- **Epoch clock skew:** `Date.now()` is not monotonic; a mid-startup NTP step could skew a region. Acceptable for a one-shot ~minute measurement; called out so a wildly negative region is read as skew, not signal.
- **No secret surface:** the log line is pure timing integers; no tokens, paths-with-usernames are limited to the `logs` dir path Electron owns. Secrets scan over the diff is clean by construction.
