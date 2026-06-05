import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenableUrl } from "../src/urls";

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
  assert.equal(isOpenableUrl("data:text/html,<script>alert(1)</script>"), false);
});

test("isOpenableUrl rejects malformed input", () => {
  assert.equal(isOpenableUrl("not a url"), false);
  assert.equal(isOpenableUrl(""), false);
});
