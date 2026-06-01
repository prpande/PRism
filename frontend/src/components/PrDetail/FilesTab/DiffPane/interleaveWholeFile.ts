import type { DiffLine, FileChange } from '../../../../api/types';

export function parseHunkLines(body: string): DiffLine[] {
  const rawLines = body.split('\n');
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(raw);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ type: 'hunk-header', content: raw, oldLineNum: null, newLineNum: null });
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'insert', content: raw.slice(1), oldLineNum: null, newLineNum: newLine });
      newLine++;
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'delete', content: raw.slice(1), oldLineNum: oldLine, newLineNum: null });
      oldLine++;
    } else if (raw.startsWith(' ')) {
      lines.push({
        type: 'context',
        content: raw.slice(1),
        oldLineNum: oldLine,
        newLineNum: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return lines;
}

// baseContent reserved for split-mode parity checks; current implementation derives oldLineNum
// from cumulative-shift arithmetic per spec § 5.4, so baseContent is not consulted yet.
export function interleaveWholeFile(
  file: FileChange,
  headContent: string,
  baseContent: string | null,
): DiffLine[] {
  void baseContent; // reserved — see above
  const out: DiffLine[] = [];
  const headLines = headContent.split('\n');
  let prevNewEnd = 0;
  let prevOldEnd = 0;

  for (const hunk of file.hunks) {
    for (let n = prevNewEnd + 1; n < hunk.newStart; n++) {
      out.push({
        type: 'context',
        content: headLines[n - 1] ?? '',
        oldLineNum: prevOldEnd + (n - prevNewEnd),
        newLineNum: n,
        isFilled: true,
      });
    }
    out.push(...parseHunkLines(hunk.body));
    prevNewEnd = hunk.newStart + hunk.newLines - 1;
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }

  for (let n = prevNewEnd + 1; n <= headLines.length; n++) {
    out.push({
      type: 'context',
      content: headLines[n - 1] ?? '',
      oldLineNum: prevOldEnd + (n - prevNewEnd),
      newLineNum: n,
      isFilled: true,
    });
  }

  return out;
}
