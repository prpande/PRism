import { describe, it, expect } from 'vitest';
import {
  pathToLang,
  tokenizeLines,
  getHighlighterAsync,
} from '../src/components/Markdown/shikiInstance';

describe('pathToLang', () => {
  it('maps common extensions to grammars', () => {
    expect(pathToLang('src/App.tsx')).toBe('tsx');
    expect(pathToLang('a/b/main.ts')).toBe('typescript');
    expect(pathToLang('x.cs')).toBe('csharp');
    expect(pathToLang('Program.PY')).toBe('python'); // case-insensitive
    expect(pathToLang('infra/main.tf.toml')).toBe('toml');
    expect(pathToLang('q.sql')).toBe('sql');
  });

  it('maps basename specials', () => {
    expect(pathToLang('build/Dockerfile')).toBe('dockerfile');
  });

  it('returns null for unknown or extension-less files', () => {
    expect(pathToLang('LICENSE')).toBeNull();
    expect(pathToLang('weird.xyz')).toBeNull();
    expect(pathToLang('')).toBeNull();
  });
});

describe('tokenizeLines', () => {
  it('returns dual-theme token styles with no bare color', async () => {
    await getHighlighterAsync();
    const lines = tokenizeLines('const x = 1;', 'typescript');
    expect(lines.length).toBe(1);
    const concat = lines[0].map((t) => t.text).join('');
    expect(concat).toBe('const x = 1;'); // text is loss-less
    const styled = lines[0].find((t) => Object.keys(t.style).length > 0);
    expect(styled).toBeDefined();
    expect(styled!.style).toHaveProperty('--shiki-light');
    expect(styled!.style).toHaveProperty('--shiki-dark');
    expect(styled!.style).not.toHaveProperty('color'); // defaultColor:false
  }, 15_000);

  it('falls back to one plaintext token per line for null lang', async () => {
    await getHighlighterAsync();
    const lines = tokenizeLines('a\nb', null);
    expect(lines).toEqual([[{ text: 'a', style: {} }], [{ text: 'b', style: {} }]]);
  }, 15_000);

  it('emits a single plaintext token for lines over the char cap', async () => {
    await getHighlighterAsync();
    const long = 'x'.repeat(2001);
    const lines = tokenizeLines(`${long}\nshort`, 'typescript');
    expect(lines[0]).toEqual([{ text: long, style: {} }]);
    expect(lines[0].length).toBe(1);
    // The non-capped line must be highlighted, not also plaintext.
    expect(lines[1].map((t) => t.text).join('')).toBe('short');
    expect(lines[1].find((t) => Object.keys(t.style).length > 0)).toBeDefined();
  }, 15_000);

  it('drops non-hex color values (supply-chain guard)', async () => {
    await getHighlighterAsync();
    const lines = tokenizeLines('return;', 'typescript');
    const allStyled = lines.flat().filter((t) => '--shiki-light' in t.style);
    expect(allStyled.length).toBeGreaterThan(0);
    for (const t of allStyled) {
      expect(t.style['--shiki-light']).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  }, 15_000);
});
