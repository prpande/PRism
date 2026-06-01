import { describe, it, expect } from 'vitest';
import type { FileChange } from '../src/api/types';
import {
  interleaveWholeFile,
  parseHunkLines,
} from '../src/components/PrDetail/FilesTab/DiffPane/interleaveWholeFile';

function modifiedFile(hunks: FileChange['hunks']): FileChange {
  return { path: 'src/a.ts', status: 'modified', hunks };
}

describe('interleaveWholeFile', () => {
  it('1. single hunk spanning whole file — output matches parseHunkLines (no filled lines)', () => {
    const file = modifiedFile([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, body: '@@ -1,2 +1,3 @@\n a\n+b\n c' },
    ]);
    const headContent = 'a\nb\nc';
    const result = interleaveWholeFile(file, headContent, null);
    const expected = parseHunkLines(file.hunks[0].body);
    expect(result).toEqual(expected);
    expect(result.every((l) => !l.isFilled)).toBe(true);
  });

  it('2. single hunk in middle — leading and trailing gaps are filled-context', () => {
    const file = modifiedFile([
      {
        oldStart: 3,
        oldLines: 1,
        newStart: 3,
        newLines: 2,
        body: '@@ -3,1 +3,2 @@\n-old\n+new1\n+new2',
      },
    ]);
    const headContent = 'line1\nline2\nnew1\nnew2\nline5';
    const result = interleaveWholeFile(file, headContent, null);
    expect(result[0]).toMatchObject({
      type: 'context',
      content: 'line1',
      oldLineNum: 1,
      newLineNum: 1,
      isFilled: true,
    });
    expect(result[1]).toMatchObject({
      type: 'context',
      content: 'line2',
      oldLineNum: 2,
      newLineNum: 2,
      isFilled: true,
    });
    expect(result.find((l) => l.content === 'line5')).toMatchObject({
      type: 'context',
      oldLineNum: 4,
      newLineNum: 5,
      isFilled: true,
    });
  });

  it('3. multiple hunks with gaps — oldLineNum derivations correct across hunks', () => {
    const file = modifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, body: '@@ -2,1 +2,2 @@\n-x\n+y\n+z' },
      { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1, body: '@@ -5,1 +6,1 @@\n-p\n+q' },
    ]);
    const headContent = 'a\ny\nz\nb\nc\nq\nd';
    const result = interleaveWholeFile(file, headContent, null);
    const gap2 = result.find((l) => l.content === 'b' && l.isFilled);
    expect(gap2).toMatchObject({ oldLineNum: 3, newLineNum: 4 });
    const gap3 = result.find((l) => l.content === 'c' && l.isFilled);
    expect(gap3).toMatchObject({ oldLineNum: 4, newLineNum: 5 });
    const trailing = result.find((l) => l.content === 'd' && l.isFilled);
    expect(trailing).toMatchObject({ oldLineNum: 6, newLineNum: 7 });
  });

  it('4. leading gap — hunk does not start at line 1', () => {
    const file = modifiedFile([
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, body: '@@ -5,1 +5,1 @@\n-old\n+new' },
    ]);
    const headContent = 'l1\nl2\nl3\nl4\nnew';
    const result = interleaveWholeFile(file, headContent, null);
    expect(result.slice(0, 4)).toEqual([
      { type: 'context', content: 'l1', oldLineNum: 1, newLineNum: 1, isFilled: true },
      { type: 'context', content: 'l2', oldLineNum: 2, newLineNum: 2, isFilled: true },
      { type: 'context', content: 'l3', oldLineNum: 3, newLineNum: 3, isFilled: true },
      { type: 'context', content: 'l4', oldLineNum: 4, newLineNum: 4, isFilled: true },
    ]);
  });

  it('5. trailing gap — file longer than last hunk range; trailing-newline-terminated content emits one extra empty filled row', () => {
    const file = modifiedFile([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    const headContent = 'new\ntail1\ntail2\n';
    const result = interleaveWholeFile(file, headContent, null);
    const trail = result.filter((l) => l.isFilled);
    expect(trail.map((l) => l.content)).toEqual(['tail1', 'tail2', '']);
    expect(trail[0]).toMatchObject({ oldLineNum: 2, newLineNum: 2 });
    expect(trail[1]).toMatchObject({ oldLineNum: 3, newLineNum: 3 });
    expect(trail[2]).toMatchObject({ oldLineNum: 4, newLineNum: 4 });
  });
});
