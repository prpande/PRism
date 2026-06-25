# useComposerAutoSave robustness — design (#602)

**Issue:** [#602](https://github.com/prpande/PRism/issues/602) — Frontend: `useComposerAutoSave`
robustness. Severity Major. Part of the correctness/robustness follow-on to epic #317.

**Tier/Risk:** T2 / gated B2 (cross-tab §5.7a behavioral invariant — Defect B). Single
production file: `frontend/src/hooks/useComposerAutoSave.ts`.

## Problem

Three independent defects in the draft auto-save hook, all confirmed against the current source:

- **A — no flush-on-unmount → last `<250 ms` edit silently dropped.** The debounce effect
  cleanup (`useComposerAutoSave.ts:215-220`) only `clearTimeout`s; it never flushes.
  `useDraftComposer` flushes only on explicit user actions (onClose, Cmd+Enter, save, post-now,
  line-switch `flushRef`); its unmount cleanup just nulls `flushRef.current`. Any unmount path
  that bypasses those handlers — PR navigation tearing the tree down, file-tree collapse, sub-tab
  switch unmounting the composer — within `COMPOSER_DEBOUNCE_MS` (250 ms) of the last keystroke
  **drops that keystroke**.

- **B — `disabled` (cross-tab take-over) not re-checked after `await`.** `performSave`
  (`:100-188`) checks `p.disabled` once at entry. If a cross-tab take-over flips `disabled` true
  *during* an in-flight PUT, the post-await effects (`setBadge('saved')`, `onAssignedId`,
  `onSaved`, `onLocalDelete`) still fire — undermining the spec §5.7a guarantee that the read-only
  tab performs no writes/notifications.

- **C — update/delete saves are not serialized.** `inFlightCreate` (`:115-126`) dedups concurrent
  *creates*, but two overlapping update/delete `performSave` calls (debounce timer firing while
  `flush()` also runs; or empty-body delete interleaving an update) have no ordering guard.
  Out-of-order resolution lets an older write win the terminal `setBadge('saved')`, and a
  delete/update interleave can land **server-side in the wrong order** (lost-update / wrong final
  state under rapid edit+clear+flush).

## Approach

### A — flush-on-unmount

Add an effect with an **empty dependency array** whose cleanup runs only on unmount:

```ts
useEffect(() => {
  return () => {
    // Unmount with a debounce timer still pending → the last keystroke
    // hasn't been persisted. Fire-and-forget a final save (cleanups cannot
    // await). setBadge after unmount is a React no-op; the PUT still lands.
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
      void performSave(propsRef.current.body);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

- **Why a separate effect, not the existing body-keyed cleanup:** the debounce effect's cleanup
  (`:215`) runs on *every* `props.body` change (its deps include `props.body`). Flushing there
  would fire a save on every keystroke, defeating the debounce. An empty-dep effect's cleanup runs
  exactly once, at unmount.
- **`performSave` is stable** (`useCallback([])`), so referencing it from an empty-dep effect is
  safe and doesn't violate exhaustive-deps in spirit (it never changes identity).
- **`disabled` interaction — two independent guards (ce-doc-review adversarial finding).** The
  flush-on-unmount is safe under take-over for *two* reasons, and the rationale must name both so
  neither is removed in isolation: (1) when the tab is taken over the debounce effect already cancels
  the timer (`:200-208`), so `debounceTimer.current` is usually null at unmount and the cleanup
  no-ops; (2) even if `disabled` flips *after* the timer was nulled by an in-progress save and the
  component then unmounts, the enqueued `doSave` re-reads `propsRef.current.disabled` at entry
  (`:102`) and bails. Guard (1) alone is insufficient (it doesn't cover the post-null flip); guard
  (2) is the actual backstop. Both must remain.
- The fire-and-forget save reuses the full `performSave` path (threshold gate, create-vs-update,
  empty-body delete), so an unmount of a sub-threshold or empty composer correctly no-ops/deletes.

### B — post-await `disabled` re-check

After **each** `await` in `doSave`, re-read the *live* flag `propsRef.current.disabled` and bail
**before the entire result-handling block** — not just before the callbacks. Placing the re-check
immediately after the `await` suppresses *both* the notifications **and** the internal
`draftIdRef.current = …` state write, so a taken-over tab retains no state from its in-flight
write (per ce-doc-review coherence finding):

```ts
const result = await sendPatch(...);
if (propsRef.current.disabled) return; // taken over mid-flight → no state write, no badge/notify
// ...everything below (draftIdRef write, setBadge, onAssignedId/onSaved/onLocalDelete) is skipped
```

Applies at the three `sendPatch` await sites (create `:137`, delete `:160`, update `:174`).
**Interaction with C:** the create-only `inFlightCreate` drain at `:115-126` (the old fourth
await site `:118`) is *removed* by Defect C's serialization, so that re-check site disappears in
the final code — the chain, not a manual drain, orders saves. The PUT that was already dispatched
cannot be recalled, but every observable effect (badge, `onAssignedId`, `onSaved`, `onLocalDelete`,
`onDraftDeletedByServer`, and the local `draftIdRef` write) is suppressed, which is what §5.7a
constrains for the now-read-only tab.

**`flush()` call-site guard (ce-doc-review security finding).** `flush()`'s safety today rests on
`doSave`'s entry check (`:102`) returning early when disabled. Make the §5.7a guarantee explicit at
the call site too: add `if (propsRef.current.disabled) return null;` at the top of `flush()` before
it clears the debounce timer, so a `flush()` invoked on a taken-over tab (e.g. a submit handler)
short-circuits without entering the save chain even if the entry check is ever refactored away.

### C — serialize all saves through one in-flight chain

Replace the create-only `inFlightCreate` dedup with a single tail-chained promise that serializes
**every** save:

```ts
const saveChain = useRef<Promise<void>>(Promise.resolve());

const performSave = useCallback((currentBody: string): Promise<void> => {
  const next = saveChain.current.then(() => doSave(currentBody));
  // Swallow rejections on the stored tail so one failed save doesn't poison
  // the chain; the awaited `next` still surfaces the real result to callers.
  saveChain.current = next.catch(() => undefined);
  return next;
}, []);
```

`doSave` is the existing body of `performSave` (threshold gate, create/update/delete), **minus**
the `inFlightCreate` plumbing — serialization makes it redundant: a second save now *awaits* the
first create to complete, by which point `draftIdRef.current` is set, so it naturally fires an
update instead of a duplicate create. This preserves the existing
`InFlightCreate_QueuesSubsequentDebounce_NoDuplicateCreate` behavior while also ordering
update/delete saves.

- **Ordering guarantee (AC#3):** save N+1 cannot dispatch its `sendPatch` until save N has fully
  resolved, so server-side writes land in submission order and the terminal `setBadge('saved')`
  reflects the last write. **Load-bearing invariant (ce-doc-review adversarial finding):** terminal-badge
  correctness rests on *the last-enqueued save being the latest user intent* — true because saves are
  enqueued in the order keystrokes/flushes occur and the chain preserves that order. Each link still
  calls `setBadge('saving')` when it runs, so a multi-save chain visibly steps `saving→saved→saving→saved`;
  a mid-chain failure flashes `unsaved`/`rejected` transiently before the final link's success overwrites
  it. This is unchanged from today's per-save badge behavior — serialization only guarantees the *terminal*
  badge is the last write's.
- **`draftIdRef` write must stay synchronous (ce-doc-review adversarial finding).** Removing
  `inFlightCreate` transfers its create-dedup obligation onto the chain *plus* one ordering rule: in the
  create branch, `draftIdRef.current = result.assignedId` MUST be written synchronously after the
  `sendPatch` await resolves and before the link's promise settles (it is, at `:139`). If a future edit
  inserted an `await` between the `sendPatch` resolution and that ref write, a chained second save could
  read a stale `null` id and fire a duplicate create. A code comment at the assignment will record this.
- **`flush()`** still clears the debounce timer then calls `performSave`; it now awaits its
  position in the chain. Return value (`draftIdRef.current`) is read after the chain settles, so
  post-now's freshly-assigned id is correct.
- **Why not a generation counter:** a per-save generation guard on `setBadge` fixes only the badge
  race, not the server-side delete/update reordering that AC#3 requires. Insufficient.

## Edge cases

- **Unmount mid-create (A + C):** the empty-dep cleanup enqueues a final save behind the in-flight
  create on the chain; it runs after the create resolves. Fire-and-forget, no await needed.
- **Disabled flips during the chained wait (B + C):** each chained save re-checks
  `propsRef.current.disabled` at entry (existing `:102`) *and* post-await (new), so a save that
  was queued before take-over and starts after it early-returns without writing.
- **404 recovery during take-over:** the post-await re-check suppresses `onDraftDeletedByServer`
  too — a read-only tab must not pop the recovery modal.

## Test plan (vitest, `frontend/__tests__/useComposerAutoSave.test.tsx`)

1. **A:** render with `body:'abcd'`, advance < 250 ms (timer pending), `unmount()`, drain
   microtasks → `sendPatch` called once with the create patch.
2. **A no-op:** unmount sub-threshold (`'ab'`) with timer pending → no `sendPatch`.
3. **B-create:** hold create in-flight, flip `disabled:true` via rerender, resolve PUT → no
   `onAssignedId`, badge not `'saved'`, **and** `draftIdRef` not retained (re-enable + edit fires a
   fresh create, not an update — proves the local id write was also suppressed).
4. **B-update:** existing draft, hold update in-flight, flip `disabled` → no `onSaved`, badge unchanged.
5. **B-delete:** existing draft, empty body, hold delete in-flight, flip `disabled` → no
   `onLocalDelete`.
6. **C-order:** existing draft; fire an update (held in-flight) then a delete; resolve in order →
   `sendPatch` calls are update-then-delete, second does not start before the first resolves;
   terminal badge reflects the delete.
7. **B-flush-guard:** call `flush()` on a hook rendered with `disabled:true` → no `sendPatch`,
   returns `null` (call-site §5.7a guard).
8. **Regression:** the full existing suite (threshold, debounce, assignedId/update, in-flight
   create dedup, error handling, prState gate, flush, reply/pr-root variants) stays green —
   including `InFlightCreate_QueuesSubsequentDebounce_NoDuplicateCreate`, which now guards the
   chain's create-dedup obligation rather than `inFlightCreate`'s.

## Out of scope

- Changing `useDraftComposer`'s explicit flush points or `flushRef` contract — A is fixed entirely
  inside `useComposerAutoSave`, so every consumer benefits without per-consumer wiring.
- The cross-tab `TabStamp`/poisoning protocol itself — untouched; B only honors the derived
  `disabled` prop more strictly.
