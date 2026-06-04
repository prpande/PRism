## Summary

Adds a single reusable accent-colored `Spinner` and adopts it at the data-fetch
screens named in #125 — the Inbox first-load and the PR-detail diff loading
states — replacing bare `Loading…` text.

The issue's "no rotating spinner exists" was slightly off: a one-off ring
(`.spinner` + `@keyframes discard-pending-spin`) already lived in
`DiscardPendingReviewConfirmationModal.module.css`. Rather than add a third
loading style, the shared `Spinner` **generalizes** that ring technique.

- `frontend/src/components/Spinner/` — `Spinner.tsx` + module CSS + `index.ts`.
  Color is declared on the ring via `--spinner-color` (default `var(--accent)`),
  so ambient text color (e.g. `.muted` → `--text-3` at the diff sites) cannot
  defeat the accent. `prefers-reduced-motion` swaps rotation for a gentle opacity
  pulse (not a frozen circle). `role="status"` + sr-only label keeps it announced.
- **Inbox** first-load shows `<Spinner size="lg">`; `aria-busy` dropped from
  `<main>` so the spinner's own live region announces (no nesting).
- **DiffPane** all three loading states use the spinner: file-fetch header,
  whole-file inline, and the whole-file overlay (keeps its distinct
  `Loading whole file…` label). Nested `role`/`aria-live` removed at each site;
  the header spinner is suppressed while the overlay spinner is active so only
  one live region announces.

Closes #125.

## Proof

### Classification
- **Tier T2** — one new component + module CSS wired into the Inbox + DiffPane; single coherent unit.
- **Risk B1 (UI-visual, gated)** — `design` label; alters rendered loading output. Pauses **after** green-and-ready for the human visual assert. No B2 risk surface touched (no auth/PAT, submit pipeline, migrations, cross-tab stamp, sidecar, host-header, or architectural invariant).

### Acceptance criteria
- [x] A single reusable accent-colored spinner exists — `frontend/src/components/Spinner/` + unit test `frontend/__tests__/Spinner.test.tsx`.
- [x] Inbox fetch shows the spinner instead of bare `Loading…` — `InboxPage.tsx`.
- [x] PR-detail / diff loading use the same spinner consistently — all three `DiffPane.tsx` loading states.
- [x] Color follows `--accent`; reduced-motion respected; loading stays announced (`role="status"` + non-empty sr-only name).

### Secrets scan
Clean — CSS modules + TSX + test specs + one spec `.md`; no token/key/secret-like patterns over the diff.

### a11y / WCAG 1.4.11 (non-text contrast, ≥3:1)
Accent ring vs the surfaces it renders on, computed oklch→relative-luminance:

| Pair | Ratio |
|------|-------|
| light `--accent` (L 0.55) vs `--surface-0` (L 0.96) | **4.28:1** ✅ |
| light `--accent` vs `--surface-1` (L 0.99) | **4.67:1** ✅ |
| dark `--accent` (L 0.72) vs dark `--surface-0` | **7.65:1** ✅ |

No new axe serious/critical expected (the spinner adds a `role="status"` live region with an sr-only name).

### Doc-review dispositions (1× ce-doc-review, headless — coherence, feasibility, design-lens, adversarial)
- **Applied** — removed nonexistent `cx()` helper → template-literal join (repo has no `clsx`).
- **Applied** — third DiffPane loading state (whole-file overlay) brought into scope (triple-flagged).
- **Applied** — ring color via `--spinner-color`/`--accent` so ambient `.muted` can't defeat the accent (adversarial #1).
- **Applied** — dropped `aria-busy` on Inbox `<main>` (nested-live-region silencing — design #3 / adversarial #6).
- **Applied** — reduced-motion = opacity pulse, not a silent static ring (design #4 / adversarial #2).
- **Applied** — WCAG 1.4.11 contrast verification + computed numbers (design #1).
- **Applied** — corrected the false "DiffPane specs assert `Loading…`" claim; those branches had **zero** coverage → added new DiffPane loading-branch tests (feasibility #2/#3).
- **Applied** — explicit removal phrasing in wiring (coherence #2).
- **Applied-adjusted** — test assertions use `within(getByRole('status')).getByText(/loading/i)` (content within the live region), **not** name-scoped `getByRole('status',{name})`: the `status` role names from author not content, so the adversarial #5 suggestion was technically wrong for this role; the content-within check still guards a dropped label.
- **Deferred (explicit scoping principle)** — adversarial #3/#4, design #2: full-screen/pane **fetch** states get the Spinner; in-button inline affordances (discard-modal one-off, `MarkAllReadButton`) and separate render boundaries (`MarkdownFileView`, Mermaid/Markdown Suspense fallbacks) keep their existing treatment this slice. The discard one-off folds in later for free via the `--spinner-color` seam. Reason: keep the B1 visual surface focused on the issue's named screens.

### Preflight adversarial review (pre-open) dispositions
- **Fixed (Important)** — `replace-token-same-login.spec.ts` asserted a bare `getByRole('status')` count; the new Inbox spinner is also `role="status"`, so it could race `/api/inbox` latency. Scoped the assertion to the toast copy (`/connected as/i`), matching the sibling different-login spec.
- **Fixed (Minor)** — DiffPane header + whole-file-overlay spinners are independent live regions that could both mount; the header spinner is now gated off while the overlay is active.
- **No action (Minor)** — dropped `aria-busy` on Inbox `<main>`: verified benign (no test/SR regression; the old `<main>` had no live region).

### Tests (authored test-first; non-bug enhancement)
- `Spinner.test.tsx` (red→green): status region, default + custom label, size class, layout className passthrough.
- New `DiffPane.test.tsx` loading-branch coverage (none existed): file-fetch header + whole-file overlay.
- `InboxPage.test.tsx` loading assertion migrated to the status region.
- Reduced-motion e2e in `a11y-audit.spec.ts` — passes on the **prod** project (asserts `animation-duration` 1.2s, hash-independent); **skipped on the vite-dev project**, which force-reloads on first-load dependency re-optimization and tears down the transient spinner (documented in the test). CI runs prod-only.

### Pre-push checklist (local)
`npm run lint` clean · `npm run build` clean · vitest **1126/1126** · `dotnet build` Release 0 errors/0 warnings · `dotnet test` green (the 2 `PortSelector` failures are environmental parallel-port contention — **510/510** in isolation) · reduced-motion e2e passes on prod.

### Visual (UI — B1)
Before/after screenshots (light + dark) follow as a PR comment after this number exists.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
