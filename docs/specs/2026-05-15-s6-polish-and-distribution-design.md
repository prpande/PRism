# S6 — Polish and distribution (PoC ship)

**Slice**: S6 (after S6 PR0 multi-account storage scaffold, which has shipped).
**Date**: 2026-05-15.
**Status**: Design — pending user review.
**Source authorities**:
- [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) — the Definition of Done (DoD) bullets this slice closes.
- [`docs/spec/02-architecture.md`](../spec/02-architecture.md) — distribution model, configuration schema, security posture.
- [`docs/spec/03-poc-features.md`](../spec/03-poc-features.md) § 9 (keyboard shortcuts), § 11 (Settings, currently "PoC: file-only"), § 13 (accessibility baseline).
- [`docs/roadmap.md`](../roadmap.md) S6 row — the items this slice ships.
- [`docs/specs/2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md) — S6 PR0, already shipped; this slice extends the storage shape into runtime behavior for the single-account v1 case and leaves v2 generalizations annotated.

---

## 1. Goal and scope

### 1.1 Goal

Ship the PoC binary that clears the validation gate. Every DoD checkbox under `01-vision-and-acceptance.md` § Cross-platform, § Tests (automated), and § Quality closes; users can download a `PRism-win-x64.exe` or `PRism-osx-arm64` from a GitHub Release, run it once, paste a PAT, and start reviewing. Plus the Settings + Replace-token surface so reviewers can tune the app without hand-editing `config.json`.

### 1.2 End-to-end demo at slice completion

1. Maintainer dispatches `publish.yml` workflow → both binaries attached to a draft GitHub Release; maintainer promotes to published.
2. New user downloads `PRism-win-x64.exe` → double-click → SmartScreen warning ("Windows protected your PC") → user clicks **More info → Run anyway** (the Setup screen tells them this exact phrase).
3. Browser auto-launches at `http://localhost:5180` (or next free port).
4. Setup screen → paste PAT → validate → land on Inbox.
5. Header shows nav: `Inbox / Settings / Setup`. User clicks **Settings** → sees grouped sections: Appearance (theme, accent, AI preview), Inbox sections (five visibility toggles), GitHub (read-only host display + "Edit `config.json`" link), Auth (Replace token link).
6. User presses `?` on the inbox → cheatsheet overlay opens with the shortcut table. Press `Esc` → closes. Press `Cmd/Ctrl+/` from inside a composer → opens; composer text preserved; closing returns focus.
7. Initial paint of every page shows the PRism logo with a subtle pulse + low-opacity watermark; once data arrives, content renders.
8. Tab through every page — focus rings visible on every interactive element; axe-core in CI reports 0 serious/critical violations.
9. User clicks **Replace token** → app verifies no submit pipeline is in-flight → routes to `/setup?replace=1` → user pastes a different login's PAT → validates → drafts preserved across all PRs; `pendingReviewId` / draft `threadId` / reply `replyCommentId` cleared; S5's foreign-pending-review modal handles orphan pending reviews on next submit attempt.

### 1.3 In scope

1. Settings page with the field set in § 2.
2. Replace token flow (lazy validate-before-swap) and the identity-change rule.
3. Keyboard cheatsheet overlay (`?` and `Cmd/Ctrl+/`).
4. Branded loading states with PRism icon + low-opacity watermark.
5. Accessibility baseline audit closing every DoD § 13 bullet.
6. Manual-dispatched publish workflow producing `PRism-win-x64.exe` and `PRism-osx-arm64`.
7. First-run trust copy on Setup screen for SmartScreen (Windows) and Keychain/Gatekeeper (macOS).
8. Viewport screenshot regression test for the no-layout-shift-on-banner DoD line.
9. README graduation to "downloadable PoC" status, plus a Troubleshooting section.

### 1.4 Out of scope (deferred)

- Code signing (Authenticode / Apple Developer ID notarization) — P4 backlog.
- Auto-update — v2 backlog.
- Linux binary — P4 backlog (Linux remains best-effort per `05-non-goals.md`).
- `osx-x64` (Intel Mac) binary — explicit DoD non-target.
- Polling-cadence Settings UI — half-day v2 retrofit; deferred per brainstorm (`config.polling.*` shape already exists; pollers read from `IConfigStore.Current`; the missing piece is allowlist + UI rows).
- Logging-level Settings UI — file-only.
- Event-log retention Settings UI — file-only.
- GitHub host editable in Settings — Settings shows read-only with link to `config.json`; host changes still go through hand-edit + `FileSystemWatcher` → host-change-resolution flow.
- Orphan-drafts surface (for PRs the current token can't see) — drafts persist in `state.json` invisibly; spec § 3.4 explains why.

### 1.5 v1 vs v2 boundary

The multi-account storage scaffold ([`2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md)) shipped the on-disk shape for v2 multi-account but explicitly deferred interface and wire commitments. This slice introduces single-account-shape interfaces (one Replace endpoint, one identity-change rule scope, etc.) that v2's multi-account brainstorm will revisit. § 10 enumerates every such touch-point so the v2 effort inherits a starting list.

---

## 2. Settings page

### 2.1 Surface

- Route: `/settings`, gated like other authed routes (`hasToken === true`). The route handler in `App.tsx` adds a `<Route path="/settings" element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />} />`.
- A new `<NavLink to="/settings">Settings</NavLink>` lands in the Header between `Inbox` and `Setup`. The Settings tab reuses identical CSS to the existing Inbox tab (no new styling tokens). The Setup tab stays for explicit re-entry (mostly first-run); when `!hasToken`, a leading `·` indicator renders before the "Setup" label to communicate first-run-needed status without altering tab weight. The indicator disappears once a PAT is connected.
- **Active-state on `/setup?replace=1`**: when the user reaches Setup via the Replace token flow (the URL carries `?replace=1`), the **Settings** tab is rendered active and the Setup tab is NOT — because the user got there from Settings and "Replace token" is a Settings affordance, not a re-onboarding action. Implement via a custom `isActive` predicate on `NavLink` that checks `pathname === '/setup' && !searchParams.has('replace')` for the Setup tab and `(pathname === '/settings') || (pathname === '/setup' && searchParams.has('replace'))` for the Settings tab.
- Layout: single column with `max-width: 720px`, centered, vertical sections grouped by category with a section heading and supporting helper text. The 720px max-width is mobile-narrow-friendly — the column centers within any viewport ≥720px and naturally shrinks below that down to ~375px without horizontal scroll.
- Header chips (theme cycle, accent picker, AI preview toggle) remain visible while on `/settings`. The chips give instant-flip; Settings is the comprehensive surface. Both coexist per roadmap framing.

### 2.2 Field set

| Category | Field | Type | Persists to (`config.json` path) | Hot-reload semantics |
|---|---|---|---|---|
| Appearance | Theme | enum `system` / `light` / `dark` | `ui.theme` | Applied on next render; existing `usePreferences` flow |
| Appearance | Accent | enum `indigo` / `amber` / `teal` | `ui.accent` | Applied on next render |
| Appearance | AI preview | bool | `ui.aiPreview` | Frontend refetches `/api/capabilities` after toggle (existing pattern) |
| Inbox sections | Review requested | bool | `inbox.sections.review-requested` | Next inbox poll tick (120s default) |
| Inbox sections | Awaiting author | bool | `inbox.sections.awaiting-author` | Next inbox poll tick |
| Inbox sections | Authored by me | bool | `inbox.sections.authored-by-me` | Next inbox poll tick |
| Inbox sections | Mentioned | bool | `inbox.sections.mentioned` | Next inbox poll tick |
| Inbox sections | CI failing on my PRs | bool | `inbox.sections.ci-failing` | Next inbox poll tick |
| GitHub | Host (read-only display) | string | n/a — reads `config.github.accounts[0].host` via the multi-account scaffold delegate property | n/a |
| GitHub | "Copy `config.json` path" button | button → clipboard | n/a — copies `<dataDir>/config.json` to clipboard via `navigator.clipboard.writeText`; surfaces a brief success toast ("Path copied — paste into your editor"). Browsers block `<a href="file:///...">` for security, so we render this as a button-with-clipboard-action rather than a hyperlink. Works cross-browser; doesn't require shell-out APIs. | n/a |
| Auth | Replace token | link → § 3 lazy-swap flow | n/a | n/a |

**Inbox-tick hot-reload caveat.** The inbox poller reads `config.Current.Inbox.Sections` per fetch cycle, not on `IConfigStore.Changed`. A user toggling an inbox section in Settings sees the change apply on the next 120s poll, not immediately. Surfacing this in Settings helper text:

> Inbox section changes apply on the next inbox refresh (within 2 minutes).

This is acceptable for the PoC — the inbox isn't a live-edit surface and the delay is bounded. Faster propagation requires the poller to subscribe to `IConfigStore.Changed` and force an immediate refetch, which is a half-day v2 polish item parallel to the polling-cadence work.

### 2.3 Persistence: `ConfigStore.PatchAsync` allowlist extension

Today `PatchAsync` accepts only `theme`, `accent`, `aiPreview` (the `_allowedUiFields` set). The allowlist becomes dotted paths so non-`ui.*` fields can join:

```csharp
private static readonly HashSet<string> _allowedFields = new(StringComparer.Ordinal)
{
    // ui.* (existing — backwards-compat path keeps these accepted as bare keys for the
    // /api/preferences POST body shape established in S0+S1)
    "theme",
    "accent",
    "aiPreview",
    // inbox.sections.* (new in S6) — keys map to InboxSectionsConfig
    // (ReviewRequested, AwaitingAuthor, AuthoredByMe, Mentioned, CiFailing) in
    // PRism.Core/Config/AppConfig.cs. Canonical section set: docs/spec/03-poc-features.md § 11.
    "inbox.sections.review-requested",
    "inbox.sections.awaiting-author",
    "inbox.sections.authored-by-me",
    "inbox.sections.mentioned",
    "inbox.sections.ci-failing",
};
```

The single-field-per-patch contract from S0+S1 is preserved: each PATCH carries exactly one key (the dotted path or the bare `ui.*` key) and one value. The patch handler's switch arm dispatches on the key. Adding a sub-record-aware merge function inside `ConfigStore.PatchAsync`:

```csharp
// Existing handlers for theme/accent/aiPreview (bare keys) — unchanged.
// New handlers for dotted paths:
case "inbox.sections.review-requested":
    var sections = _current.Inbox.Sections;
    var newSections = sections with { ReviewRequested = Convert.ToBoolean(value, ...) };
    _current = _current with { Inbox = _current.Inbox with { Sections = newSections } };
    break;
// ... and so on for each inbox.sections.* key.
```

The mechanical expansion is acceptable for five keys. If a future slice adds many more dotted fields, refactor to a path-walking helper; until then, the explicit switch arms are clearer.

### 2.4 Wire shape

`GET /api/preferences` returns a richer payload that exposes the new categories:

```jsonc
{
  "ui": {
    "theme": "system",
    "accent": "indigo",
    "aiPreview": false
  },
  "inbox": {
    "sections": {
      "review-requested": true,
      "awaiting-author": true,
      "authored-by-me": true,
      "mentioned": true,
      "ci-failing": true
    }
  },
  "github": {
    "host": "https://github.com",
    "configPath": "C:\\Users\\<user>\\AppData\\Local\\PRism\\config.json"
  }
}
```

`POST /api/preferences` keeps the single-field contract. Body shape stays `{ "<key>": <value> }` where `<key>` is either a bare `ui.*` key (back-compat) or a dotted `inbox.sections.*` key. Unknown keys → `400 ConfigPatchException` (existing path).

The `github.configPath` field is read-only; it's there so the Settings page can display "Edit `<actual path>`" without the frontend having to guess the data directory across platforms. Computed at startup as `Path.Combine(Environment.GetFolderPath(SpecialFolder.LocalApplicationData), "PRism", "config.json")` and exposed via a small extension on `IConfigStore` (`ConfigStore.ConfigPath` property; read-only).

### 2.5 Validation

- **Bool fields**: must be `true` or `false`. Anything else → 400 with field name in the error body.
- **Enum fields** (theme, accent): closed set match against the same lookup tables used today by header chips.
- **Unknown keys**: 400 (existing path).
- **Multi-field patches**: 400 (existing path; the single-field contract is preserved).

### 2.6 Save semantics (per-field auto-save)

Each Settings toggle/dropdown fires its own one-field PATCH on change; the page never has a Save button. The interaction states this introduces:

- **Save mode**: **optimistic update with rollback**. The UI flips immediately on click; the PATCH fires in the background; on `2xx` the in-memory `usePreferences` state is reconciled against the response (in-place — no flicker on success); on `4xx`/`5xx`/network failure the UI flips back to its prior value and surfaces an inline error toast: *"Couldn't save — `<field>` reverted."* This matches the header-chip pattern and keeps perceived latency at zero on the happy path.
- **Per-field error isolation**: failures on one field do NOT roll back unrelated fields. The toast names the specific field; the user can retry by clicking again.
- **Navigate-away during in-flight PATCH**: the PATCH continues — it's `fetch` not `XHR`, so it runs to completion regardless of route changes. On return to `/settings`, `usePreferences` re-fetches via the existing focus-refetch path (`useEffect` + `focus` listener in `usePreferences.ts`) and the page reflects the persisted state. No flicker because the optimistic update already landed in memory.
- **Multiple in-flight PATCHes**: each toggle fires its own request; they don't serialize on the frontend. Backend `ConfigStore.PatchAsync` serializes via its internal `_gate` (existing). Concurrent PATCHes therefore land in arrival order at the backend; no client-side coordination needed.

### 2.7 Frontend components

New under `frontend/src/`:

- `pages/SettingsPage.tsx` — top-level page; uses `usePreferences` hook (extended to read the new GET shape) and `useConfigPath` (new hook hitting `/api/preferences`'s `github.configPath`).
- `components/Settings/`
  - `AppearanceSection.tsx` — three rows (theme dropdown, accent radio group, AI preview switch).
  - `InboxSectionsSection.tsx` — five toggle rows with helper text about the 2-minute propagation caveat. The helper text renders as a single `<span id="inbox-section-help">` once at the top of the section; every toggle in the section sets `aria-describedby="inbox-section-help"` so screen reader users hear the propagation caveat as part of each control's announcement.
  - `GithubSection.tsx` — read-only host display + "Edit `config.json`" link.
  - `AuthSection.tsx` — Replace token link with the in-flight-submit guard logic from § 3.
  - `SettingsPage.module.css` — section styling, max-width 720px container, group dividers.

Each component is a thin presentational shell over `usePreferences`. Patching follows the existing one-field-at-a-time pattern from `HeaderControls.tsx`.

---

## 3. Replace token and identity-change rule

### 3.1 Lazy-swap UI flow

1. User clicks Replace token (Settings Auth section).
2. Frontend `GET /api/submit/in-flight` (new endpoint; see § 3.5). Response: `{ inFlight: bool, prRef?: string }`. If `inFlight === true`, surface an inline message on the Auth section:

   > A submit is in progress on `<owner>/<repo>/<n>`. Replace token after it finishes.

   The Replace link disables: rendered as a greyed-out anchor with `aria-disabled="true"`, `tabIndex={-1}`, and `pointer-events: none`. A tooltip on hover/focus repeats the same message ("Submit on `<prRef>` in progress"). Frontend re-polls `/api/submit/in-flight` on the next `state-changed` SSE event so the link re-enables once the lock clears. **If the SSE channel is permanently broken** (per the S3 deferral "no user-visible signal when SSE is permanently broken"), the link stays disabled until the user reloads the page; this is acceptable for the PoC because (a) SSE breakage is itself a regression that surfaces via other paths (no live updates anywhere), and (b) a permanent disable is preferable to a stale-enabled link that 409s on click.

3. Otherwise, frontend navigates to `/setup?replace=1`. The `/setup` route guard in `App.tsx` is loosened: today `isAuthed && pathname === '/setup'` redirects to `/`; the new rule is `isAuthed && pathname === '/setup' && !searchParams.has('replace')` redirects to `/`. Reaching `/setup?replace=1` while authenticated is allowed.
4. `SetupForm` renders identically (same component, same UI) plus a **Cancel** link rendered only when `searchParams.has('replace')` is true. The Cancel link is styled as a secondary action below the Continue button and calls `navigate('/settings')` (explicit destination, not history-dependent — back-button history may carry the user further than intended). The host displayed is `config.github.accounts[0].host` (unchanged).
5. User pastes new PAT. Frontend POSTs `/api/auth/replace` (new endpoint; see § 3.5).
6. Backend on `/api/auth/replace`:
   - Re-check `SubmitLockRegistry.AnyHeld()`. If held → return `409 Conflict` with body `{ ok: false, error: "submit-in-flight", prRef: "<owner>/<repo>/<n>" }`. Closes the TOCTOU race between step 2's check and the user's paste-and-submit.
   - `tokens.WriteTransientAsync(newPat)`.
   - `review.ValidateCredentialsAsync()`. If `!result.Ok` → `tokens.RollbackTransientAsync()` → return validation-failure body (mirrors `/api/auth/connect`).
   - Snapshot `priorLogin = config.Current.Github.Accounts[0].Login` (read before commit).
   - `tokens.CommitAsync()` — atomic keychain replace.
   - `viewerLogin.Set(result.Login ?? "")`.
   - `config.SetDefaultAccountLoginAsync(result.Login ?? "", ct)` — writes the new login to `config.github.accounts[0].login` via the existing helper.
   - Apply identity-change rule (§ 3.2).
   - Return body: `{ ok: true, login: result.Login, host: config.Current.Github.Host, identityChanged: bool }`.
7. Frontend on 200:
   - Fire `prism-auth-recovered` event (existing pattern in `App.tsx`).
   - `navigate('/')`.
   - If `identityChanged === true`, surface a toast via the new `<Toast>` component family (see § 3.1.1 below):

     > Connected as `<newLogin>`. Drafts preserved; pending review IDs cleared so the new login can re-submit.

8. Frontend on 409 → surface inline error on `/setup?replace=1`:

   > A submit started during your token paste. Try Replace again in a moment.

   Stays on `/setup?replace=1`; the user can retry. The old PAT is still in the keychain (no `CommitAsync` happened); the transient was never written if the 409 fires before `WriteTransientAsync`. If the 409 fires after `WriteTransientAsync` but before `CommitAsync` (the only window where the transient exists), `RollbackTransientAsync` is invoked.

9. Frontend on validation failure → existing failure UI in `SetupForm` (same as connect path).

### 3.1.1 Toast component (new — first toast in the product)

The Replace token flow introduces the first toast surface in the product. No toast pattern exists in the design handoff or `tokens.css`, so S6 ships a small `<Toast>` component family alongside the Replace token flow.

- **Component**: new under `frontend/src/components/Toast/{Toast.tsx, ToastProvider.tsx, useToast.ts, Toast.module.css}`. Provider mounted at App root as a sibling to `CheatsheetProvider`.
- **API**: `const toast = useToast()` exposes `toast.success(message)`, `toast.error(message)`, `toast.info(message)`. Each call returns a `dismiss()` handle so callers can programmatically close.
- **Layout**: bottom-right of the viewport (16px margin); max-width 360px; single-line headline with an optional second-line body; close button (X icon) in the top-right corner of the toast.
- **Styling**: `--surface-2` background with a colored left border per kind — `--accent-success` (green; success), `--accent-warning` (amber; warning), `--accent-danger` (red; error). New tokens to add in `tokens.css`: `--toast-bg`, `--toast-border-success`, `--toast-border-warning`, `--toast-border-danger`, `--toast-shadow`. All derived from the existing oklch base palette.
- **Duration**: success and info toasts auto-dismiss at 5s; error toasts persist until the user clicks the close button (failure visibility matters more than auto-dismiss).
- **Stacking**: up to 3 concurrent toasts stack vertically (newest at the bottom). A 4th displaces the oldest with a brief fade.
- **A11y**: `role="status"` + `aria-live="polite"` for success/info; `role="alert"` + `aria-live="assertive"` for error. Close button carries `aria-label="Dismiss <kind> toast"`. The pulse animation respects `prefers-reduced-motion` (no fade-in animation if the user has reduced-motion enabled — toast renders instantly).

Other Replace-token-flow surfaces (submit-in-flight 409, validation failure on the new PAT) reuse the same component with `toast.error`. Future surfaces (S5's `submit-duplicate-marker-detected` toast already ships under a separate `useSubmitToasts` hook — that hook is refactored in PR4 to use `useToast` so all toasts share one surface).

### 3.2 Identity-change rule

Triggered post-`CommitAsync` inside `/api/auth/replace` only when `priorLogin` differs from the new login.

```
priorLogin = config.github.accounts[0].login (snapshot before CommitAsync)
newLogin   = result.Login from ValidateCredentialsAsync (post-validate)

if priorLogin is null OR newLogin is null:
    identityChanged = false        (never reached via Replace — Replace requires a prior token; first-Setup hits /api/auth/connect)

elif string.Equals(priorLogin, newLogin, OrdinalIgnoreCase):
    identityChanged = false        (case-insensitive: GitHub treats "alice" and "Alice" as the same login)

else:
    identityChanged = true

    // Counts captured by the transform closure so the forensic event below can read them.
    // The transform runs under IAppStateStore's internal lock — concurrent draft saves
    // (PrDraftEndpoints, PrReloadEndpoints, etc., which all use UpdateAsync) serialize
    // against the same lock, so no in-flight write is lost during the identity-change pass.
    var sessionsAffected = 0;
    var draftsAffected   = 0;
    var repliesAffected  = 0;

    await stateStore.UpdateAsync(state => {
        var sessions = state.Reviews.Sessions;
        var newSessions = new Dictionary<string, ReviewSessionState>(sessions.Count);
        foreach (var (refKey, session) in sessions) {
            var hadPendingOrIds =
                session.PendingReviewId is not null ||
                session.DraftComments.Any(d => d.ThreadId is not null) ||
                session.DraftReplies.Any(r => r.ReplyCommentId is not null);

            var clearedDraftComments = session.DraftComments
                .Select(d => d.ThreadId is null ? d : d with { ThreadId = null })
                .ToImmutableList();
            var clearedDraftReplies = session.DraftReplies
                .Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null })
                .ToImmutableList();

            newSessions[refKey] = session with {
                PendingReviewId        = null,
                PendingReviewCommitOid = null,
                DraftComments          = clearedDraftComments,
                DraftReplies           = clearedDraftReplies,
                // DraftVerdict, DraftVerdictStatus, DraftSummaryMarkdown,
                // ViewedFiles, IterationOverrides, LastViewedHeadSha,
                // LastSeenCommentId — all preserved.
            };

            if (hadPendingOrIds) sessionsAffected++;
            draftsAffected  += session.DraftComments.Count(d => d.ThreadId is not null);
            repliesAffected += session.DraftReplies.Count(r => r.ReplyCommentId is not null);
        }

        return state.WithDefaultReviews(state.Reviews with { Sessions = newSessions.ToImmutableDictionary() });
    }, ct);

    // Forensic event + cache eviction + SSE fan-out are side-effects of the successful
    // UpdateAsync — they run AFTER the transform commits so a transform retry (last-
    // transform-wins under contention) doesn't double-fire them.

    // Forensic event (see § 3.6)
    forensic.Emit("IdentityChanged", new {
        accountKey       = AccountKeys.Default,
        priorLogin,
        newLogin,
        sessionsAffected,
        draftsAffected,
        repliesAffected,
    });

    // In-memory cache eviction (see § 3.3)
    activePrCache.Clear();
    inboxPoller.RequestImmediateRefresh();
    activePrSubscriberRegistry.RemoveAll();

    // SSE fan-out so other tabs re-fetch (see § 3.4)
    sse.Publish(new StateChanged(prRef: null, fieldsTouched: ["identity-change"]));
```

**What is preserved.** Every text field: `DraftComment.BodyMarkdown`, `DraftReply.BodyMarkdown`, `DraftSummaryMarkdown`. Every non-Node-ID per-session field: `DraftVerdict`, `DraftVerdictStatus`, `ViewedFiles`, `IterationOverrides`, `LastViewedHeadSha`, `LastSeenCommentId`. "The reviewer's text is sacred" — applied verbatim.

**What is cleared.** Only the GraphQL Node IDs scoped to the prior login: `PendingReviewId`, `PendingReviewCommitOid`, every `DraftComment.ThreadId`, every `DraftReply.ReplyCommentId`. `DraftReply.ParentThreadId` is preserved — it identifies a GitHub thread the user replied to, owned by GitHub (not by the prior login). The new login can reply to the same thread.

**GitHub-side consequence.** Any pending review created by `priorLogin` is now "foreign" from `newLogin`'s perspective. On next submit attempt against any affected PR, the S5 foreign-pending-review flow (`SubmitPipeline` → `IReviewSubmitter.FindOwnPendingReview` → modal) presents Resume/Discard/Cancel. Drafts (with null `threadId`) re-submit cleanly through `addPullRequestReviewThread` as new threads.

**Case-insensitive compare.** GitHub treats logins as case-insensitive in routing but case-preserving in display. A user rotating from a token that returned `Alice` to one that returns `alice` is the same user; identity-change must not fire. `string.Equals(priorLogin, newLogin, StringComparison.OrdinalIgnoreCase)` is the comparison.

### 3.3 Cache invalidation on identity-change

Three caches need eviction when `identityChanged === true`:

- **`IActivePrCache`** — in-memory cache of the currently-active PR's details (file tree, comment list, etc.). Holds token-A-fetched data that may include PRs token B can't see (404), or shows comment counts that differ between authors. Add new method `void Clear()` to the interface (single line, no parameters in v1; v2 generalizes to `ClearForAccount(accountKey)`).
- **Inbox poller** — last-result cache. Add `void RequestImmediateRefresh()` that wakes the poller before its next 120s tick. The current `InboxPoller.ExecuteAsync` loop is `WaitForSubscriberAsync → orchestrator.RefreshAsync → Task.Delay(nextDelay, stoppingToken)` — a semaphore checked "each iteration" would only fire at the next 120s boundary. The fix is to race the delay against a signal. Recommended implementation: a private `SemaphoreSlim _refreshSignal = new(0, 1)`; replace `await Task.Delay(delay, stoppingToken)` with `await Task.WhenAny(Task.Delay(delay, linkedCt.Token), _refreshSignal.WaitAsync(linkedCt.Token))` where `linkedCt` is a `CancellationTokenSource.CreateLinkedTokenSource(stoppingToken)` so either branch can cancel the other. `RequestImmediateRefresh` calls `_refreshSignal.Release()` (semaphore stays at capacity 1 — duplicate signals coalesce). Unit test: signal mid-delay, assert next `RefreshAsync` lands within 100ms.
- **`ActivePrSubscriberRegistry`** (`PRism.Core/PrDetail/`) — drops every active per-PR subscription. Frontend tabs hear the `state-changed` event with `identity-change` field tag and re-subscribe naturally on next PR-detail navigation. Implementation: add a new `void RemoveAll()` method to the existing `Add` / `Remove` / `RemoveSubscriber` surface; iterate and clear both `_bySubscriber` and `_byPr` dictionaries under their existing concurrency discipline. No synthetic disconnect event is needed — the frontend's existing SSE-reconnect logic detects subscription absence on the next per-PR poll cycle (which now returns no events for the dropped PR) and re-subscribes when the user navigates to that PR.

Identity-change is the ONLY trigger that calls `Clear()` / `UnsubscribeAll()` in v1. Other auth state transitions (initial connect, host change) handle their own state via separate paths.

### 3.4 Multi-tab and 404-on-current-PR

- **Multi-tab**: every tab's `useAuth` hook receives `state-changed` with `identity-change` field tag → re-fetches `/api/auth/state` (which now reports the new login). The tab's React state for inbox / PR-detail re-renders. Composer text in any open composer remains untouched (state.json drafts preserved).
- **404 on the currently-viewed PR**: user is on `/pr/owner/P2/42` and replaces with a token that has no access to `P2`. After the identity-change cache eviction:
  - Next active-PR poll (forced within seconds via `RequestImmediateRefresh` analog for the active poller, OR within 30s on the normal cadence — actually the active-PR poller doesn't have an immediate-refresh path today, but the next 30s tick hits 404).
  - Spec § 12 (poc-features) "404 on a PR" handler surfaces: *"This PR no longer exists or your token doesn't cover this repo."*
  - User navigates back to inbox manually. Drafts for P2 remain in `state.json` invisibly; they re-surface if access is later restored.

We don't auto-redirect-on-404 because the standard 404 banner is the right UX — it tells the user what happened. Adding a Replace-token-specific redirect would duplicate logic.

### 3.5 Backend endpoints

#### `GET /api/submit/in-flight` (new)

Read-only, idempotent. Returns the current state of `SubmitLockRegistry`.

**`SubmitLockRegistry.AnyHeld()` implementation note.** The registry stores `ConcurrentDictionary<string, SemaphoreSlim>` whose entries are never evicted (per the class comment). A naive `_locks.Any()` would return `true` forever after the first submit, breaking Replace token entirely. Two acceptable implementations:

- **Probe each lock** — iterate `_locks`, call `WaitAsync(TimeSpan.Zero)` on each `SemaphoreSlim`; if it succeeds, the lock was free → immediately `Release()` (we only needed to probe, not hold). If it returns `false`, the lock is held → that's the answer; return `(true, prRef)`. Loop has an inherent TOCTOU window (a lock can be released between check-i and check-i+1) but the same window already applies to the post-paste re-check, and the worst case is a false-negative that resolves on the next call.
- **Maintain a separate held-set** — add a `ConcurrentDictionary<string, byte> _heldLocks` populated inside `TryAcquireAsync` on success and cleared in the disposable `IDisposable` handle's `Dispose`. `AnyHeld()` becomes `_heldLocks.Any() ? (true, _heldLocks.Keys.First()) : (false, null)`. Same TOCTOU window; simpler enumeration.

Implementer picks; spec doesn't pre-commit. Test must cover both the "no submit ever ran" baseline and the "submit completed; lock returned" path (the naive probe must not report it as held).

```jsonc
// 200 — no lock held
{ "inFlight": false }

// 200 — lock held
{ "inFlight": true, "prRef": "owner/repo/123" }
```

If multiple locks are held (legal — submits on different PRs can run concurrently), return any one (the first iterated). Frontend uses this for the Replace-token guard; "any submit in flight" is what matters, not which one. Returning the first matches the "refuse with clear message" UX (we show a single PR ref in the inline message).

#### `POST /api/auth/replace` (new)

Distinct from `/api/auth/connect` because the post-validate behavior differs (identity-change rule applies; first-connect just commits).

```jsonc
// Request body
{ "pat": "ghp_..." }

// 200 — success, no identity change
{ "ok": true, "login": "alice", "host": "https://github.com", "identityChanged": false }

// 200 — success, identity changed
{ "ok": true, "login": "bob", "host": "https://github.com", "identityChanged": true }

// 400 — validation failed (mirrors /connect's failure shapes)
{ "ok": false, "error": "invalid-token", "detail": "..." }

// 409 — submit lock held at the moment of replace
{ "ok": false, "error": "submit-in-flight", "prRef": "owner/repo/123" }
```

The endpoint does NOT support a `Warning` path (the `no-repos-selected` warning from `/api/auth/connect`) because the user previously connected — they're not in a first-Setup posture. If the new PAT happens to validate with `NoReposSelected`, treat it as success (the user knows what they're doing). The same posture applies to other warnings v2 might add.

### 3.6 Forensic event log

The `IdentityChanged` event is appended to `<dataDir>/state-events.jsonl`:

```jsonc
{
  "ts": "2026-05-15T12:34:56Z",
  "kind": "IdentityChanged",
  "payload": {
    "accountKey": "default",
    "priorLogin": "alice",
    "newLogin": "bob",
    "sessionsAffected": 7,
    "draftsAffected": 23,
    "repliesAffected": 5
  }
}
```

The `accountKey` field is `"default"` in v1 but **present in the schema** so v2's per-account scoping is a structural extension rather than a re-keying migration. The counts let a maintainer doing "where did this draft go" reconstruction grep by date and account.

The event is emitted only when `identityChanged === true`. Same-login Replace is silent (no event — same posture as no-op state mutations elsewhere).

### 3.7 Edge cases

- **User backs out of `/setup?replace=1`**: clicks browser back, closes tab, or navigates to `/`. Nothing happened server-side; the old PAT and login are intact. Next render of any route uses the unchanged auth state.
- **Validation fails on new PAT**: `RollbackTransientAsync` clears the transient; old PAT in keychain unchanged; identity-change rule does not fire.
- **S5 foreign-pending-review modal open at moment of Replace**: user navigates from the PR detail to `/settings`; modal unmounts. Next visit to that PR re-evaluates against the new login. If the new login happens to BE the foreign author, the pending review is no longer foreign — fixes itself.
- **Tab A in Settings → Replace; Tab B viewing PR detail**: Tab B receives `state-changed` with `identity-change` → re-fetches PR detail → either 404s (if no access) or renders fresh data (if access). Composer text preserved if any was being typed.
- **Replace fires immediately after a submit completes**: race between Tab A's `GET /api/submit/in-flight` (returns `false`) and Tab B's submit starting. Defense: the backend re-checks `AnyHeld()` inside `/api/auth/replace` itself (step 6 above); a submit that grabbed the lock between Tab A's check and Tab A's submit-paste loses the race and returns 409. The TOCTOU window is closed.
- **First-launch user with `priorLogin === null`**: identity-change rule short-circuits to `identityChanged = false`. This branch is unreachable via Replace (Replace requires `hasToken === true`, which only happens after a successful connect that has populated `accounts[0].login`). Defensive nonetheless.
- **Dangling `DraftReply.ParentThreadId` after foreign-pending Discard.** If `priorLogin` had a pending review with attached threads at the moment of Replace, AND the user authored replies to those attached threads (so `DraftReply.ParentThreadId` is populated from snapshotted threads, per S5 `ResumeForeignPendingReview`), AND `newLogin` then chooses **Discard** on the foreign-pending-review modal on next visit to that PR → the backend's `DeletePendingReviewAsync` removes the pending review and its attached threads server-side, and the preserved `DraftReply.ParentThreadId` now references a thread that no longer exists. **Detection**: next submit attempts `addPullRequestReviewReplyComment` against the dangling thread id; GitHub returns a not-found error; the submit pipeline's retry path surfaces a generic "attach failed" toast. **Recovery**: user manually discards the orphan reply via the existing Drafts tab UI; subsequent submit succeeds. **Accepted as a rare edge case** (requires the specific four-event sequence above); deliberate mitigation deferred to v2 alongside the broader multi-account brainstorm. The S6 spec documents the path so an implementer triaging "submit failed after Replace" reports has the recipe; a v2 hardening could null `ParentThreadId` on the Discard path when its thread id is in the discarded set.

### 3.8 Tests

Backend unit (`PRism.Web.Tests`):
- `/api/auth/replace` happy path with same login → `identityChanged === false`; no state mutation.
- `/api/auth/replace` happy path with different login → `identityChanged === true`; every session's Node IDs cleared; every draft body byte-for-byte preserved; forensic `IdentityChanged` event recorded with correct counts.
- `/api/auth/replace` case-insensitive login match → `identityChanged === false`.
- `/api/auth/replace` with validation failure → `RollbackTransientAsync` called; no commit; old PAT still readable; no state mutation; no forensic event.
- `/api/auth/replace` with `SubmitLockRegistry.AnyHeld() === true` → 409; no transient written; no commit; no state mutation.
- `/api/auth/replace` **PAT-not-logged discipline**: capture the structured log output of a happy-path call; assert no log message contains the request body's PAT value as a substring. The endpoint must log `PatLength` only, mirroring `/api/auth/connect`. Defends against an implementer who copies `/connect`'s skeleton but passes the raw PAT into the logger.
- `/api/submit/in-flight` returns `{ inFlight: false }` when registry empty.
- `/api/submit/in-flight` returns `{ inFlight: true, prRef: <ref> }` when a lock is held; matches one of the held refs.
- `/api/submit/in-flight` **post-submit-completion**: register a submit, complete and dispose the lock, call `AnyHeld()` — must return `(false, null)`, not `(true, <stale-ref>)`. Defends against the naive `_locks.Any()` regression described in `SubmitLockRegistry.AnyHeld()` implementation note above.

Backend unit (`PRism.Core.Tests`):
- `IActivePrCache.Clear()` evicts every entry.
- `activePrSubscriberRegistry.RemoveAll()` removes every subscription.
- Forensic event shape: `accountKey: "default"`, counts match the cleared content.
- `InboxPoller.RequestImmediateRefresh()`: signal the poller mid-`Task.Delay`; assert next `RefreshAsync` invocation lands within 100ms (not 120s).

Frontend unit (Vitest):
- Settings page renders all four sections.
- Toggling an inbox section POSTs `inbox.sections.<key>: <bool>` (single-field shape).
- Replace button disables when `useSubmitInFlight()` returns `inFlight: true`.

Frontend e2e (Playwright):
- Replace token with same PAT → no toast; Settings page re-renders with same login.
- Replace token with different login PAT (fixture-controlled) → toast surfaces; subsequent PR-detail visits render under new login; drafts visible.
- Replace token while a submit is fixture-locked → 409; inline error visible; old token still authoritative.

---

## 4. Keyboard cheatsheet overlay

### 4.1 Component

New under `frontend/src/components/Cheatsheet/`:

- `Cheatsheet.tsx` — the overlay component.
- `CheatsheetProvider.tsx` — React context exposing `isOpen` and `toggle()`. Mounted at App root.
- `shortcuts.ts` — static `SHORTCUTS` constant (same content as `03-poc-features.md` § 9).
- `Cheatsheet.module.css` — overlay styling.

The overlay is `role="dialog"` with `aria-modal="false"` per spec § 9 non-modal contract. Visually: fixed-position centered panel, soft backdrop dim (no pointer events on the backdrop — clicks fall through). Width `min(640px, calc(100vw - 32px))` so it shrinks gracefully below 672px without horizontal scroll; max-height 80vh with internal scroll if content overflows. The panel has an `<h2 id="cheatsheet-heading">Keyboard shortcuts</h2>` and the overlay's `role="dialog"` carries `aria-labelledby="cheatsheet-heading"` so screen readers announce the panel by name.

**Focus management.** On open, focus moves to the panel's `<h2>` heading (which has `tabIndex={-1}` for programmatic focusability). This is the ARIA APG pattern for non-modal dialogs — NVDA and JAWS users may not discover the overlay via the virtual cursor without focus movement, so opening on `?` while keeping focus in the composer would silently fail for AT users. On close (Esc, `?`, or `Cmd/Ctrl+/`), focus returns to the previously-focused element captured in a ref at open time. Composer text in any open composer is preserved across the focus dance — the composer's DOM state is untouched; we only move `document.activeElement`. Tab through the cheatsheet's own interactive elements is allowed but optional; the cheatsheet ships without an explicit close button (users use `Esc`, `?`, or `Cmd/Ctrl+/` to close).

### 4.2 Shortcut handlers

New `useCheatsheetShortcut` hook installs `keydown` on `document` at App root:

```tsx
function isTextEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT' && target.getAttribute('type') === 'text') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[data-composer="true"]')) return true;
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  const isMeta = e.metaKey || e.ctrlKey;

  if (e.key === '?' && !isTextEditingContext(e.target)) {
    e.preventDefault();
    toggle();
    return;
  }
  if (isMeta && e.key === '/') {
    e.preventDefault();
    toggle();
    return;
  }
  if (e.key === 'Escape' && isOpen) {
    e.preventDefault();
    e.stopPropagation();  // closes cheatsheet first; composer's Esc handler does not fire
    close();
    return;
  }
  // Cmd/Ctrl+R intentionally NOT intercepted — existing reload handler fires and the
  // cheatsheet stays open (spec § 9 explicit rule).
}
```

The `data-composer="true"` marker is set on every composer's outer wrapper (`<div data-composer="true">` around the textarea). This lets the focus-routing rule recognize composers even when focus is on a nested button or markdown preview rather than the textarea itself. Add the marker to existing composer components: inline comment composer, reply composer, PR-summary composer.

### 4.3 Content

`SHORTCUTS` constant:

```ts
export const SHORTCUTS: ReadonlyArray<{ group: string; rows: ReadonlyArray<{ keys: string; context: string; action: string }> }> = [
  {
    group: 'Global',
    rows: [
      { keys: 'Cmd/Ctrl + R', context: 'Anywhere',                action: 'Reload current view' },
      { keys: 'Cmd/Ctrl + /', context: 'Anywhere',                action: 'Toggle this cheatsheet' },
      { keys: '?',            context: 'Outside text inputs',     action: 'Toggle this cheatsheet' },
      { keys: 'Esc',          context: 'Cheatsheet open',         action: 'Close cheatsheet' },
    ],
  },
  {
    group: 'File tree',
    rows: [
      { keys: 'j',            context: 'File tree',                action: 'Next file' },
      { keys: 'k',            context: 'File tree',                action: 'Previous file' },
      { keys: 'v',            context: 'File tree (file focused)', action: 'Toggle "Viewed" checkbox' },
    ],
  },
  {
    group: 'Diff',
    rows: [
      { keys: 'n',            context: 'Diff',                     action: 'Next comment thread' },
      { keys: 'p',            context: 'Diff',                     action: 'Previous comment thread' },
      { keys: 'c',            context: 'Diff (line focused)',      action: 'Open comment composer' },
    ],
  },
  {
    group: 'Composer',
    rows: [
      { keys: 'Cmd/Ctrl + Enter', context: 'Composer',             action: 'Save draft' },
      { keys: 'Esc',              context: 'Composer (non-empty)', action: 'Cancel (with discard confirm)' },
    ],
  },
  {
    group: 'Submit dialog',
    rows: [
      { keys: 'Cmd/Ctrl + Enter', context: 'Submit dialog focused', action: 'Confirm submit' },
    ],
  },
];
```

Render as a two-column table per group with group headings. Keep typographic styling consistent with the existing `tokens.css`.

### 4.4 Tests

Frontend unit (Vitest):
- `isTextEditingContext` returns true for textarea, text input, contenteditable, and any descendant of `[data-composer="true"]`.
- `useCheatsheetShortcut` does not toggle on `?` when target is a textarea.
- `useCheatsheetShortcut` toggles on `Cmd/Ctrl+/` regardless of target.

Frontend e2e (Playwright):
- Press `?` outside any composer → overlay visible.
- Press `?` inside a composer → literal `?` typed into the textarea; overlay NOT visible.
- Press `Cmd/Ctrl+/` inside a composer → overlay visible; `document.activeElement` still the composer textarea; composer body unchanged.
- Press `Esc` with both cheatsheet and a non-empty composer open → cheatsheet closes; composer NOT prompted for discard.
- Press `Cmd/Ctrl+R` with cheatsheet open → reload runs (banner clears, page re-renders); cheatsheet still visible after reload settles.

---

## 5. Branded loading states and icon usage

### 5.1 Asset pipeline

The canonical icons live in `assets/icons/` at the repo root (`PRism{16,32,48,64,256,512}.ico`, `PRismOG.png`). Web rendering needs PNG or SVG; we don't have an SVG, so `PRismOG.png` is the primary asset.

Add a one-time copy step (manual during the icon PR, then documented):

- `assets/icons/PRismOG.png` → `frontend/public/prism-logo.png`
- `assets/icons/PRism256.ico` → `frontend/public/favicon.ico`

Vite serves files in `public/` at the root URL (`/prism-logo.png`, `/favicon.ico`). No build-pipeline changes.

The frontend public/ files are duplicates of the canonical assets — when the canonical icons change, the duplicates must be re-copied. Spec § 12 (Project standards updates) documents this contract.

### 5.2 Header logo

Replace the existing `<Logo />` stub in `frontend/src/components/Header/Logo.tsx`:

```tsx
export function Logo() {
  return <img src="/prism-logo.png" alt="PRism" width={28} height={28} className={styles.logo} />;
}
```

CSS: aspect-preserving, no extra styling beyond border-radius if visual polish demands. The image's natural size is much larger than 28×28; the browser's image scaling produces a sharp result.

### 5.3 Favicon

`frontend/index.html`:

```html
<link rel="icon" href="/favicon.ico" type="image/x-icon">
```

Already present in some form (every Vite-templated index.html has a favicon line); update the href and remove any default Vite icon reference.

### 5.4 `<LoadingScreen>` component

New under `frontend/src/components/LoadingScreen/`:

```tsx
import styles from './LoadingScreen.module.css';

interface Props {
  label?: string;
}

export function LoadingScreen({ label = 'Loading…' }: Props) {
  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-live="polite">
      <img src="/prism-logo.png" alt="" aria-hidden="true" className={styles.watermark} />
      <div className={styles.center}>
        <img src="/prism-logo.png" alt="" aria-hidden="true" className={styles.pulseLogo} />
        <span className={styles.label}>{label}</span>
      </div>
    </div>
  );
}
```

CSS:

```css
.screen {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-base);
  overflow: hidden;
}

.watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60vmin;
  height: auto;
  opacity: 0.06;
  pointer-events: none;
  z-index: 0;
}

.center {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}

.pulseLogo {
  width: 96px;
  height: 96px;
  animation: prism-pulse 1.5s ease-in-out infinite;
}

.label {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

@keyframes prism-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.7; }
}

@media (prefers-reduced-motion: reduce) {
  .pulseLogo { animation: none; }
}
```

The watermark and pulse logo both reference the same image. The `alt=""` + `aria-hidden="true"` combination on both `<img>` elements ensures screen readers don't announce them; the `role="status"` + `aria-live="polite"` on the outer div + the visible `Loading…` label handles SR announcement.

**Timeout fallback.** `<LoadingScreen>` shouldn't display indefinitely if the backend never responds (binary startup failure, port collision, network partition on the localhost socket). The component accepts an optional `timeoutMs` prop (default 10000) and a `timeoutLabel` prop (default `"Taking longer than expected — check the terminal output."`). After `timeoutMs`, the `Loading…` label swaps to `timeoutLabel`, the pulse animation stops, and an inline "Reload" button appears under the label that calls `window.location.reload()`. The timeout is purely visual — it doesn't cancel any in-flight request; it gives the user agency when the spinner clearly isn't progressing.

### 5.5 Scope — which loading states get `<LoadingScreen>`

| Location | Today | After |
|---|---|---|
| `App.tsx` initial `authState === null` | `<div aria-busy="true">Loading…</div>` | `<LoadingScreen />` |
| `App.tsx` host-mismatch path before HostChangeModal renders | inline `<div>` | `<LoadingScreen />` |
| `SetupPage.tsx` waiting for authState | `<div aria-busy="true">Loading…</div>` | `<LoadingScreen />` |
| `InboxPage` initial fetch (pre-data) | Existing inbox skeleton | Keep skeleton |
| `PrDetailPage` initial fetch | Existing skeleton | Keep skeleton |
| Per-section in-page transitions (button click, form submit, file-tree expand) | Button-level spinner | Keep button-level |

The branded screen applies to **initial whole-app paint only** — moments where the React tree is empty or just rendering its outermost shell. In-page skeletons (file tree placeholder, PR header placeholder) stay because they're faster perceived (the chrome is already painted) and don't compete with the dense content view.

### 5.6 Tests

Frontend unit (Vitest):
- `<LoadingScreen>` renders the watermark img with `aria-hidden="true"`.
- `<LoadingScreen>` renders the pulse logo with `aria-hidden="true"`.
- `<LoadingScreen>` renders the label inside `role="status"`.
- Custom label prop renders correctly.

Frontend e2e (Playwright):
- Initial app load shows the LoadingScreen briefly before redirecting to inbox or setup.
- The `<img alt="">` elements are not announced (verified via `getByRole('img')` returning the logo by name and the watermark/pulse not appearing as named).

---

## 6. Accessibility baseline audit

### 6.1 Method — three passes

**Pass 1 — Automated (axe-core via Playwright).**

New spec `frontend/e2e/a11y-audit.spec.ts`. Uses `@axe-core/playwright` (`AxeBuilder`).

Visits each page in turn, asserts zero violations at `serious` or `critical` impact:
- `/setup`
- `/` (Inbox, with at least one PR row)
- `/pr/owner/repo/<n>` (Overview tab)
- `/pr/owner/repo/<n>/files` (Files tab)
- `/pr/owner/repo/<n>/drafts` (Drafts tab)
- `/settings`
- Cheatsheet open (any page, then press `?`)

Runs in CI on every PR. Failing this spec blocks merge.

**Pass 2 — Manual grep + fix for bullets axe doesn't catch.**

- **Semantic landmarks**: grep `frontend/src/pages/` and `frontend/src/components/` for top-level components missing `<header>/<main>/<nav>`. Add wrappers.
- **Icon-only buttons**: grep for `<button>` elements with no text content. Verify each has `aria-label`. Targets known from current code: header theme/accent/AI chips, iteration tab strip controls, file tree row buttons.
- **Focus rings**: grep CSS modules for `:focus-visible` rules. Verify every interactive element has a visible focus ring (use `--focus-ring` token from `tokens.css`).
- **SR-only badge labels**: grep `Badge` / `Chip` components rendering counts. Each must have a `<span className="sr-only">` companion describing the count in words ("3 new commits" rather than just "3").

**Pass 3 — Manual VoiceOver pass on macOS dogfood machine.**

Walk through:
- Unread badges on inbox rows
- Viewed checkbox toggle
- Iteration tab strip navigation
- Composer open / dismiss / discard-confirm
- Cheatsheet open / close
- LoadingScreen pulse (verify `prefers-reduced-motion` honored)

Findings either fix in-slice (Pass 2 hook) or document as deferrals.

### 6.2 DoD-bullet evidence checklist

| DoD bullet | Evidence in implementation plan |
|---|---|
| Semantic landmarks | axe-core "landmark-one-main" / "region" rules: 0 violations |
| ARIA on icon-only buttons | axe-core "button-name" rule: 0 violations + grep audit recorded in PR description |
| Keyboard-navigable file tree | Existing S3 e2e spec (file-tree-kbd-nav) green; re-verified |
| Focus rings visible | Manual screenshot of Tab traversal on Inbox + PR detail; attached to PR |
| WCAG AA color contrast | axe-core "color-contrast" rule: 0 violations |
| SR-only badge labels | grep audit recorded + axe-core "aria-text" rule: 0 violations |

### 6.3 Starter fix targets

Preliminary list (not authoritative — the implementation plan enumerates after the audit runs):
- Header chips (theme/accent/AI): verify `aria-label`.
- Inbox row category chips: verify.
- Iteration tab strip: verify role + keyboard handling.
- File tree row buttons + viewed checkboxes: verify.
- LoadingScreen `<img>` elements: confirmed `alt="" aria-hidden="true"` by design (§ 5).
- Cheatsheet overlay: verify `role="dialog"` + `aria-modal="false"` per spec § 9.
- Settings page form inputs: verify each has an associated `<label>`.

---

## 7. Publish workflow and first-run trust copy

### 7.1 `PRism.Web.csproj` publish properties

Add (gated on `$(PublishProfile)` to keep dev builds untouched):

```xml
<PropertyGroup Condition="'$(PublishProfile)' != ''">
  <PublishSingleFile>true</PublishSingleFile>
  <SelfContained>true</SelfContained>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
  <EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>
  <PublishTrimmed>false</PublishTrimmed>
</PropertyGroup>
```

`PublishTrimmed: false` is deliberate. Trimming + reflection-based DI (ASP.NET Core's default) is fragile; AOT investigation is a P4 backlog item per spec M20. For PoC, full self-contained no-trim is safe.

`EnableCompressionInSingleFile: true` trades CPU for size; cold-start adds ~200ms which is acceptable for an app launched once per session.

### 7.2 Build steps per target

```
# Build frontend assets first (publish workflow does this in CI).
# Vite is configured with `build.outDir: '../PRism.Web/wwwroot'` in `frontend/vite.config.ts`,
# so `npm run build` writes the SPA assets directly into PRism.Web/wwwroot — no copy step
# needed. `emptyOutDir: true` also clears any stale assets first.
cd frontend && npm ci && npm run build

# Publish per target
dotnet publish PRism.Web/PRism.Web.csproj \
  --runtime <rid> \
  --self-contained \
  --configuration Release \
  -p:PublishProfile=ci \
  -p:PublishSingleFile=true \
  -p:EnableCompressionInSingleFile=true \
  --output publish/<rid>
```

`<rid>` is `win-x64` or `osx-arm64`.

### 7.3 `.github/workflows/publish.yml`

New workflow file. `workflow_dispatch` trigger only — never runs automatically.

```yaml
name: Publish

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag (e.g., v0.1.0)'
        required: true
        type: string

permissions:
  contents: write  # required to create releases

jobs:
  build-and-publish:
    runs-on: windows-latest
    steps:
      # Third-party actions pinned to commit SHAs (not version tags). A mutable tag
      # like `@v4` can be force-pushed; pinned SHAs cannot. Required because this
      # workflow runs with `contents: write`. Bump deliberately via Dependabot
      # Actions configuration (see § 7.6).
      - uses: actions/checkout@<commit-sha>          # actions/checkout v4.x
      - uses: actions/setup-dotnet@<commit-sha>      # actions/setup-dotnet v4.x
        with:
          dotnet-version: '10.0.x'
      - uses: actions/setup-node@<commit-sha>        # actions/setup-node v4.x
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: 'frontend/package-lock.json'

      - name: Frontend install
        working-directory: frontend
        run: npm ci

      - name: Frontend build
        working-directory: frontend
        # Writes directly to ../PRism.Web/wwwroot per vite.config.ts `build.outDir`;
        # `emptyOutDir: true` clears stale assets first. No copy step needed.
        run: npm run build

      - name: Publish win-x64
        run: >
          dotnet publish PRism.Web/PRism.Web.csproj
          --runtime win-x64 --self-contained --configuration Release
          -p:PublishProfile=ci -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true
          --output publish/win-x64

      - name: Publish osx-arm64
        run: >
          dotnet publish PRism.Web/PRism.Web.csproj
          --runtime osx-arm64 --self-contained --configuration Release
          -p:PublishProfile=ci -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true
          --output publish/osx-arm64

      - name: Rename and measure binaries
        run: |
          Rename-Item publish/win-x64/PRism.Web.exe PRism-win-x64.exe
          Rename-Item publish/osx-arm64/PRism.Web    PRism-osx-arm64
          Write-Host "win-x64 size:   $((Get-Item publish/win-x64/PRism-win-x64.exe).Length / 1MB) MB"
          Write-Host "osx-arm64 size: $((Get-Item publish/osx-arm64/PRism-osx-arm64).Length / 1MB) MB"
        shell: pwsh

      - name: Create draft Release
        uses: softprops/action-gh-release@<commit-sha>   # softprops/action-gh-release v2.x — SHA-pinned per supply-chain discipline
        with:
          tag_name: ${{ github.event.inputs.tag }}
          name: PRism ${{ github.event.inputs.tag }}
          draft: true
          generate_release_notes: true
          files: |
            publish/win-x64/PRism-win-x64.exe
            publish/osx-arm64/PRism-osx-arm64
```

The Release is created as a **draft** so the maintainer can verify both binaries run on their target OS before promoting to published. Promotion is a manual click in the GitHub Releases UI.

### 7.4 Binary size measurement

Workflow logs each binary's size. Maintainer records the actual numbers in the README's Download section after the first publish:

> PRism v0.1.0 binaries:
> - Windows x64: ~113 MB
> - macOS ARM64: ~108 MB

Spec budget per `02-architecture.md` § Distribution: ≤150MB. Expected range with React + Mermaid + react-diff-view assets: 100–130MB.

If the budget is exceeded, options (P4 backlog): AOT publish (drops to 30–50MB but requires source-generator JSON + reflection-free DI; substantial refactor), drop Mermaid bundle (loses diagram rendering — DoD line; not viable), separate frontend hosted from CDN (breaks local-first principle; not viable). The investigation is deferred per spec M20.

### 7.5 First-run trust copy on Setup screen

Update `frontend/src/components/Setup/SetupForm.tsx` to add a collapsible "First run on this machine?" disclosure below the existing PAT generation steps but above the paste field.

Platform detection: `navigator.platform` is the primary signal (deprecated but still functional and supported everywhere). Fallback: render both blocks if detection fails or returns an unrecognized string.

```tsx
function detectPlatform(): 'windows' | 'macos' | 'unknown' {
  const p = navigator.platform.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'unknown';
}

function FirstRunDisclosure() {
  const [open, setOpen] = useState(false);
  const platform = detectPlatform();
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>First run on this machine?</summary>
      {(platform === 'windows' || platform === 'unknown') && (
        <section>
          <h3>Windows</h3>
          <p>The first time you run PRism, Windows shows a SmartScreen warning
             ("Windows protected your PC") because PRism isn't code-signed for
             the PoC. Click <strong>More info</strong>, then <strong>Run anyway</strong>.
             Code signing arrives post-PoC.</p>
        </section>
      )}
      {(platform === 'macos' || platform === 'unknown') && (
        <section>
          <h3>macOS</h3>
          <p>If macOS Gatekeeper blocks the binary, right-click the app and pick
             <strong> Open</strong> the first time. The first time PRism reads
             your token, macOS asks <strong>Allow / Always Allow / Deny</strong> —
             click <strong>Always Allow</strong> so you aren't asked again.
             Code signing arrives post-PoC.</p>
        </section>
      )}
    </details>
  );
}
```

The disclosure defaults to closed. First-runners see the summary "First run on this machine?" and expand if they hit a warning; return users (most cases) skip it. Spec § 13 (DoD line 121) explicitly requires the SmartScreen and Keychain copy on Setup.

**Browser-default `<details>` styling is acceptable.** The native `<details>` element renders with the browser's default chevron and animation; the result will not match the rest of the product's token-derived design language. Accepted deliberately for this surface — the first-run disclosure is a transient, first-runners-only artifact; cross-browser custom styling of `<details>` requires CSS that handles the marker pseudo-element differently on each browser, and the maintenance cost outweighs the visual polish gain. If a future slice promotes the disclosure to a more prominent surface, it can switch to a custom `<DisclosureGroup>` component at that point.

### 7.6 Tests

The publish workflow itself is verified by:
- Maintainer dispatches the workflow with a test tag (e.g., `v0.0.1-test`) → draft Release attached with both binaries → maintainer downloads both → runs on Windows + macOS → verifies first-run flow works as documented in § 7.5.

The first-run copy is verified by:
- Vitest unit test: `FirstRunDisclosure` renders the Windows block when `navigator.platform === 'Win32'`.
- Vitest unit test: renders the macOS block when `navigator.platform === 'MacIntel'`.
- Vitest unit test: renders both blocks when `navigator.platform === ''`.

No e2e for the publish workflow itself — CI minutes are expensive and the workflow runs maybe 5 times in the PoC lifetime. Manual verification per dispatch is the right cadence.

**Supply-chain hygiene for the workflow.** Add a `.github/dependabot.yml` entry for `package-ecosystem: "github-actions"` so Dependabot opens PRs when the pinned actions release new versions. The maintainer reviews and approves each bump — the SHA pin is what makes the workflow safe; Dependabot is the tooling that keeps the pin current without manual hunting.

---

## 8. Viewport screenshot regression test

### 8.1 Goal

DoD line 131 (`01-vision-and-acceptance.md`):
> No layout shift when a PR with new commits arrives (banner appears without pushing content). **Verification**: a Playwright/Cypress test captures viewport screenshots before and after a simulated banner trigger; bytes-equal except in the banner's reserved sticky region.

### 8.2 Spec

New file `frontend/e2e/no-layout-shift-on-banner.spec.ts`.

```ts
test('PR detail viewport bytes-equal before and after banner trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Seed: PR loaded into PR detail view via existing test hooks.
  await page.goto('/pr/owner/repo/123');
  await page.locator('[data-testid="pr-header"]').waitFor();

  // Disable animations to remove pixel drift sources.
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }'
  });

  // Mask the banner's sticky region (top 48px under the header).
  const bannerRegion = { x: 0, y: 56, width: 1440, height: 48 };

  // Baseline.
  await expect(page).toHaveScreenshot('pr-detail-before-banner.png', {
    mask: [page.locator('[data-testid="reload-banner"]')],
    maxDiffPixelRatio: 0.001,
  });

  // Trigger banner via existing S5 test hook.
  await page.request.post('/test/advance-head', {
    data: { prRef: 'owner/repo/123', newHeadSha: 'feed...' },
  });

  // Wait for banner to appear.
  await page.locator('[data-testid="reload-banner"]').waitFor({ state: 'visible' });

  // Compare against the same baseline; banner is masked.
  await expect(page).toHaveScreenshot('pr-detail-before-banner.png', {
    mask: [page.locator('[data-testid="reload-banner"]')],
    maxDiffPixelRatio: 0.001,
  });
});
```

The masking approach uses Playwright's built-in `mask` option on `toHaveScreenshot` — pixels under the masked locator are not compared. Both calls use the same baseline filename so the second call asserts equality against the first.

### 8.3 Caveats

- **Platform scope**: CI runs on `windows-latest` → screenshots are Windows-only. macOS gets a manual-verify checkbox in the publish checklist (run the spec locally on macOS before each release). Cross-platform pixel comparison is impossible due to font-hinting differences; the test catches *layout* regressions, not rendering drift.
- **Animation disablement**: required to avoid in-flight animation pixels at capture time.
- **Anti-aliasing tolerance**: `maxDiffPixelRatio: 0.001` absorbs sub-pixel rendering noise (~1300 pixels out of 1.3M).
- **Baseline storage**: Playwright stores baselines under `frontend/e2e/__screenshots__/`. First run creates the baseline; CI fails if no baseline exists, so the first PR shipping this test must include the baseline.

### 8.4 Tests

The screenshot regression test IS the test. No meta-tests.

---

## 9. README updates

### 9.1 Status section graduation

When the first Release lands (post-publish-workflow-dispatch), update from:

> ## Status
>
> Implementation in progress. S0+S1 (foundations), S2 (inbox read), S4 (drafts + composer), and S5 (submit pipeline) have shipped... [long status]

To:

> ## Status
>
> **Released.** Download PRism v0.1.0 — [Windows](link) / [macOS Apple Silicon](link). See `docs/roadmap.md` for slice history; `docs/specs/README.md` for spec index.

The maintainer edits this manually after dispatching the publish workflow and verifying the binaries; this is the *last* PR in the slice (PR9 per § 13) so the Release tag is known.

### 9.2 New "Download and first run" section

Inserted as the first user-facing section, immediately after the project description:

```markdown
## Download and first run

Download the binary for your platform from the [Releases page](link):
- **Windows x64**: `PRism-win-x64.exe`
- **macOS Apple Silicon**: `PRism-osx-arm64`

### Windows

Double-click the `.exe`. Windows shows a SmartScreen warning because PRism isn't code-signed for the PoC. Click **More info → Run anyway**.

### macOS

Double-click the binary. If Gatekeeper blocks ("can't be opened because Apple cannot check it for malicious software"), right-click → **Open** instead. The first time PRism reads your token from the keychain, macOS asks **Allow / Always Allow / Deny** — click **Always Allow**.

### Generate a GitHub Personal Access Token

PRism authenticates to GitHub with a PAT you generate at <https://github.com/settings/personal-access-tokens/new>. Required scopes (fine-grained PAT):

- Pull requests: **Read and write**
- Contents: **Read**
- Checks: **Read**
- Commit statuses: **Read**

(Metadata: Read is auto-included.) Paste the PAT into the Setup screen on first launch.
```

### 9.3 Development workflow and pre-push checklist

Keep as-is. No changes.

### 9.4 New "Troubleshooting" section

Added below Process (the outer fence uses four backticks because the example itself contains a triple-backtick code block):

````markdown
## Troubleshooting

### Recovering a lost draft

PRism writes a forensic event log at `<dataDir>/state-events.jsonl` (rolling, 30 files × 10 MB cap = ~300 MB ceiling). Every `DraftSaved` event includes the full body markdown at the time of explicit save (`Cmd/Ctrl+Enter`, "Save draft" button, etc.). To recover a lost draft:

```
grep 'DraftSaved' "<dataDir>/state-events.jsonl"* | grep 'owner/repo/123'
```

If recent events are missing, check `<dataDir>/logs/` for `event-loss warning` entries — these signal a window where the forensic log was unable to write (disk full or similar).

### Replace token

The Settings page has a **Replace token** link in the Auth section. Clicking it walks you through pasting a new PAT and validates it before swapping. If your new token authenticates as a different GitHub login than the previous one, PRism:

- Preserves all draft text across every PR ("the reviewer's text is sacred").
- Clears the GraphQL Node IDs that were owned by the prior login (`pendingReviewId`, draft `threadId`, reply `replyCommentId`).
- The next time you submit a review on an affected PR, PRism's foreign-pending-review modal handles any orphan pending reviews the prior login left on GitHub.

Drafts for PRs your new token cannot access remain in `state.json` invisibly. They re-surface if access is later restored.
````

### 9.5 New "Configuration" pointer

Brief pointer below Troubleshooting:

```markdown
## Configuration

User preferences live in `<dataDir>/config.json`. The full schema is documented in [`docs/spec/02-architecture.md`](docs/spec/02-architecture.md) § Configuration schema. Editor saves are hot-reloaded; invalid configs surface a toast and fall back to documented defaults.
```

---

## 10. v2 multi-account touch-point register

The multi-account storage scaffold (`2026-05-10-multi-account-scaffold-design.md`, shipped) committed the on-disk shape for v2 multi-account but explicitly deferred interface and wire shapes. This slice introduces single-account-shape code that v2's multi-account brainstorm will revisit. The register below enumerates every touch-point so v2 inherits a starting list.

| S6 surface | v1 single-account shape | v2 generalization | Reversal cost |
|---|---|---|---|
| `POST /api/auth/replace` (§ 3.5) | Replaces THE token | Accepts `accountKey` param OR new per-account endpoint (`/api/accounts/{key}/replace`); old endpoint deprecates | Endpoint-shape change |
| Identity-change rule (§ 3.2) | Iterates `Accounts[default].Reviews.Sessions` via `state.Reviews` delegate | Parameterized by `accountKey`; only clears Node IDs for that account's sessions | Mechanical: replace `state.WithDefaultReviews` with `state.WithAccountReviews(accountKey, ...)` |
| `IViewerLoginProvider.Set(login)` | Single-value provider | Per-account: `SetForAccount(accountKey, login)` and `GetForAccount(accountKey)` | Interface signature change + every call site (8–10 sites total) |
| `IActivePrCache.Clear()` (§ 3.3) | Evicts all entries globally | `ClearForAccount(accountKey)`; cache key shape grows from `PrRef` to `(accountKey, PrRef)` | Cache key shape change + identity-change rule call site |
| `SubmitLockRegistry.AnyHeld()` (§ 3.5) | Global check | `AnyHeldForAccount(accountKey)`; lock key becomes `(accountKey, PrRef)` because the same PR could be reachable via two different accounts | Lock key shape change + `/api/auth/replace` call site |
| `state-changed` SSE event with `fieldsTouched: ["identity-change"]` (§ 3.3) | No account scope | Adds `accountKey` payload field | Wire-shape extension (additive — old consumers ignore the field) |
| Settings page Auth section (§ 2.2) | Single global "Replace token" link | Per-account row with per-row Replace button; "Add account" / "Remove account" affordances | UI redesign of one section; no other Settings sections affected |
| Forensic `IdentityChanged` event (§ 3.6) | Payload includes `accountKey: "default"` already | v2 reads the field as the real account key; schema unchanged | No migration needed — v1 emits the schema-compatible shape |
| First-run trust copy (§ 7.5) | No multi-account interaction | No change — first-run copy is platform-shaped, not account-shaped | n/a |
| Cheatsheet shortcuts (§ 4) | No account interaction | No change | n/a |
| LoadingScreen (§ 5) | No account interaction | No change | n/a |
| Viewport screenshot test (§ 8) | No account interaction | No change | n/a |

**Posture summary.** Every row above is a single-method API surface change or wire-shape extension, not a "rip out the module" refactor. The multi-account storage scaffold spec's bet — irreversible storage shape now, reversible interfaces in v2 — pays off here because S6 keeps the reversible bits reversible.

**Binding constraints v1 inherits from the storage scaffold spec § 7 that S6 must respect.**

- `accountKey` is an arbitrary opaque string within an allowlist (`[a-zA-Z0-9_-]`, max 64). S6 hardcodes `"default"` which trivially satisfies this. New code introduced in S6 that *displays* an account key (e.g., the forensic event payload, the future Settings per-account section) MUST treat the value as opaque text, not parse or split it.
- No-silent-fallback. S6 doesn't route across accounts (there's only one), but the surfaces v2 will multi-account-ify (Replace token, Settings Auth section) must not in their v2 form silently pick an account when multiple could apply — prompt explicitly. The S6 UI shapes are compatible: a per-account-row layout is the right v2 shape and the v1 single-row UI is a degenerate case of that.

---

## 11. Tests (consolidated)

### 11.1 Backend unit (`PRism.Web.Tests`)

- `/api/auth/replace`:
  - Happy path, same login (case-sensitive match) → `identityChanged === false`; no mutation.
  - Happy path, same login (case-insensitive: `Alice` → `alice`) → `identityChanged === false`.
  - Happy path, different login → `identityChanged === true`; every session's Node IDs cleared; every draft body preserved; forensic event recorded with correct counts.
  - Validation failure → `RollbackTransientAsync` invoked; no commit; no state mutation; no forensic event.
  - `SubmitLockRegistry.AnyHeld() === true` → 409; transient rolled back (or never written); no commit; no state mutation.
- `/api/submit/in-flight`:
  - Empty registry → `{ inFlight: false }`.
  - One lock held → `{ inFlight: true, prRef: <ref> }`.
  - Multiple locks held → `{ inFlight: true, prRef: <one-of> }`.
- `ConfigStore.PatchAsync`:
  - Existing `ui.*` keys still accepted (back-compat).
  - New dotted keys (`inbox.sections.*`) accepted and persisted to correct sub-record.
  - Unknown dotted keys → `ConfigPatchException` → 400.
  - Multi-field patches still rejected.

### 11.2 Backend unit (`PRism.Core.Tests`)

- `IActivePrCache.Clear()` evicts every entry; subsequent reads miss.
- `ActivePrSubscriberRegistry.RemoveAll()` removes every subscription; both `_bySubscriber` and `_byPr` are empty afterward.
- Forensic `IdentityChanged` event payload shape: `accountKey: "default"`, counts match the cleared content.

### 11.3 Frontend unit (Vitest)

- Settings page renders all four sections.
- Toggling each inbox section POSTs `inbox.sections.<key>: <bool>` (single-field shape).
- Settings GitHub section renders the host + `configPath` link.
- Replace button disables when `useSubmitInFlight()` returns `inFlight: true`.
- `useCheatsheetShortcut`: `?` outside composer toggles; inside composer does not.
- `useCheatsheetShortcut`: `Cmd/Ctrl+/` toggles regardless of focus.
- `useCheatsheetShortcut`: `Esc` on open cheatsheet calls `stopPropagation`.
- `<LoadingScreen>`: watermark + pulse logo both `aria-hidden="true"`; label inside `role="status"`.
- `FirstRunDisclosure`: renders Windows block for `Win32`, macOS block for `MacIntel`, both for unknown.

### 11.4 Frontend e2e (Playwright)

- `e2e/settings-flow.spec.ts`: toggle every Settings field, observe persistence across reload.
- `e2e/replace-token-same-login.spec.ts`: Replace with same login → no toast; no state mutation visible.
- `e2e/replace-token-different-login.spec.ts`: Replace with different login (fixture-controlled) → toast surfaces; drafts visible on subsequent PR-detail visits.
- `e2e/replace-token-submit-in-flight.spec.ts`: Replace while submit fixture-locked → 409; inline error; old token still authoritative.
- `e2e/cheatsheet.spec.ts`: open via `?`, `Cmd/Ctrl+/`; close via `Esc`; composer focus preservation; `Cmd/Ctrl+R` with overlay open.
- `e2e/a11y-audit.spec.ts`: axe-core run on every page; zero serious/critical violations.
- `e2e/no-layout-shift-on-banner.spec.ts`: viewport bytes-equal pre/post banner.

### 11.5 Manual verification (publish + dogfood)

- Dispatch `publish.yml` with a test tag; download both binaries.
- Run `PRism-win-x64.exe` on a Windows machine; verify SmartScreen flow + Setup first-run copy.
- Run `PRism-osx-arm64` on macOS Apple Silicon; verify Gatekeeper right-click → Open + Keychain "Always Allow" flow.
- Tab through every page on each OS; verify focus rings.
- Run VoiceOver pass on macOS per § 6.1 Pass 3.

---

## 12. Project standards updates

Changes accompany the implementing PRs (per `.ai/docs/documentation-maintenance.md`):

- **`docs/spec/03-poc-features.md` § 11 "Settings"** — amend "No Settings UI in PoC" header to describe the page that just shipped. Document that Settings hosts theme/accent/AI preview/inbox section visibility/host display/Replace token, and that polling cadences / logging level / event-log retention remain file-only. Reference this spec.
- **`docs/spec/03-poc-features.md` § 9 "Keyboard shortcuts"** — no content change; the existing table is the source of truth. Cross-reference the cheatsheet implementation under `frontend/src/components/Cheatsheet/`.
- **`docs/spec/03-poc-features.md` § 13 "Accessibility baseline"** — no content change; add a footnote that S6 closes each bullet with evidence per the implementation plan.
- **`docs/spec/02-architecture.md` § Distribution** — note the `publish.yml` workflow as the canonical publish path; binary size measurement lives in the README's Download section.
- **`docs/roadmap.md` S6 row** — flip to "Shipped" with PR references at the end of the slice.
- **`docs/specs/README.md`** — move this spec entry to the Implemented section once the last PR merges.
- **`README.md`** — per § 9 of this spec (graduation, Download section, Troubleshooting).
- **Asset duplication contract** — add a short note to `assets/icons/README.md` (or to a new top-level doc note) that frontend uses copies at `frontend/public/{prism-logo.png, favicon.ico}`; when canonical icons change, re-copy.

---

## 13. PR cut

Single slice, nine-PR plan. Sequencing respects dependencies; orthogonal PRs can land in either order.

| PR | Scope | Depends on | Notes |
|---|---|---|---|
| **PR1** | Backend: `ConfigStore.PatchAsync` allowlist extension + richer `/api/preferences` GET shape + `/api/submit/in-flight` endpoint. | none | xUnit tests for every new allowlist branch + endpoint shape. |
| **PR2** | Backend: `/api/auth/replace` endpoint + identity-change rule + `IActivePrCache.Clear()` + `SsePerPrRegistry.UnsubscribeAll()` + forensic `IdentityChanged` event with `accountKey: "default"` carry-forward. | PR1 (uses in-flight check internally) | xUnit tests for every identity-change branch + forensic shape + cache eviction. |
| **PR3** | Frontend: Settings page (`/settings` route, four section components, `usePreferences` hook extension). | PR1 (richer GET shape) | Vitest + Playwright `settings-flow.spec.ts`. |
| **PR4** | Frontend: Replace token UX — footer link, lazy-swap flow, route gating on `?replace=1`, multi-tab `state-changed` reaction. | PR2 (uses new endpoint) | Playwright same-login / different-login / submit-in-flight specs. |
| **PR5** | Frontend: Cheatsheet overlay + shortcut handlers (`useCheatsheetShortcut`, `<CheatsheetProvider>`, `<Cheatsheet>`, `shortcuts.ts`, `data-composer="true"` markers on existing composers). | none | Vitest hook tests + Playwright `cheatsheet.spec.ts`. |
| **PR6** | Frontend: icon assets (asset copy step, `frontend/public/prism-logo.png`, favicon update, Header `<Logo>` swap) + `<LoadingScreen>` component + integration into App.tsx and SetupPage.tsx. | none | Vitest unit tests for `<LoadingScreen>`. |
| **PR7** | A11y audit fixes (cross-cutting touches to Header, Inbox, PR detail, Settings, Cheatsheet, LoadingScreen) + new `e2e/a11y-audit.spec.ts` + axe-core CI integration. | PR3, PR5, PR6 (audit covers their surfaces) | The Playwright spec fails the build on any new serious/critical violation. |
| **PR8** | `publish.yml` workflow + `PRism.Web.csproj` publish properties + first-run trust copy in `SetupForm.tsx` + `FirstRunDisclosure` component. | none | Manual: dispatch workflow once with a test tag; verify both binaries on both OSes. |
| **PR9** | Viewport screenshot regression test (`e2e/no-layout-shift-on-banner.spec.ts`) + README graduation + spec doc updates (`02-architecture.md`, `03-poc-features.md` § 11, `docs/roadmap.md`, `docs/specs/README.md`). | PR8 (Release exists for the README to link) | Final PR — flips slice status to Shipped. |

**Sequencing notes:**
- PR1 and PR2 are backend-only and can land in either order; PR2 internally uses PR1's `/api/submit/in-flight` so landing PR1 first is the cheaper sequencing.
- PR5, PR6, PR8 are independent of everything else and can land in any order.
- PR7 should land AFTER PR3 + PR5 + PR6 so the audit sees the final surfaces.
- PR9 lands LAST — the README Status section update references the Release tag, which is produced by PR8's workflow dispatch.

---

## 14. Open questions

(Few because the design is well-pinned. Spec self-review checks for placeholders, contradictions, ambiguity, and scope.)

1. **Frontend platform detection for first-run trust copy.** `navigator.platform` is deprecated; `navigator.userAgentData.platform` is the modern API with spotty support. The spec uses `navigator.platform` with the "unknown → render both blocks" fallback. Decide during writing-plans whether to add a `userAgentData` probe first and fall through to `platform`, or stay with the simpler single-source approach. Default: single-source `navigator.platform`.

2. **Release draft vs prerelease vs published.** The workflow creates a draft Release. Alternative: `prerelease: true` so the Release appears immediately under the "Pre-releases" tab without manual promotion. Default: draft (more cautious — maintainer verifies binaries before any user sees them).

I'll commit to defaults during writing-plans unless you pull on either.
