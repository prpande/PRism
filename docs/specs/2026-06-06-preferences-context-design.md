# PreferencesContext — dedup the per-consumer preferences fetch

- **Issue:** [#143](https://github.com/prpande/PRism/issues/143) — *usePreferences fires multiple parallel GETs per focus*
- **Tier / Risk:** T2 / hands-off (preferences read-write path; no risk surface, no rendered-output change)
- **Date:** 2026-06-06

## Problem

`usePreferences()` is a self-contained hook: each call owns a `useState`, fires
`GET /api/preferences` on mount, and registers its **own** `window` `focus`
listener that refetches. Consumers are **app-wide**, not settings-only:

| Consumer | Reads | Where |
|----------|-------|-------|
| `AppearanceSync` | `preferences` | app root (`App.tsx`), every page |
| `useAiGate` → ~8 components | `preferences` | OverviewTab, FilesTab, DiffPane, PrHeader, AskAiButton, UnresolvedPanel, AiComposerAssistant, InboxPage |
| `OverviewTab` | `preferences` | PR-detail |
| `AppearanceSection` | `preferences`, `set` | /settings |
| `InboxSectionsSection` | `preferences`, `set` | /settings |
| `ConnectionSection` | `preferences` | /settings |

Every mounted consumer = one more `useState` + one more `focus`-triggered
`GET /api/preferences`. On `/settings` with the navbar present that is 4+
parallel GETs per focus; across PR-detail it is more. They also hold
**independent copies** of the same data, so a `set` in one does not update
another until that other's focus refetch fires — the workaround documented in
`applyTheme.ts:9-15` and `AppearanceSection.tsx:24-28`.

## Goal / acceptance criteria

1. A **single** shared `GET /api/preferences` per focus event — no N-way
   duplication.
2. All consumers read from one shared store.
3. Existing behavior preserved, including `set`'s key-scoped optimistic
   rollback (`usePreferences.ts:91-116`) and the `theme`/`accent`/`density`
   apply-to-document path. Suite stays green.

## Approach (chosen: A2 — shared provider + **lenient** consumer)

Lift the single source of truth into a provider mounted **once** at the app
root. `usePreferences()` reads that shared value when a provider is present
(always, in the app), and **falls back to a live local self-fetch when it is
not** — mirroring `useEventSource()`, which is also lenient (returns `null`
outside its provider) precisely because it is an ambient, widely-read context.
Preferences (theme + the AI gate, read transitively by ~11 PrDetail components
via `useAiGate`) is ambient in the same way, so a throw-outside-provider
consumer would impose a wrapper tax on ~11 existing specs and every future
PrDetail test. Lenient avoids that while still achieving the dedup, because in
production the provider is unconditionally present. Call sites stay
byte-identical.

> **Why not throw (the rejected half of A).** `OpenTabsContext`/`AskAiDrawerContext`
> throw, but they are narrowly used. The throw broke ~11 specs that render real
> AI-gated PrDetail components without mocking the hook, and would tax every
> future such test. The throw's only benefit — a loud error if the provider is
> forgotten — guards a misconfiguration the app structure already prevents (root
> mount, no lazy routes, top-level `ErrorBoundary`).

### File layout

- **New `frontend/src/contexts/PreferencesContext.tsx`** — home for:
  - the `PreferenceKey` type + `readKey`/`writeKey` helpers (moved verbatim from
    `usePreferences.ts`),
  - `PreferencesContext = createContext<PreferencesContextValue | null>(null)`
    (exported as a test seam, mirroring `OpenTabsContext`),
  - `usePreferencesStore(enabled)` — the **one** implementation of the store:
    `useState` + the GET fetch + the `focus` refetch listener + `set` (rollback
    logic moved verbatim). The `enabled` gate makes the instance **inert** (no
    fetch, no listener) when it isn't the active source, so the fallback instance
    inside a provided consumer issues **no** duplicate request. Returns a
    `useMemo([preferences, error, refetch, set])` value, mirroring
    `OpenTabsContext.tsx:140-152`, so unrelated re-renders don't churn consumers.
    (`set`'s identity legitimately tracks `preferences` via its `useCallback`
    dep — inherent to rollback-against-current-state; kept verbatim rather than
    ref-stabilized.)
  - `PreferencesProvider` — calls `usePreferencesStore(true)` once and supplies
    the value via context.
  - `usePreferences()` — reads context; calls `usePreferencesStore(ctx == null)`
    and returns `ctx ?? fallback`. `enabled` is derived from provider-presence,
    which is stable for a given consumer, so hook order never changes. **No
    throw.**
- **`frontend/src/hooks/usePreferences.ts`** — becomes a thin re-export shim:
  `export { usePreferences, type PreferenceKey } from '../contexts/PreferencesContext';`
  This keeps every `from '../hooks/usePreferences'` import path valid (zero
  call-site edits) and keeps the existing `vi.mock('../hooks/usePreferences')`
  mocks intercepting (vi.mock replaces the module at that path wholesale).

The value keeps the **identical** return shape `{ preferences, error, refetch,
set }`, so consumers destructure unchanged.

### Provider placement

Mount a **single** `<PreferencesProvider>` in `App.tsx` wrapping the
`{isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}` ternary
(`App.tsx:155`) — i.e. at the `OpenTabsProvider` nesting level, **outside** the
`isAuthed` conditional. This covers both branches with one provider instance.
`AppearanceSync` (mounted inside `tree`, which renders in the unauthed branch
too) is the **only** preferences consumer on the unauthed `/setup` path —
`SetupPage` itself never calls `usePreferences` — so wrapping the ternary, not
just the `EventStreamProvider` subtree, is what keeps the unauthed branch
satisfied.

**Consequence — no `useEventSource()` inside the provider.** Sitting outside the
`EventStreamProvider`, `PreferencesProvider` cannot consume the SSE source
directly (the same constraint `OpenTabsContext.tsx:127-133` documents for
itself). Any future SSE-driven preference invalidation (e.g. a follow-up that
makes #221 reactive across tabs) must use a `window`-event bridge, not a direct
`useEventSource()` call.

### Intentional behavior delta

Today a consumer mounting **after** load (e.g. opening a PR) fires a fresh GET on
mount. Under the shared provider it reads the already-loaded snapshot and waits
for the next focus to refresh. This is the dedup we want (criterion 1); data
still refreshes on focus, and PR-detail's freshness refetch (#168) is a separate
mechanism untouched here. Called out so reviewers don't read it as a regression.

### Error and loading semantics under the shared store

The `error` field and the `preferences === null` loading window become **shared**
across all consumers (today each holds its own). A failed initial GET now leaves
*every* consumer in the graceful-degraded state at once (`useAiGate` → `false`,
Settings sections → `return null`, `AppearanceSync` → no-op, default appearance),
with the **single** `focus` listener as the sole retry path (today N independent
listeners each retried). This is a real failure-topology change from
N-independent to 1-shared, but the user-visible impact matches today's
per-consumer behavior, and **no consumer surfaces `error` to the user today**, so
it introduces no new silent failure. `error` is retained in the return shape for
parity. Named here so the reviewer accepts the consolidation knowingly; no new
error UI is in scope.

### Stale comments

The independent-`useState` workaround notes in `applyTheme.ts:9-15` and
`AppearanceSection.tsx:24-28` no longer describe reality once state is shared.
The direct `applyThemeToDocument` call on toggle is **kept** (idempotent;
preserves instant visual feedback without depending on effect-timing), but the
comments are refreshed to describe the shared-context model. No behavior change.

## Test plan

- **New `PreferencesContext.test.tsx`** (spies `apiClient.get`/`post`, mocks
  `useToast`):
  - **Dedup:** three consumers under one `PreferencesProvider` → **exactly one**
    `GET /api/preferences` on mount (would be three on the old per-consumer hook),
    and **exactly one** more per dispatched `window` `focus`.
  - **Shared store:** a `set('theme','dark')` in one consumer is observed by a
    separate reader consumer (proves one store, not independent copies).
  - **Lenient fallback:** `usePreferences()` rendered **without** a provider does
    **not** throw — it self-fetches once (mirrors `useEventSource()`).
- **`set` rollback regression stays where it is** (`__tests__/hooks.test.tsx`,
  `describe('usePreferences')`). It calls the real hook via
  `renderHook(() => usePreferences())`; under the lenient design that exercises
  the **fallback** path of the *same* `usePreferencesStore` code, so the two
  key-scoped rollback regressions are preserved **unchanged** (no wrapper added).
- **Existing-test impact: zero edits** (verified by sweeping all specs that
  render a preferences consumer — directly or transitively via `useAiGate`).
  - **Mock-based specs untouched.** Factory-form `vi.mock('.../usePreferences', …)`
    (the four PrDetail specs) and automock-form
    `vi.mock('.../usePreferences')` (`useAiGate.test`,
    `Settings/AppearanceSection.test`) both replace the module at its specifier
    path, so the re-export shim keeps them intercepting (confirmed green).
  - **Real-consumer specs untouched** *because the consumer is lenient.*
    `appearance-sync.test` (real `<AppearanceSync/>`, MSW), `hooks.test` (real
    hook), and the ~11 PrDetail specs that render AI-gated components
    (`OverviewTab`, `FilesTab`, `FilesTabComposer`, `DiffPane`×2,
    `InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`,
    `PrRootConversation`, `MermaidBlock`) all self-fetch via their existing
    fetch/MSW setup, exactly as before #143 — the whole reason A2 was chosen over
    the throw.
  - **Pre-existing coverage gap, out of scope:** `InboxSectionsSection` and
    `ConnectionSection` have no direct unit specs today. This refactor preserves
    their behavior but does not add coverage for them.
- Full `npm test` green (168 files / 1308 tests); `npm run lint` + `npm run build`
  clean.

## Out of scope

- No change to the `/api/preferences` wire shape, the backend, `useCapabilities`,
  or the AI two-factor gate logic.
- No new preference keys or UI.
- #221 (AI toggle reactivity) is a likely downstream beneficiary of the shared
  store but is **not** claimed or fixed here.

## Rejected alternatives

- **A-with-throw — context read that throws outside the provider.** The first
  half of the chosen approach, rejected after implementation surfaced its real
  cost: it broke ~11 PrDetail specs and would tax every future AI-gated test, to
  guard a misconfiguration the app structure already prevents. See the "Why not
  throw" callout above. A2 keeps everything else about A and only swaps the throw
  for the lenient read.
- **B — new `usePreferencesContext()` hook, migrate ~6 call sites, keep the old
  self-fetching hook.** More churn; two ways to read prefs; the old hook lingers
  as a duplication footgun.
- **C — naïve silent fallback (unconditional local self-fetch).** A2 is the
  *refined* form of this; the naïve version is what's rejected. The difference:
  A2's fallback shares the **one** `usePreferencesStore` implementation (no
  duplicated logic) and is **inert** under a provider (the `enabled` gate), so it
  never reintroduces duplication on the production path — the path the app always
  takes. The naïve C (a second self-fetching code path, or a fallback that fetches
  even when a provider exists) would duplicate both logic and requests; A2 avoids
  both.
- **Page-scoped provider (the issue's literal wording).** Would not dedup the
  app-root (`AppearanceSync`), PR-detail, or inbox consumers.
