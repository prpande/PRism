# #644 + #630 — Inline-composer post lock & taken-over save badge (design)

**Issues:**
[#644](https://github.com/prpande/PRism/issues/644) — `tech-debt`, `area:reliability`, `area:frontend`;
[#630](https://github.com/prpande/PRism/issues/630) — `tech-debt`, `area:frontend`.
Both are follow-ons to the #601/#602 composer-race work and live in the same composer family
(`useDraftComposer` / `ComposerActionsBar` / `PrRootReplyComposer`, all on `useComposerAutoSave`).
Bundled into one PR because they touch the same files and substrate.

**Tier:** T2 each. #644 carries one real design constraint (must not re-break #601 Fix A); #630 is a
small change behind a resolved product decision. Each is ~1–2 frontend files.

**Risk:** The PR inherits the stricter of the two.

- **#644 — hands-off.** A behavioral input-lock with no rendered-output change a human must eyeball.
  Adjacent to the cross-tab `disabled` gate (§5.7a) but deliberately does **not** touch it (see
  Constraint).
- **#630 — gated B1 (UI-visual).** Changes what the composer's status slot renders. The target
  presentation was an open product question, resolved by the owner (read-only indicator supersedes
  the save badge). CI cannot assert "looks right" → human eyeball at green-and-ready.

> **Gate-scope note.** The PR's B1 visual gate eyeballs the #630 read-only indicator but does **not**
> exercise #644's input-lock (which only manifests under a concurrent in-flight post). #644's
> correctness rests on its automated tests, not the human gate — "PR passed the visual gate" must not
> be read as "#644 was human-verified."

Neither touches a B2 surface: no token/PAT, no reviewer-atomic submit pipeline (the touched post
path is the **single-comment** `postComment`, not `addPullRequestReview`→`submitPullRequestReview`),
no persisted schema, no cross-tab **stamp/poisoning** logic (we read the existing `readOnly` prop;
we do not change how it is produced), no sidecar/security surface.

---

## #644 — inline/reply textarea editable during an in-flight post

### Problem

`InlineCommentComposer` / `ReplyComposer` render the textarea `readOnly={editor.readOnly}`, where
`editor.readOnly` reflects **only** the cross-tab take-over flag — **not** `posting`. So during a
post-now the textarea stays editable. A keystroke mutates `body`, which re-fires
`useComposerAutoSave`'s body-keyed debounce effect and schedules an `updateDraftComment` PUT that
races the in-flight post — the same write-races-post class #601 closed for the **buttons** and the
Cmd/Ctrl+Enter shortcut, but never for the textarea itself. `PrRootReplyComposer` already gates its
editor `readOnly={readOnly || postInFlight}`; the shared-hook composers do not.

### Constraint (the trap, from #644's last AC bullet)

The naive symmetry fix — pass `posting` into the autosave hook's `disabled`
(`disabled: readOnly || posting`) — **re-breaks #601 Fix A**. `useComposerAutoSave.doSave` bails at
entry (and after each `await sendPatch`) when `disabled` is true. Fix A relies on the inline
post-now `flush()` running _during_ the post so its `draft-not-found` (404) branch can fire
`onDraftDeletedByServer`, set `recoveryModalOpenRef`, and short-circuit the doomed post. Gating the
hook's `disabled` on `posting` would suppress exactly that 404 detection (the same mechanism that
makes #601's descoped Defect B not reproduce on the root composer). So the lock must stop **input**
without disabling the **flush's** own write/404 path.

### Fix

Lock the _textarea only_, at the component layer, leaving the hook's `disabled` cross-tab-only:

```tsx
readOnly={editor.readOnly || actions.posting}
aria-readonly={editor.readOnly || actions.posting || undefined}
```

Why this is sufficient and safe:

1. **No new debounce.** The inline/reply textarea is the _only_ mutator of `body`: `editor.setBody`
   is wired solely to the textarea `onChange`. (`AiComposerAssistant` is rendered by the shared
   `ComposerActionsBar` in all three composers, but today it is a null-returning placeholder with no
   `setBody` access, so it cannot mutate `body`.) A read-only textarea fires no input/change event
   for typing, paste, IME commit, drag-drop, or autofill, so `body` freezes → the body-keyed debounce
   effect never re-fires → no racing PUT. (AC #1.) **Forward note:** when v2 wires a real
   suggestion-insert into `AiComposerAssistant`, that insert becomes a new `body` mutator and must
   itself be `posting`/`readOnly`-gated, or it reopens this race.
2. **Pre-post debounce already cancelled.** `handlePostNow` `await`s `flush()`, and `flush()`
   unconditionally `clearTimeout`s the pending debounce **synchronously at its start**, before any
   await. A timer armed by the keystroke just before Post is therefore cleared, in the same tick, by
   the post's own flush — no new code needed for this. (AC #2.)
3. **Fix A intact.** The hook's `disabled` stays `readOnly` (cross-tab only). `posting` never reaches
   the hook, so `doSave`/`flush` run fully during a post and the 404 branch is live. (AC #3.) The
   regression test `…/Composer/useDraftComposer.test.tsx` "post-now does NOT post … 404 recovery
   (#601 Defect A)" stays green.
4. **Does not gate `disabled` on `posting`.** Satisfied by construction — `posting` is applied to the
   DOM `readOnly` attribute, never to `UseComposerAutoSaveProps.disabled`. (AC #4.)

The `posting` value is already exposed on the hook result (`actions.posting`); the keyboard siblings
(Cmd/Ctrl+Enter submit, Escape→discard) were already `posting`-guarded in #601, so the textarea
attribute is the only remaining live input route.

---

## #630 — save badge stuck on 'Saving…' after a mid-PUT take-over

### Problem

`useComposerAutoSave.doSave` calls `setBadge('saving')` before each `sendPatch`. The #602 post-await
re-check (`if (propsRef.current.disabled) return;`) bails **before** the result block when a cross-tab
take-over flips `disabled` true mid-PUT — correctly suppressing the write/notify, but leaving the
badge permanently on `'saving'` (a perpetual spinner) for the now-read-only composer.

### Decision (owner-resolved product call)

The badge value is unsalvageable for a read-only tab (`'saving'` misleads, `'unsaved'` implies the
user can save, `'saved'` is a lie since the PUT result was suppressed). **A read-only indicator
supersedes the save badge.** When the composer is cross-tab read-only, the status slot shows a
"Read-only" indicator (title: "Another tab is editing this PR.", reusing the existing `saveTooltip`
copy) instead of `badgeLabel(badge)`. The underlying badge value is no longer rendered, so the stuck
`'saving'` is moot — no hook change required.

### Fix (presentation only)

Extract the status slot into one shared component, `ComposerStatusBadge({ badge, readOnly })`, which
renders the read-only indicator when `readOnly` and the save badge otherwise. Use it at **every**
badge site, so the read-only treatment is uniform and the markup has a single source:

- `ComposerActionsBar` (inline + reply composers).
- `PrRootReplyComposer` (root composer footer).
- `PrRootBodyEditor` (its `showBadge` slot — surfaced by the **SubmitDialog** PR-root editor).
  **Deviation from the first draft (added during the `/simplify` reuse pass):** `PrRootBodyEditor`
  inlined the identical badge span and has the **same** latent stuck-`'saving'` bug under a cross-tab
  take-over (same `useComposerAutoSave`, same `disabled=readOnly`). Routing it through the shared
  component both removes the duplicate and extends the #630 fix to that site. Verified safe:
  `SubmitDialog`'s `readOnly` is the §5.7a cross-tab flag (`PrHeader`/`PrDetailView` thread
  `presence.readOnly`), and `PrRootReplyComposer` passes `showBadge={false}`, so the change is a no-op
  there and only adds the indicator where the editor's badge is actually shown.

Keep `data-testid="composer-badge"` / `role="status"` on whichever span renders (the slot is stable;
its content swaps). Distinct class `composer-badge--readonly` for targeting. No change to
`ComposerSaveBadge`, `badgeLabel`, or `useComposerAutoSave` — the type stays clean and the
load-bearing hook is untouched.

- **Styling (neutral).** `composer-badge--readonly` uses the base `.composer-badge` neutral palette
  (`--surface-3` / `--text-2`); it adds **no** semantic color. Read-only is a neutral lock, not an
  error (`danger`) or warning state — the existing four badge variants all carry urgency/failure
  signals that would mislead here.
- **Copy + a11y.** Span text is `Read-only`; `title="Another tab is editing this PR."` (reusing the
  existing `saveTooltip` copy). `role="status"` (= `aria-live="polite"`) is intentional — assertive
  would be intrusive for a non-emergency cross-tab state change. `Read-only` (the span text) is the
  full screen-reader announcement; the `title` is a **mouse-hover enhancement only** (a `title` on a
  non-focusable span isn't announced/keyboard-reachable). The "another tab" context already rides on
  the disabled action buttons' tooltips for keyboard/SR users who navigate to them, so no extra
  `aria-describedby` is added (lower-lift T2 path; the B1 gate confirms the look).

### Why not settle the badge in the hook

The issue floats settling the dangling `'saving'` in the hook's `if (props.disabled)` cleanup effect.
Rejected: it still has no correct badge value to settle to (the whole reason the product call landed
on a superseding presentation), and it would add behavior to the delicate autosave hook for a state
the presentation already hides. The read-only state (`readOnly === true`) is _exactly_ when the badge
gets stuck, so the presentation gate fully covers the observable.

**Load-bearing premise: cross-tab read-only is terminal for the PR view.** This presentation-only fix
is correct because `readOnly` never reverts true→false on a still-mounted composer:
`useCrossTabPrPresence` sets `readOnly` true on an incoming claim and resets it to false **only** on
PR-identity change (which remounts the composer with a fresh `'saved'` badge) — there is no
release/yield path that flips it back for a live PR. So `readOnly === true` holds for the composer's
entire mounted lifetime once taken over, and the gate hides the stuck badge throughout. If a future
"release take-over / reclaim" affordance flips `readOnly` back to false on a live composer, the stuck
`'saving'` would resurface (the hook state was never settled) — that change must **also** settle the
badge in the hook. Recorded here so the coupling is explicit.

---

## Acceptance criteria → tests (red-on-main first)

**#644** — the fix lands in **both** `InlineCommentComposer.tsx` and `ReplyComposer.tsx` (each renders
its own textarea), so the red-on-main assertion is added to **both**
`__tests__/InlineCommentComposer.postNow.test.tsx` **and** `__tests__/ReplyComposer.postNow.test.tsx`
(component-level so the DOM attribute is under test):

- [ ] The textarea carries the `readonly` attribute while a post is in flight — **red on main**
      (textarea reflects only `editor.readOnly` → editable during post), **green on fix**. This is the
      canonical proof of the lock: a read-only textarea cannot fire a user-input `onChange`, so `body`
      freezes and no debounced `updateDraftComment` PUT can race the post (AC #1/#2). jsdom's
      `fireEvent.change` bypasses `readOnly` and `userEvent` deadlocks against the suite's fake timers,
      so the attribute assertion (not a synthetic keystroke) is the deterministic test.
- [ ] The lock is scoped to the post window: a **failed** post (composer stays open) restores an
      editable textarea. Guard against over-locking.
- [ ] #601 Fix A regression: the existing `useDraftComposer.test.tsx` 404-recovery test stays green —
      the hook's `disabled` is unchanged (`posting` reaches the DOM attribute only, never the hook).

**#630** (`…/Composer/` — extend the existing badge tests / `useDraftComposer.test.tsx` +
`ComposerActionsBar.test.tsx`):

- [ ] A composer rendered `readOnly` shows the read-only indicator in the status slot, **not**
      `'Saving…'`, regardless of the underlying badge value. Red on main (renders `badgeLabel(badge)`
      unconditionally), green on fix.
- [ ] Take-over mid-PUT (badge driven to `'saving'`, then `readOnly` flips true) renders the
      read-only indicator, not a stuck spinner.

All red-on-main, green-on-fix.

## Out of scope

- The root-composer **post-in-flight** stuck-badge variant (`readOnly || postInFlight` → mid-post
  autosave 404 on retry). #630 is scoped to the **cross-tab take-over** case; on success the root
  composer unmounts via `onClose`, and the post flush bails at `doSave` entry without
  `setBadge('saving')`, so the take-over case is the live one. Noted, not fixed here.
- Any refactor folding `PrRootReplyComposer` into `useDraftComposer` (#326's deferred consolidation).
- Styling polish of the read-only indicator beyond a legible, theme-correct presentation (the B1
  visual gate confirms the look).
