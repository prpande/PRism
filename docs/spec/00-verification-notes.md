# Verification notes (Wave 1 of spec-review remediation)

This document records the empirical verification of external-API claims that the spec depends on. The spec-review (`spec-review.md`) flagged several foundational assertions that may not survive contact with reality. Wave 1 of the remediation plan is to verify or falsify each assertion *before* redesigning. This file records those findings.

Truth labels: **CONFIRMED** (claim survives), **FALSIFIED** (claim is wrong as stated), **PARTIAL** (claim is partly true but needs revision), **UNDOCUMENTED** (no public ground truth; needs empirical test).

**A note on identifier shapes.** The `C1`–`C4` and `M19`–`M21` labels in this document are local section anchors; cross-references from other spec files (e.g., `[verification-notes § C1]`) point at these. Other letter-prefixed labels — `(C5)`–`(C9)`, the `(M*N*)` series above `M21`, and `(A*N*)` — appeared in earlier drafts of the spec text as inline parentheticals; they were never proper sections in this document and have been removed from the spec. If you see a `(M*N*)`-style label in any spec file, it is a local section marker, not a cross-document reference. Section headers themselves are the references — follow the header text, not the parenthetical.

---

## Summary table

| ID  | Spec claim (paraphrased)                                                                            | Status        | Wave 2 action |
| --- | --------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| C1  | Atomic submit (verdict + new comments + replies) via a single GitHub API call                       | **PARTIAL**   | Switch submit path from REST to GraphQL pending-review pattern; revise "single API call" wording. |
| C2  | GraphQL `synchronize` events drive iteration reconstruction                                         | **FALSIFIED** | Re-spec iteration reconstruction against `PullRequestCommit` + `HeadRefForcePushedEvent`; pick clustering policy. |
| C3  | `request_repo_access` synthetic tool registered with Claude Code via host                           | **PARTIAL → RESOLVED BY REDESIGN** | Filesystem access uses Claude Code's built-in `Read`/`Grep`/`Glob` scoped via `--add-dir` (not MCP-resident `repo_read`/`repo_grep`/`repo_glob` — those were dropped in W29). The `request_repo_access` MCP tool was dropped in W29 then **reinstated in W31** as a takes-no-arguments consent-bridge tool the model calls when broader repo access is needed; the upgrade uses W30's fresh-session-with-injection (clean kill, new flags, conversation injected). Modal copy is host-authored — the tool taking no arguments is the structural defense against attacker-controllable `reason` text. |
| C4  | `--resume` after a *clean* session end (no dangling `tool_use`) resumes cleanly with full model state | **UNDOCUMENTED → GATING for cross-restart chat resume** | The dangling-tool_use failure mode is sidestepped (we end cleanly via `EndCleanlyAsync`), but the *clean-end* resume path is now load-bearing for the cross-restart UX and must be empirically verified before P2-2 ships. Plus a sub-question: does `--resume` survive Claude Code CLI updates between session-end and resume? |
| M19 | Shiki bundle is small enough to ship every grammar                                                  | **FALSIFIED** | Commit to a language subset and document it; full bundle is ~1.2 MB gz. |
| M20 | Self-contained .NET 10 + React assets fit in ~70 MB binary                                          | **UNDOCUMENTED** | Empirical measurement during initial scaffolding; ~70 MB likely requires AOT or aggressive trimming. |
| M21 | Mermaid v11 lazy bundle is ~600 KB                                                                  | **FALSIFIED** | Mermaid v10 minified is ~2.7 MB; v11 has a "tiny" subset. Restate budget after picking the bundle variant. |
| C5  | `--mcp-config` JSON shape uses `"type": "http"` discriminator                                       | **PENDING (empirical gate)** | Run as first task of P0-7. |
| C6  | `AddPullRequestReviewThreadInput` accepts `pullRequestReviewId` for the pending-review case          | **PENDING (empirical gate)** | Run before submit-pipeline implementation. |
| C7  | HTML-comment marker durability in `addPullRequestReviewThread` round-trips                          | **PENDING (empirical gate)** | Run before submit-pipeline lost-response retry path. Default scheme is the `<!-- prism:client-id:<id> -->` marker; client-side normalization is the documented fallback only if the marker fails. |
| C8  | Model behavior on cumulative head-shift system-message injection                                     | **PENDING (empirical gate)** | Run before P2-2 chat ships. Verify the model defers to current diff over pre-shift answers when prompted with the cumulative-shift note. |

---

## C1 — Atomic submit including replies

### Claim under test

`spec/01-vision-and-acceptance.md` ("The wedge" section, principle 4 "Reviewer-atomic submit", the demo flow step about clicking Submit, and the DoD checkbox about replies); `spec/03-poc-features.md` § 4 (Reply composer) and § 6 (Submit flow + Reviewer-atomic semantics). Original wording: "a single GitHub API call posts everything (new comments, replies via `in_reply_to`, verdict, summary)". (Section anchors used instead of line numbers since the spec moves under remediation; line-number references would drift.)

### Verification method

Read the official REST and GraphQL reference docs for the relevant endpoints/mutations.

### Findings

**REST path (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`)** — body schema, fetched verbatim:

- Top-level fields: `commit_id`, `body`, `event`, `comments` (array).
- Each item in `comments[]`: `path` (required), `body` (required), `position`, `line`, `side`, `start_line`, `start_side`.
- **No `in_reply_to_id` or any reply-attachment field on `comments[]` items.**

The reply-capable REST endpoints are separate:

- `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` accepts `in_reply_to`. Doc note: "When `in_reply_to` is specified, all parameters other than body in the request body are ignored." This endpoint is not part of any review batch — it creates a standalone review comment immediately.
- `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` accepts only `body`. Also not part of any batch.

**Conclusion (REST):** the spec's "single API call" version of the wedge is **impossible** via REST.

**GraphQL path (the rescue):** GitHub's GraphQL API has a *pending-review* model that does support an atomic-from-the-user's-perspective flow.

- `AddPullRequestReviewInput` — accepts `body`, `commitOID`, `event` (or omitted to leave the review pending), `comments` (deprecated: "comments will be removed; use the threads argument instead"), `threads` ([DraftPullRequestReviewThread]).
- `DraftPullRequestReviewThread` fields: `body`, `line`, `path`, `side`, `startLine`, `startSide`. **No reply-attachment field.**
- `AddPullRequestReviewThreadReplyInput` — accepts `pullRequestReviewId` (Node ID of *pending* review) and `pullRequestReviewThreadId`. The `pullRequestReviewId` parameter explicitly admits a pending review — this is the documented pattern for batching replies into an unsubmitted review.
- `submitPullRequestReview` finalizes the pending review (verdict + all attached threads + replies) in one mutation.

So the actual achievable shape is: `addPullRequestReview` (no event → pending) → multiple `addPullRequestReviewThread` calls → multiple `addPullRequestReviewThreadReply` calls (with `pullRequestReviewId` = pending review ID) → `submitPullRequestReview`. **Multiple HTTP calls, but reviewer-atomic**: nothing is visible to anyone else until `submitPullRequestReview` runs, and if the submit step fails, the work persists in pending state recoverable on retry.

### Implication for Wave 2

1. Restate the wedge in `01-vision-and-acceptance.md`: drop "single API call", keep "atomic from the reviewer's perspective". Honest framing: "all draft work stays private until the submit click; submit finalizes verdict + new threads + replies as one user action."
2. Switch the submit path in `PRism.GitHub` from REST `POST /pulls/{n}/reviews` to a GraphQL multi-mutation sequence (Octokit handles GraphQL via `IGitHubClient.GraphQL` or via raw HttpClient).
3. New edge case: GitHub allows **one pending review per user per PR**. If the user already has a pending review (e.g., started a review on github.com and never submitted), our `addPullRequestReview` call may fail or attach to an existing pending review. The submit pipeline (`spec/03-poc-features.md` § 6) handles this via the foreign-pending-review prompt — the user is shown the orphan's contents and chooses Resume or Discard.
4. Idempotency story becomes easier: the pending-review ID itself is the natural idempotency key. On retry, fetch pending reviews for the user; if one exists, reuse it.

---

## C2 — GraphQL `synchronize` events for iteration reconstruction

### Claim under test

`spec/02-architecture.md` ("Stack" table, GitHub-client row); `spec/03-poc-features.md` § 3 ("Iteration reconstruction" subsection). Original wording: "GraphQL needed for timeline `synchronize` events (iteration reconstruction)" and "Each `synchronize` event in the timeline yields an iteration with `before` and `after` SHAs." (Section anchors used instead of line numbers.)

### Verification method

Inspected the `PullRequestTimelineItems` GraphQL union member list against the public schema reference.

### Findings

The union has 72 members. **No member has `synchronize` in its name.** `synchronize` is a webhook event name (`pull_request.action == "synchronize"`), not a GraphQL type. The closest available constructs:

- `PullRequestCommit` — one event per commit on the PR. No grouping into "this push" — each commit appears independently.
- `HeadRefForcePushedEvent` — fired only on force-pushes. Has `beforeCommit` / `afterCommit`. Does **not** fire for normal (fast-forward) pushes.

There is no GraphQL primitive for "this group of commits arrived in one push".

### Implication for Wave 2

The PoC's iteration tabs as currently spec'd require inferring "which commits were pushed together". Two reasonable policies:

1. **One iteration per `PullRequestCommit`** (per-commit tabs). Honest and simple; loses CodeFlow's grouping. Tab count grows with commit count.
2. **Cluster `PullRequestCommit` events by author/committer date** (e.g., commits within 60s of each other belong to the same push). Best-effort approximation; will misgroup occasionally but matches CodeFlow UX better. `HeadRefForcePushedEvent` resets the cluster boundary explicitly.

Recommend (2) with a disclosure: "iteration boundaries are approximate; force-pushes are detected exactly". Update `02-architecture.md:9` to cite `PullRequestCommit` + `HeadRefForcePushedEvent` instead of `synchronize`. Update `03-poc-features.md:172–173` to describe the clustering policy.

Historical note (provider abstraction has since been dropped): ADO has native iterations (`pull request iterations` API), GitLab has "versions" — both more first-class than GitHub's. The original spec drafted a provider abstraction partly motivated by this asymmetry; the abstraction is gone (`spec/01-vision-and-acceptance.md` Principle 6), but the observation is recorded here as context for why GitHub's iteration model is the one corner where the spec invests in a clustering-and-overrides UI. If a non-GitHub backend is ever pursued (~6–8 weeks of refactor work, not a feature in this backlog), iteration reconstruction is one of the surfaces that would need to be re-shaped per backend.

---

## C3 — Custom synthetic tool registration in Claude Code

### Claim under test

`spec/04-ai-seam-architecture.md` (`<RepoAccessRequestModal>` description; "Two-phase chat with repo access" section, since rewritten); `backlog/01-P0-foundations.md` (P0-4 implementation notes); `backlog/03-P2-extended-ai.md` (P2-2 implementation notes, since rewritten). The spec invoked a `request_repo_access` tool as if Claude Code natively supports custom backend-defined tools whose `tool_use` flows back through stream-json to the host. (Section anchors used instead of line numbers.)

### Verification method

`claude --help` (CLI surface inspection); claude-code-guide subagent (sourced answer with links to the Agent SDK custom-tools doc, MCP configuration doc, and the relevant GitHub issues).

### Findings

- `claude --help` exposes `--mcp-config`, `--allowedTools`, `--disallowedTools`, `--agents <json>` (custom *subagents*, not custom tools), `--tools` (selecting from the built-in set).
- **MCP is the only documented mechanism for registering a custom tool.** No flag exists for "declare an in-host tool definition that Claude Code's stream-json output should reflect as `tool_use` events". The Agent SDK custom-tools doc says: "Using the SDK's in-process MCP server, you can give Claude access to databases, external APIs, domain-specific logic, or any other capability your application needs." That's the supported path.
- Stream-json does not let the host inject `tool_result` for a host-defined tool name. The tool_use → tool_result loop is mediated by MCP (or by built-in tools).
- **There is no documented .NET MCP server library.** The MCP spec references TypeScript and Python SDKs. .NET integration requires either implementing the protocol (stdio is simplest), finding/auditing a community library, or running an out-of-process MCP server in another language and managing it from .NET.

### Implication for Wave 2

C3's finding (MCP is the only documented mechanism for custom tools) is still load-bearing for the chat feature, but the *consequences* and *which tools live on MCP* have evolved through three rounds:

1. `PRism.Web` hosts an HTTP MCP server in-process (P0-7) that exposes **three** host-defined tools: `pr_diff_file`, `pr_existing_comments` (both backed by `IReviewService`/GitHub API), and `request_repo_access` (the consent-bridge tool the model calls when broader repo access is needed; takes no arguments). Filesystem reads are *not* on the MCP server — those use Claude Code's built-in `Read`/`Grep`/`Glob`.
2. Filesystem access is provided by Claude Code's **built-in** `Read`/`Grep`/`Glob` tools, scoped via `--add-dir <worktree-path>` and gated via `--allowedTools`. The session starts in state 1 (no `--add-dir`) and is upgraded to state 2 (with `--add-dir`) via the lazy-upgrade flow described in `04-ai-seam-architecture.md` § "Repo access via lazy upgrade with fresh-session injection".
3. The user grants repo access **lazily, mid-session** when the model calls `request_repo_access`. The consent modal (`<RepoAccessRequestModal>`) is host-authored only — the `request_repo_access` tool takes no arguments, so no model-supplied string can land in the modal. (W29 had moved consent to chat-open to avoid this exact attack surface; W31 re-enabled mid-session consent after eliminating the `reason` parameter.)
4. The phase transition C4 was concerned about — toggling Read/Grep/Glob on the *same session* via kill-and-resume — is sidestepped by killing cleanly and starting a *fresh* session with new flags + conversation injected as system-prompt context (W30's mechanism). No `--resume` involved in the upgrade path.
5. P0-1 acceptance criteria do **not** include shipping an MCP-resident filesystem layer; the MCP server (P0-7) carries three thin tools.

---

## C4 — `--resume` semantics with a dangling `tool_use`

### Claim under test

`spec/04-ai-seam-architecture.md` ("Two-phase chat with repo access", since rewritten): phase-1 emits a tool_use, host kills the session, then `claude --resume <session-id>` starts phase-2. (Section anchors used instead of line numbers; the section has since been replaced by "Repo access via MCP-resident filesystem tools".)

### Verification method

Documentation search; claude-code-guide subagent.

### Findings

**Officially undocumented.** The how-claude-code-works doc does not describe behavior when resuming a session whose last assistant turn was a tool_use awaiting a tool_result. There is a known related bug: [GitHub issue #18880 — "claude --resume crashes on killed sessions; Ctrl+C unresponsive during tool execution"](https://github.com/anthropics/claude-code/issues/18880). This is not the same scenario but indicates that the kill-and-resume code path is fragile.

### Implication for Wave 2

C4 splits into two distinct sub-questions, with different statuses:

1. **Kill-mid-tool-use, then `--resume`** — *sidestepped*. We never kill mid-tool-use deliberately. `EndCleanlyAsync` waits for the current model turn to complete (up to a 5-second graceful timeout) before exiting the subprocess. Sessions that end via SIGKILL after the timeout (or via subprocess crash, or OS memory pressure) are flagged `lastTurnEndedCleanly = false` in `aiState.chatSessions` and are **not** attempted as `--resume` candidates — they fall through to fresh-with-injection on the next reopen. This sub-case is no longer gating any feature.

2. **Clean-end, then `--resume`** — *gating, empirical test required before P2-2 ships*. The cross-restart chat resume design (see `spec/04-ai-seam-architecture.md` § "Cross-restart chat resume" and `backlog/03-P2-extended-ai.md` § P2-2) depends on `claude --resume <session-id>` working correctly when the prior session ended cleanly (no dangling tool_use). Officially undocumented; needs empirical verification.

   **Test (run before P2-2 implementation lands):**
   - Start a Claude Code session with `claude -p --input-format stream-json --output-format stream-json --include-partial-messages [...flags]`.
   - Send a user turn; let the model respond fully (capture `LlmResult` event).
   - Send a clean exit (close stdin, await process exit).
   - Capture the session ID from the prior session's startup output.
   - Run `claude -p --resume <session-id> [...same flags]`.
   - Send a follow-up turn that references the prior turn (e.g., "what was my last question?").
   - Verify the model recalls without explicit reminder.

   **Three possible outcomes:**
   - Resume succeeds + the model retains full context → cross-restart resume works as spec'd. Land P2-2 with the resume path.
   - Resume succeeds but model has no prior context → `--resume` is "session-id-as-key, not full-state-restore". The cross-restart Case A degrades to fresh-with-injection. UX is degraded but not broken; spec text needs to acknowledge this and remove the "Resumed your chat from <timestamp>" promise of full-context.
   - Resume fails outright → the cross-restart use case is fresh-with-injection only. Even more degraded; the `claudeCodeSessionId` field in `aiState.chatSessions` becomes vestigial.

3. **Sub-question: does `--resume` survive Claude Code CLI updates?** When the user's `claude` binary updates between session-end and resume, is the stored session ID still honored? Spec assumes "no" and falls back to fresh-with-injection; a positive answer would let us promise resume across CLI updates too. Empirically test by upgrading the CLI between session-end and resume.

The empirical test is the load-bearing gate for the cross-restart chat-resume UX. Run it as part of P0-1's acceptance criteria (`backlog/01-P0-foundations.md` § P0-1 has the test sketched as the "Empirical pre-implementation gate"); the result determines which of the three outcomes above the spec commits to.

---

## M19 — Shiki language pack scope

### Claim under test

`spec/02-architecture.md:15` references Shiki without specifying which grammars to ship.

### Findings

- Full Shiki bundle: ~1.2 MB gzipped (all themes, all languages).
- "Web" bundle: ~695 KB gzipped.
- Minimal bundle (one theme, one language, plus core + wasm): ~200 KB transferred.
- Shiki supports lazy-loading per-language async chunks.

### Implication for Wave 2

`02-architecture.md:15` must commit to a strategy: which languages ship by default, which lazy-load on demand. Recommended subset: TypeScript/JavaScript/JSX/TSX, C#, Go, Python, Java, Rust, Ruby, HTML, CSS, JSON, YAML, Markdown, Shell, SQL, plus `plaintext`. ~16 grammars. Lazy-load anything else when first encountered in a diff.

Document the subset in `02-architecture.md`; remove any implied "all languages supported".

---

## M20 — Self-contained .NET 10 binary size

### Claim under test

`spec/02-architecture.md:7, 145–147`: "self-contained ~70MB; AOT 30–50MB; includes the .NET runtime + the built React assets in `wwwroot`".

### Findings

No authoritative public benchmark for an ASP.NET Core 10 minimal-API + static-asset self-contained binary. General guidance says framework-dependent < self-contained < self-contained-with-ReadyToRun. Trimming reduces size; AOT trims aggressively but breaks reflection-dependent paths in ASP.NET Core (minimal-API runtime, polymorphic JSON).

Order-of-magnitude expectation, drawn from prior .NET versions: a self-contained ASP.NET Core minimal-API publish is in the 80–130 MB range *before* React assets. AOT can bring this down to 30–50 MB but requires source-generator-based JSON, removing reflection-based DI, and other constraints the spec hasn't planned for.

### Implication for Wave 2

The "~70 MB" claim is **unverified and likely optimistic** without AOT. AOT is non-trivial to make work with the chosen stack. Two paths:

1. **Drop the precise size claim.** Replace with "binary size budget: ≤ 150 MB self-contained; AOT investigated as size-reduction option in v2." Honest and scope-preserving.
2. **Commit to AOT in PoC.** Adds engineering cost (every dependency must be AOT-compatible; minimal API needs source-generator endpoints; `System.Text.Json` source-gen contexts for every serialized type). Real engineering work, not a flag flip.

Recommend (1) for PoC. Reopen the AOT decision as a P4 item.

Add a `dotnet publish` measurement to the P0 milestone gate so the actual number lands in the spec before v0.1.

---

## M21 — Mermaid v11 bundle size

### Claim under test

`spec/02-architecture.md:17`, `03-poc-features.md:336`: "~600KB; only loaded when ...".

### Findings

From a recorded mermaid-js discussion (issue [#4314](https://github.com/orgs/mermaid-js/discussions/4314)):

- mermaid v9.3.0: 878 KB
- mermaid v9.4.0: 2.65 MB
- mermaid v10.x minified: 2.69 MB
- TiddlyWiki + mermaid.min.js v10.3.0: 2.8 MB

Mermaid v11 introduces `@mermaid-js/tiny` ([npm package](https://www.npmjs.com/package/@mermaid-js/tiny)) — a stripped-down subset for cases where only a few diagram types are needed. Sizes for tiny are not in the discussion.

### Implication for Wave 2

The "~600KB" budget reflects an old version (pre-v9.4). Current reality is roughly 2.5–3 MB for the full bundle. Two paths:

1. **Use `@mermaid-js/tiny`** if the diagram types we care about (flowchart, sequence, state, ER) are supported. Restate the size budget after measuring the actual tiny bundle. Document the caveat: some Mermaid syntax won't render.
2. **Use full mermaid lazy-loaded.** Restate the budget as "lazy ~2.5 MB on first Mermaid encounter; cached thereafter; non-Mermaid pages pay zero". Acceptable cost for an explicitly opt-in heavyweight library.

Recommend (2) initially — fewer compatibility surprises — and reopen (1) if the lazy-load latency proves uncomfortable in practice.

Update both spec files; remove the "~600KB" claim.

---

## C5 — `--mcp-config` JSON shape for HTTP MCP servers (UNDOCUMENTED-VERIFIED-EMPIRICALLY)

### Claim under test

`spec/04-ai-seam-architecture.md` and `backlog/01-P0-foundations.md` § P0-7 both commit to writing a `--mcp-config` JSON file with a `{ "mcpServers": { "<name>": { "type": "http", "url": "...", "headers": {...} } } }` shape. The transport discriminator (`"type": "http"`) is required for HTTP MCP servers; without it, Claude Code parses the entry as a stdio command and rejects the file.

### Verification method

Empirical test ahead of P0-7 implementation: write the example JSON to disk, run `claude --mcp-config <path> -p "list your tools"`, confirm the host's tools appear and Claude Code does not error on parse.

### Status

**Pending** — to be performed by the P0-7 implementer as a gate before further work. Sources cite Claude Code's official MCP configuration documentation, but the exact `type` field key and value have not been confirmed against the running CLI version this project will ship against. If the field name differs (e.g., `"transport"` instead of `"type"`) or the URL discriminator is implicit by URL prefix, update both spec locations to match. Add the empirical evidence — version of Claude Code tested + working JSON shape — back into this entry once verified.

### Implication for P0-7

P0-7's library-selection spike must include this verification step early. Discovering the wrong JSON shape after the rest of the MCP server is built would be a multi-day rebuild.

---

## C6 — `addPullRequestReviewThread` parameter shape (UNDOCUMENTED-VERIFIED-EMPIRICALLY)

### Claim under test

`spec/03-poc-features.md` § 6 submit pipeline step 2 calls `addPullRequestReviewThread` with `pullRequestReviewId` of the pending review. GitHub's GraphQL `AddPullRequestReviewThreadInput` has shifted over time: the `pullRequestReviewId` field exists for replies (verified in C1), but for *threads*, the current preferred parameter may be `pullRequestId` with the pending review implicit, with `pullRequestReviewId` either deprecated or absent.

### Verification method

Read the live `AddPullRequestReviewThreadInput` schema via `gh api graphql -f query='{ __type(name: "AddPullRequestReviewThreadInput") { inputFields { name description isDeprecated } } }'`. Confirm which field the spec's pipeline should use as of implementation time.

### Status

**Pending** — to be performed before the submit pipeline implementation lands. If `pullRequestReviewId` on `AddPullRequestReviewThreadInput` is removed (rather than deprecated), step 2 of the spec's pipeline as written will fail; the spec must update the parameter shape to whatever's currently supported. If `pullRequestId` is the preferred shape, switch to that and add a one-line note documenting the schema drift.

### Implication for the submit pipeline

Either way, the verification-notes entry serves as a tripwire: if a future `gh api` call returns a different schema shape than what's documented here, the submit pipeline implementer is alerted before they ship against a stale shape.

---

## C7 — HTML-comment marker durability in `addPullRequestReviewThread` round-trips (UNDOCUMENTED-VERIFY-EMPIRICALLY)

### Claim under test

`spec/03-poc-features.md` § 6 step 3 (the submit pipeline's lost-response adoption step) commits to an **HTML-comment marker** scheme: every submitted thread body carries a `<!-- prism:client-id:<draft.id> -->` footer; on retry, the matcher parses the marker out of returned bodies and adopts by `draft.id` rather than by body equivalence. The narrowed claim under test is: **GitHub's GraphQL ingestion preserves HTML comments in `addPullRequestReviewThread` round-trips** (the rendered UI strips the comment, but the stored body the GraphQL `body` field returns retains it). This is the only condition the marker scheme depends on. Earlier wording leaned on byte-equivalence of the entire body as the idempotency check; that has been retracted in favor of the marker, which is durable across the body normalizations GitHub may perform (line-ending changes, Unicode NFC/NFD, trailing-whitespace stripping, HTML-entity normalization in code fences) because HTML comments are observed to pass through markdown rendering intact.

### Verification method

Empirical test before the submit-pipeline implementation lands. The test is narrow: confirm that an HTML-comment footer survives the round-trip. Call `addPullRequestReviewThread` against a test PR with a body of the form `<user body>\n\n<!-- prism:client-id:<guid> -->`; then query the same pending review's threads back via `pullRequest.reviews(states: PENDING).first(1).threads`; check that the returned `body` field contains the literal `<!-- prism:client-id:<guid> -->` substring. Run the test against three body shapes to cover the few ways markdown processors sometimes mangle HTML:

1. Marker as the only content (no user-visible body).
2. Marker as a footer after a normal user body (the default shape PRism submits).
3. Marker after a fenced code block (PRism appends the marker *outside* the fence; if the user's body ends in an unclosed fence the marker would land inside, which the implementer guards against by detecting and re-closing).

For each, record whether the marker substring is preserved in the returned body.

### Status

**Pending.** To be performed by the submit-pipeline implementer before the lost-response retry path is committed to. Three outcomes:

- **Marker preserved in all three cases** — the spec stands as written; the marker is the canonical idempotency key for the lost-response window. **This is the expected outcome** based on observed GitHub behavior in adjacent surfaces (issue/PR bodies, comment edits) where HTML comments are reliably retained.
- **Marker preserved in cases 1 and 2 but not 3 (fence edge)** — acceptable; PRism's submitter detects an unclosed fence and re-closes it before appending the marker, so case 3 in production never lands inside a fence. Document the test result and ship.
- **Marker stripped in any case where it shouldn't be** — fall back to **(a) client-side body normalization parity**: the matcher compares `(filePath, line, body)` after applying the same normalization steps GitHub applied (line-ending to `\n`, NFC Unicode, trim trailing whitespace, decode HTML entities). The fallback is documented but not built unless the test fails — building both schemes preemptively is wasted work. The earlier "(c) accept duplicate-thread risk" option is removed; it does not satisfy the DoD criterion that retry "must not produce duplicate threads or replies on GitHub."

### Implication for the submit pipeline

C7 is now a narrow gate (HTML-comment durability) rather than a broad gate (full body byte-equivalence across eight Unicode/whitespace permutations). The marker scheme is the default in `03-poc-features.md` § 6 step 3 — the implementer ships the marker first, runs the C7 test, and falls back to (a) only if the test fails. This eliminates the prior "log + ask user to dedupe" fallback (which was not a recovery — it accepted the duplicate-thread failure mode the adoption step exists to prevent).

---

## C8 — Model behavior on cumulative head-shift system-message injection (PENDING)

### Claim under test

`spec/04-ai-seam-architecture.md` § "head-changes mid-session" injects a cumulative-shift note into the user-turn prompt when the PR's `head_sha` shifts during a chat session. The note tells the model that earlier-turn code references may be stale and asks it to re-derive answers from the current diff. The claim under test: **a current-generation Claude model defers to the current diff over its working-memory pre-shift answers when prompted with this note.**

### Verification method

Empirical test before P2-2 chat ships. Use the latest Claude model PRism's chat is configured against (Opus 4.7 at minimum):

1. Start a chat session against a test PR at head `SHA_A`. Ask: *"What does the `validateOrder` function do at line 42 of `src/order_service.cs`?"* Capture the model's answer (Answer 1).
2. Simulate a head-shift to `SHA_B` where the function's behavior has changed (e.g., the test fixture's `validateOrder` at SHA_B no longer checks for null). Inject the cumulative-shift note as documented.
3. Ask a follow-up that depends on the now-stale answer: *"Given what you said earlier, would the function still throw on a null input?"* Observe the model's response.

Three possible outcomes:

- **Model re-derives from current diff** (re-reads `validateOrder` at SHA_B, notes the change, answers based on the new behavior) → injection works as designed; ship as written.
- **Model hedges** (mentions both pre-shift and post-shift behaviors, asks the user to clarify) → acceptable; the user is informed, no silent error.
- **Model confidently re-uses pre-shift answer** (says "yes, it would still throw," ignoring the shift) → injection is insufficient. Escalate the design: stronger system-prompt assertion ("pre-shift answers are now invalidated; do not refer to them"), or force a fresh session on every shift, or both.

### Status

**Pending.** Run during P2-2 implementation, before the chat feature ships. Document the observed outcome and adjust `04-ai-seam-architecture.md` § "head-changes mid-session" if outcome 3 occurs.

### Implication for P2-2

If the injection works (outcomes 1 or 2), the cumulative-shift design ships as written. If outcome 3, the chat orchestrator's behavior needs to escalate — either by sending a stronger reminder or by automatically restarting the chat session on shift (with the conversation log injected as system-prompt context). The latter is a meaningful UX downgrade (model loses internal state) but preserves correctness.

---

## Wave 2 readiness checklist

Spec-level updates that flow from Wave 1's findings. Items checked here are the *spec-text* updates, not the *implementation* — those are gating tripwires the implementer hits during P0 work.

- [x] Restate atomic-submit wedge in `01-vision-and-acceptance.md` (C1) — replaced "single API call" with reviewer-atomic + GraphQL pending-review framing.
- [x] Switch GitHub provider's submit code path from REST to GraphQL pending-review pattern (C1) — `03-poc-features.md` § 6 documents the full pipeline; `PRism.GitHub` is the implementation site.
- [x] Add "one pending review per user per PR" edge case to missing decisions (C1) — handled in `03-poc-features.md` § 6 step 1 via the foreign-pending-review prompt.
- [x] Re-spec iteration reconstruction in `02-architecture.md` and `03-poc-features.md` (C2) — `PullRequestCommit` + `HeadRefForcePushedEvent` + 60s clustering; `iterations.clusterGapSeconds` knob exposed.
- [x] Re-spec the AI repo-access path: drop MCP-resident filesystem tools entirely; use Claude Code's built-in `Read`/`Grep`/`Glob` scoped via `--add-dir`; lazy mid-session consent via the model calling `request_repo_access` (which takes no arguments — host-authored modal copy only); upgrade via fresh-session-with-injection (C3, C4 dangling-tool-use sidestepped) — `04-ai-seam-architecture.md` § "Repo access via lazy upgrade with fresh-session injection" describes the chosen design. **Note**: C4's *clean-end resume* sub-question is load-bearing for the cross-restart chat UX (W30); see C4 entry above.
- [x] Add P0 task: "select or hand-roll a .NET MCP server library" (C3) — `backlog/01-P0-foundations.md` § P0-7.
- [x] Commit to a Shiki language subset in `02-architecture.md` (M19) — 16 grammars listed; lazy-load for the rest.
- [x] Drop the "~70 MB" binary-size claim or commit explicitly to AOT with associated cost (M20) — replaced with "≤ 150 MB; AOT investigated as P4 size-reduction option."
- [x] Replace the "~600KB" Mermaid claim; commit to lazy-loaded full or to `@mermaid-js/tiny` (M21) — `02-architecture.md` and `03-poc-features.md` quote ~2.5–3 MB lazy-loaded; tiny reserved as future swap.

### A note on gate runnability

C5, C6, C7, the C4 clean-end resume probe, and C8 are deferrable to P0 implementation, but **C5 / C6 / C7 are trivially runnable today** and resolving them now moves the corpus from "design-ready" to "implementation-ready":

- **C5** (MCP config JSON shape): ~30 minutes with `claude --mcp-config <test.json>` and a stub HTTP server that logs incoming requests. Resolves whether `"type": "http"` is the correct discriminator.
- **C6** (`AddPullRequestReviewThreadInput` field name): ~2 minutes with `gh api graphql -f query='{ __type(name: "AddPullRequestReviewThreadInput") { inputFields { name description isDeprecated } } }'`. Resolves the parameter shape against the live schema.
- **C7** (HTML-comment marker durability): ~few hours with a test PR — submit a thread with the marker, query the pending review's threads, check whether the marker substring is preserved in the returned body. Resolves the default for the lost-response retry path.
- **C4 (clean-end resume)**: ~1 day with two sequential `claude` invocations and a follow-up turn that probes prior context. Resolves the cross-restart chat resume UX.
- **C8** (head-shift cumulative-injection model behavior): ~1 day with a test fixture PR and a current-generation Claude model. Resolves whether the chat orchestrator's design holds.

**Recommendation:** run C5 and C6 during the next focused review window — both are sub-day. C7 lands best ahead of submit-pipeline work but can be batched. C4 lands ahead of P2-2 chat. C8 is a P2-2 prerequisite. None of these block PoC ship from the v0.1 work the implementer can already start (project scaffolding, frontend setup, GitHub provider basics) — they gate features that come later in the dependency chain.

Outstanding empirical gates (these are not spec-text updates; they are tripwires the implementer hits during P0):

- [ ] **C4 (clean-end resume)** — verify that `claude --resume <session-id>` after a *clean* session end restores the model's full conversation context. Run as part of P0-1's acceptance gate, before P2-2 chat ships. The result determines whether the spec's cross-restart "Resumed your chat from <timestamp>" UX is achievable or degrades to fresh-with-injection. Also probe whether resume survives a CLI update between session-end and resume.
- [ ] **C5** — verify the `--mcp-config` JSON shape (`"type": "http"` discriminator key) against the running Claude Code CLI version the project ships against. Run as the first task of P0-7.
- [ ] **C6** — verify the live `AddPullRequestReviewThreadInput` parameter shape (whether `pullRequestReviewId` or `pullRequestId` is the correct field as of implementation time) via `gh api graphql -f query='...'`. Run before the submit-pipeline implementation lands.
- [ ] **C7** — verify that the `<!-- prism:client-id:<id> -->` HTML-comment marker survives `addPullRequestReviewThread` round-trips (rendered UI strips the comment; the GraphQL `body` field retains it). The lost-response adoption step in the submit pipeline matches by marker, not by body equivalence. Run before the submit-pipeline implementation lands. See § C7. Documented fallback if the marker is stripped: (a) client-side body normalization parity; (c) accept-best-effort is no longer an option.
- [ ] **C8** — verify the model defers to current diff over pre-shift answers when prompted with the cumulative head-shift note. Run before P2-2 chat ships. See § C8 for the test sequence and outcomes.

---

## PAT type detection

**Implementation pattern (informational).** PRism's Setup-time validator branches on the token prefix:
- `ghp_…` → classic PAT; `X-OAuth-Scopes` is parsed and diffed against `["repo", "read:user", "read:org"]`.
- Anything else (`github_pat_…`, `gho_…`, etc.) → fine-grained / OAuth-style; `X-OAuth-Scopes` is empty for these tokens, so the header check is skipped.

For fine-grained tokens, a follow-up Search probe (`GET /search/issues?q=is:pr+author:@me`/`review-requested:@me`) detects the no-repos-selected failure mode. If both return `total_count: 0`, the connect endpoint returns `warning: "no-repos-selected"` without committing the token; the frontend gates the commit behind a confirmation modal.

This was added in `docs/superpowers/specs/2026-05-06-pat-scopes-and-validation-design.md` after the original adversarial-review pass missed the `X-OAuth-Scopes` shape difference between classic and fine-grained PATs.
