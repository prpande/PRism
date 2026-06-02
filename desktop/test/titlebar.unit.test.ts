import { test } from "node:test";
import assert from "node:assert/strict";
import {
  titleBarOverlayOptions,
  DEFAULT_TITLEBAR_HEIGHT,
  COMPACT_TITLEBAR_HEIGHT,
} from "../src/titlebar";

test("dark theme maps to a dark overlay color and a light symbol glyph", () => {
  const o = titleBarOverlayOptions("dark", "comfortable");
  assert.equal(o.color, "#2a2d31");
  assert.equal(o.symbolColor, "#e6e7e9");
});

test("light theme maps to a white overlay color and a dark symbol glyph", () => {
  const o = titleBarOverlayOptions("light", "comfortable");
  assert.equal(o.color, "#ffffff");
  assert.equal(o.symbolColor, "#1a1c1e");
});

test("an unknown/system theme string is treated as light (the SPA resolves 'system' before writing data-theme)", () => {
  const o = titleBarOverlayOptions("system", "comfortable");
  assert.equal(o.color, "#ffffff");
  assert.equal(o.symbolColor, "#1a1c1e");
});

test("compact density shrinks the overlay height to match the 48px compact header", () => {
  assert.equal(titleBarOverlayOptions("light", "compact").height, COMPACT_TITLEBAR_HEIGHT);
  assert.equal(COMPACT_TITLEBAR_HEIGHT, 48);
});

test("comfortable (and any non-compact) density uses the 56px default header height", () => {
  assert.equal(titleBarOverlayOptions("light", "comfortable").height, DEFAULT_TITLEBAR_HEIGHT);
  assert.equal(titleBarOverlayOptions("dark", "anything-else").height, DEFAULT_TITLEBAR_HEIGHT);
  assert.equal(DEFAULT_TITLEBAR_HEIGHT, 56);
});
