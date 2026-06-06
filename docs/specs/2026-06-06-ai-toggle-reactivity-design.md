# AI preview toggle reactivity (#221) — design

**Issue:** [#221](https://github.com/prpande/PRism/issues/221) — AI preview toggle doesn't take effect until reload/refetch.
**Tier/Risk:** T2 / hands-off (no `design`/`needs-design` label; reactivity-timing fix, no B2 surface).

> **Approach pivoted post-review.** The first draft proposed a dedicated
> `CapabilitiesContext` (shared store, mirroring #143). The `ce-doc-review`
> adversarial pass surfaced a simpler fix the draft hadn't engaged, and the owner
> chose it given D112 is `DEFER-TO-V1.X` (don't build shared-store infrastructure
> for deferred work). This doc reflects the chosen approach; the shared-store and
> "drop the factor" options are recorded under Alternatives.

## Problem

Toggling **AI preview** (Settings → Appearance) does not take effect immediately on
already-mounted views. The AI-gated features (Inbox Activity/Watching rail and category
chips, PR-detail summary / hunk annotations / pre-submit validators / file focus / Ask-AI /
composer assist / draft reconciliation) only appear after a **reload**, a window
**blur→focus**, or **opening a fresh PR**. The toggle should take effect instantly.

## Root cause (post-#143)

`useAiGate(key) = (capabilities?.[key] ?? false) && (preferences?.ui.aiPreview ?? false)`
reads two hooks:

- `usePreferences()` — **already shared** after #143 (`PreferencesContext`, one app-root
  provider, reactive `set`). Toggling `aiPreview` propagates to every consumer immediately.
- `useCapabilities()` (`frontend/src/hooks/useCapabilities.ts`) — **still module-local
  `useState`**, fetched from `/api/capabilities` on mount + window `focus` only. Every
  consumer holds its **own** copy.

On the wire, capabilities **mirror** `aiPreview` (`CapabilitiesEndpoints.cs:13` returns
AllOn/AllOff from `AiPreviewState.IsOn`; `PreferencesEndpoints.cs:47` mirrors `aiPreview`
into that holder), so `useAiGate(key)` equals `aiPreview` for **every** key today — the
capabilities factor is inert forward-compat scaffolding (deferral **D112**, `DEFER-TO-V1.X`).

The toggle handler (`AppearancePane.tsx:48-52`) does `set('aiPreview', next).then(() =>
refetchCapabilities())`, but `refetchCapabilities` only refreshes **AppearancePane's own**
capabilities instance. Net effect:

- **Toggle OFF** is already instant — `aiPreview` (the reactive AND-factor) flips to
  `false`, and `false && anything === false` closes every gate immediately.
- **Toggle ON still lags** — `aiPreview` flips to `true` everywhere, but every *other*
  consumer's `capabilities` stays the stale `AllOff` snapshot (a populated object, so a
  `?? true` fallback would not rescue it) until its own mount/focus, so `useAiGate` stays
  `false`.

Verified by a red-on-main repro: two `useAiGate` consumers under one `PreferencesProvider`;
toggling `aiPreview` on leaves the second consumer's gate closed.

## Approach (chosen): derive capabilities from the shared preference

Because capabilities currently mirror `aiPreview`, make `useCapabilities()` **derive** its
value from the already-shared, reactive `usePreferences()` instead of doing an independent
per-instance `/api/capabilities` fetch:

```ts
// frontend/src/hooks/useCapabilities.ts
export function useCapabilities() {
  const { preferences, error } = usePreferences();
  const capabilities = preferences
    ? (preferences.ui.aiPreview ? ALL_ON : ALL_OFF) // AllOn/AllOff, mirroring the wire
    : null;
  return { capabilities, error, refetch: async () => {} };
}
```

- Every `useAiGate` consumer now derives capabilities from the **one shared** preferences
  source, so a toggle re-renders all of them immediately — no reload, focus, or remount.
- **One** round-trip on toggle-ON (the prefs POST); the frontend no longer calls
  `/api/capabilities` at all (the value is derived). This is *snappier* than a shared-store
  refetch, which would need a second round-trip.
- `useAiGate.ts` is **unchanged** (keeps the two-factor `capabilities[key] && aiPreview`
  shape and the typed-key API), so all 7 of its unit tests and every consumer test that
  mocks `useCapabilities` keep passing — the return shape `{ capabilities, error, refetch }`
  is preserved.
- `refetch` becomes a no-op (nothing to refetch); `AppearancePane`'s
  `.then(() => refetchCapabilities())` is dropped so the toggle handler is just
  `set('aiPreview', next)`.

### Why derive, not "drop the capabilities factor" or "build a shared store"

- **Drop the factor** (`useAiGate` returns `aiPreview`) is equivalent in behavior but rips
  out the typed two-factor gate, forces a rewrite of `useAiGate`'s narrowing tests, orphans
  `useCapabilities`, and trips eslint (unused `key` param — the repo has no
  `argsIgnorePattern`). Deriving achieves the same outcome with a one-file footprint.
- **Shared-store `CapabilitiesContext`** (approach A, mirror of #143) is the *right* fix
  **when capabilities become independently meaningful** — but that is D112 (`DEFER-TO-V1.X`).
  Building provider + store + fallback now is infrastructure for deferred work (YAGNI).

Both deriving and dropping bake in today's "capabilities mirror `aiPreview`" assumption;
**D112 is the documented reopener** — when the backend stops mirroring, swap
`useCapabilities` back to an independent reactive source (the deferred shared store). The
D112 deferral note is updated to record that #221 made the frontend derive (so decoupling is
no longer purely backend-only).

## Acceptance criteria

- [ ] Toggling AI preview updates **already-mounted** `useAiGate` consumers immediately — no
      reload, window blur/focus, or fresh-PR remount. (Regression test: a second consumer
      reflects the toggle without any focus/remount event. Red on main, green on head, same
      test.)
- [ ] Toggle-ON opens the gate within a **single** round-trip (the prefs POST); no
      `/api/capabilities` GET is issued by the frontend.
- [ ] `useAiGate`'s existing unit tests and all consumer tests that mock `useCapabilities`
      remain green unchanged (return shape preserved).
- [ ] Out-of-provider renders still work (a consumer with no `PreferencesProvider` derives
      `null` capabilities via the existing lenient `usePreferences` fallback — no throw).

## Test plan (TDD)

- **Regression (red→green):** two `useAiGate` consumers + a toggler under
  `PreferencesProvider`; assert the non-triggering consumer flips `off`→`on` after the
  toggle, with no focus/remount. The committed test runs unchanged on main (per-instance
  capabilities fetch → stays `off` → RED) and on head (derived from shared prefs → GREEN).
  `apiClient` is mocked with a stateful prefs POST; the `/api/capabilities` GET is mocked too
  (called on main, unused on head).
- **No-fetch:** assert toggling does not call `apiClient.get('/api/capabilities')` on head.
- **Derive mapping:** `useCapabilities` returns `AllOn` when `aiPreview` is true, `AllOff`
  when false, `null` before preferences load.

## Alternatives rejected

- **A — dedicated `CapabilitiesContext` shared store (mirror #143):** correct shape for
  D112, but premature infrastructure for `DEFER-TO-V1.X` work; needs a 2nd round-trip on
  toggle-ON.
- **Drop the capabilities factor in `useAiGate`:** behavior-equivalent but larger blast
  radius (test rewrite, orphaned hook, eslint unused-param).
- **B — fold capabilities into `PreferencesContext`:** couples two distinct endpoints and
  bakes in the coupling D112 intends to remove.
- **C — module-level singleton via `useSyncExternalStore`:** diverges from the codebase's
  context convention; leaks state across tests.

## Risks / notes

- **Mirror assumption is now explicit on the frontend.** `useCapabilities` derives
  `AllOn/AllOff` from `aiPreview`. This is true today (verified against
  `CapabilitiesEndpoints.cs`); **D112** is the reopener — restore an independent reactive
  capabilities source when the backend stops mirroring. Update the D112 deferral note.
- **`/api/capabilities` becomes frontend-unused.** The backend endpoint stays (cheap, ready
  for D112); only the frontend stops calling it.
- `useAiGate.ts` deliberately untouched so its forward-compat two-factor shape and tests
  survive — the fix is entirely in the capabilities data source.
