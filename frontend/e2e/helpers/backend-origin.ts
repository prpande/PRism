// Centralized backend origin for e2e helpers/specs that hit ABSOLUTE backend
// URLs (/test/*, /api/*) or set an Origin header.
//
// #239: PRISM_E2E_PORT (#217) parameterizes the port the backend is booted on so
// multiple agents/worktrees can run the suite in parallel. Relative page.goto
// paths and baseURL already honor it, but absolute URLs and Origin headers were
// hardcoded to :5180 — so a run on a non-default port booted the backend on (e.g.)
// 5205 while every absolute helper call hit 5180 → ECONNREFUSED. Reading the port
// here, in one place, keeps the served port and the origin used by helpers in sync.
//
// The parse logic MIRRORS playwright.config.ts's parseE2ePort: require an integer
// in the valid TCP range, else fall back to 5180. The two must agree — if the
// config boots on a port this helper wouldn't derive, absolute calls would miss it.
const DEFAULT_E2E_PORT = 5180;

function parseE2ePort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_E2E_PORT;
}

/** The port the e2e backend is served on this run (default 5180). */
export const E2E_PORT = parseE2ePort(process.env.PRISM_E2E_PORT);

/**
 * The backend origin for this run, e.g. `http://localhost:5205`. Use for both
 * absolute fetch URLs (`${BACKEND_ORIGIN}/test/reset`) and the `Origin` header —
 * OriginCheckMiddleware rejects a mutating verb whose Origin doesn't match the
 * served host.
 */
export const BACKEND_ORIGIN = `http://localhost:${E2E_PORT}`;
