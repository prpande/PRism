import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLButtonElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  CustomEvent: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      globals: browserGlobals,
    },
    plugins: { '@typescript-eslint': tseslint, 'react-hooks': reactHooks },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
      // #331 — wire dep-array / hooks correctness that was previously enforced only by
      // hand-written rationale comments. We enable exactly the two rules this issue scopes,
      // NOT the v7 `recommended-latest` preset: that preset also turns on ~15 React-Compiler-era
      // rules (immutability, purity, set-state-in-effect, preserve-manual-memoization, …) whose
      // adoption is a separate, larger decision and out of scope here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // #331 — test files: relax `exhaustive-deps` (mount probes and `renderHook`
    // wrappers legitimately violate dep-exhaustiveness) but keep `rules-of-hooks`
    // at error — a conditional/looped hook call in a custom test hook is a real
    // bug class even in tests. Must be the LAST config block: ESLint flat config
    // applies later blocks over earlier ones for matching files.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
];
