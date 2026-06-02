import { spawn, ChildProcess } from "node:child_process";
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

/**
 * Spawn the PRism.Web sidecar, learn its port from stdout, health-gate, and return
 * a handle. The backend picks its own free port (no shell-side TOCTOU); we read it.
 */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const child: ChildProcess = spawn(
    opts.binaryPath,
    ["--no-browser", ...(opts.dataDir ? ["--dataDir", opts.dataDir] : [])],
    {
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const port = await readPortFromStdout(child, opts.startTimeoutMs ?? 15000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthy = await pollHealth(baseUrl, opts.startTimeoutMs ?? 15000);
  if (!healthy) {
    child.kill();
    throw new Error("PRism backend failed its health check.");
  }

  return {
    baseUrl,
    stop: () => stopChild(child),
  };
}

function readPortFromStdout(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
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
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for backend port."));
    }, timeoutMs);
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
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
