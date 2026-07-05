# #586 — Composer Markdown Formatting Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub-style markdown formatting toolbar — one shared `<FormattingToolbar>` driven by a surface-agnostic handle — to all three PR-detail comment composers, relocating the existing footer Preview toggle into it as a `Write | Preview` segmented control.

**Architecture:** A pure DOM-free transform engine (`markdownFormatting.ts`) computes each edit `(text, selStart, selEnd) => { value, selectionStart, selectionEnd }`. A thin application layer (`applyFormatting.ts`) applies the edit via `document.execCommand('insertText')` (undo-preserving in Chromium/Electron) with a `setRangeText` fallback, syncs React state, and restores caret + focus. A presentational `FormattingToolbar.tsx` renders the segmented control + a WAI-ARIA `role="toolbar"` of format buttons, owns the shared `runAction`/caret-restore mechanism, and calls `useFormattingShortcuts` for Ctrl/Cmd+B/I/K/E. A `ToolbarOverflowMenu.tsx` collapses low-priority buttons behind a "…" menu at narrow widths. The three composers each render `<FormattingToolbar handle={…} />`; the bespoke Overview composer reaches its textarea through a new optional `textAreaRef` prop on `PrRootBodyEditor`. No backend, wire, or DTO change.

**Tech Stack:** React 18 + TypeScript + Vite; vitest + @testing-library/react + jsdom; existing `MarkdownRenderer` (remark-gfm) reused for preview; inline 16×16 `currentColor` SVG icons (convention from `FilesTab/diffIcons.tsx`); CSS custom properties in `frontend/src/styles/tokens.css`.

## Global Constraints

- **Worktree only.** All work happens in `D:\src\PRism\.claude\worktrees\586-composer-formatting-toolbar` on branch `worktree-586-composer-formatting-toolbar`. Never edit the launch checkout `D:\src\PRism`. Derive every path from the worktree root.
- **GFM round-trip is a tested constraint.** Every token the engine emits MUST match GitHub's own composer output because comments post **verbatim** to GitHub: bold `**…**`, italic `_…_`, strikethrough `~~…~~`, inline `` `…` ``, fenced ```` ```\n…\n``` ````, `[text](url)`, ATX headings `# `/`## `/`### `, blockquote `> `, bullets `- ` (hyphen, **not** `*`), ordered `1. `, task `- [ ] `. Engine tests assert the **exact emitted string**.
- **Shortcut path honors the disable gate.** `useFormattingShortcuts` early-returns when `handle.disabled` is true. A `Ctrl/Cmd+B` pressed while `disabled` (read-only or posting) fires **no** transform and **no** `onChange` — this closes the #601/#644 autosave-vs-post race for the keyboard path exactly as the buttons already close it.
- **Undo-preserving application.** Apply edits with `document.execCommand('insertText', …)`; fall back to `setRangeText` only when `execCommand` returns false/throws (jsdom, non-Chromium), emitting a one-time dev-only `console.warn`.
- **10 buttons, no `@`/`#`.** Bold, Italic, Strikethrough, Code, Link, Heading, Quote, Bulleted list, Numbered list, Task list. `@`/`#` are cut this slice (follow-up issue with real autocomplete).
- **SubmitDialog is untouched.** It mounts `PrRootBodyEditor` without the new ref prop and renders no toolbar — behavior- and pixel-identical to today.
- **No new markdown sanitization/render path.** Reuse `MarkdownRenderer` / `ComposerMarkdownPreview` as-is.
- **CI gates.** `npm run lint` includes `prettier --check` and `eslint` — run `prettier --write` on every new/edited file. Typecheck with `tsc -b` (NOT `tsc --noEmit`, which is vacuous here). Run the frontend suite via `node_modules/.bin/vitest` (never `npx vitest`). Unused params satisfy eslint when prefixed `_`.
- **Commits:** conventional scope `feat(#586):`/`test(#586):`/`refactor(#586):`/`style(#586):`. Use bare `#586` — do NOT use a closing keyword (`fix(#586)` or "Closes #586") in commit subjects; the issue stays open until the PR closes it. Every commit ends with the two trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HUnfWat3YPn4JzJCYHVzbv
  ```
- **B1 live gate.** #586 is UI-visual gated: final acceptance requires a human live pass in the running Electron app across all three composers, both themes, and narrow inline width (Task 10).

## File Structure

All new files under `frontend/src/components/PrDetail/Composer/`.

| File | Responsibility | Task |
|------|----------------|------|
| `markdownFormatting.ts` | Pure DOM-free transform engine + `FormatAction`/`FormatResult` types + `applyMarkdownFormat` dispatch. Wrap family in Task 1, line-prefix family in Task 2. | 1, 2 |
| `markdownFormatting.test.ts` | Exhaustive engine unit tests, exact GFM strings. | 1, 2 |
| `applyFormatting.ts` | Application layer: minimal-span `execCommand('insertText')` + `setRangeText` fallback + dev warn + `onChange` + caret. | 3 |
| `applyFormatting.test.ts` | jsdom fallback-path tests (value, selection, `onChange` payload, type-after-edit caret). | 3 |
| `formattingIcons.tsx` | 10 inline 16×16 `currentColor` SVG icon components + a `MoreIcon` kebab. | 4 |
| `formattingIcons.test.tsx` | Smoke test: each icon renders an `aria-hidden` `<svg>`. | 4 |
| `formattingHandle.ts` | The `FormattingHandle` interface. | 5 |
| `useFormattingShortcuts.ts` | Ctrl/Cmd+B/I/K/E → `runAction`; early-returns when `handle.disabled`. | 5 |
| `useFormattingShortcuts.test.tsx` | Fires the right action; **no-op while disabled**. | 5 |
| `FormattingToolbar.tsx` | Segmented `Write \| Preview` control + `role="toolbar"` roving buttons; owns `runAction` + caret-restore + focus flow; calls `useFormattingShortcuts`. | 6 |
| `FormattingToolbar.test.tsx` | Render/roving/gating/focus-flow/click-invokes-transform tests. | 6 |
| `ToolbarOverflowMenu.tsx` | "…" (More) WAI-ARIA menu-button holding overflowed buttons. | 7 |
| `ToolbarOverflowMenu.test.tsx` | Overflow split, menu a11y, menuitem invokes transform. | 7 |

Modified files: `styles/tokens.css` (Task 6/7), `InlineCommentComposer.tsx` + `ReplyComposer.tsx` + `ComposerActionsBar.tsx` + `ComposerActionsBar.test.tsx` (Task 8), `PrRootBodyEditor.tsx` + `PrRootReplyComposer.tsx` (+ tests) (Task 9).

---

## Task 1: Engine — types, dispatch, and the wrap family (bold / italic / strikethrough / code / link)

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/markdownFormatting.ts`
- Test: `frontend/src/components/PrDetail/Composer/markdownFormatting.test.ts`

**Interfaces:**
- Produces:
  - `interface FormatResult { value: string; selectionStart: number; selectionEnd: number }`
  - `type FormatAction = 'bold' | 'italic' | 'strikethrough' | 'code' | 'link' | 'heading' | 'quote' | 'bulleted' | 'numbered' | 'task'`
  - `function applyMarkdownFormat(action: FormatAction, text: string, selStart: number, selEnd: number): FormatResult`
  - (Task 1 implements the wrap/link cases; Task 2 implements the line-prefix cases. Both dispatch through `applyMarkdownFormat`.)

- [ ] **Step 1: Write the failing wrap-family tests**

Create `markdownFormatting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyMarkdownFormat } from './markdownFormatting';

describe('applyMarkdownFormat — bold', () => {
  it('wraps a selection in ** ** and keeps the core selected', () => {
    // "foo bar" with "bar" (4..7) selected
    const r = applyMarkdownFormat('bold', 'foo bar', 4, 7);
    expect(r.value).toBe('foo **bar**');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('inserts an empty pair with the caret parked between on an empty selection', () => {
    const r = applyMarkdownFormat('bold', 'foo ', 4, 4);
    expect(r.value).toBe('foo ****');
    expect(r.selectionStart).toBe(6);
    expect(r.selectionEnd).toBe(6);
  });

  it('toggles off when the selection already includes the markers', () => {
    const r = applyMarkdownFormat('bold', 'foo **bar**', 4, 11); // "**bar**" selected
    expect(r.value).toBe('foo bar');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('toggles off when the selection sits inside an existing pair (bold-inside-bold)', () => {
    const r = applyMarkdownFormat('bold', '**bar**', 2, 5); // "bar" selected, markers outside
    expect(r.value).toBe('bar');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('keeps a trailing space outside the markers', () => {
    const r = applyMarkdownFormat('bold', 'foo bar ', 4, 8); // "bar " selected (trailing space)
    expect(r.value).toBe('foo **bar** ');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });
});

describe('applyMarkdownFormat — italic', () => {
  it('wraps with single underscores (GFM), not asterisks', () => {
    const r = applyMarkdownFormat('italic', 'a foo b', 2, 5);
    expect(r.value).toBe('a _foo_ b');
  });

  it('does NOT treat a surrounding ** bold ** boundary as an italic pair', () => {
    // selecting "foo" inside **foo** must ADD italic, not strip bold
    const r = applyMarkdownFormat('italic', '**foo**', 2, 5);
    expect(r.value).toBe('**_foo_**');
  });
});

describe('applyMarkdownFormat — strikethrough', () => {
  it('wraps with ~~ ~~', () => {
    const r = applyMarkdownFormat('strikethrough', 'foo', 0, 3);
    expect(r.value).toBe('~~foo~~');
  });
});

describe('applyMarkdownFormat — code', () => {
  it('wraps a single-line selection in inline backticks', () => {
    const r = applyMarkdownFormat('code', 'foo bar', 4, 7);
    expect(r.value).toBe('foo `bar`');
  });

  it('toggles inline backticks off', () => {
    const r = applyMarkdownFormat('code', 'foo `bar`', 4, 9);
    expect(r.value).toBe('foo bar');
  });

  it('wraps a multi-line selection in a fenced block', () => {
    const r = applyMarkdownFormat('code', 'a\nb', 0, 3);
    expect(r.value).toBe('```\na\nb\n```');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('a\nb');
  });

  it('strips a selected fenced block (toggle off)', () => {
    const r = applyMarkdownFormat('code', '```\na\nb\n```', 0, 11);
    expect(r.value).toBe('a\nb');
  });
});

describe('applyMarkdownFormat — link', () => {
  it('wraps a selection as [selection](url) with url selected', () => {
    const r = applyMarkdownFormat('link', 'see foo', 4, 7);
    expect(r.value).toBe('see [foo](url)');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('url');
  });

  it('inserts [text](url) with text selected on an empty selection', () => {
    const r = applyMarkdownFormat('link', '', 0, 0);
    expect(r.value).toBe('[text](url)');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('text');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/markdownFormatting.test.ts`
Expected: FAIL — `applyMarkdownFormat` is not defined / module not found.

- [ ] **Step 3: Implement the engine core + wrap family**

Create `markdownFormatting.ts`:

```ts
export interface FormatResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'link'
  | 'heading'
  | 'quote'
  | 'bulleted'
  | 'numbered'
  | 'task';

/**
 * Pure, DOM-free markdown transform. Given the full text and the current
 * selection, returns the next value and where the selection should land.
 * Every emitted token is GitHub-Flavored Markdown (see plan Global Constraints).
 */
export function applyMarkdownFormat(
  action: FormatAction,
  text: string,
  selStart: number,
  selEnd: number,
): FormatResult {
  switch (action) {
    case 'bold':
      return wrapSymmetric('**', text, selStart, selEnd);
    case 'italic':
      return wrapSymmetric('_', text, selStart, selEnd);
    case 'strikethrough':
      return wrapSymmetric('~~', text, selStart, selEnd);
    case 'code':
      return formatCode(text, selStart, selEnd);
    case 'link':
      return formatLink(text, selStart, selEnd);
    // Line-prefix actions are implemented in Task 2.
    case 'heading':
    case 'quote':
    case 'bulleted':
    case 'numbered':
    case 'task':
      return formatLinePrefixAction(action, text, selStart, selEnd);
    default:
      return { value: text, selectionStart: selStart, selectionEnd: selEnd };
  }
}

// --- wrap family -----------------------------------------------------------

// Wrap the selection's non-whitespace core in `marker` on both sides, or strip
// the marker if it is already present immediately inside OR immediately outside
// the selection (toggle). Leading/trailing whitespace stays outside the marker.
function wrapSymmetric(marker: string, text: string, start: number, end: number): FormatResult {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  const leadingWs = /^\s*/.exec(selected)![0];
  const trailingWs = /\s*$/.exec(selected)![0];
  const core = selected.slice(leadingWs.length, selected.length - trailingWs.length);
  const m = marker.length;

  // Toggle off — markers included inside the selected core.
  if (core.length >= 2 * m && core.startsWith(marker) && core.endsWith(marker)) {
    const inner = core.slice(m, core.length - m);
    const value = before + leadingWs + inner + trailingWs + after;
    const s = start + leadingWs.length;
    return { value, selectionStart: s, selectionEnd: s + inner.length };
  }

  // Toggle off — markers immediately outside the selection (selection inside a pair).
  if (before.endsWith(marker) && after.startsWith(marker)) {
    const value =
      before.slice(0, before.length - m) + leadingWs + core + trailingWs + after.slice(m);
    const s = start - m + leadingWs.length;
    return { value, selectionStart: s, selectionEnd: s + core.length };
  }

  // Wrap on — empty selection parks the caret between the pair.
  if (core.length === 0) {
    const value = before + leadingWs + marker + marker + trailingWs + after;
    const caret = before.length + leadingWs.length + m;
    return { value, selectionStart: caret, selectionEnd: caret };
  }

  const value = before + leadingWs + marker + core + marker + trailingWs + after;
  const s = start + leadingWs.length + m;
  return { value, selectionStart: s, selectionEnd: s + core.length };
}

function formatCode(text: string, start: number, end: number): FormatResult {
  const selected = text.slice(start, end);
  if (!selected.includes('\n')) {
    return wrapSymmetric('`', text, start, end);
  }
  const before = text.slice(0, start);
  const after = text.slice(end);

  // Toggle off — the selection is already a fenced block.
  if (selected.startsWith('```') && selected.trimEnd().endsWith('```')) {
    const inner = selected.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
    const value = before + inner + after;
    return { value, selectionStart: before.length, selectionEnd: before.length + inner.length };
  }

  const wrapped = '```\n' + selected + '\n```';
  const value = before + wrapped + after;
  const innerStart = before.length + 4; // past the leading "```\n"
  return { value, selectionStart: innerStart, selectionEnd: innerStart + selected.length };
}

function formatLink(text: string, start: number, end: number): FormatResult {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (selected.length === 0) {
    const value = before + '[text](url)' + after;
    const s = before.length + 1; // after "["
    return { value, selectionStart: s, selectionEnd: s + 'text'.length };
  }

  const value = before + `[${selected}](url)` + after;
  const urlStart = before.length + 1 + selected.length + 2; // "[" + selected + "]("
  return { value, selectionStart: urlStart, selectionEnd: urlStart + 'url'.length };
}

// Implemented in Task 2. Declared here so the dispatch compiles in Task 1;
// Task 2 replaces this stub with the real implementation.
function formatLinePrefixAction(
  _action: FormatAction,
  text: string,
  start: number,
  end: number,
): FormatResult {
  return { value: text, selectionStart: start, selectionEnd: end };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/markdownFormatting.test.ts`
Expected: PASS (all wrap-family tests green; line-prefix actions are still stubbed and untested until Task 2).

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/markdownFormatting.ts src/components/PrDetail/Composer/markdownFormatting.test.ts
git add frontend/src/components/PrDetail/Composer/markdownFormatting.ts frontend/src/components/PrDetail/Composer/markdownFormatting.test.ts
git commit -m "feat(#586): markdown transform engine — wrap/code/link family"
```

---

## Task 2: Engine — line-prefix family (heading cycle / quote / bulleted / numbered / task)

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/markdownFormatting.ts`
- Test: `frontend/src/components/PrDetail/Composer/markdownFormatting.test.ts`

**Interfaces:**
- Consumes: `applyMarkdownFormat`, `FormatResult`, `FormatAction` from Task 1.
- Produces: the real `formatLinePrefixAction` (replaces the Task 1 stub). No new exports.

- [ ] **Step 1: Write the failing line-prefix tests**

Append to `markdownFormatting.test.ts`:

```ts
describe('applyMarkdownFormat — quote / bulleted / task', () => {
  it('prefixes every selected non-empty line with "> "', () => {
    const r = applyMarkdownFormat('quote', 'a\nb', 0, 3);
    expect(r.value).toBe('> a\n> b');
  });

  it('toggles the quote prefix off when all non-empty lines carry it', () => {
    const r = applyMarkdownFormat('quote', '> a\n> b', 0, 7);
    expect(r.value).toBe('a\nb');
  });

  it('uses "- " (hyphen) for bulleted lists, not "*"', () => {
    const r = applyMarkdownFormat('bulleted', 'a\nb', 0, 3);
    expect(r.value).toBe('- a\n- b');
  });

  it('uses GFM "- [ ] " for task lists', () => {
    const r = applyMarkdownFormat('task', 'do it', 0, 5);
    expect(r.value).toBe('- [ ] do it');
  });

  it('leaves blank lines unprefixed', () => {
    const r = applyMarkdownFormat('bulleted', 'a\n\nb', 0, 4);
    expect(r.value).toBe('- a\n\n- b');
  });
});

describe('applyMarkdownFormat — numbered list', () => {
  it('numbers each non-empty line sequentially from 1.', () => {
    const r = applyMarkdownFormat('numbered', 'a\nb\nc', 0, 5);
    expect(r.value).toBe('1. a\n2. b\n3. c');
  });

  it('toggles numbering off when every non-empty line is already numbered', () => {
    const r = applyMarkdownFormat('numbered', '1. a\n2. b', 0, 9);
    expect(r.value).toBe('a\nb');
  });
});

describe('applyMarkdownFormat — heading cycle', () => {
  it('adds "### " (H3) by default', () => {
    const r = applyMarkdownFormat('heading', 'Title', 0, 5);
    expect(r.value).toBe('### Title');
  });

  it('cycles ### -> ## on a second application', () => {
    const r = applyMarkdownFormat('heading', '### Title', 0, 9);
    expect(r.value).toBe('## Title');
  });

  it('cycles ## -> #', () => {
    const r = applyMarkdownFormat('heading', '## Title', 0, 8);
    expect(r.value).toBe('# Title');
  });

  it('cycles # -> stripped', () => {
    const r = applyMarkdownFormat('heading', '# Title', 0, 7);
    expect(r.value).toBe('Title');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/markdownFormatting.test.ts`
Expected: FAIL — the line-prefix `describe` blocks fail (stub returns the text unchanged).

- [ ] **Step 3: Replace the stub with the real line-prefix implementation**

In `markdownFormatting.ts`, delete the `formatLinePrefixAction` stub and replace it with:

```ts
// --- line-prefix family ----------------------------------------------------

// Expand [start, end] to whole-line bounds. A selection whose end sits at the
// very start of a line (right after a "\n") does NOT include that line.
function selectedLineRange(
  text: string,
  start: number,
  end: number,
): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let searchFrom = end;
  if (end > start && end > 0 && text[end - 1] === '\n') searchFrom = end - 1;
  let lineEnd = text.indexOf('\n', searchFrom);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd };
}

function withBlock(
  text: string,
  start: number,
  end: number,
  transform: (lines: string[]) => string[],
): FormatResult {
  const { lineStart, lineEnd } = selectedLineRange(text, start, end);
  const before = text.slice(0, lineStart);
  const block = text.slice(lineStart, lineEnd);
  const after = text.slice(lineEnd);
  const newBlock = transform(block.split('\n')).join('\n');
  const value = before + newBlock + after;
  return { value, selectionStart: lineStart, selectionEnd: lineStart + newBlock.length };
}

function toggleLinePrefix(
  prefix: string,
  text: string,
  start: number,
  end: number,
): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allPrefixed = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));
    if (allPrefixed) {
      return lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
    }
    return lines.map((l) => (l.trim().length > 0 && !l.startsWith(prefix) ? prefix + l : l));
  });
}

const NUMBERED_RE = /^\d+\.\s/;

function formatNumbered(text: string, start: number, end: number): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allNumbered = nonEmpty.length > 0 && nonEmpty.every((l) => NUMBERED_RE.test(l));
    if (allNumbered) {
      return lines.map((l) => l.replace(NUMBERED_RE, ''));
    }
    let n = 0;
    return lines.map((l) => {
      if (l.trim().length === 0) return l;
      n += 1;
      return `${n}. ${l.replace(NUMBERED_RE, '')}`;
    });
  });
}

const HEADING_RE = /^(#{1,6})\s+/;

// H3 default; cycles ### -> ## -> # -> (stripped) based on the first non-empty line.
function cycleHeading(text: string, start: number, end: number): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
    const m = HEADING_RE.exec(firstNonEmpty);
    const current = m ? m[1].length : 0;
    const next = current === 0 ? 3 : current === 3 ? 2 : current === 2 ? 1 : 0;
    const nextPrefix = next === 0 ? '' : '#'.repeat(next) + ' ';
    return lines.map((l) => {
      if (l.trim().length === 0) return l;
      return nextPrefix + l.replace(HEADING_RE, '');
    });
  });
}

function formatLinePrefixAction(
  action: FormatAction,
  text: string,
  start: number,
  end: number,
): FormatResult {
  switch (action) {
    case 'heading':
      return cycleHeading(text, start, end);
    case 'quote':
      return toggleLinePrefix('> ', text, start, end);
    case 'bulleted':
      return toggleLinePrefix('- ', text, start, end);
    case 'numbered':
      return formatNumbered(text, start, end);
    case 'task':
      return toggleLinePrefix('- [ ] ', text, start, end);
    default:
      return { value: text, selectionStart: start, selectionEnd: end };
  }
}
```

- [ ] **Step 4: Run the full engine suite to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/markdownFormatting.test.ts`
Expected: PASS — every wrap and line-prefix test green.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/markdownFormatting.ts src/components/PrDetail/Composer/markdownFormatting.test.ts
git add frontend/src/components/PrDetail/Composer/markdownFormatting.ts frontend/src/components/PrDetail/Composer/markdownFormatting.test.ts
git commit -m "feat(#586): markdown transform engine — line-prefix family + heading cycle"
```

---

## Task 3: Application layer (`applyFormatting.ts`)

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/applyFormatting.ts`
- Test: `frontend/src/components/PrDetail/Composer/applyFormatting.test.ts`

**Interfaces:**
- Consumes: `applyMarkdownFormat`, `FormatAction` from Task 1/2.
- Produces: `function applyFormatting(textarea: HTMLTextAreaElement, action: FormatAction, onChange: (next: string) => void): { selectionStart: number; selectionEnd: number }`. It focuses the textarea, applies the minimal-diff edit undoably (`execCommand('insertText')` with a `setRangeText` fallback), calls `onChange` with the resulting value, sets the selection, and returns the target selection so the caller can re-assert it.

- [ ] **Step 1: Write the failing application-layer tests**

Create `applyFormatting.test.ts` (jsdom exercises the `setRangeText` fallback because it does not implement `execCommand('insertText')`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { applyFormatting } from './applyFormatting';

function makeTextarea(value: string, selStart: number, selEnd: number): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.value = value;
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  return ta;
}

describe('applyFormatting', () => {
  it('applies the engine edit to the textarea value (fallback path)', () => {
    const ta = makeTextarea('foo bar', 4, 7);
    const onChange = vi.fn();
    applyFormatting(ta, 'bold', onChange);
    expect(ta.value).toBe('foo **bar**');
    expect(onChange).toHaveBeenCalledWith('foo **bar**');
  });

  it('leaves the engine selection on the textarea', () => {
    const ta = makeTextarea('see foo', 4, 7);
    const sel = applyFormatting(ta, 'link', () => {});
    // "[foo](url)" — "url" is selected
    expect(ta.value).toBe('see [foo](url)');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('url');
    expect(sel.selectionStart).toBe(ta.selectionStart);
    expect(sel.selectionEnd).toBe(ta.selectionEnd);
  });

  it('parks the caret so the next typed character lands inside the pair', () => {
    const ta = makeTextarea('x ', 2, 2);
    applyFormatting(ta, 'bold', () => {});
    // "x ****", caret between the pairs at index 4
    ta.setRangeText('Z', ta.selectionStart, ta.selectionEnd, 'end');
    expect(ta.value).toBe('x **Z**');
  });

  it('warns once (dev) when execCommand is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ta = makeTextarea('a', 0, 1);
    applyFormatting(ta, 'bold', () => {});
    // jsdom has no execCommand insertText -> fallback -> dev warn at most once
    warn.mockRestore();
    expect(ta.value).toBe('**a**');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/applyFormatting.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `applyFormatting.ts`**

```ts
import { applyMarkdownFormat, type FormatAction } from './markdownFormatting';

let warnedOnce = false;

// Smallest [start, oldEnd) span that differs between oldStr and newStr, plus the
// replacement text for that span. Keeps execCommand's undo entry scoped to the
// region the format actually changed instead of the whole buffer.
function minimalReplaceSpan(
  oldStr: string,
  newStr: string,
): { start: number; oldEnd: number; replacement: string } {
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start += 1;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { start, oldEnd, replacement: newStr.slice(start, newEnd) };
}

/**
 * Apply a markdown transform to a textarea, preserving native undo where the
 * runtime supports it (Chromium/Electron: execCommand('insertText')). Falls back
 * to setRangeText (jsdom, non-Chromium) with a one-time dev warning because that
 * path does not push a native undo entry. Returns the target selection so the
 * caller can re-assert it after React commits (see FormattingToolbar caret token).
 */
export function applyFormatting(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  onChange: (next: string) => void,
): { selectionStart: number; selectionEnd: number } {
  const value = textarea.value;
  const result = applyMarkdownFormat(action, value, textarea.selectionStart, textarea.selectionEnd);
  const span = minimalReplaceSpan(value, result.value);

  textarea.focus();
  textarea.setSelectionRange(span.start, span.oldEnd);

  let ok = false;
  try {
    ok = document.execCommand('insertText', false, span.replacement);
  } catch {
    ok = false;
  }
  if (!ok) {
    if (import.meta.env?.DEV && !warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[applyFormatting] execCommand insertText unavailable; falling back to setRangeText (native undo not preserved).',
      );
    }
    textarea.setRangeText(span.replacement, span.start, span.oldEnd, 'preserve');
  }

  onChange(textarea.value);
  textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
  return { selectionStart: result.selectionStart, selectionEnd: result.selectionEnd };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/applyFormatting.test.ts`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/applyFormatting.ts src/components/PrDetail/Composer/applyFormatting.test.ts
git add frontend/src/components/PrDetail/Composer/applyFormatting.ts frontend/src/components/PrDetail/Composer/applyFormatting.test.ts
git commit -m "feat(#586): applyFormatting application layer (execCommand + setRangeText fallback)"
```

---

## Task 4: Formatting icons (`formattingIcons.tsx`)

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/formattingIcons.tsx`
- Test: `frontend/src/components/PrDetail/Composer/formattingIcons.test.tsx`

**Interfaces:**
- Produces: named components `BoldIcon`, `ItalicIcon`, `StrikethroughIcon`, `CodeIcon`, `LinkIcon`, `HeadingIcon`, `QuoteIcon`, `BulletListIcon`, `NumberedListIcon`, `TaskListIcon`, `MoreIcon` — each a 16×16 `currentColor` SVG with `aria-hidden` + `focusable="false"`. Also `ICONS: Record<FormatAction, () => JSX.Element>` mapping each action to its icon.

- [ ] **Step 1: Write the failing icon smoke test**

Create `formattingIcons.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ICONS, MoreIcon } from './formattingIcons';
import type { FormatAction } from './markdownFormatting';

const ACTIONS: FormatAction[] = [
  'bold',
  'italic',
  'strikethrough',
  'code',
  'link',
  'heading',
  'quote',
  'bulleted',
  'numbered',
  'task',
];

describe('formattingIcons', () => {
  it.each(ACTIONS)('renders an aria-hidden svg for %s', (action) => {
    const Icon = ICONS[action];
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.getAttribute('focusable')).toBe('false');
  });

  it('renders the More (kebab) icon', () => {
    const { container } = render(<MoreIcon />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/formattingIcons.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `formattingIcons.tsx`**

```tsx
import type { FormatAction } from './markdownFormatting';

const SVG = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function BoldIcon() {
  return (
    <svg {...SVG}>
      <text x="3" y="12" fontSize="12" fontWeight="700" fill="currentColor">
        B
      </text>
    </svg>
  );
}

export function ItalicIcon() {
  return (
    <svg {...SVG}>
      <text x="4" y="12" fontSize="12" fontStyle="italic" fill="currentColor">
        I
      </text>
    </svg>
  );
}

export function StrikethroughIcon() {
  return (
    <svg {...SVG}>
      <text x="3" y="11" fontSize="11" fill="currentColor">
        S
      </text>
      <line x1="2.5" y1="8" x2="13.5" y2="8" {...stroke} />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg {...SVG}>
      <polyline points="6,4 2,8 6,12" {...stroke} />
      <polyline points="10,4 14,8 10,12" {...stroke} />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg {...SVG}>
      <path d="M6.5 9.5a2.5 2.5 0 0 1 0-3.5l2-2a2.5 2.5 0 0 1 3.5 3.5l-1 1" {...stroke} />
      <path d="M9.5 6.5a2.5 2.5 0 0 1 0 3.5l-2 2a2.5 2.5 0 0 1-3.5-3.5l1-1" {...stroke} />
    </svg>
  );
}

export function HeadingIcon() {
  return (
    <svg {...SVG}>
      <text x="2" y="12" fontSize="11" fontWeight="700" fill="currentColor">
        H
      </text>
    </svg>
  );
}

export function QuoteIcon() {
  return (
    <svg {...SVG}>
      <line x1="3" y1="3" x2="3" y2="13" {...stroke} strokeWidth={2} />
      <line x1="6" y1="5" x2="13" y2="5" {...stroke} />
      <line x1="6" y1="8" x2="13" y2="8" {...stroke} />
      <line x1="6" y1="11" x2="11" y2="11" {...stroke} />
    </svg>
  );
}

export function BulletListIcon() {
  return (
    <svg {...SVG}>
      <circle cx="3" cy="5" r="1" fill="currentColor" />
      <circle cx="3" cy="11" r="1" fill="currentColor" />
      <line x1="6" y1="5" x2="14" y2="5" {...stroke} />
      <line x1="6" y1="11" x2="14" y2="11" {...stroke} />
    </svg>
  );
}

export function NumberedListIcon() {
  return (
    <svg {...SVG}>
      <text x="1.5" y="6.5" fontSize="5" fill="currentColor">
        1
      </text>
      <text x="1.5" y="12.5" fontSize="5" fill="currentColor">
        2
      </text>
      <line x1="6" y1="5" x2="14" y2="5" {...stroke} />
      <line x1="6" y1="11" x2="14" y2="11" {...stroke} />
    </svg>
  );
}

export function TaskListIcon() {
  return (
    <svg {...SVG}>
      <rect x="2" y="3" width="5" height="5" rx="1" {...stroke} />
      <polyline points="3,5.5 4,6.5 6,4" {...stroke} />
      <line x1="9" y1="5.5" x2="14" y2="5.5" {...stroke} />
      <line x1="9" y1="11" x2="14" y2="11" {...stroke} />
      <rect x="2" y="9" width="5" height="5" rx="1" {...stroke} />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...SVG}>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

export const ICONS: Record<FormatAction, () => JSX.Element> = {
  bold: BoldIcon,
  italic: ItalicIcon,
  strikethrough: StrikethroughIcon,
  code: CodeIcon,
  link: LinkIcon,
  heading: HeadingIcon,
  quote: QuoteIcon,
  bulleted: BulletListIcon,
  numbered: NumberedListIcon,
  task: TaskListIcon,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/formattingIcons.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/formattingIcons.tsx src/components/PrDetail/Composer/formattingIcons.test.tsx
git add frontend/src/components/PrDetail/Composer/formattingIcons.tsx frontend/src/components/PrDetail/Composer/formattingIcons.test.tsx
git commit -m "feat(#586): formatting toolbar icons"
```

---

## Task 5: The handle type + keyboard shortcuts (`formattingHandle.ts`, `useFormattingShortcuts.ts`)

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/formattingHandle.ts`
- Create: `frontend/src/components/PrDetail/Composer/useFormattingShortcuts.ts`
- Test: `frontend/src/components/PrDetail/Composer/useFormattingShortcuts.test.tsx`

**Interfaces:**
- Produces:
  - `interface FormattingHandle { textareaRef: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (next: string) => void; previewMode: boolean; onTogglePreview: () => void; disabled: boolean }`
  - `function useFormattingShortcuts(handle: FormattingHandle, runAction: (action: FormatAction) => void): void` — attaches a `keydown` listener to `handle.textareaRef.current` mapping `Ctrl/Cmd+B/I/K/E` to `runAction('bold'|'italic'|'link'|'code')`; **early-returns when `handle.disabled`**.
- Consumes: `FormatAction` from Task 1.

- [ ] **Step 1: Write the failing shortcut tests**

Create `useFormattingShortcuts.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useFormattingShortcuts } from './useFormattingShortcuts';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';

function Harness({ disabled, runAction }: { disabled: boolean; runAction: (a: FormatAction) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const handle: FormattingHandle = {
    textareaRef: ref,
    value: '',
    onChange: () => {},
    previewMode: false,
    onTogglePreview: () => {},
    disabled,
  };
  useFormattingShortcuts(handle, runAction);
  return <textarea ref={ref} aria-label="body" />;
}

describe('useFormattingShortcuts', () => {
  it('maps Ctrl+B/I/K/E to the matching actions', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    const ta = getByLabelText('body');
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'i', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'e', ctrlKey: true });
    expect(runAction.mock.calls.map((c) => c[0])).toEqual(['bold', 'italic', 'link', 'code']);
  });

  it('also maps the Cmd (meta) variants', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', metaKey: true });
    expect(runAction).toHaveBeenCalledWith('bold');
  });

  it('fires NO action while disabled (autosave-race safety)', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={true} runAction={runAction} />);
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', ctrlKey: true });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('ignores reserved combos (Ctrl+Enter, Ctrl+Shift+P)', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    const ta = getByLabelText('body');
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'p', ctrlKey: true, shiftKey: true });
    expect(runAction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/useFormattingShortcuts.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `formattingHandle.ts` and `useFormattingShortcuts.ts`**

`formattingHandle.ts`:

```ts
import type React from 'react';

// The single surface-agnostic interface every composer satisfies. The toolbar
// depends only on this — never on useDraftComposer — which is what lets the
// bespoke PrRootReplyComposer reuse the identical component.
export interface FormattingHandle {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  previewMode: boolean;
  onTogglePreview: () => void;
  // Format-action gate: readOnly || posting (NOT previewMode). Gates the format
  // buttons AND the keyboard-shortcut path; does NOT gate Write | Preview.
  disabled: boolean;
}
```

`useFormattingShortcuts.ts`:

```ts
import { useEffect } from 'react';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';

const KEY_TO_ACTION: Record<string, FormatAction> = {
  b: 'bold',
  i: 'italic',
  k: 'link',
  e: 'code',
};

// Binds Ctrl/Cmd+B/I/K/E on the handle's textarea to the shared runAction. A
// native listener (not the textarea's onKeyDown prop) so it composes with the
// composer's existing matchComposerKey handler without rewiring it. Honors the
// same disable gate as the buttons (§Autosave-race safety): inert under
// posting/read-only, so a mid-post shortcut cannot schedule a draft PUT that
// races the in-flight post.
export function useFormattingShortcuts(
  handle: FormattingHandle,
  runAction: (action: FormatAction) => void,
): void {
  const { textareaRef, disabled } = handle;
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (disabled) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const action = KEY_TO_ACTION[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      runAction(action);
    };
    ta.addEventListener('keydown', onKeyDown);
    return () => ta.removeEventListener('keydown', onKeyDown);
  }, [textareaRef, disabled, runAction]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/useFormattingShortcuts.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/formattingHandle.ts src/components/PrDetail/Composer/useFormattingShortcuts.ts src/components/PrDetail/Composer/useFormattingShortcuts.test.tsx
git add frontend/src/components/PrDetail/Composer/formattingHandle.ts frontend/src/components/PrDetail/Composer/useFormattingShortcuts.ts frontend/src/components/PrDetail/Composer/useFormattingShortcuts.test.tsx
git commit -m "feat(#586): FormattingHandle + Ctrl/Cmd+B/I/K/E shortcuts with disable gate"
```

---

## Task 6: The toolbar (`FormattingToolbar.tsx`) + styling

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/FormattingToolbar.tsx`
- Test: `frontend/src/components/PrDetail/Composer/FormattingToolbar.test.tsx`
- Modify: `frontend/src/styles/tokens.css` (append the `.formatting-toolbar` block)

**Interfaces:**
- Consumes: `FormattingHandle` (Task 5), `applyFormatting` (Task 3), `ICONS` (Task 4), `useFormattingShortcuts` (Task 5), `FormatAction` (Task 1).
- Produces: `function FormattingToolbar({ handle }: { handle: FormattingHandle }): JSX.Element`. Renders the `Write | Preview` segmented control (its own tab stop) plus a `role="toolbar"` of the 10 format buttons (single tab stop via roving tabindex). Owns `runAction` (calls `applyFormatting`, stashes the target caret, bumps a token) and a `useLayoutEffect` that re-asserts the caret after commit; manages focus flow across the preview toggle; calls `useFormattingShortcuts(handle, runAction)`. This task renders **all 10 buttons unconditionally** (no overflow yet — Task 7 adds it).

- [ ] **Step 1: Write the failing toolbar tests**

Create `FormattingToolbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, fireEvent, within } from '@testing-library/react';
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';

function Harness({
  initialValue = 'hello',
  initialPreview = false,
  disabled = false,
  onChangeSpy,
}: {
  initialValue?: string;
  initialPreview?: boolean;
  disabled?: boolean;
  onChangeSpy?: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [previewMode, setPreviewMode] = useState(initialPreview);
  const handle: FormattingHandle = {
    textareaRef: ref,
    value,
    onChange: (v) => {
      setValue(v);
      onChangeSpy?.(v);
    },
    previewMode,
    onTogglePreview: () => setPreviewMode((p) => !p),
    disabled,
  };
  return (
    <div>
      <FormattingToolbar handle={handle} />
      {!previewMode && (
        <textarea ref={ref} aria-label="body" value={value} onChange={(e) => setValue(e.target.value)} />
      )}
    </div>
  );
}

describe('FormattingToolbar', () => {
  it('renders the Write | Preview control and a formatting toolbar with 10 buttons', () => {
    const { getByRole } = render(<Harness />);
    expect(getByRole('button', { name: 'Write' })).toBeTruthy();
    expect(getByRole('button', { name: 'Preview' })).toBeTruthy();
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    expect(within(toolbar).getAllByRole('button').length).toBe(10);
  });

  it('reflects the active view with aria-pressed', () => {
    const { getByRole } = render(<Harness />);
    expect(getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the format buttons in preview mode but keeps the Write | Preview control', () => {
    const { getByRole, queryByRole } = render(<Harness initialPreview />);
    expect(queryByRole('toolbar')).toBeNull();
    expect(getByRole('button', { name: 'Write' })).toBeTruthy();
  });

  it('disables the format buttons when the handle is disabled', () => {
    const { getByRole } = render(<Harness disabled />);
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    within(toolbar)
      .getAllByRole('button')
      .forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
    // Write | Preview stays enabled
    expect((getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('applies a transform when a button is clicked and leaves focus on the textarea', () => {
    const onChangeSpy = vi.fn();
    const { getByRole, getByLabelText } = render(<Harness initialValue="" onChangeSpy={onChangeSpy} />);
    const ta = getByLabelText('body') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
    fireEvent.click(getByRole('button', { name: /Bold/ }));
    expect(onChangeSpy).toHaveBeenCalledWith('****');
    expect(document.activeElement).toBe(ta);
  });

  it('roves focus with ArrowRight/Home/End', () => {
    const { getByRole } = render(<Harness />);
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    const buttons = within(toolbar).getAllByRole('button') as HTMLButtonElement[];
    buttons[0].focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/FormattingToolbar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FormattingToolbar.tsx`**

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';
import { applyFormatting } from './applyFormatting';
import { ICONS } from './formattingIcons';

interface ButtonDef {
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

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

export function buttonTitle(def: ButtonDef): string {
  return def.shortcut ? `${def.label} (${MOD}+${def.shortcut})` : def.label;
}

export function FormattingToolbar({ handle }: { handle: FormattingHandle }) {
  const { textareaRef, previewMode, onTogglePreview, disabled } = handle;

  // Shared apply path: engine edit -> DOM -> onChange -> caret, then re-assert
  // the caret after React commits via a layout effect keyed on this token.
  const pendingCaret = useRef<{ start: number; end: number } | null>(null);
  const [caretToken, setCaretToken] = useState(0);

  const runAction = useCallback(
    (action: FormatAction) => {
      const ta = textareaRef.current;
      if (!ta || disabled) return;
      const sel = applyFormatting(ta, action, handle.onChange);
      pendingCaret.current = { start: sel.selectionStart, end: sel.selectionEnd };
      setCaretToken((t) => t + 1);
    },
    [textareaRef, disabled, handle],
  );

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta && pendingCaret.current) {
      ta.setSelectionRange(pendingCaret.current.start, pendingCaret.current.end);
      ta.focus();
      pendingCaret.current = null;
    }
  }, [caretToken, textareaRef]);

  // Focus flow across the view switch: entering Preview parks focus on the
  // Preview button (the textarea is about to unmount); returning to Write parks
  // focus back on the textarea so the user resumes typing.
  const previewBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevPreview = useRef(previewMode);
  useEffect(() => {
    if (prevPreview.current !== previewMode) {
      if (previewMode) previewBtnRef.current?.focus();
      else textareaRef.current?.focus();
      prevPreview.current = previewMode;
    }
  }, [previewMode, textareaRef]);

  // Roving tabindex across the format buttons.
  const [activeIndex, setActiveIndex] = useState(0);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = TOOLBAR_BUTTONS.length;

  const focusIndex = (i: number) => {
    const clamped = Math.max(0, Math.min(count - 1, i));
    setActiveIndex(clamped);
    btnRefs.current[clamped]?.focus();
  };

  const onToolbarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusIndex(activeIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusIndex(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusIndex(count - 1);
    }
  };

  useFormattingShortcutsBinding(handle, runAction);

  return (
    <div className="formatting-strip">
      <div className="composer-view-switch" role="group" aria-label="Editor view">
        <button
          type="button"
          className="composer-view-switch-btn"
          aria-pressed={!previewMode}
          onClick={() => {
            if (previewMode) onTogglePreview();
          }}
        >
          Write
        </button>
        <button
          ref={previewBtnRef}
          type="button"
          className="composer-view-switch-btn"
          aria-pressed={previewMode}
          onClick={() => {
            if (!previewMode) onTogglePreview();
          }}
        >
          Preview
        </button>
      </div>

      {!previewMode && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="formatting-toolbar"
          onKeyDown={onToolbarKeyDown}
        >
          {TOOLBAR_BUTTONS.map((def, i) => {
            const Icon = ICONS[def.action];
            const prevGroup = i > 0 ? TOOLBAR_BUTTONS[i - 1].group : def.group;
            return (
              <span key={def.action} style={{ display: 'contents' }}>
                {def.group !== prevGroup && (
                  <span role="separator" aria-orientation="vertical" className="formatting-toolbar-sep" />
                )}
                <button
                  ref={(el) => {
                    btnRefs.current[i] = el;
                  }}
                  type="button"
                  className="formatting-toolbar-btn"
                  aria-label={buttonTitle(def)}
                  title={buttonTitle(def)}
                  tabIndex={i === activeIndex ? 0 : -1}
                  disabled={disabled}
                  aria-disabled={disabled || undefined}
                  onFocus={() => setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAction(def.action)}
                >
                  <Icon />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Wrapper so the shortcut hook is always called (rules of hooks) even though the
// toolbar buttons unmount in preview. The hook itself no-ops when the textarea
// ref is null.
function useFormattingShortcutsBinding(
  handle: FormattingHandle,
  runAction: (action: FormatAction) => void,
) {
  useFormattingShortcuts(handle, runAction);
}
```

Add the import at the top of the file:

```tsx
import { useFormattingShortcuts } from './useFormattingShortcuts';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/FormattingToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the toolbar styling to `tokens.css`**

Append to `frontend/src/styles/tokens.css` (after the existing `.composer-preview-toggle` block near line 1166), keyed to the same tokens as the control it replaces:

```css
/* #586 — formatting toolbar strip: a Write|Preview segmented control + a
   role=toolbar of icon buttons, mounted above the textarea. Keyed to the same
   color tokens as the removed .composer-preview-toggle so light/dark parity
   matches the control it replaces. */
.formatting-strip {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 34px; /* stable row height: no reflow when the toolbar hides in preview */
  padding: var(--s-1) var(--s-1) 0;
  flex-wrap: nowrap;
}
.composer-view-switch {
  display: inline-flex;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.composer-view-switch-btn {
  font-size: var(--text-sm);
  font-family: var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  padding: var(--s-1) var(--s-2);
  cursor: pointer;
}
.composer-view-switch-btn:hover {
  color: var(--text-1);
}
.composer-view-switch-btn[aria-pressed='true'] {
  background: var(--surface-3);
  color: var(--text-1);
}
.formatting-toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-1);
  flex: 1 1 auto;
  min-width: 0;
}
.formatting-toolbar-sep {
  width: 1px;
  align-self: stretch;
  margin: 3px var(--s-1);
  background: var(--border-2);
}
.formatting-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-2);
  cursor: pointer;
}
.formatting-toolbar-btn:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--surface-3);
  border-color: var(--border-2);
}
.formatting-toolbar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **Step 6: Verify styling didn't break the build + full-file prettier**

Run: `cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/FormattingToolbar.tsx src/components/PrDetail/Composer/FormattingToolbar.test.tsx src/styles/tokens.css && node_modules/.bin/tsc -b`
Expected: prettier clean; `tsc -b` reports 0 errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/Composer/FormattingToolbar.tsx frontend/src/components/PrDetail/Composer/FormattingToolbar.test.tsx frontend/src/styles/tokens.css
git commit -m "feat(#586): FormattingToolbar — segmented Write|Preview + role=toolbar + styling"
```

---

## Task 7: Overflow "…" menu (`ToolbarOverflowMenu.tsx`) + ResizeObserver wiring

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/ToolbarOverflowMenu.tsx`
- Test: `frontend/src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/FormattingToolbar.tsx` (measure width, split visible vs overflow, render the menu)
- Modify: `frontend/src/styles/tokens.css` (menu styling)

**Interfaces:**
- Consumes: `TOOLBAR_BUTTONS`, `buttonTitle` (Task 6), `ICONS` (Task 4), `MoreIcon` (Task 4), `FormatAction` (Task 1).
- Produces: `function ToolbarOverflowMenu({ items, runAction }: { items: FormatAction[]; runAction: (a: FormatAction) => void }): JSX.Element` — a WAI-ARIA menu-button ("…"): `aria-haspopup="menu"` + `aria-expanded`; opens a `role="menu"` of `role="menuitem"`s; `ArrowUp/Down` navigate; `Escape` closes and returns focus to the trigger; selecting an item runs `runAction`.
- Produces (from FormattingToolbar): overflow priority ranking `OVERFLOW_PRIORITY` and the width-driven split.

- [ ] **Step 1: Write the failing overflow-menu tests**

Create `ToolbarOverflowMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { ToolbarOverflowMenu } from './ToolbarOverflowMenu';

describe('ToolbarOverflowMenu', () => {
  it('renders a collapsed menu-button and expands on click', () => {
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={() => {}} />,
    );
    const trigger = getByRole('button', { name: /More formatting/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('menu')).toBeTruthy();
  });

  it('focuses the first item on open and navigates with ArrowDown', () => {
    const { getByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: /More formatting/i }));
    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('runs the action and closes when a menuitem is chosen', () => {
    const runAction = vi.fn();
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task', 'strikethrough']} runAction={runAction} />,
    );
    fireEvent.click(getByRole('button', { name: /More formatting/i }));
    fireEvent.click(within(getByRole('menu')).getAllByRole('menuitem')[0]);
    expect(runAction).toHaveBeenCalledWith('task');
    expect(queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { getByRole, queryByRole } = render(
      <ToolbarOverflowMenu items={['task']} runAction={() => {}} />,
    );
    const trigger = getByRole('button', { name: /More formatting/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ToolbarOverflowMenu.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { FormatAction } from './markdownFormatting';
import { ICONS, MoreIcon } from './formattingIcons';
import { TOOLBAR_BUTTONS, buttonTitle } from './FormattingToolbar';

function defFor(action: FormatAction) {
  return TOOLBAR_BUTTONS.find((b) => b.action === action)!;
}

export function ToolbarOverflowMenu({
  items,
  runAction,
}: {
  items: FormatAction[];
  runAction: (a: FormatAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      // Focus the first item after it mounts.
      requestAnimationFrame(() => itemRefs.current[0]?.focus());
    }
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(items.length - 1, activeIndex + 1);
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  return (
    <div className="formatting-overflow">
      <button
        ref={triggerRef}
        type="button"
        className="formatting-toolbar-btn"
        aria-label="More formatting options"
        title="More formatting options"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <ul
          role="menu"
          aria-label="More formatting options"
          className="formatting-overflow-menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((action, i) => {
            const def = defFor(action);
            const Icon = ICONS[action];
            return (
              <li key={action} role="none">
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={i === activeIndex ? 0 : -1}
                  className="formatting-overflow-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    runAction(action);
                    close(false);
                  }}
                >
                  <Icon />
                  <span>{buttonTitle(def)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the overflow-menu tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing FormattingToolbar overflow-split test**

Append to `FormattingToolbar.test.tsx`:

```tsx
import { act } from '@testing-library/react';

// A controllable ResizeObserver mock: capture the callback and let the test push
// a container width.
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: ResizeObserverCallback;
  el: Element | null = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.el = el;
  }
  unobserve() {}
  disconnect() {}
  emit(width: number) {
    this.cb(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

describe('FormattingToolbar — overflow', () => {
  it('collapses low-priority buttons into the "…" menu at a constrained width', () => {
    const orig = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const { getByRole, queryByRole } = render(<Harness />);
      act(() => {
        // ~5 buttons' worth of width -> the tail (strikethrough, task, …) overflows.
        MockResizeObserver.instances.at(-1)!.emit(180);
      });
      const toolbar = getByRole('toolbar', { name: 'Formatting' });
      // High-priority buttons stay visible; a More button appears.
      expect(within(toolbar).getByRole('button', { name: /Bold/ })).toBeTruthy();
      expect(getByRole('button', { name: /More formatting/i })).toBeTruthy();
      // Strikethrough (lowest priority) is no longer a direct toolbar button.
      expect(within(toolbar).queryByRole('button', { name: /Strikethrough/ })).toBeNull();
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = orig;
    }
  });

  it('shows no "…" button when everything fits', () => {
    const orig = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const { getByRole, queryByRole } = render(<Harness />);
      act(() => {
        MockResizeObserver.instances.at(-1)!.emit(2000);
      });
      expect(within(getByRole('toolbar')).getAllByRole('button').length).toBe(10);
      expect(queryByRole('button', { name: /More formatting/i })).toBeNull();
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = orig;
    }
  });
});
```

- [ ] **Step 6: Run to verify the overflow-split tests fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/FormattingToolbar.test.tsx`
Expected: FAIL — no overflow behavior yet (all 10 always render; no "More" button).

- [ ] **Step 7: Wire the ResizeObserver split into `FormattingToolbar.tsx`**

Add near the top of `FormattingToolbar.tsx`, after `TOOLBAR_BUTTONS`:

```tsx
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

const BTN_WIDTH = 32; // px per icon button incl. gap (approx; measured live)
const MORE_WIDTH = 32; // px for the "…" trigger
```

Add the import:

```tsx
import { ToolbarOverflowMenu } from './ToolbarOverflowMenu';
```

Inside `FormattingToolbar`, add container measurement state and effect (place beside the roving state):

```tsx
const toolbarRef = useRef<HTMLDivElement | null>(null);
const [maxVisible, setMaxVisible] = useState(TOOLBAR_BUTTONS.length);

useEffect(() => {
  const el = toolbarRef.current;
  if (!el || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? el.clientWidth;
    const fitsAll = Math.floor(width / BTN_WIDTH);
    if (fitsAll >= TOOLBAR_BUTTONS.length) {
      setMaxVisible(TOOLBAR_BUTTONS.length);
    } else {
      // Reserve room for the "…" trigger among the visible slots.
      setMaxVisible(Math.max(1, Math.floor((width - MORE_WIDTH) / BTN_WIDTH)));
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
}, [previewMode]);

// Split by priority; render in display order.
const visibleActions = new Set(OVERFLOW_PRIORITY.slice(0, maxVisible));
const overflowActions = OVERFLOW_PRIORITY.slice(maxVisible);
const visibleButtons = TOOLBAR_BUTTONS.filter((b) => visibleActions.has(b.action));
const overflowInDisplayOrder = TOOLBAR_BUTTONS.filter((b) => overflowActions.includes(b.action)).map(
  (b) => b.action,
);
```

Change the toolbar `<div role="toolbar">` to attach `ref={toolbarRef}`, iterate `visibleButtons` instead of `TOOLBAR_BUTTONS`, fix the roving index bookkeeping to the visible count, and append the overflow menu:

```tsx
{!previewMode && (
  <div
    ref={toolbarRef}
    role="toolbar"
    aria-label="Formatting"
    className="formatting-toolbar"
    onKeyDown={onToolbarKeyDown}
  >
    {visibleButtons.map((def, i) => {
      const Icon = ICONS[def.action];
      const prevGroup = i > 0 ? visibleButtons[i - 1].group : def.group;
      return (
        <span key={def.action} style={{ display: 'contents' }}>
          {def.group !== prevGroup && (
            <span role="separator" aria-orientation="vertical" className="formatting-toolbar-sep" />
          )}
          <button
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            className="formatting-toolbar-btn"
            aria-label={buttonTitle(def)}
            title={buttonTitle(def)}
            tabIndex={i === activeIndex ? 0 : -1}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onFocus={() => setActiveIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runAction(def.action)}
          >
            <Icon />
          </button>
        </span>
      );
    })}
    {overflowInDisplayOrder.length > 0 && (
      <ToolbarOverflowMenu items={overflowInDisplayOrder} runAction={runAction} />
    )}
  </div>
)}
```

Update `count` and `focusIndex` to use `visibleButtons.length` (the roving set is the visible buttons; the "…" trigger is a natural focus stop after them). Change `const count = TOOLBAR_BUTTONS.length;` to `const count = visibleButtons.length;` and move that declaration below the split so it sees `visibleButtons`.

- [ ] **Step 8: Add overflow-menu styling to `tokens.css`**

Append:

```css
/* #586 — overflow "…" menu */
.formatting-overflow {
  position: relative;
  display: inline-flex;
}
.formatting-overflow-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 20;
  margin: var(--s-1) 0 0;
  padding: var(--s-1);
  list-style: none;
  min-width: 180px;
  background: var(--surface-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  box-shadow: var(--shadow-2);
}
.formatting-overflow-item {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: var(--s-1) var(--s-2);
  font-size: var(--text-sm);
  font-family: var(--font-sans);
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: var(--radius-1);
  cursor: pointer;
  text-align: left;
}
.formatting-overflow-item:hover,
.formatting-overflow-item:focus-visible {
  background: var(--surface-3);
  outline: none;
}
```

- [ ] **Step 9: Run the full toolbar + overflow suite and typecheck**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/FormattingToolbar.test.tsx src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx && node_modules/.bin/tsc -b`
Expected: PASS; `tsc -b` 0 errors.

- [ ] **Step 10: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/ToolbarOverflowMenu.tsx src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx src/components/PrDetail/Composer/FormattingToolbar.tsx src/components/PrDetail/Composer/FormattingToolbar.test.tsx src/styles/tokens.css
git add frontend/src/components/PrDetail/Composer/ToolbarOverflowMenu.tsx frontend/src/components/PrDetail/Composer/ToolbarOverflowMenu.test.tsx frontend/src/components/PrDetail/Composer/FormattingToolbar.tsx frontend/src/components/PrDetail/Composer/FormattingToolbar.test.tsx frontend/src/styles/tokens.css
git commit -m "feat(#586): ResizeObserver overflow '...' menu for narrow composer widths"
```

---

## Task 8: Wire #1/#2 + remove Preview from `ComposerActionsBar`

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx`
- Test: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`

**Interfaces:**
- Consumes: `FormattingToolbar` (Task 6/7), `FormattingHandle` (Task 5), the `editor`/`actions` slices of `useDraftComposer` (unchanged).
- Produces: nothing new. `ComposerActionsBar` keeps its `previewMode`/`onTogglePreview` props (they now feed the toolbar) but no longer renders the Preview `<button>`.

- [ ] **Step 1: Update the failing `ComposerActionsBar` test**

In `ComposerActionsBar.test.tsx`, the button-order assertion currently expects `['Preview', 'Discard', 'Add to review', 'Comment']`. Change it to drop `'Preview'`:

```tsx
expect(buttons).toEqual(['Discard', 'Add to review', 'Comment']);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`
Expected: FAIL — `'Preview'` is still rendered, so the array includes it.

- [ ] **Step 3: Remove the Preview button from `ComposerActionsBar.tsx`**

Delete the left-group Preview `<button className="composer-preview-toggle">…</button>` (lines 64-71). Keep the `previewMode`/`onTogglePreview` props on the interface and in the destructure (they are still passed through by `useDraftComposer` and consumed by the toolbar via the composer). To satisfy eslint no-unused-vars, prefix them in the destructure since the bar no longer reads them:

Change the destructure to `previewMode: _previewMode, onTogglePreview: _onTogglePreview,` OR remove them from the destructure while keeping them on the props type. Simplest: remove `previewMode` and `onTogglePreview` from the destructure list (they stay declared on `ComposerActionsBarProps` for the spread contract) — an unread prop in the type is fine; an unused destructured binding is the lint error. Verify by leaving them out of the destructure.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Render `<FormattingToolbar>` in `InlineCommentComposer.tsx`**

Add the import:

```tsx
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';
```

Build the handle and render the toolbar at the top of the composer body, above the `{editor.previewMode ? … : <textarea/>}` swap:

```tsx
  const handle: FormattingHandle = {
    textareaRef: editor.textareaRef,
    value: editor.body,
    onChange: editor.setBody,
    previewMode: editor.previewMode,
    onTogglePreview: actions.onTogglePreview,
    disabled: editor.readOnly || actions.posting,
  };

  return (
    <div
      role="form"
      aria-label={composerAriaLabel(anchor)}
      data-composer="true"
      data-testid="inline-comment-composer"
      className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}
    >
      <FormattingToolbar handle={handle} />
      {editor.previewMode ? (
        <ComposerMarkdownPreview body={editor.body} />
      ) : (
        <textarea
          /* …unchanged… */
        />
      )}
      <ComposerActionsBar {...actions} />
      {/* …unchanged… */}
    </div>
  );
```

- [ ] **Step 6: Render `<FormattingToolbar>` in `ReplyComposer.tsx`**

Apply the identical change to `ReplyComposer.tsx`: import `FormattingToolbar` + `FormattingHandle`, build the same `handle` (using its `editor`/`actions`), and render `<FormattingToolbar handle={handle} />` at the top of the body above the preview/textarea swap.

- [ ] **Step 7: Run the composer suites + typecheck**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer && node_modules/.bin/tsc -b`
Expected: PASS; `tsc -b` 0 errors. (The existing `useDraftComposer` / `InlineCommentComposer` / `ReplyComposer` tests still pass — the toolbar is additive; no prop contract changed.)

- [ ] **Step 8: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/InlineCommentComposer.tsx src/components/PrDetail/Composer/ReplyComposer.tsx src/components/PrDetail/Composer/ComposerActionsBar.tsx src/components/PrDetail/Composer/ComposerActionsBar.test.tsx
git add frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx frontend/src/components/PrDetail/Composer/ReplyComposer.tsx frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx
git commit -m "feat(#586): wire toolbar into inline+reply composers; move Preview into the toolbar"
```

---

## Task 9: Wire #3 (`PrRootReplyComposer`) via a new `PrRootBodyEditor` ref prop + remove footer Preview

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
- Test: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx`

**Interfaces:**
- Consumes: `FormattingToolbar` (Task 6/7), `FormattingHandle` (Task 5).
- Produces: `PrRootBodyEditor` gains an **optional** prop `textAreaRef?: React.RefObject<HTMLTextAreaElement | null>` attached via a merged callback-ref alongside its internal ref. When omitted (SubmitDialog), behavior is identical to today.

- [ ] **Step 1: Write the failing test — toolbar present in the Overview composer, footer Preview gone**

Add to `PrRootReplyComposer.test.tsx` (follow the file's existing render/setup helpers; a minimal new test):

```tsx
it('renders the formatting toolbar and no footer Preview toggle', () => {
  renderComposer(); // existing helper that mounts PrRootReplyComposer with required props
  // Toolbar present with the Write | Preview segmented control.
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  // The old footer `.composer-preview-toggle` button is gone: exactly one control
  // switches preview now (the segmented one), so there is no button literally
  // labelled "Preview"/"Edit" in the footer actions row.
  const actions = document.querySelector('.composer-actions')!;
  expect(actions.querySelector('.composer-preview-toggle')).toBeNull();
});
```

If `PrRootReplyComposer.test.tsx` has no reusable `renderComposer`/`screen` setup, mirror the render harness already used by the other tests in that file (props: `prRef`, `prState`, `draftId`, `onDraftIdChange`, `registerOpenComposer`, `onClose`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx`
Expected: FAIL — no toolbar; the footer still has `.composer-preview-toggle`.

- [ ] **Step 3: Add the optional external ref to `PrRootBodyEditor.tsx`**

Add the prop to the interface:

```tsx
  // #586 — optional external textarea ref, attached via a merged callback-ref
  // alongside the internal ref. Supplied by PrRootReplyComposer so its toolbar
  // can act on this textarea; omitted by SubmitDialog (no toolbar there).
  textAreaRef?: React.RefObject<HTMLTextAreaElement | null>;
```

Add `textAreaRef` to the destructured props, import `React` type if not already, and replace the plain `ref={textareaRef}` with a merged callback-ref:

```tsx
  const setTextAreaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      if (textAreaRef) textAreaRef.current = el;
    },
    [textAreaRef],
  );
```

and on the `<textarea>`: `ref={setTextAreaRef}`.

- [ ] **Step 4: Render the toolbar in `PrRootReplyComposer.tsx` and remove the footer Preview button**

Add imports:

```tsx
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';
```

Create a ref the parent shares with both the editor and the toolbar handle:

```tsx
  const bodyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const formattingHandle: FormattingHandle = {
    textareaRef: bodyTextAreaRef,
    value: body,
    onChange: handleBodyChange,
    previewMode,
    onTogglePreview: () => setPreviewMode((p) => !p),
    disabled: readOnly || postInFlight,
  };
```

Render `<FormattingToolbar handle={formattingHandle} />` at the top of the composer body — above the `<div hidden={previewMode}>` editor block:

```tsx
  return (
    <div
      role="form"
      aria-label="Reply to this PR"
      data-composer="true"
      className={`composer-frame ${styles.prRootReplyComposer}`}
      onKeyDown={handleKeyDown}
    >
      <FormattingToolbar handle={formattingHandle} />
      <div hidden={previewMode}>
        <PrRootBodyEditor
          /* …existing props… */
          textAreaRef={bodyTextAreaRef}
        />
      </div>
      {/* …preview + error… */}
```

Pass `textAreaRef={bodyTextAreaRef}` to `PrRootBodyEditor`. Then **remove** the footer Preview button (the left-group `<button className="composer-preview-toggle">…</button>`, lines 228-235). `previewMode` remains owned by the composer and now flows into the toolbar's segmented control.

Note: `handleKeyDown` on the outer div still owns `Ctrl/Cmd+Shift+P` (preview), `Ctrl/Cmd+Enter` (submit), `Escape` via `matchComposerKey`; the toolbar's `useFormattingShortcuts` owns `Ctrl/Cmd+B/I/K/E` on the textarea — disjoint keys, no collision.

- [ ] **Step 5: Run the Overview composer suite + typecheck**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx src/components/PrDetail/Composer/PrRootReplyComposer.badge.test.tsx && node_modules/.bin/tsc -b`
Expected: PASS; `tsc -b` 0 errors.

- [ ] **Step 6: Confirm SubmitDialog is untouched**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail` and grep to confirm `SubmitDialog` still mounts `PrRootBodyEditor` **without** `textAreaRef` and renders no `FormattingToolbar`.

Run: `git grep -n "PrRootBodyEditor" frontend/src/components/PrDetail/SubmitDialog.tsx`
Expected: the SubmitDialog mount has no `textAreaRef` prop (the prop is optional; behavior identical to today).

- [ ] **Step 7: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/Composer/PrRootBodyEditor.tsx src/components/PrDetail/Composer/PrRootReplyComposer.tsx src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx
git add frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx frontend/src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx
git commit -m "feat(#586): wire toolbar into the Overview root composer via an optional editor ref"
```

---

## Task 10: Full verification, live B1 pass, and follow-up issue

**Files:** none (verification + issue filing).

- [ ] **Step 1: Full frontend suite**

Run: `cd frontend && node_modules/.bin/vitest run`
Expected: PASS — the entire suite green (all new Composer tests + no regressions). Record the count for the PR body.

- [ ] **Step 2: Lint + prettier + typecheck (the CI gate)**

Run: `cd frontend && node_modules/.bin/tsc -b && npm run lint`
Expected: `tsc -b` 0 errors; `eslint` clean; `prettier --check` clean.

- [ ] **Step 3: Live B1 pass in the running app**

Launch per the repo recipe (`run.ps1 -Reset None --no-browser`, real PAT, serve-detached on the real DataDir), open a real PR, and verify in the running Electron app:
  - **All three composers** render the toolbar: Files inline (#1), thread reply (#2), Overview reply (#3).
  - Each of the 10 buttons wraps/inserts the correct GFM around a selection, **toggles off** on a second click, restores the caret, and **returns focus to the textarea**.
  - `Ctrl/Cmd+B/I/K/E` fire the same transforms and are **undoable** with `Ctrl/Cmd+Z` (real native undo — the execCommand path, not the jsdom fallback).
  - `Write | Preview` switches views with the defined focus flow (Preview → focus the control; Write → focus the textarea) and **no layout shift** (stable strip height).
  - **Both themes** (light/dark) — the toolbar/segmented-control colors match the control they replaced.
  - **Narrow inline width** — the "…" overflow menu appears, keeps the priority buttons visible, and is keyboard-operable (open → first item focused; ArrowUp/Down; Escape returns focus to "…").
  - Format buttons are **disabled while posting** and greyed in read-only; the shortcut path is inert then too (type mid-post: no toolbar effect).
  - Capture before/after screenshots (both themes + narrow width) for the PR per the visual-verification recipe.

- [ ] **Step 4: File the `@`/`#` autocomplete follow-up issue**

Create a GitHub issue for real `@`-mention / `#`-reference autocomplete (participant / PR fuzzy-search popovers), cross-linked from #586, noting it reintroduces the two cut toolbar buttons **with actual behavior**. Record its number for the #586 PR body and the spec §Follow-up.

- [ ] **Step 5: Raise the PR**

Run `/simplify` on the branch diff first (quality pass — it edits the tree, so run before the final verify), then open the PR via `pr-autopilot`. PR body includes: the AC checklist, the machine-review dispositions, the live-pass screenshots, "Closes #586", and a link to the follow-up issue.

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:
- Goals 1–8 → Tasks 1–9 (shared toolbar T6/7; wrap/insert+caret+focus T3/6; undo T3; shortcuts T5; a11y T6/7; Preview relocation T8/9; MarkdownRenderer reuse — unchanged; GFM constraint T1/2 assertions).
- §The actions / §Toggle contract → Task 1 (wrap/code/link) + Task 2 (line-prefix, heading cycle, numbered renumber) with exact-string tests.
- §Application vector → Task 3 (minimal span, execCommand + fallback + dev warn, caret) + Task 6 (useLayoutEffect caret re-assert token).
- §Autosave-race safety → Task 5 (disabled early-return + no-op-while-disabled test) + handle `disabled = readOnly || posting` in Tasks 8/9.
- §Accessibility → Task 6 (segmented control separate tab stop + aria-pressed; role=toolbar roving; titles; separators; mousedown-preventDefault; focus flow) + Task 7 (menu-button pattern).
- §Degradation → Task 6 (hidden-in-preview / disabled gating; stable strip height in CSS).
- §Styling & theming → Task 6/7 CSS keyed to `.composer-preview-toggle` tokens; both-theme check in Task 10.
- §Responsive overflow → Task 7.
- §Testing → each task's tests + Task 10 live pass.
- §Non-goals: SubmitDialog untouched (Task 9 step 6); `@`/`#` cut (Task 10 follow-up); no aria-pressed toggle-state on format buttons (buttons carry no aria-pressed in Task 6).

**2. Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows complete code; every test step shows real assertions.

**3. Type consistency.** `FormatResult`/`FormatAction` (Task 1) used unchanged in Tasks 2/3/5/6/7. `FormattingHandle` (Task 5) used identically in Tasks 6/8/9. `applyFormatting(textarea, action, onChange) → { selectionStart, selectionEnd }` (Task 3) called with that exact shape in Task 6. `ICONS: Record<FormatAction, …>` + `MoreIcon` (Task 4) consumed in Tasks 6/7. `TOOLBAR_BUTTONS`/`buttonTitle`/`OVERFLOW_PRIORITY` exported from Task 6, imported in Task 7. `ToolbarOverflowMenu({ items, runAction })` (Task 7) matches its FormattingToolbar call site.

**One deviation from the spec, flagged per the plan-deviation rule:** the spec's §wiring says each composer calls `useFormattingShortcuts(handle)`. This plan instead has **`FormattingToolbar` call `useFormattingShortcuts(handle, runAction)`** so a single owner holds `runAction` + the caret-restore token + the shortcut binding (avoids duplicating that mechanism in every composer). All spec-required properties hold: shortcuts operate on the textarea, share the `applyFormatting` path (undoable), honor the disable gate, and use disjoint keys from `matchComposerKey`. The toolbar is always mounted (spec §Degradation), so the hook is always active in edit mode. This is an internal structural refinement, not a behavior change; it is recorded here and will be noted in the PR's Proof section.
