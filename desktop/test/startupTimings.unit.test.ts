import { test } from "node:test";
import assert from "node:assert/strict";
import { attribute, formatSummary, Phase } from "../src/startupTimings";

// A complete, self-consistent set of epoch-ms marks + process creation time.
//   C (processCreationTime) = 688
//   moduleLoad=1000 whenReady=1044 sidecarSpawn=1050
//   portReceived=3230 healthOk=3350 contentLoaded=3540
const C = 688;
const fullMarks = (): Map<Phase, number> =>
  new Map<Phase, number>([
    ["moduleLoad", 1000],
    ["whenReady", 1044],
    ["sidecarSpawn", 1050],
    ["portReceived", 3230],
    ["healthOk", 3350],
    ["contentLoaded", 3540],
  ]);

test("attribute computes every region from a complete mark set", () => {
  const a = attribute(fullMarks(), C);
  assert.equal(a.preJs, 312); // moduleLoad - C
  assert.equal(a.electronInit, 44); // whenReady - moduleLoad
  assert.equal(a.sidecarBoot, 2180); // portReceived - sidecarSpawn
  assert.equal(a.healthPoll, 120); // healthOk - portReceived
  assert.equal(a.spaLoad, 190); // contentLoaded - healthOk
  assert.equal(a.totalInstrumented, 2540); // contentLoaded - moduleLoad
  assert.equal(a.procToContent, 2852); // contentLoaded - C
});

test("attribute nulls only the regions whose endpoint mark is missing", () => {
  const marks = fullMarks();
  marks.delete("healthOk");
  const a = attribute(marks, C);
  assert.equal(a.healthPoll, null, "healthPoll needs healthOk");
  assert.equal(a.spaLoad, null, "spaLoad needs healthOk");
  // Regions that don't depend on healthOk still compute.
  assert.equal(a.electronInit, 44);
  assert.equal(a.sidecarBoot, 2180);
  assert.equal(a.totalInstrumented, 2540);
  assert.equal(a.preJs, 312);
  assert.equal(a.procToContent, 2852);
});

test("attribute degrades preJs/procToContent to null when getCreationTime is null", () => {
  const a = attribute(fullMarks(), null);
  assert.equal(a.preJs, null);
  assert.equal(a.procToContent, null);
  // Post-JS regions are unaffected by a missing process-creation anchor.
  assert.equal(a.totalInstrumented, 2540);
  assert.equal(a.electronInit, 44);
});

test("formatSummary renders a greppable single line for a full attribution", () => {
  const line = formatSummary(attribute(fullMarks(), C));
  assert.equal(
    line,
    "[startup] preJs=312 electronInit=44 sidecarBoot=2180 healthPoll=120 spaLoad=190 totalInstrumented=2540 procToContent=2852 (ms)",
  );
});

test("formatSummary renders null regions as n/a", () => {
  const marks = fullMarks();
  marks.delete("healthOk");
  const line = formatSummary(attribute(marks, null));
  assert.equal(
    line,
    "[startup] preJs=n/a electronInit=44 sidecarBoot=2180 healthPoll=n/a spaLoad=n/a totalInstrumented=2540 procToContent=n/a (ms)",
  );
});
