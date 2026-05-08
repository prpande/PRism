import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;

export function getHighlighter(): Highlighter | null {
  if (highlighterInstance) return highlighterInstance;

  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async (mod) => {
      const hl = await mod.createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [
          'typescript',
          'javascript',
          'json',
          'html',
          'css',
          'markdown',
          'yaml',
          'bash',
          'csharp',
          'python',
          'go',
          'rust',
          'jsx',
          'tsx',
        ],
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
