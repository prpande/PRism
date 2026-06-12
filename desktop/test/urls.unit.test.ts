import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenableUrl, windowOpenDecision } from "../src/urls";

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
