# Architecture

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend runtime | **.NET 10 (LTS)** with C# 14 | Current LTS released Nov 2025. Author is most productive in C#. Self-contained binary size budget is captured at the first publish (target ≤ 150 MB; AOT investigation deferred to P4). See [verification-notes § M20](./00-verification-notes.md#m20). |
| Backend framework | **ASP.NET Core minimal APIs** | Lean, no MVC ceremony, excellent perf, built-in WebSocket support for chat in v2. |
| GitHub client | **Octokit.NET** (REST) + raw `HttpClient` (GraphQL) | REST covers most read paths (PR detail, file content, Search API, Checks). GraphQL is required for **(a)** the pending-review submit pipeline (`addPullRequestReview` → `addPullRequestReviewThread`/`Reply` → `submitPullRequestReview`) and **(b)** iteration reconstruction via `PullRequestCommit` + `HeadRefForcePushedEvent` timeline events. See [verification-notes § C1](./00-verification-notes.md#c1) and [§ C2](./00-verification-notes.md#c2). |
| Credential storage | **`Microsoft.Identity.Client.Extensions.Msal`** | Cross-platform encrypted store. DPAPI on Windows, Keychain on macOS, libsecret on Linux. Same API everywhere. Used by Azure CLI / Visual Studio. Platform caveats (macOS unsigned-build prompt, Linux headless `libsecret` unavailability) documented under "Locations on disk" below. |
| Local state | **JSON file** via `System.Text.Json`, atomic-rename writes, behind `IAppStateStore` interface | Tiny dataset (<100KB). Hand-readable. No SQL knowledge required. Migration path to SQLite if needed in v2. |
| Config | **JSON file** with `FileSystemWatcher` hot reload | Edit, save, see changes within next poll cycle. No restart. |
| Frontend | **React + Vite + TypeScript** | Web stack, modern tooling. |
| Diff viewer | **`react-diff-view`** + **`diff` (jsdiff)** for word-level | Purpose-built for PR-style diffs. Inline-widget API is *the* killer feature for inline comment threads and AI annotations. |
| Syntax highlighter | **Shiki** with a curated language subset | TextMate grammars (same as VS Code). Single instance powers diffs, code blocks in comments, and rendered-markdown code fences. Default bundled grammars (~16): TypeScript/JavaScript/JSX/TSX, C#, Go, Python, Java, Rust, Ruby, HTML, CSS, JSON, YAML, Markdown, Shell, SQL, plaintext. Other languages lazy-load on first encounter. Web worker for non-blocking highlighting on large diffs. See [verification-notes § M19](./00-verification-notes.md#m19). |
| Markdown renderer | **`react-markdown` + `remark-gfm`** | GFM features (tables, task lists, strikethrough). Custom code-block renderer dispatches by language to Shiki, Mermaid, or v2 extensions. |
| Mermaid | **`mermaid` v11**, lazy-loaded | Bundled into the React app via dynamic import (NOT a runtime fetch from a CDN — PoC is offline-capable and a network dependency would defeat the local-first posture). `mermaid` is shipped inside the self-contained binary and parsed only when a markdown file contains a `mermaid` fence; non-Mermaid pages pay zero parse/eval cost. Bundle is ~2.5–3 MB; `@mermaid-js/tiny` reserved as a future swap if first-load latency is uncomfortable in practice. See [verification-notes § M21](./00-verification-notes.md#m21). |
| API contract | Hand-written TS types in `frontend/src/types/api.ts` mirroring backend DTOs | Source of truth: `PRism.Core.Contracts`. Switch to NSwag codegen if drift becomes painful. |
| Distribution | `dotnet publish -r {win-x64, osx-arm64} --self-contained -p:PublishSingleFile=true` | One self-contained binary per platform. Size budget ≤ 150 MB; actual size measured at first publish and recorded in the README. macOS unsigned for PoC; document the right-click → Open Gatekeeper workaround. macOS Intel / `osx-x64` is **not** a PoC publish target (see `01-vision-and-acceptance.md` DoD § Cross-platform — shipping an untested target is the worst of all options). |
| Real-time UX | Background polling (30s active PR, 120s inbox) → banner UI; **server-push to the frontend via Server-Sent Events on `/api/events`**; no webhooks | GitHub webhooks require public reachability; not viable for a local tool. The backend polls GitHub on its own cadence and pushes consolidated state-change events to subscribed tabs over SSE — that is the channel the banner refresh model and multi-tab consistency depend on. WebSocket is reserved for v2 chat (its full-duplex nature is not needed for one-way banner updates). |

## Project layout

```
PRism.sln
├── PRism.Core                       ← business logic, IReviewService interface (GitHub-shaped, kept for testability/mocking)
├── PRism.Core.Contracts             ← provider DTOs (Pr, FileChange, DraftReview, PrReference, Verdict, ExistingComment, etc.). Separate project so test code and the GitHub project can reference DTOs without pulling Core's business logic.
├── PRism.AI.Contracts               ← Placeholder DTOs for AI seam interfaces (separate assembly so non-AI code can't accidentally pull AI types). Naming parallels the v2 `PRism.AI.*` per-feature projects.
├── PRism.GitHub                     ← Octokit + raw GraphQL; the concrete IReviewService implementation
├── PRism.Web                        ← ASP.NET Core host, REST API, static React serving
└── frontend/                             ← React + Vite + TS source (built into Web/wwwroot during publish)
    ├── src/
    │   ├── components/
    │   ├── pages/
    │   ├── api/                          ← thin HTTP client over backend REST
    │   ├── types/api.ts                  ← hand-mirrored from PRism.Core
    │   └── ai-slots/                     ← capability-flag-gated AI components (render null in PoC)
    └── vite.config.ts
```

### Dependency rule

`PRism.Core` defines `IReviewService` (the interface the rest of the app talks to GitHub through). `PRism.GitHub` is the only project that references Octokit and the only project that implements `IReviewService`. `PRism.Web` depends on both Core and GitHub through DI; **it has no `using Octokit;` directive in any source file** but does take a transitive *binary* dependency on the Octokit assembly through DI registration. This is **source-level dependency hygiene for testability, not binary-level isolation** — at publish time the Octokit DLL ships in `PRism.Web`'s output directory because `services.AddSingleton<IReviewService, GitHubReviewService>()` requires the GitHub assembly to be linked. A reader expecting "no Octokit DLL in PRism.Web's bin/" will be surprised; the rule is that no `PRism.Core` or `PRism.Web` source file talks to GitHub via Octokit's API surface directly, not that the binary is Octokit-free. `IReviewService` is GitHub-shaped (its method signatures, DTOs, and verdict semantics are GitHub's). A future non-GitHub backend, if ever pursued, would be a refactor of the interface, not a drop-in implementation. Earlier drafts of this spec framed the interface as `IReviewService` with multi-provider extensibility (`ProviderCapabilities.Extensions`, `VerdictExtensions`, an `PRism.Providers.AzureDevOps` stub project); all of that has been dropped — see `01-vision-and-acceptance.md` Principle 6 for the rationale.

## The `IReviewService` interface

`PRism.Core` defines a single GitHub-shaped service interface that the web layer and frontend talk to. The interface exists for **testability and DI**, not for multi-provider abstraction. There is one implementation (`PRism.GitHub.GitHubReviewService`) and no plan for additional implementations; a non-GitHub backend, if ever pursued, would be a refactor.

### `IReviewService`

```csharp
public interface IReviewService
{
    // Auth
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);

    // Discovery
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);
    bool TryParsePrUrl(string url, out PrReference? reference);

    // PR detail
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);
    Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);

    // Submit (GraphQL pending-review pipeline)
    Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct);
}
```

The interface is GitHub-shaped: `GetIterationsAsync` returns per-push iteration ranges (matching GitHub's reconstruction model); `Verdict` is GitHub's 3-state (`Approve | RequestChanges | Comment`); inbox sections are GitHub Search syntax (`review-requested:@me`, `mentions:@me`, `is:pr`). Earlier drafts framed these as "lowest common denominator" with extensibility bags (`VerdictExtensions`, `ProviderCapabilities.Extensions`) for provider-specific extras; those are gone — the spec commits to GitHub semantics directly.

### Core DTOs (in `PRism.Core.Contracts`)

PoC declares two groups of DTOs in two separate assemblies:
- **Provider DTOs** — used by `IReviewService` and the submit pipeline. Live in **`PRism.Core.Contracts`**. Listed below.
- **AI seam DTOs** — used by AI feature interfaces. Live in their own assembly **`PRism.AI.Contracts`** (separate project, parallel to v2's `PRism.AI.*` per-feature projects). Declared as placeholder records so PoC's `Noop*` implementations compile against strong types. Listed in `04-ai-seam-architecture.md` § "DTO catalogue — declared in PoC."

The two-assembly split is structural (project boundary, not folder convention): the GitHub project and other adapters reference `PRism.Core.Contracts` only and cannot accidentally take an `PRism.AI.Contracts` dependency. AI projects (`PRism.AI.*`) reference both. (Earlier wording placed the AI DTOs in a `PRism.Core.Contracts.Ai/` *subfolder* of `PRism.Core.Contracts`; that arrangement preserved the appearance of separation without enforcement, since C# does not bind subfolder to sub-assembly. The current naming also breaks the prefix-collision risk that `PRism.Core.Contracts.Ai` had — `PRism.Core.Contracts.Ai` reads as a sub-namespace of `PRism.Core.Contracts` rather than a sibling assembly.)

Provider DTOs:

- `PrReference` — concrete shape `(string Owner, string Repo, int Number)`. Round-trips to and from a stable string form `"<owner>/<repo>/<number>"` (e.g., `"acme/api-server/123"`) — used as the key in `state.json.reviewSessions[ref]` and in URL-paste parsing. The string form is the wire-portable identity; the structured form is the in-process representation. `PrReference.Parse(string)` → typed; `PrReference.ToString()` → wire-string. **No `Provider` discriminator** — earlier drafts carried a `string Provider` field with `"github"` as its only valid value; that field has been dropped along with the multi-provider abstraction. The host (cloud vs. GHES) is configured globally via `github.host` and is not part of the PR identity. Both `Parse` and the URL-paste validator share the same parser implementation in `PRism.Core.Contracts.PrReferenceParser`; malformed inputs (extra colons, missing slash, non-numeric PR number, invalid owner/repo characters) are rejected with a single error type and message shape so the inbox URL-paste error and the state-load error are consistent.
- `Pr` — title, author, state, branch info, mergeability, CI summary
- `PrIteration` — index, before/after SHA, commits, summary
- `FileChange` — path, status (added/modified/deleted/renamed), hunks
- `DiffHunk` — anchor, lines (with old/new line numbers, change type)
- `ExistingComment` — id, author, body, anchor, thread_id, parent_id, state
- `Verdict` — `Approve | RequestChanges | Comment`. GitHub's three review verdicts, full stop. (Earlier drafts paired this with a `VerdictExtensions` JSON-blob bag for provider-specific additions like ADO's `ApprovedWithSuggestions`; that bag has been dropped along with the multi-provider abstraction — the tool is GitHub-shaped, the verdict is GitHub's verdict.)
- `DraftReview` — the full payload the submit pipeline operates on:
  - `PrReference Pr`
  - `Verdict Verdict` (and a `VerdictStatus` flag for re-confirm)
  - `string SummaryMarkdown`
  - `DraftComment[] NewThreads` — drafts that will become new threads (`addPullRequestReviewThread`); each carries `(filePath, lineNumber, side, anchoredSha, anchoredLineContent, bodyMarkdown, draftId, threadId?)` where `threadId` is null until the thread is created server-side, then populated with the GraphQL `pullRequestReviewThreadId`. The stamped `threadId` is the idempotency key on retry; see `03-poc-features.md` § 6 ("Idempotency on retry"). Materialized from `state.json.reviewSessions[ref].draftComments[]`.
  - `DraftReply[] Replies` — drafts that target an existing thread (`addPullRequestReviewThreadReply`); each carries `(parentThreadId, bodyMarkdown, draftId, replyCommentId?)`. Materialized from `state.json.reviewSessions[ref].draftReplies[]` — a separate collection on disk, not unified with `draftComments[]`.
  - `string? PendingReviewId` — the GraphQL Node ID of the user's pending review on this PR if the previous submit attempt left one behind (idempotency key for resumable retry).
  - `string CommitOid` — the SHA the pending review is anchored to. Captured at submit-pipeline step 1 (`addPullRequestReview` passes `commitOID = current head_sha at submit time`). Used by the retry path to detect head-moved-since-pending-review-created (see `03-poc-features.md` § 6).
- `InboxSection` — labeled list of `PrInboxItem`
- `PrInboxItem` — id, title, author, repo, age, comment count, unread deltas. (Renamed from `PrSummary` to disambiguate from the AI summarizer's `PrSummary` return type. The two types now live in different *assemblies*: `PRism.Core.Contracts.PrInboxItem` (the inbox row, declared here) and `PRism.AI.Contracts.PrSummary` (the AI summarizer's return type, declared in `04-ai-seam-architecture.md` § DTO catalogue). The cross-assembly split reinforces that the inbox row is provider-shaped and the AI summary is feature-shaped.)
- *(`ProviderCapabilities` was previously declared here as a record with typed bools + an `Extensions` dictionary for multi-provider extensibility; it has been dropped along with the abstraction. The `/api/capabilities` endpoint still exists, but it carries only the AI feature-flag state — no provider-specific flags.)*

**GraphQL Node IDs are opaque.** The Core DTOs carry several GraphQL Node ID strings — `DraftReview.PendingReviewId` (a `PRR_…` ID), `DraftComment.threadId` (a `PRRT_…` ID), `DraftReply.parentThreadId` (also `PRRT_…`), `DraftReply.replyCommentId` (a `PRR…` comment ID). These are GitHub's internal node-identity strings issued by `api.github.com`'s GraphQL endpoint (or the configured GHES host). **AI features and other consumers must treat these as opaque strings**: do not parse the prefix, do not assume base64 encoding, do not rely on length, do not synthesize one from a non-server source. The only operations the spec promises against them are equality comparison and pass-through to GraphQL mutations. When a future consumer needs structured info derivable from a Node ID (e.g., "is this thread on iteration N?"), the consumer fetches that structurally via a separate GraphQL query, never by parsing the ID.

### GitHub host configuration (cloud + GHES)

PoC supports both **github.com cloud** and **GitHub Enterprise Server (GHES)** through a single config field:

```jsonc
{
  "github": {
    "host": "https://github.com"           // default; for GHES, set to your instance host (e.g., "https://github.acmecorp.com")
  }
}
```

Implementation:
- **Octokit** is constructed with a base API URL derived from `github.host`. For `https://github.com`, the API URL is `https://api.github.com` (cloud's special case). For any other host, the API URL is `<host>/api/v3` (GHES's standard pattern).
- The **Setup screen's "Generate a PAT" link** templates against `github.host`: `https://github.com/settings/personal-access-tokens/new` for cloud, `<host>/settings/personal-access-tokens/new` for GHES.
- The **URL-paste escape hatch** parser accepts any URL whose host equals `github.host`'s host. Pasting `https://github.acmecorp.com/owner/repo/pull/123` works when `github.host` is set to `https://github.acmecorp.com`; pasting a github.com URL when configured for GHES (or vice versa) fails with a clear error.
- The **GraphQL endpoint** is `<api_url>/graphql` per Octokit's convention.

**One host per launch.** Multi-host (a single instance talking to both github.com and a GHES instance simultaneously, or to multiple GHES instances) is not supported in PoC. Users with both a personal github.com account and a corporate GHES account can run two instances of PRism with different `<dataDir>` values, or restart the app to switch hosts. Multi-account / multi-host is a P4 backlog item if demand warrants it; for v1 the single-host constraint keeps the auth and config surfaces small.

### Local workspace and the `.prism/` subroot

PoC ships no chat, but the workspace concept is documented here because v2's `IRepoCloneService` (P0-4 + P2-2) is the consumer and the schema must be reserved now to avoid v2 reshaping `state.json` again.

**Configuration.** `github.localWorkspace` is an optional absolute path. When set, the user is telling PRism "this is the root where my git repos live." When unset (the default for users who skip the workspace picker in Setup), PRism falls back to `<dataDir>/.prism/` for clones and worktrees — same internal layout, different root.

**Directory layout under the workspace root**:

```
<localWorkspace>/                        ← e.g. /Users/me/src or C:\src
├── api-server/                          ← user's existing clone (visibly untouched)
├── web-frontend/                        ← user's other clone (visibly untouched)
└── .prism/                         ← single dedicated PRism subroot
    ├── clones/
    │   └── <owner>/
    │       └── <repo>/                  ← PRism-created clones (only when no user-owned clone exists for this repo)
    └── worktrees/
        └── <owner>/
            └── <repo>/
                ├── pr-123/              ← v2 chat session worktree contents
                └── pr-456/              ← persistent for the PR's lifetime
```

**The `.prism/` subroot is the only directory PRism creates inside the workspace.** Under it, all clones, worktrees, refs caches, and any future v2 file-state live. The user's existing clones at `<workspace>/api-server/`, `<workspace>/web-frontend/`, etc. are visibly untouched by PRism — no `.prism-worktrees/` subfolders, no PRism-suffixed clone names alongside theirs, no `.gitignore`/`.git/info/exclude` edits. Cleanup is trivially `rm -rf <workspace>/.prism/`.

**Workspace enumeration.** At backend startup (and on each PR-detail-view mount, scoped to the PR's repo), the backend lists `<workspace>/*/` one level deep — *excluding* `.prism/`. For each entry:
1. Run `git -C <path> rev-parse --git-dir` to confirm it's a git repo (skip if not).
2. Run `git -C <path> remote -v` to read all remotes; parse each URL for `<owner>/<repo>` shape (handles `https://github.com/owner/repo`, `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git`, etc.).
3. If a remote matches the configured `github.host`, record `<owner>/<repo>` → `<absolute path>` as a **user-owned clone**.

The result is persisted in `state.json.aiState.repoCloneMap` so subsequent startups skip the scan unless the workspace mtime has changed. PRism-created clones at `<localWorkspace>/.prism/clones/<owner>/<repo>/` are added to the same map with `ownership = "prism-created"`. Schema:

```jsonc
"aiState": {
  "repoCloneMap": {
    "acme/api-server":   { "path": "/Users/me/src/api-server",                                  "ownership": "user" },
    "acme/web-frontend": { "path": "/Users/me/src/web-frontend",                                "ownership": "user" },
    "acme/new-repo":     { "path": "/Users/me/src/.prism/clones/acme/new-repo",            "ownership": "prism-created" }
  },
  "workspaceMtimeAtLastEnumeration": "2026-05-05T12:00:00Z"
}
```

**Serialization policy.** The wire form is **kebab-case lowercase** (`"user"`, `"prism-created"`) — consistent with the rest of `config.json` / `state.json` (`inbox.deduplicate`, etc.). The C# enum is `CloneOwnership.User` / `CloneOwnership.PRismCreated`; the kebab-case round-trip is wired via a single `JsonStringEnumConverter` registration with a kebab-case naming policy applied to the application's `JsonSerializerOptions`. (.NET 9+ ships a built-in `JsonNamingPolicy.KebabCaseLower`; pre-9 uses a small custom policy.) The same policy applies uniformly to every C# enum that crosses the JSON boundary; new enums inherit kebab-case automatically without per-enum attributes. Tests assert the round-trip on serialize and deserialize so a future `System.Text.Json` default change cannot silently flip the wire format.

The schema is reserved in PoC (PoC writes `aiState: {}`); the v1→v2 migration adds the keys with empty defaults.

**Reusing user-owned clones.** When a user-owned clone exists for the PR's repo, the v2 chat path reuses it as the object store via `git worktree add` to an external path inside `.prism/worktrees/`:
```
git -C <user-clone> fetch origin pull/<n>/head:refs/prism/pr-<n>
git -C <user-clone> worktree add <localWorkspace>/.prism/worktrees/<owner>/<repo>/pr-<n> refs/prism/pr-<n>
```
The worktree's working-tree contents live in `.prism/`; the worktree's `.git` *file* points back to the user's clone's `.git` *directory*. The user's repo dir gains two pieces of git-internal metadata — a ref under `refs/prism/` and a worktree-tracking entry under `.git/worktrees/` — both of which are invisible in `git status`, `git branch`, and normal git workflows. PRism never writes user-visible files inside the user's clone.

**Worktree lifetime.** Worktrees persist for the PR's lifetime, not for the chat session's. A reviewer who opens chat on the same PR across multiple days reuses the same worktree (faster: no fresh `git fetch + worktree add`), and `git fetch` is run on every Reload click to sync the worktree to the latest PR head. PR-closure marks the worktree for cleanup (best-effort; not deleted immediately because the user may want to look at the closed PR's worktree). The cleanup audit (below) periodically prompts to remove worktrees on PRs closed more than 7 days ago.

**Cleanup audit.** Triggered automatically (a) **at backend startup** if total PRism disk usage exceeds 5 GB (configurable as `github.workspaceCleanupThresholdBytes`); (b) **on chat-session-end** events for the repo whose chat just ended (small, scoped check — does this repo's `.prism/` footprint now exceed the threshold?); and manually via the "Clean up disk usage" button in Settings. **PoC ships the audit machinery but does not exercise it** — PoC has no chat (no clones, no worktrees), so there is nothing to clean up; the audit code path is reached only after v2 ships chat. Documenting it in PoC's architecture is the contract the v2 contributor inherits. The audit:
1. Scans `<workspace>/.prism/worktrees/` and `<workspace>/.prism/clones/` (or `<dataDir>/.prism/...` if no workspace).
2. For each worktree, looks up the PR's state via the existing PR-state cache; flags worktrees on PRs closed/merged more than 7 days ago as candidates for removal.
3. For each PRism-created clone (under `.prism/clones/`): if no worktrees remain and no PR has been opened against this repo for 30+ days, flag the clone as a candidate.
4. **Never** flags user-owned clones for removal — the audit only deletes things under `.prism/`.
5. Surfaces a confirmation modal: *"Found N worktrees and M clones from closed PRs (~X.Y GB). Clean up? — Yes / Customize / Not now."* Customize lets the user uncheck specific items.

The audit is best-effort: if the PR-state cache is stale, we may suggest cleanup of a worktree the user still cares about. The user's confirmation step is the safety net.

**Sync-on-Reload.** Worktree fetch + reset is tied to the user's explicit Reload click on the banner — *not* to background polling. When the user clicks Reload:
1. Backend runs `git -C <clone-path> fetch origin pull/<n>/head:refs/prism/pr-<n>` (fast-forward or force-update the ref).
2. Backend runs `git -C <worktree-path> reset --hard refs/prism/pr-<n>` to update the worktree to the new head.
3. Reconciliation pass runs against drafts (per `03-poc-features.md` § 5).
4. Active chat sessions get the inject-system-message-on-head-shift treatment from `04-ai-seam-architecture.md` § "head-changes mid-session".

Background polling never touches the worktree. This preserves "banner-not-mutation" for chat in addition to drafts and diffs.

**No prefetch.** Cloning and worktree creation happen lazily, only after the user explicitly authorizes via the consent modal at chat-open time. Speculatively cloning a repo because the user *might* open chat is rejected — the disk cost is non-negligible, and most chat-skip cases would never reclaim it. The resulting "preparing chat…" spinner at first-time-on-this-repo chat-open is the honest UX for the wait.

**Changing `github.host` between launches.** The pending-review GraphQL Node IDs and `pendingReviewId` values stored in `state.json` are issued by a *specific* host's GraphQL endpoint and are meaningless against a different host. On startup, the backend compares the configured `github.host` against the host recorded in `state.json.lastConfiguredGithubHost` (a top-level field added for this purpose):
- **First launch / matching host** — record / confirm the configured host, continue normally.
- **Mismatch** — surface a one-time modal: *"You changed `github.host` from `<old>` to `<new>`. Pending reviews and draft thread/comment IDs in your local state were issued by the old host and won't match the new one. Continue (your draft text is preserved; pending-review IDs and per-thread server stamps will be cleared) or revert to `<old>`?"* On Continue, the backend clears every `pendingReviewId`, `pendingReviewCommitOid`, every per-draft `threadId` and `replyCommentId` stamp, and updates `lastConfiguredGithubHost`. Draft *bodies* and anchors are preserved — the user's text is sacred. The next submit on each PR re-creates a pending review against the new host. On Revert, the backend reverts `github.host` in `config.json` to the previous value and exits with a message asking the user to relaunch (the FileSystemWatcher rewrite is committed before exit). This treats a host change with the same conservative posture as the multi-account model — different host = different identity space.

## Data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser (React + Vite)                                               │
│   ├─ Inbox view                                                      │
│   ├─ PR detail view (file tree, diff, iteration tabs, composer)      │
│   ├─ AI slots (all gated by /api/capabilities, render null in PoC)   │
│   └─ Banner refresh component                                        │
└──────────────────────────────────────────────────────────────────────┘
            │ HTTP (REST), WebSocket (v2 chat only)
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ASP.NET Core minimal API (PRism.Web)                            │
│   ├─ /api/capabilities                                               │
│   ├─ /api/inbox                                                      │
│   ├─ /api/events           (SSE — all banner + StateChanged events)  │
│   ├─ /api/pr/{ref}                                                   │
│   ├─ /api/pr/{ref}/iterations                                        │
│   ├─ /api/pr/{ref}/diff?from={sha}&to={sha}                          │
│   ├─ /api/pr/{ref}/comments                                          │
│   ├─ /api/pr/{ref}/draft (GET/PUT — see "Draft endpoint semantics") │
│   ├─ /api/pr/{ref}/submit (POST — finalize pending review)           │
│   ├─ /api/pr/{ref}/subscribe (POST — register active-PR poll)        │
│   ├─ /api/pr/{ref}/unsubscribe (POST — unregister; also fires on SSE-disconnect) │
│   ├─ /api/pr/{ref}/file?path=...&sha=... (markdown rendering source) │
│   ├─ /api/mcp              (HTTP MCP transport for chat — v2; bearer auth)        │
│   ├─ /api/pr/{ref}/chat    (WebSocket for chat session — v2)         │
│   ├─ (/api/auth/start-device-flow ships in P4-G3 OAuth device flow; NOT in PoC)    │
│   └─ Background pollers                                              │
└──────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PRism.Core (interfaces) + IReviewService impl                  │
│   ├─ AppStateStore (JSON file, atomic writes)                        │
│   ├─ ConfigStore (JSON file, hot reload via FileSystemWatcher)       │
│   ├─ TokenStore (MSAL extensions)                                    │
│   ├─ ReviewEventBus (pub/sub)                                        │
│   └─ AI seams (no-op stubs in PoC)                                   │
└──────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PRism.GitHub                                                    │
│   ├─ Octokit.NET (REST) — base URL from config.github.host           │
│   └─ HttpClient + GraphQL queries (timeline, pending-review pipeline)│
└──────────────────────────────────────────────────────────────────────┘
            │ HTTPS
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ api.github.com  (cloud)  — or  <ghes-host>/api/v3  (GHES)            │
└──────────────────────────────────────────────────────────────────────┘
```

## Distribution

### PoC distribution model

- Self-contained single-file binary per target platform: `PRism-win-x64.exe`, `PRism-osx-arm64`. (`osx-x64` was an earlier target; dropped in PoC because there is no test path for it.)
- Each binary includes the .NET runtime + the built React assets in `wwwroot`. Size budget ≤ 150 MB; the actual measurement is recorded at first publish. AOT publish is investigated as a P4 size-reduction option but is not required for PoC. See [verification-notes § M20](./00-verification-notes.md#m20).
- **No installer.** User downloads the binary, runs it, browser auto-launches at `http://localhost:<port>`.
- **No code signing in PoC.** Document the macOS Gatekeeper workaround (right-click → Open the first time).
- **No auto-update in PoC.** v2 backlog item.
- Distribution channel: direct download from a GitHub release, or git-source clone for engineering colleagues.

### Auto-launching the browser

Cross-platform via `Process.Start`:

- Windows: `Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })`
- macOS: `Process.Start("open", url)`
- Linux: `Process.Start("xdg-open", url)`

Encapsulate in a small `BrowserLauncher` helper.

### UI shell flexibility (architectural note)

The PoC is browser-launched, but the architecture is **deliberately compatible with a swap to a native desktop window** without touching anything else. The frontend is React served over localhost; the backend is ASP.NET Core. A native shell (Photino.NET on Windows/macOS/Linux, using each OS's WebView) would replace the browser launcher with a window-creation call (~10 lines) and otherwise leave the system unchanged.

This is tracked as a v2 backlog item (`backlog/05-P4-polish.md` → P4-K12). The two modes (browser-based and native-window-based) can also coexist — the same backend serves both, the user picks per launch. Future contributors should preserve this property: avoid frontend code that assumes a real browser context (e.g., relying on browser-only APIs like the back/forward stack as a navigation primitive instead of in-app routing).

### Port selection

Default port `5180`. If port in use, try `5181`–`5199`. If all in use, fail loudly with a clear message. Port chosen at startup is logged to console and used for the browser launch.

**Why a fixed range and not OS-assigned ports.** Letting the OS pick a free port (`new IPEndPoint(IPAddress.Loopback, 0)`) would avoid the 20-port ceiling and the rare "all-in-use" failure. The trade-off is that the **CSRF defense's `Origin` check** (see "Cross-origin defense" below) becomes harder to reason about: the user's browser bookmarks, the documentation's example URLs, and any external integration would not have a stable origin to compare against. The fixed range gives a small, predictable origin set (20 possibilities) that's still trivially documented. 20 is enough for any reasonable concurrent-launch pathology — if the user has 20 stale PRism instances running, something else is wrong. The range is a deliberate trade favoring a stable Origin contract over flexibility.

**Why 5180 specifically.** The 5180–5199 range is outside the most-crowded common-dev-server clusters (Vite/Webpack/CRA dev servers around 3000–3001/8080–8081, Next.js around 3000, the 5500s for VS Code Live Preview / Live Server). Single-port collisions still happen — a user running another tool on 5180 falls through to 5181 silently. If a future review reveals 5180 has become crowded, the range can shift wholesale to a less-trafficked block (e.g., 14760–14779) without breaking anything beyond stale documentation; the `Origin` contract carries the actual port at runtime.

### Suppressing browser auto-launch (`--no-browser`)

The default startup auto-launches the system browser at `http://localhost:<port>`. Users running PRism on a remote machine over SSH (or in a tmux session, or as a managed service) need to suppress this — the auto-launch would either fail (no display) or open a browser on the wrong machine. The CLI accepts `--no-browser` to skip the launch; the chosen port is still logged to stdout so the user can navigate manually (or forward the port via `ssh -L`). Document in the README's "Running on a remote machine" section.

## Locations on disk

All paths use `Environment.GetFolderPath(SpecialFolder.LocalApplicationData)` (cross-platform; resolves to `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.local/share` on Linux).

```
<LocalApplicationData>/PRism/
├── config.json              ← user preferences (hot-reloaded)
├── state.json               ← drafts, view state, iteration cache
├── state.json.lock          ← lockfile preventing two backend instances on same data dir
└── logs/                    ← rolling text logs
```

Token storage is in the OS keychain via MSAL Extensions, NOT in the data directory.

### Platform caveats for keychain access

- **macOS unsigned builds.** Keychain Services typically requires a code-signed identity to write/read entries without prompting. PoC explicitly skips signing (see "No code signing in PoC" below). The likely user-visible consequence: macOS prompts the user with an "Allow / Always Allow / Deny" dialog the first time the unsigned `PRism` binary reads its keychain entry. **Clicking "Always Allow" suppresses subsequent prompts** for that binary + that keychain entry — the user is not asked again unless the binary is re-built (different code signature) or moved. Code signing in P4-K4 prevents the dialog entirely (no prompt even on first launch). Both mechanisms work; "Always Allow" is the user-side fix, code signing is the maintainer-side fix. The first-run setup flow mentions both so the user knows what's happening.
- **Linux headless / containerized environments.** MSAL Extensions on Linux uses `libsecret` (gnome-keyring or kwallet). On systems without a desktop session — headless servers, minimal containers, WSL without keychain agents — `libsecret` is unavailable and credential operations will fail at runtime. PoC does not actively support these environments (Linux is in the P4 backlog for explicit testing — see `spec/05-non-goals.md`). The startup probe distinguishes three failure cases by inspecting the underlying error rather than collapsing them into one message:
  - **`libsecret` library not installed** (the binary cannot find `libsecret-1.so.0`) → "OS keychain library not installed on this system. Install `libsecret-1` (Debian/Ubuntu: `apt install libsecret-1-0`; Fedora: `dnf install libsecret`), then restart PRism."
  - **`libsecret` is installed but no keyring agent is running** (DBus connection refused, "no provider registered") → "OS keychain library is installed but no keyring agent is running. Start `gnome-keyring-daemon` or `kwalletd`, then restart PRism. Common on WSL and minimal desktop sessions."
  - **`libsecret` runs but credential operations fail** (any other error) → "OS keychain returned an error: `<message from MSAL>`. See `<dataDir>/logs/` for details."
  These map to specific exception types thrown by MSAL Extensions; the implementation pattern-matches the inner exception (`DllNotFoundException` → install hint; DBus-related → agent hint; other → generic). A plain-file credential fallback gated on user opt-in is a P4 item; PoC does not ship it because it would be a footgun on signed-binary builds where the keychain works.

## Draft endpoint semantics

`/api/pr/{ref}/draft` is the single funnel for all writes to a PR's review-session payload (drafts, replies, summary, verdict, iteration overrides). The wire shape:

- **`GET /api/pr/{ref}/draft`** — returns the full review-session payload for that PR: `{ draftVerdict, draftVerdictStatus, draftSummaryMarkdown, draftComments[], draftReplies[], iterationOverrides[], pendingReviewId, pendingReviewCommitOid, viewedFiles }`. Empty object if no session exists yet for the PR.

- **`PUT /api/pr/{ref}/draft`** — body is a partial `ReviewSessionPatch` (a typed object with optional fields for each writable element):
  ```jsonc
  {
    "draftVerdict": "approve" | "requestChanges" | "comment",           // set/replace; explicit null-clear unsupported in S4 wire — see deferrals "PR3 wire-shape gap: explicit verdict-clear has no sentinel"
    "draftSummaryMarkdown": "...",                                       // string replace
    "newDraftComment": { filePath, lineNumber, side, anchoredSha, anchoredLineContent, bodyMarkdown },     // append; backend assigns `id`
    "newPrRootDraftComment": { bodyMarkdown },                           // append PR-root (file-scope) draft; backend assigns `id`
    "updateDraftComment": { id, bodyMarkdown? },                         // edit existing draft body
    "deleteDraftComment": { id },                                        // discard
    "newDraftReply": { parentThreadId, bodyMarkdown },                   // append reply; backend assigns `id`
    "updateDraftReply": { id, bodyMarkdown? },
    "deleteDraftReply": { id },
    "confirmVerdict": true,                                              // re-confirm verdict after a NeedsReconfirm reload (clears the status)
    "markAllRead": true,                                                 // bookmark the highest issue-comment id as seen (subscriber-only — 404 otherwise)
    "overrideStale": { id },                                             // mark a Stale draft/reply as user-acknowledged-stale; classifier short-circuits it back to Draft until the next head shift
    "iterationOverridePatch": { addOverrides[], removeOverrides[] },     // merge/split persistence
    "fileViewedToggle": { filePath, viewedAtSha }                        // mark/unmark viewed
  }
  ```
  Exactly **one** of these fields is set per request; the backend rejects multi-field patches with 400. The single-field constraint makes `StateChanged.fieldsTouched` deterministic ("the field that was set, plus any derived state — e.g., `lastSeenCommentId` if a comment-related field was touched"). `markAllRead` requires the caller's session-cookie to also have an active SSE subscription registered for `{ref}` — closes the drive-by-tab vector where a navigator could mark a PR's comments as seen by URL alone (spec § 4.7).
- **Response**: `{ assignedId?: string }` for `newDraftComment` / `newDraftReply` (server-generated UUIDv4 the client adopts); empty body otherwise. The full updated state is *not* returned — clients re-`GET` if they need it; the SSE `StateChanged` event tells other tabs to refresh.

There is no `DELETE /api/pr/{ref}/draft/{id}` route — discards go through `PUT` with `deleteDraftComment` / `deleteDraftReply`. This keeps the endpoint count small and the SSE-event-fan-out logic uniform.

**Body validation rules.** `bodyMarkdown` on `newDraftComment`, `updateDraftComment`, `newDraftReply`, and `updateDraftReply` is **rejected with 400 if it is empty after `String.Trim()`** (whitespace-only counts as empty). Reasons: (a) the submit pipeline's lost-response adoption matcher relies on the body uniquely identifying drafts of the same line via the `<!-- prism:client-id:<id> -->` marker (an empty body is fine for that), but (b) GitHub's `addPullRequestReviewThread` rejects empty `body` with 422, so allowing an empty draft locally would only postpone the failure to submit time; (c) the user has explicit Discard affordances if they want to drop a draft. Surfaces an inline error in the composer: *"Comment body can't be empty."* The same rule applies to `draftSummaryMarkdown` only at submit time — drafting an empty summary is fine pre-submit; submit blocks per the empty-pipeline rule (§ 6 Submit button rule (a)).

`POST /api/pr/{ref}/submit` is the only other write path on a PR's state; it consumes drafts and produces a submitted review.

## PR polling lifecycle

The active-PR poller (30s cadence) and the inbox poller (120s) need an explicit subscribe/unsubscribe protocol so the backend doesn't accumulate stale subscriptions over time, and so multi-tab semantics are predictable.

### Subscription protocol

- **Inbox subscription** is implicit: the backend always polls inbox while at least one tab has an open SSE connection (`/api/events` subscriber count > 0). When the last tab closes, inbox polling pauses; resumed on next subscriber.
- **Active-PR subscription** is explicit per-tab. When a tab navigates to the PR detail view, it sends `POST /api/pr/{ref}/subscribe`. The backend records `(tabId, prRef)` in an in-memory subscription set and ensures the PR-poller is running for that ref. When the tab navigates away (or closes), it sends `POST /api/pr/{ref}/unsubscribe`. `tabId` is the per-launch session token (used for CSRF) plus a tab-scoped UUID generated at SSE-connect time.
- **Multiple tabs same PR**: backend polls that PR once at 30s cadence regardless of subscriber count. SSE events fan out to all subscribed tabs.
- **Multiple tabs different PRs**: backend polls each subscribed PR at 30s. Each cycle issues **3 REST calls per PR** (`pulls/{n}` + `pulls/{n}/comments` + `pulls/{n}/reviews`), so N subscribed PRs cost `N × 6` calls/min. The core REST budget is 5000/hour ≈ 83 calls/min; the active-PR poller fits ~13 concurrent PRs at 30s cadence before saturating its share. PoC's UI surfaces one PR at a time so this ceiling is not load-bearing for v1; multi-PR tabs (P4-F6) is when the throttle matters and the pollers will need to either share calls (combined `pulls/{n}` graph query for several PRs at once) or downshift to 60s cadence — that is a P4-F6 design problem, not a PoC problem. The earlier "~80 PRs" figure was based on a 1-call-per-cycle assumption and has been corrected here.

### Subscription garbage collection

- **Tab closes cleanly**: `unsubscribe` request fires from `beforeunload`; backend removes the subscription.
- **Session token mismatch after backend restart**: when a tab re-subscribes after the backend has restarted, its old per-launch session-token cookie no longer matches the new backend instance's token. The backend rejects the mutation with 403 + a `X-Session-Token-Mismatch: true` response header (and a body that names the recovery action). The frontend's API client recognizes the header, performs a `GET /` to receive the new session-token cookie, and replays the original mutation transparently. The user sees a brief loading indicator on writes immediately after a backend restart, not an error toast.
- **PAT rotation mid-pipeline**: if the user rotates their GitHub PAT (replaces the token via Setup) while a submit pipeline is mid-flight, the next mutation in the pipeline will 401. The 401 wrapper's "401 mid-composer / mid-mutation" recovery applies (see `03-poc-features.md` § 12) — re-auth as a modal overlay, then resume the pipeline from the same step. Drafts and `pendingReviewId` are preserved across the re-auth.
- **Tab crashes / navigates without unsubscribe**: the SSE connection drops. The backend listens for SSE-disconnect events on the underlying connection and removes the tab's subscriptions on disconnect. A subscription with no SSE connection survives at most one polling cycle before garbage collection.
- **Backend crashes / restarts**: in-memory subscriptions are lost. Frontend tabs detect SSE disconnection on reconnect and re-subscribe automatically as part of the reconnect handshake.

### Idle eviction

A subscribed tab that has been hidden (`document.visibilityState === 'hidden'`) for more than 5 minutes downgrades to `inactive`: backend stops polling its PR until the tab returns to `visible`. The tab is still subscribed; the polling is just paused. This avoids polling for dozens of background tabs that the user has not closed.

**On visibility resume**, the backend immediately runs one poll for that PR (rather than waiting up to 30s for the next cadence tick), then resumes the regular cadence. Cost: one extra REST cycle per wake event; benefit: the user does not see stale data for up to 30s after returning to a tab they intentionally re-foregrounded.

### SSE backpressure for slow consumers

A subscribed tab whose JavaScript is throttled (backgrounded, hung) does not disconnect — its TCP receive buffer just stops draining. Without a guard, the backend's send buffer to that tab fills, every state mutation has to fan-out to the stalled connection, and the system slows. Each SSE writer therefore enforces a **per-message write timeout of 30s**. If a write to a tab's SSE connection blocks longer than that, the backend treats the connection as disconnected, runs the unsubscribe path for that tab, and logs *"SSE consumer evicted: write timeout."* The tab may reconnect later (its SSE-reconnect logic re-establishes the channel and re-subscribes); from the backend's view, the eviction is the same as any other disconnect.

### Why this matters for the wedge

Without an explicit lifecycle, the backend either polls every PR ever opened in this launch (rate-limit catastrophe over a workday) or polls only one (multi-tab broken, contradicting the multi-tab consistency story below). The lifecycle above is the contract the rest of the spec depends on — the SSE channel, banner refresh, and multi-tab model all assume it.

## Caching strategy by consumer

`IReviewService` is intentionally **un-cached** (see `04-ai-seam-architecture.md` § "Caching ownership for the per-turn snapshot"). Each consumer that needs caching owns its own strategy, scoped to that consumer's invalidation rules. PoC and v2 ship the following caches; the table is the authoritative list so v2 contributors don't accidentally introduce a sixth.

| Consumer | Scope | Lifetime | Invalidation trigger | Notes |
|---|---|---|---|---|
| Inbox poller (per-section in-memory) | Per `(section_id, query_hash)` | Until next polling cycle | Polling cycle (120s default) replaces wholesale | "Latest poll result" store, not a TTL cache. Reduces frontend-driven re-requests within a polling window; does not reduce per-poll-cycle GitHub traffic. See § Inbox > Implementation notes. |
| Awaiting-author "user's last review per PR" cache | Per `(pr_ref, head_sha)` | Until `head_sha` changes | `head_sha` change → key miss naturally | Avoids 30 extra `pulls/{n}/reviews` calls per inbox refresh on cold start. |
| CI-failing-PR check-runs cache | Per `(pr_ref, head_sha)` | Until `head_sha` changes | `head_sha` change | Same key shape as above; both caches sit in the inbox poller. |
| Active-PR poller (in-memory poll-result store) | Per `pr_ref` | Until next 30s polling cycle | Polling cycle replaces wholesale | Same shape as inbox; rate-limit-aware. See `03-poc-features.md` § PR detail "Banner refresh on PR update." |
| Reconciliation-pass file content | Per `(file_path, sha)` | Lifetime of one Reload | Reload completes | Used only during the reconciliation pass; in-memory and discarded after. |
| Markdown-rendering source | Per `(file_path, sha)` | Per session | Application restart | Backing for `GET /api/pr/{ref}/file?path=...&sha=...`. See `03-poc-features.md` § 7 "Markdown rendering." |
| Chat per-turn `IReviewContext` snapshot (v2, P2-2) | Per `(pr_ref, head_sha)` | Lifetime of chat session | `head_sha` change (`PrUpdated` event subscriber) | Owned by chat. PR detail / comments / iterations / diff cached together. ~50 LOC of caching code in P2-2. |
| `IAiCache` (v2, P0-2) | Per `<feature>:<provider>:<pr_ref>:<head_sha>:<input_hash>` | TTL or `head_sha` change | `IReviewEventBus.PrUpdated` invalidates the prefix | Two-tier (in-memory + file-based at `<dataDir>/llm-cache/`). |

**Why the proliferation is acceptable.** Each cache has a different invalidation rule and lifetime; merging them into a single decorator over `IReviewService` would force one cache's rules onto every consumer (some need 30s freshness, some need session-lifetime, some need per-`head_sha`). The cost of having seven caches is documentation and discipline — every new consumer that needs caching consults this table to decide whether an existing cache fits or a new one is justified, and a new cache adds a row here. The cost of *not* having it documented is a v2 maintainer adding cache layer #8 with a subtly different invalidation rule and the resulting "why does my reload show stale comments for 30 seconds" mystery.

**HTTP-client-level caching is out of scope** for PoC. The middle-ground option (one `HttpClient` cache with cache-control headers configurable per call) is plausible but adds a v2-only abstraction that no current consumer asks for; revisited if a consumer with very-low-latency needs lands.

## Concurrency model

- **Single backend mutex** around writes to `state.json`. Each write is one transaction: serialize the new in-memory state, atomic-rename to `state.json`, and *then* publish the corresponding `IReviewEvent`s. If the disk flush fails (disk full, permissions, atomic-rename fails on Windows), the in-memory mutation is **rolled back** to the snapshot taken at the start of the transaction; the API returns `503 ServiceUnavailable` with an explanatory body; no SSE event is published. This preserves the "disk and memory agree on what state is" invariant — a subsequent successful save sees the original state, not the partially-mutated one. Process-killed-mid-flush is handled separately by atomic-rename: the on-disk file is always either the old or the new version, never partially-written; the SSE event simply doesn't fire for that mutation, and tabs see the new state on next read.
- **Mutex granularity for the submit pipeline.** The submit pipeline (`03-poc-features.md` § 6) runs a multi-step GraphQL sequence (`addPullRequestReview` → `addPullRequestReviewThread` × N → `addPullRequestReviewThreadReply` × M → `submitPullRequestReview`), with each external call followed by a local `state.json` persist (stamping `pendingReviewId`, `threadId`, `replyCommentId` as they come back). **Each external GitHub call's local-persist is a separate mutex-protected write** — the pipeline is not held under a single transaction. Specifically: (a) the mutex is acquired only for the duration of each individual `state.json` write, not for the GraphQL call itself; (b) other tabs can save drafts on *other* PRs concurrently with a submit, and even on the *same* PR for fields the pipeline is not actively touching (the multi-tab last-writer-wins rule applies); (c) within the submit pipeline, the spec's resumable state machine handles partial-progress from interleaved writes — `threadId` stamps land one at a time and the pipeline's resume logic verifies them before advancing. This trade keeps a slow submit (multi-second GraphQL roundtrips) from blocking every other tab's drafts; the cost is that the submit's atomicity is "atomic from the reviewer's perspective via the GraphQL pending-review pattern" (per § C1), not "atomic at the local mutex level."
- **Two browser tabs hitting the same backend = OK** for write integrity. Backend serializes writes naturally and the JSON file never corrupts.
- **Two backend instances on the same data directory = blocked** by lockfile. Second instance detects, refuses to start, exits with a clear message.
- Reads from in-memory copy of state, no contention.

### Multi-tab consistency

Backend mutex protects the *file*; it does not propagate state changes to other tabs' React state. PoC's policy is **eventual consistency via polling**:

- Every tab subscribes to the `/api/events` SSE stream (the same one used for the banner update model). On every state-mutating endpoint (`PUT /api/pr/{ref}/draft`, `POST /api/pr/{ref}/submit`, etc.), the backend publishes a `StateChanged(ref, fields_touched)` event after the file is flushed.
- Other tabs receive the event and **re-fetch the affected slice** of state (e.g., the draft list for that PR). They do not naively overwrite local in-memory state — if the user is currently typing in a composer for the same PR, the composer text is preserved and only non-composer state (other drafts, file view state) is reconciled.
- **Last-writer-wins on conflicting *edits* to the same draft.** If Tab A and Tab B both call `updateDraftComment` against the same draft `id` within the same polling window, the second write replaces the first silently. The `StateChanged` event lets the losing tab observe the change after-the-fact, but PoC does not surface a conflict UI. This is a known imperfection; a v2 backlog item (P4-F9 — "multi-tab conflict notification") will reopen if reviewers report losing comments.
- **Two tabs creating new drafts on the same line is allowed, not deduplicated.** If Tab A and Tab B both call `newDraftComment` with the same `(filePath, lineNumber, side, anchoredSha, anchoredLineContent)`, the backend assigns two distinct draft IDs and both drafts persist. This is intentional — two distinct opinions from the same reviewer on the same line is rare but valid (e.g., the user typed two thoughts in two tabs and meant to keep both). The submit pipeline sends both as separate `addPullRequestReviewThread` calls; github.com renders them as two threads anchored to the same line. The user dedupes manually via the existing "Discard" affordance if they didn't mean to keep both. Backend-side dedup at create time was considered and rejected: it would silently swallow the second draft, violating "the reviewer's text is sacred."
- **Tabs viewing different PRs** don't collide: the mutex serializes writes but events are filtered by `pr_ref` so each tab only re-fetches its own PR's slice.
- **`iterationOverrides` (right-click iteration tab merge / split).** Merges and splits are persisted under `state.json.reviewSessions[ref].iterationOverrides`. Two tabs viewing the same PR share the same override list — the change is published as a `StateChanged(ref, fields_touched: ["iterationOverrides"])` event, and other tabs re-render the iteration tab strip on receipt. If tab A merges iterations 2 and 3 while tab B is currently viewing iteration 3, tab B's iteration tab strip rerenders to show the merged tab (a brief toast: "Iterations 2 and 3 were merged in another tab"). **In-flight composer is preserved**: if tab B has an open composer with non-empty content when the SSE arrives, the composer stays open with its anchor (file path + line number + anchored line content) intact; only the iteration tab strip behind it rerenders. The composer's anchor is independent of which iteration tab is "selected" — the underlying file + line still exists, even if the iteration grouping shifted. This is the same principle as the banner-not-mutation rule: remote-driven changes do not disturb active user work; only the surface chrome (tab strip) updates.

The combination — mutex + per-PR SSE events — gives correct durability and acceptable perceived consistency without optimistic locking or last-writer-wins detection in PoC.

### Lockfile cleanup on hard crash

`state.json.lock` is a sentinel file containing the backend's PID **and the binary's absolute path** (one JSON-encoded record: `{ "pid": <int>, "binaryPath": "<absolute path>", "startedAt": "<ISO8601>" }`). The binary path lets the false-positive collision check distinguish "another `PRism` is running" from "the OS recycled my old PID for a different process." On startup, the backend reads the lockfile (if present) and:

- If the PID is **alive** and is a running `PRism` process → another instance is running; refuse to start with a clear message.
- If the PID is **dead** (no such process) → the previous instance crashed without releasing the lock; log a warning ("Recovered from stale lockfile from PID *X*"), overwrite the lockfile with the current PID, continue startup.
- If the PID is **alive but is not `PRism`** (e.g., the OS recycled the PID for another process) → treat as dead-lock case; warn and continue. The probability of false-positive collision is low given how short-lived backend instances tend to be.

On Windows, file-locking via `FileShare.None` is auto-released on process exit but the lockfile *content* persists. The PID-liveness check above handles cleanup. On macOS / Linux, advisory locks are tricky: `fcntl(F_SETLK)`-style locks are released when *any* file descriptor pointing at the file is closed, not just the lock-holder's, so the .NET runtime's lock primitive is **not** a reliable single source of truth on POSIX. The PID-liveness check is the actual mechanism on POSIX too (not just belt-and-suspenders); the OS-level `flock`/`fcntl` is best-effort defense in depth.

This avoids the cliff where killing the backend via Task Manager / `kill -9` leaves the user unable to relaunch.

**Atomic-create-or-fail for the initial lockfile write.** The PID-liveness check covers takeover from a dead instance; it does not cover the race where two backend instances launch within the same handful of milliseconds, both observe an absent (or dead-PID) lockfile, both decide to take over, and both proceed. The fix: the *first* write of a fresh lockfile uses **atomic create-only** semantics — POSIX `O_EXCL | O_CREAT` (`File.Open` with `FileMode.CreateNew` in .NET maps to this on every platform), Windows equivalent via `CreateFile` with `CREATE_NEW`. If the create-only call fails because another process won the race and created the file first, fall back to "read existing → check PID liveness → take over if dead, refuse if alive." The race is closed by the OS-guaranteed atomicity of create-only writes; the PID-liveness branch handles the dead-lock-takeover case as before.

**Torn-write recovery.** The lockfile content (`{ pid, binaryPath, startedAt }`) is not subject to atomic-rename discipline; a power-cut or kill mid-PID-takeover write could leave the file with truncated or invalid JSON. On startup, if the lockfile parses fail, treat the lockfile as missing (the same path as "no lockfile present") and proceed to the atomic-create-or-take-over flow. Log a warning ("recovered from malformed lockfile") so the maintainer notices if this happens repeatedly. This adds one branch to startup and avoids a "permanently locked-out by a corrupted JSON" cliff.

## Configuration schema

The full strawman config (including the v2-reserved `llm` block) is in [`spec/04-ai-seam-architecture.md`](./04-ai-seam-architecture.md#configuration-schema-poc-documents-the-shape-v2-uses-it) under "Configuration schema." The shape:

```jsonc
{
  "polling": { "activePrSeconds": 30, "inboxSeconds": 120 },
  "inbox": { "sections": { ... }, "showHiddenScopeFooter": true },
  "review": {
    "blockSubmitOnStaleDrafts": true,
    "requireVerdictReconfirmOnNewIteration": true
  },
  "iterations": {
    // S3 ships only `cluster-gap-seconds` and `clustering-disabled` as live `IterationsConfig`
    // fields. Coefficients are constant per process lifetime today (defaults live in
    // `IterationClusteringCoefficients`'s record-init in `PRism.Core/Iterations/`). The
    // `clustering-coefficients` shape below is the planned future binding — when the
    // `IOptionsMonitor<IterationClusteringCoefficients>` wiring lands (alongside P0-9
    // calibration), this is the JSON shape it will read. Today, writing this block to
    // `config.json` is a no-op (unknown fields are ignored on deserialize). See
    // `iteration-clustering-algorithm.md` § "Coefficient surface" for the full story.
    "cluster-gap-seconds": 60,                     // Bound today but **inert** — `WeightedDistanceClusteringStrategy` reads coefficients from `IterationClusteringCoefficients`, not from this field; setting it has no behavior change. Legacy field on `IterationsConfig`, originally the only iteration-clustering knob; kept on the record for v1-config-file backward-compat (no warning is emitted on unknown changes). **Slated for removal in S4** (alongside S4's drafts/replies/reconciliation field additions and migration #2; remove the field from `IterationsConfig` in the same migration that wraps `AppState` per ADR-S4-1).
    "clustering-disabled": false,                  // Live today. Calibration-failure escape hatch — set true to disable WeightedDistance globally and force every PR onto `CommitMultiSelectPicker`. Default ships `false` (algorithm runs on every PR); flip to `true` if discipline-check agreement on a real corpus is unsatisfactory. See `iteration-clustering-algorithm.md` § "Calibration-failure escape hatch."

    // ⚠ The `clustering-coefficients` block below is **NOT BOUND today** — writing it to
    // `config.json` is a silent no-op (no warning is emitted on the unknown field). Coefficients
    // are constants per process lifetime; tuning requires a code edit to
    // `IterationClusteringCoefficients`'s record-init defaults and a rebuild. The shape is shown
    // here so the future `IOptionsMonitor<IterationClusteringCoefficients>` binding (P0-9 era)
    // has a published target. **DO NOT copy this block into `config.json` expecting it to take
    // effect.** See `iteration-clustering-algorithm.md` § "Coefficient surface" for the full story.
    "clustering-coefficients": {
      "file-jaccard-weight":              0.5,    // FileJaccardMultiplier signal weight. 0 = ignore; values approaching 1 reduce distance toward zero (validator enforces strictly < 1).
      "force-push-after-long-gap":        1.5,    // ForcePushMultiplier value when both conditions are met.
      "force-push-long-gap-seconds":      600,    // Below this gap, force-push is treated as a tight --amend (no expansion).
      "mad-k":                            3,      // MAD threshold = median + mad-k × MAD.
      "hard-floor-seconds":               300,    // Distance clamp floor.
      "hard-ceiling-seconds":             259200, // Distance clamp ceiling (3 days).
      "skip-jaccard-above-commit-count":  100,    // Above this commit count, skip the per-commit changedFiles fan-out.
      "degenerate-floor-fraction":        0.5     // If more than this fraction of distances clamp to the floor, declare the PR's signal too weak.
    }
  },
  "logging": {
    "level": "info",                         // "info" | "debug"; affects file logs in `<dataDir>/logs/`. No telemetry, no remote upload.
    "stateEvents": true,                     // forensic append-only state-event log at `<dataDir>/state-events.jsonl`. Default on; users opting for "nothing-on-disk-but-state.json" set false.
    "stateEventsRetentionFiles": 30          // rotation cap; 30 files × 10 MB each = ~300 MB ceiling. See § "Append-only state event log."
  },
  "ui": { "theme": "system" },
  "github": {
    "host": "https://github.com",                    // override to your GHES host (e.g., "https://github.acmecorp.com") for GitHub Enterprise Server. See § "GitHub host configuration" for the validator + host-change-between-launches rules.
    "localWorkspace": "/Users/me/src"                // optional; root directory where the user keeps their git repos. v2 chat uses this to (a) discover repos the user has already cloned (no duplicate clone), (b) place new clones it has to create (under `<localWorkspace>/.prism/clones/`), and (c) place all worktrees (under `<localWorkspace>/.prism/worktrees/`). Fall back to `<dataDir>/.prism/` if `null` (the default for users who skip the workspace picker in Setup). Empty in PoC because PoC ships no chat; field is read by P2-2 (chat) onwards. See § "Local workspace and the `.prism/` subroot" below.
  },
  "llm": {                                  // present but ignored in PoC
    "provider": "claude-code",
    "model": "claude-opus-4-7",
    "userProfile": {},                      // shape reserved; populated in v2
    "features": {
      "summary": { "enabled": false },
      "fileFocus": { "enabled": false },
      "chat": { "enabled": false },
      "hunkAnnotations": { "enabled": false },
      "composerAssist": { "enabled": false },
      "draftSuggestions": { "enabled": false },
      "preSubmitValidators": { "enabled": false },
      "draftReconciliation": { "enabled": false },
      "inboxEnrichment": { "enabled": false },
      "inboxRanking": { "enabled": false }
    }
  }
}
```

## State schema (PoC)

> **Casing note.** The example below uses **camelCase** keys for readability and to match the C# property names, but `state.json` on disk uses **kebab-case** for every property: `JsonSerializerOptionsFactory.Storage` applies `KebabCaseJsonNamingPolicy` to all property names (e.g. `LastViewedHeadSha` C# → `last-viewed-head-sha` JSON; `ReviewSessions` → `review-sessions`; `ViewedFiles` → `viewed-files`; etc.). Dictionary *keys* are intentionally NOT kebab-cased (file paths, repo identifiers must round-trip identically). When extending the schema, name the C# property in PascalCase as usual; the policy converts at write-time. When hand-editing `state.json` (rarely supported — see "Hand-edits" note below), use the kebab-case form.

```jsonc
{
  "version": 2,                                  // S3 ships v1 → v2: adds `viewed-files` per session. v1 files are migrated on first load via `MigrateV1ToV2` in `AppStateStore`. Files already at v2 are loaded as-is. See § "Schema migration policy" below.
  "reviewSessions": {
    "owner/repo/123": {
      "lastViewedHeadSha": "abc...",
      "lastSeenCommentId": "12345",
      "draftVerdict": "approve",
      "draftVerdictStatus": "draft",                  // re-confirm logic compares the PR's current head_sha against `lastViewedHeadSha`; no separate anchor-SHA field is stored (an earlier draft kept `draftVerdictAnchorSha` here with no producer or consumer; it has been dropped).
      "draftSummaryMarkdown": "...",
      "pendingReviewId": null,                // GraphQL Node ID (PRR_...) of the user's pending review on this PR; populated mid-submit and cleared on success. Idempotency key for retry. See [verification-notes § C1](./00-verification-notes.md#c1).
      "pendingReviewCommitOid": null,         // SHA the pending review was anchored to at step 1. Compared against current head_sha on retry to detect history-rewriting force-push since the pending review was created — see § 6 retry "Stale `commitOID`" path.
      "draftComments": [                     // new threads (drafts that will produce `addPullRequestReviewThread` mutations)
        {
          "id": "uuid",                       // server-generated client-facing draft ID
          "filePath": "src/Foo.cs",
          "lineNumber": 42,
          "side": "RIGHT",
          "anchoredSha": "abc...",
          "anchoredLineContent": "if (x == null) {",
          "bodyMarkdown": "Should this be nullable?",
          "threadId": null,                   // GraphQL Node ID (PRRT_...) stamped after `addPullRequestReviewThread` succeeds; null until the thread has been created server-side. Durable idempotency key for retry — see `03-poc-features.md` § 6.
          "status": "draft"
        }
      ],
      "draftReplies": [                       // replies to existing threads (drafts that will produce `addPullRequestReviewThreadReply` mutations). Stored as a separate collection because the wire/business semantics diverge from new-threads (no file/line anchor; no reconciliation pass; different GraphQL mutation; different submit-button rule).
        {
          "id": "uuid",                       // server-generated client-facing draft ID
          "parentThreadId": "PRRT_...",       // GraphQL Node ID of the existing thread this reply targets
          "bodyMarkdown": "Yes — see also OrderService.",
          "replyCommentId": null,             // GraphQL Node ID of the posted reply comment, stamped after `addPullRequestReviewThreadReply` succeeds; null until then. Idempotency key for retry.
          "status": "draft"
        }
      ],
      "viewedFiles": {                        // S3-shipped per-session map of filePath → headShaAtTimeOfMark, populated by the per-file "Viewed" checkbox on the Files tab. The lookup walks the full PR commit graph (not just clustered iterations) to decide whether a file has been touched since the mark — see `03-poc-features.md` § 3 "Viewed checkbox semantics" for the truthful-by-default-on-unknown-changedFiles rule. C# field: `ViewedFiles` on `ReviewSessionState`. On disk, the kebab policy writes this as `viewed-files`.
        "src/Foo.cs": "abc...",
        "src/Bar.cs": "abc..."
      },
      "iterationOverrides": []                 // user-applied iteration boundary edits via right-click on iteration tabs (PoC feature). Empty array = no overrides applied. Each entry: { kind: "merge" | "split-before" | "split-after", commitSha: "<SHA>", appliedAt: "<ISO8601>" }. "merge" combines this commit's iteration with the previous; "split-before" starts a new iteration *at* this commit (this commit is the first in the new iteration); "split-after" ends the current iteration *after* this commit (the next commit starts a new iteration). The earlier `kind: "split"` was directionally ambiguous; the two-form split fixes that. Replays on PR reload; persists across sessions. History-rewriting force-push handling: on reload, any override whose `commitSha` is no longer in the PR's commit graph (`GET /repos/{o}/{r}/commits/{sha}` returns 404) is dropped silently. A single one-time toast surfaces: "N iteration boundary overrides were dropped because the commits they referenced were rewritten by a force-push." Same posture as the draft fallback in § 5 — best-effort recovery, no rebuild attempt.
    }
  },
  "ui": {                                       // global UI preferences — not per-PR, persisted across sessions
    "fileTreeWidthPx": 280                       // user-resized width of the left file-tree pane (PoC feature). Lives at the top-level (global), not under `reviewSessions[ref]` — the same width applies to every PR. Default 280px on first launch.
  },
  "installSalt": null,                          // lazily generated when v2 first writes to `aiState.alwaysAllowRepoAccess`; PoC ships `null` because PoC has no AI features and no consumer for the salt. Used as the HMAC salt for PAT-fingerprinting once present. Format: **32 random bytes, base64url-encoded** (44-character string, no padding). Stable across app restarts; rotated only by manual deletion of `state.json`. Eager generation in PoC was rejected because the value would lock in a format v2 may want to change before any code reads it. Once v2 ships, the format is locked and any per-account salts (a possible v2 enhancement) live in a separate sibling field — the existing `installSalt` is never reshaped in place. **Backup-restore migration**: a user who restores a `state.json` backup that carries a different `installSalt` than the current install loses match against any persisted `aiState.alwaysAllowRepoAccess` fingerprints (the new salt produces different HMAC outputs); the modal re-fires on first chat per repo. This is the correct safety posture — a foreign salt is a foreign install in everything but a copied file. v2's documented behavior on salt mismatch: clear `alwaysAllowRepoAccess` automatically and surface a one-time toast: *"Repo access permissions were reset because state was restored from a different install. Re-grant access on first use."*
  "lastConfiguredGithubHost": "https://github.com",  // the `github.host` value the current `state.json` was written against. Compared against the configured host on startup; mismatch triggers the host-change-between-launches modal — see § "Changing `github.host` between launches."
  "aiState": {                                 // empty in PoC; v2 sub-keys enumerated below for forward-compat awareness:
    // "dismissedAnnotations": { "<stableId>": { "dismissedAt": "ISO8601" } }   — populated by P2-4 (hunk annotator)
    // "alwaysAllowRepoAccess": { "owner/repo": { "grantedAt": "ISO8601", "patFingerprint": "<HMAC-SHA256(installSalt, full_PAT) truncated to 32 base64 chars>" } }  — populated by P2-2 (chat)
    // "repoCloneMap": { "owner/repo": { "path": "<absolute>", "ownership": "user" | "prism-created" } }  — populated by P0-4 workspace enumeration
    // "workspaceMtimeAtLastEnumeration": "<ISO8601>"
    // "cleanupCandidates": { "<worktree-path>": { "prRef": "owner/repo/123", "closedAt": "ISO8601" } }  — populated when polling detects a PR state flip to closed/merged; used by the cleanup audit
    // "chatSessions": { "<prismSessionId>": {
    //     "claudeCodeSessionId": "<id from claude>",        // returned by Claude Code at session start; the resume key
    //     "prRef": "owner/repo/123",
    //     "openedAt": "<ISO8601>", "lastTurnAt": "<ISO8601>",
    //     "lastTurnEndedCleanly": true,                      // true if the session ended on a complete model turn (no dangling tool_use); false if SIGKILL'd or process-crashed mid-turn. Resume is only attempted when true.
    //     "repoAccessState": "none" | "session" | "always",  // "none" = state 1 (no --add-dir); "session" or "always" = state 2 (with --add-dir + Read/Grep/Glob). Determines flags on resume. Sessions begin life with "none"; transition to "session" or "always" via the lazy-upgrade flow when the model calls `request_repo_access` and the user approves. "always" also persists `aiState.alwaysAllowRepoAccess[<owner>/<repo>]`.
    //     "worktreePath": "<absolute>",                       // re-validated on resume (still resolves? still pointing at the right ref?)
    //     "conversationLog": [ { "role": "user" | "assistant", "content": "...", "at": "<ISO8601>" } ]   // mirrored locally for the drawer's display on resume; Claude Code's own session storage holds the full model-internal state
    //   } }
    //   — populated by P2-2 (chat). Survives backend restart so chats can resume across days/reboots via `claude --resume <claudeCodeSessionId>`. Sessions where `lastTurnEndedCleanly === false` cannot be resumed reliably (per [verification-notes § C4](./00-verification-notes.md#c4)) and fall back to "fresh session + conversation-log injection as system-prompt context."
    // ...other v2 features may add keys; the v1→v2 migration adds them as needed.
  }
}
```

### Schema migration policy

`state.json` carries a top-level `"version": <int>` field. The backend checks this on startup:

- **Version equal to current**: load directly.
- **Version less than current**: run a registered migration function `v{n} → v{n+1}` for each step until the schema reaches current. Each migration is a small, deterministic function in `PRism.Core` that maps the old shape to the new. The pre-migration file is copied to `state.json.v{n}.bak` so the user can recover by hand if a migration introduces a bug.
- **Version greater than current** (forward-incompat): the app **loads in read-only mode** rather than refusing to start. The backend sets `IAppStateStore.IsReadOnlyMode = true` for the process lifetime. Endpoints that mutate state (`POST` / `PUT` / `PATCH` / `DELETE` for state-touching routes — e.g., `/api/pr/{ref}/mark-viewed`, `/api/pr/{ref}/files/viewed`) return `423 Locked` with the problem-slug `/state/read-only`. Reads continue to work — the user can browse the inbox and PR-detail surfaces, but cannot save drafts, mark files viewed, or submit. This replaces the earlier "refuse to load" wording: the app starts, the user can read, and only writes are blocked. (Frontend banner copy + the consumer of `/state/read-only` are spec-defined here; current S3 surfaces enforce the 423 server-side, with the user-facing banner UX gated to a follow-up alongside the rest of the read-only-mode UI polish.)
- **Missing `version` field**: `MigrateIfNeeded` throws `UnsupportedStateVersionException(0)`, which propagates out of `LoadAsync` (the `catch (JsonException)` quarantine block does not catch it). The earlier "treat as v1" rule was retired because v1 files written by S0/S1/S2 builds always carry the field; a missing field signals a hand-edit-gone-wrong or a foreign-format file, neither of which should silently migrate. **Note for future reconciliation:** a malformed `version` value (e.g. `"1"` as a string, `1.5` as a float) is translated to `JsonException` and *does* hit the quarantine path — the asymmetry between "missing" (uncaught throw) and "malformed" (quarantined) is the current behavior; a follow-up should align them so missing also quarantines, since the user-recovery story is otherwise opaque ("app failed to start, no recovered file").

PoC ships at `version: 2` (S3's v1 → v2 migration adds `viewed-files` per session). v1 files written by earlier builds are migrated on first load via the inline `MigrateV1ToV2` helper on `AppStateStore`. The migration framework (ordered chain of `(toVersion, transform)` steps) is **not** abstracted in S3 — that extraction lands in S4 when migration #2 motivates it (see [`docs/specs/2026-05-06-architectural-readiness-design.md`](../specs/2026-05-06-architectural-readiness-design.md) § ADR-S4-2).

**Unparseable `state.json` (corruption, truncated write, hand-edit-gone-wrong, encoding mismatch).** The backend tries to parse `state.json` on startup; if the parse fails:

1. Copy the corrupt file to `state.json.<ISO8601-timestamp>.corrupt` (preserves the original bytes for forensic recovery; the user can hand-extract draft bodies from the `.corrupt` file even if no reload path uses it).
2. Write a fresh empty `state.json` (`{ "version": 2, "reviewSessions": {}, "ui": {}, "installSalt": null, "lastConfiguredGithubHost": "<configured>", "aiState": {} }`).
3. Surface a loud, non-dismissable banner on the inbox: *"Your local state was unreadable on startup. The previous file is preserved at `state.json.<ts>.corrupt` for recovery; the app started fresh. Drafts from before this launch are not restored automatically — see the corrupt-file path or the forensic event log at `<dataDir>/state-events.jsonl` if `logging.stateEvents` was on."* The banner persists until the user explicitly dismisses it (so they cannot miss the data-loss event).
4. Log the parse error verbatim to `<dataDir>/logs/`.

The forensic event log (separate file, not subject to the same corruption) is the recovery path: `DraftSaved` events carry full body markdown, so a determined user can reconstruct lost drafts from `state-events.jsonl`. The principle "the reviewer's text is sacred" is preserved by the *recoverability* of the corrupt file plus the event log, not by refusing to start. Refusing to start would block all of the user's other PRs because of one bad write, which is the wrong trade.

**Size and performance ceiling.** The "<100 KB" figure cited as the data scale is true on day 1 and false within months for a heavy reviewer (PRs accumulate, draft history grows, iteration overrides accumulate, append-only forensic log lives elsewhere but `state.json` itself grows with `reviewSessions`). **Promote `P4-L2` (migrate to SQLite) when**: `state.json` exceeds **1 MB** *or* the save-mutex p99 latency exceeds **200 ms** for ten consecutive saves. Both conditions are observable from the existing telemetry-free code (size from a stat, latency from in-process timing) — so the trigger is automatic, not "user complains." A toast surfaces at the threshold: *"Local state is approaching the JSON store's comfortable size; the next major version will migrate to SQLite. Your data is safe."*

**Forward-compat test in PoC.** Even though no migration runs in PoC, the framework is exercised by **two** unit tests so the v2 contributor inherits a working harness:
1. A no-op `v0 → v1` migration for the historical "missing version field" case.
2. A **realistic v1 → v2 migration that adds the exact `aiState` keys v2 plans to add** — concretely: `aiState.dismissedAnnotations: {}` (per `04-ai-seam-architecture.md` § `<AiHunkAnnotation>`, populated by P2-4), `aiState.alwaysAllowRepoAccess: {}` (per P2-2), `aiState.repoCloneMap: {}` and `aiState.workspaceMtimeAtLastEnumeration: null` and `aiState.cleanupCandidates: {}` (all three populated by P0-4 workspace enumeration / cleanup), and `aiState.chatSessions: {}` (per P2-2 cross-restart resume). The test feeds a synthetic v1 `state.json` through the migration and asserts each of these six keys exists with the documented empty default in the output. This catches "the framework runs migrations" *and* "the migration the spec assumes will run actually composes correctly" — the second guarantee is what was missing in earlier wording (a synthetic-but-arbitrary migration tested only the framework, not the actual v2 plan).

The test does not commit to v2's *exact* schema (v2 may add fields beyond the six listed) — it commits to "the keys mentioned in this spec compile against the migration framework today." When v2 adds new `aiState` keys not listed here, the v1→v2 migration test is amended at the same time. This is the kind of forward-compat coverage that, without a written test, evaporates during the months between PoC ship and v2 first-light.

**Version-field write lifecycle.** PoC writes `"version": <CurrentVersion>` proactively into `state.json` on every save — including the first save that creates the file. This means a `state.json` produced by PoC always carries an explicit version. With `CurrentVersion = 2` today, every save writes v2; v1 files originating from earlier builds are migrated on first load and the next save persists them as v2. The lifecycle: read → migrate-if-needed → use → write-back-with-current-version. There is no scenario where a written file has a `version` lower than the writing binary's current version.

**Hand-edits to `state.json` while the app is running are not supported.** The `FileSystemWatcher` hot-reload mechanism applies only to `config.json` (per § 11 Settings). `state.json` has no watcher; the backend reads it once on startup and writes it on every state mutation. A user who hand-edits `state.json` while the app is running will have their edit silently overwritten on the next mutation (the in-memory copy is authoritative). Recovery: stop the app, edit, restart. Document this in the README — power users tempted to fix state by hand-edit need to know.

### ID strategies

PoC and v2 use several ID schemes. The choice for each is deliberate; the table below is the rule-set so that future ID needs (e.g., per-suggestion IDs in P2-6 draft suggester) match an existing strategy rather than inventing a sixth.

| ID | Strategy | Issued by | Rationale |
|---|---|---|---|
| `DraftComment.id`, `DraftReply.id` | Server-issued UUIDv4 | Backend on `PUT /api/pr/{ref}/draft` | Avoids two-tab collision; ID exists only after persistence (a typed-but-never-saved draft has no ID). |
| `HunkAnnotation.StableId` | Content-addressable: `sha256(prRef + filePath + anchored_line_content + anchor_kind)` | Frontend or backend (recomputable on demand) | Survives diff renumbering when `head_sha` shifts; lets `aiState.dismissedAnnotations` keep dismissals stable across iterations. |
| `PR_session.id` (key under `state.json.reviewSessions[ref]`) | Synthesized from `PrReference.ToString()` (e.g., `"acme/api-server/123"`) | Implicit from the PR identity | Wire-portable, hand-readable, idempotent across launches. The session is the PR; no separate randomness needed. |
| `installSalt` | 32 random bytes, base64url-encoded | Backend on first `aiState.alwaysAllowRepoAccess` write | Per-installation HMAC salt; lazy generation per § State schema. |
| `mcp-session-token` | 32 random bytes, base64-encoded | Backend on chat session start | Per-chat-session bearer for the MCP HTTP endpoint; never persisted to disk. |
| `prismSessionId` (key under `aiState.chatSessions`) | Server-issued UUIDv4 | Backend on chat session start | Disambiguates concurrent chat sessions on the same PR (e.g., from two tabs); persists across backend restart for resume. |
| GraphQL Node IDs (`PendingReviewId`, `threadId`, `parentThreadId`, `replyCommentId`) | Server-issued by GitHub | github.com / GHES GraphQL | Opaque pass-through; treated as strings (see "GraphQL Node IDs are opaque" above). |

**Rule for new IDs.** When adding a new ID-bearing concept, pick from this table:

- If two browser tabs could plausibly create the same logical thing concurrently → server-issued UUIDv4 (the draft pattern).
- If the ID needs to survive a representation shift (e.g., line renumbering, hash changes) → content-addressable from the stable parts of the identity (the annotation pattern).
- If the ID *is* the identity of an external system → opaque pass-through (the Node ID pattern).
- If the ID exists only for backend bookkeeping and never crosses to GitHub → random bytes, never persist if security-sensitive (the bearer-token pattern).

A new ID that does not fit one of these patterns is a signal that the design is doing something unusual; flag it in the PR description and document the chosen strategy here.

### Draft ID generation

Each draft comment's `id` is a **UUIDv4 generated server-side** when the draft is first persisted (the `PUT /api/pr/{ref}/draft` endpoint generates the ID and returns it in the response). The frontend never invents draft IDs.

Rationale:
- Server-generated avoids the (very unlikely but possible) collision risk of two browser tabs generating the same UUID for two unrelated drafts.
- Server-generated is the natural source of truth: the ID exists only after the draft is persisted, so a "draft" that was typed but never saved has no ID and never appears anywhere.
- The frontend optimistic-UI for draft creation uses a temporary client-side `pending-<random>` placeholder that is replaced with the server-issued UUID as soon as the response arrives. If the user types fast enough to interact with the draft before the response arrives, the frontend serializes against the placeholder and rewrites the placeholder when the response lands.

## Testing

The DoD requires automated tests for the submit pipeline, reconciliation algorithm, and state migration framework (`spec/01-vision-and-acceptance.md` § "Tests (automated)"). The infrastructure those tests sit in:

- **C# tests**: **xUnit** with FluentAssertions; one project per source project (`PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`). Integration tests against GitHub use [`octokit.recorded-tests`](https://github.com/octokit/recordedtests-net) or hand-rolled fixture replay; do not hit live GitHub from CI without a dedicated test PAT. The submit-pipeline tests *must* simulate mid-mutation network drops to exercise the lost-response window (see DoD).
- **Frontend tests**: **Vitest** for unit (component logic, hooks, capability-flag gating); **Playwright** for integration (the demo flow + the no-layout-shift assertion). Tests live under `frontend/__tests__/` (unit) and `frontend/e2e/` (Playwright).
- **CI invocation**: a single `dotnet test` + `npm test` + `npm run e2e` sequence runs everything. CI runs on Windows + macOS (Apple Silicon) workers; Linux runs are aspirational (Linux is in the P4 backlog for explicit testing — see `spec/05-non-goals.md`).
- **Test scope beyond the explicit DoD list**: service-interface contract (`PRism.GitHub.GitHubReviewService` correctly implements every method on `IReviewService` against canned-response fixtures — this is a testability contract, not a multi-provider contract); capability registry (clauses 1+2+3 of `IsEnabled` short-circuit in the documented order; `Noop*` types are detected — see `spec/04-ai-seam-architecture.md` § "Resolution rule" for the marker-interface mechanism); SSE channel (backpressure timeout, reconnect-after-restart, multi-tab fan-out); cross-platform (Windows build runs on a freshly-imaged Win11 VM with no .NET installed); forensic event log (rotation works at 10 MB / 30 files cap); and the demo flow itself as an end-to-end Playwright run. Add tests for these as the corresponding code lands; they are not gating DoD checkboxes individually but the absence of any of them at PoC ship-time is a quality regression worth flagging in the README.

## Logging

- File-based, rolling, in `<dataDir>/logs/`.
- Level: Info default, Debug toggleable via config.
- No telemetry, no remote upload.

## Append-only state event log

`state.json` is the single source of truth for current state, but state-mutating operations are also recorded to an append-only event log at `<dataDir>/state-events.jsonl`. Each line is a JSON record like:

```jsonc
{ "ts": "2026-05-04T12:34:56Z", "kind": "DraftSaved", "prRef": "owner/repo/123", "payload": { /* fields */ } }
{ "ts": "2026-05-04T12:35:01Z", "kind": "DraftDiscarded", "prRef": "owner/repo/123", "payload": { /* fields */ } }
{ "ts": "2026-05-04T12:36:10Z", "kind": "ReviewSubmitted", "prRef": "owner/repo/123", "payload": { /* pendingReviewId, threadCount, replyCount */ } }
```

**What the log buys.** When the user reports "my draft disappeared" or "I clicked submit and it said success but my comments aren't on GitHub," the log lets the maintainer reconstruct what actually happened. Without it, recovery requires guessing from `state.json` (which only carries current state) and GitHub's response logs (which only the user can see). For a tool whose principle 2 is "the reviewer's text is sacred," a recovery path matters.

**Cost and retention.** A few hundred bytes per event, written asynchronously after the in-memory mutation lands. Rolling: rotate at 10 MB, **keep last 30 files** (~300 MB total — still negligible on disk for a developer's machine, and large enough to preserve a heavy reviewer's history across multiple weeks). The earlier "keep last 5 files" cap was sized against the wrong use-case: with 50 MB total, a heavy reviewer rotates through history in a few weeks and "investigate disappeared draft three weeks ago" — the literal use-case the log was added for — would be unreconstructable. The first-run setup screen surfaces the actual retention horizon ("about N weeks at typical use"); users with deeper-history needs can override `logging.stateEventsRetentionFiles` in config. No PII concerns beyond what `state.json` itself holds (the user's drafts, file paths, line numbers — all already in scope locally).

**Ordering guarantee.** The log is written by **a single background consumer reading from a bounded in-process channel** (`System.Threading.Channels.BoundedChannel` with capacity 1024 and a single reader). Producers — every state-mutation endpoint — push their events onto the channel after the in-memory mutation lands and before the API call returns. The consumer dequeues serially and writes to `state-events.jsonl` synchronously per record. This guarantees the on-disk order matches the order in which producers' mutations completed, regardless of how many threads were producing concurrently. POSIX `O_APPEND` write atomicity is **not** sufficient on its own — `O_APPEND` guarantees no interleaving of bytes within a single `write()` syscall but says nothing about ordering across threads — so the single-consumer queue is load-bearing for forensic reconstruction. If the channel fills (1024 unflushed events; would only happen if the consumer is stuck), producers wait; this back-pressure is preferable to dropping events that the user might need to recover a draft.

**Drop-on-overflow safety net.** If a producer's `WriteAsync` would block for more than 5 seconds (e.g., the disk is full and the consumer cannot drain), the producer logs *one* event-loss warning to `logs/` and proceeds without enqueuing. The forensic log is a best-effort recovery aid; blocking the user's mutating endpoints on log writes turns it from a safety net into a footgun. The disk-full case is rare enough on a developer's machine that this trade is acceptable; the warning makes the maintainer aware so they can act before more events are lost. **Cross-reference for recovery**: a user reading `state-events.jsonl` to recover a draft will not find the warning there (it's in `logs/`, not the event log itself). The README's "Recovering a lost draft" section documents the cross-reference: if the event log is missing recent events for a draft you expected, check the most recent files under `logs/` for an event-loss warning to see whether the period was a drop window.

**Not a replay log.** This is a forensic log, not a CRDT or event-sourcing substrate. `state.json` is still authoritative for current state. The log is read by humans (or scripts) when something goes wrong, not by the application on every startup.

**Disabled via config.** A `logging.stateEvents: false` config flag (default `true`) disables the log for users who want a strict "nothing-on-disk-but-the-state-file" posture. Documented in the config schema.

**Trade-off when opted out.** Without the event log, "my draft disappeared" reports cannot be reconstructed — the only state on disk is the current snapshot. The first-run setup screen surfaces this trade-off in plain language ("Disable forensic logging? You'll save a small amount of disk traffic but lose the ability to recover from accidental discards"). The default is on because the disk cost is small at typical-reviewer scale (see next paragraph for the cost model after the keystroke-debounce de-emphasis) and "the reviewer's text is sacred" is a stronger commitment than minimization.

**`DraftSaved` is logged on explicit save, not every keystroke.** The composer's 250 ms keystroke debounce auto-saves to `state.json` for crash recovery — that auto-save is *not* a forensic event. A 10-minute typing session debounce-saves dozens of times; logging each would balloon the log to multi-MB within minutes for negligible recovery value (the reconstruction use-case wants "what was the latest body of this draft when it disappeared," which is one entry per draft, not hundreds). The forensic log records `DraftSaved` only on:
- The first time a draft is created (`newDraftComment` / `newDraftReply`).
- An explicit user save: `Cmd/Ctrl+Enter` in the composer, "Save draft" button click, or the auto-save fired by the in-flight-composer-on-banner-arrival flow (per `03-poc-features.md` § 3 "In-flight composer when the banner arrives" — that save is explicit because the user clicked Reload).
- Any state-mutation that touches the draft body via a path other than keystroke debounce (e.g., AI composer-assistant accept; manual re-anchor on reconciliation).

Keystroke-debounce auto-saves still write to `state.json` exactly as before — the change is only that the *event log* doesn't get a record per debounce. Recovery via the event log gives the user the body at last-explicit-save, not at last-keystroke; the `state.json` snapshot is the source for last-keystroke, so the combined recovery path covers both granularities. A few hundred bytes per logged event holds; the log size budget per heavy-reviewer-week shrinks by roughly an order of magnitude versus per-keystroke logging.

**File naming + rotation.** Files are named `state-events.jsonl`, `state-events-1.jsonl`, ..., `state-events-29.jsonl`. On rotation: `state-events.jsonl` → `state-events-1.jsonl` (rename); existing `state-events-{N}.jsonl` → `state-events-{N+1}.jsonl` for N=1..29; the highest-numbered file (>=30) is unlinked. The current write-target is always `state-events.jsonl` (the unsuffixed name). Rotation uses rename, not copy-and-truncate, so an in-flight read on a rotated file remains valid for the reader's lifetime.

## Security posture (PoC)

- GitHub PAT stored in OS keychain, never in `config.json` or `state.json`.
- Backend never returns the raw PAT to the frontend; backend makes all GitHub calls.
- Frontend → backend communication is HTTP on localhost only.
- Lockfile prevents accidental double-startup but is not a security boundary.

### Cross-origin defense for the localhost API

Even though the backend listens on localhost only, **any browser tab the user has open can send fetches to it**. Without a defense, a malicious page could submit reviews under the user's GitHub identity (CORS does not block opaque-mode POSTs) or probe the inbox via tag-based requests. The backend therefore enforces two checks on every mutating endpoint (anything that's not a `GET`):

1. **Origin / Referer check (`OriginCheckMiddleware`).** The request's `Origin` (or `Referer` if `Origin` is absent) must equal the backend's own origin (`http://localhost:<port>` chosen at startup). On `POST` / `PUT` / `PATCH` / `DELETE`, the middleware **rejects empty or missing `Origin` outright** — the earlier "absent treated as same-origin" wording was tightened in S3. Requests with any other origin, or with no `Origin` header, are rejected with `403 Forbidden`. This blocks `<form>` posts and `fetch(..., {mode: 'no-cors'})` from arbitrary pages.
2. **Per-launch session token (`SessionTokenMiddleware`).** On startup, `SessionTokenProvider` generates a 256-bit random token (`Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))`). The token is the *value*; it travels two ways — as the `prism-session` cookie (lowercase, written by `Program.cs`'s cookie-stamping middleware on every `text/html` response — `prism-session=<token>; Path=/; SameSite=Strict; HttpOnly=false`) and as the `X-PRism-Session` request header (mixed-case, set by the SPA from the cookie value). Re-stamping the cookie on every HTML response defends against the case where a backend restart rotates the token while the frontend tab is still open: the next full-page reload picks up the fresh cookie automatically. The SPA reads the cookie value and echoes it in the `X-PRism-Session` header on every mutating request; non-SPA callers may also satisfy auth with either the cookie or the header. Comparison is **constant-time** (`CryptographicOperations.FixedTimeEquals` on equal-length byte arrays) to keep token validation outside any timing-attack surface; mismatched-length inputs short-circuit to a fixed-time false. The backend rejects mismatching mutating requests with `401 Unauthorized` carrying the problem-slug `/auth/session-stale`. The token is not persisted to disk and changes every launch.
   - `SameSite=Strict` keeps cross-site requests from carrying the cookie; the explicit header check defends against same-site malicious pages that the browser might still ship the cookie to.
   - The cookie is intentionally not `HttpOnly` because the React app must read it. The blast radius of token leakage is limited to "while this backend instance is running on this machine," and the threat model is local-only.
   - **`GET /api/events` (Server-Sent Events) is the one read carve-out** that authenticates via cookie alone (no `X-PRism-Session` header). Browsers' `EventSource` API does not let JS attach custom headers to the connection, so the cookie is the only path. This is acceptable because the SSE channel is read-only — it carries no state mutations.
   - **Frontend recovery on 401.** The frontend's HTTP client (`frontend/src/api/client.ts`) treats any `401` response as a session-stale signal: it dispatches a `prism-auth-rejected` `CustomEvent` on `window`. `App.tsx` listens for that event and clears the in-memory auth flag, which causes the routing tree to redirect to `/setup` (the route is `<Navigate to="/setup" replace />`). The Setup page re-prompts for the PAT and the next page-level navigation picks up the freshly-stamped cookie. The Server-Sent Events ping/keepalive path in `events.ts` is the one place that does fall back to `window.location.reload()` (after a connection-level failure that the dispatch-and-route flow can't recover from on its own); mutating-endpoint 401s do not reload.
   - **Development override.** When `ASPNETCORE_ENVIRONMENT == "Development"` *and* the `PRISM_DEV_FIXED_TOKEN` environment variable (read via `Environment.GetEnvironmentVariable` only — **not** via `IConfiguration` / `dotnet user-secrets`, deliberately, to eliminate any path where `appsettings.json` could leak a fixed token into a non-Development host) is non-empty, `SessionTokenProvider` uses that value instead of generating a fresh random token. This pins the cookie across `dotnet watch run` reloads so the SPA tab does not need to re-authenticate every backend restart. Production hosts ignore the env var entirely. See `README.md` § "Stable session token across `dotnet watch run` reloads (Development only)" for usage.

**Per-verb enforcement (matches the shipped middleware order).** `OriginCheckMiddleware` short-circuits early on non-mutating verbs — **GET requests are NOT origin-checked.** `SessionTokenMiddleware` runs on all `/api/*` paths regardless of verb, accepting **either** the `X-PRism-Session` header **or** the `prism-session` cookie (a `FixedTimeMatches` against either passes). For SPA-issued GETs the cookie satisfies the check; for server-side or non-cookie callers the header satisfies it. Writes (`POST` / `PUT` / `PATCH` / `DELETE`) carry **both** the tightened Origin check and the session-token check.

The middleware skips `/api/health` (liveness probe by convention) and any non-`/api/*` path (so SPA HTML and assets can load — that's what stamps the cookie in the first place). There is also a development carve-out for the loopback-different-port case where Vite (5173) proxies `/api` to the backend (5180) and the SPA never receives a same-origin cookie for the dev server's port; that branch lets dev traffic flow without auth and is documented in the middleware comments.

`/api/capabilities` is GET-only and therefore *not* gated by the Origin check, but is gated by the session-token check via the cookie (any browser tab attempting to probe it without the same-origin cookie hits 401). The earlier framing — "Origin check protects `/api/capabilities` from cross-origin disclosure" — was wrong; the session-token cookie is what closes that surface.

CORS is otherwise wide open in PoC (only one origin matters; the Origin check is the actual defense).

### What's still out of scope

- Frontend → backend remains **unauthenticated in the user-identity sense**: any process running on the same machine that can read the cookie can talk to the backend. PoC is single-user; this is acceptable. Multi-user / hosted deployments require real authentication (out of scope; see `spec/05-non-goals.md`).

### Two parallel auth surfaces (browser vs. MCP)

> **Scope note.** The MCP-only auth pipeline described in this section is **not built in PoC** — `/api/mcp` is not exposed and Claude Code is not invoked. The design is documented here so that v2 (P0-7 + P2-2) inherits a complete auth model rather than inventing one under feature pressure. PoC implementers can skim this section; v2 implementers consult it alongside `04-ai-seam-architecture.md` § "Auth from Claude Code to the MCP endpoint" (which carries the per-session bearer + MCP-config-JSON shape and the operational constraints — request size cap, token rotation, orphan subprocess cleanup).

The localhost backend exposes two authenticated surfaces: the browser-facing API (cookie + Origin check + `X-PRism-Session` header) and the MCP HTTP endpoint at `/api/mcp` (bearer token in the Authorization header). They terminate on the same backend on the same port and share threat-model assumptions, but the auth mechanisms are independent because Claude Code is not a browser.

**Path-based discriminator (explicit).** The backend has two middleware pipelines distinguished by URL path:
- **`POST /api/mcp` and any sub-path** — requires `Authorization: Bearer <token>` *and* `Origin` either absent or equal to our own; **rejects requests carrying a cookie + `X-PRism-Session` header instead of a bearer**. This is the MCP-only pipeline.
- **Every other path** — requires the cookie + `X-PRism-Session` header pair (for mutating verbs) plus the `Origin`-equals-self check (for all verbs); **rejects requests carrying a bearer token instead**. This is the browser-only pipeline.

A request that satisfies neither auth shape hits 401. The path is the discriminator: a developer adding a new mutating endpoint inherits the browser pipeline by default, and adding an MCP tool route under `/api/mcp/...` inherits the bearer pipeline by default — there is no "either auth works" middle ground that could mis-route a check. The cross-rejection (bearer at non-MCP path → 401, cookie-pair at `/api/mcp` → 401) is intentional belt-and-suspenders against a confused-deputy attack where a stolen credential of one type is replayed against an endpoint expecting the other.

The MCP-only pipeline carries these additional rules:
- The bearer token used for MCP is **not subject to the Origin-equals-self check** — Claude Code does not issue an `Origin` header at all. The MCP endpoint requires `Origin` to be **either absent or null**, *and* the bearer to validate; a request with a valid bearer **but a foreign `Origin` header** (e.g., `Origin: http://evil.example`) is rejected as suspicious — that combination would only arise from a malicious browser tab that has somehow obtained the bearer, exactly the threat model elsewhere acknowledged. The combined rule: bearer matches AND (Origin missing OR Origin equals our own). Treating bearer-with-foreign-Origin as a separate rejection is essentially free and closes a small but real attack surface.
- The bearer token is held in backend memory; it is **never persisted to disk**, **never logged**, and is invalidated when the chat session ends.
- Threat: a malicious sibling process that can read this backend's process memory could steal the bearer and impersonate Claude Code for the lifetime of the chat session. This is an acknowledged limit of "local-only" trust — process-memory introspection by a hostile local process is outside the threat model. PoC accepts this; a hosted deployment (out of scope) would mediate MCP through a separate authenticated channel.
- Threat: a malicious VS Code extension or similar local tool that can spawn a process and read environment / file-system state could potentially obtain the bearer if it can read the per-session `mcp-config` JSON file at `<dataDir>/mcp/chat-session-<sessionId>.json`. The file is created with restricted permissions:
  - **POSIX:** `0600` (owner read/write only) — set explicitly via `File.SetUnixFileMode` after creation. This is unambiguous and well-supported.
  - **Windows:** the `FileSecurity` ACL is **explicitly built** rather than inheriting from the parent: remove all inherited rules, grant `FullControl` to the current user only (`WindowsIdentity.GetCurrent().User`), deny everything else. The .NET API is `new FileSecurity()` → `SetAccessRuleProtection(isProtected: true, preserveInheritance: false)` → `AddAccessRule(...)` → `File.Create + SetAccessControl`. Default `File.Create` would inherit the parent directory's ACL, which on most Windows systems grants `Authenticated Users: Read` — meaning every process running as any user on the machine could read the file. The explicit ACL closes that gap.
  
  The bearer is not in the file's filename or in process arguments. Still, a determined attacker running as the same user with file-read access to `<dataDir>` has enough to impersonate. This is consistent with the broader "any local process that can read `<dataDir>` can read the user's drafts" posture; the ACL hardening defends against the *cross-user* case on a multi-user machine.

## What's NOT in PoC (architecture-level)

See `spec/05-non-goals.md` for the full list. At the architecture level specifically:

- No multi-tenancy.
- No authentication between frontend and backend (localhost only).
- No HTTPS (localhost only; the OS sandboxes traffic).
- No webhooks (polling only).
- No background services beyond the polling loop.
- No multi-account.
- No multi-provider runtime selection (one provider per app instance).
