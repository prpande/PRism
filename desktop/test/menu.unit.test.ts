import { test } from "node:test";
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions } from "electron";
import {
  applicationMenuTemplate,
  editableContextMenuTemplate,
} from "../src/menu";

function rolesFrom(items: MenuItemConstructorOptions[]): string[] {
  return items
    .filter(
      (item): item is MenuItemConstructorOptions & { role: string } =>
        typeof item.role === "string",
    )
    .map((item) => item.role);
}

test("applicationMenuTemplate preserves standard macOS Edit shortcuts", () => {
  const template = applicationMenuTemplate("darwin");
  assert.ok(template);
  const editMenu = template.find(
    (item: MenuItemConstructorOptions) => item.label === "Edit",
  );
  assert.ok(editMenu);
  assert.ok(Array.isArray(editMenu.submenu));
  const roles = rolesFrom(editMenu.submenu);
  assert.deepEqual(roles, [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ]);
});

test("applicationMenuTemplate stays disabled off macOS", () => {
  assert.equal(applicationMenuTemplate("win32"), null);
  assert.equal(applicationMenuTemplate("linux"), null);
});

test("editableContextMenuTemplate includes the standard text-edit roles", () => {
  const roles = rolesFrom(editableContextMenuTemplate());
  assert.deepEqual(roles, [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ]);
});
