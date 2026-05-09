# PoC Features

Every user-facing feature shipping in the PoC, fully specified.

---

## 1. First-run setup

### Behavior
- On first launch (detected by absence of token in keychain), the app shows a Setup screen.
- Setup screen contains:
  - A **GitHub host** input (text field, default `https://github.com`). For GitHub Enterprise Server users, override with the GHES instance host (e.g., `https://github.acmecorp.com`). The value is persisted to `config.json` as `github.host` and is the same field documented in `02-architecture.md` § "GitHub host configuration."
    - **Validation rules** (applied on blur and again on Continue):
      - Bare host without scheme (`github.com`) — auto-prepend `https://` and accept; show a brief inline note ("scheme assumed: https://").
      - Trailing slash (`https://github.com/`) — strip silently.
      - Path beyond the host (`https://github.com/foo/bar`) — strip the path, surface a soft warning ("path stripped: `foo/bar`"). The `github.host` config field is a host, not a URL with path.
      - API URL pasted instead of human URL (`https://api.github.com`) — detect (a leading `api.` subdomain) and surface a corrective inline message: "this looks like the API URL; the host field expects the human URL (`https://github.com`). Use this human URL?" with one-click accept.
      - `http://` (unencrypted) scheme — accept only with an explicit "I'm on a trusted internal network" checkbox the user must tick. Surface a warning that PATs are sent in clear text. For PoC's audience this is rare enough to gate behind opt-in; documenting the option avoids blocking users with an internal GHES that has not yet been TLS-fronted.
      - Non-HTTP scheme (`ssh://`, `git://`) or otherwise malformed URL — inline error: *"`{value}` is not a valid GitHub host. Expected `https://github.com` or your GHES host (e.g., `https://github.acmecorp.com`)."*
    - The validator runs the same logic on a paste into the URL-paste escape hatch on the inbox; the host the user pastes there is checked against the configured host using these same normalization rules.
  - A link to the **PAT generation page** templated against the host: `<host>/settings/personal-access-tokens/new`. Updates live as the user types in the host field.
  - The Setup screen lists the **fine-grained permissions** PRism requires:
    - Pull requests: Read and write
    - Contents: Read
    - Checks: Read
    - Commit statuses: Read

    Metadata: Read is auto-included by GitHub. For Repository access, the user picks "All repositories" or "Select repositories" (the public-only mode does not expose private repos PRism needs).

    A muted footnote covers users with an existing classic PAT: *"Already have a classic PAT? It needs the `repo`, `read:user`, and `read:org` scopes."* (Matches `RequiredScopes` in `GitHubReviewService`; mismatching the validator surfaces as `InsufficientScopes`.)
  - A textarea to paste the token.
  - **A small "About local data" disclosure block** below the form: *"PRism stores your drafts, view state, and a forensic recovery log of mutations under `<dataDir>/`. The recovery log (`state-events.jsonl`, default on, ~300 MB ceiling) is what lets us recover a draft if `state.json` is corrupted. Disable it later in `config.json` (`logging.stateEvents: false`) if you prefer a smaller footprint — the trade is that 'my draft disappeared' is unrecoverable."* The disclosure is a one-time onboarding signal so a privacy-conscious user knows the log exists and how to opt out, without making them choose at the moment they're trying to paste a token.
  - A "Continue" button.
- On Continue:
  - Backend calls `GET /user` against GitHub to validate the token.
  - On 200: backend then probes `GET /search/issues?q=is:pr+author:@me&per_page=1` and `GET /search/issues?q=is:pr+review-requested:@me&per_page=1` to detect the **fine-grained-PAT-with-no-repos-selected** failure mode. If both probes return zero results, surface the soft warning before navigation; otherwise commit the token immediately.
  - **No workspace picker in PoC's setup flow.** PoC has no chat, no clones, no `.prism/` footprint to place — the workspace concept is purely a v2 chat concern. v2's first-chat-open is the natural place to ask the user where their repos live (with full context to explain the choice: a specific repo about to be cloned, an estimated size, the alternative of `<dataDir>/.prism/`). Earlier drafts of this spec included an "optional workspace step" in PoC's setup so users wouldn't have to revisit Setup when v2 lit up; it has been dropped because it asked users to make a decision they could not evaluate (they didn't know what chat would need from `localWorkspace`) for a feature they may never use. The `config.github.localWorkspace` field still exists in the schema (read by P2-2 chat onwards); v2 prompts on first chat-open and writes to it then.
  - On 401: error displayed inline ("Token rejected — check that you copied it correctly").
  - On other: error displayed inline ("Could not reach GitHub — check your network").
- The Setup screen is also accessible from a **"Replace token" link in the app footer** — the only Settings affordance that ships in PoC's UI. (Everything else under Settings is file-only via `config.json`; the token, however, lives in the OS keychain and cannot be edited via a config file. The footer link is the single path to swap PATs without leaving the app.) Clicking it navigates to the Setup screen with the existing keychain token cleared and the form pre-populated with the configured `github.host`.

### State
- Token: in OS keychain (MSAL extensions) — not on disk.
- "Have we ever set up?" detected by token presence; no separate flag.

### Token expiry handling
- All GitHub API calls go through a wrapper that detects 401.
- On 401 from any endpoint: app navigates the user to the Setup screen with a banner: "Your token has expired. Generate a new one."
- The user's drafts and view state are preserved across token regeneration.

---

## 2. Inbox

The default landing surface after setup. Shows PRs that involve the user, organized into sections.

### Sections (in display order)

1. **Review requested** — PRs where the user has been explicitly asked to review.
   - Query (GitHub Search API): `is:open is:pr review-requested:@me archived:false`
2. **Awaiting author** — PRs the user has commented on or requested changes on, where the ball is in the author's court.
   - Query: `is:open is:pr reviewed-by:@me archived:false` filtered to PRs with newer commits than the user's last review submission.
3. **Authored by me** — PRs the user opened.
   - Query: `is:open is:pr author:@me archived:false`
4. **Mentioned** — PRs where `@<username>` appears in any comment. **Section is shown by default** (the maintainer's call: most reviewers want @-mentions visible). User can hide it by setting `inbox.sections.mentioned: false` in `config.json`.
   - Query: `is:open is:pr mentions:@me archived:false`
5. **CI failing on my PRs** — PRs the user authored where **any check-run is failing or any commit status is `error` / `failure`**. (The rule is "anything reporting failure," not "anything required for merge" — branch-protection-aware filtering, where only checks marked required by branch protection count, is a P4 backlog item; PoC's surface includes failing optional checks like style linters that aren't required for merge.)
   - Source: results of section 3 + per-PR call to the GitHub Checks API and the legacy combined-statuses API to find any failing check-run or error/failure status.
   - **Section overlap policy:** PRs in section 5 are also in section 3 (both are "PRs I authored"). PoC's default is **deduplicated** (`inbox.deduplicate: true`): a failing PR appears only in section 5, not section 3, so the user does not see the same PR row twice for one PR. The same dedup rule applies symmetrically to **section 1 (review-requested) vs section 4 (mentioned)**: a PR that is both review-requested *and* mentions the user appears only in section 1 (the more specific signal — they're explicitly asked to review — wins over the weaker one). The earlier draft of these rules defaulted to non-deduplicated (a PR with failing CI showed up in sections 3 and 5; a review-requested mention showed up in 1 and 4); user feedback pushed it the other way — seeing 6 visual rows for 3 distinct PRs was confusing. Setting `inbox.deduplicate: false` restores the earlier behavior for users who want the pure-membership semantics for both pairs.

### Section behavior
- Each section is collapsible. Initial state: expanded.
- Section header shows count: "Review requested (3)".
- **All-empty inbox state.** When *every* section returns zero PRs (typical on first launch with a fresh PAT, or after the user has cleared every active review), surface a single one-line hint at the top of the inbox above the section list: *"Nothing in your inbox right now. Try pasting a PR URL above to jump to a specific PR, or wait for a review request."* Suppressed as soon as any section becomes non-empty. This avoids the empty-five-times-with-no-onboarding cold-start.
- Empty sections show a section-specific muted placeholder so the copy matches whether the empty state is *good news* or merely neutral:
  - **Section 1 (Review requested):** *"No reviews requested right now."*
  - **Section 2 (Awaiting author):** *"Nothing waiting on the author."*
  - **Section 3 (Authored by me):** *"You haven't opened any PRs."*
  - **Section 4 (Mentioned):** *"You aren't @-mentioned on any open PRs."*
  - **Section 5 (CI failing):** *"No CI failures on your PRs — nice."* (This one is reassurance, not neutral.)

### PR row (in any section)

Each row displays:
- Title (clickable; navigates to PR detail view)
- Repo (e.g., `acme/api-server`)
- Author (avatar + login)
- Age ("2h", "yesterday", "3d ago")
- Comment count
- **Unread badges** (right-aligned):
  - "🔵 2 new commits" if `lastViewedHeadSha != null && head_sha != lastViewedHeadSha`. **First-visit suppression**: if `lastViewedHeadSha` is null/unset (no review session entry exists for this PR yet), no commits-badge fires — a never-opened PR is not "new commits", it's "never seen", which the `<New>` row chip captures more honestly. The first time the user opens the PR detail view, the backend writes `lastViewedHeadSha = head_sha` atomically before the next inbox poll, so subsequent visits compute correctly.
  - "💬 3 new comments" if `lastSeenCommentId != null && comments newer than lastSeenCommentId exist`. Same first-visit rule: null/unset → no badge; first PR-view sets `lastSeenCommentId = max(comment.id)` atomically.
  - Only one type of badge if both apply, but the dot color signals both

### URL paste escape hatch

Above the inbox sections, a single text input: "Paste PR URL — jump to it directly."
- Accepts any GitHub PR URL whose **host matches the configured `github.host`**: `<host>/<owner>/<repo>/pull/<number>`. For cloud users this is `https://github.com/<owner>/<repo>/pull/<number>`; for GHES users it's `https://<ghes-host>/<owner>/<repo>/pull/<number>`.
- A pasted URL whose host does *not* match `github.host` fails with a clear error: *"This PR is on `<host>`, but PRism is configured for `<configured-host>`. Switch hosts in Setup, or restart with a different data directory for the other host."*
- On valid URL → navigates to PR detail view
- On invalid URL (malformed, not a PR URL) → inline error
- Critical for the "colleague drops a link in chat" case — without this escape hatch, the user has no fast path to a PR not surfaced in their inbox.

### Polling

- Background poll every **120s** (configurable via `polling.inboxSeconds`).
- Diff against current inbox state. If changes detected (new PR, new commit on existing PR, new comment, CI state change), display banner above sections: *"3 new updates — Refresh."*
- Banner is dismissible; clicking Refresh applies updates and dismisses.
- View does NOT auto-mutate. The user explicitly chooses when to refresh.

### Token-scope mismatch

If the user's fine-grained PAT does not cover a repo whose PR appears in their Search API results:
- The PR row is **hidden** (we don't surface PRs the user can't access; the footer below acknowledges them in aggregate so the user knows scope is limited).
- A footer at the bottom of the inbox: *"Some PRs may be hidden — your token may not cover all your repos. [Configure token scope]"* (no count is shown — most hidden PRs are in orgs the API never reports, so any count would be a fraction of the actual hidden set and would mislead. Earlier wording promising a literal count `N` has been dropped.)
- The footer link goes to GitHub's PAT settings.

#### Fine-grained PAT scope behavior

Fine-grained personal access tokens are **scoped per-org** (and within an org, per-repo). The Search API (`/search/issues`) returns only results from repos the token can access — meaning a PR a colleague drops in chat may be invisible in search even if the user is a reviewer on it. Two consequences:

1. **The footer cannot count PRs from orgs the token doesn't cover at all** (the API never reports them). It could count PRs from orgs the token covers but where specific repos are excluded — but that is a tiny fraction of the actual hidden set, and surfacing only that count would mislead more than not surfacing one. The footer drops the count entirely and surfaces a soft prompt: *"Some PRs may be hidden — paste a PR URL above to access ones not in your inbox."* If a count is ever reintroduced, it must be qualified explicitly with what it does and does not include.
2. **The URL-paste escape hatch is the recovery path.** If a colleague shares a link to a PR in an unscoped repo, paste-the-URL hits `GET /repos/{owner}/{repo}/pulls/{n}` directly; if the token has no access, surface the standard 404 error with the message "your token doesn't cover this repo — update token scope at github.com/settings/tokens."

Classic PATs (broader scope) work without these caveats but are deprecated by GitHub for new use cases. PoC documents fine-grained PAT support; classic-PAT compatibility is not actively prevented but not guaranteed.

### Implementation notes

- Inbox state is fetched lazily on inbox view mount.
- Backend keeps the most recent poll result for each section in memory, keyed by `(section_id, query_hash)`. The store is replaced wholesale when the polling refresh runs and produces a new value; there is no TTL within a polling window. This is closer to "in-memory storage of the latest poll result" than to a true cache (it does not reduce per-poll-cycle traffic to GitHub — only redundant frontend-driven requests within a window). Calling it "caching" was loose framing; the rationale is "frontend hits the same backend endpoint multiple times within a polling window (toggle collapse, navigate to PR view and back) and the backend should not re-call GitHub for each."
- Search API rate limit is 30 req/min; a full inbox refresh fetches 5 sections + per-PR Checks for section 5. Fits comfortably within limits at 2-min cadence even with the per-PR fan-outs noted below.

#### Per-section rate-limit accounting

The per-section costs add up in two places PoC must track explicitly:

- **Section 2 (Awaiting author)** filters Search API results by "newer commits than the user's last review submission." Computing "user's last review submission" per PR requires `pulls/{n}/reviews` per matched PR. For a user with 30 reviewed-but-still-open PRs, that is 30 extra calls per refresh. Mitigations:
  - Cache `(pr_ref, head_sha) → user_last_review_sha` aggressively (invalidate only when `head_sha` changes).
  - On cold start, fetch in parallel with a concurrency cap (e.g., 8); subsequent refreshes are mostly cache hits.
  - At 2-min cadence with cold cache, worst-case ~30 extra calls every 2 min = 15 calls/min, comfortably within the 5000/hour core REST limit.
- **Section 5 (CI failing on my PRs)** uses the **Checks API** (`/repos/{o}/{r}/commits/{sha}/check-runs`) per authored PR. PoC also queries the **legacy combined statuses API** (`/repos/{o}/{r}/commits/{sha}/status`) on the same call set, because some CI systems (older Travis, some self-hosted runners) still post statuses rather than check-runs. The CI-failing inclusion rule is: "any failing check-run OR any error/failure status." Cost: ~2 calls per authored PR. Cache same as the awaiting-author section above (key on `(pr_ref, head_sha)`, invalidate on `head_sha` change, cold start fans out with concurrency cap of 8).
- The 30 req/min limit applies to the Search API specifically, not to per-PR REST calls (which use the 5000/hour core limit). These are separate budgets and PoC doesn't conflate them.

### AI seam usage (PoC: no-op)

- `IInboxRanker` could re-order rows. PoC: identity (no re-ordering).
- `IInboxItemEnricher` could attach summaries / category badges to rows. PoC: no enrichments.
- Both flagged behind `ai.inboxRanking` and `ai.inboxEnrichment` capabilities; rendered with no-op stubs.

### Activity rail (right-side rail in the inbox grid)

The inbox grid has a right-side "Activity" rail (per [`design/handoff/screens.jsx`](../../design/handoff/screens.jsx) `ActivityFeed`) showing recent cross-PR activity ("amelia.cho pushed iter 3 to #1842", "ci-bot marked CI failing on #1827", etc.) and a "Watching" sub-list of repos.

**The rail is deliberately NOT backed by an AI seam in the PoC.** It renders as a hand-canned static React component with items lifted verbatim from the design handoff, gated on the existing `ui.aiPreview` flag (no per-rail `ai.*` capability). This is a deliberate exception to the "every AI surface in the inbox is backed by a `Noop*` / `Placeholder*` seam pair" pattern. See [`04-ai-seam-architecture.md`](04-ai-seam-architecture.md) § "What's NOT seamed (deliberate deferrals)" for the rationale and the v2 retrofit posture.

When `ui.aiPreview` is `false`, the rail is not rendered (parent grid collapses to single-column). When `true`, the rail renders the canned data — same flag-flip semantics as the seam-backed AI surfaces, even though no seam is involved.

The rail is also hidden below the 1180px viewport breakpoint per the design handoff's responsive rules (independent of the `aiPreview` flag).

---

## 3. PR detail view

The main reviewing surface.

### Layout (top to bottom)

1. **Header bar** (sticky)
   - PR title
   - Author + repo + branch info ("from `feature-x` into `main`")
   - Mergeability indicator ("Mergeable" / "Conflicts" / "Unknown")
   - CI status summary ("3 checks passing, 1 failing")
   - Verdict picker (left-most action) — see "Submit flow"
   - Submit Review button — see "Submit flow"
2. **PR sub-tab strip** (sticky below header) — three tabs: **Overview** / **Files** / **Drafts**. Overview is the default landing tab on PR open. Drafts is rendered but disabled until S4 ships the composer.
3. **Per-tab content area:**
   - **Overview tab.** Hero card containing `<AiSummarySlot>` (capability-flag-gated; `null` in PoC, AI summary in v2). Below that: PR description, stats (changed files / additions / deletions / commit count), PR-root issue-level conversation rendered **read-only**, and a "Review files" CTA that switches to the Files tab. Reply composer + "Mark all read" lands in S4 alongside the inline-comment composer. See § "PR view scope" below.
   - **Files tab.** The reviewing surface. Top of the tab carries the **iteration tabs** (described below); under them, a two-pane main area. Iteration tabs render *only* on the Files tab.
     - **Iteration tabs** — "All changes" tab (default selected); **Last 3** iteration tabs inline (i.e., the most recent three — for a 5-iteration PR: Iter 3, 4, 5 are inline; Iter 1, 2 are in the dropdown; for a PR with ≤ 3 iterations all are inline and the dropdown is hidden); older-iterations dropdown ("All iterations ▾"); "Compare ⇄" picker for arbitrary-pair diffs.
     - **Two-pane main area** — left pane: **File tree** (collapsible directories with smart compaction, per-file "Viewed" checkbox, AI focus badge slot); right pane: **Diff for currently-selected file** (file-by-file, not continuous scroll).
   - **Drafts tab.** Disabled until S4. Surfaces the user's saved drafts on this PR plus the stale-draft reconciliation matrix.
4. **Banner overlay** (when PR has been updated since last reload) — sticky just below the PR sub-tab strip.

The `<AiSummarySlot>`'s position moved from "between sticky header and sticky iteration tabs" (the earlier sticky-stack design) to "Overview-tab hero card." See `04-ai-seam-architecture.md` § `<AiSummarySlot>` for the placement rationale.

### File tree

- **Collapsible directory tree.** Files grouped under their parent directories; each directory is a collapsible node. Single-child directory chains are **smart-compacted** into a single row (`src/components/diff/` instead of three nested nodes), which keeps long monorepo paths readable without forcing the user to expand four levels to see anything. Compaction stops at any directory that has more than one child or that contains files directly.
- **Per-directory viewed-rollup.** Each directory row shows a small rollup of viewed status across its files: e.g., `3 / 7 viewed`. The rollup updates live as the user toggles per-file checkboxes inside it. Recursive: parent directories aggregate their children's rollups.
- **Collapse-state resets on PR open.** Every PR-detail mount renders the tree fully expanded; the user's manual collapse/expand within a session is in-memory only and is discarded on the next PR open. This is deliberate — collapse-state persistence across reopens is a S6/v2 settings item; the in-session ergonomics are what S3 ships.
- Each file row shows:
  - Status icon (added / modified / deleted / renamed)
  - File path (just the filename within its directory row; the full path is implicit from the parent directories)
  - Line counts ("+12 -3")
  - "Viewed" checkbox (right-aligned)
  - **AI focus badge slot** (`<AiFileFocusBadges>`) — capability-flag-gated; `null` in PoC
- Selected file highlighted.
- `j` / `k` keyboard shortcuts navigate next/prev file in tree (skipping directory headers).

### "Viewed" checkbox semantics

- Per-`(pr_ref, file_path, head_sha)` — same as GitHub.
- The lookup walks the **full PR commit graph**, not just the clustered iterations. When the user marks `src/Foo.cs` viewed at `head_sha = abc`, the backend scans every commit between `abc` and the current head looking at each commit's `changedFiles` to decide whether the file has been touched since the mark.
  - If any commit since the mark touches that file → checkbox resets, file appears unviewed.
  - If no commit since the mark touches that file → checkbox persists, file remains viewed.
- **Truthful-by-default on unknown commit data.** Commits with unknown `changedFiles` (the per-commit REST fan-out failed or was skipped because the PR exceeded `iterations.skip-jaccard-above-commit-count`) cause the checkbox to reset rather than persist. The file *might* have been touched; without the data we can't be sure, and the safer default is "show the user the diff again" rather than "trust a stale checkmark." This matches GitHub's own conservative handling.
- Storage: `state.json.reviewSessions[ref].viewed-files[<filePath>] = <headShaAtTimeOfMark>` (the C# field is `ReviewSessionState.ViewedFiles`) — see `02-architecture.md` § "State schema (PoC)."
- Visual indicator on the file row: "Viewed" checkbox is checked, file path appears slightly muted.
- **Known limitation on PRs above the per-commit fan-out cap.** The post-mark scan needs each commit's `changedFiles`. On PRs that exceed `iterations.skip-jaccard-above-commit-count` (default 100 commits), the per-commit REST fan-out is skipped entirely and every commit's `changedFiles` is unknown. Combined with the truthful-by-default rule above, the viewed-checkbox **resets on every reload** for files in PRs above the cap — the reviewer loses progress tracking on exactly the large PRs where it would matter most. P0+ may add a coarser "viewed at PR head SHA" fallback that doesn't depend on per-commit data (accepting a known staleness risk in exchange for a usable progress indicator); until then, the viewed-checkbox is effectively a per-session affordance on very large PRs.

### Empty PR (no commits beyond base)

If `GetDiffAsync` returns an empty `FileChange[]` (PR opened with no commits, or the PR's head equals its base), the file tree renders empty with a placeholder message: *"This PR has no changes yet. Commits added later will appear here on reload."* The submit button is disabled (no draft comments possible without a diff to anchor them; a "Comment" verdict with only a summary is permitted via the submit dialog). The banner refresh model continues to poll, so when the author pushes the first commit, the user sees the update banner and reloads.

### Diff display

- **Library:** `react-diff-view`.
- **Default:** side-by-side, three lines of context per hunk, syntax-highlighted via Shiki.
- **Toggle:** unified view (single column with +/- markers).
- **Word-level highlighting** within changed lines, using `diff` (jsdiff) library.
- **Whitespace shown as-is.** No filtering, no toggle. v2 AI categorizes; PoC is truthful.
- **No expand-to-full-file in PoC.** Hunks only. No "show whole file" button. (The backend's `GET /api/pr/{ref}/file` endpoint exists for markdown rendering and *could* serve full file content to a UI affordance — the architectural cost is zero; the gate is purely UX. Adding the button is a P4 item, `P4-B8`, and is the smallest possible UI change once the demand is real.)
- **Diff source and truncation.** Diff content is built from `pulls/{n}/files` (the file list, paginated to GitHub's 3000-file ceiling) plus the `pulls/{n}` `changed_files` integer cached alongside the rest of the PR object. Truncation is **derived** as `pull.changed_files > files.length` — there is no `compare`-endpoint round-trip. (GitHub's `compare` endpoint documents truncation behavior in prose only; the response body carries no `truncated` field, so probing it would tell us nothing the file-count derivation doesn't.) On truncation, the diff pane footer surfaces a banner with the exact copy: *"PRism shows GitHub's first N files of this diff. Full-diff support is on the roadmap. Open on github.com."* The banner copy is matched verbatim by the `DiffTruncationBanner` component.
- **Click-to-comment:** clicking any line in the diff opens a comment composer anchored to that line. (See "Comments" section.)
- **Existing GitHub comments** are rendered as inline widgets between code lines, **read-only** in PoC.
- **AI hunk annotation slot** (`<AiHunkAnnotation>`) — uses the same widget API as comment threads; capability-flag-gated; never inserted in PoC.

**PR view scope.** The Files tab shows the diff and inline comments; the Overview tab renders **PR-root issue-level comments read-only** (the conversational thread that github.com shows under the PR description, separate from line-anchored review comments). The **chronological PR conversation feed** (commits + comments + reviews + status updates + force-push events in time order) that github.com surfaces on the "Conversation" tab is **out of scope for PoC**. The iteration tabs capture push history; the file tree captures file changes; threaded review comments capture line-anchored discussion; the Overview tab's read-only thread captures PR-level discussion. A merged chronological feed is a P4 backlog item if reviewers report missing it. PoC's bias is "the things that matter for reviewing the code"; v2 may add the conversational view if dogfooding shows it's missed.

### Iteration tabs

- "All changes" tab shows the standard PR diff: `base..current_head`.
- Each iteration tab shows the diff range for that iteration:
  - Iteration N tab → `iter_N-1_head..iter_N_head` (just what changed in that round).
  - For N=1 (the first iteration), `iter_0_head` is **the PR's merge-base against its target branch** (the same SHA the "All changes" tab uses as `base`). Subsequent iterations chain from the prior iteration's `after` SHA. Equivalently: each `PrIteration`'s `before` field is iteration N-1's `after`, with iteration 1's `before` taken from the PR's `merge_base_sha` at the time the iterations were reconstructed.
  - Reasoning: when a reviewer clicks "Iter 3", they want "what did the author change *in this round*," not the cumulative diff.
- Above the diff, each iteration tab also shows a small commit list (the commits added in that iteration).
- "Compare ⇄" picker: choose any two iterations from a dropdown; the diff updates to `iter_X_head..iter_Y_head`.
  - **UI surface.** Two inline dropdowns next to a `⇄` separator: `[Iter X ▾] ⇄ [Iter Y ▾]`. Both dropdowns list the same iteration set (Iter 1 … Iter N).
  - **Auto-swap on reverse selection.** If the user picks `Y < X` (e.g., left dropdown shows Iter 4, right shows Iter 2), the picker silently swaps the values so the diff is always computed `lower..higher` (`iter_2_head..iter_4_head`). A small "swapped" hint appears next to the picker for one second on swap so the user knows their selection was normalized.
  - **Same-iteration selection.** If `X == Y`, the diff area renders the empty-diff state with the message *"No changes between Iter X and Iter X."* The diff library is not invoked; the file tree shows zero files.
  - **"All changes" mixed with iterations is not allowed.** Both dropdowns are scoped to numbered iterations only. The PR-wide "All changes" view is the existing left-most tab in the iteration tab strip, not a Compare option; combining it with an iteration on the other side is undefined and forbidden by the picker (the dropdown items are limited to numbered iterations).

### Iteration reconstruction

- Source: GitHub GraphQL `PullRequestTimelineItems` connection.
- GraphQL has no `synchronize` event (that's a webhook-only name). The two relevant timeline types are:
  - `PullRequestCommit` — one event per commit on the PR. No native grouping into "this push".
  - `HeadRefForcePushedEvent` — fired only on force-pushes; carries `beforeCommit` and `afterCommit`.
- **Algorithm.** The full algorithm — weighted-distance clustering with two live multipliers (file Jaccard and force-push), MAD-based threshold, degenerate-case detector, and four documented future multipliers — lives in [`docs/spec/iteration-clustering-algorithm.md`](./iteration-clustering-algorithm.md). It supersedes the earlier "60-second `clusterGapSeconds` knob" policy. The earlier knob is **retired**; tuning is done through `iterations.clustering-coefficients` (file-jaccard-weight, force-push-after-long-gap, force-push-long-gap-seconds, mad-k, hard-floor-seconds, hard-ceiling-seconds, skip-jaccard-above-commit-count, degenerate-floor-fraction).
- The algorithm reads `committedDate` (not `authoredDate`) for ordering — `--amend` and rebase refresh the committer date, but author date can lie about timeline position after history rewrites. This is a deliberate, load-bearing choice; the algorithm doc records the rationale.
- Per-commit `changedFiles` (input to `FileJaccardMultiplier`) is fetched via REST `GET /repos/{o}/{r}/commits/{sha}` fan-out (concurrency cap 8, 100 ms inter-batch pace), bounded by `iterations.skip-jaccard-above-commit-count` (default 100). GraphQL's `Commit` type does not expose changed-file paths — the REST fan-out is the only path. On 4xx from the fan-out, mark the offending commit's file set as unknown, mark the session degraded (subsequent fan-outs skipped), log a single warning, and continue.
- Each iteration's range is `iter_N-1_head..iter_N_head` (the SHAs at the boundary points). Iterations are numbered by chronological order: 1 = first iteration, 2 = second, etc.
- **Force-push as a soft signal.** Earlier wording made every `HeadRefForcePushedEvent` a hard iteration boundary. The current algorithm treats force-push as a *multiplier* (the `ForcePushMultiplier`) whose strength scales with the surrounding time gap: a force-push within `force-push-long-gap-seconds` of the prior commit is treated as an `--amend` fixup (no expansion); a force-push after a long gap multiplies the distance by `force-push-after-long-gap` (default 1.5), making the boundary likely. This handles the common case of a tight `--amend` + force-push chain without exploding the tab count. See the algorithm doc for the full treatment, including positioning when `beforeCommit` / `afterCommit` are null after GitHub GC.
- **Calibration-failure escape hatch.** When the discipline-check (slice spec § 11.5) fails to reach 70% agreement on hand-labeled corpora, set `iterations.clustering-disabled = true`. PrDetailLoader then emits `ClusteringQuality: Low` for every PR; the frontend renders `CommitMultiSelectPicker` instead of `IterationTabStrip` — same UX as the per-PR degenerate fallback and the 1-commit case.
- Iteration boundaries are **approximate** for normal pushes (committer dates can lie, especially after `git commit --amend`). Force-pushes are *detected* exactly even though their iteration-boundary contribution is now soft. The UI does not promise per-push fidelity for normal-push grouping; "iteration" is a reviewer convenience, not a git-truth claim.
- **Recovering from a misclustered iteration.** A right-click on the iteration tab strip exposes "Merge with previous iteration" / "Split iteration here" — both UI-only operations on the locally-computed iteration list (no GitHub side-effect). The user's manual override is persisted in `state.json.reviewSessions[ref].iterationOverrides` so it survives reload. This makes the algorithm's failure modes recoverable in-tool rather than requiring a config edit + restart.
- **Pre-shipping discipline check.** Run the algorithm against 5–10 real PR histories from the author's recent reviewing experience (heavy amend cycles, rebases, multi-day work, CI-amend pipelines). Document what fraction cluster correctly. **If discipline-check agreement falls below 70% after the documented tuning rounds, set `iterations.clustering-disabled = true`** and ship `CommitMultiSelectPicker` as the universal fallback — the wedge is "iteration tabs are first-class when they work; the GitHub-style commit picker when they don't," not "always iteration tabs even when they're misleading."
- **Iteration range after rebase-onto-main:** if an iteration's SHA range includes both the author's changes and a mainline catch-up (because the author rebased their feature branch onto a newer main), the diff `iter_N-1_head..iter_N_head` will show both. PoC does **not** try to filter out the mainline-catch-up portion (that would require git-merge-base reconstruction with the iteration's pre-rebase point, which we don't always have). Instead: **every iteration whose boundary is a `HeadRefForcePushedEvent`** carries a banner on the tab: *"This iteration includes a force-push; some changes may be upstream merges rather than author changes. Use the All changes tab if the per-iteration view is too noisy."* The banner fires unconditionally on force-push iterations — no diff-size heuristic. An earlier draft gated the banner on a "diff size > 2× the prior iteration's size" rule, which had bad failure modes (no banner on iteration 1 where reviewers most need it; false positives on small refactors followed by larger follow-ups; no banner on a force-push that pulled in a *small* mainline catch-up). The unconditional banner is louder than ideal but its failure mode is "the user dismisses it and moves on," which is recoverable; the heuristic's failure mode was "the user trusted the missing banner and reviewed mainline noise as if it were the author's change," which isn't. A precise diff-from-author's-prior-changes computation (via merge-base reconstruction) is a v2 refinement.
- **Historical SHA unavailability:** if a historical SHA returns 404/422 from GitHub (rare; happens after long GH garbage collection), the affected iteration tab shows a graceful "this iteration's commits are no longer available" message.

See [verification-notes § C2](./00-verification-notes.md#c2) for the original `synchronize` claim and why it was revised.

### Banner refresh on PR update

- Backend polls active PR every **30s** (configurable via `polling.activePrSeconds`).
- Polled endpoints: `pulls/{n}` (head SHA, mergeability), `pulls/{n}/comments` and `pulls/{n}/reviews` for *count* (each via `?per_page=1` + `Link`-header `rel="last"` page-number parse — GitHub does not expose a cheap count query, so this paginated probe is the canonical pattern). Diff is NOT refetched on every poll.
- If `head_sha` changed OR comment count changed: banner appears at top of PR view: *"PR updated — Iteration 4 available, 2 new comments — Reload."*
- The banner is the **only** signal of change. The diff under the user's cursor never mutates.
- Clicking Reload triggers full PR reload + draft reconciliation pass (see "Stale-draft reconciliation").
- **Reload does NOT update `lastViewedHeadSha` / `lastSeenCommentId`.** Those two fields are the user's "I have seen this PR up to here" mark — they're only the user's opinion to update, not the system's. Both fields are written exactly once per PR-detail open: at PR-detail mount the backend stamps the current `head_sha` and the highest comment ID into `state.json.reviewSessions[ref]`. Subsequent in-session reloads (banner click, manual refresh) do not advance the marks. This means a user who clicks Reload to see "what changed since I last looked" but doesn't re-mount the page (e.g., they Reload, glance at the diff, navigate away without scrolling) keeps their unread/unseen counts intact for the next visit. The "Mark all read" affordance in the inbox row exists for the explicit case where the user wants to advance the marks without opening the PR.

#### In-flight composer when the banner arrives

If the user has an open composer (inline comment, reply, or PR-level summary) with **unsaved content** when Reload is clicked:

1. Reload is **blocked** until the composer is resolved. A modal appears: *"You have unsaved comment text. Save as draft, discard, or cancel reload?"*
2. **Save as draft (default action, Enter):** the composer's content is saved against the current `(file_path, line_number, anchored_line_content)` at the **pre-reload** head SHA. After save, the reconciliation pass runs over this draft along with all others; if the line is gone in the new head, the draft becomes stale and the user reconciles it through the standard flow.
3. **Discard:** composer is closed, content discarded, reload proceeds.
4. **Cancel reload:** the banner stays up; the user finishes typing; clicks Reload again.

If the composer is open but **empty** (or whitespace-only), Reload proceeds without prompting and the empty composer is closed. The user's intent is captured by what they typed, not by an open composer with no content.

### AI seam usage (PoC: no-op)
- `<AiSummarySlot>` on the Overview tab (hero card) — `null` in PoC; v2 renders the AI-generated summary.
- `<AiFileFocusBadges>` in the Files-tab file tree — `null` in PoC.
- `<AiHunkAnnotation>` widgets — never inserted in PoC.
- `<AiChatDrawer>` — never mounted in PoC.
- The Overview-tab hero card and the file-tree focus column reserve space for these slots so v2 light-up does not cause significant re-layout. (See `04-ai-seam-architecture.md` § `<AiSummarySlot>` for the honest layout-reservation policy: PoC consumes 0px and v2 light-up is treated as a configuration change the user opts into, not a remote event.)

---

## 4. Comments

### Click-to-comment

- Click any line in the diff → comment composer opens, anchored to that line.
- Clicking another line while composer is open: prompt "Discard or save current comment?" before moving anchor.
- `Esc` cancels (with discard prompt if non-empty).
- `Cmd/Ctrl+Enter` saves the draft.

### Comment composer

- Markdown body with live-preview toggle. **Default**: live-preview is **off** in the inline comment composer (kept compact for line-level interaction). The submit dialog's PR-summary textarea always renders live-preview alongside the body (the dialog has the room and the summary benefits more from being seen as it's typed). The two surfaces' defaults are deliberately different — the inline composer is for quick line-level remarks, the dialog is for the holistic-opinion summary.
- Preview uses the same `react-markdown` + `remark-gfm` + Shiki + Mermaid pipeline as `.md` file rendering.
- Single-line anchor only (multi-line ranges deferred to v2).
- "Save draft" button (or `Cmd/Ctrl+Enter`).
- "Discard" button.
- **Auto-save on keystroke (debounced 250 ms).** Every composer (inline comment, reply, PR-summary textarea) auto-saves its body to `state.json` on a 250 ms keystroke debounce. This protects against `Cmd/Ctrl+R` interception failures on Firefox (`§ 9 keyboard shortcuts`) and other "page unloaded unexpectedly" cases. On reload, an in-flight composer with auto-saved content is restored at its anchor with the auto-saved body pre-filled; the user sees their text where they left it.
- **AI composer assistant slot** (`<AiComposerAssistant>`) — capability-flag-gated; in PoC the slot exists but the "Refine with AI ✨" button is hidden because `ai.composerAssist` is `false`.

### Reply composer

- Existing GitHub comment threads are rendered read-only inline.
- Each thread has a "Reply" button.
- Clicking Reply opens a composer with the same shape as a top-level comment composer; the anchor is the existing thread's GraphQL Node ID (`pullRequestReviewThreadId`, `PRRT_...`).
- Reply drafts are saved with the parent thread's ID; on submit, replies attach to the user's pending review via `addPullRequestReviewThreadReply` and finalize when the user clicks Submit. See [verification-notes § C1](./00-verification-notes.md#c1).

### Markdown rendering inside comments

- Comment bodies (drafts and existing) are rendered with `react-markdown` + `remark-gfm`.
- Code blocks render with Shiki using the same instance as the diff viewer.
- Mermaid blocks lazy-load and render via the language-dispatcher pattern.
- Raw HTML is **not** allowed. Sanitization is enforced via `react-markdown`'s default schema (no `rehype-raw` plugin); attempting to write `<script>` or other HTML tags renders them as escaped text rather than executing them.
- **Rendering-fidelity gap with github.com.** GitHub's renderer permits a broader HTML allowlist than `react-markdown`'s defaults — `<details>`/`<summary>` (collapsible sections), `<sub>`/`<sup>` (subscripts), `<kbd>` (keystrokes), `<br>` (line breaks), `<picture>`/`<source>` (responsive images), `<a name="...">` (anchors), `<img>` with attributes. PRism's strict no-HTML stance renders all of these as escaped text rather than rendered form. PRs that use them will look different here than on github.com. Acceptable PoC trade-off (security over fidelity); a future P4 item could add a sanitized allowlist matching GitHub's set if reviewers report missing it.
- **`react-markdown` version + `urlTransform` config.** Pin to `react-markdown` v9 or later. Older versions allowed `javascript:` URLs in autolinks; v9 strips them by default. Also set the `urlTransform` prop to a strict allowlist of `http`, `https`, and `mailto` schemes — the explicit allowlist defends against future default changes. Pin **all** `remark-*` and `rehype-*` plugins explicitly; v9 (Sept 2024) is recent enough that downstream plugin compatibility is uneven, and a transient sub-dependency upgrade can introduce a sanitization regression. CI runs `npm ci` against the lockfile rather than `npm install`.

### Existing comments edited or deleted out-of-band

The existing-comments list is refreshed each time the active PR is polled. When a remote change is detected (an existing comment's body changed on github.com, or a comment was deleted entirely):

- **Existing comment text changed.** The next reload picks up the new body. The comment renders with its current text, and the inline thread shows a small **"edited" badge** with the timestamp so the reviewer notices that the surrounding context has shifted (without needing a full diff-against-previous-version view, which is a v2 backlog item). The "Banner, not mutation" principle in `spec/01-vision-and-acceptance.md` covers diffs and drafts; for existing-comment text edits, the badge is the visible signal that something changed — informational, not a forced reload.
- **Existing comment deleted.** If a draft reply is anchored to that thread, the reply becomes stale: `status = stale`, reason "the thread you replied to has been deleted." Submit blocked until the user discards the reply or rewrites it as a top-level comment on the same line.
  - **Timing**: the staling transition is applied during the reconciliation pass that runs on **Reload**, *not* at poll-detection time. The poller detects the deletion and surfaces the standard banner ("PR updated — Reload"); the reply remains in `draft` status until the user clicks Reload. This preserves "banner-not-mutation" — the user's submit button does not unexpectedly disable from under their cursor while they are looking at the PR. After Reload, if the parent thread is gone, the reconciliation pass flips `status = stale` and the standard reconciliation UI handles it from there.
- **Reply targets resolved threads.** Resolving/unresolving threads is not a PoC feature; if a v2 user resolves a thread on github.com between polls, an in-progress draft reply still submits successfully (GraphQL allows replies on resolved threads); the resolved-state badge updates on the next reload.

### Draft persistence

- Each draft comment is stored in `state.json` under the matching review session.
- Drafts persist across application restarts.
- Drafts persist across PR reloads (with conflict reconciliation; see below).

---

## 5. Stale-draft reconciliation

### Trigger

When the user clicks Reload on the banner (after a new commit arrives), the reconciliation pass runs over every draft comment.

### Per-draft classification

For each draft comment with `(file_path, line_number, anchored_line_content, anchored_sha)`, the reconciliation algorithm runs in two steps. Step 1 resolves which file the draft now lives against; step 2 resolves which line.

**Step 1 — File-level resolution.**

1. If the draft's `file_path` exists at the new head SHA → continue to step 2 with the same path.
2. If the draft's `file_path` is absent at the new head but the diff reports a `renamed` status (with `from_path = file_path, to_path = X`) → continue to step 2 against `X`. The draft's `file_path` is updated to `X` silently. Renamed-only files do not invalidate drafts.
3. If the file is `deleted` (and not renamed) → mark `status = stale` with reason "file deleted." Submit blocked.

**Step 2 — Line resolution (within the resolved file).**

Fetch the file content at the new head SHA (cached per `(file, sha)` for the lifetime of the reload). Compute three candidate match sets against `anchored_line_content`:

- **Exact match at original line number** — byte-equal at the original `line_number`.
- **Exact match at any other line(s)** — byte-equal at one or more different line numbers.
- **Whitespace-equivalent match(es)** — byte-equal after normalizing whitespace runs and stripping CR/LF differences. (`if(x==null){` and `if (x == null) {` and `if (x == null) {\r` are all whitespace-equivalent.) **Conservative default: ambiguous file types are treated as whitespace-significant.** A maintained allow-list at `PRism.Core/Reconciliation/WhitespaceInsignificantExtensions.cs` enumerates the file types where whitespace-equivalent matching is safe (current contents: `.cs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.java`, `.rs`, `.rb`, `.cpp`, `.h`, `.html`, `.css`, `.json`, `.md`, `.txt`, `.sh`, `.sql`). Files outside the list — including `.py`, `.yml`, `.yaml`, `Makefile`, `*.mk`, `.sass`, `.haml`, `.coffee`, `.pug`, `.slim`, indent-sensitive XML, polyglot files with custom extensions, templating languages (`.j2`, `.tera`, `.liquid`), DSLs, files-with-no-extension — fall back to exact-match-only. The conservative posture matches "the reviewer's text is sacred": better to mark a draft Stale that the user re-anchors than to silently re-anchor to a wrong line in a whitespace-significant context. The earlier framing (deny-list of whitespace-significant types, allow whitespace-equivalence by default) had the wrong default.

Classify based on which candidates exist:

| Case | Classification | UI behavior |
|------|----------------|-------------|
| Exact match at original line, no others | **Fresh** | Silent re-anchor; update `anchored_sha`. No badge. |
| Exact match at original line + N others | **Fresh-but-ambiguous** | Re-anchor at original line. Persistent badge: "this line content appears N+1 times; original position kept." |
| Exact match elsewhere only (single match) | **Moved** | Re-anchor; update `line_number` and `anchored_sha`. Subtle badge: "moved to line M." |
| Multiple exact matches elsewhere, none at original | **Moved-ambiguous** | Re-anchor to the **closest line number to the original** `line_number`. Persistent badge: "ambiguous match — N candidates; re-anchored to closest." |
| No exact match, single whitespace-equivalent match | **Fresh** (treated as) | Silent re-anchor. Reason: auto-formatter ran or line endings flipped. No badge. |
| No exact match, multiple whitespace-equivalent matches | **Moved-ambiguous** | Same disambiguation as above (closest line number wins; persistent badge). |
| No exact or whitespace-equivalent match | **Stale** | `status = stale`. Submit blocked until reconciled. |
| **History-rewriting force-push, anchored SHA unreachable, multiple exact or whitespace-equivalent matches in new file** | **Stale** | `status = stale`. Submit blocked. The reviewer must re-anchor manually or discard — re-anchoring arbitrarily without the original line number as tie-breaker would risk landing the comment in the wrong context. |
| **History-rewriting force-push, anchored SHA unreachable, exactly one match in new file** | **Moved** | Re-anchor; persistent badge: "original commit was rewritten — re-anchored, please verify." |

**Notes.**
- Line-ending changes (CRLF ↔ LF) and trailing-whitespace flips on the anchored line are treated as whitespace-equivalent. The reviewer's intent doesn't change because line endings did.
- **History-rewriting force-push (anchored SHA becomes 404).** If the new head SHA is the result of a force-push that rewrote history such that the draft's `anchored_sha` is no longer in the PR's commit graph (`GET /repos/{o}/{r}/commits/{anchored_sha}` returns 404 or 422), the reconciliation pass cannot fetch the file content at the original SHA. In that case the algorithm falls back to **content-only matching against the new head** — it skips the "exact match at original line number" check (since the original line number is meaningful only relative to a reachable SHA) and proceeds with whole-file scan. The classification then depends on how many matches exist in the new file:
  - **Exactly one exact match** → `Moved` (single match; re-anchor; persistent badge: "draft's original commit was rewritten — re-anchored to line M, please verify").
  - **Multiple exact matches OR multiple whitespace-equivalent matches** → **`Stale`** (block submit). When the original line number is unreachable, there is no tie-breaker that the algorithm can defend with anything stronger than "this body appears somewhere." Re-anchoring arbitrarily would land the comment on a line the reviewer never reviewed in the new context — exactly the wrong outcome under "the reviewer's text is sacred." Block submit and force the user to either re-anchor manually or discard.
  - **No match anywhere** → `Stale` (block submit; same as the standard no-match case).
  
  The reconciliation panel surfaces a one-line note for any draft hitting this fallback: *"draft's original commit was rewritten — best-effort reanchoring; please verify."* The earlier wording classified multi-match as `Moved-ambiguous` (which does not block submit); that has been promoted to `Stale` because the soft badge was not enough to defend against landing comments on lines the reviewer had not seen in the new context.
- The "closest line number" rule is deliberate: in real code, the same line content (`}`, `});`, `return null;`, blank lines, single-line imports) appears many times, and the original `line_number` is the best signal we have for which instance the comment was about.
- Drafts classified as `Fresh-but-ambiguous` or `Moved-ambiguous` do **not** block submit. The badge persists so the reviewer can adjudicate manually if desired (open the composer; re-pick the anchor; save).
- Drafts classified as `Stale` block submit until the user takes one of the reconciliation actions described below.

The cases this section explicitly covers — multi-match, file rename via `renamed` status, whitespace-equivalent matches, line-ending changes, ambiguous matches — were added during a remediation pass in response to spec-review feedback. The historical record of *which* review flagged each case lives in `00-verification-notes.md` rather than in `spec-review.md` (the latter is a transient working file that is overwritten on each pass).

### Verdict re-confirmation

- **Trigger: `head_sha` change, applied client-side on Reload.** If `draftVerdict` is set and the PR receives a new iteration (any `head_sha` change), the `draftVerdictStatus` flip happens **as part of the reconciliation pass** that runs when the user clicks Reload — not at the moment the poller detects the new head. This preserves the "banner-not-mutation" principle: the verdict picker the user is looking at does not silently change state under their cursor. The banner ("PR updated — Reload") is the announcement; clicking Reload triggers stale-draft reclassification *and* the verdict re-confirm flip together.
- Other PR-state changes (someone resolving a thread, comment added, CI status flipping) do **not** trigger re-confirm; the user's verdict is about the *code state*, and only a new iteration changes that.
- Submit is blocked until the user re-confirms the verdict (single click).
- The user may change the verdict if they want — re-confirmation is just an intent check.

### Reconciliation UI

After reload, an "Unresolved" section appears at the top of the PR view summarizing:
- N drafts are stale and need attention
- M drafts moved automatically
- Verdict needs re-confirmation

For each stale draft, the UI offers:
- "Show me" — scrolls to the comment, shows its body and the original line content alongside the new code in the same area
- "Edit" — opens the composer; the user can rewrite or re-anchor manually
- "Delete" — discards the draft
- "Keep anyway" — moves draft from `stale` to `draft` status (user accepts it might land on the wrong line; rare but allowed)

**Submit button is disabled** while any drafts are `stale` or verdict is `needs-reconfirm`. Hover tooltip explains why.

**"Discard all stale drafts" header action.** The reconciliation panel header carries a secondary button: *"Discard all N stale drafts"* (visible only when N ≥ 1). Clicking it surfaces a confirmation modal listing the count and a sample of bodies (first three drafts' first lines), then hard-deletes every draft whose status is `stale` from this PR's session. **Both `draftComments` (new threads) and `draftReplies` are included** — replies can also become stale (per § 4 "Existing comments edited or deleted": a parent thread deleted on github.com flips the reply to `stale`), and the bulk-discard's purpose is "wipe all blockers in one click," which would be incomplete if it skipped replies. The modal's sample preview labels each entry as either `[thread on src/Foo.cs:42]` or `[reply on thread PRRT_…]` so the user knows which collections are about to clear. The use case: the reviewer has decided not to finish this review now and wants to submit just verdict + summary as a "Comment" verdict without per-draft adjudication. The principle "the reviewer's text is sacred" is satisfied because the user explicitly confirmed discard for the whole batch — silent batch-discard would violate it, but explicit-confirmation does not. After the bulk discard, if no other blocker remains, submit re-enables. Per-draft Edit / Discard / Keep-anyway actions remain available for users who want to adjudicate individually.

### AI seam usage (PoC: no-op)
- `IDraftReconciliationAssistant` is invoked per stale draft in v2, returning suggested actions ("this comment is now obsolete because the new code addresses it" / "this still applies, here's the new line"). PoC: no-op stub.
- The reconciliation UI has a slot per stale draft for AI assistance output; renders `null` in PoC.

### Drafts on a closed or merged PR

Polling detects when a PR's `state` flips to `closed` or `merged` (the `pulls/{n}` poll already returns this). Behavior when the user has unsubmitted drafts:

- **The PR view stays open in read-only mode.** The header gets a banner: *"This PR is now {closed | merged}. Submitting a review is no longer possible."* (GitHub rejects review submissions on merged PRs, and accepts but ignores them on closed PRs in most configurations — neither is useful.) **What "read-only" means precisely**: only **submit-related mutations are blocked** — the Submit Review button is disabled, the comment composer's Save Draft button is disabled (the composer can still be opened and the user can type into it for "copy out before discarding," but typing is not persisted to `state.json` and a banner inside the composer says *"PR closed — text not saved"*), and the keystroke-debounce auto-save is suppressed for this PR. Everything **read-only** continues to work: marking files viewed (the per-file "Viewed" checkbox; this is local-only state), switching iteration tabs and Compare picker, opening any file's diff, scrolling through inline comment threads, opening the rendered/diff toggle on `.md` files, navigating with `j`/`k`. The user can still poll-detect reopen via the banner; if the PR transitions back to `open`, the read-only mode lifts and submit re-enables.
- **Drafts are NOT auto-discarded.** They remain in `state.json`. Reasons: the user may want to copy text out before discarding; the PR may reopen; the user may not have noticed the close yet.
- **Submit button is disabled** with a tooltip: *"PR is {closed | merged}. Reviews can't be submitted. Discard drafts to clear, or copy them elsewhere first."*
- **A "Discard all drafts" button** appears next to the submit button when the PR is closed/merged. Clicking it prompts a confirmation modal listing the draft count, then clears all drafts (and `pendingReviewId`) for this PR from `state.json`.
- **Pending review on the GitHub side** (if `pendingReviewId` is set) becomes orphaned. GitHub does not document automatic cleanup of pending reviews on closed PRs; "eventually" is unbounded. The discard-all-drafts action **always succeeds locally** — drafts and `pendingReviewId` are cleared from `state.json` regardless of network state. The action *also* attempts `deletePullRequestReview` on the orphan as a courtesy cleanup; if that call fails (network error, GitHub down, the pending review no longer exists, GitHub returns 404), the failure is logged and a one-time toast is surfaced: *"Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR."* The local cleanup is never blocked on the remote call. This matches the user's intent ("wipe my local drafts, regardless of GitHub-side state"). If the user does *not* discard but the PR stays closed, `pendingReviewId` remains set in `state.json` so retry on re-open can adopt it (see below).
- **PR re-opens.** If the same PR transitions back to `open`, the banner disappears, the submit button re-enables, and drafts are re-reconciled against the current head SHA via the standard reconciliation pass. **If `pendingReviewId` is set**, the next submit attempt runs the foreign-pending-review prompt described in § 6 step 1 — the user sees the orphan's contents (threads + replies) and explicitly chooses Resume (foreign content is imported as drafts for review) or Discard (orphan deleted server-side) before any submit happens. The two paths use the same modal so behaviour is consistent regardless of how the orphan came to exist.

This makes it explicit that drafts are durable across external state changes: the reviewer's text is never silently dropped, even when the PR they were reviewing is no longer reviewable.

---

## 6. Submit flow

### Verdict picker

- Three options: Approve, Request changes, Comment.
- Default: none selected.
- Picker is in the header bar.

**Submit with no header-verdict selected.** When the user clicks Submit Review while no verdict is selected in the header, the submit confirmation dialog opens with the verdict picker **pre-selected to `Comment`** (mirroring github.com's default for "I'm leaving comments without an explicit verdict"). The user can change the picker inside the dialog before clicking Confirm Submit. The GraphQL `submitPullRequestReview` mutation requires an `event` (`APPROVE | REQUEST_CHANGES | COMMENT`); when the user submits the dialog with the pre-selected `Comment`, the pipeline passes `event: COMMENT`. There is no "submit with no event" path — the GraphQL `submit` step always finalizes with one of the three values, so the dialog's pre-select is the spec's contract for "user has content to post but never picked a verdict."

### PR-level summary

- A textarea **inside the Submit confirmation dialog** (not in the header). The user clicks Submit Review → dialog opens → textarea is the body of the GitHub review record (the part that GitHub displays at the top of the review). This keeps the PR view's header focused on navigation and verdict; the summary is composed at submit time when the user has formed their holistic opinion.
- Markdown supported. Live preview rendered alongside the textarea inside the dialog (same `react-markdown` pipeline as elsewhere) — the user sees the summary as they type, in the same dialog where they will hit Confirm.
- The dialog's confirmation panel does **not** show a separate "summary excerpt with Show all expander" — the textarea + live preview is the canvas; a redundant truncated excerpt below it would be noise. Earlier wording referencing a "first 3 lines or 240 chars excerpt with `Show full summary` expander" applied to a previous design where the textarea lived in the PR header and the dialog showed only a read-only excerpt; now that the textarea is in the dialog, the excerpt mechanic is dropped.
- Auto-saved to `state.json` as `draftSummaryMarkdown` on every keystroke (debounced 250 ms), so closing and reopening the dialog preserves the in-progress summary. Cleared from `state.json` when the review submits successfully.
- Same `<AiComposerAssistant>` slot pattern available here as in inline comments — the AI refinement feature works on the summary too.

### Submit Review button

- Disabled when **any** of the following:
  - **(a) No author contribution at all.** No verdict selected **AND** `DraftReview.NewThreads` is empty **AND** `DraftReview.Replies` is empty **AND** `DraftReview.SummaryMarkdown` is empty/whitespace. (A submit with no verdict, no drafts, and no summary text would post nothing meaningful — github.com 422s the same shape.) This is the right reading of the earlier ambiguous "empty body" rule.
  - **(b)** Any draft has `status = stale`.
  - **(c)** Verdict has `status = needs-reconfirm`.
  - **(d)** `IPreSubmitValidator` returns blocking errors (PoC: no-op stub returns no errors).
  - **(e) Comment verdict with no content of any kind.** Verdict = `Comment` **AND** `DraftReview.NewThreads` is empty **AND** `DraftReview.Replies` is empty **AND** `DraftReview.SummaryMarkdown` is empty/whitespace. The Comment verdict is the only verdict that doesn't carry inherent meaning of its own (Approve / Request changes do); a Comment review with no body, no inline threads, and no replies posts nothing the reader can act on, and github.com 422s it. Disable submit with the tooltip *"A comment review needs at least a summary or one inline thread."* Note this is **not** redundant with rule (a): rule (a) only fires when *no verdict* is selected; rule (e) catches the case where the user picked Comment but didn't write anything.
  - **(f) Banner-detected head_sha drift.** The most-recent active-PR poll observed a `head_sha` different from `lastViewedHeadSha` (i.e., the banner is up — "PR updated — Reload"). Submit is blocked with the tooltip *"Reload first — there are commits you haven't seen yet."* Clicking the disabled button (or the tooltip) focuses the banner. This rule defends against a footgun the reconciliation-on-Reload flow would otherwise leave open: a reviewer who set `draftVerdict = Approve` at head_sha A, sees the banner, and clicks Submit *without* clicking Reload would submit an Approve verdict against the *new* head_sha (the submit pipeline anchors `commitOID` at submit time, per § 6 step 1) — approving code they have not seen. Forcing the Reload restores the principle "verdict re-confirmation is required after any new commit."
- Empty-PR case (per § 3 "Empty PR"): verdict = Comment + non-empty `SummaryMarkdown` + empty `NewThreads`/`Replies` → none of (a)–(e) fires (verdict is set; summary is non-empty, so rules (a) and (e) are false) → button **enabled**. Replies-only reviews (verdict=Comment + non-empty `Replies` + empty `NewThreads` + any summary) → also enabled. Both are intentional.
- On click, opens a confirmation dialog:
  - Includes the **PR-level summary textarea + live preview** (see § 6 "PR-level summary") — the user composes the summary inside this dialog; the textarea is the canvas, not a read-only excerpt. Below the summary: count of new threads, count of replies, and the verdict picker (re-confirmable here if not already set in the header).
  - **Validator results section** (`IPreSubmitValidator` output) — empty in PoC
  - "Confirm Submit" / "Cancel"
- On Confirm, the submit pipeline runs the GraphQL pending-review sequence:
  1. **Create pending review** — `addPullRequestReview` with `event` omitted (so the review stays pending) and `commitOID = <current head_sha at submit time>` (captured from the most recent `GetPrAsync` result; this anchors the pending review's threads to the displayed line numbers). Body is `SummaryMarkdown ?? ""` — always pass an explicit string, never null/omit (consistency rule for the retry path's body comparison). Returns `pullRequestReviewId` (`PRR_...`). Stored in `state.json` as `pendingReviewId` and `commitOid` for idempotency.
  2. **Attach new threads** — for each new draft, `addPullRequestReviewThread` with `pullRequestReviewId` of the pending review.
  3. **Attach replies** — for each draft reply, `addPullRequestReviewThreadReply` with `pullRequestReviewId` of the pending review and `pullRequestReviewThreadId` of the parent thread.
  4. **Finalize** — `submitPullRequestReview` with `pullRequestReviewId` and `event: APPROVE | REQUEST_CHANGES | COMMENT`. The summary body is set on the pending review (step 1) and applied at submit time.
- On success of step 4: drafts cleared from `state.json`, `pendingReviewId` cleared, banner appears: "Review submitted. View on GitHub →"
- On failure mid-pipeline: drafts and `pendingReviewId` NOT cleared. The pending review on GitHub is invisible to others until step 4 succeeds. Retry resumes from where the previous attempt left off (see "Reviewer-atomic semantics" below).

### Pending-review submit semantics

- Multiple GraphQL mutations under the hood, **but reviewer-atomic from the user's perspective**: a pending review is invisible to anyone except its author until `submitPullRequestReview` runs. If the submit pipeline fails partway, no half-visible review exists on GitHub — only an invisible pending review the next retry resumes.
- **Idempotency on retry.** The pending review's ID (`pendingReviewId` in `state.json`) is the natural idempotency key. The adapter implements retry as a **resumable state machine**:
  1. **Detect existing pending review.** Query GitHub for any pending review owned by the current user on this PR (`viewer.pullRequestReviews(states: [PENDING])` filtered to the PR's `id`). Three outcomes:
     - **Match by ID.** `pendingReviewId` from `state.json` matches a server-side pending review → resume from step 3.
     - **Other pending review exists.** Server has a pending review the user owns on this PR but its ID does not match `pendingReviewId` (e.g., `pendingReviewId` is null because step 1 of the previous submit attempt died; or the user started a pending review on github.com long ago). **Always prompt the user before adopting** — adopting silently would risk submitting forgotten content. The submit dialog opens an "adopt-or-discard" sub-step:
       - Backend fetches the foreign pending review's ID + threads + replies (call this **Snapshot A**, with timestamp).
       - Modal shows: *"You have a pending review on this PR from {timestamp}. It contains {N} thread(s) and {M} reply(ies). Resume it (you'll see the contents before submit), discard it and start fresh, or cancel?"*
       - **TOCTOU defense (always re-fetch before acting).** Between the modal opening and the user's choice, the foreign pending review can change on github.com (the user opens the PR in a browser tab and submits / deletes / edits the pending review; another tool acts on it). GitHub's "one pending review per user per PR" constraint guarantees there's at most one at any moment, but it does not guarantee Snapshot A is still authoritative when the user clicks Resume or Discard. Before either branch acts, the backend **re-fetches the user's pending review on this PR** (call this **Snapshot B**) and compares its ID against Snapshot A's ID:
         - **Same ID** → proceed with the chosen branch as below.
         - **Different ID** (a new pending review was created) or **no pending review** (Snapshot A's was submitted or deleted on github.com) → abort the modal with a one-time toast: *"Your pending review state changed during the prompt. Please retry submit."* No server-side mutation runs; `pendingReviewId` is cleared if Snapshot B has nothing.
       - On **Resume** (TOCTOU check passed): each foreign thread is **imported as a draft** into `state.json.draftComments` (with its server-side `threadId` already stamped) and shown in the reconciliation panel for the user to keep / edit / discard before continuing the submit. Foreign threads that the user discards are removed via `deletePullRequestReviewThread` before step 5. The user explicitly approves the merged set before submission.
       - On **Discard** (TOCTOU check passed): the orphan pending review is deleted via `deletePullRequestReview` (using Snapshot B's ID, which equals Snapshot A's by the check); `pendingReviewId` is cleared; pipeline returns to "no pending review exists."
       - On **Cancel**: submit dialog closes; nothing changes server-side. No re-fetch needed.
     - **No pending review exists.** Run step 1 (`addPullRequestReview` with no event) to create one; persist the new ID; continue.

  This is also the resolution path used when a closed PR re-opens with a stale `pendingReviewId` (see § 5 "Drafts on a closed or merged PR" — the prompt is the same modal). The earlier draft of this section silently adopted foreign pending reviews with a toast; that has been replaced because silent adoption could submit threads the user had no memory of writing, which violates the "reviewer's text is sacred" principle in the wedge direction the user did not intend (surfacing forgotten text as new).
  2. *(handled in step 1.)*
  3. **Reconcile attached threads against drafts.** For each `DraftComment` (new thread) in `state.json`:
     - **If `draft.threadId` is already set** (it was successfully created on a prior attempt) → **verify** that thread still exists on the pending review (`pullRequestReviewThreadId` query). If it does, skip. If it doesn't (the user resolved/deleted it on github.com between attempts), recreate it and re-stamp `draft.threadId`.
     - **If `draft.threadId` is null** → before calling `addPullRequestReviewThread`, **first reconcile against threads that may have been created by a previous attempt whose response was lost**. The submitted body always carries an HTML-comment marker footer of the form `<!-- prism:client-id:<draft.id> -->` (see "Client-ID marker on submitted bodies" below). Query the pending review's existing threads (`pullRequest.reviews(states: PENDING).first(1).threads`); for each existing thread, parse the marker out of the returned body and match it against the unstamped draft's `id`. On match, adopt the server's thread ID into `draft.threadId` and skip the `addPullRequestReviewThread` call. Only call `addPullRequestReviewThread` for drafts whose marker is not present in any server-side thread; the response's thread ID is **stamped onto the draft** (`draft.threadId = <PRRT_...>`) and persisted to `state.json` immediately.

       This pre-reconciliation step closes the **lost-response window**: a previous attempt's `addPullRequestReviewThread` may have succeeded server-side but the response never reached us (network drop, OS sleep, process kill before the local persist). On retry we'd otherwise create a duplicate thread with identical content. The marker is the idempotency key — it survives any body normalization GitHub may apply (line-ending changes, Unicode NFC/NFD, trailing-whitespace stripping, HTML-entity normalization in code fences) because HTML comments pass through GitHub's markdown rendering durably in observed practice. Cost: every submitted body carries a ~60-character footer the user never sees in rendered form. The thread ID is the durable idempotency key going forward; the marker is used **only** for the one-shot adoption step on unstamped drafts.

       **Client-ID marker on submitted bodies.** Every `addPullRequestReviewThread` call submits `bodyMarkdown` as `<user body>\n\n<!-- prism:client-id:<draft.id> -->`. The marker is rendered as nothing in the GitHub UI (HTML comments are stripped at render time) but is preserved in the stored body that the GraphQL `body` field returns. The same convention applies to `addPullRequestReviewThreadReply` (with `<!-- prism:client-id:<reply.id> -->`). The drafts' `id` field (a server-generated UUIDv4 from `PUT /api/pr/{ref}/draft`) is already unique, so the marker disambiguates duplicate-content drafts on the same line cleanly without any content-equivalence comparison.

       **C7 empirical gate is narrow.** The remaining empirical question is *only* whether GitHub strips HTML comments specifically from `addPullRequestReviewThread` round-trips — testable in a single curl. If the test confirms HTML comments are preserved, the marker scheme stands as written and is the spec's default. If the test reveals GitHub strips HTML comments (unlikely but possible if GitHub adds a markdown sanitizer in front of body storage), fall back to client-side body normalization with a documented matcher (the option (a) path in C7) — but the default is the marker, not the normalization. See [verification-notes § C7](./00-verification-notes.md#c7) for the test sequence.
  4. **Reconcile replies against draft replies.** Same logic for `DraftReply`: each carries an optional `replyCommentId`. If set → verify the comment still exists on the parent thread; if not, repost. If null → call `addPullRequestReviewThreadReply` and stamp the response's comment ID onto the draft reply. **Foreign-author thread deletion mid-retry**: if `addPullRequestReviewThreadReply` returns 404/422 because the parent thread (`parentThreadId`) was deleted by its author between submit attempts, the reply is demoted to `status = stale, reason = "parent thread deleted"`. Submit blocks until the user resolves (discard the reply, or rewrite as a new top-level thread on the same line). This is the same recovery path as the user-action case in § 4 "Reply composer."

      **Dangling-reply edge case** (parent deleted *after* a successful reply submit). If a reply was successfully posted in a prior submit (its `replyCommentId` is stamped) and the parent thread is later deleted by its author, the reply persists on github.com as an orphan with a missing parent. The verify step above checks "does *the reply* still exist," not "does its parent still exist" — so the verify passes and the pipeline skips. The orphan reply remains on github.com with a dangling parent, which github.com may render with a "this comment refers to a deleted comment" indicator (varies by UI version). PRism does not actively detect this case during the submit retry. It is left as an acceptable edge — the user's content is preserved on GitHub, just without its conversational context. (A future P4 item could surface this on poll detection: "your reply on PR #123 lost its parent.")
  5. **Finalize.** Call `submitPullRequestReview`. On success, clear `pendingReviewId` and all draft state. **Empty-pipeline finalize**: when both `NewThreads` and `Replies` are empty (e.g., empty-PR case with verdict=Comment + summary only), steps 2 and 3 are skipped entirely; step 5 runs against the pending review with no attached threads. GraphQL accepts a Comment review with only a body. The retry path treats `NewThreads.Length == 0 && Replies.Length == 0` as a finalize-only case — no thread/reply reconciliation work, only the `submitPullRequestReview` call.

  **Stale `commitOID` on retry.** `addPullRequestReview` (step 1) anchors the pending review to a specific `commitOID`. If the PR's head moves between attempts (the author pushed during retry), the resumable retry detects mismatch by comparing the pending review's stored `commitOID` against the current `head_sha`. **Policy: discard, clear stamps, recreate.** When mismatched, the resumable pipeline:
  1. Calls `deletePullRequestReview` on the stale pending review.
  2. Clears `pendingReviewId` and `pendingReviewCommitOid` from `state.json`.
  3. **Clears `threadId` and `replyCommentId` stamps from every draft in this PR's session.** This step is essential — those stamps reference threads that lived on the deleted pending review and are no longer valid; without clearing them, retry's reconcile-against-pending-review step would treat them as "verify thread still exists," find the thread missing (it's gone with the deleted review), recreate, and leave the local stamps as dangling references.
  4. Re-runs from step 1 against the new head with all drafts in unstamped state.

  The user is expected to have already reconciled drafts against the new head as part of the standard reload flow before retrying; if they haven't (e.g., automatic retry triggered without a reload), the reconciliation pass runs in-pipeline as a prerequisite to the new step 1. The alternative — keeping the stale `commitOID` and threads — would land threads anchored to a historical commit that no longer matches displayed line numbers (silently wrong); explicit discard-clear-recreate is the safer trade.
- **Why this works.** Each `DraftComment` and `DraftReply` carries a server-issued, server-validated thread/comment ID once it has been posted at least once. The idempotency key is the ID itself, not a content hash. Three failure modes that broke an earlier content-equivalence design are now handled correctly:
  1. **User wrote the same comment text on two different lines.** Two distinct drafts, each with its own `threadId` after first post; no collision.
  2. **User resolved/deleted the thread on github.com between attempts.** The verify step in (3) catches it; the draft is reposted as a new thread.
  3. **Body got auto-formatted between save and post.** Doesn't matter — the thread ID is stable, content drift doesn't cause a duplicate.
- The pending review's ID is still the natural idempotency key for the *outer* state machine (does the pending review exist?); the per-draft thread/reply IDs are the keys for the inner content reconciliation.
- **One pending review per user per PR (GitHub constraint).** Adapter behavior is captured above as the "Other pending review exists" case in step 1. The user retains their work either way; the only observable consequence is the toast message.

See [verification-notes § C1](./00-verification-notes.md#c1) for the original "single REST call" claim and why the GraphQL pending-review pattern is the actual atomic-from-the-reviewer's-perspective shape.

### AI seam usage (PoC: no-op)
- `IPreSubmitValidator` runs in the submit dialog; in PoC, no AI validators are registered, only the deterministic stale-draft / verdict checks.

---

## 7. Markdown rendering for `.md` files

### Rendered view (default for `.md`, `.markdown`, `.mdx`)

When the user opens a markdown file in the file tree:
- The file's diff tab shows two view modes via a toggle:
  - **Rendered** (default) — split-pane: old rendered markdown on the left, new rendered markdown on the right
  - **Diff** — standard react-diff-view code-level diff
- The toggle is per-file; default is "Rendered." The user's choice **persists per-`(pr_ref, file_path)`** in `state.json.reviewSessions[ref].fileMarkdownViewMode[<file_path>] = "rendered" | "diff"`, so a reload returns to the user's last view choice for that file. Files the user has not toggled remain at the "Rendered" default. The persistence map is global per session and never grows beyond the file count of the PR.
- Both panes use `react-markdown` + `remark-gfm` + Shiki + Mermaid via the language-dispatcher pattern.
- Comments anchor to raw markdown lines (the diff tab is the canvas for commenting). Comment-on-rendered-prose is v2 backlog.

### Mermaid in rendered markdown

- Detected via fence language: ` ```mermaid `
- Mermaid v11 lazy-loaded via dynamic import (~2.5–3 MB; bundled inside the binary, not fetched from a network — PoC is offline-capable. The dynamic import defers parse/eval until first encountered). See [verification-notes § M21](./00-verification-notes.md#m21).
- On parse error: inline error block with the raw mermaid source visible (rendered through the same `react-markdown` + sanitization pipeline as the surrounding markdown, so a malformed Mermaid block containing `<script>` is escaped, not executed). Doesn't crash the rendered view.
- Theme: `default` (Mermaid's built-in light theme) for app light mode, `dark` for app dark mode. **API note (Mermaid v11):** the global theme is set via `mermaid.initialize({ theme })`; per-render execution is `mermaid.run({ querySelector: '.mermaid' })` (replacing the deprecated `mermaid.init`). On app-theme toggle, the implementation calls `mermaid.initialize` with the new theme **and** `mermaid.run` against existing `.mermaid` DOM nodes to re-render in place; without the `mermaid.run` call, already-rendered diagrams retain the old theme until the next mount. This v11 API surface is verified empirically against the Mermaid v11 changelog; if Mermaid v12 changes the API again, treat the `system`-theme + dynamic-toggle DoD criterion as an integration-test gate.
- Diagrams render at natural size with horizontal overflow scroll. Click-to-zoom is v2 backlog.

### Other code blocks in rendered markdown

- Routed to Shiki via the language dispatcher.
- Same Shiki instance used by the diff viewer and comment bodies.

### Backend API

- Markdown rendering needs full file content at base and head SHAs.
- Backend exposes `GET /api/pr/{ref}/file?path=<p>&sha=<s>` for this purpose.
- Two calls per markdown file (base and head). Cached per `(file, sha)` for the session.
- **Authorization.** The endpoint is gated by the per-launch session token (Origin check + token header for browsers; bearer for the chat MCP server). It returns *any* file content the user's GitHub PAT can read (the backend doesn't restrict by path beyond the session-token authentication). A malicious local browser tab with the session token could enumerate file paths via this endpoint — same blast radius as direct `state.json` reads on the same machine, which the threat model already accepts as out-of-scope. No additional path restrictions in PoC; the endpoint exists specifically to reach beyond the diff for markdown-rendering source.

---

## 8. Banner update model

### Active PR view banner
- Polls every 30s.
- Triggers: new commits (`head_sha` changed), new comments (`comment_count` changed), CI state change.
- Position: sticky just below the PR sub-tab strip (Overview / Files / Drafts).
- Contents: summary of changes ("1 new commit, 2 new comments") + "Reload" button.
- Dismissible (X button) without reloading.
- Only one banner at a time per PR view.
- **Reload does NOT advance `lastViewedHeadSha` / `lastSeenCommentId`.** The two marks are written only on PR-detail mount. Reload re-fetches the PR contents and re-runs draft reconciliation, but it leaves the unread/unseen accounting alone — that's the user's mark to advance, not the banner's. See § 3 "Banner refresh on PR update" for the rationale.

### Inbox banner
- Polls every 120s.
- Triggers: new PR in any section, new commit on any tracked PR, new comment count delta.
- Position: above the inbox sections.
- Same Reload-or-dismiss pattern.

### Implementation
- Single `IReviewEventBus` emits `PrUpdated`, `InboxUpdated`, `StateChanged`, `RepoAccessRequested` events from background pollers and state-mutating endpoints.
- Frontend subscribes via **Server-Sent Events** on `/api/events` (chosen over plain polling so the multi-tab consistency model can deliver `StateChanged` events within seconds across tabs; see `spec/02-architecture.md` § "Multi-tab consistency").
- Banner components subscribe to the relevant event type.

---

## 9. Keyboard shortcuts (minimal set)

| Shortcut | Context | Action |
|---|---|---|
| `j` | File tree | Move to next file |
| `k` | File tree | Move to previous file |
| `v` | File tree (file selected) | Toggle "Viewed" checkbox on the focused file |
| `n` | Diff | Move to next comment thread on current file |
| `p` | Diff | Move to previous comment thread on current file |
| `c` | Diff (line focused) | Open comment composer on focused line |
| `Esc` | Composer | Cancel/dismiss (with discard confirm if non-empty) |
| `Cmd/Ctrl + Enter` | Composer | Save draft |
| `Cmd/Ctrl + Enter` | Submit dialog | Confirm submit (when no composer is focused — see focus rule below) |
| `Cmd/Ctrl + R` / `F5` | Anywhere | Reload (overrides browser reload; dispatches to current view's reload action). Both keys are intercepted; browsers vary in which one their default-reload path uses. In Photino (P4-K12) the intercept is reliable; in browser-based PoC, Firefox occasionally preempts `Cmd/Ctrl+R` in ways `preventDefault` cannot block. **Consequence on preempt**: the browser does a full page reload, which loses the most-recent ≤250 ms of in-flight composer typing (the auto-save debounce window) — anything older than 250 ms is already on disk. This is an acknowledged Firefox-only limitation. Mitigation: an explicit "Save draft" action (`Cmd/Ctrl+Enter` in composers) flushes the debounce queue immediately; users on Firefox doing long-form composition should save explicitly before reloading. |
| `?` | Outside text-input contexts | Show keyboard shortcut cheatsheet overlay. **Focus-routing rule**: `?` is intercepted only when the focused element is *not* a `<textarea>`, `<input type="text">`, contenteditable element, or open composer body. Inside text-input contexts, `?` types a literal question mark — that's the desired behavior, not a workaround. To open the cheatsheet from inside a composer, use `Cmd/Ctrl + /` (next row) instead. |
| `Cmd/Ctrl + /` | Anywhere (including inside composers) | Show keyboard shortcut cheatsheet overlay. Works in *any* focus context — text inputs, composers, the PR view. This is the universal cheatsheet chord; `?` is the lighter shortcut for non-text contexts. |

Cheatsheet is a **non-modal overlay** — when it opens, any underlying composer keeps its content and DOM focus state intact, and closing the cheatsheet returns the user to exactly where they were. Closing the cheatsheet does **not** trigger the composer's discard-confirmation flow (that flow is for `Esc`-on-non-empty-composer; opening or closing the cheatsheet is not a "leaving the composer" event). Closing chords: `Esc` while the cheatsheet is open closes the cheatsheet *only* (the composer is untouched); `?` (when not focused in a text input) toggles it; `Cmd/Ctrl + /` toggles it from anywhere. Lists all shortcuts. **`Esc` precedence rule when both cheatsheet and a composer are open**: `Esc` closes the cheatsheet first; a subsequent `Esc` then handles the composer per its own dismiss rule. The earlier "composer wins, then cheatsheet" rule has been reversed because the cheatsheet is the more recently opened element and is the one the user just looked at.

**`Cmd/Ctrl+R` while only the cheatsheet is open**: the reload action runs as it would for the underlying view, *and* the cheatsheet stays open. The cheatsheet is a transient overlay; reloading the PR or inbox underneath it is the user's intent (the cheatsheet was opened to remind them how to reload). Closing the cheatsheet on reload would surprise the user. The same holds for `Cmd/Ctrl+Enter`: if the cheatsheet is open with no other focused interactive element, the keystroke is consumed by no handler (no composer, no submit dialog) — the cheatsheet does not interpret either shortcut.

**Focus-routing rule for `Cmd/Ctrl + Enter`.** When both a composer and the submit-confirmation dialog are open simultaneously (rare but possible, e.g., the PR-summary textarea acts as the composer for the summary while the dialog is the submit canvas), the shortcut routes to **whichever element has DOM focus**. The submit-confirm button is the dialog's default focus; clicking inside the textarea moves focus there; tabbing back to the Confirm button returns it. The user is never in a state where the shortcut does an action they did not intend, because the action is always tied to the focused element.

Vim-mode / chord shortcuts are explicitly v2.

---

## 10. Inbox / PR view: "Mark all viewed" and progress

Beyond the per-file Viewed checkbox:
- File tree shows total progress: "12 of 28 files viewed."
- No "mark all viewed" button (force the user to actually look). **Likely-pushback acknowledgment**: reviewers reviewing 50-file PRs will hit this on every PR; the friction is real and the principle ("force the user to actually look") is a soft one. If user testing reveals the no-button rule is annoying enough to drive users back to github.com, reverse it — add a "Mark all viewed" affordance behind a confirmation modal that says *"Mark all 28 files as viewed without opening them?"*. The principle is preserved (the user explicitly confirms they're skipping the look) and the friction drops to one click.

---

## 11. Settings (PoC: file-only)

No Settings UI in PoC. All preferences live in `config.json` and the user edits the file directly. Hot reload via `FileSystemWatcher` means changes apply on the next poll cycle.

**Editor save semantics.** Many editors (VS Code, vim with default settings, IntelliJ) save files via *rename-and-replace* — they write a temp file, then `rename(temp, final)`. `FileSystemWatcher` on macOS and Linux fires `Renamed` rather than `Changed` for this pattern, and on some file systems may miss the event entirely. The hot-reload implementation therefore subscribes to **both `Changed` and `Renamed`** events, debounces them by 250 ms (to coalesce rapid sequences), and on debounce-fire **re-reads `config.json` from disk** rather than acting on the event payload. This works across editors and file systems without per-editor special cases.

The README links to a documented config schema. Invalid config behavior depends on whether a last-good-config is in memory:

- **Invalid config, last-good-config available** (typical case — user edits the file in a running app): non-blocking toast: *"config.json invalid — last good config still active."* Logs detail the parse error.
- **Invalid config on cold load** (first run with hand-edited bad config; or a config file produced by a v2 binary the user downgraded from): no last-good-config exists in memory. Backend logs the parse error, falls back to **documented defaults** for every key, surfaces a different toast: *"config.json could not be parsed; defaults are in effect. Edit the file and save to retry — your changes will hot-reload."* The app continues startup; the user is not blocked.
- The "documented defaults" are the values shown in the schema example (`02-architecture.md` § Configuration schema): polling 30s/120s, deduplicated inbox, github provider, etc.

A "Replace token" link in the app footer goes to the Setup screen (re-prompting for a new PAT).

---

## 12. Error handling baseline

- Network errors during GitHub calls: in-app toast + retry button.
- 429 (rate limit): the wrapper reads the response's `X-RateLimit-Reset` header (epoch seconds when the rate-limit window resets) and pauses **all polling** for the affected resource (Search vs core REST track separately) until that time + small jitter (up to 30s). Toast surfaces: *"Polling paused until HH:MM (rate limit). Active operations will resume automatically."* If `X-RateLimit-Reset` is missing or malformed, fall back to exponential backoff capped at 5 min. Avoids the "retry every 5 min indefinitely against an exhausted limit" failure mode.
- 404 on a PR: "This PR no longer exists or your token doesn't cover this repo."
- **401 mid-composer:** if the user has an open composer (inline comment, reply, or PR-summary textarea) with non-empty content when a 401 lands from a polling fetch, the redirect to Setup is **suppressed**. Instead: the composer's contents are saved to `state.json` first (forced flush of the auto-save debounce), then a banner replaces the banner area: *"Token expired — reauthenticate to continue (your draft is saved)."* The banner has a single action that opens the Setup screen *as a modal overlay* rather than navigating away. After successful re-auth, the modal closes and the composer is restored intact. This preserves "the reviewer's text is sacred" through token-rotation events the same way the banner-arrival flow does.
- **401 anywhere else:** before redirecting, the wrapper calls `GET /user` to disambiguate. If `/user` succeeds → the token is valid but lacks scope for the requesting endpoint (token didn't include this org/repo); show a banner: "Your token doesn't cover this repo. Update token scope at github.com/settings/tokens." If `/user` returns 401 → the token is genuinely expired/revoked, **OR** it's a classic PAT without `read:user` scope (classic PATs without that scope return 401 from `/user` even when the token is otherwise valid). To distinguish the two, the wrapper makes a second probe: `GET /rate_limit` (works for any authenticated token regardless of scope). If `/rate_limit` succeeds → the token is valid; surface a banner: "Your token is missing `read:user` scope and the requesting endpoint scope. Generate a new token, or use a fine-grained PAT." If `/rate_limit` also returns 401 → the token is genuinely expired/revoked; navigate to Setup screen with token-expired banner. If `/user` returns 429 (rate limit on the disambiguation probe itself) → treat as "uncertain" and surface a soft toast ("Could not verify token state — try the failing action again in a minute") rather than redirecting; false redirects on rate-limit blips are more disruptive than the original 401.
- Unhandled exceptions: log + show "Something went wrong" toast with a "Copy diagnostics" button.

---

## 13. Accessibility baseline

Not a feature but a non-negotiable quality gate:

- Semantic HTML for landmarks (header, main, nav, etc.).
- All icon-only buttons have ARIA labels.
- File tree is keyboard-navigable (arrow keys, Enter to select).
- Focus rings visible on all interactive elements.
- Color contrast meets WCAG AA.
- Screen-reader-only labels for unread badges ("3 new commits").

This is a baseline requirement, not a feature. v2 may iterate further (full WCAG AAA, screen reader optimization).
