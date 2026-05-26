export interface ShortcutRow {
  keys: string;
  context: string;
  action: string;
}

export interface ShortcutGroup {
  group: string;
  rows: ReadonlyArray<ShortcutRow>;
}

export const SHORTCUTS: ReadonlyArray<ShortcutGroup> = [
  {
    group: 'Global',
    rows: [
      {
        keys: 'Cmd/Ctrl + R',
        context: 'Anywhere',
        action: 'Reload current view (closes the cheatsheet)',
      },
      { keys: 'Cmd/Ctrl + /', context: 'Anywhere', action: 'Toggle this cheatsheet' },
      { keys: '?', context: 'Outside text inputs', action: 'Toggle this cheatsheet' },
      { keys: 'Esc', context: 'Cheatsheet open', action: 'Close cheatsheet' },
    ],
  },
  {
    group: 'File tree',
    rows: [
      { keys: 'j', context: 'File tree', action: 'Next file' },
      { keys: 'k', context: 'File tree', action: 'Previous file' },
      { keys: 'v', context: 'File tree (file focused)', action: 'Toggle "Viewed" checkbox' },
    ],
  },
  {
    group: 'Diff',
    rows: [
      { keys: 'n', context: 'Diff', action: 'Next comment thread' },
      { keys: 'p', context: 'Diff', action: 'Previous comment thread' },
      { keys: 'c', context: 'Diff (line focused)', action: 'Open comment composer' },
    ],
  },
  {
    group: 'Composer',
    rows: [
      { keys: 'Cmd/Ctrl + Enter', context: 'Composer', action: 'Save draft' },
      { keys: 'Esc', context: 'Composer (non-empty)', action: 'Cancel (with discard confirm)' },
    ],
  },
  {
    group: 'Submit dialog',
    rows: [
      { keys: 'Cmd/Ctrl + Enter', context: 'Submit dialog focused', action: 'Confirm submit' },
    ],
  },
];
