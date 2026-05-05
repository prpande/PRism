# Spec Review — PRism (PoC focus)

A fresh adversarial pass over `docs/spec/`, `docs/backlog/00-priority-methodology.md`, `docs/backlog/01-P0-foundations.md` (skimmed for cross-refs), and `docs/claude-design-prompt.md`. Per the README, this file is transient working notes and overwrites prior reviews; the prior pass's findings are absorbed into the spec proper as `00-verification-notes.md` entries or in-place edits.

Findings are pinned to file paths, line numbers (where stable), and quoted phrases so a maintainer can act without re-deriving what was seen. Per the user's instruction, the review focuses on the **PoC spec** (the work that ships first); v2 / backlog items are touched only where they leak into PoC obligations.

---

## 1. Executive summary

This corpus is competent, careful, and self-aware in ways that most planning documents are not. The verification-notes discipline (C1–C7, M19–M21) is the strongest artifact: it falsified concrete external-API claims before the spec built on them, and the empirical gates that survive (C5, C6, C7, C4) are sized to the right stage of work. The wedge framing has been honestly downgraded in line with what the spec can actually claim. The architectural seam discipline — DTO assemblies, marker-interface capability gating, the `IReviewContextFactory` lifetime model — is well-thought-through.

**The corpus's central problem is a strategic one, and the spec admits it.** A 5–8 month "PoC" is committed against a 1-of-3-strong-yeses external validation gate that fires *after* the spend. The lean alternative is rejected with reasoning that does not survive scrutiny (§ 2.1). The spec then admits in `Known risks` that the human-led-review trajectory may shorten inside that same window, and that the entire UI is shaped for a possibly-vanishing premise. These two admissions, together, mean the spec is performing two stances simultaneously: "we know the bet might be wrong" and "we're spending the full budget on the bet anyway." A maintainer revisiting in three months will resolve this by hitting the easier defaults — keep building — and the strategic uncertainty will quietly evaporate.

**The wedge itself is structurally weaker than the spec presents.** Each of the four headline differentiators is qualified inside the same document: stale-draft reconciliation is "not headline-marketable on its own," the atomic-submit pipeline is "the same pipeline github.com uses," iteration tabs are admitted to be at risk of being copied by GitHub, and AI seams produce nothing the user can use until v2. The remaining differentiator under stress-testing — iteration tabs — is gated by a pre-ship discipline check the spec itself built in (§ 6.4). If that check fails, the headline collapses to "per-commit tabs with a merge UI," which is not better than github.com's existing per-commit dropdown.

**The implementation-level issues are a smaller pile but include several real defects**: a verdict-re-confirmation bypass (§ 2.2), a foreign-pending-review race (§ 2.3), a `commitOID`/head-SHA race at submit time (§ 2.4), a verdict-event ambiguity for the "submit with no verdict" case (§ 2.5), the `draftVerdictAnchorSha` orphan field, an MCP architecture designed in PoC text for a v2-only surface (§ 5.3), and the `repoCloneMap` ownership serialization splitting two ways inside a single document. These are concrete enough to fix.

The corpus is roughly one focused editing pass and three architectural decisions short of being implementation-ready. The strategic uncertainty is unresolvable by editing.

---

## 2. Critical issues

### 2.1 The "5–8 month PoC" framing is the spec's most consequential bet, and the lean-PoC counter-argument doesn't hold

`spec/01-vision-and-acceptance.md:131-135`:

> "The PoC scope — full GitHub integration + GraphQL pending-review pipeline + 7-row stale-draft reconciliation + the AI seam scaffold (16+ Noop classes, ~25 placeholder DTOs, 9 frontend slots) + cross-platform self-contained binary + state migration framework + forensic event log + automated tests for submit/reconciliation/migration — is a **5–8 month commitment for one full-time senior developer** [...] **The PoC commits to the full scope.** A leaner alternative was considered (defer AI seams + migration framework + forensic log; ship in 6–8 weeks) and rejected: the seams pay back in v2 (no Core refactor when AI features ship), the reconciliation matrix is hard to retrofit later, and the polish items (migration framework, forensic log) compound the longer they sit."

This is a v0.5 product wearing a "PoC" label. The DoD checklist (`01-vision-and-acceptance.md:71-115`) lists **~30 substantive functional/architectural/cross-platform/test gates** that, taken together, describe a finished tool. The label is doing motivated work — calling this a "PoC" makes it seem like a low-risk learning artifact; the scope makes it the budget of a v1.0 launch.

The lean-alternative counter-arguments do not survive scrutiny:

1. **"The seams pay back in v2 (no Core refactor when AI features ship)"** — partially false. The same document (§ 2.6 below) admits that some placeholder DTOs in `PRism.AI.Contracts` will reshape per-feature (`ComposerSuggestion.Notes` already did, enums can't be additive, `ValidationResult.SuggestedAction` is reserved for reshape). The "no refactor" payback is partial.
2. **"The reconciliation matrix is hard to retrofit later"** — true *only* if you ship with the same 7-row design. A 3-row PoC (Fresh / Moved-best-effort / Stale) with real-user feedback driving expansion is a perfectly defensible alternative. The 7-row design may be over-engineering for cases the user never hits.
3. **"Polish items compound"** — true for incidental polish; false for the forensic event log + state migration framework. Both are pure additions you can ship in v0.2 without breaking v0.1.

The strategic risk the spec calls out at `01-vision-and-acceptance.md:168` ("the human-led-review trajectory may shorten") is precisely the risk the lean-PoC alternative hedges against. Spec admits the largest risk in line 168, then rejects the strongest hedge against it in line 135. This is the load-bearing inconsistency in the strategic framing.

A 1-of-3-strong-yes validation gate (`01-vision-and-acceptance.md:156`) is *also* a soft gate — the spec acknowledges it was softened from "≥2 of 3 strong-or-qualified" because that bar was "structurally near-unreachable." If the bar is near-unreachable for excellent products, then either (a) the bar should stand and the spec accept that most products won't clear it, or (b) the bar should be moved and the spec own that the gate is now lenient. Currently the spec performs (a) and uses (b).

**Direction:** Either accept the trajectory bet explicitly and own the cost in plain language ("we are spending 5–8 months on a UI shaped for a window we believe is at least 18 months wide; if the window is shorter, the surface is wrong and the work is wasted"), or take the lean-PoC hedge seriously and ship a stripped 6–8 week build before committing the rest. The current framing performs both stances.

### 2.2 Verdict re-confirmation can be bypassed: head SHA changes between banner and submit are not protected

`spec/03-poc-features.md:362`:

> "**Trigger: `head_sha` change, applied client-side on Reload.** If `draftVerdict` is set and the PR receives a new iteration (any `head_sha` change), the `draftVerdictStatus` flip happens **as part of the reconciliation pass** that runs when the user clicks Reload — not at the moment the poller detects the new head."

`spec/01-vision-and-acceptance.md:88` (DoD):

> "Verdict re-confirmation is required after any new commit."

These two are not aligned. The DoD says "after any new commit"; the implementation says "applied at Reload." A reviewer who has set `draftVerdict = Approve` at head_sha = A, sees the banner ("PR updated — Reload"), and then clicks **Submit Review without clicking Reload first**, will submit a "needs no re-confirm" verdict against the *new* head_sha = B (because the submit pipeline at `spec/03-poc-features.md:432` captures `commitOID = <current head_sha at submit time>` server-side). The user just approved code they have not seen.

Nothing in the submit flow forces a Reload before submit. The banner is dismissible. The composer auto-save is debounced — but the banner-arrived-but-not-reloaded state is not a blocker on submit.

This is the principle 3 ("banner, not mutation") inverted into a footgun: the reviewer's view is correctly preserved as A, but the submit lands on B. The principle that should defend against this is "verdict re-confirmation is required after any new commit" — the DoD wording — but the implementation only honors it on Reload.

**Direction:** Apply the verdict re-confirmation flip server-side at the moment the head_sha change is observed, OR enforce a forced Reload before submit if the active poll has detected a head_sha drift since the last Reload. The first approach violates banner-not-mutation (changes a UI control's state without explicit user action); the second is the safer choice. Add to § 6 Submit Review: "Submit is blocked when the banner-detected head_sha differs from the head_sha the user has reloaded against; the submit dialog redirects to the banner."

### 2.3 The submit pipeline's "foreign pending review" prompt has a TOCTOU race

`spec/03-poc-features.md:443-450`:

> "**Other pending review exists.** Server has a pending review the user owns on this PR but its ID does not match `pendingReviewId` (e.g., `pendingReviewId` is null because step 1 of the previous submit attempt died; or the user started a pending review on github.com long ago). **Always prompt the user before adopting** — adopting silently would risk submitting forgotten content. The submit dialog opens an 'adopt-or-discard' sub-step:
> - Backend fetches the foreign pending review's threads + replies.
> - Modal shows: *"You have a pending review on this PR from {timestamp}. ..."*"

Between the backend's fetch and the user's "Resume / Discard / Cancel" choice, the user (or another tool) can create a *new* pending review on github.com — for example, by opening the PR in a browser tab and clicking "Start a review." On Resume, the adapter would import the threads of the originally-fetched orphan, not the now-current orphan; on Discard, `deletePullRequestReview` may target the wrong ID. GitHub's "one pending review per user per PR" constraint guarantees there's only one at any moment, but it does not guarantee the spec's fetched view of "which one" is current at the moment the user clicks Resume.

The probability is low (the user has to interact with two UIs concurrently), but the failure mode is silent data clobber on a sacred surface ("the reviewer's text is sacred"). The spec does not acknowledge this race.

**Direction:** Re-fetch the foreign pending review's ID immediately before the Resume/Discard branch acts, and abort with a "your pending review state changed during the prompt — please restart" toast if the ID has drifted. Or document the race and accept it as a rare-and-recoverable edge case (the user can manually inspect github.com after submit).

### 2.4 The C7 lost-response adoption is "provisional" with no real default fallback

`spec/03-poc-features.md:461`:

> "Until C7 is resolved, the adoption matcher is **provisional**: implement it with byte-equality as written, but fence the lost-response retry path behind an integration test that simulates the round-trip and falls back to **'log + ask user to dedupe'** if the test reveals body drift."

`spec/00-verification-notes.md` § C7 enumerates three options: (a) client-side normalization, (b) `<!-- prism:client-id:<guid> -->` HTML-comment marker, (c) accept best-effort and document duplicate-thread risk. The decision is **deferred until "after the empirical test reveals what GitHub actually normalizes."**

This is a problem. "Log + ask user to dedupe" *is* the failure mode the adoption step exists to prevent. If C7 fails for any of the eight Unicode/whitespace cases the verification-notes lists, the spec ships with a known-broken retry path. Option (b) is the most robust, costs ~60 bytes per body footer, and is the best default — but the spec defers it pending an empirical test that has not been run.

The DoD line at `01-vision-and-acceptance.md:90` reads "retry from the same state converges on success without producing duplicate threads or replies on GitHub." That bar would force option (b) by default; the C7 deferral lets the implementer treat duplicate-on-retry as "convergence" if it eventually surfaces. The two cannot both be true.

**Direction:** Adopt option (b) by default in PoC. The body footer is small (60 chars), the marker is durable through GitHub's body normalization (HTML comments survive markdown rendering in observed practice), and the only risk is GitHub specifically stripping HTML comments — testable in a single curl. Update DoD and § 6 step 3 to require the marker; demote C7 from "decision pending" to "verify the marker survives, fall back to (a) if not."

### 2.5 The verdict picker's "submit with no verdict" path has no defined GraphQL event

`spec/03-poc-features.md:407` says verdict-picker "Default: none selected."

`spec/03-poc-features.md:421-426` (Submit Review button rule (a)):

> "Disabled when **(a) No author contribution at all.** No verdict selected **AND** `DraftReview.NewThreads` is empty **AND** `DraftReview.Replies` is empty **AND** `DraftReview.SummaryMarkdown` is empty/whitespace."

This is `AND`-joined, so the button is enabled if the user has any drafts/replies/summary even when no verdict is selected. The pipeline at line 435 then runs `submitPullRequestReview` with `event: APPROVE | REQUEST_CHANGES | COMMENT` — the GraphQL mutation **requires** an event; there is no "no event" option once you call `submit`. (The "no event" path keeps the review pending — see C1 — but submit is the finalize step that requires choosing one.)

What does the pipeline pass when no verdict is selected? The spec never says. Implicit options:
- Default to `COMMENT` (the lowest-friction GitHub equivalent of "I'm leaving comments without a verdict"). This is the safest default but has not been documented.
- Reject with a "verdict required" error at the dialog. Contradicts rule (a).
- Open the dialog with `COMMENT` pre-selected. Surfaces the implicit choice to the user.

This is concrete, frequent, and unspecified. Every reviewer using the tool to leave drive-by comments hits this path on day one.

**Direction:** Decide. The cleanest answer is to pre-select `COMMENT` in the submit confirmation dialog when no verdict is set in the header (mirroring github.com's "Comment" default), and document that the GraphQL `event` is `COMMENT` in this branch. Update rule (a) to reflect that the verdict effectively defaults to Comment for this branch.

### 2.6 The seam doc promises v2 won't reshape Core types, then says Core types may reshape

`spec/04-ai-seam-architecture.md:5`:

> "v2 lights up features by registering a different DI implementation and flipping a capability flag — **explicitly without reshaping existing Core types**."

`spec/04-ai-seam-architecture.md:233-238` (same document):

> "**The 'additive-only' promise — refined.** Earlier wording said 'v2 features may add fields (additive, non-breaking).' That promise turns out to be too strong: when a v2 implementer has actual prompt outputs to fit, **some placeholder records will need to reshape**. Concretely:
> - `ComposerSuggestion.Notes` was originally `string`; `ComposerNote[]` (with severity) is the shape the P2-1 implementation actually needs. **This is a reshape**, not an addition. [...]
> - Enum extensions (`AnnotationSeverity`, `NoteSeverity`, `ValidationSeverity`) cannot be additive — C# enums are not extensible. [...]
> - `ValidationResult.SuggestedAction` is `string?` for PoC clarity; v2 may want a structured `ValidationAction`. That reshape would break the PoC `Noop*` and would need a coordinated swap of the contract type + impl."

These two paragraphs are in direct contradiction in the same document. Moving the reshape into `PRism.AI.Contracts` does not change that the contract assembly is being modified ahead of the v2 feature; that is exactly what "reshaping Core types" means in this architecture.

The whole point of the "no reshape" promise is that the 2–3 weeks of seam scaffolding pays back in v2 (per § "A note on PoC effort"). If reshape is permitted per-feature, the scaffolding cost is unchanged but the *return* is "Core changes per feature, but localized to one assembly" — not the headline promise.

**Direction:** Pick one framing and apply it consistently. The honest version: rewrite line 5 to *"v2 lights up most features by registering a different DI implementation and flipping a capability flag; some features require additive or breaking changes to the placeholder DTOs in `PRism.AI.Contracts`, applied as a coordinated contract update ahead of the feature."* Kills the headline claim but matches what the rest of the document says.

### 2.7 `repoCloneMap.ownership` serializes two different ways inside the same document

`spec/02-architecture.md:154-161` shows the JSON serialization with kebab-case lowercase values:

> *"...are added to the same map with `ownership = 'prism-created'`. Schema: ... `'ownership': 'prism-created'` ..."*

`spec/02-architecture.md:504` (state-schema enum comment):

> `// "repoCloneMap": { ..., "ownership": "user" | "prism-created" }`

`spec/04-ai-seam-architecture.md:385`:

> "Persists the result in repoCloneMap with ownership = 'prism-created'."

`spec/04-ai-seam-architecture.md:420-422` (same document):

> `CloneOwnership Ownership);                       // "User" or "PRismCreated"`
> `public enum CloneOwnership { User, PRismCreated }`

`backlog/01-P0-foundations.md:116`:

> "`repoCloneMap` entry is added with `ownership = 'PRismCreated'`."

So the on-disk format is described as `"prism-created"` in three places and `"PRismCreated"` in three places, and `04-ai-seam-architecture.md` contradicts itself between line 385 and lines 420/422. Default `System.Text.Json` serialization of `CloneOwnership.PRismCreated` produces `"PRismCreated"`; producing `"prism-created"` requires an explicit `JsonStringEnumConverter` with kebab-case naming policy (a .NET 9+ feature). No serialization policy is documented anywhere.

This is a guaranteed round-trip bug the first time a state.json written by the wrong stack gets parsed by the right one.

**Direction:** Decide once. If kebab-case wins (consistent with `inbox.deduplicate`-style elsewhere in the JSON config), document the `JsonStringEnumConverter` policy in `02-architecture.md` § State schema, and update the four PascalCase occurrences. If PascalCase wins, update the six lowercase occurrences. Until this is resolved, the implementer reading any one document will produce a writer that is incompatible with another document's reader.

### 2.8 The AI summary slot is in three different positions across three documents

`spec/03-poc-features.md:142-151` lists `<AiSummarySlot>` as the **last bullet inside** the sticky `Header bar`:

> **1. Header bar (sticky)**
>   - PR title; Author + repo; Mergeability; CI status; Verdict picker; Submit Review button
>   - **AI summary slot** (`<AiSummarySlot>`) — capability-flag-gated; `null` in PoC

`spec/04-ai-seam-architecture.md:466-476` says the slot is **between** the sticky header and the sticky iteration tabs, and is **itself non-sticky**:

> "Position: in the PR header bar, between the title row and the iteration tabs.
> [...]
> **The slot is *not* sticky**: it scrolls away when the user scrolls past the header. [...]
> DOM order: `header (sticky) → AiSummarySlot (non-sticky) → iteration tabs (sticky) → diff body`."

`docs/claude-design-prompt.md` is internally self-contradictory: line 58 (the slot table) matches `04-ai-seam-architecture.md`; line 116 ("Right: verdict picker (3 options), Submit button, AI summary slot") matches `03-poc-features.md`'s "inside the sticky header" framing.

These layouts are not equivalent. "Inside the sticky header" means the slot moves with the header on scroll and reserves header-row space when shown. "Between sticky header and sticky iteration tabs, non-sticky" means the slot scrolls away under the iteration tabs as the user scrolls down. Different visual behavior; different layout-shift policy.

A designer reading `claude-design-prompt.md` will produce a layout that disagrees with itself. An implementer reading `03-poc-features.md` first will build something that disagrees with `04-ai-seam-architecture.md`'s sticky-stack reasoning.

**Direction:** Pick one. The seam-doc design (between header and tabs, non-sticky) has the better-reasoned rationale and survives scrutiny — adopt it. Update `03-poc-features.md` to remove the AI summary slot bullet from inside the Header bar list and place it as item 1.5 between Header bar and Iteration tabs. Fix line 116 of `claude-design-prompt.md`.

### 2.9 `draftVerdictAnchorSha` is in the schema, referenced nowhere

`spec/02-architecture.md:462`:

> ```jsonc
> "draftVerdict": "approve",
> "draftVerdictAnchorSha": "abc...",
> "draftVerdictStatus": "draft",
> ```

A grep across the corpus confirms `draftVerdictAnchorSha` appears in this single location and nowhere else. The verdict-re-confirmation logic at `spec/03-poc-features.md:362` reads only `head_sha`; it does not consult `draftVerdictAnchorSha`. The `GET /api/pr/{ref}/draft` payload at `02-architecture.md:316` does not return it. The `PUT /api/pr/{ref}/draft` patch shape at line 318 has no field for setting it.

So this is a state-schema field with no producer, no consumer, no description. Either it is vestigial (delete it), or it is intended for the "verdict was set against this SHA, so head changes that don't touch the verdict's anchor SHA shouldn't trigger reconfirm" optimization — in which case the spec needs a producer (PUT semantic), a consumer (re-confirm comparison), and GET inclusion.

**Direction:** Decide whether the field is real. If yes: add producer/consumer/GET inclusion. If no: delete the line.

---

## 3. Inconsistencies and contradictions

### 3.1 Reconciliation table has nine rows; DoD asserts seven branches

`spec/01-vision-and-acceptance.md:108`:

> "**Reconciliation algorithm** has tests for each of the **seven classification branches** in `03-poc-features.md` § 5: ... Plus the file-resolution edge cases: file renamed (via `renamed` status); file deleted; force-push history rewrite (anchor SHA unreachable → content-only fallback)."

The table at `spec/03-poc-features.md:334-345` has **nine** rows (the 7 enumerated + 2 force-push-anchor-unreachable rows that lead to distinct outcomes Stale vs. Moved). The DoD bullet collapses the force-push case into one — but the table requires separate test coverage for both outcomes.

**Direction:** Update DoD to nine cases; split "force-push history rewrite" into its two outcomes.

### 3.2 Section 5 ("CI failing on my PRs") contradicts itself on which checks count

`spec/03-poc-features.md:59-60` (section header):

> "**CI failing on my PRs** — PRs the user authored where **any required check is failing**."

`spec/03-poc-features.md:127`:

> "Section 5 [...] The CI-failing inclusion rule is: **'any failing check-run OR any error/failure status.'**"

"Any required check" implies branch-protection awareness ("required" by branch protection). "Any failing check" is the implementation rule. A PR with a failing optional style linter appears in section 5 under the implementation rule but should not under the prose rule. Branch-protection awareness is documented as a P4 item (P4-H3), so the implementation rule is correct.

**Direction:** Rewrite the section 5 prose: *"PRs the user authored where any check-run is failing or any commit status is error/failure. Branch-protection-aware filtering is a P4 item."*

### 3.3 The `aiState` schema enumeration in the state-schema section is incomplete vs. the rest of the spec

`spec/02-architecture.md:501-505` enumerates `aiState` keys (with v2-reserved comments). Three keys referenced elsewhere are missing here or scoped in the comments-only block:
- `repoCloneMap` (`02-architecture.md:154`, `04-ai-seam-architecture.md:354`) — present in line 504's comment list, OK
- `workspaceMtimeAtLastEnumeration` (`02-architecture.md:163`) — present, OK
- `cleanupCandidates` (`02-architecture.md:506`, `backlog/01-P0-foundations.md:122`) — present in 506, OK
- `chatSessions` (`02-architecture.md:507-516`) — present, OK
- `dismissedAnnotations` (`02-architecture.md:502`) — present, OK
- `alwaysAllowRepoAccess` (`02-architecture.md:503`) — present, OK

On a second reading the enumeration is actually complete — earlier review wording flagged the migration test for omitting some. The migration-test description at `02-architecture.md:546` lists *five* keys (`dismissedAnnotations`, `alwaysAllowRepoAccess`, `repoCloneMap`, `cleanupCandidates`, `chatSessions`) but does not list `workspaceMtimeAtLastEnumeration`, which P0-4 expects. The migration test as specified would not assert that key exists with a default.

**Direction:** Add `workspaceMtimeAtLastEnumeration` to the migration test's asserted-keys list, or drop the "all keys covered" promise and replace with "the listed keys cover the consumers added in P0; future v2 keys are added with their feature."

### 3.4 The "Replace token" UI affordance contradicts the "Settings: file-only" rule

`spec/03-poc-features.md:32`:

> "The Setup screen is also accessible from a 'Replace token' / 'Sign out' action in app settings (file-only in PoC, so this happens via direct config edit and an in-UI link)."

`spec/03-poc-features.md:577-589` (Settings section):

> "## 11. Settings (PoC: file-only)
> No Settings UI in PoC. ... A 'Replace token' link in the app footer goes to the Setup screen (re-prompting for a new PAT)."

Line 32 says the action happens via *direct config edit* (which is meaningless for a token in the OS keychain) **and** an in-UI link. Line 589 confirms the in-UI footer link. The "via direct config edit" part is wrong: the token is in the OS keychain, not in `config.json`, so a config edit does not replace the token.

**Direction:** Rewrite line 32: *"The Setup screen is also accessible from a 'Replace token' link in the app footer (the only Settings affordance in PoC; everything else is file-only)."*

### 3.5 The "no Octokit in `PRism.Web`" DoD vs. the binary that ships

`spec/01-vision-and-acceptance.md:94`:

> "`using Octokit;` is contained to `PRism.GitHub` (the only project that needs it). `PRism.Core` and `PRism.Web` do not import Octokit."

This is enforceable only at the source level. `PRism.Web` references `PRism.GitHub` for DI registration (`Program.cs` calls `services.AddSingleton<IReviewService, GitHubReviewService>()`) — which means the Octokit assembly is in `PRism.Web`'s `bin/` at publish time. A reader expecting "no Octokit DLL in the published binary" will be surprised. The dependency-hygiene rule is real and useful, but the wording undersells what it actually buys.

**Direction:** Tighten the DoD: *"`using Octokit;` does not appear in any source file under `PRism.Core` or `PRism.Web`. Octokit is referenced transitively at the binary level via DI registration; this is a source-level dependency-hygiene rule, not a binary one."*

### 3.6 First-iteration diff range is undefined

`spec/03-poc-features.md:204-205`:

> "Iteration N tab → `iter_N-1_head..iter_N_head` (just what changed in that round)."

For N=1, this is `iter_0_head..iter_1_head`. The spec never defines `iter_0_head`. Inferable as "the PR's merge-base against its target branch" — but the DoD criterion (`01-vision-and-acceptance.md:79`) doesn't carve out the N=1 case either.

**Direction:** Add: *"Iteration 1's `before` SHA is the PR's merge-base against its target branch; subsequent iterations chain from the prior iteration's `after` SHA."*

### 3.7 `claude-design-prompt.md` carries v2 design constraints inside a PoC design ask

The prompt at `claude-design-prompt.md:71-78` describes the iteration tab strip as "All changes" + "up to 3 iteration tabs inline" + dropdown + Compare picker. Matches the spec. But the prompt also asks for design of the chat drawer (`<AiChatDrawer>` at lines 61-62) and the Repo-access modal (line 62), both of which are explicitly v2 only. PoC ships nothing visual for these. A designer asked to design them in PoC will produce mockups for components the PoC code will not render.

This is fine if the designer understands "design now, ship in v2" — the prompt's "Notes for the human" section at lines 11-15 partially covers this. But the slot table at lines 56-67 mixes PoC-visible chrome (file row, file tree) with v2-only chrome (chat drawer, repo-access modal) without flagging which is which. The designer will spend time designing what doesn't ship.

**Direction:** Annotate the slot table: which surfaces ship in PoC, which are v2-only. The PoC slots are placeholders that render `null`; the v2 surfaces are full components. The design effort should be weighted accordingly.

---

## 4. Missing decisions and under-specified areas

### 4.1 What does the submit pipeline pass as `event` when the verdict is unset?

Already covered in § 2.5 above. The implementation rule for the disabled-button gate is `AND`-joined (verdict OR drafts OR replies OR summary suffices); the GraphQL `submitPullRequestReview` requires an event. The default is unstated.

### 4.2 What happens to draft *replies* when the user clicks "Discard all stale drafts"?

`spec/03-poc-features.md:382` describes the bulk-discard:

> "**'Discard all stale drafts' header action.** [...] Clicking it surfaces a confirmation modal listing the count and a sample of bodies (first three drafts' first lines), then hard-deletes every draft whose status is `stale` from this PR's session."

Draft replies have their own `stale` status (per `03-poc-features.md:297`, "the thread you replied to has been deleted"). The bulk-discard action's name says "drafts." Replies are technically drafts. Implicit: yes, replies are included. But the modal sample shows "drafts' first lines" which is ambiguous about reply bodies.

**Direction:** Clarify: bulk-discard applies to both `draftComments` and `draftReplies` with `status = stale`; the modal listing shows the union with a small label distinguishing thread-drafts from replies.

### 4.3 What does "PR view stays open in read-only mode" actually mean?

`spec/03-poc-features.md:391-396` describes behavior when a PR closes/merges mid-review. It promises the PR view "stays open in read-only mode" but never defines "read-only." Specifically:
- Can the user still mark files viewed? (View state mutation; not draft mutation.)
- Can they switch iteration tabs?
- Can they open the diff for a file?
- Can they scroll-into-existing-comment-threads (read-only is fine, but is the inline composer disabled?)

The DoD has no test for any of these.

**Direction:** Specify which mutations are blocked vs. allowed. Recommended: only the submit-related mutations are blocked (Submit Review button + composer save buttons); all read-only navigation continues to work.

### 4.4 Cancel during the chat-bootstrap clone

`backlog/03-P2-extended-ai.md:91` (skimmed; this is v2 but documented in PoC spec via `IRepoCloneService` placeholder DTOs) shows a "Cancel" button during the clone progress UI. What does Cancel do?
- Kill the `git clone` process and `rm -rf` the partial directory.
- Let the clone finish in the background (as a "courtesy clone for next time") and dispose the chat bootstrap.
- Block until next safe checkpoint.

PoC ships no chat, but the design choice is reflected in `IRepoCloneService` as `EnsureCloneAsync` returning a discriminated-union `CloneResult`. Cancellation token semantics are unstated.

**Direction:** Pick one. Default: kill+rm. The spec could state this in `IRepoCloneService`'s contract: *"Cancellation kills the in-flight git process and removes the partial clone directory."*

### 4.5 Empty-body draft handling for the lost-response adoption matcher

`spec/03-poc-features.md:457` describes the adoption matcher as comparing on `(filePath, originalLine, originalStartLine, body)`. If two drafts on the same line have empty bodies (the `PUT /api/pr/{ref}/draft` shape doesn't validate non-empty), the matcher cannot disambiguate them. The submit pipeline has no rule for empty-body drafts.

**Direction:** Reject empty-body drafts at the endpoint. Add to `02-architecture.md` § Draft endpoint semantics: *"Empty `bodyMarkdown` (after trim) is rejected with 400."* Validation at the boundary is also a defense against accidental "Save draft" clicks on an empty composer.

### 4.6 Reply-staling timing — banner-not-mutation says one thing; the prose says another

`spec/03-poc-features.md:296-297`:

> "**Existing comment deleted.** If a draft reply is anchored to that thread, the reply becomes stale: `status = stale`, reason 'the thread you replied to has been deleted.' Submit blocked until the user discards the reply or rewrites it as a top-level comment on the same line."

When does this transition happen? Polling at 30s, banner appears. Per principle 3 (banner, not mutation), the user's draft state should not silently change between Reload clicks. The prose ("becomes stale") is neutral about timing. If staling fires at poll-detection time, a user who hasn't reloaded clicks Submit and is unexpectedly blocked.

**Direction:** Tie the staling to Reload, not to poll-detection. Add: *"Reply-staling on parent-thread deletion is applied during the reconciliation pass on Reload, not at poll-detection time."*

### 4.7 The `Compare ⇄` picker's edge cases

`spec/03-poc-features.md:207`: *"'Compare ⇄' picker: choose any two iterations from a dropdown; the diff updates to `iter_X_head..iter_Y_head`."*

Three unspecified cases:
- User picks the same iteration on both sides — diff is empty by definition.
- User picks Y < X — diff shows reverse changes (additions become deletions).
- User picks "All changes" on one side and an iteration on the other — undefined.

**Direction:** Lock the picker to "X < Y," show "no changes" for same-iteration, forbid "All changes" mixed with iterations.

### 4.8 The `?` shortcut UX trap with non-empty composers

`spec/03-poc-features.md:557` says `?` types literal in a composer; to open the cheatsheet from a composer, press `Esc` first. Line 263 says `Esc` cancels with a discard prompt if the composer is non-empty. The two combine to a real trap: the user wants to remind themselves of a shortcut and is forced through a discard-confirmation modal.

**Direction:** Treat the cheatsheet open as orthogonal to composer focus. The cheatsheet appears as a non-modal overlay; the composer keeps its content; subsequent `?` or `Esc` closes the cheatsheet without affecting the composer. Document a `Cmd/Ctrl+/` chord as the composer-friendly cheatsheet open.

### 4.9 Cleanup audit triggers and cadence

`spec/02-architecture.md:178`:

> "**Cleanup audit.** Triggered when total PRism disk usage exceeds 5 GB or via a 'Clean up disk usage' button in Settings."

When does the threshold check fire? On startup? After every chat-session-end? Periodically? The "Settings" path is unbuildable in PoC (Settings is file-only per § 11). So the audit can only fire automatically — and PoC doesn't even create clones (chat is v2). The audit machinery exists in PoC architecture but PoC never exercises it.

**Direction:** Document the trigger: "audit runs on startup if disk usage exceeds threshold, plus after explicit user action via the v2 Settings UI." Acknowledge that PoC does not exercise the audit because PoC does not create clones; the architecture is reserved for v2.

### 4.10 What happens at first launch with zero PR activity?

The first-run flow is Setup → optional workspace picker → Inbox. The Inbox polls and shows five sections. If all are empty (a brand-new GitHub user, or a fresh PAT with no review activity), the user sees "Nothing here right now" five times and possibly a hidden-PRs footer. There's no onboarding, no sample PR, no highlighted "paste a URL to get started." The first-time experience for a user with no review activity is empty.

Not a bug, but worth a one-line decision.

**Direction:** Either add a one-line empty-state hint at the top of the inbox when *all* sections are empty ("Try pasting a PR URL above to get started, or wait for a review request"), or accept the empty default explicitly.

### 4.11 The `installSalt` migration scenario for a wiped state.json

`spec/02-architecture.md:499`:

> "`installSalt`: lazily generated when v2 first writes to `aiState.alwaysAllowRepoAccess`; PoC ships `null`."

What happens if a v2 binary launches against a state.json produced by PoC where `installSalt` is null, and the user grants "Always allow"? The migration generates the salt on first write — fine. But what about a user who ran v2 once (generated a salt), then deleted state.json (or restored from backup)? The new salt is different. Any `alwaysAllowRepoAccess` entries still in the *backed-up* state.json with the old salt would silently fail to match.

The spec rejects "eager generation in PoC" with reasoning that v2 may want to change the format (e.g., per-account salts). But once v2 ships, the format is locked anyway — the rationale is hollow unless v2 actually plans to change it (which the spec hints at). The migration story for users who already have a salt is undocumented.

**Direction:** Either commit to the salt format in PoC and document it, or document the v2 salt-rotation/migration plan when the format changes.

### 4.12 PR view's `Cmd/Ctrl+R` behavior on Firefox is "acknowledged limitation"

`spec/03-poc-features.md:556`:

> "...Firefox occasionally preempts `Cmd/Ctrl+R` in ways `preventDefault` cannot block — this is an acknowledged limitation rather than a promised perfect interception."

The acknowledgment is honest, but the consequence is unstated: when Firefox preempts the key, the browser does a full page reload, which discards the React app's state. In-flight composers are auto-saved at 250ms debounce — but the most-recent 250ms of typing is lost. The forensic event log doesn't help here (it logs only on explicit save). For Firefox users, the reload key is a recurring 250ms-data-loss path.

**Direction:** Document this in the user-facing copy somewhere (the cheatsheet?) or test with Firefox specifically and either fix the intercept or warn the user against using Firefox.

---

## 5. Architectural concerns

### 5.1 The MCP architecture is built into the PoC text for a feature PoC does not ship

`spec/02-architecture.md:227-228` shows `/api/mcp` and `/api/pr/{ref}/chat` as endpoints in the data flow diagram (marked "v2"). The cross-origin defense section at lines 633-651 designs the MCP auth pipeline in detail — bearer token, Origin-equals-self-or-absent rule, file ACL hardening on POSIX 0600 + Windows ACL, cross-rejection between bearer and cookie auth pipelines. None of this code ships in PoC.

The "two parallel auth surfaces (browser vs. MCP)" section is well-designed but is in the *PoC architecture document*. A PoC implementer reading 02-architecture.md will spend cognitive load on a v2 surface; a PoC reviewer evaluating "is the PoC implementable from these docs?" will count this as PoC complexity that is then absent from the DoD.

The MCP modal-storm rate limit (`04-ai-seam-architecture.md:538`, "max 3 invocations per minute, max 10 per session lifetime") is policy text without an enforcement story or an interface in PoC — v2 will need to invent the gating.

**Direction:** Move the MCP auth design into `04-ai-seam-architecture.md` (where the rest of the chat design lives). Leave a one-paragraph stub in `02-architecture.md`'s cross-origin defense section saying "v2 chat adds an MCP-only auth pipeline; design is in `04-ai-seam-architecture.md` § Claude Code integration." The architecture doc is then a PoC document; the v2 surfaces live in the seam doc.

### 5.2 Single-account / single-host is the wedge audience's most likely friction point

`spec/02-architecture.md:122`:

> "**One host per launch.** Multi-host (a single instance talking to both github.com and a GHES instance simultaneously, or to multiple GHES instances) is not supported in PoC. Users with both a personal github.com account and a corporate GHES account can run two instances of PRism with different `<dataDir>` values, or restart the app to switch hosts."

The wedge audience — engineers heavy enough on review to leave github.com — is heavily represented in the multi-account population: personal github.com + work GHES, work github.com cloud + work GHES, contractor scenarios, OSS maintainer scenarios. The spec's recommendation is "run two instances against two data directories" — which means two binaries, two ports, two browser tabs polling 30s × N PRs each, two keychain entries, two banner streams, two inbox panels, no cross-PR navigation. Practically, this is friction-equivalent to "use two different tools."

Multi-host is a P4 backlog item, but its absence from PoC bites the wedge audience disproportionately. The validation gate's "≥1 of 3 strong yes" is harder to clear when 2 of 3 reviewers have multi-account workflows and one of them defaults to "I went back to GitHub.com" because they cannot consolidate.

**Direction:** Either move multi-account support out of P4 (it is not a polish item; it is a foundational scope-of-the-tool item for the audience), or explicitly carve out the validation-gate test population to "single-account-only reviewers" so the experiment isn't running against an unfair audience.

### 5.3 `IReviewService` is intentionally un-cached, multiplying caching surfaces

`spec/04-ai-seam-architecture.md:53-59` justifies the un-cached design as "pushing into IReviewService would impose chat's strategy on every other consumer." True. But the consequence is that *every* consumer with caching needs becomes a re-implementation site:
- Inbox poller: per-section in-memory cache (`02-architecture.md:116`).
- Active-PR poller: rate-limit-accounting per-PR (`03-poc-features.md:121-128`).
- Awaiting-author section: `(pr_ref, head_sha) → user_last_review_sha` cache.
- CI-failing section: per-PR check-runs cache.
- Chat (v2): per-`(prRef, head_sha)` cache (`04-ai-seam-architecture.md:54-58`).
- Markdown rendering endpoint: per-`(file, sha)` (`03-poc-features.md:515`).
- Reconciliation pass: per-`(file, sha)` for the reload (`03-poc-features.md:326`).

Seven caches in the PoC alone, with different invalidation rules and lifetimes. The seam doc's argument that one decorator strategy can't fit all is right; the unstated counter is that *no* decorator strategy means each consumer reinvents the cache. The middle-ground option (HTTP-client-level cache underneath all of them, with cache-control configurable per-call) isn't considered.

This isn't a bug; it's a deferred design decision that will accrete subtly-different cache implementations. When a v2 maintainer asks "why does my reload show stale comments for 30 seconds," the answer will be "because cache layer X invalidates on event Y but layer Z doesn't subscribe to that event." The spec doesn't acknowledge this trajectory.

**Direction:** Either document the caching strategy by consumer in a single table (so a maintainer can see all seven and reason about consistency), or revisit the un-cached `IReviewService` decision with HTTP-client-level caching as a third option.

### 5.4 `IStreamingLlmProvider` is shaped for Claude Code; the multi-substrate promise is undermined

`spec/01-vision-and-acceptance.md:170` (Known risks):

> "`StreamingSessionOptions` carries `AddDirs`, `AllowedTools`, `DisallowedTools`, `ResumeSessionId`, `McpConfigPath` — these are Claude-Code-specific concepts. An `AnthropicApiLlmProvider` or `OllamaLlmProvider` would either ignore most of them (interface lies about the contract) or implement awkward shims."

The spec is honest about this. But the consequence is that the substrate-neutral `ILlmProvider` abstraction is structurally Claude Code's interface with extra opts that other providers ignore. Mitigation is "reactive (CI compatibility test suite)." That's not mitigation — it's a flag that detects breakage. The interface is shaped for the immediate need; the multi-substrate promise (P4-N4 Ollama) is structurally compromised at the interface level.

The seam-doc's `IAiFeatureFlags.IsEnabled` clause 3 ("LLM substrate availability probe") is provider-agnostic in description but in practice all the v2 features lean on Claude-Code-specific flags. The first AnthropicApiLlmProvider implementer will discover that `--add-dir` has no analog and that `request_repo_access` is meaningless without MCP, and that the substrate-neutral promise was about interface shape, not feature parity.

**Direction:** Either commit to Claude Code as the only substrate (drop the substrate-neutral framing; rename the interfaces `IClaudeCodeLlmProvider`), or commit to multi-substrate and refactor `StreamingSessionOptions` into a discriminated-union of substrate-specific opts. Currently the spec promises substrate-neutrality and ships substrate-specificity.

### 5.5 The forensic event log is a privacy surface broader than `state.json`

`spec/02-architecture.md:577-608` documents the append-only event log at `<dataDir>/state-events.jsonl`. `DraftSaved` events carry full body markdown (`02-architecture.md:600-605` clarifies the events fire on explicit save, not every keystroke — so the log is the body-at-explicit-save). Retention is 30 files × 10 MB = ~300 MB.

This is a **larger PII surface than state.json itself**. state.json carries only the current draft body; the event log carries every draft body across multiple weeks at typical use, including drafts the user discarded. A user who reviews sensitive PRs and then deletes their drafts believes the drafts are gone; the event log retains them.

The spec acknowledges privacy in the line "No PII concerns beyond what `state.json` itself holds." This understates: the log holds *historical* drafts state.json has already discarded.

The opt-out is documented (`logging.stateEvents: false`), and the trade-off is surfaced in the first-run setup. But the default is "on" with the rationale "the reviewer's text is sacred" applied to *recovery*. A user who values "deleted = deleted" is the worse trade.

**Direction:** Either default to off (with a one-time prompt at first-run asking the user to opt in for "we can recover your draft if you accidentally discard it"), or scope the log to operations-without-bodies and put body recovery behind an explicit opt-in. The current default is overly aggressive for a tool that markets local-first privacy as a principle.

### 5.6 The single-mutex-around-state.json blocks all writers during a multi-second submit

`spec/02-architecture.md:374`:

> "**Single backend mutex** around writes to state.json. Each write is one transaction..."

The submit pipeline at `03-poc-features.md:432-436` runs a multi-step GraphQL sequence (addPullRequestReview + addPullRequestReviewThread × N + addPullRequestReviewThreadReply × M + submitPullRequestReview). Each of these is a network call, potentially a few seconds. If the submit pipeline is treated as a transaction that holds the mutex across calls, every other tab is blocked from saving drafts during a submit. If it's split across mutex-acquire/release boundaries (which it must be — the local persist of `pendingReviewId` happens after addPullRequestReview returns), the single-mutex promise weakens.

The spec doesn't say which. The line "Each write is one transaction" implies the latter, but the boundaries (which writes are atomic-with-each-other) are not enumerated for the submit pipeline.

**Direction:** Document mutex acquisition/release granularity for the submit pipeline. Recommended: each external GitHub call's local-persist is a separate mutex-protected write; the pipeline is not a single transaction.

### 5.7 The chat-session "head shifted" system-message injection is clever but fragile

`spec/04-ai-seam-architecture.md:63`:

> "When the chat detects a `head_sha` shift between turns, **the next user turn's prompt is prefixed with a system-message-style note**: '[Note: the PR's head moved at turn N. Code referenced in earlier turns may not match the current state...]'"

This is a v2 concern, but the design is committed in PoC text. Two issues:
- The model's behavior on this injection is empirically untested. The spec asserts "the kind of context-awareness the model handles well when surfaced explicitly" — but the C-track verification discipline that the spec applies elsewhere is absent here. Add this as a verification entry: send a turn referencing prior code, inject the head-shift note, ask a follow-up that depends on the now-stale earlier reference, observe whether the model defers to the new code or hallucinates from memory.
- The injection is "on that turn only, then update the tracked SHA" — meaning multiple shifts produce only one note total per shift, not a cumulative caveat. If the user's chat spans iterations 3, 4, 5 with shifts at turns 3 and 7, the model needs to know about both to interpret turns 1–6 correctly. The spec's design only re-prepends per shift; cumulative effect is unspecified.

**Direction:** Add this to the verification-notes track as an empirical gate before P2-2. Specify the cumulative-shift behavior.

---

## 6. Premise challenges

### 6.1 The wedge collapses under its own admissions

The spec lists four headline differentiators (`01-vision-and-acceptance.md:23-37`):

1. **Stale-draft reconciliation** — admitted: *"this feature is a real difference from github.com, but the user friction it defends against (drafts being silently re-anchored on a force-push) is **rare in practice**. Most 'draft loss' reviewers experience is browser-tab loss — solved by *any* local persistence, not by the seven-row matrix."*
2. **Iteration tabs** — admitted in `Known risks` line 167: *"GitHub may copy the wedge. First-class iteration tabs, file-by-file diff with proper navigation, stale-draft reconciliation — these are features GitHub has shipped variations of in CodeFlow / VS Code's PR extension and could ship in the main UI in 2026."*
3. **Local-first authoring with reviewer-atomic submit** — admitted: *"The pending-review pipeline itself is the same one github.com's 'Start a review → Finish your review' flow uses; what makes PRism different is *what happens to drafts that aren't yet submitted.*"* Then admitted-of-#1 above.
4. **Banner-based update model** — not unique to PRism (most modern reviewing UIs avoid auto-mutation).

The remaining wedge is "iteration tabs + word-level diff + rendered markdown by default + an inbox + the 'designed AI seams' meta-claim." Word-level diff, rendered markdown, and the inbox are commodity features. AI seams produce nothing the user can use until v2 ships. **Iteration tabs are the only PoC-shipped non-commodity differentiator that could justify switching from github.com**, and the spec admits GitHub may ship them in 2026.

The pre-shipping discipline check at `03-poc-features.md:223` is the spec's own admission that iteration tabs may not even work on real data: *"If <30% of those PRs cluster correctly, the right call is 'one tab per PullRequestCommit' by default."* If the discipline check fires that fallback, the headline differentiator is "per-commit tabs with a merge UI" — not better than github.com's existing per-commit dropdown.

**What evidence would falsify:** The pre-shipping discipline check itself, if run against the author's actual PR history and showing >70% correct clustering. The validation gate's "1 of 3 strong yes" landing on a reviewer who specifically cites iteration tabs as the reason. **What happens if it fails:** The 5–8 month investment is in a tool whose differentiator is structurally weak; the validation gate is harder to clear; the wedge thesis is broken.

### 6.2 The "AI-first review trajectory" risk and the spec's bet

`01-vision-and-acceptance.md:168` (Known risks):

> "**The 'human reviews AI-authored code' trajectory may shorten.** If the dominant pattern becomes 'AI reviews, humans approve aggregations,' the primary surface here is built for a shorter window than the spec assumes. **Honest acknowledgment: the mitigation is gestural.** [...] If the trajectory dominates, the surface is wrong and the tool would need a different UI altogether."

This is the spec's most honest moment and its largest unaddressed risk. The spec spends 5–8 months building a UI shaped for "human reads diff, AI assists at the margins" against a window the spec admits may be 18 months wide. If the build slips to 9 months and the trajectory shifts at month 12, the bet is lost.

The "lean PoC" alternative the spec rejects is *exactly* the hedge against this risk: build the minimum, validate the human-led-review premise externally on a stripped surface, only then invest the 6 months. The spec admits the largest risk in line 168 and rejects the strongest hedge against it in line 135 with reasoning that doesn't survive scrutiny (§ 2.1).

**What evidence would falsify the bet:** A meaningful share of the validation-gate's N=3 reviewers reporting that they do most of their review of AI-authored PRs by reading the AI's own pre-submit critique rather than the diff itself. **What happens if it fails:** The tool's primary surface is wrong; the seam scaffolding is partially recoverable, the UI is not.

### 6.3 The validation gate is structurally lenient

`01-vision-and-acceptance.md:156`:

> "**Gate passes if: at least 1 of 3 lands as 'I'd switch to this' (strong yes) AND at least 2 of 3 do not land as 'I went back to GitHub.com' (no).**"

This is a soft gate. With 3 reviewers, the conditions are "1 strong yes + 0 strong nos" or "1 strong yes + 1 ambiguous + 1 strong no" (since ambiguous → no). A single enthusiastic reviewer + one polite holdout + one detractor passes the gate. The spec acknowledges the gate was softened from "≥2 of 3 strong-or-qualified" because that bar was "structurally near-unreachable."

If the harder bar is unreachable for excellent products (per the spec's own reasoning), then either the bar should stand and the spec accept that most products won't clear it, or the bar should be moved and the spec own that the gate is now lenient. Currently the spec performs both stances.

A 1-of-3 gate against a 5–8 month spend has expected value roughly equivalent to a coin flip on whether the spend was justified. The spec's own framing of "the author is the most motivated-reasoning-prone observer in the system" applies here — the gate exists to defend against the author's bias, but a 1-of-3 bar is easy enough to clear by selection effects (the author picks the three reviewers).

**What evidence would falsify the gate's defensibility:** Run the same N=3 protocol on the author's existing tool of choice (github.com itself) and observe the same gate passing. If it does, the gate is too easy.

**What happens if the gate is too lenient:** Continued investment on weak signal; the strategic risk in 6.2 is not actually de-risked.

### 6.4 The verification-notes discipline is "we tested A; we'll test B during implementation"

The C-tracks (C5, C6, C7, C4) are documented as "implementer hits the tripwire during P0 work." This pushes risk into implementation, not into pre-implementation design. The spec's empirical-gate framing implies "we've de-risked"; it has *deferred*.

If C5 reveals that `--mcp-config` uses `transport` instead of `type`, the fix is small. If C6 reveals that `pullRequestReviewId` has been deprecated, the fix is small. If C7 reveals body normalization, the fix is medium (option (a) or (b)). If C4 reveals that `--resume` doesn't preserve full state across CLI updates, the cross-restart UX collapses to fresh-with-injection — a meaningful UX downgrade for a load-bearing feature.

**The cumulative probability that *all four* gates pass cleanly with no spec changes is meaningfully lower than each individually**, and the spec doesn't budget for any failures. For a "5–8 month commitment," even a 70% cumulative pass rate implies a meaningful risk of mid-build redesign on a load-bearing surface.

**What evidence would falsify the discipline:** Run any one of C5/C6 in 30 minutes with the existing `gh` CLI and `claude --version`. Both could resolve before the spec ships. The spec has not done this — they remain pending. **What happens if any fails after build starts:** Multi-day rebuild on the C7 case; potentially a UX downgrade on C4.

**Direction:** Run the trivially-runnable empirical gates *now*, before the spec is treated as implementation-ready. C5 and C6 are sub-day tasks. C7 is a few hours. C4's clean-end resume is a one-day test. Resolving all four moves the empirical-gate framing from "deferred to implementer" to "actually de-risked."

---

## 7. Smaller observations

### Tooling and config

- **Default port `5180`** (`02-architecture.md:285`) is a single digit from VS Code's Live Preview port (5500) and overlaps with several common dev servers in the 5181–5199 fallback range. Consider a default outside the 5xxx web-dev cluster, e.g., 14760.
- **No `--no-browser` flag** is documented. Users who run the binary on a remote machine over SSH (or in a tmux session) cannot suppress the auto-launch.
- **Frontend tooling is under-specified.** Architecture line 565 lists Vitest + Playwright; ESLint, Prettier, type-checking config, build target browsers are unspecified. Probably fine for a one-developer PoC, but the DoD doesn't gate it.
- **The Mermaid v11 theme-switching API note** at `03-poc-features.md:503` is a load-bearing detail buried in a paragraph. Move it into a "Mermaid integration" subsection of architecture; it gates a DoD criterion.
- **The Vitest snapshot folder location** for the no-layout-shift test at `01-vision-and-acceptance.md:114` is unspecified. Will it live next to the component or in a centralized `frontend/__tests__/snapshots/`?

### Wedge framing

- The "Mark all viewed" decision (`03-poc-features.md:573`) — "no button, force the user to actually look. Push back if testing reveals this is annoying" — is a provisional decision. Reviewers reviewing 50-file PRs will hit it on every PR. Annoyance is a low bar; this will get pushed back the first week.
- "Vim-style" `j/k/n/p/c/v` shortcuts are a learning curve for non-vim users. The spec calls them out as default, with vim-mode as P4 ("full chord set") — which means even more vim, not a non-vim alternative.
- The 5GB disk threshold (`02-architecture.md:178`) and the 500MB clone-warning threshold (`backlog/01-P0-foundations.md:120`) are magic numbers without configurability paths in PoC.

### State and persistence

- The forensic log's "drop on overflow" safety net (`02-architecture.md:592`) at 5-second WriteAsync timeout is reasonable, but the log entry "event-loss warning" goes to `logs/`, not back into `state-events.jsonl`. A user reading the forensic log to recover a draft will not find the warning unless they cross-reference. Document the cross-reference path.
- `state.json.lock` content includes binary path (`02-architecture.md:395`) for false-positive PID-collision defense — good. But the lockfile content is not subject to the same atomic-rename discipline as state.json. A torn-write of the lockfile content during PID-takeover (rare) would leave a malformed JSON that the next instance refuses to parse. Recovery: the malformed-JSON parser path treats the lockfile as missing and proceeds. Document this.
- Editor-save semantics for state.json (not config.json) is undocumented. If a user hand-edits state.json while the app is running, the FileSystemWatcher on state.json (if any — the spec only describes config.json's watcher) does what?

### Submit pipeline edge cases

- The "stale `commitOID`" recovery flow (`03-poc-features.md:465-470`) clears all draft thread/reply IDs on detection. This is the right safe choice. But if a user has manually edited drafts on github.com (added a comment via the web UI on the now-stale pending review's threads), those edits are lost on discard-and-recreate. Acceptable, but worth a one-line note.
- "Foreign-author thread deletion mid-retry" is documented for replies (`03-poc-features.md:462`); for new threads, the pending-review-deletion case is documented at line 465-470. But what about *foreign-author thread deletion* on a thread the user *replied to* in a prior submit attempt? If the reply was successfully posted and stamped, then the parent thread is deleted by its author, the reply still exists on github.com with a dangling parent. On retry, the verify step (`03-poc-features.md:456`) checks the reply still exists — it does — and skips. The dangling reply persists. github.com may render it as an orphan. Edge case worth covering.

### Frontend / UX

- The composer's "live-preview toggle" (`03-poc-features.md:268`) lives in the comment composer but the same toggle is implicit in the submit dialog's PR-summary textarea + live preview (always-on). Inconsistent default — the inline composer hides the preview by default; the submit dialog always shows it.
- "Rendered markdown for `.md` files" defaults to "Rendered" (`03-poc-features.md:494`). The toggle is per-file. State is presumably persisted per-`(pr_ref, file_path)` to remember the user's choice — but `02-architecture.md`'s state schema doesn't reserve this. Without persistence, every reload resets to "Rendered."
- The `<AiHunkAnnotation>` widget API note (`04-ai-seam-architecture.md:493-499`) acknowledges the widget API only works for line-anchored annotations and that file-scope annotations need a separate slot deferred to v2. The PoC reserves the line-anchored slot; the file-scope slot is unreserved. v2 will need to add it without "reshape" — fine if the slot insertion is at the file-tree row level, which is independent of the diff widget API.

### Security / privacy

- "Bearer token never logged" (`02-architecture.md:638`) is a discipline; nothing in the spec enforces it. A future contributor adding diagnostic logging may inadvertently include the bearer. A pre-commit hook or test that scans for bearer-shaped strings in logs would be a useful defense.
- "Frontend → backend remains unauthenticated in the user-identity sense" (`02-architecture.md:632`) is fine for single-user, but this means a Cypress/Playwright test that talks to the running backend (without going through the browser's session-token cookie) can't easily simulate the auth — the test would either need to bypass the cookie check (test-only flag) or run in a real browser. The spec's "automated tests" DoD doesn't specify which.

### Empirical gates

- C5, C6, C7, and the C4 clean-end resume probe are deferrable but trivially runnable. C5: 30 minutes with `claude --mcp-config <test.json>`. C6: 2 minutes with `gh api graphql`. C7: a few hours with a test PR. C4 clean-end: a day. **All four could be resolved before the spec ships.** Doing so moves the corpus from "design-ready" to "implementation-ready."

---

## 8. What's done well

Brief, with three concrete examples.

1. **The verification-notes discipline.** `00-verification-notes.md` is the strongest artifact in the corpus. C1's falsification of the "single API call" wedge — and the resulting redesign to GraphQL pending-review — saved the implementer from a multi-week dead end. The C-track and M-track labels with status enum (CONFIRMED / FALSIFIED / PARTIAL / UNDOCUMENTED) is a pattern worth keeping in the repo as a permanent discipline beyond Wave 2.

2. **The submit pipeline's idempotency design.** `03-poc-features.md` § 6 thinks through resume-after-crash, foreign-pending-review prompt, commitOID-mismatch with discard-clear-recreate, lost-response window with content-equivalence adoption (modulo C7), and foreign-author thread deletion. The state machine is real, the failure modes are enumerated, and the per-draft-`threadId` stamping as the durable idempotency key is the right choice over content-hashing. Most production submit pipelines do not get this right.

3. **The capability-flag resolution rule.** `04-ai-seam-architecture.md:272-280` requires AND-joining (impl is non-noop) AND (config flag) AND (LLM substrate available). The marker-interface mechanism (`INoopAiService`) for clause 1 is type-safe and rename-safe, where a string-prefix check would be neither. This is the kind of invariant that prevents "user enables feature in config but the impl was deleted three releases ago" silent failures.

---
