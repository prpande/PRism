# Universal AI-content marker (`AiMarker`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one shared, accessible, theme-stable `AiMarker` sparkle component and apply it to every AI surface — replacing all six raw `✨` emoji and adding the marker where AI text appears with no glyph today.

**Architecture:** A pure presentational `AiMarker` wraps a relocated, CSS-sizable `SparkIcon` (the existing welcome-screen sparkle). It has two roles selected by space: **icon-only provenance** (sr-only "AI-generated") on compact surfaces with no room for a label (inbox chip, Hotspots tab), and **decorative** beside a visible "AI…" word everywhere else. The component holds no hooks; each host mounts it only where real AI content renders.

**Tech Stack:** React 18 + TypeScript + Vite, CSS Modules + design tokens (`--accent`), Vitest + Testing Library, Playwright (visual baselines), ESLint flat config.

## Global Constraints

- **Base branch = `V2`** (never `main`). PR base must be `V2`.
- **Backend build/test:** N/A — this slice is frontend-only.
- **Verify FE tooling via the real binary**, not the rtk proxy: `node ./node_modules/prettier/bin/prettier.cjs --check .`, `node ./node_modules/vitest/vitest.mjs run` (never `npx vitest`).
- **Two FE test trees:** co-located `src/**/*.test.tsx` **and** the legacy `frontend/__tests__/` mirror — update both where a mirror exists (confirmed mirror: `frontend/__tests__/AiSummaryCard.test.tsx`).
- **`npm test` strips types** — also run `npm run build` / `tsc -b` after the shared-component move.
- **Accessible string** is the single constant `AI_PROVENANCE_LABEL = 'AI-generated'`.
- **Marker is static** (no animation), **non-interactive** (no focus/tab-stop/`title`).
- **Zero raw `✨` in `frontend/src`** at the end (grep-clean). Non-`✨` glyphs untouched.
- All commands run from the repo root `D:\src\PRism\.claude\worktrees\489-ai-marker`.

---

### Task 1: Relocate `SparkIcon` to shared `components/Ai/`, make it CSS-sizable

**Files:**
- Create: `frontend/src/components/Ai/SparkIcon.tsx`
- Create: `frontend/src/components/Ai/SparkIcon.test.tsx`
- Modify: `frontend/src/pages/welcomeIcons.tsx` (remove local `SparkIcon`, re-export from shared)

**Interfaces:**
- Produces: `export function SparkIcon(props: { size?: number; className?: string }): JSX.Element` — a decorative (`aria-hidden`, `focusable="false"`) monochrome `currentColor` SVG, 18×18 viewBox, default render 18px, overridable by `size` or by CSS `width`/`height` on `className`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Ai/SparkIcon.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SparkIcon } from './SparkIcon';

describe('SparkIcon', () => {
  it('renders a decorative svg with the sparkle paths', () => {
    const { container } = render(<SparkIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 18 18');
    expect(svg!.querySelectorAll('path')).toHaveLength(2);
  });

  it('accepts a className for sizing and a size override', () => {
    const { container } = render(<SparkIcon size={12} className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '12');
    expect(svg).toHaveClass('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Ai/SparkIcon.test.tsx`
Expected: FAIL — cannot resolve `./SparkIcon`.

- [ ] **Step 3: Create the shared component**

```tsx
// frontend/src/components/Ai/SparkIcon.tsx
export interface SparkIconProps {
  /** Pixel size; defaults to 18. CSS width/height on `className` also overrides. */
  size?: number;
  className?: string;
}

/** AI sparkle glyph (relocated from pages/welcomeIcons.tsx). Monochrome, decorative,
 *  currentColor so a parent sets the colour; size via prop or CSS. */
export function SparkIcon({ size = 18, className }: SparkIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M7.5 3.25 8.85 7.65 13 9 8.85 10.35 7.5 14.75 6.15 10.35 2 9 6.15 7.65 Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M13.75 3 14.2 4.3 15.5 4.75 14.2 5.2 13.75 6.5 13.3 5.2 12 4.75 13.3 4.3 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Re-point `welcomeIcons.tsx` at the shared icon**

In `frontend/src/pages/welcomeIcons.tsx`, delete the local `SparkIcon` function (lines ~78–96) and add a re-export near the top (after `SVG_PROPS`):

```tsx
// SparkIcon now lives in the shared Ai module (#489); re-export so /welcome is unchanged.
export { SparkIcon } from '../components/Ai/SparkIcon';
```

Leave `LockIcon` and `PanelsIcon` untouched. `WelcomePage.tsx` keeps `import { LockIcon, PanelsIcon, SparkIcon } from './welcomeIcons';` unchanged.

- [ ] **Step 5: Run tests + typecheck**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Ai/SparkIcon.test.tsx` → PASS
Run: `npm run build` → typecheck PASS (this is the regression guard for the `welcomeIcons.tsx` re-export + `WelcomePage.tsx` import — there is **no** WelcomePage unit test, so do not rely on a vitest run to cover `/welcome`).
Run: `grep -n "export { SparkIcon }" frontend/src/pages/welcomeIcons.tsx` → confirms the re-export line is present.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/SparkIcon.tsx frontend/src/components/Ai/SparkIcon.test.tsx frontend/src/pages/welcomeIcons.tsx
git commit -m "refactor(ai-marker): relocate SparkIcon to shared Ai module, make CSS-sizable (#489)"
```

---

### Task 2: `AiMarker` component, CSS, and `AI_PROVENANCE_LABEL` constant

**Files:**
- Create: `frontend/src/components/Ai/aiStrings.ts`
- Create: `frontend/src/components/Ai/AiMarker.tsx`
- Create: `frontend/src/components/Ai/AiMarker.module.css`
- Create: `frontend/src/components/Ai/AiMarker.test.tsx`
- Modify: `frontend/src/components/Ai/index.ts` (export `AiMarker`)

**Interfaces:**
- Consumes: `SparkIcon` from Task 1.
- Produces:
  - `export const AI_PROVENANCE_LABEL = 'AI-generated'`
  - `export function AiMarker(props: { variant?: 'superscript' | 'inline'; decorative?: boolean; className?: string }): JSX.Element` — wrapper `<span data-ai-marker data-testid="ai-marker">` containing `SparkIcon`; provenance (default) appends `<span class="sr-only">AI-generated</span>`; `decorative` omits it. No `title`. Variant class controls geometry.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Ai/AiMarker.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AiMarker } from './AiMarker';
import { AI_PROVENANCE_LABEL } from './aiStrings';

describe('AiMarker', () => {
  it('provenance (default) renders the sparkle plus an sr-only label', () => {
    render(<AiMarker />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent(AI_PROVENANCE_LABEL);
    expect(marker).not.toHaveAttribute('title');
  });

  it('decorative renders the sparkle with no sr-only label and no title', () => {
    render(<AiMarker decorative />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker).toHaveTextContent('');
    expect(marker).not.toHaveAttribute('title');
  });

  it('applies the variant class (superscript default, inline opt-in)', () => {
    const { rerender } = render(<AiMarker />);
    expect(screen.getByTestId('ai-marker').className).toMatch(/superscript/);
    rerender(<AiMarker variant="inline" />);
    expect(screen.getByTestId('ai-marker').className).toMatch(/inline/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiMarker.test.tsx`
Expected: FAIL — cannot resolve `./AiMarker`.

- [ ] **Step 3: Create the constant, component, and CSS**

```ts
// frontend/src/components/Ai/aiStrings.ts
/** Single source of truth for the AI-provenance accessible label (#489). */
export const AI_PROVENANCE_LABEL = 'AI-generated';
```

```tsx
// frontend/src/components/Ai/AiMarker.tsx
import { SparkIcon } from './SparkIcon';
import { AI_PROVENANCE_LABEL } from './aiStrings';
import styles from './AiMarker.module.css';

export interface AiMarkerProps {
  /** 'superscript' (default) = tiny raised glyph beside a text label;
   *  'inline' = baseline glyph for buttons / nav / headers. */
  variant?: 'superscript' | 'inline';
  /** Identity use: decorative glyph only, no sr-only label. Use where adjacent
   *  visible "AI…" text already announces provenance. Default false = provenance. */
  decorative?: boolean;
  className?: string;
}

// Pure presentational AI marker (#489). Holds no hooks: the host mounts it only
// where real AI content renders (never on loading/error copy). Static, non-interactive.
export function AiMarker({ variant = 'superscript', decorative = false, className }: AiMarkerProps) {
  const cls = [
    styles.aiMarker,
    variant === 'inline' ? styles.inline : styles.superscript,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} data-ai-marker="" data-testid="ai-marker">
      <SparkIcon className={styles.glyph} />
      {!decorative && <span className="sr-only">{AI_PROVENANCE_LABEL}</span>}
    </span>
  );
}
```

```css
/* frontend/src/components/Ai/AiMarker.module.css */
.aiMarker {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
}
.glyph {
  width: 1em;
  height: 1em;
  display: block;
}
/* Superscript: tiny raised glyph against a text label. Sits OUTSIDE the label's
   truncation region (caller spaces it); never animate (spec §4/§8). */
.superscript {
  font-size: 0.72em;
  vertical-align: super;
  margin-inline-start: 0.2em;
}
/* Inline: baseline glyph for buttons / nav / headers. */
.inline {
  font-size: 1rem;
}
```

- [ ] **Step 4: Export from the Ai barrel**

In `frontend/src/components/Ai/index.ts`, add:

```ts
export { AiMarker } from './AiMarker';
export type { AiMarkerProps } from './AiMarker';
export { AI_PROVENANCE_LABEL } from './aiStrings';
```

- [ ] **Step 5: Run tests + build**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiMarker.test.tsx` → PASS
Run: `npm run build` → PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/aiStrings.ts frontend/src/components/Ai/AiMarker.tsx frontend/src/components/Ai/AiMarker.module.css frontend/src/components/Ai/AiMarker.test.tsx frontend/src/components/Ai/index.ts
git commit -m "feat(ai-marker): add shared AiMarker component (provenance + decorative) (#489)"
```

---

### Task 3: AI Summary — add visible "AI Summary" label + decorative marker (success branch)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css` (only if a spacing class is needed)
- Test: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx` and legacy `frontend/__tests__/AiSummaryCard.test.tsx`

**Interfaces:**
- Consumes: `AiMarker` (decorative superscript), the existing `.aiSummaryLabel` CSS class.

- [ ] **Step 1: Write the failing test** (co-located)

```tsx
// add to AiSummaryCard.test.tsx
it('renders an "AI Summary" label with the decorative marker on success', () => {
  render(<AiSummaryCard summary={{ body: 'x', category: 'fix' }} loading={false} error={false} />);
  expect(screen.getByText('AI Summary')).toBeInTheDocument();
  expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
});

it('does NOT render the label/marker on loading or error', () => {
  const { rerender } = render(<AiSummaryCard summary={null} loading error={false} />);
  expect(screen.queryByTestId('ai-marker')).toBeNull();
  rerender(<AiSummaryCard summary={null} loading={false} error />);
  expect(screen.queryByTestId('ai-marker')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx`
Expected: FAIL — no "AI Summary" text / no `ai-marker`.

- [ ] **Step 3: Add the label + marker in the success branch**

In `AiSummaryCard.tsx`, add the import:

```tsx
import { AiMarker } from '../../Ai/AiMarker';
```

In the **success** return (the `<section …data-testid="ai-summary-card">` block), insert the label as the **first child, before `<SampleBadge />`** — so SampleBadge's `.aiSummaryCard [data-sample-badge] + *` margin target (its *next* sibling) is unchanged:

```tsx
    <section
      className={`ai-summary-card ${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
      data-testid="ai-summary-card"
    >
      <span className={styles.aiSummaryLabel}>
        AI Summary
        <AiMarker variant="superscript" decorative />
      </span>
      <SampleBadge />
      {/* …existing Live head / chip / body unchanged… */}
```

Then give `.aiSummaryLabel` (currently typography-only, `AiSummaryCard.module.css` ~lines 52–58) a flex baseline context so the superscript glyph aligns predictably beside the uppercase text:

```css
.aiSummaryLabel {
  display: inline-flex;
  align-items: baseline;
  /* …existing font-weight / font-size / letter-spacing / text-transform / color… */
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx` → PASS

- [ ] **Step 5: Update the legacy mirror**

Apply the same two assertions to `frontend/__tests__/AiSummaryCard.test.tsx` (mirror the new `it(...)` blocks). Run:
`node ./node_modules/vitest/vitest.mjs run __tests__/AiSummaryCard.test.tsx` → PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx frontend/__tests__/AiSummaryCard.test.tsx
git commit -m "feat(ai-marker): label AI summary card with AI Summary + marker (#489)"
```

---

### Task 4: Hunk annotation — replace emoji with decorative marker

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx` (or co-located test for the component)

**Interfaces:**
- Consumes: `AiMarker` (inline decorative). Keeps the existing visible `<span>AI</span>` meta label.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the AiMarker and no raw sparkle emoji', () => {
  render(<AiHunkAnnotation annotation={{ tone: 'calm', body: 'x' }} />);
  expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
  expect(screen.getByTestId('ai-hunk').textContent).not.toContain('✨');
  expect(screen.getByText('AI')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx`
Expected: FAIL — no `ai-marker`.

- [ ] **Step 3: Replace the emoji span**

In `AiHunkAnnotation.tsx`, add `import { AiMarker } from '../../../../Ai/AiMarker';` and replace the emoji span (lines 28–30, the `<span className="ai-icon" aria-hidden="true">✨</span>` before `<div className={styles.aiHunkBody}>`):

```tsx
      <span className="ai-icon" aria-hidden="true">
        ✨
      </span>
```

with:

```tsx
      <AiMarker variant="inline" decorative className="ai-icon" />
```

(`className="ai-icon"` preserves the existing tinted-box slot look; the B1 pass decides whether to keep the box for the monochrome glyph.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx
git commit -m "feat(ai-marker): swap hunk-annotation emoji for AiMarker (#489)"
```

---

### Task 5: Inbox category chip — icon replaces "AI" text + provenance reaches AT via aria-label

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

**Interfaces:**
- Consumes: `AiMarker`. The visible chip marker becomes the icon (decorative in the DOM, since the row `<button>` swallows descendant labels); provenance is delivered by composing `AI_PROVENANCE_LABEL` into the row's `aria-label`.

- [ ] **Step 1: Write the failing test**

**Use the file's existing harness — do NOT invent `makePr()`.** `InboxRow.test.tsx` already has a `const PR` fixture and a `renderInboxRow(pr, props)` helper that wraps the row in `MemoryRouter` + `OpenTabsProvider` (the row calls `useNavigate`/`useOpenTabs` and requires a `maxDiff` prop — rendering `<InboxRow>` bare throws). `InboxItemEnrichment` requires `{ prId, categoryChip, hoverSummary }` — mirror the shape the existing enrichment tests pass. Add:

```tsx
it('AI category chip: icon replaces the "AI" text and provenance rides the row aria-label', () => {
  renderInboxRow(PR, {
    showCategoryChip: true,
    enrichment: { prId: PR.prId, categoryChip: 'Refactor', hoverSummary: 's' },
  });
  const row = screen.getByRole('button');
  expect(row).toHaveAccessibleName(/AI-generated/); // provenance via accessible name
  expect(screen.getByTestId('ai-marker')).toBeInTheDocument(); // icon, not literal "AI"
  expect(screen.getByText('Refactor')).toBeInTheDocument();
});

it('no AI provenance in the aria-label when the chip is hidden', () => {
  renderInboxRow(PR, {
    showCategoryChip: false,
    enrichment: { prId: PR.prId, categoryChip: 'Refactor', hoverSummary: 's' },
  });
  expect(screen.getByRole('button')).not.toHaveAccessibleName(/AI-generated/);
});
```

**Also update the pre-existing chip-marker assertions** (~lines 265–268) that break once the literal "AI" text becomes the marker. The old block does `chip.querySelector('[class*="chipMarker"]')` then `toHaveTextContent('AI')` + `toHaveAttribute('aria-hidden','true')` — neither holds on the marker wrapper (it wraps an SVG; `aria-hidden` is on the nested SVG). Replace with a `getByTestId('ai-marker')` presence check and drop the text/`aria-hidden`-on-wrapper assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — accessible name lacks "AI-generated" / no `ai-marker`.

- [ ] **Step 3: Compose provenance into the aria-label and swap the chip marker**

In `InboxRow.tsx`, add `import { AiMarker } from '../Ai/AiMarker';` and `import { AI_PROVENANCE_LABEL } from '../Ai/aiStrings';`.

Add an AI suffix after the `ciSuffix` line (~line 83):

```tsx
  // #489: the chip's sparkle is visual-only (button swallows descendant labels),
  // so the AI provenance rides the row aria-label instead.
  const aiSuffix =
    showCategoryChip && enrichment?.categoryChip ? ` · ${AI_PROVENANCE_LABEL}` : '';
```

Append `${aiSuffix}` to both `ariaLabel` branches (lines 85–89):

```tsx
  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}${aiSuffix}`
    : `${pr.title} · ${pr.repo} · open · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}${aiSuffix}`;
```

Replace the `.chipMarker` "AI" text (lines 129–131) with the decorative **inline** icon (the comment above it stays accurate — still a sighted-user cue):

```tsx
                <span className={styles.chip}>
                  <AiMarker variant="inline" decorative className={styles.chipMarker} />
                  {enrichment.categoryChip}
                </span>
```

Use `variant="inline"` — **not** superscript: the `.chip` pill has `overflow:hidden; text-overflow:ellipsis`, so a `vertical-align:super` glyph would be clipped at the pill's top edge (the #492 trap). Keep `className={styles.chipMarker}` so the fixed-width `flex:none` slot behaviour (in-code comment) is preserved; the SVG sizes to `1em` of the chip's font.

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Inbox/InboxRow.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(ai-marker): inbox chip icon + AI-generated in row aria-label (#489)"
```

---

### Task 6: Hotspots tab — icon-only provenance marker at the tab top

**Files:**
- Modify: `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx`
- Modify: `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css` (positioning class)
- Test: `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx`

**Interfaces:**
- Consumes: `AiMarker` (provenance **inline** — sr-only "AI-generated"; nothing else announces it, and the tab top is not a label-swallowing control so the sr-only surfaces).

- [ ] **Step 1: Write the failing test**

**Use the file's existing harness — `HotspotsTab` takes NO props** (it reads state from `usePrDetailContext()`). `HotspotsTab.test.tsx` already has a `renderTab(fileFocus, …)` helper that wraps `<HotspotsTab />` in a `PrDetailContextProvider` with a full context value; mirror it. Add a present-case and the negative present-content-boundary cases:

```tsx
it('renders exactly one provenance marker at the top of the tab on success', () => {
  renderTab(/* fileFocus fixture with ≥1 high/medium entry — mirror existing tests */);
  expect(screen.getAllByTestId('ai-marker')).toHaveLength(1); // region-level, not per row
  expect(screen.getByText('AI-generated')).toBeInTheDocument(); // sr-only, surfaces here
});

it.each(['loading', 'fallback', 'error', 'not-subscribed', 'no-changes', 'empty'])(
  'does NOT render the marker in the %s state (present-content boundary)',
  (status) => {
    renderTab(/* fixture/ctx that drives HotspotsTab into this status — mirror existing tests */);
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  },
);
```

(The implementation guards each non-success state with an early return *before* the success `<div className={styles.hotspots}>`, so these pass once the marker lives only in that success return — but TDD must assert the boundary, mirroring Task 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx`
Expected: FAIL — no `ai-marker`.

- [ ] **Step 3: Add the marker at the top of `.hotspots`**

In `HotspotsTab.tsx`, add `import { AiMarker } from '../../Ai/AiMarker';` and insert at the top of the container (line ~55):

```tsx
  return (
    <div className={styles.hotspots}>
      <div className={styles.aiRegionMark}>
        <AiMarker variant="inline" />
      </div>
      {high.length > 0 && <Group label="High" rows={high} onOpen={requestFileView} />}
      {medium.length > 0 && <Group label="Medium" rows={medium} onOpen={requestFileView} />}
    </div>
  );
```

Add to `HotspotsTab.module.css`:

```css
/* #489: region-level AI provenance marker, top-right of the tab content. */
.aiRegionMark {
  display: flex;
  justify-content: flex-end;
  color: var(--accent);
}
```

(Exact position/size is a B1 visual decision; the marker must render exactly once.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx
git commit -m "feat(ai-marker): provenance marker on the Hotspots tab (#489)"
```

---

### Task 7: AI Settings tab — decorative marker on the "AI" nav label

**Files:**
- Modify: `frontend/src/components/Settings/SettingsNav.tsx`
- Test: `frontend/src/components/Settings/SettingsNav.test.tsx` (**already exists — extend it**)

**Interfaces:**
- Consumes: `AiMarker` (inline decorative). Only the `section === 'ai'` item gets it.

- [ ] **Step 1: Write the failing test**

**Extend the existing file using its `renderAt(path)` helper** (it wraps `SettingsNav` in `MemoryRouter`; `SettingsNav`/`SettingsLink` call `useLocation`/`useEffectiveLocation`, so a bare `render(<SettingsNav />)` throws). Query by **exact** name to avoid matching a future "AI …" tab:

```tsx
it('shows the AI marker only on the AI nav item', () => {
  renderAt('/settings/appearance');
  const aiLink = screen.getByRole('link', { name: 'AI' });
  expect(aiLink.querySelector('[data-ai-marker]')).not.toBeNull();
  const appearance = screen.getByRole('link', { name: 'Appearance' });
  expect(appearance.querySelector('[data-ai-marker]')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Settings/SettingsNav.test.tsx`
Expected: FAIL — no marker in the AI item.

- [ ] **Step 3: Render the marker for the AI item**

In `SettingsNav.tsx`, add `import { AiMarker } from '../Ai/AiMarker';` and update the `Item` body (lines 20–29) to append the marker when `section === 'ai'`:

```tsx
function Item({ section, label, active }: NavItem & { active: boolean }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={active ? 'page' : undefined}
    >
      {label}
      {section === 'ai' && <AiMarker variant="inline" decorative />}
    </SettingsLink>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/Settings/SettingsNav.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/SettingsNav.tsx frontend/src/components/Settings/SettingsNav.test.tsx
git commit -m "feat(ai-marker): AI identity marker on the settings AI tab (#489)"
```

---

### Task 8: Ask-AI pull-tab + drawer (3 sites) — replace emoji with decorative markers

**Files:**
- Modify: `frontend/src/components/AskAiDrawer/AskAiPullTab.tsx`
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.tsx`
- Test: co-located `AskAiPullTab.test.tsx` / `AskAiDrawer.test.tsx` — **mirror each file's existing render harness** (the drawer uses its real provider/thread flow; drive one AI message + a `pendingAiReply` through that harness, not a bare `render`).

**Interfaces:**
- Consumes: `AiMarker` (inline decorative) at all four sites. Header (7a), per-message (7b), typing indicator (7c) are all decorative — the drawer is one AI region marked at the header (Decision 3).

- [ ] **Step 1: Write the failing tests**

```tsx
// AskAiPullTab.test.tsx — mirror the file's existing render setup
it('renders the AiMarker and no raw emoji', () => {
  /* render via the file's existing harness */
  expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
  expect(screen.getByRole('button').textContent).not.toContain('✨');
});
```

```tsx
// AskAiDrawer.test.tsx — open drawer, thread = exactly 1 AI message + pendingAiReply
it('replaces all three drawer sparkles with markers and leaves no emoji', () => {
  const { container } = render(/* file's harness: drawer open, 1 ai msg + pendingAiReply */);
  expect(container.textContent).not.toContain('✨');
  // header + one message + typing indicator = exactly three (exact count catches a missed swap)
  expect(screen.getAllByTestId('ai-marker')).toHaveLength(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/AskAiDrawer`
Expected: FAIL — no `ai-marker`.

- [ ] **Step 3: Swap all four emoji spans**

In **`AskAiPullTab.tsx`** add `import { AiMarker } from '../Ai/AiMarker';` and replace the emoji span (~lines 26–28):

```tsx
      <span className="ai-icon" aria-hidden="true">
        ✨
      </span>
```
with
```tsx
      <AiMarker variant="inline" decorative className="ai-icon" />
```

In **`AskAiDrawer.tsx`** add the same import and replace each of the three `<span className="ai-icon" aria-hidden="true">✨</span>` blocks — header (~lines 86–88), per-AI-message (~lines 111–113), typing indicator (~lines 120–122); match on the emoji-span content, not the exact line — with:

```tsx
      <AiMarker variant="inline" decorative className="ai-icon" />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/AskAiDrawer` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer/
git commit -m "feat(ai-marker): migrate Ask-AI pull-tab + drawer emoji to AiMarker (#489)"
```

---

### Task 9: Stale-draft suggestion — replace emoji with decorative marker

**Files:**
- Modify: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx`
- Test: co-located **`StaleDraftRow.sample.test.tsx`** (the existing co-located test file — there is no plain `StaleDraftRow.test.tsx`; extend the `.sample` file and mirror its fixture)

**Interfaces:**
- Consumes: `AiMarker` (inline decorative). Keeps the existing visible "AI suggestion" label.

- [ ] **Step 1: Write the failing test**

**Mirror the fixture in `StaleDraftRow.sample.test.tsx`.** `StaleDraftRow` has several required props (`prRef`, `draft` (a non-trivial `DraftLike`), `onMutated`, `aiSuggestion`, `onSelectSubTab`); reuse the props object the existing sample test already builds rather than inventing one. Add:

```tsx
it('renders the AiMarker, keeps the "AI suggestion" label, drops the emoji', () => {
  /* render via the file's existing fixture, ensuring aiSuggestion is present */
  const block = screen.getByTestId('stale-draft-ai-suggestion');
  expect(within(block).getByTestId('ai-marker')).toBeInTheDocument();
  expect(within(block).getByText('AI suggestion')).toBeInTheDocument();
  expect(block.textContent).not.toContain('✨');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/Reconciliation/StaleDraftRow.sample.test.tsx`
Expected: FAIL — no `ai-marker`.

- [ ] **Step 3: Swap the emoji span**

In `StaleDraftRow.tsx` add `import { AiMarker } from '../../Ai/AiMarker';` and replace the emoji span (~lines 131–133, the `<span className="ai-icon" aria-hidden="true">✨</span>` before `<div className={styles.staleAiBody}>`):

```tsx
          <span className="ai-icon" aria-hidden="true">
            ✨
          </span>
```
with
```tsx
          <AiMarker variant="inline" decorative className="ai-icon" />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/Reconciliation/StaleDraftRow.sample.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.sample.test.tsx
git commit -m "feat(ai-marker): migrate stale-draft emoji to AiMarker (#489)"
```

---

### Task 10: Grep-clean verification + ESLint guard against raw `✨`

**Files:**
- Modify: `frontend/eslint.config.js`

**Interfaces:** none (config + verification).

- [ ] **Step 1: Verify zero raw sparkles remain**

Run (from repo root): `grep -rn "✨" frontend/src`
Expected: **no output** (all six migrated). If any remain, fix that surface before proceeding — the lint rule below would otherwise fail.

- [ ] **Step 2: Add the ESLint rule**

In `frontend/eslint.config.js`, extend the `files: ['**/*.{ts,tsx}']` block's `rules` object (after the `react-hooks/*` rules, ~line 49) with:

```js
      // #489 — the sparkle AI marker has a single source of truth (components/Ai/AiMarker).
      // Ban the raw emoji so a future surface can't silently reintroduce per-OS-variant glyphs.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/\\u2728/]",
          message: 'Use <AiMarker /> (components/Ai/AiMarker) instead of the raw ✨ emoji (#489).',
        },
        {
          selector: "JSXText[value=/\\u2728/]",
          message: 'Use <AiMarker /> (components/Ai/AiMarker) instead of the raw ✨ emoji (#489).',
        },
        {
          selector: "TemplateElement[value.raw=/\\u2728/]",
          message: 'Use <AiMarker /> (components/Ai/AiMarker) instead of the raw ✨ emoji (#489).',
        },
      ],
```

(`Literal` covers string literals **and** JSX attribute string values; `JSXText` covers element children; `TemplateElement` covers template literals.)

- [ ] **Step 3: Run lint to verify it passes (and would catch a regression)**

Run: `node ./node_modules/eslint/bin/eslint.js .` (from `frontend/`) → PASS (0 errors).
Sanity-check the rule bites at two sites: temporarily add `const x = '✨';` (string literal) **and** a JSX child `<span>✨</span>` to any `.tsx` file, re-run eslint, confirm both error with the #489 message, then remove them.

- [ ] **Step 4: Commit**

```bash
git add frontend/eslint.config.js
git commit -m "chore(ai-marker): ESLint guard banning raw ✨ in frontend/src (#489)"
```

---

### Task 11: Full suite, build, prettier, and baseline regeneration

**Files:** none (verification + generated baselines).

- [ ] **Step 1: Full FE gate (real binaries, not rtk)**

```bash
cd frontend
node ./node_modules/vitest/vitest.mjs run        # all unit/component tests PASS
npm run build                                     # tsc -b + vite build PASS
node ./node_modules/prettier/bin/prettier.cjs --check .   # formatting clean (whole dir)
node ./node_modules/eslint/bin/eslint.js .        # lint clean
```

- [ ] **Step 2: Regenerate affected visual baselines**

Affected (regenerate whichever the visual suite actually renders — a surface absent from a spec won't produce a baseline): `pr-detail-overview`, `pr-detail-hotspots`, `pr-detail-files-diff`, `pr-detail-drafts` (only if `StaleDraftRow` is in that spec's fixture), `ask-ai-drawer`, `inbox` (Preview), settings AI pane. **NOT** `pr-detail-files-tree`.
- **win32:** run the Playwright visual suite locally with `--update-snapshots` for the affected specs.
- **linux:** let CI render, download the `e2e-results` artifact, and commit the exact `__screenshots__/linux/*.png` (do not hand-tweak — exact regen per the #492 workflow).

- [ ] **Step 3: Commit baselines**

```bash
git add frontend/e2e/__screenshots__/
git commit -m "test(ai-marker): regenerate visual baselines for marked surfaces (#489)"
```

- [ ] **Step 4: Run `/simplify` over the diff**

Quality pass before PR (per repo pre-push checklist). Apply surviving suggestions.

---

## Self-Review

**Spec coverage:** Every §6 surface maps to a task — summary (T3), Hotspots (T6), hunk (T4), inbox chip (T5), settings tab (T7), pull-tab/drawer (T8), stale-draft (T9); component+glyph (T1/T2); ESLint+grep-clean (T10); baselines/gate (T11). Variant per the §6 table is encoded in each task's `AiMarker` props (provenance icon-only inline on Hotspots; decorative everywhere else; inbox chip = decorative marker + provenance via row aria-label). The AT-reach caveat for the inbox chip is T5 Step 3 + its test. The present-content-boundary rule is T3's and T6's loading/error/empty negative tests.

**Test-harness note (post doc-review):** the surface tasks do **not** invent fixtures — each uses the host file's existing harness: `renderInboxRow(PR, props)` (T5, with `maxDiff` + `{prId,categoryChip,hoverSummary}` enrichment), `renderTab(fileFocus)` + `PrDetailContextProvider` (T6, `HotspotsTab` takes no props), `renderAt(path)` (T7, the file already exists), the drawer's real provider/thread flow (T8), and the existing `StaleDraftRow.sample.test.tsx` fixture (T9). Tasks 5 also updates the pre-existing `chipMarker` assertion that the swap would otherwise break.

**Type consistency:** `AiMarker` props (`variant`, `decorative`, `className`) and `AI_PROVENANCE_LABEL` are defined in T2 and consumed unchanged in T3–T9; `SparkIcon` props (`size`, `className`) defined in T1 and consumed by T2.

## Execution Handoff

Plan complete. After the plan gate, execute via **subagent-driven-development** (fresh subagent per task, review between), or inline via **executing-plans**.
