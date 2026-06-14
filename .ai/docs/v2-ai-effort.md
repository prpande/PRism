# V2 AI Effort — Orientation for Any Agent/Machine

> **Read this first if you're picking up v2 AI work.** It's a map, not a spec. The
> authoritative detail lives in the backlog, the epic, and per-slice docs (linked below);
> on any conflict, **the backlog `.md` wins**. This file captures the cross-cutting context
> and the timeline that those sources don't.

## 1. What V2 is

PRism's AI features were scaffolded from the start as **9 capability-gated seams**
(`IPrSummarizer`, `IFileFocusRanker`, `IHunkAnnotator`, `IDraftSuggester`, `IPreSubmitValidator`,
`IComposerAssistant`, `IDraftReconciliator`, `IInboxItemEnricher`, `IInboxRanker`) with
Noop + Placeholder implementations. **V2 lights them up** by swapping Placeholder for a real
provider behind a tri-state gate — one seam (one class + a prompt + tests) at a time.

- **Substrate:** the **Claude Code CLI** (shell out to `claude -p --output-format json`),
  provider-agnostic behind `ILlmProvider`. Multi-provider by construction (Ollama/OpenAI admitted
  as new impls); a banned-symbol analyzer keeps provider specifics out of features.
- **Tri-state `AiMode {Off, Preview, Live}`** — Off = no AI; Preview = labeled sample content
  (zero egress); Live = real provider, probed, consent-gated. **Default is Preview** (PR #283).
- **Scope:** v2 = **Tier 1 (read)** + **Tier 2 (authoring)** seams. **PR chat with repo access is
  v3** — it's net-new and drags in MCP host + repo clone + streaming + the heaviest privacy cost.
  v2 needs only the **one-shot** CLI path (no streaming/MCP/`--add-dir`).

## 2. Branching & rollout — the #1 gotcha

**`V2` is a long-lived branch forked from `main` that acts as the "AI-development main".**

- **Every v2/AI PR's base MUST be `V2`, never `main`.** Feature branch off `V2` → PR → merge back to `V2`.
- **`main` keeps shipping v1 to customers with *no* v2 pieces.** The AI substrate never reaches
  `main` through day-to-day work.
- **`main` → `V2` syncs** happen at a regular cadence (keeps V2 current with v1 hotfixes).
- **`V2` → `main` happens only at a deliberate cutover**, when the v2 AI set is ready to ship.
- ⚠️ **Automation default is wrong here:** `pr-autopilot` auto-detects PR base from `origin/HEAD`
  (= `main`). **Always override base to `V2`.** (This once opened a PR that would have shipped the
  dark AI substrate to customers; corrected by re-pointing to `V2`.)
- **One fresh worktree + feature branch per increment**, off the latest `V2`. No single shared
  long-lived feature branch.

## 3. Where the authoritative detail lives

| Source | Role |
|---|---|
| `docs/backlog/` — `00-priority-methodology.md`, `01-P0-foundations.md`, `02-P1-core-ai.md`, `03-P2-extended-ai.md`, `05-P4-polish.md` (no `04-P3`) | **Source of truth** — detailed decomposition. On any conflict, this wins. |
| GitHub **epic #423** ("[AI] v2 augmentation roadmap", label `roadmap`) | **Live readiness map** — dependency-ordered "what's next", ✅/🟢/⛔ per item. Open it to answer "what do I pick up." |
| **20 root issues** #403–#422 (`ai:foundation`/`ai:core`/`ai:extended`) + milestone "v2 — AI" | Coarse tracking issues; picking one up triggers a brainstorm → refined child issues. |
| `docs/specs/2026-06-12-ai-roadmap-issue-tracking-design.md` | How the epic/roots/labels/milestone map to the backlog + maintenance rules. |
| `docs/specs/2026-06-05-v2-ai-roadmap-design.md` | The overarching roadmap (substrate, phasing, governance, cost). |
| `docs/specs/YYYY-MM-DD-*-design.md` + `docs/plans/YYYY-MM-DD-*.md` | Per-slice design + TDD plan (output of brainstorming → writing-plans). |

**Tier labels are words** (`ai:foundation`/`ai:core`/`ai:extended`), deliberately *not* `p0/p1/p2`,
to avoid collision with the severity labels `priority:p1`/`priority:p2` (an orthogonal axis).

## 4. What's shipped on `V2` so far (timeline)

| Increment | What landed | PR(s) |
|---|---|---|
| **P0-PR1** — LLM provider substrate | `PRism.AI.ClaudeCode`: `ILlmProvider`/`ClaudeCodeLlmProvider` (one-shot), availability probe + identity assert, `PromptSanitizer`, `ITokenUsageTracker` — all dark | #218 |
| **P0-PR2** — Capability model (dark) | binary→tri-state `AiSeamSelector`, per-flag `AiCapabilities` + `AiCapabilityResolver`, `ui.ai.mode` config + migration, `/api/capabilities` rewrite | #242, #250 |
| **P0-PR3a** — FE mode migration | FE `aiPreview`→tri-state `aiMode`; Off\|Preview segmented control; define-once `SampleBadge` | #293 |
| **P1 First-Light** — first real seam | live `ClaudeCodeSummarizer` (diff-grounded, PR-nature category), D111 spend gate, per-provider **egress consent** (folded into the Live predicate, backend-enforced), per-feature enablement seam, `JsonlAiInteractionLog` | #388 |
| **P1b-1** — base-rebase freshness | summary cache re-keyed on `(prRef, baseSha, headSha)`, base-change producer + eviction, R7 CAS, Live-only "Out of date" chip + Regenerate | #458 |

**In flight / next:** P0-2 real `IAiCache` (#403; child #374 ✅, #397 remaining), the rest of the
epic. P0-1b streaming + P0-4 clone + P0-7 MCP are the chat (P2-2) prerequisites.

## 5. Substrate facts (design invariants)

- **Zero-credential auth:** `claude -p` spawned by the same OS user reads the subscription OAuth
  credential `/login` wrote — PRism manages **no** AI credentials. Therefore: **never pass `--bare`**
  (skips OAuth); **scrub `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`** from the child env; the
  **sidecar must run as the logged-in user** (a service identity won't see the credential).
- **Agent SDK credit metering (effective 2026-06-15):** on subscription plans, `claude -p` draws
  from a separate, per-user, non-pooled **Agent SDK credit** PRism can't read or set; when exhausted,
  calls stop until refresh unless paid usage credits are enabled. → **caching + lazy-load are budget
  management** for a wallet we can't see. This is the standing design baseline.
- **`--resume` restores full context after a clean end** (probed v2.1.177, #479 / C4) — so cross-restart
  chat resume (P2-2) is viable. BUT it is **working-directory-scoped** (resume MUST run from the same cwd;
  PRism's stable per-user base satisfies this), **fails hard** on a cwd/id miss (must degrade to
  fresh-with-injection), and the result is **version-conditional** (CLI-update survival untested). Do NOT
  use `--resume` for cross-*feature* context forwarding (a separate session id); for that, use prompt
  caching on a stable diff prefix.

## 6. Cross-cutting conventions & gotchas (these bite every increment)

- **Backend build/test:** every `dotnet build`/`dotnet test` needs `-p:NuGetAudit=false` (sandbox
  audit feed is blocked → NU1900). CI-faithful test run: `dotnet test --settings .runsettings`
  (excludes `Category=Integration` live-GitHub tests). Run ONE build/test at a time, foreground.
- **The `rtk` proxy masks prettier/lint/vitest** — it can report "clean"/"pass" when they fail.
  **Verify via the direct binary:** `node ./node_modules/prettier/bin/prettier.cjs --check .`,
  `node ./node_modules/vitest/vitest.mjs run` (never `npx vitest`).
- **Two FE test trees:** co-located `src/**/*.test.tsx` **and** the legacy `frontend/__tests__/`
  mirror — update **both**. A migration that enumerates only one leaves the other stale.
- **`npm test` strips types** — also run `npm run build` / `tsc -b`, especially after shared-type
  changes or dep bumps, or test-file type errors slip to CI.
- **A clean merge can hide an interface break** — after a `main`→`V2` sync, *compile* the merged tree
  (a new `IConfigStore`/seam implementer on the incoming side won't conflict-mark but breaks the build).
- **CI gate = the repo's pre-push checklist** (FE lint/build/test + Release `dotnet build` +
  `dotnet test --settings .runsettings`). Run it verbatim before pushing.
- Known intermittent flakes (pass in isolation): **#280** (SSE client-abort), **#389** (files-tree
  baseline). File a tracking issue when a new flake surfaces; don't just re-run.

## 7. Governance (non-negotiable in AI surfaces)

- **Egress consent is backend-enforced**, folded into the Live predicate:
  `liveUsable = seamRegistered && providerAvailable && consentRecorded(providerId)`. No consent ⇒
  seam resolves Noop ⇒ 204, zero provider calls. `DisclosureVersion` is a constant; a material
  change (recipient / data categories / terms) bumps it and re-prompts.
- **Token-spend discipline:** on failure show a visible error but **no auto-retry / no easy Retry
  button** (invites token-burning clicks) — recovery is a deliberate action (reopen, explicit
  Regenerate). Every feature carries a **backend-enforced `userEnabled`** toggle
  (`ai.features.<key>` + `AiFeatureState`); a frontend-only hide still burns tokens. Inbox fan-out
  features are the real spenders.
- **Eval is agent-driven + human-anchored:** the owner states each feature's target intent (the
  rubric); the agent proposes a golden set (owner approves) and tunes prompts (LLM-as-judge inner
  loop); the owner's final review of tuned output is the certification that gates the phase.

## 8. Picking up the next item

1. Open **epic #423** → pick a 🟢 root in Foundations/Core (or follow daily-use signal).
2. `brainstorming` → design doc in `docs/specs/` → `writing-plans` → plan in `docs/plans/`
   (run `ce-doc-review` on each), file refined child issues linked on the root.
3. Fresh worktree + feature branch off the latest `V2`. Implement (TDD). `/simplify`.
4. `pr-autopilot` **with base overridden to `V2`**. Flip the epic line when it ships.
