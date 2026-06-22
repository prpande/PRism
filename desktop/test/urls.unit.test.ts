import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenableUrl,
  navigationDecision,
  windowOpenDecision,
} from "../src/urls";

const APP_ORIGIN = "http://127.0.0.1:5180";

test("isOpenableUrl accepts an https URL", () => {
  assert.equal(isOpenableUrl("https://github.com/o/r/pull/1"), true);
});

test("isOpenableUrl accepts uppercase HTTPS (URL normalizes the scheme)", () => {
  assert.equal(isOpenableUrl("HTTPS://github.com/o/r/pull/1"), true);
});

test("isOpenableUrl rejects http", () => {
  assert.equal(isOpenableUrl("http://github.com/o/r/pull/1"), false);
});

test("isOpenableUrl rejects file:", () => {
  assert.equal(isOpenableUrl("file:///etc/passwd"), false);
});

test("isOpenableUrl rejects javascript:", () => {
  assert.equal(isOpenableUrl("javascript:alert(1)"), false);
});

test("isOpenableUrl rejects data:", () => {
  assert.equal(
    isOpenableUrl("data:text/html,<script>alert(1)</script>"),
    false,
  );
});

test("isOpenableUrl rejects malformed input", () => {
  assert.equal(isOpenableUrl("not a url"), false);
  assert.equal(isOpenableUrl(""), false);
});

test("windowOpenDecision always denies the in-app window", () => {
  assert.equal(
    windowOpenDecision("https://github.com/o/r/pull/1").action,
    "deny",
  );
  assert.equal(windowOpenDecision("javascript:alert(1)").action, "deny");
  assert.equal(windowOpenDecision("not a url").action, "deny");
});

test("windowOpenDecision opens https in the OS browser, rejects the rest", () => {
  assert.equal(windowOpenDecision("https://github.com/o/r/pull/1").open, true);
  assert.equal(windowOpenDecision("http://github.com/o/r/pull/1").open, false);
  assert.equal(windowOpenDecision("file:///etc/passwd").open, false);
  assert.equal(windowOpenDecision("javascript:alert(1)").open, false);
  assert.equal(windowOpenDecision("not a url").open, false);
});

test("navigationDecision allows same-origin navigation (in-app routing)", () => {
  assert.deepEqual(navigationDecision(`${APP_ORIGIN}/pr/42`, APP_ORIGIN), {
    prevent: false,
    open: false,
  });
  // bare origin + trailing slash are still same-origin
  assert.deepEqual(navigationDecision(`${APP_ORIGIN}/`, APP_ORIGIN), {
    prevent: false,
    open: false,
  });
});

test("navigationDecision prevents cross-origin nav and opens https in the OS browser", () => {
  assert.deepEqual(
    navigationDecision("https://github.com/o/r/pull/1", APP_ORIGIN),
    { prevent: true, open: true },
  );
});

test("navigationDecision prevents a different loopback port (cross-origin)", () => {
  // A different port is a different origin — must not be treated as in-app.
  assert.deepEqual(navigationDecision("http://127.0.0.1:9999/x", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
});

test("navigationDecision prevents non-https cross-origin without opening", () => {
  // http / file / mailto are admitted by the renderer's urlTransform (mailto) or
  // are otherwise parseable, but the https-only egress invariant blocks the open.
  assert.deepEqual(navigationDecision("http://github.com/x", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
  assert.deepEqual(navigationDecision("file:///etc/passwd", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
  assert.deepEqual(navigationDecision("mailto:dev@example.com", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
});

test("navigationDecision prevents (never opens) an unparseable target", () => {
  assert.deepEqual(navigationDecision("not a url", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
  assert.deepEqual(navigationDecision("", APP_ORIGIN), {
    prevent: true,
    open: false,
  });
});
