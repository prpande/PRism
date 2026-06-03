import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortFromLine } from "../src/ports";

test("parsePortFromLine extracts the port from the listening line", () => {
  const line = "PRism listening on http://127.0.0.1:5183 (dataDir: /home/u/.prism)";
  assert.equal(parsePortFromLine(line), 5183);
});

test("parsePortFromLine returns null for unrelated lines", () => {
  assert.equal(parsePortFromLine("some other log line"), null);
});

test("parsePortFromLine handles localhost host form too", () => {
  assert.equal(parsePortFromLine("PRism listening on http://localhost:5180 (dataDir: x)"), 5180);
});
