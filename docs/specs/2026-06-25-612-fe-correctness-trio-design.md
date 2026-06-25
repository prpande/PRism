# #612 — Frontend correctness (accent fallback + draft-session refetch guard)

**Issue:** [#612](https://github.com/prpande/PRism/issues/612) · **Tier:** T2 · **Risk:** hands-off
**Status:** spec for two independent, prescribed correctness fixes surfaced by the epic #317 follow-on sweep. Each has a single clear cause, an exact remedy, and a checkable acceptance criterion. No new behavior; no design choice.

## Scope note — Defect A dropped from this PR

The issue bundled a third defect, **A (HostChangeModal "Revert" dead-ends the modal)**, with a prescribed `void refetch()` fix "symmetric with onContinue." `ce-doc-review` (adversarial + security personas) and a direct source read **falsified that fix**:

- `AuthEndpoints.cs:152-158` — the `revert` branch calls `lifetime.StopApplication()` (process exit) and **mutates no host state** (the code comment notes revert "cannot mutate config" yet — `ConfigStore.PatchAsync` only allows `ui.*`).
- `/api/auth/state` derives `hostMismatch` from `LastConfiguredGithubHost != configHost` (`AuthEndpoints.cs:33-39`). Since revert changes neither side, a post-revert refetch returns `hostMismatch` **still set** (modal stays) — or fails against the draining server, surfacing the "Couldn't load auth state" error modal.

So the prescribed fix cannot satisfy its own acceptance criterion ("modal closes"), and the issue's matching test mock (`/api/auth/state → hostMismatch: null`) encodes a response the backend never produces for revert. The correct fix is a **gated UX change** (consume `HostChangeExiting.Exiting` → show a "restarting to revert…" terminal state), and revert is a half-built feature (can't yet mutate config). Per owner decision, **A is dropped from this PR**, documented on #612, and tracked as a separate issue. This spec covers **B and C only**.

## Why one PR

Two defects, two files, no shared code — bundled because they are the clean
frontend slice of one correctness sweep and each is too small to justify its own
PR + CI cycle. Independently revertable (separate commits).

## Defect B — `applyThemeToDocument` throws on an accent outside the enum

`frontend/src/utils/applyTheme.ts:3-7,26-28`. `ACCENT_HUES` maps only
`indigo|amber|teal`; `const hue = ACCENT_HUES[accent]` is `undefined` for any
other string and `String(hue.h)` throws. This is **asymmetric** with the sibling
appliers in the same file — `applyDensityToDocument` /
`applyContentScaleToDocument` carry an explicit comment that the wire shape is
validated by ConfigStore for type only, not enum membership (plan Deviation 6),
and fall back to a default. The throw fires inside `AppearanceSync`'s boot effect,
so an out-of-band `config.json` edit or FE/backend version skew
(`accent:"purple"`) crashes the appearance-sync path.

**Fix:** fall back to the default indigo hue (indigo is the documented default —
`tokens.css:76`). Because `ACCENT_HUES` is typed `Record<Accent, …>`, TypeScript
treats the lookup as total, so a bare `ACCENT_HUES[accent] ?? ACCENT_HUES.indigo`
is type-vacuous (the `??` branch is dead, and eslint `no-unnecessary-condition`
would flag it). Make the fallback reachable by typing the *lookup* as partial
while keeping the direct `.indigo` access total:

```ts
const hue =
  (ACCENT_HUES as Partial<Record<Accent, { h: number; c: number }>>)[accent] ??
  ACCENT_HUES.indigo;
```

A comment notes the same wire-validation rationale as the density/contentScale
siblings. **No `console.warn` breadcrumb** — kept silent for parity with the
sibling appliers (the diagnostic-on-corruption question is a latent gap across all
three appliers, out of scope for this fix).

**Acceptance:** `applyThemeToDocument('system', 'purple' as Accent)` sets the
indigo hue/chroma and does not throw. Known accents still map to their own hues.

## Defect C — `useDraftSession.refetch` clobbers a different PR's session

`frontend/src/hooks/useDraftSession.ts:112-123`. The mount effect guards its async
resolution with a `cancelled` flag (lines 136-152); the imperative `refetch` does
not. It awaits `getDraft(prRef)` then unconditionally
`setSession(mergeSession(sessionRef.current, server, …))` / `setStatus('ready')`.
`refetch` is wired to SSE subscribers and `useReconcile.onReloadComplete`. If a
refetch for PR-A is in flight when the user switches to PR-B, the already-invoked
async body still runs to completion and overwrites PR-B's freshly-loaded session
with PR-A's merged data (merging PR-A's local body against PR-A's server response
under the PR-B mount, via the shared `sessionRef`).

**Fix:** discard a stale refetch result when the active PR changed or the hook
unmounted. The load-bearing guard is the **prRef key**, compared as a primitive
string against a **render-tracked ref** — not the closure's own `prRef` (which is
stale-by-design and would always match) and not object identity (the prRef object
is a fresh literal each render, per the line 122 comment):

```ts
// render-time, next to sessionRef.current = session (line 101). The key uses the
// canonical prRefKey() helper from api/types (the /simplify pass swapped an inline
// owner/repo/number template for it — same format, ~20 shared call sites):
activePrKeyRef.current = prRefKey(prRef);

// in refetch, capture before the await; re-check after (both branches):
const key = activePrKeyRef.current;
const server = await getDraft(prRef);
if (!mountedRef.current || activePrKeyRef.current !== key) return; // drop stale
setSession(mergeSession(sessionRef.current, server, isOpen, setOutOfBandToast));
…
```

`mountedRef` (cleared in an unmount-only cleanup effect) is the **secondary**
backstop for the refetch-after-unmount case (SSE/onReloadComplete firing after
teardown — a React "set state on unmounted component" warning). The key check is
the primary guard; the two are not co-equal.

**Acceptance:** a `refetch` issued for PR-A that resolves *after* the hook
re-renders with PR-B's ref leaves PR-B's session intact (the stale PR-A response
is discarded). Existing same-PR refetch/merge behavior is unchanged.

## Out of scope / non-goals

- **Defect A** — see scope note above; dropped, documented, tracked separately.
- The broader composer-race set (#600–#603) — distinct hooks/paths.
- **Same-PR concurrent refetches.** C's key guard is a *cross-PR* guard only. Two
  refetches for the *same* PR (e.g. an SSE `state-changed` and a reconcile
  `onReloadComplete` firing close together) both pass the key check and both merge
  against `sessionRef.current`, last-writer-wins. This is benign (the merge
  re-reads the freshest local body and keeps open-composer bodies) and is **not**
  closed by this fix — in-flight coalescing/ordering remains tracked under the
  #600–#603 set.
- Broadening the accent enum or adding new accents; adding a diagnostic breadcrumb
  to any of the three appliers.

## Test plan

- **B:** extend `frontend/src/utils/applyTheme.test.ts` — add a `describe` for
  `applyThemeToDocument` asserting (a) the unknown-accent fallback sets the indigo
  hue/chroma and does not throw (cast the bad value `as Accent`, not `as never`),
  and (b) each known accent maps to its own hue. (Red on main: throws.)
- **C:** extend `frontend/__tests__/useDraftSession.test.tsx` — `renderHook` with a
  ref prop, start a controlled (deferred-promise) refetch on PR-A, `rerender` to
  PR-B (whose mount load resolves), then resolve the PR-A refetch and assert PR-B's
  session survives. (Red on main: clobbered.)

Full FE pre-push checklist (`.ai/docs/development-process.md`) before PR.
