# PR6 — Setup + Settings coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore visual parity between the Setup page and `design/handoff/screens.css` `.setup-*` family (centered card on accent radial-gradient wash, numbered-step pattern, required-permissions block, eye-toggle MaskedInput, fineprint footer), and polish the Settings page surfaces (card radius/shadow/type/spacing) so the maintainer's side-by-side view of `/settings` reads as a sibling of the restored PR Detail surface.

**Architecture:** CSS Modules colocated next to each component (`*.module.css`), composing against the existing `tokens.css` palette and `.btn` family. The Setup half has a direct handoff reference at `design/handoff/screens.css:1199-1295` distributed across the per-component modules: **SetupPage** maps `.setup-screen`/`.setup-bg`/`.setup-card` (1199-1224); **SetupForm** maps `.setup-brand`/`.setup-title`/`.setup-sub`/`.setup-section`/`.setup-section-head`/`.setup-num`/`.setup-link`/`.setup-scopes-label`/`.setup-scope-list`/`.setup-scope`/`.setup-error`/`.setup-continue` (1225-1288); **FirstRunDisclosure** maps `.setup-fineprint` (1289-1295); **MaskedInput** maps `.setup-input-wrap`/`.setup-eye` (1278-1279). The Settings half has NO handoff reference (S6 PR #71 replaced the handoff's floating tweaks panel with a real page per spec § 2.2); coherence target is **empirically verified** against PR3's `.overview-card` rule at `frontend/src/styles/tokens.css:506-511` (`var(--surface-1)` / `var(--border-1)` / `var(--radius-3)` / `var(--s-4) var(--s-5)` padding, **NO box-shadow**). No new tokens. No `tokens.css` lifts expected (every `.setup-*` rule is single-producer per the inventory in Task 1).

**Tech Stack:** React 19 + TypeScript + Vite. CSS Modules via Vite's built-in CSS Modules transformer. `frontend/vite.config.ts` does not set `css.modules.localsConvention`; project convention authors camelCase keys (verified against the existing 33 module files from PR2-PR5 — same pattern as PR3 D22 / PR4 D16 / PR5 D50 confirmations). Module classes accessed via `styles.screen` etc. Literal-class-and-module pattern from PR2 D16 / PR4 D34: JSX retains zero literal kebab classes for new `.setup-*` modules (Setup has no handoff-derived global tokens that need parallel literal classes since `.setup-*` is single-producer); existing `.btn` / `.btn-primary` / `.btn-icon` literal globals stay on buttons (composed alongside module classes).

**Plan deviations table (D58 onwards, log to `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` as Task 12):**

| ID  | Deviation                                                                                                                                                                                                                       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D58 | `ScopePill.module.css` deferred (spec § 4.6 mandate vs. production reality)                                                                                                                                                     | `ScopePill.tsx` has ZERO production consumers (verified via Grep over `frontend/src` — only its own definition matches). Creating a module CSS file for an unrendered component is a speculative anchor — same trap PR4 D26 explicitly rejected for `.composer-save` / `.commentThreadReply` / `.iterationNewDot`. PR9 catalog determines whether ScopePill stays as dead code or gets deleted; if it gets a consumer in PR9 the module CSS lands then. NOT creating `frontend/src/components/Setup/ScopePill.module.css` in PR6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D59 | No per-section module CSS files (`AppearanceSection.module.css` etc.)                                                                                                                                                           | Spec § 4.6 says "polish to `SettingsSections.module.css`, plus any new module CSS the section components need". The 4 section components (Appearance / InboxSections / Connection / Auth) all compose `SettingsSections.module.css` cleanly with no per-section styling divergence. Splitting into per-component modules would be YAGNI — same precedent as PR3 keeping shared `tokens.css` globals for `.chip-*` until the second-consumer trigger fires. SettingsSections.module.css stays as the single shared module for all 4 sections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D60 | Settings half acceptance is **subjective** (no handoff reference) but bound by falsifiable token targets                                                                                                                        | Spec § 4.6 explicitly: "The Settings half of PR6 is the only PR with subjective 'feels right' review criteria; the maintainer's side-by-side judgment is the gate." Coherence with PR3 Overview cards is the gate, and the token values are **empirically verified against `frontend/src/styles/tokens.css:506-511`**: `.overview-card { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-3); padding: var(--s-4) var(--s-5); }` — **NO box-shadow**. Settings sections therefore land at: `var(--surface-1)` background, `var(--border-1)` border, `var(--radius-3)` (8px) radius — UNCHANGED from current 8px hard-code, just tokenized, `var(--s-5)` padding, `var(--text-lg)` h2. **No `box-shadow` added** — PR3 Overview cards have none, so adding one breaks the coherence claim. If post-merge regret surfaces a token-level mismatch, the diff to revert is explicit. Maintainer signs off on the `settings-page.png` parity baseline as the canonical "this is what coherence looks like." Higher review noise expected. |
| D61 | SetupPage JSX gains a 3-element wrapper structure (`.screen` > `.bg` + `.card` > children)                                                                                                                                      | Currently `SetupPage.tsx` returns `<><SetupForm /><NoReposWarningModal/></>` with zero outer wrapper. The centered-card-on-radial-gradient layout REQUIRES a positioned outer wrapper (`.screen` for flex centering + scroll), an absolutely-positioned background layer (`.bg` for the radial gradient), and a relatively-positioned card host (`.card` for the form's chrome). This is structural CSS layering — adds DOM nodes but ZERO behavior change. Inside spec § 2.2's "no component-logic changes" rule per PR2-PR5 precedent (PR3 added `<span>Loading…</span>` for WCAG; PR4 added `.diff-line` BEM wrappers; both were structural CSS changes).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D62 | SetupForm.module.css `.form` drops `padding` / `background` / `border` / `border-radius` (currently lines 5-9)                                                                                                                  | The handoff `.setup-card` owns the surface treatment (background + border + radius + padding + shadow at lines 1215-1224 of `screens.css`). Moving that responsibility to `SetupPage.module.css .card` means `SetupForm.module.css .form` becomes a pure flex column with gap (single-responsibility). Adds one DOM nesting level but the existing tests assert via `getByRole/getByText` only — no class assertions to migrate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D63 | `<strong>1.</strong>` / `<strong>2.</strong>` markup replaced with `<span className={styles.num}>1</span>` inside a numbered-step section header. **Step 1 wraps the link inside the heading; ordinal stays in the a11y tree.** | Handoff `.setup-num` is a 20×20 circle with accent-soft background and accent text color (line 1249) — cannot be styled on inline `<strong>` text alone. **Critical test constraint:** `setup-page.test.tsx:78` asserts `findByRole('link', { name: /generate a token/i })` — the link text MUST remain "Generate a token". Resolution: Step 1's heading is `<h2 className={styles.sectionHead}><span className={styles.num}>1</span> <a href={patPageUrl} className={styles.link}>Generate a token</a></h2>` (the link IS the labeled portion of the heading). Step 2's heading is `<h2 className={styles.sectionHead}><span className={styles.num}>2</span> Paste it below</h2>` (no link to host). **Ordinal in a11y tree:** the numbered `<span>` is NOT `aria-hidden` — SR users hear "1 Generate a token" / "2 Paste it below" preserving step-ordinality wayfinding. Visible glyph "1"/"2" reads naturally as the cardinal number. (Reviewer-driven correction — original plan had `aria-hidden="true"` which stripped wayfinding from SR.)                              |
| D64 | `<h1>Connect to GitHub</h1>` and the subtitle paragraph wrap into `<div className={styles.brand}><h1 className={styles.title}>…</h1><p className={styles.sub}>…</p></div>`                                                      | Handoff `.setup-brand` (1225), `.setup-title` (1226), `.setup-sub` (1232) form a 3-element block at the top of the card. Each maps to one module class. **NOT `<header>`** — preflight adversarial review caught that `<header>` inside `<form>` maps to `role=banner` per the HTML AAM (the exclusion list is article/aside/main/nav/section — `<form>` is NOT in it), which would duplicate the App-level `<Header />` banner landmark. `<div>` preserves the visual grouping without the landmark duplication. No behavior change; no test asserts `<h1>` is a direct child of `<form>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D65 | MaskedInput's inline `style={{ position: 'relative' }}` and inline eye `<button>` get hoisted into a `.wrap` + `.eye` module                                                                                                    | Replaces the runtime style prop with a CSS rule. **Eye-button sizing**: handoff line 1277 defines `.btn-icon-sm { width: 18px; height: 18px; }` IMMEDIATELY before `.setup-eye` (1279) — implying the intended composition was `.btn-icon .btn-icon-sm`. But `.btn-icon-sm` is **not** in `frontend/src/styles/tokens.css` (verified — only `.btn-icon` 30×30 exists). Lift-on-second-use says don't lift speculatively, so `.eye` carries a **local size override** (`width: 18px; height: 18px;`) alongside its position rules, sized to fit inside the 36px-tall input without overflow. Handoff line 1279 position (`top: 8px; right: 8px`) preserved. (Reviewer-driven correction — original plan composed `.btn-icon` 30×30 which would have overflowed the input.)                                                                                                                                                                                                                                                                                                       |
| D66 | Eye-toggle glyph swaps to `{shown ? '🙈' : '👁'}` (visible-state feedback)                                                                                                                                                      | Current MaskedInput.tsx has `{shown ? '👁' : '👁'}` — both branches identical (copy-paste defect). **Reviewer-driven correction**: original plan kept single `👁` and deferred the variant to PR9, but that means PR6's `setup-card.png` baseline locks in same-glyph-both-states behavior; fixing it in PR9 would require a baseline re-capture. PR6 ships `{shown ? '🙈' : '👁'}` (see-no-evil monkey ↔ eye — widely-supported emoji pair) so the baseline captures the visible-toggle feedback from the start. aria-label still announces "Show token"/"Hide token" for AT. No icon library dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D67 | No `.setup-*` rules lifted to `tokens.css` in PR6                                                                                                                                                                               | Inventory (per D58-D59 scope reductions, ScopePill is deferred) confirmed every `.setup-*` handoff rule **ported in PR6** has exactly ONE production consumer (SetupPage owns `.screen`/`.bg`/`.card`; SetupForm owns `.brand`/`.title`/`.sub`/`.section`/`.sectionHead`/`.num`/`.link`/`.permissions`/`.permissionRow`/`.permissionsNote`/`.footnote`/`.error`/`.continue`/`.cancel`/`.cancelDisabled`; FirstRunDisclosure owns `.fineprint`; MaskedInput owns `.wrap`/`.eye`). Lift-on-second-use is the documented trigger per PR3 D22 / PR4 D34 / PR5 D47 — no second consumer exists in PR6 scope. If PR9 catalogs ScopePill back into a real consumer or adds another Setup-style surface, the lift happens then.                                                                                                                                                                                                                                                                                                                                                         |
| D70 | `.fineprint` lock icon deferred to PR9 a11y polish                                                                                                                                                                              | Spec § 4.6 calls for "fineprint with lock icon" but the handoff doesn't ship a glyph source (no SVG token, no icon-library import). Adding a lock icon requires a design call about source: emoji `🔒` (cross-platform-inconsistent rendering), SVG inlined into the JSX (visual fidelity but more code), or an icon library (new dependency). Spec § 2.2 ("no redesign, handoff is the visual spec") doesn't speak to icon sources for new PRism-only elements. **Decision:** ship `.fineprint` typography (margin / font-size / color) without a glyph in PR6; PR9 polish picks the glyph source and re-captures the `setup-card.png` baseline. The handoff `.setup-fineprint` flex+gap+center rules **intentionally NOT ported** to `.fineprint` because the disclosure widget is a `<details>` block, not a flex row — the flex rules don't apply meaningfully to multi-line collapsible content. If PR9 adds a `<span aria-hidden="true">🔒</span>` prefix to the `<summary>`, the flex+gap+center rules land then.                                                        |
| D69 | SINGLE-PR6 vs SPLIT decision at Task 8.5                                                                                                                                                                                        | **Measured:** 344 LOC net (265 inserts + 79 deletes) across 11 files in 4 directories, 7 review-meaningful changes (Tasks 2 + 3 + 4 + 5 + 6 + 7 + 8). Both metrics below LOC>700 / changes>18 thresholds. **SINGLE-PR6 selected.** Override-tripwire NOT applied — same-maintainer / same-review-window precedent from PR2-PR5 (PR4 shipped at 1120 LOC / 15 changes as single, PR5 at 311 LOC / 9 changes; PR6 at 344 LOC / 7 changes is well within the empirical SINGLE band). Subjective-Settings concern (D60) bound by falsifiable token targets per the post-ce-doc-review correction; reviewer can litigate exact tokens against tokens.css:506-511 rather than vibes.                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## Sequencing notes

**Subagent-driven-development ordering rule:** Tasks MUST run in numerical order. Each task's output feeds the next; Task 8.5's split-checkpoint depends on Tasks 3-8 being committed; Tasks 9-10's parity-baseline captures depend on Tasks 2-8 being committed. **Do NOT dispatch tasks in parallel.** If the orchestrator batches (per PR3-PR5 precedent — Tasks 4+5+6 may share an implementer), the batch internal order still follows the numbered sequence.

- **Tasks 1-2 are pre-flight.** Task 1 is the grep/wc/Read sweep that confirms the inventory used to write this plan (read-only, no commit); Task 2 adds the two `data-testid` attributes so the parity baseline locators have something to wait on.
- **Tasks 3-8 are the per-component module ports**, ordered Setup-first then Settings-second (matches the spec § 4.6 ordering and lets the Setup half settle before tackling the subjective Settings half).
- **Task 8.5 is the split-checkpoint.** Measures cumulative LOC + review-meaningful changes after Setup + Settings are both ported, decides SINGLE-PR6 vs SPLIT. Runs AFTER Task 8, BEFORE Tasks 9-10. Appends D69 decision-record to the deferrals sidecar exactly once.
- **Tasks 9-10 are the parity-baseline captures.** Setup capture is at `/setup` (no auth state needed — `authState === null` triggers `<LoadingScreen />` so the helper must wait for the form, but the route is reachable without `setupAndOpenScenarioPr`). Settings capture goes through `setupAndOpenScenarioPr` to materialize auth + preferences.
- **Tasks 11-13 are the closure trifecta.** Append D58-D67 (+ D70, + any D68/D69 added during execution) to deferrals sidecar, pre-push checklist, final review.

**Viewport stance:** PR6 is desktop-only per PoC convention. Parity-baselines.spec.ts uses the `{ width: 1440, height: 900 }` VIEWPORT constant for all captures. `.card` has `width: 480px; max-width: 100%` — collapses on narrower viewports but no explicit narrow-viewport test gate is added. PR9 polish can add a min-width or a narrow-viewport spec if scope ever broadens.

---

## Task 1: Pre-flight catalog

**Files:**

- Read-only: `frontend/src/pages/SetupPage.tsx`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/components/Setup/SetupForm.tsx`, `frontend/src/components/Setup/FirstRunDisclosure.tsx`, `frontend/src/components/Setup/MaskedInput.tsx`, `frontend/src/components/Setup/ScopePill.tsx`, `frontend/src/components/Setup/SetupForm.module.css`, `frontend/src/components/Settings/AppearanceSection.tsx`, `frontend/src/components/Settings/AuthSection.tsx`, `frontend/src/components/Settings/ConnectionSection.tsx`, `frontend/src/components/Settings/InboxSectionsSection.tsx`, `frontend/src/components/Settings/SettingsSections.module.css`, `frontend/src/pages/SettingsPage.module.css`, `design/handoff/screens.css:1199-1295`

- [ ] **Step 1: Grep ScopePill consumers**

  Run: `Grep pattern="ScopePill" path="frontend/src" output_mode="files_with_matches"`

  Expected: 1 file (`frontend/src/components/Setup/ScopePill.tsx` only). If 2+ files match, D58 is invalid and `ScopePill.module.css` should be created in PR6 — flag back to the orchestrator.

- [ ] **Step 2: Grep `data-testid` on Setup/Settings entry points**

  Run two greps:
  - `Grep pattern="data-testid" path="frontend/src/pages/SetupPage.tsx" output_mode="content"`
  - `Grep pattern="data-testid" path="frontend/src/pages/SettingsPage.tsx" output_mode="content"`

  Expected: no matches in either file. If matches exist on `setup-card` or `settings-page`, Task 2 collapses to a no-op and the implementer reports the unexpected finding.

- [ ] **Step 3: Grep class-based selectors in Setup/Settings test files**

  Run: `Grep pattern="className|querySelector|\.setup-|\.settings-" path="frontend/__tests__" output_mode="content" -i=true`

  Expected: zero matches inside `setup-form.test.tsx`, `setup-page.test.tsx`, `Setup/FirstRunDisclosure.test.tsx`, `Settings/SettingsPage.test.tsx`. (Other component tests like `DraftsTab.test.tsx` matching `discard-all-preview-list` are unrelated and out of scope.) If any Setup/Settings test asserts a class string, surface it to the orchestrator for inclusion in Task 2.

- [ ] **Step 4: Verify tokens already global**

  Run: `Grep pattern="\.btn|\.chip-accent|--accent-soft|--shadow-3|--text-2xl|--text-xs|--text-sm|--text-lg|--radius-2|--radius-3|--radius-4" path="frontend/src/styles/tokens.css" output_mode="files_with_matches"`

  Expected: 1 file matched (tokens.css itself). Confirms no token additions needed for PR6 — the post-S6 token vocabulary `--text-{xs,sm,base,lg,xl,2xl}` is in place and `--radius-3` (used by `.overview-card` per the empirically-verified PR3 reference) is in tokens.css line 39. **Note:** `.btn-icon-sm` (handoff line 1277) is NOT in tokens.css — that gap is handled locally by MaskedInput's `.eye` size override per D65, not a global lift.

- [ ] **Step 5: Inventory LOC of files about to change**

  Run: `wc -l frontend/src/pages/SetupPage.tsx frontend/src/pages/SettingsPage.tsx frontend/src/pages/SettingsPage.module.css frontend/src/components/Settings/SettingsSections.module.css frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css frontend/src/components/Setup/FirstRunDisclosure.tsx frontend/src/components/Setup/MaskedInput.tsx`

  Expected output approximately:

  ```
  SetupPage.tsx              175
  SettingsPage.tsx            17
  SettingsPage.module.css     12
  SettingsSections.module.css 52
  SetupForm.tsx              112
  SetupForm.module.css        68
  FirstRunDisclosure.tsx      47
  MaskedInput.tsx             32
  Σ                          515
  ```

  Treat this baseline as the input to Task 8.5's split-checkpoint LOC measurement.

- [ ] **Step 6: Report**

  Return a structured summary:
  - ScopePill consumer count: N
  - SetupPage / SettingsPage existing data-testid: yes/no
  - Test files with class selectors: list (expected empty)
  - tokens.css coverage: yes (all 9 token references already global)
  - LOC inventory: as above

  No commit. This is a discovery task only.

---

## Task 2: Add `data-testid` to SetupPage and SettingsPage

**Files:**

- Modify: `frontend/src/pages/SetupPage.tsx`
- Modify: `frontend/src/pages/SettingsPage.tsx`

**Why first:** The parity baseline tests in `frontend/e2e/parity-baselines.spec.ts` (lines 105-127) already reference `[data-testid="setup-card"]` and `[data-testid="settings-page"]` as the locator targets. They are currently marked `test.fixme()` because the testids don't exist in production. Adding the testids here unblocks Tasks 9-10 (baseline capture) without coupling the testid addition to the larger restructure.

**Note on `setup-card` placement:** The handoff `.setup-card` is the card element _inside_ the screen wrapper (handoff line 1215). PR6's SetupPage restructure (Task 3) creates the card wrapper in `SetupPage.tsx`. For now, in this task, add the testid to a single new wrapper `<div>` in SetupPage. Task 3 replaces this stub wrapper with the full module-CSS card; the testid moves with it. (Doing it this way means parity-baselines.spec.ts is unblocked at Task 2; the testid lives on a bare div until Task 3 wraps it in the module-CSS card chrome.)

- [ ] **Step 1: Modify `SetupPage.tsx`**

  Replace lines 161-174 (the `return (...)` block) with:

  ```tsx
  if (authState === null) return <LoadingScreen />;

  return (
    <>
      <div data-testid="setup-card">
        <SetupForm
          host={authState.host}
          onSubmit={isReplaceMode ? onReplace : onConnect}
          error={error}
          busy={busy}
          isReplaceMode={isReplaceMode}
        />
      </div>
      {showWarning && (
        <NoReposWarningModal
          onContinue={onContinueAnyway}
          onEdit={onEdit}
          busy={busy}
        />
      )}
    </>
  );
  ```

  Only change: wrap `<SetupForm />` in `<div data-testid="setup-card">`. NoReposWarningModal stays a sibling (it's a portal-rendered modal, not card content).

- [ ] **Step 2: Modify `SettingsPage.tsx`**

  Change line 9 from:

  ```tsx
  <main className={styles.page}>
  ```

  to:

  ```tsx
  <main className={styles.page} data-testid="settings-page">
  ```

- [ ] **Step 3: Run targeted test suite to confirm no regression**

  Run: `cd frontend && npx vitest run __tests__/setup-page.test.tsx __tests__/setup-form.test.tsx __tests__/Settings/SettingsPage.test.tsx __tests__/Setup/FirstRunDisclosure.test.tsx --reporter=verbose`

  Expected: all four test files PASS. The data-testid wrapper does NOT break `getByRole/getByText` assertions.

- [ ] **Step 4: Run Prettier write on the two modified files**

  Run: `cd frontend && npx prettier --write src/pages/SetupPage.tsx src/pages/SettingsPage.tsx`

  Then run `npx prettier --check src/pages/SetupPage.tsx src/pages/SettingsPage.tsx` and confirm no further diff. CLAUDE.md memory `feedback_prettier_check_in_ci.md` requires this BEFORE staging.

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/pages/SetupPage.tsx frontend/src/pages/SettingsPage.tsx
  git commit -m "feat(design-parity): add data-testid to SetupPage card wrapper and SettingsPage main (PR6 Task 2)"
  ```

---

## Task 3: SetupPage.module.css — centered card on accent radial-gradient wash

**Files:**

- Create: `frontend/src/pages/SetupPage.module.css`
- Modify: `frontend/src/pages/SetupPage.tsx` (replaces the Task 2 stub wrapper with the full module-CSS structure)

**Maps to handoff:**

- `.setup-screen` (handoff 1199-1207) → `.screen`
- `.setup-bg` (handoff 1208-1214) → `.bg`
- `.setup-card` (handoff 1215-1224) → `.card`

- [ ] **Step 1: Create `frontend/src/pages/SetupPage.module.css`**

  ```css
  .screen {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: var(--s-6);
  }
  .bg {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(
        circle at 20% 0%,
        color-mix(in oklch, var(--accent) 8%, transparent),
        transparent 40%
      ),
      radial-gradient(
        circle at 90% 100%,
        color-mix(in oklch, var(--accent) 6%, transparent),
        transparent 40%
      );
    pointer-events: none;
  }
  .card {
    position: relative;
    width: 480px;
    max-width: 100%;
    background: var(--surface-1);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-4);
    padding: var(--s-8);
    box-shadow: var(--shadow-3);
  }
  ```

  Identical to handoff lines 1199-1224 with the only changes being class names (kebab → camelCase per project convention) and prefix stripping (`setup-screen` → `screen`, etc., since the module scope already namespaces them).

- [ ] **Step 2: Modify `SetupPage.tsx` — wire the module**

  Add the import after line 8 (after `LoadingScreen` import):

  ```tsx
  import styles from "./SetupPage.module.css";
  ```

  Replace the Task 2 wrapper block (lines 161-174 after Task 2's edit) with:

  ```tsx
  if (authState === null) return <LoadingScreen />;

  return (
    <>
      <div className={styles.screen}>
        <div className={styles.bg} aria-hidden="true" />
        <div className={styles.card} data-testid="setup-card">
          <SetupForm
            host={authState.host}
            onSubmit={isReplaceMode ? onReplace : onConnect}
            error={error}
            busy={busy}
            isReplaceMode={isReplaceMode}
          />
        </div>
      </div>
      {showWarning && (
        <NoReposWarningModal
          onContinue={onContinueAnyway}
          onEdit={onEdit}
          busy={busy}
        />
      )}
    </>
  );
  ```

  Three structural elements: `<div className={styles.screen}>` (flex-center scroll container), `<div className={styles.bg} aria-hidden="true" />` (positioned absolute behind the card; aria-hidden because it's decorative), `<div className={styles.card} data-testid="setup-card">` (the actual card host — testid moves here from the Task 2 stub).

- [ ] **Step 3: Run vitest on Setup-touched files**

  Run: `cd frontend && npx vitest run __tests__/setup-page.test.tsx __tests__/setup-form.test.tsx --reporter=verbose`

  Expected: all tests PASS. The 3-level wrapper does NOT affect `getByRole/getByLabelText` queries.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/pages/SetupPage.tsx src/pages/SetupPage.module.css`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/pages/SetupPage.tsx frontend/src/pages/SetupPage.module.css
  git commit -m "feat(design-parity): SetupPage module CSS — centered card on accent radial-gradient wash (PR6 Task 3)"
  ```

---

## Task 4: Polish SetupForm.module.css — numbered-step pattern + handoff brand/header

**Files:**

- Modify: `frontend/src/components/Setup/SetupForm.module.css`
- Modify: `frontend/src/components/Setup/SetupForm.tsx`

**New ports (handoff → module class):**

- `.setup-brand` (1225) → `.brand`
- `.setup-title` (1226-1231) → `.title`
- `.setup-sub` (1232-1237) → `.sub`
- `.setup-section` (1238-1242, including `:first-of-type` reset) → `.section`
- `.setup-section-head` (1243-1248) → `.sectionHead`
- `.setup-num` (1249-1256) → `.num`
- `.setup-link` (1257-1261) → `.link`
- `.setup-error` (1280-1287) → `.error` (replacing the existing token-thin rule)
- `.setup-continue` (1288) → `.continue` (composes `btn btn-primary` from globals; module adds the width:100% + margin-top)

**Refreshed (existing rules updated to handoff tokens, no new mapping):**
`.permissions`, `.permissionRow`, `.permissionsNote`, `.footnote`, `.cancel`, `.cancelDisabled` (existing token-equivalent updates only). The `.form` class drops its card-chrome per D62. **`.cancel` keeps `align-self: flex-start`** (matches current production behavior; the handoff has no `.cancel` rule to align against — original plan's `align-self: center` was an unjustified design call and is reverted).

- [ ] **Step 1: Rewrite `SetupForm.module.css`**

  Full replacement (current 68 LOC → new ~115 LOC). Use Write tool:

  ```css
  .form {
    display: flex;
    flex-direction: column;
  }
  .brand {
    margin-bottom: var(--s-5);
  }
  .title {
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 var(--s-2);
  }
  .sub {
    margin: 0 0 var(--s-6);
    color: var(--text-2);
    font-size: var(--text-sm);
    line-height: 1.55;
  }
  .section {
    padding: var(--s-4) 0;
    border-top: 1px solid var(--border-1);
  }
  .section:first-of-type {
    border-top: 0;
    padding-top: 0;
  }
  .sectionHead {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--text-sm);
    font-weight: 600;
    /* Zero all margins rather than only set bottom — avoids browser default
       h2 top-margin bleeding through. Handoff's .setup-section-head uses
       margin-bottom only, but the resulting top-margin under default h2
       browser styles introduces 1em of unwanted gap. */
    margin: 0 0 var(--s-3);
  }
  .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 50%;
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    margin-bottom: var(--s-3);
  }
  .permissions {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--s-4);
    row-gap: var(--s-2);
    margin: var(--s-3) 0;
    font-size: var(--text-sm);
  }
  .permissionRow {
    display: contents;
  }
  .permissionRow > dt {
    font-weight: 500;
  }
  .permissionRow > dd {
    margin: 0;
    color: var(--text-1);
  }
  .permissionsNote {
    margin: var(--s-2) 0;
    font-size: var(--text-xs);
    color: var(--text-2);
  }
  .footnote {
    margin-top: var(--s-2);
    font-size: var(--text-xs);
    color: var(--text-2);
  }
  .footnote code {
    background: var(--surface-2);
    padding: 0 4px;
    border-radius: var(--radius-2);
    font-size: var(--text-sm);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--s-2);
    padding: 6px 10px;
    background: var(--danger-soft);
    color: var(--danger-fg);
    border-radius: var(--radius-2);
    font-size: var(--text-xs);
  }
  .continue {
    width: 100%;
    margin-top: var(--s-5);
  }
  .cancel {
    margin-top: var(--s-2);
    align-self: flex-start;
    font-size: var(--text-sm);
    color: var(--text-2);
  }
  .cancelDisabled {
    opacity: 0.5;
    cursor: not-allowed;
    text-decoration: none;
  }
  ```

  Changes vs. existing `SetupForm.module.css`:
  - `.form` drops `gap`, `max-width`, `padding`, `background`, `border`, `border-radius` (Task 3's `.card` owns them); keeps only `flex-direction: column`. Vertical rhythm now comes from `.section` and `.brand` margins.
  - Adds `.brand`, `.title`, `.sub` for the header (D64).
  - Adds `.section`, `.sectionHead`, `.num`, `.link` for the numbered-step pattern (D63).
  - `.permissions` switches `font-size: 0.95em` → `var(--text-sm)` for token consistency.
  - `.permissionsNote` and `.footnote` switch `0.85em` → `var(--text-xs)`. **Note**: on a ~14px base, `0.85em` ≈ 11.9px and `var(--text-xs)` is 12px — sub-pixel difference, intentional token-grid normalization.
  - `.footnote code` uses `var(--surface-2)` and `var(--radius-2)` instead of inline rgba and `3px`.
  - `.error` ports the handoff flex+gap+icon pattern (currently the existing `.error` is just a padded color block).
  - `.continue` keeps the existing class (no `.btn-primary` token override — composes globals per § 4.6 spec ordering).
  - **`.cancel` keeps `align-self: flex-start`** matching the existing production state — the handoff has no `.cancel` rule, so no centering justification exists.
  - Drops `.scopes` (line 11 of old file — `display: flex; gap: var(--s-2)`) — it was unused (verified by grep: only this file references it).
  - **`.section:first-of-type` reset note**: the rule fires correctly here because the first `<section className={styles.section}>` IS the first `<section>` element under `<form>` (preceded only by `<div className={styles.brand}>` and followed by `<FirstRunDisclosure />` which renders `<details>`, neither of which is a `<section>` type). Implementer must visually confirm the first section has NO top border and NO top padding when reviewing the `setup-card.png` baseline in Task 9.

- [ ] **Step 2: Modify `SetupForm.tsx` — restructure JSX for numbered-step + brand header**

  Replace the entire `return (...)` block (current lines 37-111) with:

  ```tsx
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      {/* <div> not <header> — App's <Header /> already exposes a banner;
            <header> inside <form> is NOT excluded from the banner-role
            mapping (HTML AAM exclusion list is article/aside/main/nav/section). */}
      <div className={styles.brand}>
        <h1 className={styles.title}>Connect to GitHub</h1>
        <p className={styles.sub}>
          PRism is local-first. Your token never leaves this machine.
        </p>
      </div>
      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>1</span>
          <a
            href={patPageUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.link}
          >
            Generate a token
          </a>
        </h2>
        <dl className={styles.permissions}>
          {PERMISSIONS.map((p) => (
            <div key={p.name} className={styles.permissionRow}>
              <dt>{p.name}</dt>
              <dd>{p.level}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.permissionsNote}>
          Metadata: Read is auto-included by GitHub. For Repository access,
          choose
          <em> All repositories</em> or <em>Select repositories</em>.
        </p>
        <p className={styles.footnote}>
          Already have a classic PAT? It needs the <code>repo</code>,{" "}
          <code>read:user</code>, and <code>read:org</code> scopes.
        </p>
      </section>
      <FirstRunDisclosure />
      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>2</span>
          Paste it below
        </h2>
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder="ghp_… or github_pat_…"
          ariaLabel="Personal access token"
        />
      </section>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      <button
        type="submit"
        className={`${styles.continue} btn btn-primary`}
        disabled={pat.trim().length === 0 || busy}
      >
        {busy ? "Validating…" : "Continue"}
      </button>
      {isReplaceMode &&
        (busy ? (
          <span
            role="link"
            aria-disabled="true"
            className={`${styles.cancel} ${styles.cancelDisabled}`}
          >
            Cancel
          </span>
        ) : (
          <Link to="/settings" className={styles.cancel}>
            Cancel
          </Link>
        ))}
    </form>
  );
  ```

  Changes:
  - **Brand block** (D64): `<h1>` and the local-first `<p>` wrap into a `<div className={styles.brand}>` block (NOT `<header>` — would duplicate the App-level banner landmark per the HTML AAM exclusion list). The `<h1>` gets `className={styles.title}`; the `<p>` gets `className={styles.sub}`.
  - **Step 1 section** (D63): Replaces `<div><strong>1.</strong> <a>Generate a token</a><dl>...</dl><p>...</p><p>...</p></div>` with `<section className={styles.section}><h2 className={styles.sectionHead}><span className={styles.num}>1</span> <a className={styles.link}>Generate a token</a></h2>...</section>`. **The `<a>` link is NESTED INSIDE the h2**, so the heading itself IS the linked step label. This preserves `setup-page.test.tsx:78`'s `findByRole('link', { name: /generate a token/i })` assertion — accessible name of the `<a>` is still "Generate a token" — AND lets the numbered badge sit immediately before the link inside the heading row.
    - **Ordinal in a11y tree** (D63): NO `aria-hidden` on the `<span className={styles.num}>` — SR users hear the visible "1" as the cardinal number, preserving "Step 1 / Step 2" wayfinding. The number is read AS PART OF the heading: SR announces "Heading level 2: 1, link Generate a token" for step 1, "Heading level 2: 2, Paste it below" for step 2.
  - **Step 2 section** (D63): Mirrors step 1 structurally but no link to host — `<h2 className={styles.sectionHead}><span className={styles.num}>2</span> Paste it below</h2>`.
  - **Continue button**: Now `className={`${styles.continue} btn btn-primary`}` to compose the `.btn .btn-primary` globals with the local width:100% + margin-top.
  - **Cancel link**: Unchanged structurally; tests still pass because `getByRole('link', { name: /cancel/i })` matches both `<Link>` and the `<span role="link">`.
  - **NoReposWarningModal** stays handled in SetupPage (sibling-of-card portal); no change.

- [ ] **Step 3: Run vitest on Setup**

  Run: `cd frontend && npx vitest run __tests__/setup-page.test.tsx __tests__/setup-form.test.tsx --reporter=verbose`

  Expected: all tests PASS. Specifically:
  - `setup-page.test.tsx:78`'s `findByRole('link', { name: /generate a token/i })` STILL matches the `<a>` because the link text is preserved (the link is nested inside `<h2>`, but `getByRole('link', ...)` matches by accessible-name regardless of position).
  - `setup-form.test.tsx`'s `getByText(/Already have a classic PAT/i)` still matches — the text node is inside a `<p className={styles.footnote}>` which lives inside the new `<section>`; `getByText` walks the whole tree.
  - `setup-form.test.tsx`'s `getByText('Pull requests')` etc. still match — the `<dt>` cells are inside the new `<section>` but text node match is structure-agnostic.
  - `setup-form.test.tsx`'s `getByRole('button', { name: /continue/i })` still matches — the Continue button kept its text label.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/components/Setup/SetupForm.tsx src/components/Setup/SetupForm.module.css`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css
  git commit -m "feat(design-parity): SetupForm — brand header + numbered-step sections + handoff token alignment (PR6 Task 4)"
  ```

---

## Task 5: FirstRunDisclosure.module.css — fineprint shell

**Files:**

- Create: `frontend/src/components/Setup/FirstRunDisclosure.module.css`
- Modify: `frontend/src/components/Setup/FirstRunDisclosure.tsx`

**Maps to handoff:**

- `.setup-fineprint` (1289-1295) → `.fineprint`
- Disclosure-specific wrapper styling: `.details` / `.summary` / `.section` / `.heading`

The handoff doesn't have a direct disclosure-element equivalent (it's a PRism-specific UX element added in S6). We're using the `.setup-fineprint` typography treatment (centered text-xs in text-3) as the outer wrapper visual, and adopting reasonable token-aligned styling for the disclosure-internal `<section>` blocks. Per spec § 4.6 the Setup half has direct handoff reference — but the disclosure was added post-handoff. Treat the disclosure visuals as "handoff-inspired" per the same path the spec uses for the lock-icon fineprint.

- [ ] **Step 1: Create `frontend/src/components/Setup/FirstRunDisclosure.module.css`**

  ```css
  .fineprint {
    margin-top: var(--s-4);
    font-size: var(--text-xs);
    color: var(--text-3);
  }
  /* No `display:` override — preserves the browser-default `display: list-item`
     on <summary>, which renders the disclosure triangle (▶/▼ marker). Without
     this, sighted users have no visual hint that "First run on this machine?"
     is expandable. */
  .summary {
    cursor: pointer;
    user-select: none;
    font-weight: 500;
  }
  .summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-2);
  }
  .section {
    margin-top: var(--s-3);
    padding: var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-2);
  }
  .section + .section {
    margin-top: var(--s-2);
  }
  .heading {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-1);
    margin: 0 0 var(--s-2);
  }
  .body {
    margin: 0;
    line-height: 1.55;
  }
  .body + .body {
    margin-top: var(--s-2);
  }
  ```

  Six classes total. `.fineprint` is the outer `<details>`, `.summary` styles the click target (preserves the browser-default disclosure-triangle marker), `.section` is each per-platform block (Windows/macOS), `.heading` is the inner subheading (`<h3>` — nested inside the disclosure under the form-level `<h2>` step headings), `.body` is each paragraph inside a section. **Heading-level fix** (reviewer-driven correction): the inner platform headings drop from `<h2>` to `<h3>` so the page heading structure goes h1 (Connect to GitHub) → h2 (step 1) → h2 (step 2) with nested h3 (Windows / macOS) under the disclosure, instead of mixing 4 sibling h2 elements at the form level.

- [ ] **Step 2: Modify `FirstRunDisclosure.tsx` — wire the module**

  Replace lines 13-47 (the `export function` block) with:

  ```tsx
  import styles from "./FirstRunDisclosure.module.css";

  export function FirstRunDisclosure() {
    const platform = detectPlatform();
    return (
      <details className={styles.fineprint}>
        <summary className={styles.summary}>First run on this machine?</summary>
        {(platform === "windows" || platform === "unknown") && (
          <section className={styles.section}>
            <h3 className={styles.heading}>Windows</h3>
            <p className={styles.body}>
              The first time you run PRism, Windows shows a SmartScreen warning
              (&ldquo;Windows protected your PC&rdquo;) because PRism
              isn&rsquo;t code-signed for the PoC. Click{" "}
              <strong>More info</strong>, then <strong>Run anyway</strong>. Code
              signing arrives post-PoC.
            </p>
          </section>
        )}
        {(platform === "macos" || platform === "unknown") && (
          <section className={styles.section}>
            <h3 className={styles.heading}>macOS</h3>
            <p className={styles.body}>
              The binary is built on a Windows runner, so the downloaded file
              won&rsquo;t have the Unix executable bit set. Open{" "}
              <strong>Terminal</strong>, <code>cd</code> to your Downloads
              folder, and run <code>chmod +x PRism-osx-arm64</code> once before
              launching.
            </p>
            <p className={styles.body}>
              Then, if macOS Gatekeeper blocks the binary, right-click the app
              and pick <strong>Open</strong> the first time. The first time
              PRism reads your token, macOS asks{" "}
              <strong>Allow / Always Allow / Deny</strong> &mdash; click{" "}
              <strong>Always Allow</strong> so you aren&rsquo;t asked again.
              Code signing arrives post-PoC.
            </p>
          </section>
        )}
      </details>
    );
  }
  ```

  Changes:
  - Add `import styles from './FirstRunDisclosure.module.css';` at the top of the file (above the `function detectPlatform`).
  - Each `<details>`, `<summary>`, `<section>`, `<h3>`, `<p>` gets its corresponding `className={styles.X}`.
  - **Heading level h2 → h3** for Windows / macOS subheadings (reviewer-driven correction). The disclosure sits between SetupForm's step-1 h2 and step-2 h2; making Windows/macOS h3 reflects their position as subheadings under the disclosure, not siblings of the form steps. `FirstRunDisclosure.test.tsx` does NOT assert heading levels (verified — uses `getByText` patterns only).
  - **NO behavior changes.** Platform detection, content branches, copy — all preserved verbatim.

- [ ] **Step 3: Run vitest**

  Run: `cd frontend && npx vitest run __tests__/Setup/FirstRunDisclosure.test.tsx --reporter=verbose`

  Expected: all tests PASS. Class names don't affect any assertion.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/components/Setup/FirstRunDisclosure.tsx src/components/Setup/FirstRunDisclosure.module.css`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/components/Setup/FirstRunDisclosure.tsx frontend/src/components/Setup/FirstRunDisclosure.module.css
  git commit -m "feat(design-parity): FirstRunDisclosure module CSS — fineprint shell with token-aligned per-platform sections (PR6 Task 5)"
  ```

---

## Task 6: MaskedInput.module.css — input wrap + eye-toggle button

**Files:**

- Create: `frontend/src/components/Setup/MaskedInput.module.css`
- Modify: `frontend/src/components/Setup/MaskedInput.tsx`

**Maps to handoff:**

- `.setup-input-wrap` (1278) → `.wrap`
- `.setup-eye` (1279) → `.eye` (composes `btn-icon` global for the actual button reset)

- [ ] **Step 1: Create `frontend/src/components/Setup/MaskedInput.module.css`**

  ```css
  .wrap {
    position: relative;
  }
  .input {
    width: 100%;
    box-sizing: border-box;
    min-height: 36px;
    padding: 8px 36px 8px 10px;
    font-size: var(--text-sm);
    background: var(--surface-1);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-2);
    color: var(--text-1);
  }
  .input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-color: transparent;
  }
  /* Local size override (D65): handoff line 1277 defines `.btn-icon-sm`
     (18×18) immediately before `.setup-eye`, but `.btn-icon-sm` is NOT in
     tokens.css (only `.btn-icon` 30×30 exists). Lifting `.btn-icon-sm`
     globally would be a speculative lift (no second consumer yet); instead,
     `.eye` carries the smaller size locally, sized to fit inside the 36px-tall
     input without overflow. If PR9 needs `.btn-icon-sm` for another surface,
     it lifts to tokens.css then. */
  .eye {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 18px;
    height: 18px;
  }
  ```

  Four classes. `.wrap` replaces the inline `style={{ position: 'relative' }}`. `.input` token-aligns the bare `<input>` (currently unstyled), with `min-height: 36px` + `box-sizing: border-box` to give the eye button a predictable container height. `.eye` positions the toggle button absolute AND sets a local 18×18 size override (the `.btn-icon` global it composes against is 30×30 which would overflow the input).

- [ ] **Step 2: Modify `MaskedInput.tsx`**

  Full file replacement:

  ```tsx
  import { useState, type ChangeEvent } from "react";
  import styles from "./MaskedInput.module.css";

  interface Props {
    id: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    ariaLabel: string;
  }

  export function MaskedInput({
    id,
    value,
    onChange,
    placeholder,
    ariaLabel,
  }: Props) {
    const [shown, setShown] = useState(false);
    return (
      <div className={styles.wrap}>
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange(e.target.value)
          }
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={styles.input}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide token" : "Show token"}
          className={`${styles.eye} btn-icon`}
        >
          {shown ? "🙈" : "👁"}
        </button>
      </div>
    );
  }
  ```

  Changes:
  - Drop the inline `style={{ position: 'relative' }}` → `className={styles.wrap}`.
  - Add `className={styles.input}` to the `<input>`.
  - Add `className={`${styles.eye} btn-icon`}` to the eye `<button>`. The local `.eye { width: 18px; height: 18px }` overrides `.btn-icon`'s 30×30 default.
  - Replace the `{shown ? '👁' : '👁'}` dead ternary with `{shown ? '🙈' : '👁'}` (see-no-evil monkey ↔ eye — D66). aria-label still announces state to AT. **Visible glyph distinction**: sighted users now see the icon change on toggle — fixes the prior "click eye, see same eye" usability gap; baseline captured in PR6 includes the visible-feedback affordance from the start.

- [ ] **Step 3: Run vitest**

  Run: `cd frontend && npx vitest run __tests__/setup-form.test.tsx --reporter=verbose`

  Expected: all tests PASS. Specifically `it('toggles mask/unmask on click of the eye', …)` still passes because the eye-button's aria-label-based selector (`getByRole('button', { name: /show token/i })`) works identically.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/components/Setup/MaskedInput.tsx src/components/Setup/MaskedInput.module.css`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/components/Setup/MaskedInput.tsx frontend/src/components/Setup/MaskedInput.module.css
  git commit -m "feat(design-parity): MaskedInput module CSS — wrap relative + eye-toggle absolute composes btn-icon (PR6 Task 6)"
  ```

---

## Task 7: Polish SettingsPage.module.css — coherence with PR Detail

**Files:**

- Modify: `frontend/src/pages/SettingsPage.module.css`

**Decisions for coherence (D60):**

- Page-level `<main>` keeps `max-width: 720px` + `margin: 0 auto` (centers the column on wider viewports like PR Detail's outer chrome).
- Inter-section gap stays `var(--s-6)` (matches PR3 Overview tab card gaps).
- Page heading (`h1`) gets `var(--text-2xl)` (same scale as Setup brand title and PR Detail header H1).

- [ ] **Step 1: Replace `SettingsPage.module.css`**

  ```css
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
  .page h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  ```

  Changes vs. existing:
  - `padding: var(--s-6, 24px)` → `padding: var(--s-6)` (drop the legacy fallback per the post-PR5 token convention).
  - `gap: var(--s-6, 24px)` → `gap: var(--s-6)` (same).
  - `h1` font-size `var(--font-size-xl, 1.5rem)` → `var(--text-2xl)` (24px per tokens.css line 21) — aligns with handoff brand title scale and avoids the deprecated `--font-size-xl` token (post-S6 the project uses `--text-{xs,sm,base,lg,xl,2xl}`).
  - `h1` adds `font-weight: 600` and `letter-spacing: -0.02em` for coherence with the Setup brand title and PR Detail header H1.

- [ ] **Step 2: Run vitest**

  Run: `cd frontend && npx vitest run __tests__/Settings/SettingsPage.test.tsx --reporter=verbose`

  Expected: all tests PASS. Pure CSS change.

- [ ] **Step 3: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/pages/SettingsPage.module.css`

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/pages/SettingsPage.module.css
  git commit -m "feat(design-parity): SettingsPage.module.css — h1 scale + token cleanup for PR Detail coherence (PR6 Task 7)"
  ```

---

## Task 8: Polish SettingsSections.module.css — section card coherence

**Files:**

- Modify: `frontend/src/components/Settings/SettingsSections.module.css`

**Decisions for coherence (D60), empirically verified against tokens.css:506-511 (`.overview-card`):**

- Card radius switches from hard-coded `8px` to `var(--radius-3)` (8px tokenized) — matches PR3 `.overview-card` verbatim.
- **NO `box-shadow` added** — PR3 `.overview-card` has none; adding one breaks the coherence claim.
- `h2` font-size switches from `var(--font-size-lg, 1.125rem)` to `var(--text-lg)` (17px per tokens.css line 19), adds explicit `font-weight: 600` for consistency with PR Detail headings.
- `.row` gap stays `var(--s-3)` (12px) — matches form-row convention in the rest of the app.
- `.help` color stays `var(--text-2)` — accessibility-safe muted treatment.

- [ ] **Step 1: Replace `SettingsSections.module.css`**

  ```css
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-5);
    border-radius: var(--radius-3);
    background: var(--surface-1);
    border: 1px solid var(--border-1);
  }
  .section h2 {
    margin: 0 0 var(--s-2);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .radioLabel {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    margin-right: var(--s-3);
  }
  .help {
    font-size: var(--text-sm);
    color: var(--text-2);
  }
  .linkDisabled {
    color: var(--text-2);
    opacity: 0.6;
    cursor: not-allowed;
  }
  /* No pointer-events:none — Copilot PR #71 iter-1: pointer-events:none blocks
     hover, so the title= tooltip on the disabled Replace link never appears for
     mouse users. Click is neutralized via onClick={e => e.preventDefault()} on
     the <Link>, so dropping pointer-events:none restores hover-tooltip while
     keeping the disabled affordance. */
  .srOnly {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  ```

  Changes vs. existing:
  - `border-radius: 8px` → `border-radius: var(--radius-3)` (also 8px, just tokenized — matches PR3 `.overview-card` verbatim).
  - **NO `box-shadow` change** — original plan added `var(--shadow-1)` claiming PR3 coherence, but reading `tokens.css:506-511` shows PR3 `.overview-card` has no shadow. Adding one BREAKS coherence rather than restoring it.
  - `h2` font-size `var(--font-size-lg, 1.125rem)` → `var(--text-lg)` (17px per tokens.css line 19 — verified).
  - `h2` adds `font-weight: 600` (explicit) and `letter-spacing: -0.01em` (subtle tightening matching PR Detail headings).
  - Drop the inline fallback values (`8px`, `12px`, `20px`, `1.125rem`, `4px`, `0.875rem`) per post-PR5 token convention.
  - Preserve the `pointer-events:none`-removal comment (still relevant) and `srOnly` (unchanged).
  - **`.section h2` margin** drops the trailing `0 0 var(--s-2, 8px) 0` shorthand to `0 0 var(--s-2)` (cleaner).

- [ ] **Step 2: Verify `--text-lg` exists in tokens.css**

  Run: `Grep pattern="--text-lg" path="frontend/src/styles/tokens.css" output_mode="content" -n=true`

  Expected: 1 match at tokens.css line 19 (`--text-lg: 17px;` — verified during plan write).

  If `--text-lg` is MISSING (token rename regression): revert that line in `.section h2` to `var(--font-size-lg, 1.125rem)` and append D68 to the deviations table noting the token-vocabulary gap (PR9 can normalize). Surface this discovery to the orchestrator before committing.

- [ ] **Step 3: Run vitest on Settings**

  Run: `cd frontend && npx vitest run __tests__/Settings --reporter=verbose`

  Expected: all tests PASS. Pure CSS change.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write src/components/Settings/SettingsSections.module.css`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/components/Settings/SettingsSections.module.css
  git commit -m "feat(design-parity): SettingsSections.module.css — radius/shadow/type coherence with PR Detail cards (PR6 Task 8)"
  ```

---

## Task 8.5: Split-checkpoint — SINGLE-PR6 vs SPLIT-into-Setup-and-Settings

**Files:** None modified — measurement step only.

**Why:** Per PR2-PR5 mid-plan checkpoint convention. PR2 was judged at ~12 components / 18-19 commits → single. PR3 at 8 / 16 → single. PR4 at 15/30 → single (520 LOC at the checkpoint). PR5 at 10/18 → single (311 LOC at the checkpoint, 9 review-meaningful changes). PR6's projection: ~7 file modules + 2 plan-doc updates + 2 parity baselines, ~250-350 LOC at this point.

- [ ] **Step 1: Measure cumulative net LOC delta**

  Run: `git diff --stat main..HEAD -- frontend/src/pages/SetupPage.tsx frontend/src/pages/SettingsPage.tsx frontend/src/pages/SetupPage.module.css frontend/src/pages/SettingsPage.module.css frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css frontend/src/components/Setup/FirstRunDisclosure.tsx frontend/src/components/Setup/FirstRunDisclosure.module.css frontend/src/components/Setup/MaskedInput.tsx frontend/src/components/Setup/MaskedInput.module.css frontend/src/components/Settings/SettingsSections.module.css`

  Capture total inserts + deletes.

- [ ] **Step 2: Count review-meaningful changes**

  Count: how many of these substantive changes have landed?
  - `SetupPage.tsx` testid + module wrap (3-element)
  - `SetupPage.module.css` (new)
  - `SettingsPage.tsx` testid
  - `SettingsPage.module.css` polish
  - `SetupForm.tsx` JSX restructure (brand + numbered sections)
  - `SetupForm.module.css` rewrite
  - `FirstRunDisclosure.tsx` module wire
  - `FirstRunDisclosure.module.css` (new)
  - `MaskedInput.tsx` module wire + dead-ternary drop
  - `MaskedInput.module.css` (new)
  - `SettingsSections.module.css` polish

  Expected at this checkpoint: 11 changes, ~250-400 LOC net.

- [ ] **Step 3: Decide SINGLE-PR6 or SPLIT**

  **SPLIT-tripper thresholds** (calibrated against PR2-PR5):
  - LOC > 700 (PR4 shipped at 1120, judged single because CSS-only — but 1120 was the practical ceiling)
  - OR review-meaningful changes > 18 (PR4 shipped at 15 — within tolerance)
  - OR review-noise concern: > 3 modules touch files in 3+ distinct directories AND combined review surface is dense

  PR6 projection: ~400-500 LOC + 11 changes across 2 dirs (`pages/`, `components/Setup/` + `components/Settings/`). Below all thresholds.

  **Override-tripwire (coherence judgment):** If the Setup half feels under one mental model (centered card + numbered steps + masked-input is one coherent visual story) and the Settings half is independently judged (subjective coherence vs PR Detail), a reviewer might prefer SPLIT to keep the subjective Settings review separate. Counter-argument: shipping them together means the maintainer's "feels right" Settings judgment is informed by the just-shipped Setup parity reference — same maintainer, same review window, same surface.

  **Decision:** Default to SINGLE-PR6 unless the LOC measurement exceeds 700 OR the review-meaningful change count exceeds 18. Document the decision as `D54-style` (`D69 — SINGLE-PR6 at Task 8.5: <N> LOC + <N> changes; override tripwire on coherence`).

- [ ] **Step 4: Log the decision in the plan**

  Append to the deviations table a D69 entry recording the measured values + decision. Template:

  ```
  | D69 | SINGLE-PR6 vs SPLIT decision at Task 8.5 | Decision record — populated at Task 8.5 with measured LOC + review-meaningful change count + outcome (SINGLE-PR6 or SPLIT). Defaults to SINGLE-PR6 unless LOC > 700 or changes > 18 OR coherence-tripwire fires. |
  ```

  Then EDIT the placeholder text to substitute the actual measured values: e.g., "385 LOC net + 11 review-meaningful changes. Both below LOC>700 / changes>18 thresholds. SINGLE-PR6 selected. Override-tripwire NOT applied — same-maintainer / same-review-window precedent from PR2-PR5."

  (Implementer edits this plan file in place to record the decision. Append exactly once — guarded by the sequencing note: Task 8.5 runs after Task 8 and before Task 9.)

- [ ] **Step 5: Commit the decision**

  ```bash
  git add docs/plans/2026-05-30-design-parity-recovery-pr6-setup-settings.md
  git commit -m "docs(design-parity): PR6 Task 8.5 split-checkpoint — SINGLE-PR6 decision logged (PR6 Task 8.5)"
  ```

---

## Task 9: Capture setup-card parity baseline

**Files:**

- Modify: `frontend/e2e/parity-baselines.spec.ts:105-112` (un-fixme the `setup-card` test)
- Add: `frontend/e2e/__screenshots__/win32/setup-card.png` (binary, captured by `--update-snapshots`)

**PREREQUISITES:** Tasks 2-6 must be committed. Task 2 adds the `data-testid="setup-card"` to the SetupPage wrapper; Task 3 moves it onto the styled `.card` element; Tasks 4-6 land the form / disclosure / masked-input visual updates. Without Tasks 2-3 the locator wait fails; without Tasks 4-6 the captured baseline is a half-styled snapshot that the next PR will fail against.

- [ ] **Step 1: Un-fixme the setup-card zone**

  Edit `frontend/e2e/parity-baselines.spec.ts` line 105. Change:

  ```typescript
    test.fixme('setup-card', async ({ page }) => {
  ```

  to:

  ```typescript
    test('setup-card', async ({ page }) => {
  ```

  (Remove `.fixme`.)

- [ ] **Step 2: Capture the baseline via Playwright prod project**

  Run: `cd frontend && npx playwright test --project=prod parity-baselines.spec.ts -g "setup-card" --update-snapshots`

  Expected: 1 test PASS, new `setup-card.png` written under `frontend/e2e/__screenshots__/win32/` (or `linux/darwin` per platform).

  If the test FAILS at the locator wait (`page.locator('[data-testid="setup-card"]').waitFor()` timeout):
  - Verify the testid landed in Task 3 Step 2 (re-grep `frontend/src/pages/SetupPage.tsx` for `data-testid="setup-card"`).
  - Verify `/setup` loads — `authState` resolves to a non-null value in the Test backend env so `<LoadingScreen />` doesn't block forever (`PRISM_E2E_AUTHED` env or backend Test seam — check `frontend/playwright.config.ts` `webServer.env` for the relevant flag).

  If the test FAILS at the screenshot comparison: this is the first commit of the baseline, so `--update-snapshots` writes the baseline. The "failure" only happens on the second run without `--update-snapshots`. The first run is the SOURCE of the baseline.

- [ ] **Step 3: Sanity-run the same test WITHOUT `--update-snapshots`**

  Run: `cd frontend && npx playwright test --project=prod parity-baselines.spec.ts -g "setup-card"`

  Expected: PASS — the just-captured baseline matches itself.

- [ ] **Step 4: Run Prettier write on the spec file**

  Run: `cd frontend && npx prettier --write e2e/parity-baselines.spec.ts`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__/
  git commit -m "test(design-parity): un-fixme setup-card zone + capture initial baseline (PR6 Task 9)"
  ```

---

## Task 10: Capture settings-page parity baseline

**Files:**

- Modify: `frontend/e2e/parity-baselines.spec.ts:116-127` (un-fixme the `settings-page` test)
- Add: `frontend/e2e/__screenshots__/win32/settings-page.png`

**PREREQUISITES:** Tasks 2 + 7 + 8 must be committed. Task 2 adds the `data-testid="settings-page"`; Tasks 7-8 land the Settings card / type polish. Without these the locator wait fails or the captured baseline doesn't reflect the coherence target.

- [ ] **Step 1: Un-fixme the settings-page zone**

  Edit `frontend/e2e/parity-baselines.spec.ts` line 116. Change:

  ```typescript
    test.fixme('settings-page', async ({ page }) => {
  ```

  to:

  ```typescript
    test('settings-page', async ({ page }) => {
  ```

- [ ] **Step 2: Capture the baseline**

  Run: `cd frontend && npx playwright test --project=prod parity-baselines.spec.ts -g "settings-page" --update-snapshots`

  Expected: 1 test PASS, new `settings-page.png` written under `frontend/e2e/__screenshots__/win32/`.

  Special considerations:
  - The test goes through `setupAndOpenScenarioPr` first (line 118) to materialize auth + preferences, then navigates to `/settings`. The preferences mock returns indigo accent + system theme — that's the canonical baseline state.
  - All four section headings (Appearance / Inbox sections / Connection / Auth) are present in the baseline.
  - The Replace token link is in its enabled state (no submit in flight per scenario fixture default).

- [ ] **Step 3: Sanity-run without `--update-snapshots`**

  Run: `cd frontend && npx playwright test --project=prod parity-baselines.spec.ts -g "settings-page"`

  Expected: PASS.

- [ ] **Step 4: Run Prettier write**

  Run: `cd frontend && npx prettier --write e2e/parity-baselines.spec.ts`

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__/
  git commit -m "test(design-parity): un-fixme settings-page zone + capture initial baseline (PR6 Task 10)"
  ```

---

## Task 11: Append D58-D67 + D70 (and any D68/D69 that landed) to deferrals sidecar

**Files:**

- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

- [ ] **Step 1: Append the PR6 deferrals block**

  Read the existing deferrals sidecar to find the PR5 end-marker, then append the PR6 block immediately after.

  Content to append (verbatim from the plan's deviations table above, formatted as one block per the existing PR2-PR5 entries in the sidecar):

  ```markdown
  ## PR6 — Setup + Settings coherence

  ### D58 — `ScopePill.module.css` not created

  Spec § 4.6 lists `ScopePill.module.css` as a new module. Pre-flight Task 1 verified
  `ScopePill.tsx` has zero production consumers (only file matching `Grep pattern="ScopePill" path="frontend/src"` is its own definition). Creating a module CSS file
  for an unrendered component is a speculative anchor — same trap PR4 D26
  explicitly rejected for `.composer-save` etc. PR9 catalog determines whether
  ScopePill stays as dead code or gets deleted; if a consumer lands in PR9 the
  module CSS lands then. **Explicit bet:** PR6 wagers PR9 will EITHER delete ScopePill.tsx OR document it as deferred dead-code with a v1.x consumer plan. If PR9 surfaces a consumer that needs ScopePill rendered, that PR pays the module-CSS cost, not PR6.

  ### D59 — No per-section module CSS files in Settings

  Spec § 4.6 says "polish to `SettingsSections.module.css`, plus any new module CSS
  the section components need." The 4 section components (Appearance / InboxSections /
  Connection / Auth) all compose `SettingsSections.module.css` cleanly with no per-section
  styling divergence. Splitting into per-component modules would be YAGNI. Stays as
  a single shared module.

  ### D60 — Settings half acceptance is subjective but bound by falsifiable token targets

  Per spec § 4.6: "the only PR with subjective 'feels right' review criteria." Coherence target empirically verified against `frontend/src/styles/tokens.css:506-511` (`.overview-card`): `var(--surface-1)` background, `var(--border-1)` border, `var(--radius-3)` (8px) radius, `var(--s-4) var(--s-5)` padding, **NO `box-shadow`**. SettingsSections.module.css `.section` matches: `var(--surface-1)` / `var(--border-1)` / `var(--radius-3)` / `var(--s-5)` padding / `var(--text-lg)` h2 / NO shadow. If post-merge regret surfaces a token mismatch, the diff to revert is explicit. Maintainer judgment on the `settings-page.png` parity baseline is the gate.

  ### D61 — SetupPage gains a 3-element wrapper structure

  `.screen` > `.bg` + `.card` > children. Required for centered-card-on-radial-gradient
  layout. Adds DOM nodes, zero behavior change. Inside spec § 2.2's "no component-logic
  changes" rule per PR2-PR5 precedent. Pseudo-element alternative for `.bg` is not viable — `.screen` uses flex with `overflow: auto`; a `::before` flex item would not absolute-position cleanly.

  ### D62 — SetupForm.module.css `.form` drops card-chrome

  Card chrome (padding/background/border/border-radius/box-shadow) moves to the new
  `.card` class in SetupPage.module.css. SetupForm.form is now pure flex-column.

  ### D63 — `<strong>1.</strong>` becomes `<section><h2><span class="num">1</span> <a class="link">…</a></h2>...</section>` (step 1) / `<section><h2><span class="num">2</span> Paste it below</h2>...</section>` (step 2)

  Handoff `.setup-num` requires its own positioned 20×20 circle element — cannot
  be styled on inline `<strong>` text. **Step 1's link "Generate a token" is nested INSIDE the `<h2>`** so the link text is preserved (the existing `setup-page.test.tsx:78` `findByRole('link', { name: /generate a token/i })` keeps passing). **Ordinal stays in a11y tree** (no `aria-hidden` on the badge span) — SR users hear "1 Generate a token" / "2 Paste it below" preserving step-ordinality wayfinding.

  ### D64 — Brand block wraps into `<div className=brand><h1 className=title><p className=sub>` (NOT `<header>`)

  Handoff `.setup-brand` / `.setup-title` / `.setup-sub` block at the top of the card.
  Each maps to one module class. **Wrapper is `<div>` not `<header>`** — preflight adversarial review caught that `<header>` inside `<form>` IS mapped to `role=banner` (the HTML AAM exclusion list is article/aside/main/nav/section — `<form>` is NOT in it), which would have duplicated the App-level `<Header />` banner landmark on /setup. `<div>` preserves the visual grouping without the landmark duplication.

  ### D65 — MaskedInput inline style → module + local eye-button size override

  `style={{ position: 'relative' }}` → `className={styles.wrap}`. **Eye-button sizing**: handoff line 1277 implies `.btn-icon-sm` (18×18) composition but `.btn-icon-sm` is NOT in tokens.css. `.eye` carries a local 18×18 size override alongside its position rules — sized to fit inside the 36px-tall input without overflow. Lift-on-second-use trigger remains for any future second consumer.

  ### D66 — Eye-toggle glyph: `{shown ? '🙈' : '👁'}` (visible-state feedback)

  Current MaskedInput.tsx has `{shown ? '👁' : '👁'}` (copy-paste defect). PR6 ships `{shown ? '🙈' : '👁'}` (see-no-evil monkey ↔ eye — widely-supported emoji pair) so sighted users see toggle-state feedback. aria-label still announces "Show token"/"Hide token" for AT. Captures correct feedback in the PR6 baseline (avoids PR9 baseline re-capture cost).

  ### D67 — No `.setup-*` rules lifted to tokens.css

  All handoff `.setup-*` rules **ported in PR6** are single-producer (per D58-D59 scope reductions). Lift-on-second-use is the documented trigger (PR3 D22 / PR4 D34 / PR5 D47). No second consumer exists in PR6 scope.

  ### D70 — `.fineprint` lock icon deferred to PR9 a11y polish

  Spec § 4.6 calls for "fineprint with lock icon" but handoff ships no glyph source. PR6 ships `.fineprint` typography (margin / font-size / color) without a glyph; PR9 polish picks the source (emoji / inline SVG / icon library) and re-captures the `setup-card.png` baseline. Handoff `.setup-fineprint` flex+gap+center rules intentionally NOT ported because the disclosure is a `<details>` block, not a flex row.
  ```

  Insert any D68 (text-lg vocabulary gap) or D69 (split-checkpoint decision) entries
  produced by Tasks 8 + 8.5 above their respective sub-blocks.

- [ ] **Step 2: Commit**

  ```bash
  git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
  git commit -m "docs(design-parity): append PR6 D58-D67 (+ D68/D69 if any) to deferrals sidecar (PR6 Task 11)"
  ```

---

## Task 12: Pre-push checklist (verbatim per `.ai/docs/development-process.md`)

**Files:** None modified.

- [ ] **Step 1: Run frontend vitest full suite**

  Run: `cd frontend && npm test -- --reporter=verbose 2>&1 | tail -40`

  Expected: 789+ tests PASS, 0 FAIL. (PR5 exit was 789; PR6 may add 0 — no new vitest cases — or stay at 789.)

- [ ] **Step 2: Run frontend lint (includes prettier --check)**

  Run: `cd frontend && npm run lint 2>&1 | tail -20`

  Expected: clean (0 errors / 0 warnings on `--max-warnings 0`).

- [ ] **Step 3: Run frontend build**

  Run: `cd frontend && npm run build 2>&1 | tail -30`

  Expected: clean Vite build, no TS errors, no module-CSS warnings.

- [ ] **Step 4: Run backend Release build + tests**

  Run: `dotnet build PRism.sln --configuration Release 2>&1 | tail -10`
  Then: `dotnet test PRism.sln --configuration Release --no-build --verbosity normal 2>&1 | tail -10`

  Expected: 1014+ tests PASS, 0 FAIL.

  Note: PR6 doesn't touch backend code, so this run is for the standing pre-push hygiene rule (never push without backend Release green).

- [ ] **Step 5: Run Playwright prod project on the affected specs**

  Run: `cd frontend && npx playwright test --project=prod parity-baselines.spec.ts 2>&1 | tail -30`

  Expected: at minimum the 2 PR6-touched zones (`setup-card`, `settings-page`) PASS green. The PR2-PR5 zones (pr-detail-header / pr-detail-overview / pr-detail-files-tree / pr-detail-files-diff / pr-detail-drafts / pr-detail-reconciliation-panel) continue to PASS. The 2 still-fixme'd zones (inbox / inbox-activity-rail) report fixme-skip — not regressions.

  Plus run the broader s4/s5 specs to confirm no Setup-restructure regression in flows:

  Run: `cd frontend && npx playwright test --project=prod s4-keep-anyway-survives-reload.spec.ts s4-drafts-survive-restart.spec.ts s5-submit-foreign-pending-review.spec.ts 2>&1 | tail -20`

  Expected: 11+ tests PASS, no regressions on the auth + setup flows.

- [ ] **Step 6: Report cleanly**

  Compile a one-line summary per step:
  - vitest: 789/789 PASS
  - lint: clean
  - build: clean
  - backend: 1014/1014 PASS
  - Playwright prod project: N PASS / 0 FAIL / 2 fixme-skip (inbox + inbox-activity-rail expected)

  No commit — this is verification only.

---

## Task 13: Final scope-review pass + plan-doc update

**Files:**

- Modify: `docs/plans/2026-05-30-design-parity-recovery-pr6-setup-settings.md` (this file — update the deviations table with any D68/D69 that landed during execution)
- Optional commit: deviations-table sync

- [ ] **Step 1: Re-read the deviations table at the top of this plan**

  Confirm every D58-D67 + D70 is reflected verbatim in `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` and any D68/D69 produced by Tasks 8/8.5 has been logged in both places.

- [ ] **Step 2: Re-verify spec § 4.6 line-item coverage**

  Open `docs/specs/2026-05-29-design-parity-recovery-design.md:267-278` and verify each scope line maps to a delivered artifact:

  | Spec line                                        | Delivered                                                                        |
  | ------------------------------------------------ | -------------------------------------------------------------------------------- |
  | "module CSS for SetupPage"                       | Task 3 — `SetupPage.module.css`                                                  |
  | "polish to SetupForm.module.css"                 | Task 4 — rewritten                                                               |
  | "new FirstRunDisclosure.module.css"              | Task 5                                                                           |
  | "new MaskedInput.module.css"                     | Task 6                                                                           |
  | "new ScopePill.module.css"                       | DEFERRED (D58)                                                                   |
  | "centered card on accent radial-gradient wash"   | Task 3 — `.screen` / `.bg` / `.card`                                             |
  | "numbered-step pattern"                          | Task 4 — `.section` / `.sectionHead` / `.num` (with link inside h2 for step 1)   |
  | "required-permissions block"                     | Task 4 — `.permissions` / `.permissionRow` polish                                |
  | "eye toggle on textarea"                         | Task 6 — `.eye` (with `{shown ? '🙈' : '👁'}` glyph swap and local 18×18 sizing) |
  | "fineprint with lock icon"                       | Task 5 — `.fineprint` typography only; lock icon DEFERRED to PR9 per D70         |
  | "polish to SettingsPage.module.css"              | Task 7                                                                           |
  | "polish to SettingsSections.module.css"          | Task 8 (radius-3, NO shadow — verified against PR3 reference)                    |
  | "any new module CSS the section components need" | NONE (D59)                                                                       |
  | "subjective 'feels right' review criteria"       | D60 + maintainer review (token targets are falsifiable; PR3 verbatim match)      |

- [ ] **Step 3: Confirm D70 lock-icon entry exists**

  D70 is now declared upfront in the deviations table. Verify the deferrals sidecar entry from Task 11 was appended (not absorbed into D60). If the lock icon was somehow delivered (e.g., an emoji `🔒` was added during implementation), update D70 to reflect the delivery instead of leaving the deferral text stale.

- [ ] **Step 4: If any plan deviations were added during Tasks 1-12, commit the plan-doc update**

  ```bash
  git add docs/plans/2026-05-30-design-parity-recovery-pr6-setup-settings.md
  git commit -m "docs(design-parity): PR6 plan-doc update — final deviations table sync (PR6 Task 13)"
  ```

  If no plan-doc changes, skip.

- [ ] **Step 5: Report to orchestrator**

  Final summary:
  - 13 tasks complete (including any sub-task counts from Tasks 3/4/8 where the implementer batched).
  - Cumulative LOC at exit: <N>
  - Plan deviations D58-D67 (+ D68/D69) logged to sidecar.
  - Pre-push checklist green.
  - 2 parity baselines captured (`setup-card`, `settings-page`).
  - Ready for pr-autopilot Phase 1.

---

## Risks and dependencies

- **No backend changes.** PR6 is frontend-only — backend `/api/auth/connect`, `/api/auth/replace`, `/api/preferences`, `/api/submit/in-flight` all stay verbatim.
- **No new dependencies.** No npm package adds. No CSS framework adds.
- **`--update-snapshots` baseline drift risk.** Tasks 9-10 commit binary PNGs. Like PR2-PR5, the baseline is the first-passing state and the implementer should manually inspect the captured PNG to confirm it's recognizably "the Setup card" / "the Settings page" before committing (catches font-rendering / antialiasing surprises and accidental dark-mode capture). If the baseline looks wrong, fix the upstream cause first and re-capture.
- **Dev-project Playwright timeouts on Windows.** Per PR5 precedent, Playwright dev-project tests timeout on Windows from Vite+dotnet startup contention. PR6 uses `--project=prod` for baseline captures — same workaround. The `dev` project is irrelevant to PR6's gates.
- **Subjective Settings review.** D60 documents the maintainer-judgment gate. Expect higher review noise on the Settings half. If the maintainer requests a Settings-specific revision after the Setup half is approved, fold into a follow-up plan deviation entry rather than rolling back Setup.

## Test plan coverage

PR6 ships:

- 2 new parity baselines (setup-card.png + settings-page.png)
- 0 new vitest cases (all 4 affected test files pass with existing assertions; class-free selectors give us coverage for free)
- 0 new Playwright e2e cases (parity baselines.spec.ts un-fixmes 2 zones)
- 0 backend test changes

Acceptance criteria gate:

- vitest 789+/789+ PASS
- npm run lint clean
- npm run build clean
- dotnet build + test Release 1014+/1014+ PASS
- Playwright prod parity-baselines + s4-keep-anyway + s4-drafts + s5-submit-foreign-pending-review all PASS or fixme-skip (no failures)
- maintainer side-by-side Settings coherence review at PR review time
