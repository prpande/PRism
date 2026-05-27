# v1 completion roadmap

**Date**: 2026-05-28.
**Status**: Design — pending user review.
**Source authorities**:
- [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "The PoC demo" + § "What 'shipped' means for the PoC" + § "What success looks like 90 days after the PoC ships" — the v1 ship line, distribution posture, and validation gate.
- [`docs/roadmap.md`](../roadmap.md) — slice decomposition; this roadmap adds the post-S6 phases.
- [`docs/specs/2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) § ADR-P0-4 — seed sketch for single-instance enforcement.
- [`docs/specs/2026-05-15-s6-polish-and-distribution-deferrals.md`](2026-05-15-s6-polish-and-distribution-deferrals.md) — open deferrals from S6.
- [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md) — what files to update per change type.

---

## 1. Goal and scope

### 1.1 Goal

Cross the PoC ship line at tag `v0.1.0`. A new dogfooder on a supported platform can download a binary from `releases/latest`, run it, paste a PAT, and complete the 13-step demo flow from [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "The PoC demo" without losing data or reading stale documentation.

"Supported platform" at v0.1.0 = Windows x64 only. macOS Apple Silicon ships at v0.1.1 (see § 1.4 and § 6.2 for the rationale).

### 1.2 In scope — three phases, sequential

1. **Phase 1 — Single-instance enforcement.** Closes the largest credible v1 data-loss path (two PRism windows writing `state.json` last-write-wins). Runs as its own brainstorm → spec → plan → PR cycle; this roadmap commits to running it. Phase 2 starts after Phase 1's PR(s) land on `main` — sequential, not parallel.
2. **Phase 2 — Doc/README sweep + README restructure + `CONTRIBUTING.md` extraction.** Every "publish pending" wording → truthful current state, the main README is rebuilt to a public-tool shape, and dev workflow content moves to a new `CONTRIBUTING.md`. Phase 3 starts after Phase 2's PR lands.
3. **Phase 3 — `v0.1.0` tag (Windows) + `publish.yml workflow_dispatch` + post-publish reconciliation.** First real exercise of the publish workflow. `v0.1.1` adds the macOS Apple Silicon binary on a separate cycle once a macOS verification path exists.

### 1.3 Out of scope, explicitly stamped

Every item in this section is intentionally not landing in v1. Each carries a one-line "why not now."

- **S5 quality-of-life deferrals** — `markAllRead` authz tightening, `IActivePrCache.HighestIssueCommentId`, discard-failure consolidated toast, file-fetch concurrency cap on reload, dangling-reply detection, generic merger walker for `useDraftSession`. Why not now: no v1 user impact; v2 ergonomics polish. (Dangling-reply leaves an orphan on github.com but the reviewer's own content is preserved — not in this roadmap's "data loss" definition; see § 1.6.)
- **`usePreferences` → `PreferencesContext` refactor** (PR #71 deferral). Why not now: cost is N consumers + ~10 mocked tests; benefit is one network round-trip per `/settings` focus; not load-bearing.
- **Body-cap predicate gap on `POST /api/auth/replace`** (S6 PR #70 deferral). Why not now: theoretical until a >16 KiB PAT-paste happens, which it won't; P0+ hardening. (Acknowledged risk: this is a token-replacement surface, but the worst-case is a 413 response on a hand-crafted payload, not silent data corruption.)
- **`LogsPathInfo` dual-derivation invariant** + **`LoggerMessage` template-name discipline** (S6 deferrals). Why not now: invariant/discipline policing fires on future refactors, not current code; P0+ hardening.
- **Real-flow Replace-token Playwright spec** (S6 deferral). Why not now: externally blocked on a second sandbox account.
- **VoiceOver manual a11y pass** (S6 deferral). Why not now: externally blocked on a macOS dogfood machine (same blocker class as § 1.4 / § 6.2).
- **Architectural-readiness `Before P0+` gates other than single-instance** — frontend types codegen, document homes for v2 projects, `IHostedService` for `ConfigStore` async init. Why not now: gated to v2 work (`P0+`) by design.
- **S3 Task 11 (contract tests against `mindbody/Api.Codex`)** — superseded. Landed via PR #59 redirected to `prpande/PRism`'s merged-PR history; `docs/specs/README.md` "In progress" entry promotes to "Implemented" in Phase 2.
- **N=3 external validation gate.** Per [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "What success looks like 90 days after the PoC ships". Runs *after* v1 ships. Sequencing rationale in § 1.5.

### 1.4 DoD coverage at v0.1.0 — explicit mapping

v1 ship is gated on the exit criteria in § 5, not on closing every box in [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § DoD. Per [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md), `docs/spec/` is a forward-looking design contract; the unchecked boxes there remain unchecked by policy. To make the difference between "shipped against the DoD" and "v1 ship" visible, this table walks the DoD bullets v1 knowingly does NOT fully close:

| DoD bullet | v0.1.0 state at ship | Closes at |
|---|---|---|
| Functional-1 "demo flow passes on Windows AND macOS (Apple Silicon)" | Windows-only verified. macOS deferred. | v0.1.1 |
| Cross-platform "self-contained single-file binaries publish cleanly for `win-x64` AND `osx-arm64`" | Windows publishes. macOS publishes from CI but is not runtime-verified by a human on macOS hardware until v0.1.1. | v0.1.1 |
| Cross-platform "First-run setup screen on macOS explicitly tells the user to expect a Keychain 'Always Allow' prompt" | Shipped in S6 PR #76 (`FirstRunDisclosure`). Copy is correct; not human-verified against actual Gatekeeper flow on macOS hardware. | v0.1.1 (verification) |
| Quality "Accessibility baseline ... ARIA labels on all icon-only buttons" | Shipped in S6 PR #75 axe-core audit. VoiceOver manual pass deferred — same macOS-hardware blocker. | v0.1.1 (verification) |

Every other DoD bullet either shipped (verifiable via git history) or remains unchecked by design-contract policy. The roadmap is not redefining "shipped"; it's making the macOS-hardware gap visible as a discrete deferral rather than letting it sit inside generic "unchecked boxes are intentional" prose.

### 1.5 Sequencing decision — polish-before-validate

The vision doc explicitly gates the v2 workstream on both author-dogfood AND N=3 external-validation signals: *"The AI workstream (P0–P2) starts only when both the author-dogfood signal and the external-validation signal pass. P3 (multi-platform adapters) and P4 (quality-of-life) work also gate on both signals."* The N=3 trial *"does not need to be polished or anonymous; colleagues the author can sit next to are fine."*

A defensible alternative ordering: skip this roadmap, hand the current `main`-branch build to three reviewers as a side-loaded zip, run the gate first. If the gate fails, every week of polish was wasted.

**This roadmap commits to polish-before-validate** for three reasons:

1. **The N=3 gate's success bar requires the binary "feel" right.** "I'd switch to this" is a high bar; first impressions from a hand-built side-loaded zip with stale docs lower it. The gate's softer wording ("I'd use it for X but want Y") still counts, but interpreting "ambiguous → went back to GitHub" (the gate's conservative scoring) means a stale-doc moment in the trial is more likely to drag the response into the rejected bucket.
2. **The single-instance fix (Phase 1) is required regardless of trial timing.** A trial reviewer double-launching the binary mid-trial and losing drafts produces a trial outcome unrelated to the wedge thesis. Phase 1 is on the critical path either way.
3. **The README + CONTRIBUTING delta is small (~1 PR, ~1-2 days).** It's not a multi-week investment; the marginal cost is bounded.

The sequencing trade is explicit, not implicit. If the user wants validate-before-polish, the roadmap reshapes: Phase 1 (load-bearing) → trial → reassess Phase 2/3 based on trial feedback. Re-open the question if the Phase 1 brainstorm extends Phase 1 by weeks (see § 6.1).

### 1.6 "Largest credible" data-loss path — enumeration

Phase 1 closes the *largest credible* v1 data-loss path, not the only one. The "only" claim from an earlier draft overreached. Other candidates considered and why they don't escalate to v1 phase:

| Candidate | Failure mode | Why deferred |
|---|---|---|
| Two PRism windows on same `<dataDir>` (Phase 1's target) | Last-write-wins on `state.json`; silent draft loss | User-triggered, easy to hit; HIGH frequency × HIGH impact. |
| `AppStateStore` write crash mid-`AtomicFileMove` | Partial state.json + `.bak` recovery | Already mitigated in S3 PR (`2026-05-07-appstatestore-windows-rename-retry-design.md`). Backup exists; PoC-acceptable. |
| `ConfigStore` `FileSystemWatcher` debounce race | In-memory writer collides with disk re-read | Single-process; existing debounce + atomic-rename + `_gate` makes the window narrow. No reported incident. |
| `DraftSaved` events not written to forensic log | Crash between in-memory save and atomic-flush loses draft text | Explicitly accepted in spec (`docs/spec/02-architecture.md` § "Forensic event log"); v2 item. README documents it. |
| macOS Gatekeeper quarantine-attr blocks `<dataDir>` writes | Silent no-op writes; user loses every action | Real risk class but blocked by the same macOS-hardware gap as § 1.4 — can't verify until v0.1.1. Track as v0.1.1 verification item. |
| Body-cap predicate gap on `POST /api/auth/replace` | >16 KiB body → 413, not data loss | Not a data-loss path; § 1.3 covers it. |
| Dangling-reply detection | Orphan thread on github.com after parent deleted | Reviewer's content preserved locally; not "lost" in the local sense. Not v1-load-bearing. |

The two genuine v1-class candidates are (i) two PRism windows (Phase 1) and (ii) macOS Gatekeeper write blocking. The latter rides the same hardware gap as macOS verification — it's not a "fix in code" problem, it's a "needs human on macOS to confirm the failure exists" problem.

### 1.7 Positioning shift — explicit acknowledgment

Phase 2's README restructure commits to a "public-tool shape" (bat/ripgrep style, badges, CONTRIBUTING.md). That is a positioning shift from the vision doc's "PoC distributed however the user prefers (direct download, git source for technical colleagues)" framing.

**Implications the roadmap accepts:**
- The repo invites unsolicited installs once `releases/latest` resolves. The maintainer accepts issue volume from users outside the N=3 cohort (response is "the project is in PoC; please email instead of filing" — set Issues template accordingly if friction becomes real).
- CONTRIBUTING.md auto-surfaces in GitHub's New Issue/PR pages even though the project's contributor cadence is sole-owner. This is OK — the file exists for the next contributor, not the current one.
- The README's wedge framing imports the vision doc's self-skepticism (e.g., stale-draft reconciliation is rare-in-practice). The README is not marketing copy.

If the user prefers the narrower posture — README stays internal-PoC-shaped, no badges, no CONTRIBUTING.md, no `releases/latest` polish — Phase 2 reshapes to a much smaller "wording sweep only" effort and Phase 3 stays as-is.

---

## 2. Phase 1 — Single-instance enforcement

### 2.1 Status going in

[`docs/specs/2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) § ADR-P0-4 is a seed sketch, not a spec. It explicitly defers the real design work: *"the fix is bigger than a spec edit and benefits from a separate brainstorm — the IPC channel, focus-API per OS, and the second-launch error UX are real design questions, not just plumbing."*

This roadmap commits to *running* that brainstorm next. The brainstorm produces its own spec at `docs/specs/2026-05-XX-single-instance-enforcement-design.md`, then a plan, then 1–2 implementation PRs.

### 2.2 Design questions the Phase 1 brainstorm will resolve

Not pre-decided here. Enumerated so the brainstorm has a starting list:

- **IPC channel per OS.** Win32 named pipe vs. localhost TCP probe; macOS/Linux Unix domain socket at `<dataDir>/.prism/focus.sock` vs. localhost TCP probe.
- **Focus API per OS.** How the existing process raises its browser window (Win32 `SetForegroundWindow` flicker rules + foreground-lock workaround; macOS `osascript` vs. opening the localhost URL afresh).
- **Second-launch UX — visible feedback required.** The brainstorm picks between toast on existing window ("PRism is already running — focused the existing window") and modal. Silent focus and stderr-only are pre-rejected: they fail Phase 1's user-model goal (the user understands why their action didn't do what they expected) even when they satisfy the data-coherence goal. A user double-clicking and getting silence is likely to try again, possibly conclude PRism crashed and "restart" it.
- **Mutex naming and `<dataDir>` scoping.** The mutex name must include a hash of the resolved `<dataDir>` so two PRism instances against two different `<dataDir>` values legitimately coexist (the architecture's "one host per launch" loophole; relevant for multi-account-style usage already supported by S6 PR0's storage scaffold).
- **Startup ordering race between lockfile-take and IPC-listener mount.** `LockfileManager.Acquire` runs early; the IPC focus-listener mounts later (after DI graph build + Kestrel bind). A second process launched in that window sees the lockfile but no IPC listener. Decide the discipline: spin-wait with bounded timeout, fail-loud, or order the IPC listener earlier in startup.
- **Lockfile interaction.** The existing `<dataDir>/state.json.lock` already prevents double-startup of the backend. Decide whether the mutex replaces, augments, or coexists with the lockfile; hard-crash recovery story (mutex auto-releases on process exit; lockfile relies on PID-liveness probe).

### 2.3 Acceptance for Phase 1

- The Phase 1 brainstorm produces a spec the user approves.
- The plan produces 1–2 PRs that land on `main`.
- **Merged behavior:** double-clicking the binary on Windows where PRism is already running brings the existing window forward and the second process exits with code 0.
- **Verification approach is decided by the Phase 1 brainstorm**, not pre-committed here. (Sketch: an automated cross-process integration test if the mechanism supports it; otherwise a unit test on the lockfile/mutex primitive plus a manual Windows verification.)
- **macOS verification is a v0.1.1 concern**, not a Phase 1 acceptance criterion. The same code paths ship in the macOS binary but human verification lands at v0.1.1.
- If the Phase 1 brainstorm flags the work as multi-week, see § 6.1 for the trigger and fallback.

---

## 3. Phase 2 — Doc/README sweep + README restructure + `CONTRIBUTING.md` extraction

Phase 2 is a single PR. It contains: a README rewrite in public-tool shape (§ 3.1), a new `CONTRIBUTING.md` absorbing the current README's dev-workflow content verbatim (§ 3.2), a status-truth sweep across the doc tree (§ 3.3), and a hero screenshot (§ 3.4). The Phase 2 implementer captures the screenshot before opening the PR.

If reviewer load proves too heavy, the PR splits cleanly into 2a (README + CONTRIBUTING.md + doc sweep, text-only) and 2b (hero screenshot + asset). The roadmap doesn't pre-commit the split; it's an implementer call at PR-prep time.

### 3.1 README restructure — bat/ripgrep style

The current README is dev-workflow-heavy. The restructure makes it user-facing — a reviewer landing on the repo sees the value proposition, the download, and the first-run walkthrough before any contributor content. Reference shape: [`bat`](https://github.com/sharkdp/bat), [`fd`](https://github.com/sharkdp/fd), [`ripgrep`](https://github.com/BurntSushi/ripgrep).

No line-count target — length is whatever it takes to land the wedge without padding. The bat README is ~600 lines; ripgrep's is longer. PRism's wedge is contextual (stale-draft reconciliation needs a paragraph; iteration tabs need a sentence) and will likely settle around 200–300 lines after the dev-workflow content moves out. Cut content that doesn't earn its place; don't pad to hit a budget.

Top-to-bottom structure:

| Section | Content |
|---|---|
| **Title + tagline** | `# PRism` + one-line tagline ("Local-first GitHub PR review tool that makes daily code review fast, deliberate, and reviewer-controlled."). |
| **Badge row** | CI status (links to `ci.yml`), latest release (`releases/latest`), license (Apache-2.0), platforms (Windows; macOS Apple Silicon on v0.1.1). Use `img.shields.io`. |
| **Hero asset** | One static screenshot. Hand-captured against a curated seed (or PII-scrubbed real session) to look like real usage, not test fixtures. Stored at `assets/screenshots/hero-inbox.png`. See § 3.4. |
| **One-paragraph pitch** | What PRism is, who it's for, why github.com isn't enough. Distilled from [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "What we're building" + § "The wedge". Imports the vision's self-skeptical framing (stale-draft reconciliation is rare-in-practice; the wedge is the combination). |
| **Features** | 5–7 bullets covering the wedge. Each bullet 2–4 sentences — enough to explain *why* it matters, not just *what* it is. Static-screenshot caveat: the most differentiated wedge items (banner-not-mutation, stale-draft reconciliation) are motion-based and don't show in a single image. The prose carries the weight; an animated GIF demo is a v1.x follow-up (toolchain weight of `puppeteer-screen-recorder` + `gifski` is real). |
| **Install** | Per-platform direct download links to `releases/latest/download/PRism-win-x64.exe`. macOS section says "Coming in v0.1.1 — see [the release notes](…) for status." Each platform has 2–4 lines: download, SmartScreen/Gatekeeper trust step, `chmod +x` for macOS (when it ships). |
| **Quick start** | Numbered list, 5 steps: download → run → SmartScreen trust → paste PAT → land on Inbox. References `FirstRunDisclosure` copy. |
| **Keyboard shortcuts** | Compact table of the cheatsheet: `j`/`k` nav, `v` viewed, `n`/`p` thread nav, `c` comment, `Esc`, `Cmd/Ctrl+Enter` submit, `Cmd/Ctrl+R` reload, `?` / `Cmd/Ctrl+/` cheatsheet. |
| **PAT scopes** | Required scopes (Pull requests R/W, Contents R, Checks R, Commit statuses R) + link to GitHub's fine-grained PAT page. |
| **Status** | Wording is **stateless** — does NOT claim "v0.1.0 prepared" or "v0.1.0 released". Uses "Latest binaries: see [`releases/latest`](…)" so the section doesn't go stale between Phase 2 merge and Phase 3 dispatch (the link's 200-vs-404 answers the question). |
| **Troubleshooting** | Trimmed to user-facing entries: "Recovering a lost draft" (identity-change events in `<dataDir>/logs/`; `DraftSaved`-not-logged caveat per § 1.6), "Replace token" (links to Settings page), "Where's my data?" (`<dataDir>` per platform). |
| **How it works** | 3-paragraph architectural sketch — local-first, GitHub-coupled, AI seams hidden in v1. Links to [`docs/spec/`](../spec/) for the full spec. |
| **Roadmap** | One paragraph: v1 is the PoC ship; v2 adds AI features per [`docs/backlog/`](../backlog/) (the four-tier P0–P4 layout). Link to [`docs/roadmap.md`](../roadmap.md). |
| **Contributing** | One-paragraph pointer to `CONTRIBUTING.md`. |
| **License** | Apache-2.0 + link to `LICENSE`. |

**Tone.** Direct. Verb-first. No marketing copy ("revolutionize your review workflow" is banned). The bat/ripgrep style is plain prose that respects the reader's time. The vision doc's self-skeptical posture about the wedge (e.g., "stale-draft reconciliation matters when it matters, but does not, on its own, motivate switching from github.com") lands in the README as honest framing — a distinctive, possibly stronger posture than confident feature bullets.

### 3.2 `CONTRIBUTING.md` extraction

New file at repo root. Absorbs **verbatim** (with minor rewording for the new context):

- "Development workflow" section (the two-terminal `dotnet watch run` / `npm run dev` setup).
- All "Run all tests / Run a single backend test / Run a single frontend test / Generate coverage" command blocks.
- "Integration tests (live GitHub)" section.
- "Pre-push checklist" — the canonical 5-step list mirroring `ci.yml`.
- "Stable session token across `dotnet watch run` reloads (Development only)" section.
- "Process" section (TDD, link to `.ai/docs/development-process.md`).

Adds (one short paragraph total — not a discovery surface for a contributor audience that doesn't yet exist):
- One-paragraph intro: who contributes, where the canonical sources live (`.ai/docs/`), where to ask questions.

That's it. The fuller contributor-onboarding additions (behavioral-guidelines pointer, solutions/ pointer, issue/PR conventions) get added in v1.x when there's an actual contributor audience. v1 just gets the dev workflow out of the README.

**Link-repointing responsibility.** Every cross-link in the repo that previously pointed at README anchors in the moved sections must be repointed to `CONTRIBUTING.md` in the same Phase 2 PR. Grep targets include `docs/contract-tests.md`, `docs/specs/2026-05-18-frozen-pr-contract-tests-design.md`, `.ai/docs/development-process.md` references, and any inline `[Pre-push checklist](#pre-push-checklist)`-style anchors. The PR pre-flight runs a broken-anchor check.

### 3.3 Status-truth sweep across the doc tree

| File | Edit |
|---|---|
| `README.md` § Status | Stateless wording per § 3.1 — no "prepared" or "released" claim. The `releases/latest` link is the source of truth. |
| `README.md` Features | Add one bullet acknowledging single-instance enforcement landed in v1. |
| `docs/roadmap.md` | Add a section "v1 completion (post-S6)" after the S6 row with three rows: Phase 1 (Shipped — PR #xx), Phase 2 (Shipped — this PR), Phase 3 (Pending; status set in the post-publish reconciliation PR). Cross-link to this roadmap spec. |
| `docs/specs/README.md` | Move the Phase 1 single-instance spec from "In progress" to "Implemented". Add an entry for this v1 roadmap spec under "Implemented" once Phase 3 closes. Promote the `2026-05-06-s3-pr-detail-read-design.md` entry from "In progress" to "Implemented" (Task 11 was superseded by PR #59's frozen-PR contract tests against `prpande/PRism`; the "In progress" framing has been stale since 2026-05-19). Promote the `2026-05-18-frozen-pr-contract-tests-design.md` entry from "In progress" to "Implemented" (PR #59 merged 2026-05-19; runbook at `docs/contract-tests.md`). Promote the `2026-05-18-on-disk-log-writer-design.md` entry from "In progress" to "Implemented" (PR #63 merged 2026-05-19). Audit every remaining "In progress" entry — anything whose work merged before v0.1.0 ships should land in "Implemented" before Phase 2 closes. |
| `docs/specs/README.md` "Not started" | Replace with a one-line "No v1 work remaining; v2 specs land here as P0+ work begins." (The two-option phrasing from an earlier draft punted the decision; this is the obvious pick — v2 specs don't exist yet, so there's nothing to populate.) |
| `.ai/docs/operating-context.md` | Update "current cadence" to reflect post-v0.1.0 state. |
| `.ai/docs/repo-overview.md` | Verify top-level tree is accurate (new file: `CONTRIBUTING.md`; new directory: `assets/screenshots/`). |
| `.ai/docs/development-process.md` | Verify the pre-push checklist matches what `CONTRIBUTING.md` will carry. If they diverge, `.ai/docs/` stays canonical for AI agents and `CONTRIBUTING.md` mirrors with a link back. |

**S6 spec amendments (§ 5.1 + § 5.5 LoadingScreen + icon assets) are out of scope for this PR.** Both are P3 advisory corrections that don't change v1-shipping behavior; the deferrals sidecar at [`docs/specs/2026-05-15-s6-polish-and-distribution-deferrals.md`](2026-05-15-s6-polish-and-distribution-deferrals.md) is already the authoritative override. Folding them into Phase 2 sets a precedent that every open P3 deferral must clear before tagging, which is a higher bar than § 1.1 commits to. They land in a separate v1.x doc-hygiene PR.

**No edit to `docs/spec/01-vision-and-acceptance.md` § DoD.** Per documentation-maintenance, that doc is forward-looking; unchecked boxes are intentional. The DoD-vs-v1 mapping in § 1.4 of this roadmap is the visible accounting.

### 3.4 Hero screenshot — manual one-time capture

The README references `assets/screenshots/hero-inbox.png`. The current `assets/` directory holds only `icons/`.

**Capture approach:** the Phase 2 implementer hand-captures one screenshot of the inbox view at 1440×900, against either (a) a curated seed file populated with realistic PR titles and authors, or (b) the implementer's actual review session with PII scrubbed. Test seeds as they exist today produce a sparse one-section inbox with `acme/api/123`-style placeholder data that actively undersells the wedge to a first-time visitor.

**No Playwright script, no npm script, no re-runability tooling at v1.** If a future UI change makes the screenshot stale, the next maintainer recaptures manually. For a 5-dogfooder PoC the maintenance cost of a registered tool exceeds its value. (When the maintainer cadence reaches the point where stale screenshots become a real problem, that's the trigger for v1.x screenshot-capture infrastructure.)

**Per-feature inline screenshots are out of scope.** The Features section in § 3.1 carries no inline images. The hero alone is the visual hook; prose carries the rest. (Animated GIF demos that would show the wedge's motion-based items are explicitly deferred to v1.x — see § 3.1.)

### 3.5 Acceptance for Phase 2

- README, top-to-bottom, gets a new reviewer from "what is this?" to "first PR reviewed" with no detour into contributor content.
- `CONTRIBUTING.md` exists at repo root, contains every dev-workflow line previously in `README.md`, and is linked from `README.md` § Contributing.
- Every "publish pending" / "first binary publish pending" reference is gone; the Status section uses the stateless wording from § 3.1 so it doesn't go stale between Phase 2 and Phase 3.
- `docs/roadmap.md` and `docs/specs/README.md` reflect Phase 1 as shipped, Phase 2 as shipped (in this PR), and Phase 3 as pending. The S3 Task 11 promotion lands.
- `assets/screenshots/hero-inbox.png` is checked in and referenced from the README.
- All cross-links into the moved README sections are repointed to `CONTRIBUTING.md`; broken-anchor grep is clean.
- `ce-doc-review` (Claude-only auto-review per [`CLAUDE.md`](../../CLAUDE.md)) finds no contradictions between the rewritten README, roadmap, and spec index.

---

## 4. Phase 3 — `v0.1.0` tag + publish + reconciliation

### 4.1 Pre-flight gates

Before tagging:
- Phase 1 and Phase 2 both merged to `main`.
- `main` is green on `ci.yml` at the tag commit.
- `softprops/action-gh-release@v3.0.0` (bumped in PR #81) verified against `publish.yml`'s current arg shape — the upgrade is new and untested in real use.
- `publish.yml`'s `GITHUB_TOKEN` permission (`contents: write`) confirmed against any branch-protection rule changes.
- Plan Task 8.4 from S6 PR8 ("manual workflow_dispatch verification") closes by being executed in this phase — it's a pre-existing carry-over, not a Phase 3 work item.

`PRISM_INTEGRATION_PAT` is **not** a Phase 3 prerequisite. (Earlier draft listed it; that secret is consumed by the contract-test workflow per PR #59, not by `publish.yml` — `publish.yml` uses the default `GITHUB_TOKEN`.)

### 4.2 Dispatch

1. Maintainer dispatches `publish.yml` on `main` with inputs `tag = v0.1.0` and `include_macos = false`. The `include_macos` input is the workflow's gate for the macOS binary: false at v0.1.0 (Windows-only), flipped true at v0.1.1 once macOS hardware verifies the build.
2. Workflow builds both binaries (the `osx-arm64` build stays in CI to keep the cross-compile path live), but the upload step's `files:` list conditionally omits the `osx-arm64` binary when `include_macos` is false. Only `PRism-win-x64.exe` reaches the draft Release.
3. Workflow attaches the Windows binary to a draft GitHub Release at `v0.1.0`.
4. Workflow stops at draft (per `publish.yml` shape); maintainer manually promotes after § 4.3 verification.

### 4.3 Binary verification on Windows

Required before promoting the draft Release. Verified by the maintainer on actual Windows hardware:

- Download `PRism-win-x64.exe` from the draft Release.
- Double-click. Verify the SmartScreen "Windows protected your PC" → "More info → Run anyway" path matches `FirstRunDisclosure` copy.
- Browser auto-launches on `http://localhost:5180` (or next free port in 5180–5199).
- Paste a PAT. Complete the 13-step demo flow per [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "The PoC demo".
- **If Phase 1 shipped single-instance enforcement** (the expected path): double-click the binary again, confirm focus comes back to the existing window instead of spawning a second backend, and confirm the second-launch user feedback (toast/modal per § 2.2) appears.
- **If Phase 1 fell back to known-issue note** (per § 6.1): confirm the README's known-issue paragraph is present and accurate; skip the double-launch verification.
- Open `<dataDir>/logs/`. Path discovery: Settings → Connection → "Copy logs path" if the button exists per PR #69's `logsPath` GET shape (verify the button is actually surfaced in the SettingsPage UI before this verification step runs; if it doesn't, the path resolution falls back to `<dataDir>` discovery via the README's "Where's my data?" section).
- Confirm `prism-YYYY-MM-DD.log` exists with at least one `Identity changed` or comparable structured-log line.

### 4.4 Promote + finalize docs

If verification passes:
- Promote the draft GitHub Release to published.
- Open a small follow-up PR that flips the `docs/roadmap.md` Phase 3 row from "Pending" to "Shipped" and promotes this roadmap spec from "In progress" to "Implemented" in `docs/specs/README.md`. README § Status doesn't need editing (the stateless wording from § 3.1 already accommodates "released" because the `releases/latest` link now resolves). This is always a separate PR — never an amend to Phase 2's merged commit.

### 4.5 Reconciliation PR (only if verification surfaces issues)

If verification surfaces a bug — SmartScreen copy mismatch, unsigned-binary launch edge case, single-instance enforcement misbehaving on real Windows, logs-path button missing or pointing wrong:

1. **Delete the failed draft Release** before re-dispatching. `softprops/action-gh-release` behavior on duplicate tags is not stable across versions; leaving a stranded draft pollutes `releases/`.
2. Fix in a follow-up PR; re-dispatch when merged.
3. If multiple re-dispatches reveal cumulative issues, bump the tag (`v0.1.0` → `v0.1.0-rc.2` or similar) so the published Release reflects the iterations that actually shipped.

**Iteration ceiling: 3 dispatches.** If Phase 3 doesn't converge in 3 attempts, escalate. Either the publish workflow has a structural issue requiring its own brainstorm, or the v0.1.0 scope itself needs cutting. Don't burn unbounded iterations in a sunk-cost loop.

### 4.6 Acceptance for Phase 3

- `releases/latest` resolves to a published Release with the `win-x64` binary.
- The README's `releases/latest/download/PRism-win-x64.exe` link 200s.
- The 13-step demo flow passes against the downloaded binary on Windows.

(macOS verification — `osx-arm64` binary runtime-verified by a human — is v0.1.1 acceptance, not v0.1.0.)

---

## 5. Exit criteria for v1 (= v0.1.0 ship)

All true:

1. Single-instance enforcement merged + verified on Windows. (macOS verification rides v0.1.1.) OR Phase 1 fallback fired per § 6.1 and the README's known-issue paragraph is present.
2. README is in public-tool shape; `CONTRIBUTING.md` exists; `docs/roadmap.md` and `docs/specs/README.md` reflect Phase 1 + Phase 2 as shipped. All cross-links repointed.
3. `releases/latest` resolves; `win-x64` binary downloadable; README link 200s.
4. The 13-step demo flow passes against the downloaded `win-x64` binary on Windows.

v1 is NOT defined as "every DoD checkbox closed" (see § 1.4 for the explicit DoD-bullet mapping).

**v0.1.1 follow-up — defined for clarity, NOT in v1 scope:** add the `osx-arm64` binary once a macOS verification path exists; run the 13-step demo against it; un-skip the VoiceOver manual a11y pass; verify macOS Gatekeeper / `<dataDir>` write story.

---

## 6. Risks

### 6.1 Phase 1 brainstorm reveals single-instance enforcement is bigger than expected

Plausible — IPC + focus-API + UX choices have real depth. ADR-P0-4 deliberately punted them.

**Quantitative trigger for fallback:** if the Phase 1 plan, on first `writing-plans` pass, decomposes to **>8 tasks across >3 PRs**, OR if Phase 1 implementation passes **10 calendar days from brainstorm start without merging**, fire the fallback before sinking more time.

**Fallback action.** Drop single-instance from v1 scope. Ship v0.1.0 with a README known-issue paragraph: *"Avoid launching PRism more than once on the same machine — concurrent instances will overwrite each other's draft state. Single-instance enforcement lands in v1.1."* Phase 3 § 4.3 verification skips the double-launch step and confirms the known-issue paragraph instead. Re-spec single-instance for v1.1 with the brainstorm output's cut recommendations.

### 6.2 macOS verification deferred to v0.1.1 — explicit

Earlier draft proposed shipping `osx-arm64` "build-tested, not runtime-verified" at v0.1.0. That contradicts the vision doc's own posture: *"shipping a published-but-untested binary is the kind of detail that produces a 100% failure rate when discovered"* (justification for dropping `osx-x64`). The roadmap can't import the same posture it cited.

**Decision:** v0.1.0 = Windows only. macOS Apple Silicon ships at v0.1.1 once a hardware verification path exists (maintainer borrows a machine; engages a colleague with one; or accepts a multi-week wait for hardware availability). The `osx-arm64` binary still builds from CI to keep the build path live, but it's not in `releases/latest` until v0.1.1.

**Risk this still carries:** half the wedge audience (Microsoft engineers, designers, and others on Apple Silicon) sees "Windows-only PoC" at v0.1.0 and self-selects out of the N=3 trial. Mitigation: the N=3 trial cohort selection per [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) can be Windows-weighted at v0.1.0; widen at v0.1.1. If the maintainer's network is overwhelmingly macOS, v0.1.0 may not unblock the trial — in which case the macOS hardware acquisition becomes the v0.1.0 critical-path item, not a v0.1.1 follow-up.

### 6.3 `publish.yml workflow_dispatch` fails on first dispatch

The workflow has never been exercised end-to-end on a real tag. Plan Task 8.4 was deferred at S6 PR8 ship time. Dependabot's action-SHA bumps keep references green but say nothing about whether the workflow end-to-end produces a usable binary.

**Mitigation:** § 4.5's iteration ceiling (3 dispatches) bounds the loop. Treat the first dispatch as a real debugging exercise. Specific known-unknowns: (a) does `dotnet publish --runtime win-x64 --self-contained` from a `windows-latest` runner produce a launchable binary on a fresh Windows machine? (b) does `softprops/action-gh-release@v3.0.0` accept the workflow's current arg shape? (c) does `PRism.Web.csproj`'s `PublishProfile=ci` PropertyGroup gating fire correctly on a real tag?

### 6.4 README quotes specific UI states; UI drift makes them stale silently

The README references SmartScreen copy, cheatsheet keys, the trust-prompt wording — all of which can change in a future PR.

**Mitigation:** the hero screenshot is the ONE visible regression surface. Drop the per-feature inline mini-screenshots (already done in § 3.1) so the surface area for drift is minimized. CONTRIBUTING.md adds a one-line note: *"If you change UI copy referenced in README.md, recapture the hero screenshot or update the README prose in the same PR."* No CI gate, no automated drift detector — those are v1.x infrastructure that doesn't earn its place at v1.

If drift becomes a real problem in practice (the maintainer observes multiple stale-doc moments in trial feedback), v1.x adds a CI check that grep-asserts the README's quoted UI strings against the source. Don't pre-build infrastructure for a problem that hasn't manifested.

### 6.5 Hero screenshot quality undersells the wedge

The wedge as articulated in the vision doc is overwhelmingly motion-based (banner-not-mutation, stale-draft reconciliation flow). A static inbox screenshot shows the *least differentiated* surface of PRism — could plausibly be GitHub.com with a CSS skin.

**Acceptance:** the hero asset alone won't carry the wedge. The README prose has to. The Features section's 2–4-sentence bullets do the lifting; the hero is a visual hook, not a value-proposition demo. If the wedge isn't legible from the prose, the README is broken regardless of the screenshot. v1.x animated-GIF infrastructure can land later if the wedge isn't landing.

---

## 7. Artifact + downstream wiring

- This spec lives at `docs/specs/2026-05-28-v1-completion-roadmap-design.md`.
- New entry in `docs/specs/README.md` under "In progress" (promoted to "Implemented" when Phase 3 closes).
- New rows in `docs/roadmap.md` after the S6 row referencing this spec.
- Each phase's own spec/plan happens in its own brainstorm cycle:
  - Phase 1 → `docs/specs/2026-05-XX-single-instance-enforcement-design.md` + plan.
  - Phase 2 → no separate spec; this roadmap is detailed enough. Plan lives at `docs/plans/2026-05-XX-readme-restructure-and-doc-sweep.md`.
  - Phase 3 → no spec; the steps in § 4 are the spec. Tracked via PR + Release artifacts.

The terminal state for *this* brainstorm is invoking `superpowers:writing-plans` on this roadmap. The writing-plans output is a meta-plan that decomposes the three phases into the brainstorm/spec/plan/PR cycles each needs.
