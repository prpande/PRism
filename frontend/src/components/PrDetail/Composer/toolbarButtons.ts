// #586 — shared metadata for the formatting toolbar buttons.
// Extracted from FormattingToolbar so ToolbarOverflowMenu can read
// TOOLBAR_BUTTONS / buttonTitle without a circular import (FormattingToolbar
// imports ToolbarOverflowMenu, so ToolbarOverflowMenu must not import back from
// it). This module holds pure data + a formatter — no React, no DOM.
import type { FormatAction } from './markdownFormatting';

export interface ButtonDef {
  action: FormatAction;
  label: string;
  shortcut?: string;
  group: number; // 0 = wrap, 1 = code/link, 2 = line-prefix
}

// Display order (grouped wrap · code/link · line-prefix).
export const TOOLBAR_BUTTONS: ButtonDef[] = [
  { action: 'bold', label: 'Bold', shortcut: 'B', group: 0 },
  { action: 'italic', label: 'Italic', shortcut: 'I', group: 0 },
  { action: 'strikethrough', label: 'Strikethrough', group: 0 },
  { action: 'code', label: 'Code', shortcut: 'E', group: 1 },
  { action: 'link', label: 'Link', shortcut: 'K', group: 1 },
  { action: 'heading', label: 'Heading', group: 2 },
  { action: 'quote', label: 'Quote', group: 2 },
  { action: 'bulleted', label: 'Bulleted list', group: 2 },
  { action: 'numbered', label: 'Numbered list', group: 2 },
  { action: 'task', label: 'Task list', group: 2 },
];

// Keep-visible priority (index 0 overflows LAST). The tail overflows first.
export const OVERFLOW_PRIORITY: FormatAction[] = [
  'bold',
  'italic',
  'link',
  'code',
  'quote',
  'bulleted',
  'numbered',
  'heading',
  'task',
  'strikethrough',
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

export function buttonTitle(def: ButtonDef): string {
  return def.shortcut ? `${def.label} (${MOD}+${def.shortcut})` : def.label;
}
