# Root-Comment Standalone Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the PR Overview root-comment timeline so each comment is a standalone raised card (border + `--shadow-2`) with a `--surface-2` header band, anchored to a single continuous left rail.

**Architecture:** Pure presentation change to one component — `PrRootConversation.tsx` JSX restructure (`header+body` → `grid(rail + card(band + body))`) plus a full rewrite of its CSS module, landed together in one commit (the JSX and CSS class names are coupled). No data, API, composer, or behavior changes. Elevation comes from the card's own border/shadow (the Overview page is already `--surface-0`, so there is no darker surface to recess into); long code already wraps via the shipped global `.markdown-body pre { white-space: pre-wrap }`.

**Tech Stack:** React + TypeScript + Vite, CSS Modules over a global oklch design-token system (`frontend/src/styles/tokens.css`), Vitest (unit), Playwright (parity/a11y e2e).

**Spec:** `docs/specs/2026-06-04-root-comment-cards-design.md`

**Risk:** B1 (UI-visual, gated) — drive to green-and-ready, then PAUSE for the human visual assert. Do NOT merge.

---

## File structure

- **Modify** `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx` — restructure the comment map into `grid(rail + card(band + body))`; preserve `data-testid="pr-root-comment"`, author, `<time>`, `<MarkdownRenderer>`, the actions row, and the read-only footer.
- **Rewrite** `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css` — new `.timeline/.item/.rail/.node/.card/.band/.author/.time/.body` classes; keep the actions/footer classes verbatim.
- **Modify** `frontend/__tests__/PrRootConversation.test.tsx` — add one structural guard test.
- **Update** `frontend/e2e/__screenshots__/win32/pr-detail-overview.png` — re-capture the parity baseline (intentional, this PR).

All `npx`/`npm` commands run from `D:/src/PRism-129-comment-cards/frontend` unless noted.

---

### Task 1: Add the structural guard test (author + time + body co-located in one card)

This is a characterization guard: it passes on the *current* code and must stay green through the restructure, locking in "each comment is one cohesive unit."

**Files:**
- Test: `frontend/__tests__/PrRootConversation.test.tsx`

- [ ] **Step 1: Add the test** inside the `describe('PrRootConversation', …)` block, after the existing `isolates each comment…` test (before the closing `});`):

```tsx
  it('co-locates author, timestamp, and body inside a single comment card', () => {
    const { container } = render(<PrRootConversation comments={[aliceComment]} />);
    const entry = within(container).getByTestId('pr-root-comment');
    // author, the <time> element, and the markdown body all live within ONE entry
    expect(within(entry).getByText('alice')).toBeInTheDocument();
    expect(
      within(entry).getByText((_, el) => el?.tagName.toLowerCase() === 'time'),
    ).toHaveAttribute('dateTime', '2026-05-08T14:00:00Z');
    expect(within(entry).getByText('WhenAll').tagName.toLowerCase()).toBe('strong');
  });
```

- [ ] **Step 2: Run it — expect PASS on current code**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx`
Expected: PASS (all tests, including the new one). This establishes the safety net before the restructure.

- [ ] **Step 3: Commit**

```bash
git add frontend/__tests__/PrRootConversation.test.tsx
git commit -m "test(#129): guard author+time+body co-located in one comment card"
```

---

### Task 2: Rewrite the CSS module and restructure the JSX (single commit)

The CSS class names and the JSX that consumes them are coupled, so they land together — there is no intermediate committed state.

**Files:**
- Modify (full rewrite): `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx`

- [ ] **Step 1: Replace the entire CSS module contents** with:

```css
.prRootConversation {
  display: flex;
  flex-direction: column;
}

/* Vertical comment timeline. */
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.item {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: var(--s-3);
}

.item + .item {
  margin-top: var(--s-3);
}

/*
 * Rail gutter: a single continuous line + an accent node per card. The line
 * starts at the node's center and extends `bottom: calc(-1 * var(--s-3))` so it
 * bridges the inter-card gap (= the .item margin-top) into the next card; it is
 * hidden on the last comment. The node carries a ring in the section color so the
 * line appears to pass behind it.
 *
 * Node/line `top` are pixel constants approximating the band's optical center
 * (band padding-top var(--s-2)=8px + ~half the --text-xs line-box). If the band
 * padding or --text-xs ever changes, re-tune these two values (verified at the
 * B1 visual gate).
 */
.rail {
  position: relative;
  /* Grid items are blockified by spec, but set display explicitly so the rail
     cell reliably stretches to the row height and the ::before line + .node
     anchor to a full-height box. */
  display: block;
}

.rail::before {
  content: '';
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 16px;
  bottom: calc(-1 * var(--s-3));
  width: 2px;
  background: var(--border-2);
}

.item:last-child .rail::before {
  display: none;
}

.node {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 12px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--surface-1);
}

/*
 * Standalone comment card. Same surface as its host section (--surface-1), lifted
 * by border + shadow — NOT a recessed well (the Overview page is already
 * --surface-0, the darkest surface, so there is nothing to recess into). This
 * inverts the old sunken read where the body was --surface-2 (darker than host).
 * In dark mode --shadow-2 (alpha 0.40) carries the lift; in light the border +
 * band do more of the work.
 */
.card {
  min-width: 0;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

/*
 * Header band: binds author/time into the card. `align-items: center` (NOT
 * baseline): .author is a scroll container (overflow:hidden for the ellipsis),
 * which synthesizes its baseline from the margin box and would misalign .time
 * under baseline alignment. In dark mode the fill delta vs the card is tiny
 * (~0.025 L) so the border-bottom is the real separator there; the fill carries
 * it in light.
 */
.band {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--text-xs);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-1);
  padding: var(--s-2) var(--s-4);
}

.author {
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  color: var(--text-3);
  flex: none;
  white-space: nowrap;
}

.body {
  min-width: 0;
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
}

/* `white-space: pre-wrap` is carried verbatim from the prior implementation —
   it preserves intentional hard line breaks in comment prose. Kept unchanged to
   avoid altering how existing comments render in this visual restyle. */
.body p {
  margin: 0 0 8px;
  text-wrap: pretty;
  white-space: pre-wrap;
}

.body p:last-child {
  margin: 0;
}

.body code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--surface-3);
  border-radius: 3px;
  color: var(--text-1);
}

.prRootConversationActions {
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.prRootConversationActionsRow {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.prRootReplyButton {
  display: inline-flex;
  align-items: center;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 8px 12px;
  cursor: text;
  transition:
    border-color var(--t-fast),
    color var(--t-fast);
}

.prRootReplyButton:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.prRootConversationFooter {
  font-size: var(--text-xs);
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-1);
}
```

- [ ] **Step 2: Replace the `PrRootConversation` function body** in `PrRootConversation.tsx` (the top-level exported function, lines ~30-60 — NOT `PrRootConversationActions`) with:

```tsx
export function PrRootConversation({ comments, replyContext }: PrRootConversationProps) {
  return (
    <section className={`overview-card ${styles.prRootConversation}`}>
      {comments.length > 0 && (
        <ol className={styles.timeline}>
          {comments.map((comment) => (
            <li key={comment.id} className={styles.item}>
              <span className={styles.rail} aria-hidden="true">
                <span className={styles.node} />
              </span>
              <article className={styles.card} data-testid="pr-root-comment">
                <header className={styles.band}>
                  <span className={styles.author}>{comment.author}</span>
                  <time className={styles.time} dateTime={comment.createdAt}>
                    {new Date(comment.createdAt).toLocaleDateString()}
                  </time>
                </header>
                <div className={styles.body}>
                  <MarkdownRenderer source={comment.body} />
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}

      {replyContext ? (
        <PrRootConversationActions replyContext={replyContext} />
      ) : (
        // Rendered when the conversation is mounted in a read-only context
        // (e.g., a future Drafts-tab preview slot).
        <p className={`${styles.prRootConversationFooter} muted`}>
          Composer not available in this context.
        </p>
      )}
    </section>
  );
}
```

Leave the imports, the `PrRootConversationReplyContext`/`PrRootConversationProps` interfaces, and the `PrRootConversationActions` function exactly as they are.

- [ ] **Step 3: Format both files**

Run: `npx prettier --write src/components/PrDetail/OverviewTab/PrRootConversation.module.css src/components/PrDetail/OverviewTab/PrRootConversation.tsx`
Expected: reformatted/unchanged.

- [ ] **Step 4: Run the component's unit tests — expect PASS**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx __tests__/OverviewTab.test.tsx`
Expected: PASS. The queries are behavioral (`data-testid="pr-root-comment"`, text, role, `<time>`, `strong`) and `within()` walks the full subtree, so the `<ol>/<li>` + band nesting does not break them.

- [ ] **Step 5: Lint + typecheck/build**

Run: `npm run lint`
Expected: clean (eslint + prettier --check).

Run: `npm run build`
Expected: `tsc -b && vite build` succeed, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css
git commit -m "feat(#129): root comments render as standalone cards on a rail"
```

---

### Task 3: Full unit suite + manual visual check + re-capture parity baseline

**Files:**
- Update: `frontend/e2e/__screenshots__/win32/pr-detail-overview.png`

- [ ] **Step 1: Run the full frontend unit suite**

Run: `npx vitest run`
Expected: all green (no regressions elsewhere).

- [ ] **Step 2: Launch the app for a manual eyeball** (per project convention — never hand-roll `dotnet run`)

From repo root `D:/src/PRism-129-comment-cards`:
Run: `./run.ps1 -Reset None --no-browser`
Then open `http://localhost:5180`, navigate to a PR with root comments (real-mode PAT is configured; e.g. a `mindbody/Mindbody.BizApp.Bff` PR), open the **Overview** tab, and confirm in **both** light and dark (theme toggle): cards read as standalone, the rail is continuous and bridges gaps, the node sits on the band, a long author truncates, long code wraps. **This manual eyeball is the real check for the band's `--text-3` timestamp contrast and the card elevation, since the automated a11y/parity fixtures render comment-less or fixed content.** Note (so it is not mistaken for a bug): in **light** mode the card (`--surface-1`, L≈0.99) is slightly *lighter* than the page (`--surface-0`, L≈0.96) — the border + band do the separating, and `--shadow-2` is intentionally faint here; in **dark** the shadow carries the lift. Confirm this reads acceptably; if not, the card surface/shadow may need a token tweak (do not silently revert the approach).

- [ ] **Step 3: STOP the manually-launched app before the parity recapture**

Stop the `run.ps1` app from Step 2 (Ctrl-C in its terminal). This is required: Playwright's `webServer` uses `reuseExistingServer` locally and would otherwise attach to the still-running real-mode (Development/real-PAT) server on port 5180 instead of booting its own `Test`-mode backend that the parity fixture (`acme/api/123`) needs.

- [ ] **Step 4: Re-capture the parity baseline** (the conversation is inside `pr-detail-overview.png`; this change is intentional)

From `frontend/`:
Run: `npx playwright test e2e/parity-baselines.spec.ts -g "pr-detail-overview" --project=prod --update-snapshots`
Expected: the test re-writes `frontend/e2e/__screenshots__/win32/pr-detail-overview.png` and passes. (The Playwright `webServer` in `playwright.config.ts` starts the prod + Test-mode backend automatically.)

- [ ] **Step 5: Sanity-run the updated parity test without the update flag**

Run: `npx playwright test e2e/parity-baselines.spec.ts -g "pr-detail-overview" --project=prod`
Expected: PASS against the freshly captured baseline.

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e/__screenshots__/win32/pr-detail-overview.png
git commit -m "test(#129): re-capture pr-detail-overview parity baseline"
```

---

### Task 4: Accessibility (axe) — no-regression confirmation

The a11y-audit Overview fixture renders **zero** root comments (`a11y-audit.spec.ts` `rootComments: []`), so this run does **not** exercise the new card/band/rail. Its purpose is only to confirm the restructure introduces no regression on the comment-less Overview surface. The new band's `--text-3`-on-`--surface-2` timestamp contrast is established by the spec's monotonicity argument (> #124's measured 4.85:1) and eyeballed against real comments in Task 3 Step 2.

**Files:** none (verification only)

- [ ] **Step 1: Run the a11y audit**

From `frontend/`:
Run: `npx playwright test e2e/a11y-audit.spec.ts --project=prod`
Expected: PASS — no new serious/critical axe violations on the (comment-less) Overview route.

- [ ] **Step 2: No commit needed if green.** If axe regresses, STOP and re-evaluate before proceeding (do not silently weaken the assertion).

---

## Self-review

**Spec coverage:**
- AC1 standalone card → Task 2 (`.card` + band). ✓
- AC2 continuous rail → Task 2 (`.rail::before` gap-bridge + node). ✓
- AC3 easy to scan/separate → border + shadow + spacing (Task 2); visual confirm Task 3. ✓
- AC4 markdown renders + long code wraps → `<MarkdownRenderer>` preserved (Task 2) + global `.markdown-body pre` (no change needed); `min-width:0` in `.card`/`.body`. ✓
- Accessibility (contrast, aria-hidden rail, tab order) → structure in Task 2 + Task 4 no-regression + Task 3 manual. ✓
- Empty / single-comment edge cases → Task 2 (`comments.length > 0` guard + `:last-child` line hidden). ✓
- Parity baseline re-capture → Task 3. ✓
- Existing tests stay green → Tasks 1/2. ✓

**Placeholder scan:** none — every code step shows full code; every command shows expected output.

**Type/name consistency:** class names `timeline/item/rail/node/card/band/author/time/body` are defined in Task 2's CSS and consumed by the identical `styles.*` names in Task 2's JSX; `prRootConversation`, `prRootConversationFooter`, `prRootConversationActions*`, `prRootReplyButton` are preserved in both. `data-testid="pr-root-comment"` is unchanged and matched by Task 1's guard and the existing suite.

## ce-doc-review dispositions (coherence, feasibility, design-lens — 1 pass)

- **Applied** — merged the CSS and JSX into one task/commit, eliminating the intermediate broken/unstyled state (coherence).
- **Applied** — `.band { align-items: center }` instead of `baseline`: an `overflow:hidden` ellipsis author synthesizes its baseline from the margin box and would misalign the timestamp (design-lens).
- **Applied** — added an explicit "STOP run.ps1 before the parity recapture" step; `reuseExistingServer` would otherwise attach Playwright to the real-mode server on 5180 instead of the Test-mode backend the fixture needs (feasibility).
- **Applied** — reworded Task 4: the a11y fixture renders zero comments, so it is a no-regression check only; band contrast is covered by the spec's monotonicity argument + the Task 3 manual eyeball (feasibility).
- **Applied** — documented the rail/node `top` pixel constants as band-metric-dependent, tune at the visual gate (design-lens, fyi).
- **Skipped** — `white-space: pre-wrap` on `.body p`: carried verbatim from the current implementation; changing comment-prose wrapping is a behavior change out of scope for a visual restyle (commented in the CSS) (design-lens).
- **Rejected** — "`muted` is a bare JSX prop": misread; `muted` is inside the `className` template literal, matching the existing component (design-lens).

**Round 2 (user-requested):**
- **Applied** — `.rail { display: block }` added: defensive (grid items are blockified by spec, but explicit `display` guarantees the cell stretches to row height so the `::before` rail line + node anchor correctly) (design-lens, High; likely-false-positive but zero-cost insurance on a visual-critical element).
- **Applied** — Task 3 Step 2 manual-check note: in light mode the card is *lighter* than the page (`--surface-1` > `--surface-0`); border/band separate, `--shadow-2` faint — flagged so the visual-gate reviewer doesn't mistake it for a bug (design-lens, advisory).
- **Applied (spec)** — spec band description updated from "baseline-aligned" to "center-aligned (`align-items: center`)" to match the round-1 fix — removes spec/plan drift (coherence, High).
- Feasibility round 2: clean — all round-1 fixes verified against the worktree, no new findings.
