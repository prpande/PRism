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
  ready: boolean;
}

const MAX_FILE_LINES = 2000;
const MAX_FILE_BYTES = 200_000;
// Shared stable-identity sentinel — returned (never mutated) so downstream
// memo consumers don't re-render when the maps are empty.
const EMPTY: SyntaxTokenMaps = { oldLineTokens: new Map(), newLineTokens: new Map(), ready: false };

export function normalizeEol(s: string): string {
  return s.replace(/\r$/, '');
}

function tooLarge(text: string): boolean {
  return text.length > MAX_FILE_BYTES || text.split('\n').length > MAX_FILE_LINES;
}

// Build a line→tokens map from a whole-file blob (1-based line numbers).
function mapWhole(content: string, lang: ReturnType<typeof pathToLang>): Map<number, LineToken[]> {
  const m = new Map<number, LineToken[]>();
  // Normalize EOLs before tokenizing: tokenizeLines splits on '\n', so a CRLF
  // blob would leave a trailing '\r' on every line token. The paired-line path
  // (MergedPairedContent) derives sideText from token concatenation and compares
  // it against normalizeEol-stripped content; an un-stripped '\r' would mismatch
  // and silently fall back to WordDiffOverlay (no syntax color) on every paired
  // line of a Windows/CRLF file. mapHunks already normalizes per line (below);
  // mirror that here. Normalizing preserves the line count, so 1-based numbers
  // stay correct.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return m; // empty file → no lines (avoid a phantom line-1 token)
  if (tooLarge(normalized)) return m;
  const lines = tokenizeLines(normalized, lang);
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
  const perHunkLines = file.hunks.map((hunk) =>
    parseHunkLines(hunk.body).filter((l) =>
      side === 'new' ? l.newLineNum !== null : l.oldLineNum !== null,
    ),
  );

  // Per-side size guard (spec §Guards: "2,000 lines or 200 KB of source for a
  // side"). Sum across ALL hunks first; if the side as a whole exceeds either
  // cap, tokenize nothing and return an empty map so highlightSuppressed fires
  // the honest "large file" indicator. A per-hunk check would let a file whose
  // hunks each sit under the cap but collectively exceed it tokenize fully with
  // no indicator — a drift from the stated per-side invariant.
  let totalBytes = 0;
  let totalLines = 0;
  for (const lines of perHunkLines) {
    totalLines += lines.length;
    for (const l of lines) totalBytes += normalizeEol(l.content).length + 1; // +1 ≈ join '\n'
  }
  if (totalBytes > MAX_FILE_BYTES || totalLines > MAX_FILE_LINES) return m;

  // Tokenize each hunk separately (not as one joined blob): hunk boundaries are
  // discontinuities in the file, so joining them would bleed grammar state (an
  // unclosed brace/comment in one hunk miscoloring the next).
  for (const lines of perHunkLines) {
    const source = lines.map((l) => normalizeEol(l.content)).join('\n');
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
    void getHighlighterAsync()
      .then(() => {
        if (live) setReady(true);
      })
      .catch(() => {
        // Highlighter unavailable (WASM blocked / offline / CSP): stay un-ready
        // so the plain-text fallback remains active. Swallow the rejection to
        // avoid an unhandled-rejection event — mirrors MarkdownRenderer.tsx.
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

    return { oldLineTokens, newLineTokens, ready: true };
    // headSha/baseSha bust the memo on PR navigation / force-push even when
    // path & lang are unchanged; newSource/oldSource cover content changes.
  }, [ready, lang, file, newSource, oldSource, input.headSha, input.baseSha]);
}
