import { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '../api/types';
import {
  getHighlighterAsync,
  pathToLang,
  tokenizeLines,
  type LineToken,
} from '../components/Markdown/shikiInstance';
import type { UseWholeFileContentResult } from './useWholeFileContent';
import { parseHunkLines } from '../components/PrDetail/FilesTab/DiffPane/interleaveWholeFile';

export interface UseSyntaxTokensInput {
  path: string | null;
  file: FileChange | null;
  wholeFileEnabled: boolean;
  wholeFile: UseWholeFileContentResult;
  isSplit: boolean;
  headSha: string;
  baseSha: string;
}

export interface SyntaxTokenMaps {
  oldLineTokens: Map<number, LineToken[]>;
  newLineTokens: Map<number, LineToken[]>;
}

const MAX_FILE_LINES = 2000;
const MAX_FILE_BYTES = 200_000;
const EMPTY: SyntaxTokenMaps = { oldLineTokens: new Map(), newLineTokens: new Map() };

export function normalizeEol(s: string): string {
  return s.replace(/\r$/, '');
}

function tooLarge(text: string): boolean {
  return text.length > MAX_FILE_BYTES || text.split('\n').length > MAX_FILE_LINES;
}

// Build a line→tokens map from a whole-file blob (1-based line numbers).
function mapWhole(content: string, lang: ReturnType<typeof pathToLang>): Map<number, LineToken[]> {
  const m = new Map<number, LineToken[]>();
  if (tooLarge(content)) return m;
  const lines = tokenizeLines(content, lang);
  lines.forEach((toks, i) => m.set(i + 1, toks));
  return m;
}

// Build a line→tokens map from hunk bodies for one side.
function mapHunks(
  file: FileChange,
  side: 'old' | 'new',
  lang: ReturnType<typeof pathToLang>,
): Map<number, LineToken[]> {
  const m = new Map<number, LineToken[]>();
  for (const hunk of file.hunks) {
    const lines = parseHunkLines(hunk.body).filter((l) =>
      side === 'new' ? l.newLineNum !== null : l.oldLineNum !== null,
    );
    const source = lines.map((l) => normalizeEol(l.content)).join('\n');
    if (tooLarge(source)) continue;
    const toks = tokenizeLines(source, lang);
    lines.forEach((l, i) => {
      const key = side === 'new' ? l.newLineNum! : l.oldLineNum!;
      m.set(key, toks[i] ?? [{ text: normalizeEol(l.content), style: {} }]);
    });
  }
  return m;
}

export function useSyntaxTokens(input: UseSyntaxTokensInput): SyntaxTokenMaps {
  const { path, file, wholeFileEnabled, wholeFile, isSplit } = input;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void getHighlighterAsync().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const lang = path ? pathToLang(path) : null;
  const wholeOk =
    wholeFileEnabled && wholeFile.fetchStatus === 'ok' && wholeFile.headContent !== null;
  const newSource = wholeOk ? wholeFile.headContent : null;
  const oldSource = wholeOk && isSplit ? wholeFile.baseContent : null;

  return useMemo<SyntaxTokenMaps>(() => {
    if (!ready || lang === null || file === null) return EMPTY;

    const newLineTokens =
      newSource !== null ? mapWhole(newSource, lang) : mapHunks(file, 'new', lang);
    // Old side: whole-file base only when split (unified fetches no base);
    // otherwise reconstruct from hunks — including unified whole-file delete lines.
    const oldLineTokens =
      oldSource !== null ? mapWhole(oldSource, lang) : mapHunks(file, 'old', lang);

    return { oldLineTokens, newLineTokens };
  }, [ready, lang, file, newSource, oldSource, input.headSha, input.baseSha]);
}
