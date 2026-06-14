# Surface AI seam failures (503 / timeout) to the user — design

**Issue:** #484 (`area:ai`, `area:frontend`, `needs-design`; milestone `v2 — AI`, epic #423)
**Status:** design — awaiting human review gate (gated: `needs-design`)
**Companion:** #485 (configurable AI timeout + the timeout-specific copy deferred from here)

## Problem

AI seam failures are inconsistently surfaced, and two of the four seams are
**silent**. When an AI request returns `503` (provider error / timeout) or fails
on the network, the user often gets no feedback that AI *tried and failed* — they
cannot tell failure from "AI off" or "nothing to show", and have no way to retry.
This was observed directly in the #414 hunk-annotator live validation: every
`Live` call returned `503` (provider wall-clock timeout) and the UI rendered
nothing — the only signal was a `503` in the browser console.

### Current state (the four AI seams)

| Seam | Where it renders | On failure today | Retry today |
|------|------------------|------------------|-------------|
| Summary | Overview tab (`AiSummaryCard`) | inline error block (`aiSummaryError`) | inline **Regenerate** |
| File-focus | Hotspots tab (`HotspotsTab`) | inline error message (`status:'error'`) | inline **Retry** |
| Hunk annotations | in-diff, Files tab (`AiHunkAnnotation`) | **nothing** — `catch(() => setEntries(null))` | none |
| Draft suggestions | Reconciliation panel (`UnresolvedPanel`) | **nothing** — `catch(() => setEntries(null))` | none |

> Draft-suggestions renders in the reconciliation flow (`UnresolvedPanel`), **not**
> the live comment composer. Its background classification (below) rests on that.

### Backend contract (verified `PRism.Web/Endpoints/AiEndpoints.cs`)

Summary, file-focus, and hunk-annotations each wrap the seam call in
`try/catch (LlmProviderException)` and map provider failure to a **bare**
`Results.StatusCode(503)` (no body); `204` = no-content / not-subscribed / AI off.

**Draft-suggestions is the exception:** its endpoint has **no `try/catch`** — it is
a canned-data seam (Noop/Placeholder) today and returns only `200`/`204`, so it
**cannot `503`** yet. A real suggester would currently surface as `500`, not `503`
(and the file carries a D111 note to add an `IsSubscribed` gate when the real seam
lands). #484 wires draft-suggestions into the *same* report-on-throw mechanism for
uniformity and future-proofing, but in practice **draft-suggestions will not
surface a failure until the real suggester + its `503` mapping land** — that
backend work is **not** #484 (see Deferred).

The api client (`frontend/src/api/client.ts`) throws `ApiError(status, requestId,
body)` on non-2xx and returns `undefined` on `204`, so failure-vs-no-content **is**
distinguishable at the hook layer — the silent hooks just discard it in `.catch`.

## Goals

1. Surface a failure for **every** AI seam — current (all four) and future — through
   **one shared mechanism**, so a new seam inherits failure-surfacing by opting in,
   not by re-implementing `catch(() => null)`.
2. Give the user an **easy Retry** for the failed AI action(s).
3. Never surface a false failure: not for `204`/no-content, AI off, not-subscribed,
   or `401` (auth has its own surface — the #312 re-auth banner).

## Non-goals (explicitly deferred)

- **Timeout-vs-generic failure copy** and the "raise your timeout" pointer → **#485**.
  Logged there with the backend reason-plumbing + copy-upgrade action list. #484
  stays **frontend-only** with honest generic copy. (The actionable payoff of a
  "timed out" label is "raise your timeout", which has no lever until #485 makes
  the timeout configurable.)
- Retiring `ErrorModal` / inline fatal-error states → **#446**.
- The backend `try/catch → 503` + `IsSubscribed` gate for a *real* draft-suggestions
  seam → owned by the future draft-suggestions seam work, not #484.
- Any backend change. #484 reads only what the api client already exposes.

## Delivery principle

Delivery mode is chosen by **whether the user is necessarily anchored to the
failing container**, not by who triggered the work:

- **Background** — the user can navigate to other tabs / keep working while the AI
  runs. Its failure must **follow them** → a global, **persistent**, coalesced
  toast with Retry. This covers all four current seams (summary, file-focus,
  hunk-annotations, draft-suggestions) **and** their regenerate/retry paths (a user
  commonly kicks off a regenerate and wanders off — owner decision).
- **Interactive / inline** — the user is live in that container, blocked on the
  result. **No current seam is in this mode**; it is the forward-looking half (the
  upcoming AI chat turn, an analyse-this-comment action). It adds no implementation
  scope here — it only defines what the toast deliberately does *not* claim, so a
  future interactive seam knows to render inline instead.

Summary and file-focus **keep** their existing inline error blocks. They coexist
with the toast: inline detail if you happen to be on that tab, toast to catch you
if you are elsewhere. The two silent seams (hunk / draft) get the toast only — they
have no natural content region to host an inline block.

## Architecture — `AiFailureProvider` context

A new React context provider, mounted next to `ToastProvider` in `App`, is the
single registry every seam reports to.

```ts
// frontend/src/components/Ai/aiFailure.tsx  (provider + hook)
export type AiSeam = 'summary' | 'file-focus' | 'hunk-annotations' | 'draft-suggestions';

interface AiFailureApi {
  // Report a CURRENT background failure for (prRef, seam). retry re-runs the seam's fetch.
  report: (prRef: PrReference, seam: AiSeam, opts: { retry: () => void }) => void;
  // Clear (prRef, seam) on success / no-content / off / 401 — removes it from the set.
  clear: (prRef: PrReference, seam: AiSeam) => void;
  // Clear ALL failures for a prRef (used when a PR tab is actually closed/unmounted).
  clearPr: (prRef: PrReference) => void;
}
```

- The provider holds a map keyed by `(prRefKey, seam)` → `{ retry }`, for **all
  mounted PR tabs** (see Lifecycle — every keep-alive tab's hooks can report).
- It renders **one** notification for the **active PR's** failed set only, derived
  from `activeKey` (below). When that set is empty — or `activeKey` is null (inbox /
  non-PR route) — nothing renders.

**Why a context, not a wrapper hook or event bus:** the retry **closure** rides the
context cleanly (an event-detail callback is stale-prone); and we avoid rewriting
the tested, intricate summary/file-focus hooks (their stale/regenerate/
`baseShaChanged` logic does not fit a generic wrapper without leaking). The two
*silent* seams (hunk/draft) use a tiny optional helper so they don't hand-roll the
discrimination, but no seam is *forced* onto a wrapper.

### The notification element — provider-owned, not via `useToast`

The existing `useToast` API is append-only (`show` + `dismiss`), auto-dismisses
after 10s, and de-dups on `(kind, message)` — it has **no `update`**, so a changing
coalesced message would either spawn duplicate toasts or fail to mutate in place.
Rather than widen the shared `ToastSpec` with `action` / `sticky` / `update` for a
single consumer, **`AiFailureProvider` renders its own persistent notification
element**, reusing the `Toast` module's visual tokens/styles for consistency. It is:

- **Persistent** — no auto-dismiss timer; stays until Retry succeeds for all, or the
  user dismisses it. (A background failure may not be seen for a minute, and it
  carries the only Retry — a 10s window would strand it.)
- **Single & coalesced** — exactly one element; its message lists the active PR's
  currently-failed seams. It is never pushed N times.
- **Action-bearing** — a **Retry** button and a **Dismiss** button.

Existing `Toast`/`useToast` usage is untouched.

### Seam adoption (per hook — minimal, inside existing `.then/.catch`)

Each hook gains `report` on a genuine failure and `clear` on every non-failure
branch (success, `204`/no-content, off, **and `401`**). The two currently-silent
hooks also gain a retry nonce. Full shape for `useAiHunkAnnotations` /
`useAiDraftSuggestions`:

```ts
const { report, clear } = useAiFailure();
const [retryNonce, setRetryNonce] = useState(0);
const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
// ...inside the effect (deps include retryNonce):
const myNonce = retryNonce;                       // last-write-wins guard (see Retry semantics)
getAiHunkAnnotations(prRef)
  .then((result) => {
    if (cancelled || myNonce !== retryNonce) return;
    setEntries(result);
    clear(prRef, 'hunk-annotations');             // success OR 204→null both clear
  })
  .catch((err) => {
    if (cancelled || myNonce !== retryNonce) return;
    setEntries(null);
    if (err instanceof ApiError && err.status === 401) {
      clear(prRef, 'hunk-annotations');           // 401 → auth banner owns it; do NOT report
    } else {
      report(prRef, 'hunk-annotations', { retry });  // 503 / network / other throws
    }
  });
```

For **summary** and **file-focus**, the hooks already discriminate
`{ok|absent/no-content|error}` and already own a retry/regenerate callback —
adoption is `report(..., { retry/regenerate })` on the `error` branch and
`clear(...)` on the `ok`/`absent`/`no-content` branches, with the same `401` skip
applied where the api wrapper surfaces status. Their inline error state is
untouched. (The summary/file-focus api wrappers currently collapse `401` into
`kind:'error'`; #484 threads `ApiError.status` far enough to skip reporting `401`,
without otherwise changing their inline behaviour.)

## Behaviour

### Coalescing multiple failures

Provider-down on PR open can fail all of summary, file-focus, and hunk-annotations
(and draft-suggestions once it can `503`). Seams that report **synchronously** (same
effect/event tick) fold into one element. A seam that reports **after** the element
already exists **mutates the existing element's message** — it does not spawn a
second element. Result: one notification, message = the active PR's failed-seam set,
never stacked.

### Retry-all + partial recovery

Retry-all invokes every registered `retry()` for the **active** PR. Each seam's retry
bumps its nonce → re-runs its fetch (cached server-side results are served as-is —
token discipline; a re-GET, not a forced re-rank). On completion each seam
independently `clear`s (recovered) or re-`report`s (still failing); the message
updates to the still-failing set; when the set empties the element disappears.

**Stale-resolution guard (last-write-wins).** A pre-Retry request still in flight can
resolve *after* the Retry's request and wrongly re-report a seam the Retry just
cleared. Each hook captures the nonce at fetch start and drops any resolution whose
captured nonce is stale (`myNonce !== retryNonce`), so only the latest attempt's
outcome reaches `report`/`clear`.

### Interaction & accessibility states

- **Retry in-flight.** While any seam's retry is in flight, the Retry button is
  **disabled** and labelled **"Retrying…"**; it re-enables when all in-flight seam
  fetches settle. This prevents double-fire and confirms the click registered.
- **Dismiss.** Hides the element for its *current* failure set. A **new** failure
  reported afterwards — a later PR load, or a Retry that itself `503`s — re-shows it.
  Dismissal does **not** persist across PR navigation.
- **Focus.** On full recovery / dismissal the element is removed; focus moves to the
  active tab's content region (not left on a destroyed button — WCAG 2.4.3).
- **Live region.** The element is a polite live region, but it announces only on
  **(a) first appearance** (set becomes non-empty) and **(b) disappearance** (set
  empties). Intermediate partial-recovery message mutations must NOT re-announce
  (render the mutable seam list outside the announced text node, or hold `aria-live`
  off during the batch settle), so a four-seam recovery does not fire four
  screen-reader announcements.

### Lifecycle / PR scoping (keep-alive aware)

`PrTabHost` keeps **one `PrDetailView` mounted per open tab** and only hides the
inactive ones (`active` prop) so each PR keeps its scroll/sub-tab/draft state. So
"mounted" is **not** "active", and switching tabs does **not** unmount. Therefore:

- **Active PR** is `PrTabHost`'s route-derived `activeKey`
  (`route.valid ? prRefKey(route.ref) : null`) — null on the inbox / any non-PR
  route. The provider tracks this and renders the notification **only** for the
  active prRef's failed set. On a non-PR route nothing renders.
- **Reporting** is keyed by `(prRef, seam)` and may come from any mounted (incl.
  backgrounded) tab. A backgrounded tab's failure is *recorded* but not *shown*
  while its PR is inactive; switching to that PR re-derives and shows it (and
  switching away hides it again) — failures persist with their tab, not the screen.
- **`clearPr`** runs when a PR tab is **actually closed** (removed from `openTabs`) or
  its `PrDetailView` truly unmounts — **not** on tab switch. This is what prevents a
  stale Retry firing against a PR the user has left, given that tab-switch alone
  never unmounts.

### Not reported (no false failures)

`204` / no-content, `!enabled` (AI off), not-subscribed, and `401` are **never**
reported — each maps to `clear`, not `report`. `401` is handled by the #312 re-auth
banner; AI must not double-surface auth.

## Copy

Generic, honest, actionable:

> **AI couldn't generate: {seam list}** — the provider failed or timed out.
> **[ Retry ]  [ Dismiss ]**

Seam display names (kept in sync with their UI labels): `summary` → "summary",
`file-focus` → "hotspots" (matches the **Hotspots** tab), `hunk-annotations` →
"annotations", `draft-suggestions` → "draft suggestions". Timeout-specific copy +
the settings pointer are #485's, once the timeout is tunable.

## Testing

- **Provider unit** (`aiFailure`): N seams reported → one element with all names;
  partial recovery shrinks the message then clears; Retry-all calls every registered
  `retry`; a report from a non-active prRef is recorded but **not** rendered;
  `activeKey === null` renders nothing; `clearPr` removes a closed PR's failures.
- **Hook unit** (the four hooks): `503`/network throw → `report`; `204`/`ok`/off →
  `clear`; **`401` → not reported (still clears)**; stale-nonce resolution is dropped.
  Hunk/draft gain a retry nonce that re-runs the fetch.
- **Component:** summary/file-focus inline error states still render *and* the
  notification appears (coexistence); hunk/draft render nothing inline but the
  notification appears.
- **e2e + visual:** force `503` via Playwright `page.route(... fulfill({status:503}))`
  on the `**/api/pr/.../ai/*` routes (the pattern `ai-gating-sweep.spec.ts` /
  `ai-live-consent.spec.ts` already use — frontend-only, no backend change); assert
  the persistent notification + Retry, the Retrying… disabled state, and that Retry
  clears it on recovery (new visual baseline expected). Assert a backgrounded-tab
  failure does not show while another PR is active.

## Acceptance criteria

- [ ] All four AI seams report `503`/network failures to one shared mechanism; a new
      seam opts in with `report`/`clear` (no per-seam toast plumbing).
- [ ] A single **coalesced, persistent** notification lists the failed seams and
      offers **Retry-all** + dismiss; multiple concurrent failures never stack.
- [ ] Retry re-runs the failed seams; the button shows a disabled "Retrying…" state
      in-flight; partial recovery updates the message; full recovery removes it.
- [ ] A stale pre-Retry resolution cannot re-report a seam the Retry cleared.
- [ ] Summary and file-focus keep their inline error blocks (coexist with the toast).
- [ ] No notification for `204`/no-content, AI off, not-subscribed, or `401`.
- [ ] The notification renders only for the **active** PR (route `activeKey`); a
      backgrounded tab's failure is recorded but not shown; non-PR routes show nothing.
- [ ] Closing a PR tab (or unmounting its `PrDetailView`) clears that PR's failures
      and retries; no stale retry can fire against a PR the user has left.
- [ ] Live region announces only on appearance and disappearance, not on each
      partial-recovery message change.
- [ ] Tests per the section above; visual baselines regenerated from CI.

## Deferred / Open Questions

- **Same-tab toast/inline redundancy (owner call).** `product-lens` and `design-lens`
  both flagged that when the user is *on* the Overview/Hotspots tab, the inline error
  block **and** the toast name the same seam. The owner chose coexistence
  deliberately. Optional refinement for the owner to accept or decline: omit a seam
  from the toast while the user is viewing that seam's tab, so the toast carries only
  what the user cannot currently see. Default (this spec): keep full coexistence.
- **Draft-suggestions real-seam `503` dependency.** Draft-suggestions cannot fail
  with a `503` until the real suggester lands with its own endpoint `try/catch → 503`
  and `IsSubscribed` gate. Until then it is wired into the mechanism but inert. That
  backend work is owned by the draft-suggestions seam effort, not #484.
