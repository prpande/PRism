// Startup timing attribution for the desktop cold-start (#282 Part 1).
//
// Pure, I/O-free, no Electron imports — unit-testable exactly like planSpawn /
// parsePortFromLine. main.ts owns a `Map<Phase, number>` of epoch-ms marks (one
// `marks.set(phase, Date.now())` per fixed bootstrap call site) and reads
// process.getCreationTime(); this module owns only the arithmetic + formatting.
//
// Region model (see the spec): the launch splits into pre-JS regions 1-2
// (portable extraction + AV scan, NOT instrumentable from inside) and the
// instrumented post-process-creation regions. procToContent is the subtraction
// anchor: regions 1-2 = wall-clock T - procToContent.

export type Phase =
  | "moduleLoad"
  | "whenReady"
  | "sidecarSpawn"
  | "portReceived"
  | "healthOk"
  | "contentLoaded";

export interface RegionAttribution {
  preJs: number | null; // moduleLoad - processCreationTime (Chromium/Electron pre-JS init)
  electronInit: number | null; // R3: whenReady - moduleLoad
  sidecarBoot: number | null; // R4a: portReceived - sidecarSpawn (blends single-file extract + JIT)
  healthPoll: number | null; // R4b: healthOk - portReceived
  spaLoad: number | null; // R5: contentLoaded - healthOk
  totalInstrumented: number | null; // contentLoaded - moduleLoad (all post-JS regions)
  procToContent: number | null; // contentLoaded - processCreationTime (the subtraction anchor)
}

// Field render order — also the formatSummary column order.
const FIELDS: readonly (keyof RegionAttribution)[] = [
  "preJs",
  "electronInit",
  "sidecarBoot",
  "healthPoll",
  "spaLoad",
  "totalInstrumented",
  "procToContent",
];

/** end - start when both marks are present, else null. */
function span(marks: ReadonlyMap<Phase, number>, start: Phase, end: Phase): number | null {
  const a = marks.get(start);
  const b = marks.get(end);
  return a === undefined || b === undefined ? null : b - a;
}

/** mark - anchor when both are present, else null (anchor is process creation, not a Phase). */
function fromAnchor(marks: ReadonlyMap<Phase, number>, mark: Phase, anchor: number | null): number | null {
  const m = marks.get(mark);
  return m === undefined || anchor === null ? null : m - anchor;
}

export function attribute(
  marks: ReadonlyMap<Phase, number>,
  processCreationTime: number | null,
): RegionAttribution {
  return {
    preJs: fromAnchor(marks, "moduleLoad", processCreationTime),
    electronInit: span(marks, "moduleLoad", "whenReady"),
    sidecarBoot: span(marks, "sidecarSpawn", "portReceived"),
    healthPoll: span(marks, "portReceived", "healthOk"),
    spaLoad: span(marks, "healthOk", "contentLoaded"),
    totalInstrumented: span(marks, "moduleLoad", "contentLoaded"),
    procToContent: fromAnchor(marks, "contentLoaded", processCreationTime),
  };
}

/** One greppable line; null regions render as `n/a` so a partial startup still parses. */
export function formatSummary(attr: RegionAttribution): string {
  const parts = FIELDS.map((f) => `${f}=${attr[f] === null ? "n/a" : attr[f]}`);
  return `[startup] ${parts.join(" ")} (ms)`;
}
