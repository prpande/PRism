# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo state

PRism is **pre-implementation**. The repo currently contains only:

- `docs/spec/` — the authoritative PoC specification (read in numerical order)
- `docs/backlog/` — prioritized v2 backlog (P0 / P1 / P2 / P4; P3 was dropped)
- `docs/roadmap.md` — implementation slice plan (S0+S1 → S6); the cycle picks one slice, brainstorms it, plans it, builds it
- `docs/superpowers/specs/` — per-slice implementation design docs (output of brainstorming)
- `design/handoff/` — visual/interaction design as a self-contained HTML+JSX prototype (reference, **not** production code)
- `assets/icons/` — app icons (`PRism{16,32,48,64,256,512}.ico` + `PRismOG.png`)
- `.github/workflows/` — two `@claude` GitHub Actions (`claude.yml` for `@claude` mentions, `claude-code-review.yml` for auto-review on every PR)

There is no `PRism.sln`, no `PRism.Core` / `PRism.Web` / `PRism.GitHub` projects, no `frontend/`, no build, no tests. The spec describes them; implementation hasn't begun. **Treat the docs as the source of truth and the only thing to keep in sync until source code lands.**

`docs/README.md` is the document map. Start there. `docs/spec/00-verification-notes.md` falsifies several easy assumptions about GitHub's API surface — it's load-bearing for the rest of the spec.

## Development process

**All production code is written test-first, red → green → refactor. No exceptions.**

- **Red**: write a failing test that proves the new behavior is needed. Run it; confirm it fails for the expected reason (not a compile error or a typo).
- **Green**: write the simplest implementation that makes the test pass. Don't generalize, don't anticipate, don't add scope.
- **Refactor**: clean up while tests stay green. If refactoring breaks tests, the refactor is the cause — fix it without changing test expectations.

This applies to every slice in `docs/roadmap.md` and to every commit. The spec's DoD lists *which* tests must exist (submit pipeline, reconciliation, migration); TDD is *how* every test in the codebase comes into existence — including the ones the DoD doesn't enumerate. Tests are the spec at the implementation level: if a behavior isn't tested, it isn't required, and adding production code that doesn't make a failing test pass is a process violation.

A few practical implications:
- **Every PR's first commit on a new behavior is the failing test.** Implementation lands in a follow-up commit (or a squashed commit that clearly pairs them). A diff that shows production code without a corresponding new test is a smell — the reviewer asks why.
- **Bug fixes start with a regression test that fails on `main`.** Then the fix lands.
- **Refactors that don't change behavior do not require new tests** — the existing suite is the safety net. If the existing suite doesn't cover the area being refactored, write the tests *first* (red against current behavior, green confirming current behavior), then refactor.
- **No "I'll add tests later" backlog items.** If a test wasn't written first, the behavior wasn't actually built — the work is incomplete.
- **No mocking the system under test.** Mock external boundaries (GitHub HTTP, OS keychain, file system where it makes the test painfully slow); test real classes against real collaborators inside the project.

## Commands

No build/test/lint commands exist yet. When the .NET projects land, the spec's intended publish commands are:

```
dotnet publish -r win-x64   --self-contained -p:PublishSingleFile=true
dotnet publish -r osx-arm64 --self-contained -p:PublishSingleFile=true
```

`osx-x64` (Intel Mac) is **explicitly out of scope** for the PoC — do not add it as a publish target without a documented test path.

## Architectural invariants the spec commits to

These are decisions already made and adversarially reviewed. Don't relitigate them in implementation; if they're wrong, the spec changes first.

- **GitHub-only, not multi-provider.** `IReviewService` is GitHub-shaped (cloud + GHES via configurable `github.host`). No `IReviewProvider`, no `ProviderCapabilities.Extensions`, no `VerdictExtensions` — earlier drafts had these and they were removed. `Verdict` is GitHub's three values: `Approve | RequestChanges | Comment`.
- **Source-level Octokit isolation.** `using Octokit;` must not appear in any source file under `PRism.Core` or `PRism.Web`. Octokit ships transitively via DI registration in `PRism.Web/Program.cs`; this is a *source-hygiene* rule for testability, **not** a binary-level isolation promise.
- **Capability-flag-gated AI seams.** PoC ships every AI seam interface with a `Noop*` implementation, ~25 placeholder DTOs in `PRism.AI.Contracts`, and 9 frontend slots that render `null`. `/api/capabilities` returns `false` for every `ai.*` flag in PoC. v2 lights them up by registering implementations and flipping flags — no Core refactor.
- **Reviewer-atomic submit via GraphQL pending review.** Drafts, replies, verdict, and summary stage in a GitHub *pending review* (invisible to others) and finalize together on Submit. The `addPullRequestReview` → `addPullRequestReviewThread`/`Reply` → `submitPullRequestReview` pipeline is resumable; `pendingReviewId`, per-thread `threadId`, and per-reply `replyCommentId` are stamped into `state.json` as they come back, and a `<!-- prism:client-id:<draftId> -->` HTML-comment marker in the body closes the lost-response window. See `docs/spec/00-verification-notes.md` § C1 and § C7.
- **Banner, not mutation.** Remote state never auto-applies to the diff under the cursor or to the reviewer's drafts. Polling produces a non-intrusive banner; reload is explicit. The narrow exception is informational widgets about *other* people's content (existing comment bodies, thread-state badges).
- **Truthful by default.** PoC shows whitespace, unfiltered diffs, and every draft. Filtering/categorization is the v2 AI layer's job.
- **One host per launch.** `github.host` is set once per process; switching hosts mid-launch is not supported. On startup, `state.json.lastConfiguredGithubHost` is compared against config and a host change clears every `pendingReviewId` / `threadId` / `replyCommentId` (draft *bodies* are preserved — text is sacred).
- **Cross-platform paths.** Always `Environment.GetFolderPath(SpecialFolder.LocalApplicationData)`; never hardcode `%APPDATA%` or `~/...`. Token storage uses MSAL Extensions (DPAPI on Windows, Keychain on macOS, `libsecret` on Linux — Linux is P4 and has documented failure-mode messaging).
- **Wire-format conventions.** All JSON enums round-trip as **kebab-case lowercase** (e.g. `"prism-created"`, `"request-changes"`) via a single `JsonStringEnumConverter` with a kebab-case naming policy on the application's `JsonSerializerOptions`. New enums inherit this automatically.
- **GraphQL Node IDs are opaque.** Treat `pendingReviewId` (`PRR_…`), `threadId` (`PRRT_…`), `replyCommentId`, etc. as opaque strings — no parsing, no prefix-sniffing, no synthesizing. Equality and pass-through to GraphQL only.
- **`.prism/` is the only directory PRism creates inside the user's workspace.** All clones, worktrees, and ref caches live under `<localWorkspace>/.prism/` (or `<dataDir>/.prism/` if no workspace). User-owned clones at `<workspace>/<repo>/` must remain visibly untouched. PoC ships the audit machinery but doesn't exercise it (no chat in PoC).

## Design handoff usage

`design/handoff/` is a high-fidelity interactive prototype using inline-Babel React. **Recreate the UI in the production stack (React + Vite + TS per spec); don't lift the JSX verbatim.** Key non-negotiables called out in `design/handoff/README.md`:

- Port `tokens.css` oklch values **as-is** — don't approximate to hex. The accent-rotation system depends on the parameterized hue.
- The spacing scale jumps `--s-6` (24) → `--s-8` (32). There is no `--s-7`.
- Don't add a hero panel to the inbox. It was tried and removed.
- Don't render the right activity rail below the 1180px breakpoint.
- Light-mode `--surface-1` is `oklch(0.985 0.003 250)`, not `#fff`. The slate tint matters.
- Only PR `#1842` is deeply mocked in the prototype; other tabs render stubs. In production, every tab gets the full PR Detail view.

## Operating in this repo right now

- Most edits at this stage will be to spec or backlog markdown. When a spec change has cross-cutting consequences, search the corpus for the affected term — many spec sections reference each other and `docs/spec/00-verification-notes.md` cross-links throughout.
- `docs/spec-review.md` is transient working notes from adversarial review passes; findings get absorbed into the spec proper. Don't edit it as if it were canonical.
- The two `.github/workflows/*.yml` workflows mention `@claude` and run on every PR. Be aware that opening a PR triggers an automated Claude code review.
