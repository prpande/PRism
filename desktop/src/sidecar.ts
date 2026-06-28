import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import { parsePortFromLine, pollHealth } from "./ports";

/** Default budget for EACH startup phase (port-read, then health-poll), not the total.
 *  The two phases run sequentially and each get their own budget, so the worst-case
 *  cold-start wall-clock is ~2× this — deliberate headroom for a slow-to-bind backend
 *  (cold .NET JIT / AV scan on a cold desktop; #282) that is healthy once it binds. */
export const DEFAULT_PHASE_TIMEOUT_MS = 15000;
/** Grace period after SIGTERM before escalating to SIGKILL when stopping the child. */
const KILL_GRACE_MS = 5000;
/** Bound on the captured stderr tail surfaced when startup fails. */
const STDERR_TAIL_BYTES = 8192;

export interface Sidecar {
  baseUrl: string;
  stop(): Promise<void>;
}

export interface SidecarOptions {
  binaryPath: string;
  /** Explicit dataDir override (tests). When null, --dataDir is omitted and the
   *  sidecar self-resolves its default (shared with the browser-tab build). */
  dataDir: string | null;
  parentPid: number;
  /** Budget for EACH startup phase (port-read, then health-poll), in ms. Caps each phase
   *  independently, not the total — see {@link DEFAULT_PHASE_TIMEOUT_MS}. Defaults to it. */
  startTimeoutMs?: number;
  /** Fired once the sidecar prints its port (region 4a boundary, #282 timing). */
  onPortReceived?: () => void;
  /** Fired once the health poll passes (region 4b boundary, #282 timing). */
  onHealthy?: () => void;
}

export interface SpawnPlan {
  /** Absolute path to the sidecar binary (relative inputs are normalized). */
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the spawn binary/args/cwd/env for the sidecar. Pure (no process spawn) so
 * the launch contract is unit-testable.
 */
export function planSpawn(opts: SidecarOptions): SpawnPlan {
  // Normalize to an absolute path FIRST. A relative binaryPath (e.g. a dev setting
  // PRISM_SIDECAR_BINARY=./dev-sidecar/PRism.exe) would make path.dirname collapse to
  // "." — reintroducing the exact cwd bug this function fixes — and Node's spawn
  // resolves a relative command against process.cwd(), not options.cwd, which is
  // doubly fragile once we override cwd below. Resolving once removes both hazards.
  const binary = path.resolve(opts.binaryPath);
  return {
    binary,
    args: [
      "--no-browser",
      ...(opts.dataDir ? ["--dataDir", opts.dataDir] : []),
    ],
    // Anchor the working directory to the binary's OWN directory. ASP.NET derives
    // its ContentRoot from the process cwd, and MapFallbackToFile("index.html")
    // resolves the SPA shell under {ContentRoot}/wwwroot. Electron's launch cwd is
    // NOT the binary's dir, so without this the sidecar can't find wwwroot/index.html
    // and `GET /` 404s (only `/index.html` works, served by the static-assets
    // manifest, which carries absolute paths). Pinning cwd makes the SPA load.
    cwd: path.dirname(binary),
    // Pass a MINIMAL explicit env — do NOT spread process.env. Spreading would
    // hand the sidecar every ambient variable (incl. any CI secrets like
    // GITHUB_TOKEN inherited by the Electron process). Retain only what the
    // backend needs: PATH, a temp dir, and the vars DataDirectoryResolver reads
    // to compute LocalApplicationData when --dataDir is omitted (LOCALAPPDATA/
    // USERPROFILE on Windows; HOME on Unix), plus the two sidecar signals.
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot ?? "",
            TEMP: process.env.TEMP ?? "",
            USERPROFILE: process.env.USERPROFILE ?? "",
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
          }
        : { HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "" }),
      PRISM_SIDECAR: "1",
      PRISM_PARENT_PID: String(opts.parentPid),
    },
  };
}

/**
 * Spawn the PRism.Web sidecar, learn its port from stdout, health-gate, and return
 * a handle. The backend picks its own free port (no shell-side TOCTOU); we read it.
 */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const plan = planSpawn(opts);
  const child: ChildProcess = spawn(plan.binary, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain stderr to prevent a pipe-full deadlock: stderr is piped but stdout is the
  // only stream we actively read, so on Linux (~64 KB pipe buffer) a verbose .NET
  // startup failure could fill the buffer, block the child's write, and stall stdout —
  // turning a real backend error into an opaque 15 s port-read timeout. Capture a
  // bounded tail so the failure surfaces the actual output instead of just a timeout.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(
      -STDERR_TAIL_BYTES,
    );
  });

  try {
    // Each phase gets its own budget (model B): a slow port-read does not eat into the
    // health-poll's time. See DEFAULT_PHASE_TIMEOUT_MS for the cold-start rationale.
    const phaseTimeoutMs = opts.startTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
    const port = await readPortFromStdout(child, phaseTimeoutMs);
    fireTimingHook(opts.onPortReceived);
    const baseUrl = `http://127.0.0.1:${port}`;

    const healthy = await pollHealth(baseUrl, phaseTimeoutMs);
    if (!healthy) {
      throw new Error("PRism backend failed its health check.");
    }
    fireTimingHook(opts.onHealthy);

    attachPostStartupListeners(child);

    return {
      baseUrl,
      stop: () => stopChild(child),
    };
  } catch (err) {
    // Any startup failure (spawn error, port timeout, failed health check) must not
    // leak the child. main.ts's before-quit cleanup only runs once `sidecar` is
    // assigned — which never happens if we throw here — so kill the child ourselves.
    child.kill();
    const detail = stderrTail.trim();
    if (detail.length > 0 && err instanceof Error) {
      err.message = `${err.message}\nBackend stderr (tail):\n${detail}`;
    }
    throw err;
  }
}

/**
 * Attach the PERSISTENT listeners the long-lived sidecar child needs after a successful
 * startup. readPortFromStdout's cleanup() removed its transient 'error'/'exit' listeners
 * once the port was parsed, leaving the child with only a stderr-drain listener. A
 * ChildProcess that emits 'error' with NO 'error' listener re-throws it as an UNCAUGHT
 * exception, crashing the Electron main process and bypassing the graceful before-quit
 * stop. The 'error' handler here logs and tears the child down instead of throwing; the
 * 'exit' handler logs an unexpected post-startup exit.
 */
export function attachPostStartupListeners(child: ChildProcess): void {
  child.on("error", (err: Error) => {
    console.error("[sidecar] child process error after startup:", err);
    // Best-effort teardown; stopChild no-ops if the child has already exited.
    void stopChild(child);
  });
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    console.error(
      `[sidecar] child process exited after startup (code ${code}, signal ${signal}).`,
    );
  });
}

export function readPortFromStdout(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // Parse only COMPLETE (newline-terminated) lines. split() leaves the trailing
      // partial line as the last element; retain it in buf so a chunk boundary that
      // falls inside the port digits (…:51 + 83…) can't be mis-parsed as port 51. The
      // listening line is Console.WriteLine-emitted (Program.cs), so it always arrives
      // newline-terminated — the partial tail is always resolved by a later chunk.
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const port = parsePortFromLine(line);
        if (port !== null) {
          cleanup();
          resolve(port);
          return;
        }
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(`Backend exited before reporting a port (code ${code}).`),
      );
    };
    // A spawn failure (e.g. ENOENT for a bad binary path) emits 'error', not 'exit'.
    // Without this listener the event is unhandled and crashes the Electron main
    // process instead of surfacing as a controlled startup failure.
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for backend port."));
    }, timeoutMs);
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

// Invoke an optional timing hook (#282) without letting it derail startup: a
// throwing callback must never convert a healthy sidecar boot into a failure, so
// swallow anything it throws. The hooks only record an in-memory timestamp.
function fireTimingHook(hook: (() => void) | undefined): void {
  if (!hook) return;
  try {
    hook();
  } catch {
    /* timing is best-effort; never fail startup on a marking error */
  }
}

export async function stopChild(child: ChildProcess): Promise<void> {
  // A child terminated by a SIGNAL has exitCode === null but signalCode set. Guarding on
  // exitCode alone let a signal-killed corpse fall through: kill("SIGTERM") no-ops, 'exit'
  // never re-emits, and quit blocked the full KILL_GRACE_MS until the SIGKILL timer fired.
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    // SIGTERM on Unix; on Windows .kill() maps to TerminateProcess.
    child.kill("SIGTERM");
  });
}
