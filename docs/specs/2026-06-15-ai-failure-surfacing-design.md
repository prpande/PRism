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
| Draft suggestions | comment composer | **nothing** — `catch(() => setEntries(null))` | none |

Backend (`PRism.Web/Endpoints/AiEndpoints.cs`): every seam maps provider failure
to a **bare** `Results.StatusCode(503)` (no body). `204` = no-content / not
subscribed / AI off. The api client (`frontend/src/api/client.ts`) throws
`ApiError(status, requestId, body)` on non-2xx and returns `undefined` on `204`,
so failure-vs-no-content **is** distinguishable at the hook layer — the silent
hooks just discard it in `.catch`.

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
- Any backend change. #484 reads only what the api client already exposes.

## Delivery principle

Delivery mode is chosen by **whether the user is necessarily anchored to the
failing container**, not by who triggered the work:

- **Background** — the user can navigate to other tabs / keep working while the AI
  runs. Its failure must **follow them** → a global, **persistent**, coalesced
  toast with Retry. This covers all four current seams **and** their
  regenerate/retry paths (a user commonly kicks off a regenerate and wanders off).
- **Interactive / inline** — the user is live in that container, blocked on the
  result (the *upcoming* AI chat turn, analyse-this-comment in the composer).
  Failure stays **in that container**, no toast. (No current seam is in this mode;
  this is the forward-looking half of the mechanism.)

Summary and file-focus **keep** their existing inline error blocks. They coexist
with the toast: inline detail if you happen to be on that tab, toast to catch you
if you are elsewhere. The two silent seams (hunk / draft) get the toast only — they
have no natural content region to host an inline block.

## Architecture — `AiFailureProvider` context (option 1)

A new React context provider, mounted next to `ToastProvider` in `App`, is the
single registry every seam reports to.

```ts
// frontend/src/components/Ai/aiFailure.ts  (provider + hook)
export type AiSeam = 'summary' | 'file-focus' | 'hunk-annotations' | 'draft-suggestions';

interface AiFailureApi {
  // Report a CURRENT background failure for (prRef, seam). retry re-runs the seam's fetch.
  report: (prRef: PrReference, seam: AiSeam, opts: { retry: () => void }) => void;
  // Clear (prRef, seam) on success / no-content / off — removes it from the toast.
  clear: (prRef: PrReference, seam: AiSeam) => void;
  // Clear ALL failures for a prRef (used on PR switch / unmount).
  clearPr: (prRef: PrReference) => void;
}
```

- The provider holds a map keyed by `(prRefKey, seam)` → `{ retry }`. It derives a
  single coalesced toast from the **currently-failed set for the active PR**.
- It renders **one persistent toast** (see "Toast" below) listing the failed seams,
  with one **Retry-all** that invokes every registered `retry()` for the active PR,
  plus dismiss.
- When the failed set for the active PR empties, the toast disappears.

**Why a context, not a wrapper hook or event bus:** the retry **closure** rides the
context cleanly (an event-detail callback is stale-prone); and we avoid rewriting
the tested, intricate summary/file-focus hooks (their stale/regenerate/
`baseShaChanged` logic does not fit a generic wrapper without leaking). New simple
seams use a tiny optional helper (below) so they don't hand-roll discrimination,
but no seam is *forced* onto a wrapper.

### Seam adoption (per hook — minimal, inside existing `.then/.catch`)

Each hook gains `report` on error and `clear` on the non-error branches. Illustrated
for the two currently-silent hooks, which also gain a retry nonce:

```ts
// useAiHunkAnnotations / useAiDraftSuggestions (same shape)
const { report, clear } = useAiFailure();
const [retryNonce, setRetryNonce] = useState(0);
const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
// ...inside the effect, deps include retryNonce:
getAiHunkAnnotations(prRef)
  .then((result) => {
    if (cancelled) return;
    setEntries(result);
    clear(prRef, 'hunk-annotations');   // success OR 204→null both clear
  })
  .catch(() => {
    if (cancelled) return;
    setEntries(null);
    report(prRef, 'hunk-annotations', { retry });
  });
```

For **summary** and **file-focus**, the hooks already discriminate
`{ok|absent/no-content|error}` and already own a retry/regenerate callback —
adoption is `report(..., { retry/regenerate })` on the `error` branch and
`clear(...)` on the `ok`/`absent`/`no-content` branches. Their inline error state is
untouched.

> Distinguishing `503`/network (report) from `401` (do **not** report) uses
> `ApiError.status`. The two silent api wrappers (`api/aiHunkAnnotations.ts`,
> `api/aiDraftSuggestions.ts`) currently `return result ?? null` and let throws
> propagate — the hook's `.catch` already receives the `ApiError`. The hook checks
> `err instanceof ApiError && err.status === 401` and **skips reporting** for auth
> (it still clears any prior failure). All other throws (incl. `503` and network)
> report.

## Toast — persistent, coalesced

The current `Toast` auto-dismisses errors after 10s and de-dups on `(kind, message)`.
A background failure is exactly the case where the user may be on another tab and
miss a 10s window — and the toast carries the **only** Retry. So the AI-failure toast
must be **persistent** (no auto-dismiss; stays until Retry or dismiss).

Decision: extend `ToastSpec` with an optional `action` (`{ label, onClick }`) and an
optional `sticky?: boolean` (suppresses the auto-dismiss timer). The
`AiFailureProvider` owns exactly one such sticky toast and updates its `message` as
the failed-seam set changes — it does **not** push N toasts. This reuses the existing
toast surface (single visual language) rather than introducing the separate
`Snackbar` component.

- `action` = `{ label: 'Retry', onClick: retryAll }`.
- `message` lists the human names of the currently-failed seams, e.g.
  *"AI couldn't generate: summary, hotspots, annotations."*
- Existing non-AI toasts are unchanged (no `sticky`, no `action`).

## Behaviour

### Consolidation (multiple seams fail at once)

Provider-down on PR open can fail all four. The provider coalesces: **one** toast,
listing every currently-failed seam for the active PR. As more seams fail within the
same render cycle they fold into the same toast (the derived message updates); they
never stack as separate toasts.

### Retry-all + partial recovery

Retry-all invokes every registered `retry()` for the active PR. Each seam's retry
re-runs its fetch (cached server-side results are served as-is — token discipline;
this is a re-GET, not a forced re-rank). On completion each seam independently
`clear`s (recovered) or re-`report`s (still failing). The toast message updates to
the still-failing set; when the set empties, the toast disappears.

### Lifecycle / PR scoping

Failures are keyed by `(prRef, seam)`. On navigating to a different PR — or the
`PrDetailView` unmounting — `clearPr(prRef)` runs, so a stale `retry()` can never
fire against a PR the user has left. The active PR is the one `PrDetailView` is
mounted for; the provider only renders a toast for the active PR's failures.

### Not reported (no false failures)

`204` / no-content, `!enabled` (AI off), not-subscribed, and `401` are **never**
reported — each maps to `clear`, not `report`. `401` is handled by the #312 re-auth
banner; AI must not double-surface auth.

## Copy

Generic, honest, actionable:

> **AI couldn't generate: {seam list}** — the provider failed or timed out.
> **[ Retry ]  [ Dismiss ]**

Seam display names: `summary` → "summary", `file-focus` → "hotspots",
`hunk-annotations` → "annotations", `draft-suggestions` → "draft suggestions".
Timeout-specific copy + the settings pointer are #485's, once the timeout is tunable.

## Testing

- **Provider unit** (`aiFailure` provider): N seams reported → exactly one toast
  with all names; partial recovery shrinks the message then clears; `clearPr` on PR
  switch removes the toast; Retry-all calls every registered `retry`.
- **Hook unit** (the four hooks): `503`/throw → `report`; `204`/`ok`/off → `clear`;
  `401` → **not** reported (still clears). Hunk/draft gain a retry nonce that
  re-runs the fetch.
- **Toast unit:** `sticky` suppresses auto-dismiss; `action` renders a button that
  fires `onClick`; non-AI toasts keep the 10s/dedup behaviour.
- **Component:** summary/file-focus inline error states still render *and* the toast
  appears (coexistence); hunk/draft render nothing inline but the toast appears.
- **e2e + visual:** persistent AI-failure toast with Retry on a forced-`503` PR
  (new baseline expected); Retry path clears it on recovery.

## Acceptance criteria

- [ ] All four AI seams report `503`/network failures to one shared mechanism;
      a new seam opts in with `report`/`clear` (no per-seam toast plumbing).
- [ ] A single **coalesced, persistent** toast lists the failed seams and offers
      **Retry-all** + dismiss; multiple concurrent failures never stack.
- [ ] Retry re-runs the failed seams; partial recovery updates the toast; full
      recovery dismisses it.
- [ ] Summary and file-focus keep their inline error blocks (coexist with the toast).
- [ ] No toast for `204`/no-content, AI off, not-subscribed, or `401`.
- [ ] Failures are PR-scoped; switching PRs clears stale failures/retries.
- [ ] `#484` ships frontend-only; the timeout reason/copy is deferred to #485 and
      logged there.
- [ ] Tests per the section above; visual baselines regenerated from CI.
