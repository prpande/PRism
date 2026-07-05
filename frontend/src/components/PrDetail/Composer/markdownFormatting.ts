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

// Count non-overlapping occurrences of `needle` in `haystack`.
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

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

  // Toggle off — markers immediately outside the selection (selection inside a
  // pair, e.g. **|foo|**). GUARDED so adjacent independent runs are not merged:
  // the outside marker counts as an opening delimiter only when an ODD number of
  // markers precede the selection, and the core itself must not contain the
  // marker. Without this, italic on `_a_b_c_` @ (3,4) would strip the a/c
  // underscores into `_abc_` — which then posts wrong to GitHub.
  if (
    before.endsWith(marker) &&
    after.startsWith(marker) &&
    !core.includes(marker) &&
    occurrences(before, marker) % 2 === 1
  ) {
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

function toggleLinePrefix(prefix: string, text: string, start: number, end: number): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allPrefixed = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));
    if (allPrefixed) {
      return lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
    }
    return lines.map((l) => (l.trim().length > 0 && !l.startsWith(prefix) ? prefix + l : l));
  });
}

// "- " is a prefix of the task marker "- [ ] ", so bulleted and task must be
// mutually aware or they corrupt each other's lines (bulleted-on-a-task strips
// the checkbox; task-on-a-bullet double-prefixes).
const TASK_RE = /^- \[[ xX]\] /;

function isPlainBullet(l: string): boolean {
  return l.startsWith('- ') && !TASK_RE.test(l);
}

function formatBulleted(text: string, start: number, end: number): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allBulleted = nonEmpty.length > 0 && nonEmpty.every(isPlainBullet);
    if (allBulleted) {
      return lines.map((l) => (isPlainBullet(l) ? l.slice(2) : l));
    }
    return lines.map((l) => {
      if (l.trim().length === 0) return l;
      if (isPlainBullet(l) || TASK_RE.test(l)) return l; // already a list item
      return '- ' + l;
    });
  });
}

function formatTask(text: string, start: number, end: number): FormatResult {
  return withBlock(text, start, end, (lines) => {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allTask = nonEmpty.length > 0 && nonEmpty.every((l) => TASK_RE.test(l));
    if (allTask) {
      return lines.map((l) => l.replace(TASK_RE, ''));
    }
    return lines.map((l) => {
      if (l.trim().length === 0) return l;
      if (TASK_RE.test(l)) return l;
      if (l.startsWith('- ')) return '- [ ] ' + l.slice(2); // convert bullet -> task
      return '- [ ] ' + l;
    });
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
      return formatBulleted(text, start, end);
    case 'numbered':
      return formatNumbered(text, start, end);
    case 'task':
      return formatTask(text, start, end);
    default:
      return { value: text, selectionStart: start, selectionEnd: end };
  }
}
