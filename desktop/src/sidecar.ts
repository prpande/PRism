import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import { parsePortFromLine, pollHealth } from "./ports";

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
  startTimeoutMs?: number;
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
    args: ["--no-browser", ...(opts.dataDir ? ["--dataDir", opts.dataDir] : [])],
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
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
  });

  try {
    const port = await readPortFromStdout(child, opts.startTimeoutMs ?? 15000);
    const baseUrl = `http://127.0.0.1:${port}`;

    const healthy = await pollHealth(baseUrl, opts.startTimeoutMs ?? 15000);
    if (!healthy) {
      throw new Error("PRism backend failed its health check.");
    }

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

function readPortFromStdout(child: ChildProcess, timeoutMs: number): Promise<number> {
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
      for (const line of buf.split(/\r?\n/)) {
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
      reject(new Error(`Backend exited before reporting a port (code ${code}).`));
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    // SIGTERM on Unix; on Windows .kill() maps to TerminateProcess.
    child.kill("SIGTERM");
  });
}
