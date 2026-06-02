/** Parse the bound port out of the sidecar's "PRism listening on http://<host>:<port>" stdout line. */
export function parsePortFromLine(line: string): number | null {
  const m = line.match(/PRism listening on https?:\/\/[^:]+:(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Poll GET <baseUrl>/api/health until 200 or timeout. Returns true on success. */
export async function pollHealth(
  baseUrl: string,
  timeoutMs: number,
  intervalMs = 200,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // sidecar not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
