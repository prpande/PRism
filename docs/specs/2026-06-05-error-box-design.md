# Error-box treatment for unstyled error surfaces (#182)

**Issue:** [#182](https://github.com/prpande/PRism/issues/182) — Error messages render as unstyled white text instead of a design-system error box.
**Tier / Risk:** T2 · gated **B1 (UI-visual)** — `design` label; changes rendered error output a human must eyeball. No risk-surface touched (presentational CSS/TSX only).
**Worktree / branch:** `D:/src/PRism-182-error-box` · `fix/182-error-box`.

## Problem

Several error states render as bare default-foreground text (white in dark theme), jammed top-left with no box, border, icon, or color — they read as a rendering bug, not a handled error. Two of them reference CSS classes that **do not exist** in any stylesheet:

- `PrDetailView.tsx:313` — `<div role="alert" className="pr-detail-error">` — `.pr-detail-error` is never defined → bare-text fallback. **Main offender.**
- `PrDetailView.tsx:284` — `<div role="alert" className="reload-error-banner">` — `.reload-error-banner` is never defined → same.
- `App.tsx:45` — `<div role="alert">Failed to load auth state: …</div>` — no class.
- `ErrorBoundary.tsx:27` — bare `<div role="alert">`.
- `PrTabHost.tsx:66` — bare `<div role="alert">Invalid PR reference…</div>`.
- `InboxPage.tsx:42` — `<main role="alert">` error state, no styling.

**Root cause is the absence of a shared abstraction.** The design system already defines `--danger-soft` / `--danger-fg` tokens (light + dark, `tokens.css:113-115,187-189`) and a `.banner-danger` strip. The surfaces that *do* look right each independently re-roll a near-identical module `.error` rule (SetupForm, PasteUrlInput, FilesTab, DraftsTabError, DiscardPendingReview, DiscardAllStale). Consistency depends on every author copying the same CSS by hand — and six sites didn't. The fix removes that dependency.

## Decision: a reusable `<ErrorBox>` component

Introduce one component that owns the error-box structure, the `role="alert"` semantics, and an optional leading icon. Errors become consistent **by construction** rather than by convention.

**Rejected alternatives:**
- **Global CSS class** (`.error-box` sibling to `.banner`): smaller diff, but every site still hand-writes `role="alert"` + icon markup — the exact duplication that caused the drift survives.
- **Reuse `.banner` family**: `.banner` is a full-width top strip (`border-bottom` only, no rounding) — a page banner, not a contained box. The issue explicitly wants a bordered, rounded box; reusing `.banner` fights its semantics.

### Component API

`frontend/src/components/ErrorBox/ErrorBox.tsx`

```tsx
interface ErrorBoxProps {
  children: ReactNode;   // the message
  className?: string;     // extra classes — preserves existing test/style hooks
  icon?: boolean;         // default true; leading danger glyph
}
```

- Renders a **single element** carrying `role="alert"`, the merged `className` (`error-box-module-class` + any passed `className`), an inline `aria-hidden="true"` SVG danger glyph using `currentColor`, then the children.
- One element only — so a site that needs a test hook (e.g. `.pr-detail-error`) gets it on the same node that carries `role="alert"`, and there is never a doubled `role="alert"`.
- `icon` defaults to `true`; `icon={false}` suppresses the glyph for compact contexts. No size/variant props (YAGNI — one treatment).

### Styling

`ErrorBox.module.css`, reusing the canonical box shape already recurring across the codebase:

```css
.errorBox {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--danger-soft);
  color: var(--danger-fg);
  border: 1px solid color-mix(in oklab, var(--danger-fg) 35%, transparent);
  border-radius: var(--radius-2);
  font-size: var(--text-sm);
}
.icon { flex: 0 0 auto; }   /* SVG sized via width/height attrs; currentColor */
```

Light + dark are already covered by the `--danger-*` tokens. The **border tint** (`35%` mix) is **provisional** — confirmed / nudged against the real render at the B1 visual gate.

## Migration — the six bare sites

| Site | Change |
|------|--------|
| `PrDetailView.tsx:313` | `<ErrorBox className="pr-detail-error">Couldn't load PR …</ErrorBox>` — **keeps the `.pr-detail-error` test hook** |
| `PrDetailView.tsx:284` | `<ErrorBox className="reload-error-banner">…</ErrorBox>` — class kept for continuity |
| `App.tsx:45` | `<ErrorBox>Failed to load auth state: {error.message}</ErrorBox>` |
| `ErrorBoundary.tsx:27` | `<ErrorBox>…</ErrorBox>` (class component importing a function component is fine) |
| `PrTabHost.tsx:66` | `<ErrorBox>Invalid PR reference: the PR number must be a positive integer.</ErrorBox>` |
| `InboxPage.tsx:42` | `<main><ErrorBox>…</ErrorBox></main>` — `role="alert"` moves off `<main>` onto `ErrorBox` (no doubled role) |

## `role="alert"` audit — dispositions

The issue asks to "audit all `role="alert"` usages for consistency in the same pass." Full inventory and disposition:

| Site | Disposition | Reason |
|------|-------------|--------|
| `PrDetailView:313`, `:284`; `App:45`; `ErrorBoundary:27`; `PrTabHost:66`; `InboxPage:42` | **Migrate now** | The bug — bare/undefined-class text. |
| `SetupForm:87`, `PasteUrlInput:71` (`styles.error`) | **Defer-converge** | Already render correctly. Converging changes their look (PasteUrlInput is an inline `<span>`; SetupForm has bespoke `margin-top`) — visual risk on a working surface, out of scope for "fix the broken ones." Tracked in deferrals. |
| `FilesTab:487`, `DraftsTabError:9`, `DiscardPendingReview:56`, `DiscardAllStale:143` | **Leave** | Bespoke layouts (FilesTab composes with `.banner`; DraftsTabError is a centered min-height empty-state) — not box-shaped error messages; converging would distort intent. |
| `WholeFileFailureBanner:8`, `StaleCommitOidBanner:25`, `CrossTabPresenceBanner:41` | **Leave** | Deliberate full-width `.banner` strips (top-of-view), not contained boxes. |
| `PrRootReplyComposer:192`, `FilesTab:479` | **Leave** | Inline form/post-error affordances, not standalone error states. |

The audit requirement is satisfied by this documented disposition; only genuinely-broken surfaces are migrated. Convergence of the working duplicators onto `<ErrorBox>` is a follow-up (see deferrals).

## Testing

- **`ErrorBox.test.tsx`** (new): renders `role="alert"`; renders children text; merges a passed `className` onto the alert node; shows the icon by default and omits it with `icon={false}`.
- **`PrDetailView.freshness.test.tsx`**: existing assertion on `.pr-detail-error` (class + `role="alert"`) stays green via the preserved `className`. No change expected; re-run to confirm.
- **Parity baselines** (`parity-baselines.spec.ts`): the migrated sites are mostly error paths not exercised by the happy-path baseline zones; re-capture only if a baseline zone visibly moves. Verify during execution; re-capture the affected zone(s) if so.

## Accessibility

- `role="alert"` preserved on every migrated site (assertive live region — error announces on appearance).
- The icon is decorative (`aria-hidden="true"`); the message text is the accessible content.
- Contrast: `--danger-soft` / `--danger-fg` are the established danger pair already used across chips/banners; the B1 visual gate confirms the box (incl. border) reads correctly in both themes.

## Out of scope / deferrals

- Converging the working module-`.error` duplicators (SetupForm, PasteUrlInput, and any structurally-compatible others) onto `<ErrorBox>` — a consistency follow-up, no user-visible defect today.
- No token changes; no new danger tokens.

See `docs/specs/2026-06-05-error-box-deferrals.md`.
