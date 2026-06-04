import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;

export type ShikiLang =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'yaml'
  | 'bash'
  | 'csharp'
  | 'python'
  | 'go'
  | 'rust'
  | 'jsx'
  | 'tsx'
  | 'sql'
  | 'xml'
  | 'dockerfile'
  | 'toml';

const EXT_TO_LANG: Record<string, ShikiLang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  cs: 'csharp',
  py: 'python',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  xml: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',
  toml: 'toml',
};

const BASENAME_TO_LANG: Record<string, ShikiLang> = {
  dockerfile: 'dockerfile',
};

export function pathToLang(path: string): ShikiLang | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? '';
  const byBase = BASENAME_TO_LANG[base.toLowerCase()];
  if (byBase) return byBase;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export interface LineToken {
  text: string;
  style: Record<string, string>;
}

const MAX_LINE_CHARS = 2000;
// Valid CSS hex lengths: 3, 4, 6, or 8 hex digits (5 and 7 are not valid CSS).
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Shiki types htmlStyle as `string | Record<string,string> | undefined`; the
// dual-theme defaultColor:false path always yields the object form, but the
// param must accept the union or `tsc -b` (npm run build) fails under strict.
// Only hex color values are forwarded; Shiki's --shiki-light-font-style /
// --shiki-light-font-weight variables (italic/bold) are intentionally dropped
// — we keep color only. This is by design, not an oversight.
function safeStyle(htmlStyle: string | Record<string, string> | undefined): Record<string, string> {
  if (!htmlStyle || typeof htmlStyle === 'string') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(htmlStyle)) {
    if (HEX.test(v)) out[k] = v; // drop anything that isn't a plain hex color
  }
  return out;
}

export function tokenizeLines(code: string, lang: ShikiLang | null): LineToken[][] {
  const rawLines = code.split('\n');
  const hl = highlighterInstance;
  // Two reasons to fall back to plaintext: (1) highlighter not yet loaded, or
  // (2) no grammar registered for this file type (lang === null).
  if (!hl || lang === null) {
    return rawLines.map((line) => [{ text: line, style: {} }]);
  }
  // Per-line char cap: blank over-long lines in the tokenize source (keeps line
  // count stable) and override their result with a single plaintext token.
  // Known PoC limitation: blanking a line can disturb multi-line grammar state
  // (e.g. an open template literal or block comment spanning the blanked line
  // will cause miscoloring on subsequent lines). Accepted because >2000-char
  // lines are almost always minified single-line blobs in practice.
  const capped = new Set<number>();
  const source = rawLines
    .map((line, i) => {
      if (line.length > MAX_LINE_CHARS) {
        capped.add(i);
        return '';
      }
      return line;
    })
    .join('\n');

  const { tokens } = hl.codeToTokens(source, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });

  return tokens.map((lineTokens, i) => {
    if (capped.has(i)) return [{ text: rawLines[i], style: {} }];
    return lineTokens.map((t) => ({ text: t.content, style: safeStyle(t.htmlStyle) }));
  });
}

// Derive the set of langs to load from the lookup maps so they can never drift.
// If a lang is referenced in a map but missing here, pathToLang would return a
// grammar that codeToTokens would throw on.
const LANGS_TO_LOAD: ShikiLang[] = [
  ...new Set<ShikiLang>([...Object.values(EXT_TO_LANG), ...Object.values(BASENAME_TO_LANG)]),
];

export function getHighlighter(): Highlighter | null {
  if (highlighterInstance) return highlighterInstance;

  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async (mod) => {
      const hl = await mod.createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: LANGS_TO_LOAD,
      });
      highlighterInstance = hl;
      return hl;
    });
  }

  return null;
}

export function getHighlighterAsync(): Promise<Highlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (!highlighterPromise) {
    getHighlighter();
  }
  return highlighterPromise!;
}
