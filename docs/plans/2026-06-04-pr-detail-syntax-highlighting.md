# PR-detail Syntax Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add IDE-like syntax highlighting to all code surfaces in PR detail — Overview markdown fences and the Files-tab diff (unified + side-by-side) — using the already-installed Shiki, with dual-theme support and the existing word-diff emphasis preserved.

**Architecture:** Frontend-only. A dual-theme Shiki tokenizer (`tokenizeLines`) produces per-line `{text, style}` token arrays carrying `--shiki-light`/`--shiki-dark` CSS variables. A shared `HighlightedLine` renderer emits one wrapped `.codeLine` of `.codeToken` spans (global classes so the `html[data-theme]` theme selector matches). The Overview path wires this into `MarkdownRenderer`; the diff path adds a `useSyntaxTokens` hook (adaptive whole-file/hunk-block context) and a `mergeWordDiffWithTokens` pass that layers token color (foreground) with word-diff (background) on paired lines.

**Tech Stack:** React 19 + TypeScript + Vite, Shiki `^1.29.2`, `diff` `^9.0.0`, react-markdown `^9`, Vitest + Testing Library, Playwright.

**Spec:** `docs/specs/2026-06-04-pr-detail-syntax-highlighting-design.md`

---

## Conventions for every task

- **Test runner (single file):** `cd frontend && npx vitest run <path>`
- **Before committing any frontend file:** `cd frontend && npx prettier --write <files>` (Prettier `--check` gates CI — see `feedback_prettier_check_in_ci`).
- **Pre-push (end of each PR, not each task):** `cd frontend && npm run lint && npm run build`.
- **Commits:** small, one per task step group, conventional-commit style.
- **Worktree:** all work happens in `D:\src\PRism-syntax-highlight` on branch `feature/pr-detail-syntax-highlighting`.
- **Shiki-in-vitest (verify in Task 1 first):** `shikiInstance.ts` has zero existing consumers/tests, so Task 1 is also the proof-of-life that Shiki's oniguruma WASM engine initializes under jsdom. Node supports WASM, so this should work, but: (a) the first `await getHighlighterAsync()` loads the full grammar bundle and may be slow — if any highlight test flakes on a timeout, raise that test's timeout (`it(..., async () => {...}, 15_000)`) rather than adding a fixed `Task.Delay`-style wait (`feedback_windows_ci_fixed_delay_flake`); (b) vitest runs files in separate workers, so the singleton warms once per worker, not once globally — acceptable, just budget for it. If Task 1 Step 8 reveals WASM does **not** init under jsdom, STOP and escalate: the whole plan's test strategy assumes it does.

## Plan-level decisions (deviations from the spec, recorded per `feedback_document_plan_deviations`)

1. **Global CSS classes, not CSS-module classes**, for `.codeLine` / `.codeToken` / `.wordDiffInsertBg` / `.wordDiffDeleteBg`. The dual-theme override `html[data-theme='dark'] .codeToken { … }` must match the literal rendered class; CSS-module hashing (`_codeToken_ab12`) would not. These live in `frontend/src/styles/tokens.css` (which already hosts global diff classes like `.diff-line`) and are applied as **string literals** in components. The spec's "added to `WordDiffOverlay.module.css`" is superseded by this for the theme-selector reason.
2. **Security tests extend the existing parameterized `frontend/__tests__/MarkdownRendererSecurity.test.tsx`.** Ground-truth correction: both the spec ("create `MarkdownRendererSecurity.test.tsx`… does not exist") and the round-1 security reviewer were wrong — that file **exists** and already runs a security contract over every `bodyMarkdown` consumer (`MarkdownRenderer`, `ComposerMarkdownPreview`) via `describe.each(CONSUMERS)`. Adding the highlighted-fence inert-text cases there means they run against **every** consumer, so future consumers inherit the guarantee. (`MarkdownRenderer.sanitization.test.tsx` also exists and is renderer-only; leave it as-is.)
3. **CRLF normalization** is a shared `normalizeEol(s) => s.replace(/\r$/, '')` helper applied to every per-line string both when building token source and when deriving the paired-line merge `sideText`, so token character offsets stay aligned with rendered content on CRLF-authored files (the .NET side of this repo).

---

# PHASE 1 — PR1: Highlighter core + Overview markdown + security baseline

## Task 1: Extend `shikiInstance.ts` — lang map + dual-theme `tokenizeLines`

**Files:**
- Modify: `frontend/src/components/Markdown/shikiInstance.ts`
- Test: `frontend/__tests__/shikiInstance.test.ts` (create)

- [ ] **Step 1: Write failing tests for `pathToLang`**

Create `frontend/__tests__/shikiInstance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pathToLang } from '../src/components/Markdown/shikiInstance';

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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/shikiInstance.test.ts`
Expected: FAIL — `pathToLang` is not exported.

- [ ] **Step 3: Add the lang list (+4 grammars), `ShikiLang` type, and `pathToLang`**

In `shikiInstance.ts`, extend the `langs` array in `createHighlighter` to add `'sql'`, `'xml'`, `'dockerfile'`, `'toml'` after `'tsx'`. Then add above `getHighlighter`:

```ts
export type ShikiLang =
  | 'typescript' | 'javascript' | 'json' | 'html' | 'css' | 'markdown'
  | 'yaml' | 'bash' | 'csharp' | 'python' | 'go' | 'rust' | 'jsx' | 'tsx'
  | 'sql' | 'xml' | 'dockerfile' | 'toml';

const EXT_TO_LANG: Record<string, ShikiLang> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', html: 'html', htm: 'html', css: 'css',
  md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', cs: 'csharp', py: 'python', go: 'go', rs: 'rust',
  sql: 'sql', xml: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', toml: 'toml',
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
```

- [ ] **Step 4: Run to verify `pathToLang` passes**

Run: `cd frontend && npx vitest run __tests__/shikiInstance.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `tokenizeLines`**

Append to `shikiInstance.test.ts`:

```ts
import { tokenizeLines, getHighlighterAsync } from '../src/components/Markdown/shikiInstance';

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
  });

  it('falls back to one plaintext token per line for null lang', async () => {
    await getHighlighterAsync();
    const lines = tokenizeLines('a\nb', null);
    expect(lines).toEqual([[{ text: 'a', style: {} }], [{ text: 'b', style: {} }]]);
  });

  it('emits a single plaintext token for lines over the char cap', async () => {
    await getHighlighterAsync();
    const long = 'x'.repeat(2001);
    const lines = tokenizeLines(`${long}\nshort`, 'typescript');
    expect(lines[0]).toEqual([{ text: long, style: {} }]);
    expect(lines[0].length).toBe(1);
  });

  it('drops non-hex color values (supply-chain guard)', async () => {
    await getHighlighterAsync();
    // All github-theme colors are hex, so a normal token keeps its vars;
    // this asserts the validator passes valid hex through unchanged.
    const lines = tokenizeLines('return;', 'typescript');
    const styled = lines.flat().find((t) => t.style['--shiki-light']);
    expect(styled!.style['--shiki-light']).toMatch(
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    );
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/shikiInstance.test.ts`
Expected: FAIL — `tokenizeLines` not exported.

- [ ] **Step 7: Implement `tokenizeLines`**

Add to `shikiInstance.ts`:

```ts
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
  if (!hl || lang === null) {
    return rawLines.map((line) => [{ text: line, style: {} }]);
  }
  // Per-line char cap: blank over-long lines in the tokenize source (keeps line
  // count stable) and override their result with a single plaintext token.
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
```

> Note: `highlighterInstance` is the existing module-level singleton in this file. `codeToTokens` is **synchronous** once the highlighter has resolved (verified against `@shikijs/core` 1.29.2). `tokenizeLines` returns empty-style fallback if called before `getHighlighterAsync()` has resolved.

- [ ] **Step 8: Run all `shikiInstance.test.ts`**

Run: `cd frontend && npx vitest run __tests__/shikiInstance.test.ts`
Expected: PASS (all).

- [ ] **Step 9: Commit**

```bash
cd frontend && npx prettier --write src/components/Markdown/shikiInstance.ts __tests__/shikiInstance.test.ts
cd .. && git add frontend/src/components/Markdown/shikiInstance.ts frontend/__tests__/shikiInstance.test.ts
git commit -m "feat(highlight): pathToLang + dual-theme tokenizeLines on Shiki singleton"
```

---

## Task 2: Global theme CSS for `.codeLine` / `.codeToken` / word-diff backgrounds

**Files:**
- Modify: `frontend/src/styles/tokens.css`

- [ ] **Step 1: Add the global classes**

Append to `tokens.css` (near the existing diff/global classes):

```css
/* Syntax highlighting — global classes so the dual-theme selector below
   matches the literal rendered class (CSS-module hashing would not). */
.codeLine {
  display: inline; /* single direct child of the diff content cell; in split
                      scroll-mode the existing .diffContent > * rule forces
                      inline-block + translateX onto it. Never display:contents. */
}
.codeToken {
  color: var(--shiki-light); /* light is the default; tokens carry no bare color */
}
html[data-theme='dark'] .codeToken {
  color: var(--shiki-dark);
}
/* Background-only word-diff variants for the highlighted (merged) path —
   foreground is owned by .codeToken. Full-color .wordDiffInsert/.wordDiffDelete
   in WordDiffOverlay.module.css stay for the no-token fallback path. */
.wordDiffInsertBg {
  background: var(--diff-add-bg);
  border-radius: 2px;
}
.wordDiffDeleteBg {
  background: var(--diff-rem-bg);
  border-radius: 2px;
  text-decoration: line-through;
}
```

- [ ] **Step 2: Verify the build still parses the CSS**

Run: `cd frontend && npx vite build` (or rely on Task 4's component test which imports the app). Expected: no CSS parse error.

> No unit test for static CSS; correctness is asserted visually in Task 11 and structurally in Tasks 4/9.

- [ ] **Step 3: Commit**

```bash
cd frontend && npx prettier --write src/styles/tokens.css
cd .. && git add frontend/src/styles/tokens.css
git commit -m "feat(highlight): global codeToken/codeLine + word-diff-bg theme classes"
```

---

## Task 3: `HighlightedLine` shared renderer

**Files:**
- Create: `frontend/src/components/Markdown/HighlightedLine.tsx`
- Test: `frontend/__tests__/HighlightedLine.test.tsx` (create)

- [ ] **Step 1: Write failing tests**

Create `frontend/__tests__/HighlightedLine.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HighlightedLine } from '../src/components/Markdown/HighlightedLine';

describe('HighlightedLine', () => {
  it('renders one .codeLine wrapper with one .codeToken span per span', () => {
    const { container } = render(
      <HighlightedLine
        spans={[
          { text: 'const', style: { '--shiki-light': '#005cc5', '--shiki-dark': '#79b8ff' } },
          { text: ' x', style: {} },
        ]}
        fallback="const x"
      />,
    );
    const line = container.querySelector('.codeLine');
    expect(line).not.toBeNull();
    expect(line!.children.length).toBe(2); // single direct wrapper, N token children
    const tokens = container.querySelectorAll('.codeToken');
    expect(tokens.length).toBe(2);
    expect((tokens[0] as HTMLElement).style.getPropertyValue('--shiki-dark')).toBe('#79b8ff');
    expect(line!.textContent).toBe('const x');
  });

  it('applies background-only change classes on merged spans', () => {
    const { container } = render(
      <HighlightedLine
        spans={[
          { text: 'a', style: {}, change: 'insert' },
          { text: 'b', style: {}, change: 'delete' },
        ]}
        fallback="ab"
      />,
    );
    expect(container.querySelector('.codeToken.wordDiffInsertBg')).not.toBeNull();
    expect(container.querySelector('.codeToken.wordDiffDeleteBg')).not.toBeNull();
  });

  it('renders fallback as a single plain span when spans is empty', () => {
    const { container } = render(<HighlightedLine spans={[]} fallback={'  indented'} />);
    const line = container.querySelector('.codeLine');
    expect(line!.children.length).toBe(1);
    expect(line!.textContent).toBe('  indented'); // whitespace preserved as text
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/HighlightedLine.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `HighlightedLine`**

Create `frontend/src/components/Markdown/HighlightedLine.tsx`:

```tsx
import type { LineToken } from './shikiInstance';

export interface MergedSpan extends LineToken {
  change?: 'insert' | 'delete';
}

export interface HighlightedLineProps {
  spans: MergedSpan[];
  fallback: string;
}

// Global class strings (defined in tokens.css) — NOT CSS-module imports, so the
// html[data-theme] dual-theme selector matches the rendered class.
export function HighlightedLine({ spans, fallback }: HighlightedLineProps) {
  if (spans.length === 0) {
    return (
      <span className="codeLine">
        <span>{fallback}</span>
      </span>
    );
  }
  return (
    <span className="codeLine">
      {spans.map((s, i) => {
        let cls = 'codeToken';
        if (s.change === 'insert') cls += ' wordDiffInsertBg';
        else if (s.change === 'delete') cls += ' wordDiffDeleteBg';
        return (
          <span key={i} className={cls} style={s.style}>
            {s.text}
          </span>
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run __tests__/HighlightedLine.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && npx prettier --write src/components/Markdown/HighlightedLine.tsx __tests__/HighlightedLine.test.tsx
cd .. && git add frontend/src/components/Markdown/HighlightedLine.tsx frontend/__tests__/HighlightedLine.test.tsx
git commit -m "feat(highlight): HighlightedLine shared token/merged-span renderer"
```

---

## Task 4: Wire `MarkdownRenderer` fenced code to the highlighter

**Files:**
- Modify: `frontend/src/components/Markdown/MarkdownRenderer.tsx`
- Test: `frontend/__tests__/MarkdownRenderer.highlight.test.tsx` (create)

- [ ] **Step 1: Write failing tests**

Create `frontend/__tests__/MarkdownRenderer.highlight.test.tsx`:

```tsx
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';

describe('MarkdownRenderer syntax highlighting', () => {
  it('highlights a fenced code block with a known language', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <MarkdownRenderer source={'```ts\nconst x = 1;\n```'} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.codeToken')).not.toBeNull();
    });
    expect(container.querySelector('code')!.textContent).toContain('const x = 1;');
  });

  it('renders an unknown fence language as plain code (no tokens)', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <MarkdownRenderer source={'```nope\nplain text\n```'} />,
    );
    expect(container.querySelector('code')!.textContent).toContain('plain text');
    expect(container.querySelector('.codeToken')).toBeNull();
  });

  it('leaves mermaid fences to MermaidBlock (no token spans)', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <MarkdownRenderer source={'```mermaid\ngraph TD; A-->B;\n```'} />,
    );
    expect(container.querySelector('.codeToken')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/MarkdownRenderer.highlight.test.tsx`
Expected: FAIL — no `.codeToken` rendered.

- [ ] **Step 3: Implement the highlighted `code` branch**

In `MarkdownRenderer.tsx`, replace the `if (lang) { … }` branch (currently returns a bare `<code>`) with a highlighted sub-component. Add imports at the top:

```tsx
import { useEffect, useState } from 'react';
import { getHighlighterAsync, tokenizeLines, type ShikiLang } from './shikiInstance';
import { HighlightedLine } from './HighlightedLine';
```

Add this component below the imports:

```tsx
const FENCE_LANGS = new Set<ShikiLang>([
  'typescript','javascript','json','html','css','markdown','yaml','bash',
  'csharp','python','go','rust','jsx','tsx','sql','xml','dockerfile','toml',
]);

function fenceLang(info: string | undefined): ShikiLang | null {
  const tag = (info ?? '').trim().toLowerCase();
  return FENCE_LANGS.has(tag as ShikiLang) ? (tag as ShikiLang) : null;
}

function HighlightedCodeBlock({ code, lang }: { code: string; lang: ShikiLang }) {
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

  if (!ready) {
    // Pre-resolve: existing bare-code DOM shape (no flash, stable for security test).
    return <code className={`language-${lang}`}>{code}</code>;
  }
  const lines = tokenizeLines(code, lang);
  const rawLines = code.split('\n');
  return (
    <code className={`language-${lang}`}>
      {lines.map((tokens, i) => (
        <span key={i}>
          <HighlightedLine spans={tokens} fallback={rawLines[i] ?? ''} />
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </code>
  );
}
```

Then in the `components.code` callback, change the language branch:

```tsx
      if (lang === 'mermaid') {
        return (
          <Suspense fallback={<div className="mermaid-loading muted">Loading diagram…</div>}>
            <MermaidBlock code={codeString} />
          </Suspense>
        );
      }

      const shikiLang = fenceLang(lang);
      if (shikiLang) {
        return <HighlightedCodeBlock code={codeString} lang={shikiLang} />;
      }

      return <code {...props}>{children}</code>;
```

> `fallback` is the raw line text — `HighlightedLine` uses it only when a line has zero token spans (e.g. a blank line, where the text is empty anyway). The `\n` between lines preserves copy/paste fidelity inside the `<pre><code>`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run __tests__/MarkdownRenderer.highlight.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the existing renderer tests (regression)**

Run: `cd frontend && npx vitest run __tests__/MarkdownRenderer.sanitization.test.tsx __tests__/MermaidBlock.behavioral.test.tsx`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
cd frontend && npx prettier --write src/components/Markdown/MarkdownRenderer.tsx __tests__/MarkdownRenderer.highlight.test.tsx
cd .. && git add frontend/src/components/Markdown/MarkdownRenderer.tsx frontend/__tests__/MarkdownRenderer.highlight.test.tsx
git commit -m "feat(highlight): syntax-highlight Overview markdown fenced code blocks"
```

---

## Task 5: Security baseline — highlighted-path injection tests

**Files:**
- Modify: `frontend/__tests__/MarkdownRendererSecurity.test.tsx`

- [ ] **Step 1: Add highlighted-fence injection cases to the parameterized contract**

Append inside the existing `describe.each(CONSUMERS)('$name — security contract …', ({ render: renderConsumer }) => { … })` block, so each case runs against every `bodyMarkdown` consumer:

```tsx
  it('FencedCodePayload_RendersAsInertText_NotElement', async () => {
    const { getHighlighterAsync } = await import('../src/components/Markdown/shikiInstance');
    await getHighlighterAsync();
    const { container } = render(
      renderConsumer('```ts\nconst x = "<img src=x onerror=alert(1)>";\n```'),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('onerror=alert(1)'); // present as text
  });

  it('FencedScriptPayload_DoesNotInjectMarkup', async () => {
    const { getHighlighterAsync } = await import('../src/components/Markdown/shikiInstance');
    await getHighlighterAsync();
    render(renderConsumer('```js\n</script><script>alert(1)\n```'));
    expect(document.querySelector('script')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify pass**

Run: `cd frontend && npx vitest run __tests__/MarkdownRendererSecurity.test.tsx`
Expected: PASS — token spans render text children, so payloads are inert across all consumers.

- [ ] **Step 3: PR1 pre-push checks**

Run: `cd frontend && npm run lint && npm run build`
Expected: both succeed (`feedback_run_full_pre_push_checklist`).

- [ ] **Step 4: Commit**

```bash
cd frontend && npx prettier --write __tests__/MarkdownRendererSecurity.test.tsx
cd .. && git add frontend/__tests__/MarkdownRendererSecurity.test.tsx
git commit -m "test(highlight): add security baseline for highlighted markdown fences"
```

> **PR1 boundary.** Open PR1 here via `pr-autopilot` (`feedback_use_pr_autopilot`). PR1 = Tasks 1–5: highlighter core, theme CSS, `HighlightedLine`, Overview markdown highlighting, security baseline.

---

# PHASE 2 — PR2: Diff highlighting (all line types)

## Task 6: `useSyntaxTokens` hook — adaptive context maps

**Files:**
- Create: `frontend/src/hooks/useSyntaxTokens.ts`
- Test: `frontend/__tests__/useSyntaxTokens.test.tsx` (create)

Shared types referenced (already in `frontend/src/api/types.ts`): `FileChange { status, hunks: DiffHunk[] }`, `DiffHunk { oldStart, oldLines, newStart, newLines, body }`, `DiffLine { type, content, oldLineNum, newLineNum }`. `parseHunkLines` is exported from `…/DiffPane/interleaveWholeFile.ts`.

- [ ] **Step 1: Write failing tests**

Create `frontend/__tests__/useSyntaxTokens.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useSyntaxTokens } from '../src/hooks/useSyntaxTokens';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';
import type { FileChange } from '../src/api/types';

const file = (body: string): FileChange =>
  ({
    path: 'a.ts',
    status: 'modified',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body }],
  }) as unknown as FileChange;

const okWhole = { fetchStatus: 'ok' as const, headContent: '', baseContent: null, failureReason: null };

describe('useSyntaxTokens', () => {
  it('returns empty maps for an unsupported path', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'LICENSE', file: file('@@ -1 +1 @@\n+const x = 1;'),
        wholeFileEnabled: false, wholeFile: { ...okWhole, fetchStatus: 'idle' },
        isSplit: true, headSha: 'h', baseSha: 'b',
      }),
    );
    expect(result.current.newLineTokens.size).toBe(0);
  });

  it('tokenizes hunk-mode new-side lines keyed by newLineNum', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts', file: file('@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;'),
        wholeFileEnabled: false, wholeFile: { ...okWhole, fetchStatus: 'idle' },
        isSplit: true, headSha: 'h', baseSha: 'b',
      }),
    );
    await waitFor(() => expect(result.current.newLineTokens.size).toBeGreaterThan(0));
    // context line 1 + insert line 2 both keyed on the new side
    expect(result.current.newLineTokens.has(1)).toBe(true);
    expect(result.current.newLineTokens.has(2)).toBe(true);
    const concat = result.current.newLineTokens.get(2)!.map((t) => t.text).join('');
    expect(concat).toBe('const b = 2;');
  });

  it('tokenizes whole-file split base content for the old side', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts', file: file('@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;'),
        wholeFileEnabled: true,
        wholeFile: { fetchStatus: 'ok', headContent: 'const a = 2;', baseContent: 'const a = 1;', failureReason: null },
        isSplit: true, headSha: 'h', baseSha: 'b',
      }),
    );
    await waitFor(() => expect(result.current.oldLineTokens.size).toBeGreaterThan(0));
    expect(result.current.oldLineTokens.get(1)!.map((t) => t.text).join('')).toBe('const a = 1;');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/useSyntaxTokens.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useSyntaxTokens`**

Create `frontend/src/hooks/useSyntaxTokens.ts`:

```ts
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
  const wholeOk = wholeFileEnabled && wholeFile.fetchStatus === 'ok' && wholeFile.headContent !== null;
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
    // sourceHash via the actual source strings + SHAs keeps the memo correct on
    // force-push/snapshot swaps without re-tokenizing on unrelated re-renders.
  }, [ready, lang, file, newSource, oldSource, input.headSha, input.baseSha]);
}
```

> The memo dependency list uses the source strings themselves (`newSource`/`oldSource`) plus the SHAs, which is the concrete realization of the spec's `(path, side, sourceHash, mode, headSha, baseSha)` key — a changed source string is a new dependency value, so React recomputes; identical inputs reuse the map.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run __tests__/useSyntaxTokens.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && npx prettier --write src/hooks/useSyntaxTokens.ts __tests__/useSyntaxTokens.test.tsx
cd .. && git add frontend/src/hooks/useSyntaxTokens.ts frontend/__tests__/useSyntaxTokens.test.tsx
git commit -m "feat(highlight): useSyntaxTokens adaptive whole-file/hunk token maps"
```

---

## Task 7: `mergeWordDiffWithTokens` — layer syntax + word-diff

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff.ts`
- Test: `frontend/__tests__/mergeWordDiff.test.ts` (create)

- [ ] **Step 1: Write failing tests (the critical unit)**

Create `frontend/__tests__/mergeWordDiff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeWordDiffWithTokens } from '../src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff';
import type { LineToken } from '../src/components/Markdown/shikiInstance';
import { diffWordsWithSpace } from 'diff';

const tok = (text: string): LineToken => ({ text, style: {} });

describe('mergeWordDiffWithTokens', () => {
  it('marks added words on the new side, leaving unchanged text plain', () => {
    const oldText = 'const x = 1;';
    const newText = 'const y = 1;';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok(newText)], parts, 'new');
    expect(spans.map((s) => s.text).join('')).toBe(newText);
    const changed = spans.filter((s) => s.change === 'insert').map((s) => s.text).join('');
    expect(changed).toContain('y');
    expect(spans.find((s) => s.text.includes('const'))!.change).toBeUndefined();
  });

  it('splits at the union of token and word-diff boundaries', () => {
    const oldText = 'xx yy';
    const newText = 'xx zz';
    const parts = diffWordsWithSpace(oldText, newText);
    // The token boundary ('xx z' | 'z') deliberately falls INSIDE the changed
    // word 'zz', so the merge must split on both token and change boundaries.
    const spans = mergeWordDiffWithTokens(newText, [tok('xx z'), tok('z')], parts, 'new');
    expect(spans.map((s) => s.text).join('')).toBe('xx zz');
    // The unchanged prefix stays plain; the whole changed word 'zz' is flagged
    // insert even though it straddles the token split.
    const changed = spans.filter((s) => s.change === 'insert').map((s) => s.text).join('');
    expect(changed).toBe('zz');
    expect(spans.some((s) => s.text.startsWith('xx') && s.change === undefined)).toBe(true);
  });

  // DEVIATION (impl-time): the original plan test used 'ab'→'aXb' and asserted
  // the changed text was 'X' alone. diffWordsWithSpace is word-level, so a
  // boundary-less 'ab'→'aXb' is a whole-word replacement ('aXb' changed), not a
  // sub-word 'X' edit. Sub-word/char precision is intentionally out of scope
  // (the design chose diffWordsWithSpace). Reworked into the whitespace-delimited
  // case above, which exercises the same token/change boundary union correctly.

  it('stays aligned when sides differ in whitespace (round-1 regression)', () => {
    const oldText = '\tif (x)   return;';
    const newText = '    if (y) return;';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok(newText)], parts, 'new');
    // text is reproduced exactly — no normalization drift
    expect(spans.map((s) => s.text).join('')).toBe(newText);
  });

  it('marks removed words on the old side as delete', () => {
    const oldText = 'foo(a, b)';
    const newText = 'foo(b)';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(oldText, [tok(oldText)], parts, 'old');
    expect(spans.map((s) => s.text).join('')).toBe(oldText);
    expect(spans.some((s) => s.change === 'delete')).toBe(true);
  });

  it('handles a capped single plaintext token (still backgrounds changes)', () => {
    const oldText = 'a';
    const newText = 'b';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok('b')], parts, 'new');
    expect(spans).toEqual([{ text: 'b', style: {}, change: 'insert' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/mergeWordDiff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the merge**

Create `frontend/src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff.ts`:

```ts
import type { Change } from 'diff';
import type { MergedSpan } from '../../../Markdown/HighlightedLine';
import type { LineToken } from '../../../Markdown/shikiInstance';

// `sideText` is the authoritative index space — the exact string tokenizeLines
// tokenized for this side. `wordDiffParts` MUST come from diffWordsWithSpace
// (whitespace significant) so the per-side concatenation equals sideText.
export function mergeWordDiffWithTokens(
  sideText: string,
  tokens: LineToken[],
  wordDiffParts: Change[],
  side: 'old' | 'new',
): MergedSpan[] {
  // 1. Flag changed characters in sideText coordinates.
  const changed = new Array<boolean>(sideText.length).fill(false);
  let cursor = 0;
  for (const part of wordDiffParts) {
    const belongsToSide = side === 'old' ? !part.added : !part.removed;
    if (!belongsToSide) continue;
    const len = part.value.length;
    const isChange = side === 'old' ? part.removed : part.added;
    if (isChange) {
      for (let i = cursor; i < cursor + len; i++) changed[i] = true;
    }
    cursor += len;
  }

  // 2. Walk tokens, splitting each at change-flag transitions.
  const spans: MergedSpan[] = [];
  let pos = 0;
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      const flag = changed[pos + i];
      let j = i + 1;
      while (j < t.text.length && changed[pos + j] === flag) j++;
      const span: MergedSpan = { text: t.text.slice(i, j), style: t.style };
      if (flag) span.change = side === 'old' ? 'delete' : 'insert';
      spans.push(span);
      i = j;
    }
    pos += t.text.length;
  }
  return spans;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run __tests__/mergeWordDiff.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff.ts __tests__/mergeWordDiff.test.ts
cd .. && git add frontend/src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff.ts frontend/__tests__/mergeWordDiff.test.ts
git commit -m "feat(highlight): mergeWordDiffWithTokens layered syntax + word-diff"
```

---

## Task 8: Integrate tokens into `DiffPane` — context & solo lines

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Test: `frontend/__tests__/DiffPane.highlight.test.tsx` (create)

This task threads a `SyntaxTokenMaps` through `DiffPane` and replaces the plain `<span>{content}</span>` content for **non-paired** rows (`DiffLineRow` context/solo, `SplitDiffLineRow` context/solo-insert/solo-delete) with `<HighlightedLine>`. Paired lines are done in Task 9.

- [ ] **Step 1: Write failing test**

Create `frontend/__tests__/DiffPane.highlight.test.tsx`:

```tsx
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffPane } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';
import type { FileChange, PrReference } from '../src/api/types';

const prRef: PrReference = { owner: 'o', repo: 'r', number: 1 };
const file = {
  path: 'a.ts',
  status: 'modified',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;' }],
} as unknown as FileChange;

describe('DiffPane syntax highlighting', () => {
  it('renders .codeToken spans for context/solo lines', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <DiffPane
        prRef={prRef} selectedPath="a.ts" file={file} diffMode="unified"
        truncated={false} reviewThreads={[]} prUrl="" headSha="h" baseSha="b"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.codeToken')).not.toBeNull();
    });
    // single wrapper per content cell
    const cells = container.querySelectorAll('.diff-content .codeLine');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((c) => expect(c.parentElement!.querySelectorAll(':scope > .codeLine').length).toBe(1));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/DiffPane.highlight.test.tsx`
Expected: FAIL — no `.codeToken`.

- [ ] **Step 3: Compute token maps in `DiffPane` and pass them down**

In `DiffPane.tsx`, add imports:

```tsx
import { useSyntaxTokens, normalizeEol, type SyntaxTokenMaps } from '../../../../hooks/useSyntaxTokens';
import { HighlightedLine } from '../../../Markdown/HighlightedLine';
import { mergeWordDiffWithTokens } from './mergeWordDiff';
import { diffWordsWithSpace } from 'diff';
import { pathToLang, type LineToken } from '../../../Markdown/shikiInstance';
```

After the `wholeFile` hook call (around line 118-126), add:

```tsx
  const syntax = useSyntaxTokens({
    path: selectedPath,
    file,
    wholeFileEnabled,
    wholeFile,
    isSplit,
    headSha,
    baseSha,
  });
```

Add a small helper near the top of the file (module scope):

```tsx
function tokensFor(
  maps: SyntaxTokenMaps,
  side: 'old' | 'new',
  lineNum: number | null | undefined,
): LineToken[] {
  if (lineNum == null) return [];
  return (side === 'old' ? maps.oldLineTokens : maps.newLineTokens).get(lineNum) ?? [];
}
```

- [ ] **Step 4: Replace plain content in unified `DiffLineRow`**

`DiffLineRow` is rendered from `renderUnifiedRows`. Pass `syntax` to it and replace its `renderContent`'s final return. First, thread the prop: add `syntax` to `DiffLineRowProps` and to every `<DiffLineRow … />` call site in `renderUnifiedRows`. Then in `renderContent`, change the trailing plain branch:

```tsx
    // was: return <span>{line.content}</span>;
    const toks = tokensFor(syntax, 'new', line.newLineNum ?? null);
    // context/solo: HighlightedLine; paired handled in Task 9.
    return (
      <HighlightedLine
        spans={toks}
        fallback={normalizeEol(line.content)}
      />
    );
```

> Leave the `pair` (paired insert/delete) branch using `WordDiffOverlay` for now — Task 9 swaps it.

- [ ] **Step 5: Replace plain content in split context / solo rows**

In `SplitDiffLineRow`, thread a `syntax` prop and replace the `<span>{content}</span>` in the `context`, `solo-delete`, and `solo-insert` branches with `<HighlightedLine>`:

- context cell `data-side="old"` and `data-side="new"`: both render the same new-side content today; replace each with `<HighlightedLine spans={tokensFor(syntax, side, lineNum)} fallback={normalizeEol(content ?? '')} />` where `side`/`lineNum` are `'old'`/`oldLineNum` for the old cell and `'new'`/`newLineNum` for the new cell.
- `solo-delete` old cell: `<HighlightedLine spans={tokensFor(syntax, 'old', oldLineNum)} fallback={normalizeEol(content ?? '')} />`.
- `solo-insert` new cell: `<HighlightedLine spans={tokensFor(syntax, 'new', newLineNum)} fallback={normalizeEol(content ?? '')} />`.

Thread `syntax` into `SplitDiffLineRow` props and every call site in `renderSplitRows`.

- [ ] **Step 6: Run to verify pass + regression**

Run: `cd frontend && npx vitest run __tests__/DiffPane.highlight.test.tsx __tests__/DiffPane.test.tsx`
Expected: PASS. Fix any existing-test selector that assumed a bare text span (update to read `.textContent`, which is unchanged).

- [ ] **Step 7: Commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx __tests__/DiffPane.highlight.test.tsx
cd .. && git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.highlight.test.tsx
git commit -m "feat(highlight): syntax-highlight context and solo diff lines"
```

---

## Task 9: Paired-line merge in `DiffPane` + large-file indicator

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` (indicator only if needed)
- Test: `frontend/__tests__/DiffPane.highlight.test.tsx` (extend)

- [ ] **Step 1: Add failing test for paired-line layering**

Append to `DiffPane.highlight.test.tsx`:

```tsx
  it('layers token color and background-only word-diff on paired lines', async () => {
    await getHighlighterAsync();
    const paired = {
      path: 'a.ts', status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;' }],
    } as unknown as FileChange;
    const { container } = render(
      <DiffPane
        prRef={prRef} selectedPath="a.ts" file={paired} diffMode="unified"
        truncated={false} reviewThreads={[]} prUrl="" headSha="h" baseSha="b"
      />,
    );
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    // a changed token carries both a syntax color var AND a background class
    expect(container.querySelector('.codeToken.wordDiffInsertBg')).not.toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run __tests__/DiffPane.highlight.test.tsx`
Expected: FAIL — paired lines still use `WordDiffOverlay` (no `.codeToken`).

- [ ] **Step 3: Add a paired-line merged renderer helper**

In `DiffPane.tsx`, add a module-scope component:

```tsx
function MergedPairedContent({
  syntax,
  side,
  lineNum,
  oldText,
  newText,
}: {
  syntax: SyntaxTokenMaps;
  side: 'old' | 'new';
  lineNum: number | null | undefined;
  oldText: string;
  newText: string;
}) {
  const toks = tokensFor(syntax, side, lineNum ?? null);
  if (toks.length === 0) {
    // No tokens yet (highlighter warming / large file) → existing word-diff fallback.
    return <WordDiffOverlay oldText={oldText} newText={newText} type={side === 'old' ? 'delete' : 'insert'} />;
  }
  // sideText is the token concatenation, NOT pair.content — guarantees
  // sum(token.length) === sideText.length so the merge's index walk is always
  // in-bounds even if whole-file headContent drifts from the hunk body for a line.
  const sideText = toks.map((t) => t.text).join('');
  const parts = diffWordsWithSpace(normalizeEol(oldText), normalizeEol(newText));
  const spans = mergeWordDiffWithTokens(sideText, toks, parts, side);
  return <HighlightedLine spans={spans} fallback={sideText} />;
}
```

- [ ] **Step 4: Swap paired branches to the merged renderer**

- Unified `DiffLineRow.renderContent`, the `pair` branch:

```tsx
    if ((line.type === 'insert' || line.type === 'delete') && pair) {
      const oldText = line.type === 'delete' ? line.content : pair.content;
      const newText = line.type === 'insert' ? line.content : pair.content;
      const side = line.type === 'delete' ? 'old' : 'new';
      return (
        <MergedPairedContent
          syntax={syntax}
          side={side}
          lineNum={line.type === 'delete' ? line.oldLineNum : line.newLineNum}
          oldText={oldText}
          newText={newText}
        />
      );
    }
```

- Split `SplitDiffLineRow` `kind === 'paired'`: replace each `<WordDiffOverlay … />` (old cell and new cell) with `<MergedPairedContent syntax={syntax} side="old" lineNum={oldLineNum} oldText={oldText ?? ''} newText={newText ?? ''} />` and the new cell with `side="new" lineNum={newLineNum}`.

Thread `syntax` into both row components (already done in Task 8 for `DiffLineRow`; add to `SplitDiffLineRow` if not already threaded).

- [ ] **Step 5: Large-file indicator in the header**

In `DiffPane`'s header, surface a muted indicator when highlighting is suppressed by the large-file guard. Compute a boolean and render it in the single right-aligned status slot (the same `.diffPaneLoading` slot — mutually exclusive with the loading text):

```tsx
  const highlightSuppressed =
    syntax.newLineTokens.size === 0 &&
    file != null &&
    file.hunks.length > 0 &&
    selectedPath != null &&
    pathToLang(selectedPath) !== null; // a supported file with no tokens ⇒ guard tripped (or still warming)
```

> `pathToLang` is already imported in the Task 8 import block. Render `{!isLoading && highlightSuppressed && (<span className={`diff-pane-loading muted ${styles.diffPaneLoading}`}>Syntax highlighting off (large file)</span>)}` in the header, after the existing `isLoading` span. Because both use the one `margin-left:auto` slot and are guarded mutually exclusive, they never collide. (Accept that the label also shows briefly while the highlighter warms on first load; it self-clears when tokens arrive. If that flicker is undesired in the visual pass, gate it behind an explicit large-file size check instead.)

- [ ] **Step 6: Run to verify pass + regressions**

Run: `cd frontend && npx vitest run __tests__/DiffPane.highlight.test.tsx __tests__/DiffPane.test.tsx __tests__/WordDiffOverlay.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx
cd .. && git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.highlight.test.tsx
git commit -m "feat(highlight): layered paired-line merge + large-file indicator"
```

---

## Task 10: Accessibility check — highlighted lines introduce no ARIA violations

**Files:**
- Modify: `frontend/e2e/a11y-audit.spec.ts` (extend) OR a vitest axe check if the suite uses one.

- [ ] **Step 1: Add an axe assertion over a highlighted diff**

Follow the existing `a11y-audit.spec.ts` pattern (it already runs axe over PR-detail). Add a step that navigates to a Files-tab diff with highlighting active and asserts `axe` finds no new violations on the diff container. Use the existing helpers in that file; do not introduce a new axe wiring.

- [ ] **Step 2: Run**

Run: `cd frontend && npx playwright test e2e/a11y-audit.spec.ts`
Expected: PASS (no new violations). The token spans carry text children, so the accessible name of each row is unchanged.

- [ ] **Step 3: Commit**

```bash
cd .. && git add frontend/e2e/a11y-audit.spec.ts
git commit -m "test(highlight): a11y axe check over highlighted diff"
```

---

## Task 11: Visual verification (Playwright, real app)

**Files:**
- Create: `frontend/e2e/syntax-highlight.spec.ts`

Per `feedback_launch_app_via_run_ps1` and `reference_real_pat_bff_repo_testing`: run the app via `run.ps1 -Reset None --no-browser` (localhost:5180, real PAT) and open a real BFF-repo PR.

- [ ] **Step 1: Write a screenshot spec covering the required cases**

Create `frontend/e2e/syntax-highlight.spec.ts` capturing, for a real PR opened in the Files tab:
1. dark theme — context + solo + a paired changed line (assert `.codeToken` present and a `.wordDiffInsertBg` on a changed token);
2. light theme — same view (toggle theme, assert `--shiki` color resolves via `html[data-theme='light']`);
3. a multi-line construct (block comment) crossing a hunk edge in hunk-only mode (documents the decision-2 edge case — screenshot only);
4. a unified whole-file delete line at a construct boundary (old-side exception — screenshot only);
5. an unknown-extension file (assert no `.codeToken`, clean plain fallback);
6. a large file (assert the "Syntax highlighting off (large file)" indicator).

Use absolute `http://localhost:5180/...` URLs for any `/test/...` hooks (Vite proxies only `/api/*`).

- [ ] **Step 2: Run the spec against the running app**

Run: `cd frontend && npx playwright test e2e/syntax-highlight.spec.ts`
Expected: PASS; screenshots written to the spec's output dir.

- [ ] **Step 3: Host screenshots + embed in the PR**

Per `feedback_visual_verification_screenshots_on_pr`: push PNGs to a throwaway `review-assets/pr-N` branch and embed raw URLs in the PR description for the B1 visual gate.

- [ ] **Step 4: PR2 pre-push checks**

Run: `cd frontend && npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend/e2e/syntax-highlight.spec.ts
git commit -m "test(highlight): real-app visual verification spec"
```

> **PR2 boundary.** Open PR2 via `pr-autopilot`. PR2 = Tasks 6–11: `useSyntaxTokens`, `mergeWordDiffWithTokens`, word-diff-bg CSS (Task 2 already landed it in PR1's tokens.css — fine, it's inert until used), diff integration for all line types, a11y + visual verification. B1 visual gate: wait for the human assert before merge.

---

## Self-Review (run against the spec)

**Spec coverage:**
- §1 Highlighter core (lang map, `tokenizeLines`, `defaultColor:false`, hex validation, per-line cap) → Task 1. ✓
- §2 `useSyntaxTokens` adaptive (whole-file split, unified old-side via hunk reconstruction, hunk-only, CRLF, memo) → Task 6. ✓
- §3 `HighlightedLine` single-child wrapper + paired-line merge → Tasks 3, 7, 8, 9. ✓
- §4 dual-theme CSS (global classes) → Task 2. ✓
- §5 Overview markdown wiring + bare-`<code>` fallback → Task 4. ✓
- Guards (large-file cap + indicator, per-line cap, unknown lang, warm-up fallback, tokenization-time decision) → Tasks 1, 6, 9. ✓
- Testing (unit, component, security create-in-PR1, a11y, visual) → Tasks 1,3,4,5,6,7,8,9,10,11. ✓
- PR decomposition (2 PRs, diff = all line types) → Phase 1 / Phase 2 boundaries. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Code shown in every code step. ✓

**Type consistency:** `LineToken {text, style}`, `MergedSpan extends LineToken {change?}`, `SyntaxTokenMaps {oldLineTokens,newLineTokens}`, `tokensFor(...)`, `normalizeEol(...)`, `mergeWordDiffWithTokens(sideText, tokens, parts, side)`, `pathToLang`, `tokenizeLines(code, lang)`, `ShikiLang` union — names match across Tasks 1, 3, 6, 7, 8, 9. ✓

**Known follow-ups (not blockers):** measured Shiki bundle delta vs budget (drop order `xml→toml→sql→dockerfile`); exact `sourceHash` left realized as memo deps over the source strings; memoize `diffWordsWithSpace` inside `MergedPairedContent` if a perf pass shows paired-line re-render jank (deferred — short-string word-diff is cheap, no measured problem).

## Implementation deviations (PR2, recorded at execution time)

Captured here per the "document plan deviations visibly" rule; each is also in its commit message.

- **Task 7 — test case 2 reworked.** The plan's `'ab'→'aXb'` case asserted char-level isolation (`'X'`) that word-level `diffWordsWithSpace` cannot produce. Replaced with a whitespace-delimited `'xx yy'→'xx zz'` case that exercises the same token/change-boundary union correctly (changed text `'zz'`, token boundary inside the changed word). Sub-word/char precision stays out of scope by design.
- **Task 8 — unified trailing branch is side-aware.** The plan used `tokensFor(syntax, 'new', line.newLineNum)` for all non-paired lines, which left unified **solo-delete** lines (no `newLineNum`) unhighlighted. Implemented as `side = line.type === 'delete' ? 'old' : 'new'` with the matching line number, so unified deletions highlight from `oldLineTokens`.
- **Task 9 — honest large-file indicator + paired-merge drift guard.** (1) `SyntaxTokenMaps` gained a `ready: boolean`; the indicator now gates on `syntax.ready && both maps empty` instead of the `newLineTokens.size === 0` proxy, which fired falsely during highlighter warm-up and on pure-deletion files. (2) `MergedPairedContent` compares `sideText` (token concatenation) to the side's normalized content and falls back to `WordDiffOverlay` on mismatch — defense against silent mis-highlighting if a whole-file token's line number ever disagreed with the hunk content.
- **Task 11 — committed spec runs against the fake backend.** The plan's Task 11 text mixed "run.ps1 real app" with `/test/*` hooks (which exist only in the hermetic Test-env fake backend). The committed `syntax-highlight.spec.ts` targets the fake backend (`advanceHead` injection, deterministic, CI-runnable) and asserts backend-independent observables (`.codeToken` renders, `--shiki-light`/`--shiki-dark` vars resolve, unknown-extension → no tokens, large-file → suppression indicator). It does NOT assert paired word-diff backgrounds (the fake backend emits solo inserts) — those are covered by `DiffPane.highlight.test.tsx` (vitest) and the real-app B1 screenshot pass.

## Known limitations

- **WCAG AA contrast on highlighted diff backgrounds.** Syntax highlighting paints muted token colors (comments, strings, etc.) that can fall below the WCAG 2.1 AA 4.5:1 text-contrast threshold (1.4.3) when rendered over the green/red diff add/delete backgrounds. Pre-PR2 plain near-black/near-white diff text passed; the syntax colors regress this for some token/background pairs. This is an inherent tradeoff of highlighting code on tinted diff rows that GitHub, GitLab, and VS Code all share, and the spec deliberately composes token foreground colors with line-level diff backgrounds. **Decision (owner, 2026-06-04): accept the tradeoff for the PoC and track a follow-up mitigation** (e.g. replace the line-level add/delete fill with a gutter/border marker when highlighting is active, so tokens sit on the normal surface; or contrast-adjust token colors over tinted rows). The Task 10 a11y test (`a11y-audit.spec.ts` › "highlighted diff") disables the `color-contrast` axe rule for the scoped diff audit with this rationale and still asserts that the `.codeLine`/`.codeToken` structure introduces no new ARIA/structural serious/critical violations. Tracked in the follow-up issue filed at PR-open time.
