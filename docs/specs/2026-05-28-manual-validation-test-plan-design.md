# Manual Validation Test Plan

A complete, layered manual-validation suite for PRism's PoC surface. Captures every shipped functional case as a numbered scenario so the doc serves as a regression *index* (not just a "stuff we don't have automation for" backlog) — automated coverage is annotated per case so a human reviewer knows which scenarios they're free to skip during a hurry pass.

## When to run

| Layer | Cadence | Purpose |
|---|---|---|
| **Part 1 — Smoke pass** | Before tagging any release; after any PR that touches the demo flow | Walk the wedge end-to-end. A single-machine + single-PAT subset is ~30 min; the full 25-case pass with live-PR coordination (S-9/S-10/S-11/S-21/S-22) + cross-platform §S/* cases + two-login replace (S-19) is realistically 60–90 min. Live-PR cases include poll waits (30s active, 120s inbox) and github.com round-trips — schedule accordingly |
| **Part 2 — Per-surface regression** | After any PR that touches the listed surface; on the pre-release pass for surfaces that changed since last release | Targeted re-runs; the surface section is the unit of "did I break this" |
| **Part 3 — Visual review pack** | When polish is the explicit goal of a session; before a milestone where visual quality matters | Capture the listed screenshots, bundle them, and feed them to Claude with the canned per-case prompt for layout / typography / spacing / contrast / dark-mode-parity / motion analysis |
| **Part 4 — Appendix** | As reference during any of the above | Sandbox PR catalog, throwaway-PR recipe, glossary |

## How to read a case

Every case in Parts 1 and 2 uses this shape:

```
N. <name>
   Pre: <pre-conditions in one line>
   Steps: 1) ... 2) ... 3) ...
   Expected: <single observable result>
   Automation: <pointer> | none
   Notes / regression-modes: <optional — only when non-obvious>
```

`Automation: none` cases are the *must-run* set for any pre-ship pass. Other cases can be skipped on a hurry pass under the assumption that the automated coverage is green. **If an Automation pointer is stale** (the named test file or function no longer exists when you grep for it), treat the case as `none` until the pointer is updated — automation-presence is the only signal "you can skip this," and a broken pointer is no signal at all. Automation pointers are **best-effort as of writing (2026-05-28)**; rename a Playwright spec or add coverage and the pointers here will drift. Cross-check with `npx playwright test --list` and `dotnet test --list-tests` if in doubt.

**Environment per case.** Cases tagged `Environment: binary` must run against the published single-file binary (port-walk, FileSystemWatcher rename semantics, SmartScreen / Gatekeeper trust copy, Keychain prompt). Cases tagged `Environment: dev-server` need `dotnet watch run` + `vite dev` because they exercise paths only reachable that way (e.g., `PRISM_DEV_FIXED_TOKEN`). Cases tagged `Environment: test-hooks` need `ASPNETCORE_ENVIRONMENT=Test` + `PRISM_E2E_FAKE_REVIEW=1` to register `FakeReviewSubmitter` and expose `/test/*` endpoints (see [Recipe D](#recipe-d-test-hooks-enabled-build)). Cases with no Environment tag run on either binary or dev-server.

**Recording results.** Manual passes lose their value if there's no audit trail. Recommended: create `docs/manual-validation-runs/YYYY-MM-DD-<purpose>.md` per pass and record per case — `PASS` / `FAIL <one-line>` / `SKIP <reason>` / `BLOCKED <missing precondition>`. Carry forward a per-case last-pass-date across runs so cases not run in N months bubble up as risk. The file is git-tracked; commit alongside the release tag for traceability.

Cases in Part 3 use a different per-case shape — see Part 3's intro.

## Cold-start recipes

Several cases need a clean slate. Two recipes:

**Recipe A — fresh data dir.** Quit any running PRism. Move the data directory aside:

```
# Windows
Move-Item "$env:LOCALAPPDATA\PRism" "$env:LOCALAPPDATA\PRism.bak.$(Get-Date -f yyyyMMdd-HHmmss)"

# macOS
mv "$HOME/Library/Application Support/PRism" "$HOME/Library/Application Support/PRism.bak.$(date +%Y%m%d-%H%M%S)"
```

Relaunch the binary. The token is in the OS keychain — clear it via the Setup-screen's Replace-token flow (after Recipe B is done) or via the keychain manager directly if a true cold boot is required.

**Recipe B — fresh PAT.** Generate at `<host>/settings/personal-access-tokens/new` with the scopes from README.md § "Generate a GitHub Personal Access Token". Save the token string in a password manager so subsequent cases can paste it; revoke at end of validation pass.

**Recipe C — two-login PAT pair (for identity-change cases).** S-19, P-2, P-3, P-4, and V-36 need a second GitHub account whose login differs from the primary account, with a PAT for each. Cheapest path: create a free secondary github.com account (e.g., `prpande-validation`); generate a fine-grained PAT with the same scopes as Recipe B; store alongside the primary PAT in your password manager. Throwaway organizations or bot accounts work equivalently; the only requirement is a different `viewer.login` than your primary. Cases needing Recipe C are tagged in their Pre.

<a id="recipe-d-test-hooks-enabled-build"></a>**Recipe D — test-hooks-enabled build.** Every `/test/*` endpoint and the `FakeReviewSubmitter` are hard-gated to `ASPNETCORE_ENVIRONMENT=Test` (`PRism.Web/TestHooks/TestEndpoints.cs:109`). The published single-file binary runs `Production` and returns 404 on every `/test/*` route. To exercise cases tagged `Environment: test-hooks`:

```
# PowerShell
$env:ASPNETCORE_ENVIRONMENT = "Test"
$env:PRISM_E2E_FAKE_REVIEW = "1"
dotnet watch run --project PRism.Web --urls http://localhost:5181

# bash / zsh
ASPNETCORE_ENVIRONMENT=Test PRISM_E2E_FAKE_REVIEW=1 \
  dotnet watch run --project PRism.Web --urls http://localhost:5181
```

In Test env, the production launcher (lockfile, browser auto-open, port-walk) is suppressed; open `http://localhost:5181` manually in a browser. Real submits are replaced by `FakeReviewSubmitter`, so K-* failure-recovery cases do not touch a real GitHub PR.

## Sandbox PRs

Read-side cases use the frozen contract-test PR set on `prpande/PRism` (the project's own repo) — these were chosen because their content is stable. Full table in [Appendix § Sandbox catalog](#sandbox-catalog).

| Frozen PR | Repo | What it exercises |
|---|---|---|
| #1 | `prpande/PRism` | Multi-commit small PR (iteration clustering happy path) |
| #16 | `prpande/PRism` | Single-file rename + content edit (file-resolution edge case) |
| #19 | `prpande/PRism` | Single-commit PR (iteration clustering: 1-commit degenerate fallback path) |
| #22 | `prpande/PRism` | Heavy amend cycle + force-pushes (iteration clustering stress + force-push banner) |
| #28 | `prpande/PRism` | `.md` + Mermaid (markdown rendering surface) |
| #N (varies) | `prpande/prism-sandbox` | Stale-OID real-flow fixture. The fixture lives on a **separate sandbox repo**, regenerated per pass via `npm run setup-real-e2e-fixtures` — the PR number is whatever the script produced last (read it from `frontend/e2e/real/fixtures.json` after running setup). NOT a frozen PR on `prpande/PRism`. |

Submit/reconciliation cases need a *live mutable* PR. Recipe: [Appendix § Throwaway PR recipe](#throwaway-pr-recipe).

---

# Part 1 — Smoke pass

25 numbered cases prefixed `[S]`. Target run time is workload-dependent: a single-machine subset that skips live-PR coordination cases (S-9 / S-10 / S-11 / S-21 / S-22), the identity-change case (S-19), cross-platform binary cases (S-1's SmartScreen / Gatekeeper UX), and the destructive state-migration case (S-25) lands ~30 min. The full 25-case pass is 60–90 min. Cases follow the 13-step PoC demo flow from `spec/01-vision-and-acceptance.md`, with additions for the wedge surfaces the demo doesn't cover (cheatsheet, viewed checkbox, cross-tab broadcast, identity-change Replace, on-disk log rotation).

## [S-1] Cold launch → Setup screen
**Pre:** Recipe A (fresh data dir). PRism binary downloaded.
**Steps:** 1) Double-click the binary. (Windows: dismiss SmartScreen via More info → Run anyway. macOS: right-click → Open → Open.) 2) Wait for browser to open.
**Expected:** Browser opens to `http://localhost:5180` (or next free port 5180-5199). Setup screen renders with host field defaulting to `https://github.com`, PAT link templated to the host, permission list, About-local-data block, Continue button. Backend `state-events.jsonl` does **not** exist yet (PoC defers forensic log).
**Automation:** Playwright `frontend/e2e/cold-start.spec.ts`, partial.

## [S-2] PAT paste → validated → routes to Inbox
**Pre:** Setup screen visible (from S-1). Valid PAT ready (Recipe B).
**Steps:** 1) Paste PAT into textarea. 2) Click Continue.
**Expected:** Backend probes `GET /user` (200) + the two `/search/issues` smoke probes. On success, navigates to `/inbox`. macOS: Keychain prompt — click Always Allow.
**Automation:** Playwright `frontend/e2e/cold-start.spec.ts`; backend `tests/PRism.Web.Tests/Endpoints/SetupEndpointsTests.cs`.

## [S-3] Inbox loads with five sections
**Pre:** Just completed S-2.
**Steps:** Observe inbox.
**Expected:** Five sections in order: Review requested, Awaiting author, Authored by me, Mentioned, CI failing on my PRs. Each section header shows count. Empty sections render their section-specific placeholder (e.g. "No CI failures on your PRs — nice."). URL-paste input appears above sections. Activity rail visible if `ui.aiPreview = true`, otherwise grid collapses to single column.
**Automation:** Playwright `frontend/e2e/inbox.spec.ts`; vitest `frontend/__tests__/InboxPage.test.tsx`.

## [S-4] Click PR row → PR detail loads
**Pre:** Inbox showing at least one PR with diff content. Use frozen sandbox PR #1 if cold start.
**Steps:** 1) Click the row title for a PR with multiple commits. 2) Wait for PR detail mount.
**Expected:** PR header shows title, author, branch info, mergeability, CI summary, verdict picker, Submit button (disabled — no drafts yet). Three sub-tabs (Overview / Files / Drafts); Overview is default. Drafts tab is enabled (S4 has shipped). On Files tab: file tree on left, diff pane on right, iteration tabs above ("All changes" + last 3 inline + older dropdown).
**Automation:** vitest `frontend/__tests__/PrDetailPage.test.tsx`, `FilesTab.test.tsx`, `IterationTabStrip.test.tsx`.

## [S-5] `j`/`k` navigation + viewed checkbox
**Pre:** PR detail showing Files tab on a multi-file PR.
**Steps:** 1) Press `j` to step to next file. 2) Press `j` twice more. 3) Press `k` to step back. 4) Click the Viewed checkbox on the focused file row. 5) Reload the page (Ctrl/Cmd+R).
**Expected:** Focus moves between files (skipping directory headers). Per-directory rollups update live (e.g. `1 / 5 viewed`). After reload, **the checkbox state does NOT persist on the frontend** (S3 shipped a stub — backend POST writes `state.json` but the SPA doesn't GET on mount). Confirm this is still the shipped behavior; if the GET-on-mount work has landed since this doc, this case must be updated.
**Automation:** vitest `frontend/__tests__/FilesTab.test.tsx`, partial; the persistence gap is **not** automated.
**Notes:** This is the S3 known-limitation surface — re-confirm at each release that it's still a stub or that intended semantics shipped.

## [S-6] Iteration tab shows per-iteration diff
**Pre:** PR detail on a PR with ≥3 iterations (frozen sandbox PR #1 or #22).
**Steps:** 1) Click "Iter 2" tab. 2) Click "All changes". 3) Click "Iter 3" tab.
**Expected:** Diff range updates to `iter_N-1_head..iter_N_head` for the selected iteration. Iter 2's diff is smaller than "All changes". The commit list for that iteration appears above the diff.
**Automation:** vitest `frontend/__tests__/IterationTabStrip.test.tsx`, `IterationLoader.test.tsx`.

## [S-7] Click line in diff → composer opens, save draft
**Pre:** PR detail Files tab open on any code file.
**Steps:** 1) Click a code line in the diff. 2) Type a markdown comment ("test draft for smoke"). 3) Press Ctrl/Cmd+Enter.
**Expected:** Inline composer opens anchored at clicked line. Auto-save fires (visible via no toast — silent debounce). Save closes the composer; the draft appears as an inline widget at the anchor line.
**Automation:** Playwright `frontend/e2e/s4-drafts-survive-restart.spec.ts`; vitest `frontend/__tests__/InlineCommentComposer.test.tsx`.

## [S-8] `.md` file renders Mermaid + GFM
**Pre:** PR detail Files tab; pick frozen sandbox PR #28 which has a `.md` file with Mermaid.
**Steps:** 1) Open the `.md` file from the tree. 2) Confirm Rendered view is default. 3) Toggle to Diff view. 4) Toggle back.
**Expected:** Rendered view shows split-pane (old left, new right) with Mermaid diagram rendered, GFM tables/task lists rendered, code blocks Shiki-highlighted. Diff view shows standard code diff. Toggle state persists per `(pr_ref, file_path)` after reload.
**Automation:** vitest `frontend/__tests__/MarkdownPane.test.tsx` (rendering); persistence has no automated coverage.

## [S-9] Banner appears on poll-detected new commit, Reload runs reconciliation
**Pre:** Live mutable PR with one draft saved on the current head. Author can push from a second terminal/machine. Recipe in Appendix.
**Steps:** 1) From a second machine/terminal: push a commit to the PR's head branch that does **not** touch the file the draft is anchored to. 2) Wait up to 30s for PRism's banner. 3) Click Reload.
**Expected:** Banner appears: "PR updated — Iteration N available, …" with Reload button. Diff under cursor does not auto-mutate. After Reload: draft classified Fresh (silent re-anchor; no badge); verdict (if set) flipped to `needs-reconfirm` if `head_sha` changed.
**Automation:** Playwright `frontend/e2e/real/s5-real-happy-path.spec.ts` covers banner + reload partially; the per-draft Fresh classification is exercised by backend `tests/PRism.Core.Tests/Reconciliation/...`.

## [S-10] Force-pushed mid-review → reconciliation classifies stale draft
**Pre:** Live mutable PR with a draft saved on a specific line in a specific file.
**Steps:** 1) Push a commit that **deletes the anchored line** (or the entire file). 2) Wait for banner. 3) Click Reload.
**Expected:** Draft classified Stale. Reconciliation panel "Unresolved" section appears at top with N stale drafts and offered actions (Show me / Edit / Delete / Keep anyway). Submit button disabled with tooltip explaining why.
**Automation:** Playwright `frontend/e2e/s4-reconciliation-fires.spec.ts`.

## [S-11] Reconcile stale → set verdict → submit → review on GitHub
**Pre:** From S-10 — one stale draft + one verdict re-confirm needed.
**Steps:** 1) Click "Keep anyway" on the stale draft (or Edit + re-anchor). 2) Re-confirm verdict by clicking it. 3) Click Submit Review. 4) In dialog: write a PR-level summary, confirm verdict, click Confirm Submit. 5) Open the PR on github.com.
**Expected:** Submit pipeline runs: pending review created → threads attached → finalized. Toast: "Review submitted. View on GitHub →". State cleared (`pendingReviewId` and drafts gone from `state.json`). On github.com: the review appears with summary + the inline comment correctly anchored.
**Automation:** Playwright `frontend/e2e/real/s5-real-happy-path.spec.ts`; backend `tests/PRism.Web.Tests/Endpoints/SubmitEndpointsTests.cs`, `tests/PRism.Core.Tests/SubmitPipeline/...`.

## [S-12] Drafts survive app restart
**Pre:** PRism running with at least one saved draft on any PR.
**Steps:** 1) Quit PRism completely (close browser tab + kill backend). 2) Relaunch the binary. 3) Navigate back to the PR.
**Expected:** Draft is still visible at its anchor line with its body intact. `state.json` on disk contains the draft.
**Automation:** Playwright `frontend/e2e/s4-drafts-survive-restart.spec.ts`.

## [S-13] Keep-anyway draft round-trips after another reload
**Pre:** A stale draft was marked Keep-anyway (S-10 + S-11 path, before submit).
**Steps:** 1) Reload again (browser refresh). 2) Confirm the keep-anyway draft is still in `draft` status (not flipped back to stale).
**Expected:** Draft remains `draft` (not stale), submittable. The keep-anyway action is durable.
**Automation:** Playwright `frontend/e2e/s4-keep-anyway-survives-reload.spec.ts`.

## [S-14] Multi-tab consistency — draft saved in tab A appears in tab B
**Pre:** Same PR open in two browser tabs on the same machine.
**Steps:** 1) In tab A: save a new draft on a line. 2) Switch to tab B without reloading. 3) Observe the inline-comments column on the same file in tab B.
**Expected:** Tab B shows the new draft within seconds (BroadcastChannel + SSE `DraftSaved` event). No reload required. The V6 per-tab stamp gate prevents echo (tab A doesn't re-process its own event).
**Automation:** Playwright `frontend/e2e/s4-multi-tab-consistency.spec.ts`.

## [S-15] Cheatsheet overlay (?) opens, closes, preserves composer state
**Pre:** PR detail, open the inline composer with some typed text.
**Steps:** 1) Press `?` (focus should not be in composer textarea — click outside first). 2) Press `Esc` to close. 3) Re-open composer. 4) Press `Ctrl/Cmd + /` (focus inside composer textarea).
**Expected:** Step 1 opens cheatsheet overlay (non-modal). Step 2 closes it (composer body untouched). Step 4 still opens cheatsheet from inside the composer (Ctrl/Cmd+/ is the universal chord; `?` would type a literal `?` inside a textarea).
**Automation:** Playwright `frontend/e2e/cheatsheet.spec.ts`; vitest `frontend/__tests__/Cheatsheet.test.tsx`.

## [S-16] URL-paste escape hatch
**Pre:** Inbox visible.
**Steps:** 1) Paste a valid PR URL matching configured host into the input. 2) Wait for navigation. 3) Try with a URL on a different host.
**Expected:** Step 2 navigates to that PR's detail view. Step 3 surfaces inline error "This PR is on `<host>`, but PRism is configured for `<configured-host>`…".
**Automation:** vitest `frontend/__tests__/InboxPage.test.tsx` (input partial); host-mismatch path is **not** automated.

## [S-17] Settings page round-trip
**Pre:** Inbox or PR view.
**Steps:** 1) Click Settings tab in header. 2) Change theme to Dark. 3) Change accent to Amber. 4) Toggle aiPreview off. 5) Hide "Mentioned" inbox section. 6) Navigate back to Inbox.
**Expected:** All changes visible immediately (optimistic). Inbox no longer shows Mentioned section. AI placeholders (category chips, activity rail) disappear. After full reload (Ctrl/Cmd+R), all changes persist. `config.json` on disk reflects all changes.
**Automation:** Playwright `frontend/e2e/settings-flow.spec.ts`; vitest `frontend/__tests__/SettingsPage.test.tsx`.

## [S-18] Replace token — same login preserves state
**Pre:** PRism authenticated as login `pratyush`. At least one draft saved.
**Steps:** 1) Settings → Auth → Replace token. 2) Paste a different PAT that also authenticates as `pratyush` (same login). 3) Submit.
**Expected:** Validates → identity-change rule sees same login → drafts preserved → returns to Inbox. No foreign-pending modal on next submit (because no orphans cleared).
**Automation:** Playwright `frontend/e2e/replace-token-same-login.spec.ts`.

## [S-19] Replace token — different login clears pending IDs, preserves drafts
**Pre:** PRism authenticated as login `pratyush` with one PR that has a draft + a `pendingReviewId` saved (from a previously interrupted submit). Requires Recipe C (two-login PAT pair).
**Steps:** 1) Settings → Auth → Replace token. 2) Paste the Recipe-C secondary PAT (different login). 3) Submit. 4) Navigate to the PR with the prior `pendingReviewId`. 5) Click Submit.
**Expected:** Step 3: drafts preserved, `pendingReviewId`/`threadId`/`replyCommentId` cleared. Step 5: foreign-pending-review modal appears for the orphan owned by the previous login. User can Resume/Discard.
**Automation:** Playwright `frontend/e2e/replace-token-different-login.spec.ts`.

## [S-20] On-disk log writer rotates and retains
**Pre:** PRism running for at least one app launch.
**Steps:** 1) Trigger a few mutating operations (save draft, reload PR, change settings). 2) Open the logs path (Settings shows it; or `<dataDir>/logs/`). 3) Confirm a `.log` file exists with structured entries. 4) (Optional, requires waiting/clock advance) Confirm 14-day retention by checking that files older than 14 days are gone.
**Expected:** Log files contain newline-delimited entries with timestamps, levels, scrubbed sensitive fields (no PAT, no raw token). Identity-change events ARE present (carry prior + new login + draft counts per README troubleshooting).
**Automation:** Backend `tests/PRism.Web.Tests/Logging/FileLoggerProviderTests.cs` covers rotation + retention + scrubbing.

## [S-21] Closed PR — drafts retained, Submit disabled
**Pre:** A live PR with one draft. Author can close the PR from github.com.
**Steps:** 1) On github.com, close the PR (without merging). 2) Wait up to 30s for PRism's poll. 3) Observe PR view.
**Expected:** Banner appears: "This PR is now closed. Submitting a review is no longer possible." Submit button disabled with tooltip. Composer Save-draft disabled. **Drafts NOT auto-discarded.** "Discard all drafts" button appears next to Submit.
**Automation:** Playwright `frontend/e2e/s5-submit-closed-merged-discard.spec.ts`.

## [S-22] Closed PR reopened → drafts re-reconcile
**Pre:** From S-21. Reopen the PR on github.com.
**Steps:** 1) Reopen the PR. 2) Wait for poll. 3) Click Submit (if `pendingReviewId` was set previously).
**Expected:** Banner disappears. Submit re-enables. Drafts re-reconciled against current head. If orphan `pendingReviewId` exists, foreign-pending modal appears on next submit attempt.
**Automation:** Backend coverage in `tests/PRism.Web.Tests/...` (closed/merged transitions); reopen path is **not** end-to-end automated.

## [S-23] AI preview flip — placeholders appear at every slot
**Pre:** Set `ui.aiPreview = false`. Reload.
**Steps:** 1) Confirm no AI placeholders visible anywhere (no category chips on inbox rows, no activity rail, no AI summary card on Overview, no focus dots in file tree, no validator card in submit dialog, no Ask AI empty state). 2) Settings → toggle aiPreview ON. 3) Walk the inbox → a PR → its Files tab → open submit dialog.
**Expected:** Every named slot now shows its canned data. Slot positions match shipped layouts (no slot inflates the area when empty).
**Automation:** None as a single-pass walkthrough. Individual slot rendering has vitest coverage (`AiSummaryCard.test.tsx`, `ActivityRail.test.tsx`, `PreSubmitValidatorCard.test.tsx`, `AskAi.test.tsx`).

## [S-24] Layout shift on banner — none
**Pre:** PR detail loaded; banner not yet shown.
**Environment:** test-hooks (preferred — deterministic via `/test/emit-pr-updated`) OR binary (real second-machine push, waits ~30s for poll).
**Steps:** 1) Trigger a banner via either a real second-machine push **or** `POST /test/emit-pr-updated` with the PR's ref payload (requires Recipe D). 2) Compare viewport before vs after banner appears.
**Expected:** The banner appears in its reserved sticky region. Content beneath does not shift down. This is the DoD-mandated "no layout shift on banner arrival" criterion.
**Automation:** Playwright `no-layout-shift-on-banner.spec.ts`.

## [S-25] Quit + relaunch → state migration runs silently
**Pre:** PRism running with state.json at the current schema version.
**Steps:** 1) Quit PRism. 2) **Copy `<dataDir>/state.json` to outside the dataDir** (e.g., `~/Desktop/state.bak.json` or `%USERPROFILE%\Desktop\state.bak.json`) — do NOT use a `.v1.bak` or `.vN.bak` suffix inside the dataDir, the migration framework writes those itself and a collision will overwrite your backup. 3) Edit `<dataDir>/state.json` to set `"version": 1`. 4) Relaunch.
**Expected:** Backend detects v1 → walks all migration steps to current → renames the source file to `state.json.v1.bak` (inside dataDir) → starts cleanly. No errors visible. If a migration step *fails*, the `.v1.bak` is intact and the app refuses to load (per DoD).
**Restore:** After verifying: 1) Quit. 2) Delete `<dataDir>/state.json` and any `<dataDir>/state.json.v*.bak` files the migration wrote. 3) Copy your outside-the-dataDir backup back to `<dataDir>/state.json`. 4) Relaunch — the migration sees current-schema state and does nothing.
**Automation:** Backend `tests/PRism.Core.Tests/State/MigrationFrameworkTests.cs`.
**Notes:** Destructive — backup MUST live outside the dataDir or the migration's own `.vN.bak` writes will collide. Skip if you don't want to risk corrupting your real state.

---

# Part 2 — Per-surface regression sections

Numbered globally, grouped by surface. Sections §A–§X.

## §A. First-run setup + token validation

### A-1. Host field — bare host without scheme
**Pre:** Setup screen visible.
**Steps:** 1) Clear host field. 2) Type `github.com` (no scheme). 3) Blur (Tab out).
**Expected:** Field shows `https://github.com`. Inline note: "scheme assumed: https://".
**Automation:** vitest `frontend/__tests__/SetupPage.test.tsx`, partial.

### A-2. Host field — trailing slash stripped silently
**Pre:** Setup screen.
**Steps:** 1) Type `https://github.com/`. 2) Blur.
**Expected:** Trailing slash removed; no message.
**Automation:** As A-1.

### A-3. Host field — path beyond host stripped with warning
**Pre:** Setup screen.
**Steps:** 1) Type `https://github.com/foo/bar`. 2) Blur.
**Expected:** Field shows `https://github.com`. Soft warning: "path stripped: `foo/bar`".
**Automation:** As A-1.

### A-4. Host field — API URL detected with one-click corrective accept
**Pre:** Setup screen.
**Steps:** 1) Type `https://api.github.com`. 2) Blur.
**Expected:** Inline message asks to use `https://github.com` instead with a one-click accept button. Accepting it sets the field.
**Automation:** None.

### A-5. Host field — http:// gated behind explicit checkbox
**Pre:** Setup screen.
**Steps:** 1) Type `http://my-ghes-internal`. 2) Try to Continue.
**Expected:** Continue blocked. A checkbox "I'm on a trusted internal network" appears; warning about PAT clear-text. Checking it allows Continue.
**Automation:** None.

### A-6. Host field — non-HTTP scheme rejected
**Pre:** Setup screen.
**Steps:** 1) Type `ssh://github.com`. 2) Blur.
**Expected:** Inline error: "`ssh://github.com` is not a valid GitHub host. Expected `https://github.com` or your GHES host…".
**Automation:** None.

### A-7. PAT link updates live with host
**Pre:** Setup screen.
**Steps:** 1) Edit host field to a GHES host. 2) Hover the PAT link.
**Expected:** Link href updates to `<new-host>/settings/personal-access-tokens/new`.
**Automation:** None.

### A-8. About-local-data disclosure block visible — **KNOWN DRIFT**
**Pre:** Setup screen.
**Steps:** Observe. Then check `<dataDir>/state-events.jsonl` after a few mutating actions.
**Expected (current shipped state):** Disclosure block visible with the documented copy (`state-events.jsonl`, ~300 MB ceiling, opt-out via `logging.stateEvents: false`). **AND**: `state-events.jsonl` does NOT exist on disk — the forensic-log writer ships as a no-op stub in the PoC (README.md § "Recovering a lost draft" documents this gap). The general on-disk logger that shipped in PR #63 lives at `<dataDir>/logs/*.log` and is a different surface.
**When this case must be revisited:** if a future PR wires up the forensic writer (state-events.jsonl), update both the expected behavior here AND verify the Setup-screen copy still matches the actual on-disk file lifecycle.
**Automation:** None.

### A-9. Continue with token → backend validates → routes to Inbox
**Pre:** Valid PAT.
**Steps:** As S-2.
**Expected:** As S-2.
**Automation:** Playwright `cold-start.spec.ts`.

### A-10. Continue with invalid PAT → inline error
**Pre:** Setup screen.
**Steps:** 1) Paste obviously-invalid token (e.g. `ghp_xxxx`). 2) Continue.
**Expected:** Backend returns 401. Inline error: "Token rejected — check that you copied it correctly". Setup screen still visible.
**Automation:** Backend `tests/PRism.Web.Tests/Endpoints/SetupEndpointsTests.cs`.

### A-11. Continue with network unreachable
**Pre:** Disconnect from the network.
**Steps:** Paste token, Continue.
**Expected:** Inline error: "Could not reach GitHub — check your network". Setup screen still visible.
**Automation:** None.

### A-12. Fine-grained PAT with no repos selected → soft warning
**Pre:** Generate a fine-grained PAT with zero repos selected.
**Steps:** Paste, Continue.
**Expected:** Soft warning surfaced before navigation (backend probes show zero PRs in either auth/assignee/reviewer search). User can choose to continue anyway or fix the token.
**Automation:** None.

### A-13. Footer "Replace token" link navigates back to Setup
**Pre:** Logged in. (Note: in S6 this moved to Settings → Auth section; the footer link may still exist for backwards compat — verify which is shipped.)
**Steps:** Click the Replace token link.
**Expected:** Setup screen renders with the configured host pre-populated; the keychain token is cleared on Continue.
**Automation:** Playwright `frontend/e2e/replace-token-same-login.spec.ts`, `replace-token-different-login.spec.ts`.

### A-14. Token expiry mid-session → redirect to Setup with banner
**Pre:** Authenticated. Revoke the PAT on github.com.
**Steps:** Trigger any GitHub API call (reload an inbox, open a PR).
**Expected:** 401 wrapper detects → routes to Setup screen with banner: "Your token has expired. Generate a new one." Drafts and view state preserved.
**Automation:** Backend `tests/PRism.Web.Tests/...`; end-to-end flow not automated.

## §B. Inbox

### B-1. Five sections in correct order
As S-3.

### B-2. Each section is collapsible
**Steps:** Click each section header. **Expected:** Toggle collapsed/expanded. Count remains visible on header.
**Automation:** vitest `InboxSection.test.tsx`.

### B-3. All-empty inbox shows cold-start hint
**Pre:** Recipe A + PAT with no PRs anywhere.
**Expected:** Single one-line hint above sections: "Nothing in your inbox right now. Try pasting a PR URL above…".
**Automation:** vitest `InboxPage.test.tsx`, partial.

### B-4. Per-section empty placeholders match copy
**Steps:** Confirm each empty section shows its specific copy (e.g. "No reviews requested right now.", "No CI failures on your PRs — nice.").
**Automation:** vitest `InboxSection.test.tsx`.

### B-5. PR row — unread badges (new commits)
**Pre:** A PR you have already opened once. Push a commit to it from elsewhere.
**Steps:** Wait for inbox poll. Observe row.
**Expected:** Badge: "🔵 2 new commits" (or 1, etc.). First-visit suppression: if you've never opened the PR, NO badge fires (only `<New>` chip).
**Automation:** vitest `InboxRow.test.tsx`.

### B-6. PR row — unread badges (new comments)
**Pre:** Same setup, but instead a teammate comments on the PR.
**Expected:** Badge: "💬 N new comments".
**Automation:** As B-5.

### B-7. Inbox poll → banner appears on diff
**Pre:** Inbox loaded.
**Steps:** Wait up to 120s for poll cycle while changes occur upstream.
**Expected:** Banner above sections: "N new updates — Refresh." Dismissible; Refresh applies.
**Automation:** vitest `InboxBanner.test.tsx`.

### B-8. Deduplication — PR appears once across overlapping sections
**Pre:** A PR you authored that has failing CI.
**Expected:** Appears in section 5 (CI failing) only, not section 3 (Authored by me). Same for review-requested + mentioned overlap.
**Automation:** None.

### B-9. Set `inbox.deduplicate: false` → non-deduplicated behavior
**Pre:** Edit `config.json` to `"inbox": { "deduplicate": false }`.
**Steps:** Save file. Wait for hot-reload.
**Expected:** Same PR now appears in both overlapping sections.
**Automation:** None.

### B-10. Hide "Mentioned" section via Settings
As S-17 partial.

### B-11. Activity rail — visible only when `ui.aiPreview = true`
**Pre:** Settings.
**Steps:** Toggle aiPreview off then on, observe rail.
**Expected:** Rail collapses (grid → single column) when off. Reappears when on. Also: rail hidden below 1180px viewport regardless of flag.
**Automation:** vitest `ActivityRail.test.tsx`.

### B-12. URL-paste — valid same-host URL navigates
As S-16 (steps 1, 2).

### B-13. URL-paste — different-host URL rejected
As S-16 (step 3).
**Automation:** None.

### B-14. URL-paste — malformed URL inline error
**Steps:** Paste `https://github.com/foo`. **Expected:** Inline error "not a PR URL".
**Automation:** vitest `InboxPage.test.tsx`, partial.

### B-15. Token-scope mismatch — hidden PR + footer
**Pre:** PAT with limited repo scope; a PR in your inbox results that token can't access.
**Expected:** Row hidden. Footer at bottom: "Some PRs may be hidden — paste a PR URL above to access ones not in your inbox."
**Automation:** None.

### B-16. URL-paste recovery on unscoped repo
**Pre:** PAT without access to repo `acme/secret`.
**Steps:** Paste `https://github.com/acme/secret/pull/1`.
**Expected:** Backend returns 404 → toast: "your token doesn't cover this repo — update token scope at github.com/settings/tokens."
**Automation:** None.

## §C. PR detail — Overview tab + sub-tab routing

### C-1. Overview is default landing tab
**Pre:** Click any PR from inbox.
**Expected:** Overview tab active; not Files.
**Automation:** vitest `PrDetailPage.test.tsx`.

### C-2. Overview hero: AI summary slot + PR description + stats + conversation
**Steps:** Observe Overview tab on a PR with description, multiple files, multiple commits, root-level comments.
**Expected:** Hero with `<AiSummarySlot>` (null when aiPreview off; canned card when on). PR description Markdown-rendered. Stats: changed files / additions / deletions / commits. Issue-level conversation thread rendered read-only. "Review files" CTA below.
**Automation:** vitest `AiSummaryCard.test.tsx`, partial.

### C-3. "Review files" CTA switches to Files tab
**Steps:** Click CTA. **Expected:** Active tab flips to Files.
**Automation:** None.

### C-4. Sub-tab strip is sticky below header
**Steps:** Scroll PR detail. **Expected:** Sub-tabs remain visible at top.
**Automation:** None.

### C-5. Drafts tab visible (S4-shipped, enabled)
**Steps:** Click Drafts. **Expected:** Drafts list + reconciliation panel shown.
**Automation:** vitest `DraftsTab.test.tsx`.

### C-6. URL deep-link → specific sub-tab honored
**Pre:** URL with `?tab=files`.
**Expected:** Files tab opens directly.
**Automation:** None.

## §D. PR detail — Files tab, diff display, iteration tabs, Compare picker

### D-1. Files tab loads file tree + diff pane + iteration tabs
As S-4.

### D-2. Side-by-side diff with syntax highlighting (default)
**Steps:** Open any code file. **Expected:** Two columns (old/new). Shiki highlighting visible. Three lines of context per hunk.
**Automation:** vitest `DiffPane.test.tsx`.

### D-3. Unified diff toggle
**Steps:** Press `d` or click the toggle on the diff bar.
**Expected:** Switches to single-column with +/- markers.
**Automation:** vitest `DiffBar.test.tsx`.

### D-4. Word-level diff within changed lines
**Steps:** Find a line that was modified (not added/deleted). **Expected:** Inline word-level highlights distinguish unchanged from changed portions.
**Automation:** vitest `DiffPane.test.tsx`, partial.

### D-5. Whitespace changes shown as-is
**Pre:** A PR with a whitespace-only change.
**Expected:** Diff shows the line as changed with no special filtering.
**Automation:** None.

### D-6. Diff truncation banner appears when `changed_files > files.length`
**Pre:** A PR with >3000 files (rare; or simulate via `/test/...` hook if one exists).
**Expected:** Banner: "PRism shows GitHub's first N files of this diff. Full-diff support is on the roadmap. Open on github.com."
**Automation:** vitest `DiffTruncationBanner.test.tsx`.

### D-7. Iteration tab strip — All / last 3 inline / dropdown
**Pre:** PR with 5+ iterations.
**Expected:** "All changes" + Iter 3, 4, 5 inline + "All iterations ▾" dropdown with Iter 1, 2.
**Automation:** vitest `IterationTabStrip.test.tsx`.

### D-8. Per-iteration diff range correct
As S-6.

### D-9. Compare picker — pick two iterations
**Steps:** Open Compare picker; pick Iter 2 left and Iter 4 right.
**Expected:** Diff updates to `iter_2_head..iter_4_head`. Picker shows both selections.
**Automation:** vitest `ComparePicker.test.tsx`.

### D-10. Compare picker — auto-swap on reverse selection
**Steps:** Pick Iter 4 left, Iter 2 right.
**Expected:** Values silently swap. Brief "swapped" hint appears for 1s.
**Automation:** vitest `ComparePicker.test.tsx`.

### D-11. Compare picker — same iteration both sides → empty diff
**Steps:** Pick Iter 3 / Iter 3. **Expected:** "No changes between Iter X and Iter X." File tree shows zero files.
**Automation:** As D-10.

### D-12. Force-push banner on a force-pushed iteration tab
**Pre:** PR #22 (heavy amends and force-pushes).
**Expected:** On the force-pushed iteration tab: banner "This iteration includes a force-push; some changes may be upstream merges rather than author changes…".
**Automation:** None.

### D-13. ~~Right-click iteration tab → Merge / Split overrides~~ — NOT SHIPPED
**Status:** Spec'd in `docs/spec/03-poc-features.md` § "Iterations — Recovering from a misclustered iteration" but **not implemented in the PoC** as of 2026-05-28. Verified: grep for `iterationOverrides`, `Merge with previous`, `Split iteration here`, `MergeWithPrevious` returns zero hits in source files. Backlog this case until the feature ships. The fallback when clustering misclassifies is the CommitMultiSelectPicker (D-15) plus the documented `iterations.clustering-disabled = true` escape hatch.
**Automation:** None (feature not shipped).

### D-14. ~~Iteration override survives reload~~ — NOT SHIPPED
Same status as D-13.
**Automation:** None.

### D-15. 1-commit PR → CommitMultiSelectPicker fallback
**Pre:** Frozen sandbox PR #19 (single-commit).
**Expected:** No iteration tab strip. Instead, the `CommitMultiSelectPicker` UI surfaces for picking commits to diff.
**Automation:** vitest `CommitMultiSelectPicker.test.tsx`.

### D-16. Historical SHA 404 — graceful message
**Pre:** A PR whose old iteration SHAs have been GC'd by GitHub (rare).
**Expected:** "this iteration's commits are no longer available" message on that iteration tab.
**Automation:** None.

## §E. PR detail — file tree, viewed checkbox, j/k nav

### E-1. Smart-compacted directory chain
**Pre:** PR touching `src/components/diff/Foo.tsx`.
**Expected:** Single tree row `src/components/diff/` rather than three nested.
**Automation:** vitest `FileTree.test.tsx`.

### E-2. Per-directory viewed rollup live-updates
**Steps:** Toggle Viewed on a file inside a directory.
**Expected:** Parent rollup updates from `0 / 3` → `1 / 3` etc., recursively.
**Automation:** vitest `FileTree.test.tsx`.

### E-3. Collapse state resets on PR open
**Steps:** Collapse some directories. Navigate to another PR. Navigate back.
**Expected:** Tree fully expanded again.
**Automation:** vitest `FileTree.test.tsx`, partial.

### E-4. `j` / `k` keyboard nav
As S-5 (steps 1-3).

### E-5. `v` toggles viewed on focused file
**Steps:** Focus a file, press `v`. **Expected:** Checkbox toggles.
**Automation:** vitest `FilesTab.test.tsx`, partial.

### E-6. Viewed checkbox — current shipped behavior (S3 stub)
As S-5 (step 5).
**Notes:** This is a known gap. Re-confirm at each release.

### E-7. AI focus badge slot
**Pre:** aiPreview ON.
**Expected:** Canned focus dots visible on some file rows.
**Automation:** vitest `FileTree.test.tsx`, partial.

## §F. Markdown rendering for `.md` files

### F-1. `.md` opens in Rendered view by default
As S-8 (step 2).

### F-2. Rendered/Diff toggle persists per `(pr_ref, file_path)`
**Steps:** Toggle to Diff on file A. Navigate to file B. Return to file A.
**Expected:** File A still in Diff view. File B at default Rendered.
**Automation:** None.

### F-3. Mermaid diagram renders in Rendered view
As S-8 (Mermaid block).

### F-4. Mermaid parse error → inline error block, raw source shown
**Pre:** Open a `.md` with intentionally broken mermaid.
**Expected:** Block renders error message + the raw mermaid source escaped through the sanitization pipeline; surrounding rendered view stays alive.
**Automation:** None.

### F-5. Mermaid theme follows app theme on switch
**Steps:** Open a `.md` with Mermaid in Light. Switch theme to Dark via Settings.
**Expected:** Diagram re-renders in dark theme without reload.
**Automation:** None.

### F-6. GFM features rendered (tables, task lists, strikethrough)
**Pre:** A `.md` using all three.
**Expected:** All render correctly.
**Automation:** None.

### F-7. Raw HTML escaped, not executed
**Pre:** A comment body with `<script>alert(1)</script>` (or open a PR where this exists).
**Expected:** The tag renders as escaped text. No alert fires.
**Automation:** None.

### F-8. Rendering-fidelity gap acknowledged
**Steps:** Find a PR description using `<details>` / `<sub>` / `<kbd>`.
**Expected:** They render as escaped text (PoC trade-off — acceptable).
**Automation:** None.

## §G. Composer + draft persistence + reply composer + auto-save

### G-1. Click line in diff → composer opens
As S-7 (step 1).

### G-2. Click another line with non-empty composer → discard prompt
**Pre:** Composer open with text.
**Steps:** Click a different line.
**Expected:** Modal: "Discard or save current comment?".
**Automation:** vitest `InlineCommentComposer.test.tsx`.

### G-3. Esc closes empty composer silently
**Steps:** Open composer; immediately Esc. **Expected:** Closes.
**Automation:** As G-2.

### G-4. Esc with non-empty composer → discard confirm
**Steps:** Open, type, Esc.
**Expected:** Discard confirm modal.
**Automation:** As G-2.

### G-5. Ctrl/Cmd+Enter saves
**Steps:** Type, Ctrl/Cmd+Enter. **Expected:** Saves; closes; draft visible.
**Automation:** Playwright `s4-drafts-survive-restart.spec.ts`.

### G-6. Auto-save debounce 250 ms — survives Cmd+R
**Steps:** Open composer, type some text, immediately press Cmd/Ctrl+R.
**Expected:** Page reloads. Reopen the PR → composer restored at anchor with typed body (minus the last ≤250 ms on Firefox per acknowledged limitation).
**Automation:** vitest `InlineCommentComposer.test.tsx`, partial.

### G-7. Markdown live-preview toggle (default off in inline composer)
**Steps:** Open composer. **Expected:** Preview not visible. Toggle button visible. Toggle on → preview appears alongside textarea.
**Automation:** None.

### G-8. Reply to existing GitHub comment
**Pre:** PR with at least one existing comment thread.
**Steps:** Click Reply on that thread. Type. Save.
**Expected:** Reply composer opens with parent thread ID set. Saves to `draftReplies`. Visible on next reload.
**Automation:** vitest `ReplyComposer.test.tsx`.

### G-9. Drafts survive app restart
As S-12.

### G-10. PR-summary textarea (in submit dialog) — live preview always on
**Pre:** Open submit dialog.
**Expected:** Textarea + live preview rendered alongside (different default from inline composer).
**Automation:** None.

### G-11. PR-summary auto-saves on every keystroke
**Steps:** Type in summary; close dialog; reopen.
**Expected:** Text restored.
**Automation:** None.

### G-12. AI composer assistant slot hidden when capability off
**Pre:** aiPreview off.
**Steps:** Open composer.
**Expected:** No "Refine with AI ✨" button.
**Automation:** None.

### G-13. Existing comment edited on github.com → "edited" badge after reload
**Pre:** A draft reply anchored to a comment whose text gets edited remotely.
**Steps:** Edit the parent comment on github.com. Wait for poll → Reload.
**Expected:** Thread renders new body with small "edited" badge + timestamp. Reply draft remains.
**Automation:** None.

### G-14. Existing comment deleted on github.com → reply becomes stale on Reload
**Pre:** A draft reply.
**Steps:** Delete the parent comment on github.com. Reload PRism (Reload button, not browser refresh).
**Expected:** Reply flipped to `status = stale, reason = "the thread you replied to has been deleted"`. Submit blocked.
**Automation:** None (banner-on-Reload timing specifically).

## §H. Stale-draft reconciliation — matrix + edge cases + panel actions

H-1 through H-9 are the nine matrix branches from the DoD (each case sets up a single draft, advances the PR head, clicks Reload, asserts the classification). H-10 and H-11 are file-resolution edge cases (rename / delete). H-12 is the whitespace-allow-list edge case. H-13 through H-16 are reconciliation-panel UI workflow cases, not classification branches.

### H-1. Fresh — exact match at original line, no others
Classification: Fresh. Silent re-anchor. No badge.
**Automation:** Backend `tests/PRism.Core.Tests/Reconciliation/ReconciliationTests.cs` (Fresh).

### H-2. Fresh-but-ambiguous — exact at original + N others
Classification: Fresh-but-ambiguous. Re-anchor at original. Persistent badge.
**Automation:** As H-1.

### H-3. Moved — exact match elsewhere only, single
Classification: Moved. Update line_number + anchored_sha. Subtle badge "moved to line M".
**Automation:** As H-1.

### H-4. Moved-ambiguous — multiple exact matches elsewhere
Classification: Moved-ambiguous → closest line wins. Persistent badge.
**Automation:** As H-1.

### H-5. Whitespace-equivalent single match → Fresh
**Pre:** Run an auto-formatter that changes spacing on the anchored line.
Expected: Fresh (silent re-anchor).
**Automation:** As H-1.

### H-6. Whitespace-equivalent multi-match → Moved-ambiguous
**Automation:** As H-1.

### H-7. No match anywhere → Stale
**Steps:** Delete the line content entirely.
Expected: Stale. Submit blocked.
**Automation:** As H-1.

### H-8. Force-push, anchored SHA unreachable, exactly one match in new file → Moved
**Pre:** Force-push history rewrite such that the original SHA is GC'd.
Expected: Moved with persistent badge: "original commit was rewritten — re-anchored, please verify."
**Automation:** As H-1.

### H-9. Force-push, anchored SHA unreachable, multiple matches → Stale
Expected: Stale (multi-match without original line tie-breaker is too risky).
**Automation:** As H-1.

### H-10. File renamed via `renamed` status
**Pre:** Push a rename of the file.
Expected: Draft's file_path updated silently to new path. Continue to step 2 against new path.
**Automation:** As H-1.

### H-11. File deleted
Expected: Stale with reason "file deleted". Submit blocked.
**Automation:** As H-1.

### H-12. Whitespace allow-list — `.py` file changes treated as exact-only
**Pre:** Anchor on a `.py` line. Auto-format changes spacing.
Expected: Treated as no-match → Stale (conservative default).
**Automation:** Backend `tests/PRism.Core.Tests/Reconciliation/WhitespaceAllowListTests.cs` covers the allow-list table exhaustively; manual re-walk is low-value unless the table itself changed.

### H-13. Reconciliation panel — Show me / Edit / Delete / Keep anyway
**Steps:** Apply each action on a stale draft.
Expected: Show me scrolls + shows side-by-side; Edit opens composer; Delete discards; Keep anyway flips status to `draft`.
**Automation:** Playwright `s4-keep-anyway-survives-reload.spec.ts` covers Keep-anyway.

### H-14. "Discard all stale drafts" header action
**Steps:** With N≥1 stale drafts and replies, click "Discard all N stale drafts".
Expected: Confirmation modal with count + sample (first three bodies, labeled `[thread on …]` or `[reply on …]`). On confirm: all stale drafts AND stale replies cleared. Submit re-enables if no other blocker.
**Automation:** None.

### H-15. Fresh-but-ambiguous + Moved-ambiguous do NOT block submit
**Expected:** Badges persist but Submit enabled.
**Automation:** Backend `tests/PRism.Core.Tests/Reconciliation/SubmitBlockingTests.cs`; manual re-walk is low-value unless the blocking rules changed.

### H-16. Keep-anyway durability across reload
As S-13.

## §I. Verdict re-confirmation + banner-detected head_sha drift

### I-1. Verdict set → push new commit → click Reload → verdict flipped to needs-reconfirm
**Pre:** Verdict = Approve, on head_sha A. Push commit to advance head to B.
**Steps:** Wait for banner → Reload.
**Expected:** verdict.status = needs-reconfirm. Submit blocked.
**Automation:** Backend.

### I-2. Verdict re-confirm by single click re-enables submit
**Steps:** Click the verdict (Approve). **Expected:** status flips back to `confirmed`. Submit enables (assuming no other blocker).
**Automation:** None.

### I-3. Submit blocked when banner up (head_sha drift detected)
**Pre:** Banner up; verdict set; no Reload clicked yet.
**Steps:** Try Submit.
**Expected:** Submit button disabled with tooltip: "Reload first — there are commits you haven't seen yet." Clicking the button or tooltip focuses the banner.
**Automation:** Backend partial; UI tooltip not automated.

### I-4. Comment / Approve / Request changes — only `head_sha` triggers re-confirm
**Pre:** Verdict set; a teammate adds a comment (not a commit).
**Expected:** No re-confirm flip. Verdict still confirmed.
**Automation:** None.

## §J. Submit pipeline — happy paths

### J-1. Empty-pipeline finalize: verdict=Comment + summary only, no threads/replies
As [S-11] but with no inline drafts and no replies; only a summary + Comment verdict.
**Expected:** Pipeline runs steps 1 and 5 only. GraphQL accepts.
**Automation:** Playwright `s5-submit-happy-path.spec.ts` partial; backend `tests/PRism.Core.Tests/SubmitPipeline/EmptyFinalize_Tests.cs`.

### J-2. Submit with verdict + drafts + summary (full happy path)
As [S-11].
**Automation:** Playwright `s5-real-happy-path.spec.ts`.

### J-3. Replies-only review (verdict=Comment + replies + no new threads + any summary)
**Pre:** Drafts contain only replies; no new threads.
**Expected:** Submit enabled. Pipeline runs steps 1, 4, 5.
**Automation:** None.

### J-4. Empty PR (no commits) + verdict=Comment + summary
**Pre:** A PR that has no commits beyond base (rare). Set verdict=Comment + summary.
**Expected:** Submit enabled. Pipeline finalize succeeds.
**Automation:** vitest `EmptyPrPlaceholder.test.tsx`.

### J-5. Submit dialog — pre-selected verdict when none in header
**Pre:** No verdict in header.
**Steps:** Click Submit.
**Expected:** Dialog opens with verdict picker pre-selected to `Comment`.
**Automation:** None.

### J-6. Submit dialog — confirm with verdict picker change inside dialog
**Steps:** Open dialog, change pre-selected Comment to Approve, Confirm.
**Expected:** Pipeline submits with event=APPROVE.
**Automation:** None.

### J-7. Submit succeeds → drafts cleared from state.json
**Steps:** Inspect `state.json` after a successful submit.
**Expected:** `draftComments`, `draftReplies`, `pendingReviewId`, `draftSummaryMarkdown` all cleared for this PR.
**Automation:** Backend.

### J-8. "View on GitHub →" link in success toast
**Steps:** Click the link.
**Expected:** Opens the new review URL on github.com.
**Automation:** None.

## §K. Submit pipeline — failure recovery

**Section pre-condition.** K-1 through K-12 mostly rely on test hooks (`/test/submit/inject-failure`, `/test/submit/seed-pending-review`, `/test/submit/hold`, `/test/submit/release-hold`) that are env-gated to `ASPNETCORE_ENVIRONMENT=Test` (see `PRism.Web/TestHooks/TestEndpoints.cs:109`). Run cases tagged `Environment: test-hooks` only with [Recipe D](#recipe-d-test-hooks-enabled-build) active; otherwise `FakeReviewSubmitter` is not registered and the hooks return 404/503. Cases that *can* be reproduced without hooks via a live GitHub PR are tagged with an additional `binary` option and use [Appendix § Throwaway PR recipe](#throwaway-pr-recipe).

### K-1. Retry from step 1 — pending review creation failed
**Environment:** test-hooks.
**Pre:** Recipe D active. Have one PR with a draft.
**Steps:** 1) `POST /test/submit/inject-failure` with `{ "methodName": "AddPullRequestReview", "message": "simulated network drop", "afterEffect": false }`. 2) Click Submit; confirm error. 3) `POST /test/submit/inject-failure` with `{ "methodName": "" }` to clear. 4) Retry Submit.
**Expected:** Step 2: no `pendingReviewId` saved. Step 4: retry runs step 1 successfully.
**Automation:** Playwright `s5-submit-retry-from-each-step.spec.ts`.

### K-2. Retry from step 2 — addPullRequestReviewThread failed mid-batch
**Environment:** test-hooks.
**Pre:** Recipe D + a PR with ≥3 drafts.
**Steps:** Inject failure with `{ "methodName": "AddPullRequestReviewThread", "afterEffect": true }` (failure fires AFTER the mutation lands server-side, simulating a lost response). Submit; clear; retry.
**Expected:** `pendingReviewId` saved; partial threads have `threadId` stamped. Retry skips stamped, posts unstamped — no duplicates.
**Automation:** As K-1.

### K-3. Lost-response window — marker adoption
**Environment:** test-hooks.
**Pre:** Recipe D + `/test/submit/seed-pending-review` to construct a fake pending review where one server thread's body contains `<!-- prism:client-id:<draft.id> -->` matching an unstamped local draft.
**Expected:** Retry's pre-reconciliation finds the server thread via the marker, adopts the server's thread ID into the draft, no duplicate created.
**Automation:** Playwright `s5-submit-lost-response-adoption.spec.ts`.

### K-4. Composer marker-prefix collision → rejected on PUT /draft
**Pre:** Type a draft body containing `<!-- prism:client-id:...`.
**Steps:** Save.
**Expected:** Backend rejects with 400; UI surfaces an inline error guiding the user away from the reserved marker.
**Automation:** Playwright `s5-marker-prefix-collision.spec.ts`.

### K-5. Foreign-pending-review modal — Resume path
**Environment:** test-hooks (preferred — deterministic) OR binary (live PR — open the PR on github.com in another browser, click "Start a review", add an inline comment, leave it pending; PRism's `pendingReviewId` should not match).
**Pre:** Recipe D + `/test/submit/seed-pending-review` constructs a fake foreign pending review with N threads + M replies. OR live-PR path per Environment line.
**Steps:** Submit → modal appears with "{N} threads, {M} replies". Click Resume.
**Expected:** Foreign threads imported as drafts into `draftComments` with their server-side IDs stamped. User reviews + edits before final submit. TOCTOU defense: backend re-fetches Snapshot B before acting.
**Automation:** Playwright `s5-submit-foreign-pending-review.spec.ts`; real-flow `s5-real-foreign-pending-review.spec.ts`.

### K-6. Foreign-pending-review modal — Discard path
**Steps:** Click Discard. **Expected:** Orphan deleted via `deletePullRequestReview`. `pendingReviewId` cleared. Pipeline restarts with no pending review.
**Automation:** As K-5.

### K-7. Foreign-pending-review modal — Cancel path
**Steps:** Click Cancel. **Expected:** Dialog closes. No server-side mutation. State unchanged.
**Automation:** As K-5.

### K-8. TOCTOU — foreign pending review changes between modal open and choice
**Pre:** Trigger modal. From github.com browser tab, submit or delete the pending review while PRism's modal is open. In PRism, click Resume or Discard.
**Expected:** Toast: "Your pending review state changed during the prompt. Please retry submit." No server-side mutation runs.
**Automation:** Backend.

### K-9. Stale `commitOID` retry — discard, clear stamps, recreate
**Environment:** test-hooks (preferred) OR binary (live PR).
**Pre:** Recipe D + `/test/submit/seed-pending-review` with a `commitOid` that no longer matches the PR's current head. OR live-PR path: submit step 1 succeeded with commitOID=A; push to advance head to B; retry.
**Expected:** Detect mismatch → `deletePullRequestReview` on stale pending review → clear `pendingReviewId` + `pendingReviewCommitOid` + every draft's `threadId`/`replyCommentId` → re-run pipeline from step 1.
**Automation:** Playwright `s5-submit-stale-commit-oid.spec.ts`; real-flow `s5-real-stale-commit-oid.spec.ts`.

### K-10. Stale commitOID — Recreate-and-resubmit button when not Reloaded
**Pre:** Banner up + stale commitOID detected; user hasn't clicked Reload.
**Expected:** "Recreate and resubmit" button disabled until Reload.
**Automation:** As K-9 partial.

### K-11. Foreign-author thread deletion mid-retry → reply demoted to stale
**Pre:** Draft reply targeting thread T. Between attempts, T's author deletes T on github.com. Retry.
**Expected:** `addPullRequestReviewThreadReply` returns 404/422 → reply.status = stale with reason "parent thread deleted". Submit blocked.
**Automation:** None.

### K-12. Per-PR submit lock — simultaneous submit from two tabs
**Environment:** test-hooks (recommended for determinism — `/test/submit/hold` holds the first submit; `/test/submit/release-hold` frees it) OR binary (race two tabs manually).
**Pre:** Same PR open in two tabs.
**Steps:** Manual: click Submit in both within ~1s. Deterministic: tab A submits while you `POST /test/submit/hold`; tab B clicks Submit (should be blocked); `POST /test/submit/release-hold` frees tab A.
**Expected:** First click acquires lock; second tab sees in-flight indicator (toast or banner) and is blocked. After first completes, second sees fresh state.
**Automation:** Playwright `s5-multi-tab-simultaneous-submit.spec.ts`.

### K-13. Closed/merged PR bulk-discard + orphan cleanup
As [S-21] + clicking Discard all drafts.
Expected: Local cleanup always succeeds. If `deletePullRequestReview` on the orphan fails, toast: "Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR."
**Automation:** Playwright `s5-submit-closed-merged-discard.spec.ts`.

### K-14. Submit button disabled rules — exhaustive
For each rule (a)-(f) in spec §6 "Submit Review button", set up the conditions, observe the button is disabled with the matching tooltip.
**Automation:** Backend partial; UI tooltips not automated.

## §L. Closed / merged PR handling

### L-1. PR closed mid-review → banner + Submit disabled + composer Save disabled
As [S-21].

### L-2. Open composer on closed PR — typing not persisted; banner inside composer
**Steps:** Open composer on a closed PR. Type. Reload.
**Expected:** Typed text NOT saved. Banner inside composer: "PR closed — text not saved".
**Automation:** None.

### L-3. Closed PR — j/k, viewed checkbox, markdown toggle still work
**Expected:** All read-only navigation intact.
**Automation:** None.

### L-4. PR reopens → banner clears + Submit re-enables
As [S-22].

### L-5. Merged PR — banner copy differs ("merged" instead of "closed")
**Steps:** Merge a PR with a draft.
**Expected:** Banner: "This PR is now merged. Submitting a review is no longer possible."
**Automation:** As L-1.

### L-6. Discard-all-drafts on closed PR — local-always-succeeds
As K-13.

## §M. Banner update model

### M-1. Active PR banner appears on `head_sha` change
As S-9 + S-24.
**Automation:** Playwright `no-layout-shift-on-banner.spec.ts`; vitest `BannerRefresh.test.tsx`.

### M-2. Active PR banner appears on `comment_count` change
**Steps:** Teammate comments on PR.
**Expected:** Banner with "N new comments".
**Automation:** None.

### M-3. Active PR banner — Reload runs reconciliation
As S-9 (step 3).

### M-4. Active PR banner — dismissible without Reload
**Steps:** Click X on banner.
**Expected:** Banner closes. Marks not advanced.
**Automation:** vitest `BannerRefresh.test.tsx`.

### M-5. Reload does NOT advance `lastViewedHeadSha` / `lastSeenCommentId`
**Pre:** Banner up.
**Steps:** Reload. Quit PRism. Relaunch.
**Expected:** On Inbox, the same PR still shows the unread badge (Reload did not advance the marks).
**Automation:** None.

### M-6. Marks advance only on PR-detail mount
**Steps:** Open PR (mount). Quit. Relaunch.
**Expected:** Marks now match the head at mount time. Unread badges cleared.
**Automation:** Backend.

### M-7. In-flight composer when banner arrives → modal
As §G + spec § 3 "In-flight composer when the banner arrives".
**Expected:** Modal: "Save as draft, discard, or cancel reload?" Default action: Save.
**Automation:** None (modal flow).

### M-8. Empty composer when banner arrives → reload proceeds without prompt
**Steps:** Open composer; don't type; click Reload.
**Expected:** Composer closes; Reload runs.
**Automation:** None.

### M-9. Inbox banner — appears after 120s poll on diff
As B-7.

### M-10. Only one banner per PR view
**Steps:** Cause two consecutive updates without dismissing the first.
**Expected:** Single banner stays, updated with combined summary ("1 new commit, 2 new comments").
**Automation:** None.

## §N. Keyboard shortcuts

For each shortcut from spec § 9, run the case below. Where context matters, run twice (in-context and out-of-context).

### N-1. `j` / `k` in file tree
As E-4.

### N-2. `v` toggles viewed on focused file
As E-5.

### N-3. `n` / `p` step through comment threads on current file
**Steps:** Press `n` then `p`. **Expected:** Focus moves between threads.
**Automation:** None.

### N-4. `c` opens composer on focused line
**Steps:** Focus a line, press `c`. **Expected:** Composer opens.
**Automation:** None.

### N-5. `Esc` in non-empty composer → discard confirm
As G-4.

### N-6. `Ctrl/Cmd + Enter` in composer saves
As G-5.

### N-7. `Ctrl/Cmd + Enter` in submit dialog confirms
**Steps:** Open submit dialog; ensure Confirm button focused; press Ctrl/Cmd+Enter.
**Expected:** Dialog confirms.
**Automation:** None.

### N-8. `Ctrl/Cmd + R` / `F5` reload — overrides browser
**Steps:** Press Ctrl/Cmd+R from PR detail.
**Expected:** Reload runs (banner reconciliation if banner present). Auto-save debounce may lose ≤250 ms (Firefox).
**Automation:** None.

### N-9. `?` opens cheatsheet outside text inputs
As S-15 (step 1).

### N-10. `?` inside textarea types literal `?`
**Steps:** Click into composer textarea, press `?`. **Expected:** `?` typed in body. Cheatsheet does NOT open.
**Automation:** vitest `Cheatsheet.test.tsx`.

### N-11. `Ctrl/Cmd + /` opens cheatsheet from anywhere including composer
As S-15 (step 4).

### N-12. Esc precedence — cheatsheet first, then composer
**Pre:** Composer open + cheatsheet open.
**Steps:** Press Esc.
**Expected:** Cheatsheet closes; composer untouched. Press Esc again → composer dismisses per its own rule.
**Automation:** vitest `Cheatsheet.test.tsx`.

### N-13. Cheatsheet open + Ctrl/Cmd+R → reload runs, cheatsheet stays
**Steps:** Open cheatsheet. Press Ctrl/Cmd+R.
**Expected:** PR/inbox reloads beneath; cheatsheet remains open.
**Automation:** None.

### N-14. Closing cheatsheet preserves composer content + focus
**Pre:** Composer with text + cheatsheet open.
**Steps:** Close cheatsheet.
**Expected:** Composer body still has text; DOM focus restored to where it was.
**Automation:** vitest `Cheatsheet.test.tsx`.

## §O. Settings page

### O-1. Settings tab — four sections rendered
**Sections:** Appearance, Inbox sections, Connection, Auth.
**Automation:** Playwright `settings-flow.spec.ts`.

### O-2. Theme cycle (light / dark / system)
**Steps:** Cycle through values.
**Expected:** App theme updates instantly. Shiki + Mermaid re-themed.
**Automation:** Playwright + vitest `HeaderControls.test.tsx`.

### O-3. Accent picker (indigo / amber / teal)
As O-2 for accent.

### O-4. aiPreview toggle
As O-2 for aiPreview.

### O-5. Inbox section visibility toggles
**Steps:** Hide one section. Navigate to Inbox.
**Expected:** Section gone. Reflect on `config.json`.
**Automation:** Playwright `settings-flow.spec.ts`.

### O-6. Connection — GitHub host, config path, logs path with copy
**Steps:** Click copy buttons.
**Expected:** Path copied to clipboard.
**Automation:** vitest `ConnectionSection.test.tsx`.

### O-7. Auth — Replace token link → Setup screen
As A-13.

### O-8. Optimistic save with rollback on error
**Pre:** No /test/* hook exists for the preferences PATCH; reproduction requires code-modifying the ConfigStore PATCH handler to fail temporarily, OR running on a corrupted `config.json` (force file-write failure). Practical manual exercise: this case is effectively covered by the automated vitest; manual re-walk is low value unless the rollback path is rewritten.
**Steps:** As above; or skip.
**Expected:** UI optimistically flips. On 500 → rolls back to prior value + error toast.
**Automation:** vitest `usePreferences.test.tsx`.

### O-9. `'success'` toast auto-dismisses
**Steps:** Save any setting successfully.
**Expected:** Brief success toast that fades.
**Automation:** vitest `Toast.test.tsx`.

### O-10. config.json hand-edit hot-reloads
**Steps:** Quit Settings page. Edit `config.json` directly. Save (rename-and-replace via VS Code).
**Expected:** Within 250 ms debounce, the new config is in effect (theme/accent/etc. update without restart).
**Automation:** Backend `tests/PRism.Web.Tests/Config/FileSystemWatcherTests.cs`.

### O-11. Invalid config with last-good in memory → non-blocking toast
**Steps:** Edit `config.json` to invalid JSON. Save.
**Expected:** Toast: "config.json invalid — last good config still active." App continues.
**Automation:** Backend.

### O-12. Invalid config on cold load → fall back to defaults + different toast
**Steps:** Quit. Corrupt `config.json`. Relaunch.
**Expected:** Backend logs parse error; falls back to documented defaults; toast: "config.json could not be parsed; defaults are in effect…".
**Automation:** Backend.

## §P. Identity-change rule (Replace token)

### P-1. Same login → drafts + GraphQL stamps preserved
As S-18.

### P-2. Different login → drafts preserved, threadId/replyCommentId/pendingReviewId cleared
**Pre:** Recipe C (two-login PAT pair).
Steps and Expected: as S-19.

### P-3. Submit on PR with orphan after different-login replace → foreign-pending modal
**Pre:** Recipe C.
As S-19 step 5.

### P-4. IdentityChanged SSE event fires
**Pre:** Recipe C. PRism open in two tabs. Replace token to a different login in tab A.
**Expected:** Tab B receives `IdentityChanged` SSE event and either reloads or shows a banner.
**Automation:** vitest `events-handshake.test.tsx`, partial.

### P-5. Replace token while submit in flight → blocked
**Environment:** test-hooks (the in-flight hold is non-deterministic without `/test/submit/hold`).
**Pre:** Recipe D active. A submit pipeline held mid-flight via `POST /test/submit/hold`.
**Steps:** Try Replace token.
**Expected:** Replace blocked with explanation (in-flight submit lock). Release with `POST /test/submit/release-hold` to clean up.
**Automation:** Playwright `replace-token-submit-in-flight.spec.ts`.

## §Q. Multi-tab consistency — V6 stamps, BroadcastChannel, draft echo

### Q-1. Draft saved in tab A appears in tab B
As S-14.

### Q-2. Per-tab stamp (V6 `TabStamps` map) prevents echo
**Pre:** Tab A saves draft.
**Expected:** Tab A does NOT re-process its own broadcast (suppressed by stamp). Tab B processes and renders.
**Automation:** Backend / vitest hooks.

### Q-3. Monotone stamp guard rejects out-of-order broadcasts
**Automation:** Backend.

### Q-4. Cross-tab settings change propagates
**Pre:** Two tabs.
**Steps:** Change theme in tab A.
**Expected:** Tab B updates.
**Automation:** None.

### Q-5. Concurrent submit from two tabs (per-PR lock)
As K-12.

## §R. Error handling

### R-1. Network error during GitHub call → toast + Retry button
**Pre:** Disconnect network. Trigger any API call.
**Expected:** Toast with Retry. Clicking Retry re-runs the call.
**Automation:** None.

### R-2. 429 with X-RateLimit-Reset → polling paused
**Pre:** No /test/* hook exists for simulating GitHub 429; reproducing naturally requires actually exhausting the Search API rate budget (30 req/min). Manual path: switch to a fresh PAT, hammer URL-paste with many distinct repo URLs to burn through the budget, observe banner. Practically this case is covered by backend tests; manual re-walk is low value.
**Expected:** Toast: "Polling paused until HH:MM (rate limit). Active operations will resume automatically."
**Automation:** Backend.

### R-3. 429 without X-RateLimit-Reset → exponential backoff capped at 5 min
**Automation:** Backend.

### R-4. 404 on PR → friendly message
**Steps:** Navigate to a deleted PR URL.
**Expected:** "This PR no longer exists or your token doesn't cover this repo."
**Automation:** None.

### R-5. 401 mid-composer → suppress redirect, save composer, banner
**Pre:** Composer open with text. Revoke PAT on github.com.
**Steps:** Trigger any polled API call.
**Expected:** Composer body force-flushed to `state.json`. Banner: "Token expired — reauthenticate to continue (your draft is saved)." Setup screen opens as MODAL overlay (not navigation). After re-auth, modal closes; composer restored.
**Automation:** None.

### R-6. 401 elsewhere — `/user` succeeds → scope-mismatch banner
**Steps:** Hit an endpoint with insufficient scope.
**Expected:** Banner: "Your token doesn't cover this repo. Update token scope at github.com/settings/tokens."
**Automation:** Backend.

### R-7. 401 elsewhere — `/user` 401, `/rate_limit` 200 → missing read:user scope banner
**Steps:** Use a classic PAT without `read:user`.
**Expected:** Banner: "Your token is missing `read:user` scope and the requesting endpoint scope…".
**Automation:** Backend.

### R-8. 401 elsewhere — `/user` 401, `/rate_limit` 401 → genuine expiry, navigate to Setup
**Automation:** Backend.

### R-9. 401 disambiguation probe rate-limited → uncertain toast, no redirect
**Automation:** Backend.

### R-10. Unhandled exception → toast with Copy diagnostics
**Steps:** No `/test/*` hook for client-side error injection. Manual path: edit `App.tsx` in dev-server mode to throw inside a route render and reload; OR rely on the vitest's coverage of the error boundary path.
**Expected:** "Something went wrong" toast; Copy diagnostics copies a useful payload.
**Automation:** vitest `error-boundary.test.tsx`.

## §S. Cross-platform

**Section pre-condition.** §S spans both supported platforms (Windows x64 + macOS Apple Silicon). A complete §S pass requires physical access to *both* platforms — the trust-prompt and keychain cases cannot be reasonably simulated. A pre-release pass on a single platform must explicitly skip the cases tagged `Platform: macOS` (if you're on Windows) or `Platform: Windows` (if you're on macOS), and the cross-machine cases must wait for a separate pass on the missing platform. Cases not tagged are platform-agnostic and can run on either.

### S/1. Windows SmartScreen first-run trust copy
**Platform:** Windows. **Environment:** binary.
**Pre:** Fresh download of `PRism-win-x64.exe`.
**Steps:** Double-click. **Expected:** "Windows protected your PC" dialog. More info → Run anyway path matches README copy.
**Automation:** None.

### S/2. macOS Gatekeeper first-run trust copy
**Platform:** macOS. **Environment:** binary.
**Pre:** Fresh download of `PRism-osx-arm64` + executable bit set via `chmod +x`.
**Steps:** Double-click. **Expected:** "PRism cannot be opened because…" dialog. Right-click → Open → Open path works.
**Automation:** None.

### S/3. macOS Keychain "Always Allow" prompt on first token read
**Platform:** macOS. **Environment:** binary.
**Steps:** As S/2 then walk through token paste → Inbox.
**Expected:** Keychain prompt during step that reads the token. "Always Allow" works; no future prompt on relaunch.
**Automation:** None.

### S/4. Backend port-walk 5180-5199
**Platform:** either. **Environment:** binary (port-walk is suppressed in Test env).
**Pre:** Listen on 5180 from another process.
**Steps:** Launch PRism.
**Expected:** Backend picks next free port; browser opens to it.
**Automation:** Backend.

### S/5. FileSystemWatcher honors rename-and-replace (VS Code, vim default, IntelliJ)
**Platform:** either; behavior differs subtly between platforms (macOS/Linux fire Renamed instead of Changed). Test on the platform you're shipping on.
**Steps:** Edit `config.json` with each editor; save.
**Expected:** Hot-reload fires within 250 ms (subscribes to both Changed and Renamed events).
**Automation:** Backend.

### S/6. Single-file publish profile — win-x64
**Platform:** Windows artifact validation; the workflow runs on a Linux runner, so the *workflow* itself runs anywhere.
**Steps:** Run `publish.yml` workflow_dispatch with tag `v0.1.x` (dry run, draft release).
**Expected:** `.exe` artifact in release. Sized comparable to prior tag.
**Automation:** GitHub Actions `publish.yml`.

### S/7. Single-file publish profile — osx-arm64
**Platform:** macOS artifact validation. **Steps:** Same workflow.
**Expected:** Binary artifact in release.
**Automation:** As S/6.

### S/8. File paths — Environment.SpecialFolder resolution (no hardcoded `%APPDATA%` / `~/...`)
**Platform:** both (must verify on each separately for full coverage).
**Steps:** Inspect `<dataDir>` on the platform you're testing.
**Expected:** Windows: `%LOCALAPPDATA%\PRism`. macOS: `~/Library/Application Support/PRism`.
**Automation:** Backend.

### S/9. Token storage via MSAL extensions (DPAPI Windows / Keychain macOS)
**Platform:** both (verify on each separately).
**Expected:** Token persists across restarts on the tested platform.
**Automation:** Backend.

## §T. State migration

### T-1. v1 → v2 (S3 ViewedFiles)
As S-25 (with downgrade to v1).

### T-2. v2 → v3 (S4 stale-draft fields)
As above for v2.
**Automation:** Backend.

### T-3. v3 → v4 (S6 multi-account scaffold)
As above for v3.
**Automation:** Backend.

### T-4. v4 → v5 (cross-tab stamp poisoning V5)
As above.
**Automation:** Backend.

### T-5. v5 → v6 (per-tab TabStamps)
As above.
**Automation:** Backend `tests/PRism.Core.Tests/State/MigrationV5ToV6Tests.cs`.

### T-6. Failing migration → backup intact, refuse to load
**Pre:** Corrupt the migration's output mid-write (hard to simulate; might need a test-only failure-injection seam).
**Expected:** `state.json.v{n}.bak` intact. App refuses to load, logs explain.
**Automation:** Backend.

### T-7. Token cache v0 → v1 (single-string → versioned `{tokens: {default: ...}}`)
**Pre:** Manually craft a v0 token blob in keychain (DPAPI on Windows, Security framework on macOS — both require platform-specific tooling).
**Steps:** Launch.
**Expected:** Migration runs; no token re-prompt.
**Automation:** Backend.
**Notes:** Hard to reproduce manually; backend tests cover the migration path. Manual re-walk only when the token-cache schema changes.

### T-8. Downgrade-block on token cache version mismatch
**Pre:** A token cache from a future PRism version (requires synthesizing a v2+ blob by hand).
**Expected:** Refuse to read; safe message.
**Automation:** Backend.
**Notes:** Same hard-to-reproduce caveat as T-7.

## §U. AI placeholder behavior

**This section is intentionally empty.** All aiPreview behavior is covered by other cases — see [S-23] (toggle off/on walk-through across every slot), [B-11] (activity rail visibility on toggle), [O-4] (Settings-page aiPreview toggle), [O-2 / O-3 / O-4] (header pop-out vs Settings parity for theme/accent/aiPreview), and [U-3 retained note below] for hot-reload semantics.

The earlier U-1..U-4 enumeration was pure back-reference to the cases above; it was deleted to avoid the false impression that aiPreview-specific coverage is missing.

### U-3 (retained). Toggle flip — no full reload required
**Steps:** Toggle aiPreview in Settings.
**Expected:** Placeholders appear/disappear without page reload (config hot-reload + capability re-fetch). This is the one behavior not subsumed by [S-23] or [O-4] — it asserts the hot-reload-without-page-reload path specifically.
**Automation:** vitest `header-controls.test.tsx`, partial.

## §V. Accessibility baseline

### V-1. Semantic landmarks
**Tool:** axe DevTools or browser inspector.
**Expected:** `<header>`, `<main>`, `<nav>` present in DOM at expected positions.
**Automation:** Playwright `a11y-audit.spec.ts`.

### V-2. All icon-only buttons have ARIA labels
**Tool:** axe DevTools.
**Automation:** As V-1.

### V-3. File tree keyboard-navigable
As E-4 + arrow keys + Enter.
**Automation:** Playwright `a11y-audit.spec.ts`.

### V-4. Focus rings visible
**Steps:** Tab through interactive elements with keyboard.
**Expected:** Visible focus indicator on every focusable element.
**Automation:** None.

### V-5. Color contrast WCAG AA
**Tool:** axe DevTools / WAVE.
**Automation:** Playwright `a11y-audit.spec.ts`.

### V-6. Unread badges have screen-reader-only labels
**Tool:** Inspect; screen-reader test (VoiceOver / NVDA).
**Expected:** Badges announce as "3 new commits" not "3".
**Automation:** vitest `InboxRow.test.tsx`.

### V-7. Cheatsheet a11y — non-modal, focus management
**Pre:** Composer open + Cheatsheet opens.
**Expected:** Cheatsheet does not trap focus; closing returns focus to composer position.
**Automation:** Playwright `cheatsheet.spec.ts`.

## §W. On-disk logger

### W-1. Log file written on startup
As S-20 (step 1-3).

### W-2. Rotation
**Steps:** Generate enough log volume to trigger rotation (or wait midnight if rotation is daily).
**Expected:** New file created; old file closed cleanly.
**Automation:** Backend `tests/PRism.Web.Tests/Logging/FileLoggerProviderTests.cs`.

### W-3. Retention — 14 days
**Steps:** Set system clock or seed older log files; relaunch.
**Expected:** Files >14 days old deleted.
**Automation:** Backend.

### W-4. Sensitive-field scrubbing
**Steps:** Trigger a log line that would otherwise contain a token or PAT.
**Expected:** Field replaced with `***` or similar via `ScrubFieldName`.
**Automation:** Backend.

### W-5. Login blocklist
**Steps:** Trigger an identity-change log entry.
**Expected:** Login present (intended); other PII fields scrubbed.
**Automation:** Backend.

### W-6. Logs path visible in Settings → Connection
As O-6.

## §X. Stale-OID + pr-updated SSE wire fix

### X-1. Stale-OID banner correctly fires when PR head advances behind a stale draft
**Pre:** Use real-flow stale-OID fixture (PR #7 on prpande/PRism).
**Steps:** Per spec — open the PR with PRism, simulate the stale-OID condition via the real-flow harness.
**Expected:** Stale-OID banner appears (the V6 wire-fix path).
**Automation:** Playwright `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`.

### X-2. pr-updated SSE wire shape — `prRef` as object, not string
**Pre:** Tooling that subscribes to `/api/events`.
**Steps:** Trigger a pr-updated SSE event.
**Expected:** `prRef` field is an object `{ owner, repo, number }`, not a stringified `owner/repo#N`. This was the root cause of the stale-OID banner regression fixed in PR #65.
**Automation:** Backend `tests/PRism.Web.Tests/Events/SsePrUpdatedTests.cs`.

### X-3. /test/emit-pr-updated deterministic trigger works for layout-shift assertions
As S-24.

---

# Part 3 — Visual review pack (V-1..V-44)

Capture-oriented cases. Different shape from Parts 1 and 2. The intent: produce a folder of PNGs you can paste into a Claude chat with a canned per-case prompt and get useful design feedback without re-explaining the surface.

**This workflow is unvalidated as of 2026-05-28.** Run V-1 (Setup screen) end-to-end first: capture, bundle, feed to Claude with the canned prompt, evaluate whether the returned findings are useful and not noisy. If the V-1 round delivers value, continue with V-2..V-40. If it doesn't (Claude hallucinates measurements, contradicts spec-mandated decisions despite out-of-scope clauses, or produces findings that aren't actionable), revise the prompt template based on what failed before committing to the remaining 39 cases — or remove Part 3 entirely if the model doesn't pay off. The investment to write Part 3 is recoverable; the investment to *run* Part 3 against a bad prompt template is not.

## How to use Part 3

1. Pick a contiguous batch of V-cases (most chats handle 5–8 cases worth of PNGs comfortably).
2. Run each case's Setup, capture per the Viewport + Variants spec, save into a `V-N-<slug>/` folder using the variant labels as filenames.
3. Start a Claude chat. Paste the bundle of folders. For each case, paste the canned "Send-to-Claude prompt" alongside its screenshots.
4. Claude returns findings; apply, defer, or push back per the receiving-code-review skill.

Per-case shape:

```
V-N. <surface name>
   Setup: <one-line, references §A-§X case ID where applicable>
   Viewport: <1440x900 default | 1180x800 for breakpoint check>
   Capture: <single shot | sequence | grid (e.g. "6-up: theme × accent matrix")>
   Variants to shoot: <list — each becomes a PNG filename>
   Bundle as: V-N-<slug>/
   Send-to-Claude prompt: <one-paragraph evaluation brief>
```

## V-1. Setup screen variants
- **Setup:** Recipe A; pause at Setup screen.
- **Viewport:** 1440x900.
- **Capture:** Sequence of 5.
- **Variants to shoot:** empty / typed-host / typed-host-with-validation-warning / typed-PAT / post-Continue-loading.
- **Bundle as:** `V-1-setup/`.
- **Send-to-Claude prompt:** "First-run Setup screen for PRism, a local PR review tool. Evaluate: visual hierarchy of the host field vs PAT textarea vs Continue button; clarity of the validation inline messages (warning / error / corrective accept); whether the About-local-data block is appropriately weighted (visible but not alarming); whether the Continue button's loading state communicates clearly. Out of scope: the PAT link copy (already user-tested), the specific permission list text (spec-mandated). Look for: alignment issues, cramped spacing, unclear field affordances, unintentional visual weight on warnings."

## V-2. Inbox — all five sections populated
- **Setup:** As [S-3].
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** populated.
- **Bundle as:** `V-2-inbox-populated/`.
- **Send-to-Claude prompt:** "PRism inbox with five sections each populated with at least one PR row. Evaluate: section heading hierarchy, row density, badge placement, scan-ability for 'what do I need to do next'. The activity rail on the right is canned data — ignore content, evaluate placement. **Out of scope (spec-mandated, do not propose changes):** the five section names and their ordering; the per-row metadata fields (title / repo / author / age / comment count); the section-collapse-with-count affordance; the dedup default rule. Look for: rows that don't visually separate, unclear badge prominence, repo/author balance, age column readability."

## V-3. Inbox — empty (cold-start)
- **Setup:** Recipe A + B with a freshly-created GitHub account that has no PRs.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** empty.
- **Bundle as:** `V-3-inbox-empty/`.
- **Send-to-Claude prompt:** "PRism inbox with zero PRs in all five sections (the cold-start state). Evaluate: warmth of the empty-state hint, balance of the five section placeholders (some are 'good news' like 'No CI failures — nice', others are neutral; do they feel consistent in tone?). Look for: empty-state that feels broken vs feels expected; whether the URL-paste affordance reads as a recovery path."

## V-4. Inbox — banner up + scope footer
- **Setup:** [B-7] for banner + [B-15] setup for footer (token with limited scope on an account where some PRs are out of scope).
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** with-banner-and-footer.
- **Bundle as:** `V-4-inbox-banner-footer/`.
- **Send-to-Claude prompt:** "PRism inbox with the 'N new updates — Refresh' banner above sections and the token-scope footer below. Evaluate: banner prominence (visible but non-intrusive per spec), footer subtlety (acknowledged but not alarming), whether they compete for attention. Look for: visual stacking issues, banner pushing content (it shouldn't — should be in reserved sticky region)."

## V-5. Inbox — activity rail on vs off (incl. 1180px breakpoint)
- **Setup:** Settings → toggle aiPreview off, screenshot; toggle on, screenshot. Then resize browser window to 1180x800 (or narrower) with aiPreview still on; screenshot again to verify the rail collapses at the breakpoint independently of the flag.
- **Viewport:** 1440x900 for the two flag shots; 1180x800 for the breakpoint shot.
- **Capture:** Three shots.
- **Variants to shoot:** rail-off-1440 / rail-on-1440 / rail-on-1180.
- **Bundle as:** `V-5-activity-rail/`.
- **Send-to-Claude prompt:** "PRism inbox in three states: activity rail off at 1440x900 (single column); rail on at 1440x900 (two columns); rail on at 1180x800 (rail should be hidden by CSS breakpoint per spec). Evaluate: how naturally the grid collapses between the off/on states at 1440; whether the breakpoint shot collapses cleanly (no orphan gap where the rail used to be); whether the on-state's rail items have appropriate visual weight relative to the main inbox. **Out of scope:** rail content (canned); the 1180px breakpoint threshold itself (spec-mandated). Look for: column-balance issues when the rail appears or disappears; leftover empty space at the breakpoint; visual discontinuity between the two flag states."

## V-6. Inbox row badges
- **Setup:** Multiple PRs in the inbox where badges differ — one with new commits, one with new comments, one with both.
- **Viewport:** 1440x900, crop to the inbox rows specifically.
- **Capture:** Single shot.
- **Variants to shoot:** badge-variants.
- **Bundle as:** `V-6-row-badges/`.
- **Send-to-Claude prompt:** "PRism inbox rows showing different badge states (commits / comments / both). Evaluate: badge legibility at default zoom, distinction between commit dot vs comment dot, whether the right-aligned badge stack reads cleanly against the row's left-side metadata. Look for: visual collision with the age column, color-contrast issues on the dot."

## V-7. Header — three-tab nav + popout
- **Setup:** Any page. Open the header pop-out (theme/accent/aiPreview cluster).
- **Viewport:** 1440x900, crop to header band.
- **Capture:** Two shots.
- **Variants to shoot:** nav-only / popout-open.
- **Bundle as:** `V-7-header/`.
- **Send-to-Claude prompt:** "PRism app header: the three-tab nav (**Inbox / Settings / Setup** — Setup gets a `·` first-run indicator when needed; PR detail is reached by row-click and is NOT a top-level tab) plus the right-side controls popout (theme cycle, accent picker, aiPreview toggle). Evaluate: which tab reads as 'active' at a glance, popout's placement relative to its trigger, whether the cluster feels integrated or bolted on. **Out of scope (spec-mandated):** tab names, tab order, the three-tab structure itself, the Setup `·` indicator semantics. Look for: tab indicator strength, popout's shadow/elevation, alignment with the rest of the header."

## V-8. PR detail — Overview tab
- **Setup:** Open frozen sandbox PR #1.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** overview-full.
- **Bundle as:** `V-8-overview/`.
- **Send-to-Claude prompt:** "PRism PR detail — Overview tab. Hero card at top, then PR description, then stats (files / additions / deletions / commits), then issue-level conversation, then 'Review files' CTA. Evaluate: hero card weight, the rhythm down the page, whether the 'Review files' CTA is discoverable as the primary next action. Look for: vertical pacing issues, stats card vs description balance, CTA prominence."

## V-9. Overview — AI summary slot (aiPreview off vs on)
- **Setup:** Same PR. Toggle aiPreview.
- **Viewport:** 1440x900, crop to hero card.
- **Capture:** Two shots.
- **Variants to shoot:** ai-off / ai-on.
- **Bundle as:** `V-9-ai-summary/`.
- **Send-to-Claude prompt:** "PRism Overview hero card with AI summary slot off vs on. Per spec, the slot should reserve no extra space when off (no layout shift when v2 lights it up). Evaluate: whether the off-state hero feels intentionally compact or accidentally truncated; whether the on-state's canned summary feels integrated or bolted on. Look for: visible space reservation in the off state (a spec violation), or visual upheaval between the two states."

## V-10. Files tab — full layout
- **Setup:** Open frozen sandbox PR #1, Files tab.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** files-tab-full.
- **Bundle as:** `V-10-files-tab/`.
- **Send-to-Claude prompt:** "PRism Files tab — iteration tab strip at top, file tree on left, side-by-side diff pane on right. Evaluate: column proportions (does the diff get enough room?), iteration tab strip's distinction from the page header above it, file tree row density. Look for: cramped diff, file tree column too narrow/too wide, iteration tab strip blending into the header."

## V-11. File tree — smart-compacted long path
- **Setup:** A PR touching a deeply-nested file (e.g. `src/components/diff/widgets/Foo.tsx`). Use any PR with such a path; if none, create a throwaway PR.
- **Viewport:** 1440x900, crop to file tree.
- **Capture:** Single shot.
- **Variants to shoot:** smart-compacted.
- **Bundle as:** `V-11-tree-compaction/`.
- **Send-to-Claude prompt:** "PRism file tree showing smart-compacted single-child directory chains (e.g. `src/components/diff/widgets/`). Evaluate: readability of the compacted path, whether the compaction visually distinguishes from a non-compacted directory, indent rhythm. **Out of scope (spec-mandated):** the compaction algorithm itself (single-child chains collapse; compaction stops at any directory with >1 child or files directly); the per-directory viewed-rollup format (rendered separately, see V-12). Look for: path that wraps awkwardly, compacted row that looks like a regular file."

## V-12. File tree — viewed rollups at varied ratios
- **Setup:** Toggle Viewed on some files in a directory to produce 3/7, 7/7, 0/12 rollups across visible directories.
- **Viewport:** 1440x900, crop to file tree.
- **Capture:** Single shot.
- **Variants to shoot:** rollups-mixed.
- **Bundle as:** `V-12-rollups/`.
- **Send-to-Claude prompt:** "PRism file tree with per-directory viewed rollups at 3/7, 7/7, 0/12, etc. Evaluate: rollup readability against the directory name, whether 7/7 reads as 'done' visually (subtle complete state), color/weight of the count. Look for: rollups that vanish into the row, fully-viewed directory not feeling closed-out."

## V-13. Diff — side-by-side, word-level + whitespace
- **Setup:** Files tab, pick a file with a line that has word-level changes and a line with whitespace changes.
- **Viewport:** 1440x900, crop to diff pane (one hunk).
- **Capture:** Single shot.
- **Variants to shoot:** sxs-word-ws.
- **Bundle as:** `V-13-diff-sxs/`.
- **Send-to-Claude prompt:** "PRism side-by-side diff showing word-level highlights and whitespace changes (per spec, whitespace is shown as-is, not filtered). Evaluate: word-level highlight contrast, whitespace marker visibility (this is intentional truthfulness, not a bug), Shiki syntax highlighting balance with diff colors. Look for: highlight colors that clash with syntax tokens, whitespace markers that overwhelm the line."

## V-14. Diff — unified view of same hunk
- **Setup:** From V-13, toggle to unified.
- **Viewport:** 1440x900, crop.
- **Capture:** Single shot.
- **Variants to shoot:** unified.
- **Bundle as:** `V-14-diff-unified/`.
- **Send-to-Claude prompt:** "PRism unified diff view (same hunk as V-13 for comparison). Evaluate: +/- marker prominence vs syntax highlighting, line-number column readability, whether unified mode feels intentional or like a degraded side-by-side. Look for: marker columns blending into gutters."

## V-15. Diff — truncation banner
- **Setup:** A PR with >3000 files. Rare; skip if not available.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** truncated.
- **Bundle as:** `V-15-truncation/`.
- **Send-to-Claude prompt:** "PRism diff truncation banner at the bottom of the diff pane when a PR exceeds 3000 files. Evaluate: banner's visibility (user must notice), tone (helpful pointer to github.com, not failure), placement (sticky at bottom). Look for: banner that feels apologetic or buried."

## V-16. Iteration tabs — All + inline + dropdown + Compare
- **Setup:** Frozen PR #22 (heavy iterations).
- **Viewport:** 1440x900, crop to tab strip + the first row of content below it (so the Compare picker's placement relative to the diff is visible).
- **Capture:** Single shot.
- **Variants to shoot:** iter-strip.
- **Bundle as:** `V-16-iteration-strip/`.
- **Send-to-Claude prompt:** "PRism iteration tab strip: 'All changes' tab + last 3 iterations inline + 'All iterations ▾' dropdown + 'Compare ⇄' picker. The shipped layout positions the Compare picker to the right of the dropdown on the same horizontal strip. Evaluate: active-tab indicator clarity, dropdown affordance, Compare picker's visual relationship to the rest of the strip (it's a key wedge feature; the question is whether the *shipped* placement reads as available at a glance, not whether the placement itself is right). **Out of scope (spec-mandated):** the All / Last-3-inline / older-dropdown structure; the Compare picker's existence and its position on the strip (placement is decided). Look for: Compare picker reading as decorative rather than active in the *current* placement; active-tab indicator that doesn't survive a glance; dropdown affordance that doesn't communicate 'more iterations here'."

## V-17. Iteration tab — force-push banner
- **Setup:** Open the iteration tab in PR #22 that includes a force-push.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** force-push-banner.
- **Bundle as:** `V-17-force-push-banner/`.
- **Send-to-Claude prompt:** "PRism iteration view with the force-push banner on top: 'This iteration includes a force-push; some changes may be upstream merges rather than author changes…'. Evaluate: banner's weight (informational, not blocking), copy clarity, position relative to the diff. Look for: banner that reads as 'something is broken' rather than 'heads up'."

## V-18. Compare picker — swap hint + same-iteration empty
- **Setup:** Trigger auto-swap by picking Iter 4 left, Iter 2 right; capture the brief 'swapped' hint. Separately, pick Iter 3 / Iter 3.
- **Viewport:** 1440x900, crop to picker + immediate area.
- **Capture:** Two shots.
- **Variants to shoot:** swapped-hint / same-iter-empty.
- **Bundle as:** `V-18-compare-states/`.
- **Send-to-Claude prompt:** "PRism Compare picker in two states: (1) just after auto-swap with the brief 'swapped' hint visible, (2) same iteration both sides showing 'No changes between Iter X and Iter X.' Evaluate: hint legibility in the brief 1s window (capture timing matters), empty-state message tone. Look for: hint that's too fleeting to read, empty state that looks like an error."

## V-19. Markdown — Mermaid + GFM + code
- **Setup:** Frozen PR #28; open the `.md` file in Rendered view.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** md-rendered.
- **Bundle as:** `V-19-markdown-rendered/`.
- **Send-to-Claude prompt:** "PRism Rendered markdown view of a `.md` file containing a Mermaid diagram, a GFM table, and code blocks. Evaluate: Mermaid theming matches app theme, table grid weight, code block treatment (should match the diff viewer's Shiki output). Look for: Mermaid that pops out of the app's visual style, table borders that feel too heavy."

## V-20. Markdown — Rendered vs Diff toggle
- **Setup:** Same `.md` in both modes.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** rendered / diff.
- **Bundle as:** `V-20-md-toggle/`.
- **Send-to-Claude prompt:** "PRism `.md` file in Rendered view vs Diff view. Evaluate: toggle affordance (per-file persistence is a UX feature; toggle should feel natural), continuity between the two views (file tree position, line numbers in Diff). Look for: toggle that feels disconnected, jarring transition."

## V-21. Inline composer — open with markdown + preview off (default)
- **Setup:** Click a line; type markdown including a code block and a list.
- **Viewport:** 1440x900, crop to composer.
- **Capture:** Single shot.
- **Variants to shoot:** composer-default.
- **Bundle as:** `V-21-composer/`.
- **Send-to-Claude prompt:** "PRism inline comment composer with markdown body typed and live-preview default-off (compact for line-level interaction). Evaluate: composer height (kept compact per spec), Save/Discard button placement, preview toggle discoverability. Look for: composer that pushes the diff aggressively, buttons that compete."

## V-22. Reply composer
- **Setup:** PR with an existing comment thread; click Reply.
- **Viewport:** 1440x900, crop to thread + composer.
- **Capture:** Single shot.
- **Variants to shoot:** reply-composer.
- **Bundle as:** `V-22-reply/`.
- **Send-to-Claude prompt:** "PRism reply composer attached to an existing GitHub comment thread. Evaluate: visual relationship to parent thread (indented? badged?), distinction from a top-level inline composer. Look for: reply that looks like a new top-level comment, weak parent-child cue."

## V-23. Existing inline comment — multi-thread stack on one line
- **Setup:** Find or create a PR with multiple comment threads on the same line.
- **Viewport:** 1440x900, crop.
- **Capture:** Single shot.
- **Variants to shoot:** multi-stack.
- **Bundle as:** `V-23-multi-stack/`.
- **Send-to-Claude prompt:** "PRism diff with multiple existing comment threads stacked on the same line. Evaluate: thread separation, visual stacking order (chronological? newest first?), reading flow when scrolling past. Look for: threads bleeding into each other, no clear boundary."

## V-24. Reconciliation panel — every badge variant in one shot
- **Setup:** Live PR; force three drafts into different stale-classification states (Fresh-but-ambiguous, Moved, Moved-ambiguous, Stale + Discard-all action).
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** panel-all-badges.
- **Bundle as:** `V-24-reconcile/`.
- **Send-to-Claude prompt:** "PRism Unresolved reconciliation panel after a Reload, with all four badge variants visible (Fresh-but-ambiguous, Moved, Moved-ambiguous, Stale). Evaluate: visual distinction between Stale (blocks submit) and the soft variants (does not block); per-action button cluster (Show me / Edit / Delete / Keep anyway) affordance and hierarchy within each draft row; the Discard-all header button's weight relative to per-draft Delete actions. **Out of scope (spec-mandated):** the action set itself — Show me / Edit / Delete / Keep anyway are the shipped four and are not under design review; the 'reviewer's text is sacred' principle that motivates Keep anyway; the classification taxonomy (nine-row matrix is settled). Look for: badges that don't distinguish action-required from informational; affordance of the four per-draft actions (one shouldn't dominate); Discard-all that reads as primary CTA when it's a destructive bulk action."

## V-25. Verdict picker — needs-reconfirm + disabled-Submit tooltip
- **Setup:** Verdict set, banner up; hover the disabled Submit.
- **Viewport:** 1440x900, crop to header band.
- **Capture:** Two shots.
- **Variants to shoot:** needs-reconfirm / tooltip-visible.
- **Bundle as:** `V-25-verdict/`.
- **Send-to-Claude prompt:** "PRism verdict picker in needs-reconfirm state, plus the disabled-Submit tooltip when banner drift is detected. Evaluate: needs-reconfirm visual treatment on the verdict (warning glow? dimmed?), tooltip clarity ('Reload first — there are commits you haven't seen yet.'). Look for: needs-reconfirm state that's invisible at a glance, tooltip that's too small to read."

## V-26. Submit dialog — validator + Ask AI + Verdict + Summary + Preview
- **Setup:** Open submit dialog with aiPreview off (no validator card); take shot. Toggle on; take shot.
- **Viewport:** 1440x900 (dialog modal).
- **Capture:** Two shots.
- **Variants to shoot:** dialog-ai-off / dialog-ai-on.
- **Bundle as:** `V-26-submit-dialog/`.
- **Send-to-Claude prompt:** "PRism Submit confirmation dialog. Variant 1: aiPreview off — verdict picker, summary textarea + live preview, counts of threads/replies, no validator card. Variant 2: aiPreview on — adds the canned `PreSubmitValidatorCard` and the `Ask AI` button with its 'coming in v2' empty state. Evaluate: dialog vertical pacing in both states, whether the AI additions feel integrated or bolted on, summary textarea + preview balance. Look for: dialog that grows uncomfortably between off/on, AI elements that compete with the Confirm button."

## V-27. Foreign-pending-review modal
- **Setup:** [K-5] / [K-6] setup; trigger the modal twice (once for Resume preview, once for Discard preview).
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** resume-state / discard-state.
- **Bundle as:** `V-27-foreign-pending/`.
- **Send-to-Claude prompt:** "PRism foreign-pending-review modal in two states: showing the Resume confirmation sub-step (with the foreign threads/replies count + age) vs the Discard confirmation. Evaluate: modal copy clarity (this is a confusing situation users may not have seen before), Resume vs Discard button distinction (both are destructive in different ways), Cancel button visibility. Look for: copy that doesn't explain what 'Resume' or 'Discard' actually means, button hierarchy that pushes user toward a wrong default."

## V-28. Stale-commitOID retry banner — Reloaded vs not-yet-Reloaded
- **Setup:** [K-10] setup.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** not-reloaded / reloaded.
- **Bundle as:** `V-28-stale-oid/`.
- **Send-to-Claude prompt:** "PRism stale-commitOID retry banner in two states: with 'Recreate and resubmit' disabled (user hasn't clicked Reload yet) vs enabled. Evaluate: visual distinction between the two states (disabled state must clearly signal 'do this first'), copy clarity. Look for: disabled state that looks like a bug, enabled state that doesn't differentiate from disabled."

## V-29. Closed/merged PR banner + Discard-all-drafts
- **Setup:** [L-1] or [L-5]; have drafts.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** closed-with-discard.
- **Bundle as:** `V-29-closed-pr/`.
- **Send-to-Claude prompt:** "PRism PR detail with the 'This PR is now closed' banner and the 'Discard all drafts' button visible. Evaluate: banner copy tone (informational, not alarmed), button weight (it's destructive — should be confirm-modal-gated, but the button itself should not look like a primary CTA). Look for: panic-inducing banner, Discard button reading as the next obvious action."

## V-30. Active-PR banner — full copy
- **Setup:** [S-24].
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** banner.
- **Bundle as:** `V-30-active-pr-banner/`.
- **Send-to-Claude prompt:** "PRism active-PR update banner: 'PR updated — Iteration N available, X new comments — Reload'. Evaluate: copy density (a lot to fit), Reload button prominence, dismiss-X visibility. Look for: copy that wraps awkwardly at the test viewport, Reload that doesn't read as the primary action."

## V-31. In-flight composer modal
- **Setup:** Composer with text + click Reload.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** in-flight-modal.
- **Bundle as:** `V-31-in-flight-modal/`.
- **Send-to-Claude prompt:** "PRism modal that appears when Reload is clicked with an open non-empty composer: 'You have unsaved comment text. Save as draft, discard, or cancel reload?'. Evaluate: three-button hierarchy (Save is the default Enter action per spec), modal weight, copy clarity. Look for: three-button modal that doesn't distinguish primary, Save default that's not visually obvious."

## V-32. Toast variants — success / warning / error / 429
- **Setup:** Trigger each toast variant. Use test hooks or natural-occurrence flows.
- **Viewport:** 1440x900, crop to toast area (corner).
- **Capture:** Single shot, four-up grid.
- **Variants to shoot:** four-up.
- **Bundle as:** `V-32-toasts/`.
- **Send-to-Claude prompt:** "PRism toast notifications in four variants: success, warning, error, and 429-rate-limit. Evaluate: variant distinction (color, icon, weight), auto-dismiss timing perception (success auto-dismisses; others may persist), stacking when multiple toasts fire. Look for: variants that don't differentiate enough, dismiss-X that's hard to hit."

## V-33. Cheatsheet overlay — full + with composer-open + dim
- **Setup:** Open cheatsheet from PR view. Open from inside a composer.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** standalone / composer-underneath.
- **Bundle as:** `V-33-cheatsheet/`.
- **Send-to-Claude prompt:** "PRism keyboard cheatsheet overlay in two states: opened over the PR view; opened with an inline composer still active underneath. Evaluate: shortcut grid scan-ability, dim treatment of underlying content (should feel non-modal — composer should still feel accessible), close affordance. Look for: cheatsheet that traps focus visually, dim that makes underlying composer look disabled."

## V-34. Branded LoadingScreen + favicon
- **Setup:** Recipe A; capture the launch loading screen before redirect to inbox; check browser tab favicon.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** loading-screen / favicon-tab.
- **Bundle as:** `V-34-branding/`.
- **Send-to-Claude prompt:** "PRism launch experience: the branded LoadingScreen during boot, plus the favicon in the browser tab. Evaluate: loading screen pacing (should feel intentional, not anxious), favicon recognizability at tab scale, brand consistency between the two surfaces. Look for: loading screen that lingers without a progress signal, favicon that doesn't read at 16px."

## V-35. Settings page — all four sections
- **Setup:** Open Settings; capture in default state + after some edits.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** default / edited.
- **Bundle as:** `V-35-settings/`.
- **Send-to-Claude prompt:** "PRism Settings page with all four sections (Appearance, Inbox sections, Connection, Auth) — first in default state, then after some user edits. Evaluate: section heading hierarchy, control placement consistency within each section, the optimistic-save UX (toast on success — visible in 'edited' shot), Replace token affordance prominence in Auth. Look for: sections that feel inconsistent with each other, Auth section that doesn't distinguish from less-destructive sections."

## V-36. Replace token flow — Setup re-prompt + identity-change confirm
- **Setup:** [S-19] flow; capture Setup screen after Replace token click, then capture any identity-change confirmation that appears post-validate.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** setup-prepopulated / identity-change.
- **Bundle as:** `V-36-replace-token/`.
- **Send-to-Claude prompt:** "PRism Replace-token flow: Setup screen pre-populated with the configured host + a banner indicating Replace mode; identity-change confirmation if different-login replace. Evaluate: how clearly Replace mode differs from first-run Setup, identity-change copy (this is a high-stakes confirmation), preserved-vs-cleared state explanation. Look for: Replace mode that looks identical to first-run, identity-change copy that doesn't make consequences explicit."

## V-37. Theme × accent matrix — 6-up + focus-ring walk per combo
- **Setup:** Pick one signature view (PR detail Files tab on a small file). For each of the six theme×accent combinations, capture two shots: (1) the resting view; (2) a Tab-walked focus state on the verdict picker or a file-tree row (whichever is more accent-sensitive in that combo).
- **Viewport:** 1440x900.
- **Capture:** Twelve shots — six rest + six focus.
- **Variants to shoot:** light-indigo-rest / light-indigo-focus / light-amber-rest / light-amber-focus / light-teal-rest / light-teal-focus / dark-indigo-rest / dark-indigo-focus / dark-amber-rest / dark-amber-focus / dark-teal-rest / dark-teal-focus.
- **Bundle as:** `V-37-theme-accent/`.
- **Send-to-Claude prompt:** "PRism PR detail Files tab in all six theme×accent combinations, each with a rest shot and a Tab-focused shot. **Apply WCAG 2.1 AA contrast ratios as the pass/fail bar**: 4.5:1 for body text against background; 3:1 for large text (≥18pt or ≥14pt bold) and for interactive-element borders/focus indicators against adjacent backgrounds. Flag any combination where the verdict picker label, file-tree row text, focus ring, or selected-row highlight falls below the relevant ratio. Beyond contrast: evaluate accent strength balance across indigo/amber/teal; whether any combination feels weaker than others as a daily-driver UI. **Out of scope (spec-mandated):** the three accent choices (indigo / amber / teal); the three theme modes (light / dark / system); the choice to ship 6 combinations rather than collapse to fewer; the specific oklch hue values. Look for: dark+amber legibility (amber on dark is the most fragile combination); light+teal differentiation from default neutral; any combination that loses focus rings or selected-state cues."

## V-38. a11y — keyboard focus through landmarks
- **Setup:** Tab through interactive elements from cold start.
- **Viewport:** 1440x900.
- **Capture:** Sequence of 3-4 (header → main → file tree → composer focus chain).
- **Variants to shoot:** focus-header / focus-main / focus-tree / focus-composer.
- **Bundle as:** `V-38-a11y-focus/`.
- **Send-to-Claude prompt:** "PRism keyboard-focus walk: focus rings as the user Tabs through header → main → file tree → composer. Evaluate: focus ring visibility on every element (WCAG-AA contrast), tab order intuitiveness, whether any focusable element loses its ring (a regression risk). Look for: missing focus rings, focus rings that have low contrast against accents, focus skips into out-of-viewport elements."

## V-39. Empty PR — file tree empty + placeholder
- **Setup:** A PR with no commits beyond base. Create one if necessary (open a PR with the same base/head).
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** empty-pr.
- **Bundle as:** `V-39-empty-pr/`.
- **Send-to-Claude prompt:** "PRism PR detail when the PR has no commits beyond base ('Empty PR' state). Empty file tree + placeholder message: 'This PR has no changes yet. Commits added later will appear here on reload.' Evaluate: empty-state tone (informational, not error), Submit button state (should be disabled with explanation but Comment-with-summary should still be possible per spec). Look for: empty state that reads as broken, Submit that looks unconditionally disabled."

## V-40. Error states — 404, network drop, 401 banner
- **Setup:** Trigger each: 404 by navigating to a non-existent PR; network drop by toggling wifi; 401 by revoking the PAT.
- **Viewport:** 1440x900.
- **Capture:** Three shots.
- **Variants to shoot:** 404 / network-drop-toast / 401-banner.
- **Bundle as:** `V-40-error-states/`.
- **Send-to-Claude prompt:** "PRism three error surfaces: 404 on a deleted PR, network-drop toast with Retry, 401 token-expired banner (composer-preservation variant if possible). Evaluate: consistency of error voice across the three, Retry/Reauthenticate affordance prominence, copy that distinguishes user-action errors from environmental ones. **Out of scope:** the error taxonomy itself (these three are the load-bearing ones); the choice to surface as toasts vs banners vs full-page errors. Look for: errors that all read identically, retry actions that aren't obvious."

## V-41. PR-detail loading skeleton + transient mount states
- **Setup:** Open a PR with enough content that the mount takes a perceptible moment (a multi-file PR; throttle network to "Fast 3G" in DevTools to amplify).
- **Viewport:** 1440x900.
- **Capture:** Sequence of 3 — initial click (banner shows skeleton), mid-mount (some panels filled, others still skeleton), full mount complete.
- **Variants to shoot:** skeleton-initial / skeleton-mid / fully-mounted.
- **Bundle as:** `V-41-loading-skeleton/`.
- **Send-to-Claude prompt:** "PRism PR-detail page during initial mount: three frames from initial-click → mid-mount → fully-mounted, with network throttled so the skeleton is visible. Evaluate: is the skeleton branded (matches the LoadingScreen surface from V-34) or generic; does the skeleton communicate progress (shape preview of incoming content) or feel like an empty state; does the transition to fully-mounted feel smooth or jarring. **Out of scope:** the existence of a skeleton vs an alternate loading indicator (skeleton is the chosen pattern). Look for: skeleton that feels like a 'broken empty state', shape mismatch between skeleton and fully-mounted layout (causes layout shift on swap-in), missing skeleton on any panel that takes more than ~150ms to render."

## V-42. Motion — banner arrival, toast in/out, cheatsheet fade
- **Setup:** Three sub-scenarios. (1) PR detail open, trigger banner via `/test/emit-pr-updated` (Recipe D), capture three frames: pre-arrival, mid-arrival, settled. (2) Trigger any toast, capture three frames: entry mid-animation, settled, exit mid-animation. (3) Press `?` to open cheatsheet, capture mid-fade-in, settled, mid-fade-out.
- **Viewport:** 1440x900.
- **Capture:** Nine shots total (three per sub-scenario). Manual capture via browser DevTools "Capture screenshot" while animation is paused via DevTools → Rendering → Animations panel (slow down or step through).
- **Variants to shoot:** banner-pre / banner-mid / banner-settled / toast-entry / toast-settled / toast-exit / cheatsheet-fade-in / cheatsheet-settled / cheatsheet-fade-out.
- **Bundle as:** `V-42-motion/`.
- **Send-to-Claude prompt:** "PRism three motion sequences captured as before/during/after frame triplets: (1) banner arrival on PR detail; (2) toast entry and exit; (3) cheatsheet overlay fade in and out. Evaluate: does the banner arrive without provoking attention-flight (the eye shouldn't be yanked away from the diff); do toasts feel deliberate vs incidental; does the cheatsheet feel like an overlay that floats vs one that 'replaces' the background. Spec constraints: banner must not cause layout shift (V-30 / S-24 cover the layout side; this V-case covers the motion). **Out of scope:** specific easing functions or timings (those are implementation choices not visible in static frames); whether motion exists at all (PoC ships with motion). Look for: motion that violates 'banner-not-mutation' tone (too aggressive), toasts that feel like notifications-from-elsewhere rather than in-app feedback, cheatsheet fade that's so fast the user misses what changed."

## V-43. CommitMultiSelectPicker — 1-commit PR fallback
- **Setup:** Open frozen sandbox PR #19 (single-commit; triggers the picker fallback).
- **Viewport:** 1440x900.
- **Capture:** Single shot of Files tab + crop of the picker itself.
- **Variants to shoot:** picker-in-context / picker-detail.
- **Bundle as:** `V-43-commit-multiselect/`.
- **Send-to-Claude prompt:** "PRism CommitMultiSelectPicker — the UI that replaces the iteration tab strip when the PR has only one commit (or when clustering quality is too low). Two shots: the picker in the context of the Files tab; and a closer crop of the picker control itself. Evaluate: does the picker feel like a deliberate alternative to the tab strip or like a degraded version; affordance for selecting commits to diff; readability of commit metadata (SHA, message, author). **Out of scope (spec-mandated):** the fallback's existence and trigger conditions (1-commit PRs and clustering-disabled mode); the picker's position on the Files tab. Look for: picker that doesn't communicate it's a replacement for the iteration tabs; commit rows that look stacked rather than selectable; multi-select affordance that's not obvious."

## V-44. Interaction states — hover, active, disabled across key controls
- **Setup:** For each of: the verdict picker buttons, the Submit Review button (in both enabled and disabled states), the per-draft action cluster in the reconciliation panel, the Compare picker dropdowns, the file-tree row chevron — capture both the resting state and an interaction-state variant using DevTools to lock the pseudo-class (`:hover`, `:focus-visible`, `:active`, `[disabled]`).
- **Viewport:** 1440x900, cropped to each control.
- **Capture:** Eight shots minimum (resting + hover for four controls).
- **Variants to shoot:** verdict-rest / verdict-hover / submit-enabled / submit-disabled-tooltip / draft-action-rest / draft-action-hover / compare-rest / compare-hover / tree-chevron-rest / tree-chevron-hover.
- **Bundle as:** `V-44-interaction-states/`.
- **Send-to-Claude prompt:** "PRism key interactive controls in resting and hover/disabled states (DevTools-locked pseudo-classes). Evaluate: hover signals interactivity clearly without being noisy; disabled state reads as 'not now' rather than 'broken' (especially important for Submit, which spends a lot of time disabled per spec submit-rules a-f); active/pressed feedback feels deliberate. Cross-reference V-25 (which covers the disabled-Submit-with-tooltip specifically) — V-44 captures the *micro-interactions* on every other element. **Out of scope:** the choice of hover vs no-hover (UI ships with hover); cursor changes (browser-default). Look for: controls where hover state is missing entirely; disabled states that aren't visually different enough from enabled; controls where the active/pressed feedback is invisible."

---

# Part 4 — Appendix

## Sandbox catalog

Frozen PRs on `prpande/PRism` referenced throughout this doc. These were chosen because their content is stable — the contract-tests suite locks their shape against drift.

| PR | URL | What it exercises | Used by cases |
|---|---|---|---|
| #1 | `https://github.com/prpande/PRism/pull/1` | Multi-commit PR; iteration clustering happy path | S-4, S-6, D-1, D-7, V-8, V-10 |
| #16 | `https://github.com/prpande/PRism/pull/16` | Single-file rename + content edit | D-15, H-10 |
| #19 | `https://github.com/prpande/PRism/pull/19` | Single-commit PR; degenerate iteration fallback | D-15 |
| #22 | `https://github.com/prpande/PRism/pull/22` | Heavy amend cycle + force-pushes; clustering stress; force-push banner | D-12, V-16, V-17 |
| #28 | `https://github.com/prpande/PRism/pull/28` | `.md` + Mermaid + GFM rendering | S-8, F-1..F-6, V-19 |
| #N | `https://github.com/prpande/prism-sandbox/pull/N` | Stale-OID real-flow fixture; V6 SSE wire-fix scenarios. PR number is whatever `npm run setup-real-e2e-fixtures` last wrote into `frontend/e2e/real/fixtures.json`. | X-1, X-3 |

**Drift detection and recovery.** The frozen `prpande/PRism` PRs (#1, #16, #19, #22, #28) are locked by the contract-tests suite (`tests/PRism.GitHub.Tests.Integration/`); when that suite starts failing on the canonical-strict configuration, every case in the "Used by cases" column for the affected PR needs a re-walk. The sandbox PR is regenerated per setup pass; if a sandbox setup fails, only X-* cases are affected.

**Recovering from drift on a frozen PR.** Grep the doc for the affected PR number (e.g., `#22`) to find every case that depends on it — the "Used by cases" column is the index, but be aware that cases citing "a multi-commit PR" or "a PR with ≥3 iterations" without naming a specific PR implicitly depend on the matching frozen PR; cross-check Pre lines if a frozen PR drift makes contract tests fail. Better: when authoring new cases, name the specific frozen PR in Pre even when "any PR with property X" would technically suffice — that makes the doc grep-recoverable on drift.

## Throwaway PR recipe

Submit / reconciliation cases need a live mutable PR. Recipe:

1. **One-time setup**: fork `prpande/PRism` to your own GitHub account. Clone the fork locally.
2. **Per validation pass**: create a new branch off main with a small change:
   ```
   git checkout -b validation/$(date +%Y%m%d-%H%M%S)
   echo "// test edit $(date)" >> README.md
   git add README.md && git commit -m "test"
   git push -u origin HEAD
   ```
3. Open a PR from your fork's branch against your fork's main (NOT against `prpande/PRism` upstream — keep the test traffic on your fork).
4. Use the resulting PR for K-* cases. When done, close + delete the branch.

For cases that need **a second user pushing** (banner trigger via S-9, S-10), use a second machine OR a second clone with a different identity. Or use the `/test/emit-pr-updated` deterministic hook for layout-only assertions (it bypasses GitHub entirely).

## Glossary

| Term | Definition |
|---|---|
| **Verdict** | One of Approve / Request changes / Comment — chosen in the verdict picker, finalized on submit |
| **Iteration** | A reconstructed grouping of commits inferred from the PR timeline; tabs are "All changes" + per-iteration tabs |
| **Compare picker** | Two-dropdown selector for diffing arbitrary iteration pairs; auto-swaps reverse selections |
| **Draft (DraftComment)** | A new inline comment thread the user has authored locally but not submitted |
| **Reply (DraftReply)** | A reply to an existing thread, authored locally, attaches to the pending review on submit |
| **Pending review** | GitHub-side review object (`PRR_...`) that holds threads/replies invisibly until `submitPullRequestReview` finalizes it |
| **Reconciliation pass** | The classification algorithm that runs on Reload, sorting drafts into Fresh / Moved / Stale buckets per the nine-row matrix |
| **Foreign pending review** | A pending review that exists on github.com but whose ID doesn't match the local `pendingReviewId` (e.g., orphan from a prior PRism instance, or one created on github.com directly) |
| **Identity change** | The Replace-token flow detecting that the new PAT authenticates as a different GitHub login than the previous one — triggers a state-cleanup rule that preserves drafts but clears GraphQL Node IDs owned by the prior login |
| **Cross-tab stamp (V6)** | The per-tab `TabStamps` map (state schema version 6) that gates redundant cross-tab echoes via BroadcastChannel — prevents a tab from re-processing events it originated |
| **AI preview** | The `ui.aiPreview` flag-driven mode where AI capability flags return `true` and slots render canned placeholder data — DI binds `Placeholder*` impls instead of `Noop*` |
| **`<dataDir>`** | PRism's per-platform data directory: `%LOCALAPPDATA%\PRism` on Windows; `~/Library/Application Support/PRism` on macOS |
| **Wedge** | The combination of features that motivates opening PRism instead of github.com — primarily iteration tabs, file-by-file diff, stale-draft reconciliation, local-first authoring |
