# Shared composer core — extract `useDraftComposer` + presentational pair (#326)

- **Issue:** [#326](https://github.com/prpande/PRism/issues/326) — "InlineCommentComposer and ReplyComposer are ~90% byte-identical (775 lines) and have already drifted — extract a shared composer core"
- **Epic:** #317 (2026-06 code-quality review), milestone *Code Quality — 2026-06 Review*
- **Tier / Risk:** T3 (cross-cutting, real design choices) / B1 gated (rendered output must be pixel-identical; the human visual assert is the gate, fired at green-and-ready)
- **Date:** 2026-06-11

## Problem

`InlineCommentComposer.tsx` (417 lines) and `ReplyComposer.tsx` (358 lines) duplicate the
entire state block, every handler, and the actions-bar + modals JSX nearly verbatim. Behavioral
fixes (#299 flush semantics, #302 post-now gating) have had to be applied twice; the clone has
real maintenance cost and a standing drift risk.

A third composer, `PrRootReplyComposer.tsx`, is **not** part of the clone pair — it wraps
`PrRootBodyEditor` (which owns the textarea + autosave), posts via `postRootComment` (atomic,
no `draftId`), and carries its own `PostRootCommentError` model. It shares with the other two
only the **keyboard-shortcut matching** block, which is therefore the one cross-cutting helper
all three can use.

### Scope correction: the "drift" is not a behavior bug

The issue motivates urgency with a claimed bug: `ReplyComposer.handleDiscardConfirm` lacks the
try/catch `InlineCommentComposer` has, so *"a network failure becomes an unhandled rejection and
the modal closes as if the discard succeeded."* **This is incorrect, and the correction reshapes
this work.** `sendPatch` (`api/draft.ts:96-118`) **never throws** — it catches both `ApiError`
and non-`ApiError`/network failures internally and returns a `{ ok: false, kind: 'network' }`
result. Its own comment is explicit: *"sendPatch never throws on this path so callers never have
to wrap it in try/catch ... the discard handlers all rely on this no-throw contract."*

Consequences:
- `ReplyComposer`'s `if (!result.ok) return` already keeps the modal open on a network failure.
  There is **no silent close and no unhandled rejection** — no user-visible bug.
- `InlineCommentComposer`'s discard try/catch is **dead defensive code**: the catch can never
  fire under the contract. (Verified: no composer test mocks `sendPatch` to reject — all use
  `mockResolvedValue`, so nothing exercises the catch.)

**Therefore this work is a pure-dedup refactor with zero behavior change.** It does *not* fix a
bug, does not add a try/catch to `ReplyComposer`, and the shared discard handler **drops** the
dead try/catch (honoring the documented no-throw contract) rather than propagating it. The badge
already surfaces save/discard failures via `applyErrorBadge` → `'unsaved'`/`'rejected'`.

## Goals

1. **One implementation** of: the composer state block, `handlePostNow`, the discard flow, the
   recovery modal, the keyboard-shortcut matching, and the actions bar.
2. **Zero behavior change.** Existing composer test suites stay green unchanged; rendered output
   is pixel-identical. No "fix" is folded in.
3. **No dead defensive code carried forward**: the shared discard handler matches the contract
   (no unreachable try/catch). The floated `flush()` calls keep their existing `void`
   fire-and-forget form — `flush()` cannot reject under the no-throw contract, so no `.catch` is
   added (it would be dead too).
4. **`ownerKey` becomes a prop** on the diff composers (matching `PrRootBodyEditor`), defaulting
   to `'files-tab'` so every current call site is behavior-identical. This is a **forward-enabling
   capability**, not a live fix: it lets a future reply composer mounted from a non-Files surface
   (e.g. the Drafts tab, cf. #354) register the correct owner instead of the hardcoded literal.
   No current call site changes; #354 would pass its own `ownerKey` when it adds such a mount.

## Non-goals / explicitly deferred

- **`useDraftBackedDisclosure`** — the `useState(!!existingDraft)` + resync-`useEffect` block
  duplicated in `ExistingCommentWidget.tsx:89-96` and `PrRootConversation.tsx:80-87` is a real
  dup but is **disclosure** state, not composer state. It touches two files outside the composer
  set (one on the Overview tab, widening the B1 surface) and is orthogonal to the shared-shell
  goal. **Deferred to a follow-up tech-debt issue**, cross-linked from this PR.
- **Folding `PrRootReplyComposer` into the shared hook.** Its posting model genuinely differs
  (atomic root post, no `draftId`, distinct error type). Forcing it into `useDraftComposer` would
  add conditional branches and risk the pixel/behavior-identical bar. It consumes only the shared
  `matchComposerKey` utility.
- **`PrRootReplyComposer`'s discard try/finally.** It has no `catch`, but under the no-throw
  contract that is correct (the `finally` only clears `discardInFlight`). Not a bug; not touched.
- `#327` (DiffPane/FilesTab/PrHeader decomposition) is a separate issue; not touched here.

## Approach

Chosen shape: **hook + presentational pair** (issue's suggested shape; alternatives "hook only"
and "single `<DraftComposer>` component" rejected — the first leaves the identical JSX duplicated,
the second trades readability for a config-prop blob and tight coupling).

### New modules (all under `frontend/src/components/PrDetail/Composer/`)

#### `matchComposerKey.ts` — a pure utility, not a hook

The keyboard block is identical key-matching with **no shared logic** — each composer reacts
differently (diff composers flush-then-close with a recovery-guard; `PrRootReplyComposer` does a
gated atomic post). A hook that returns a pre-bound `handleKeyDown` would have to absorb those
differences via callbacks and would hit a textarea-vs-div event-type mismatch (diff composers
bind `onKeyDown` to the `<textarea>` = `KeyboardEvent<HTMLTextAreaElement>`; `PrRootReplyComposer`
binds it to its outer `<div>` = `KeyboardEvent<HTMLDivElement>`). So extract a **pure matcher**
instead:

```ts
type ComposerShortcut = 'toggle-preview' | 'submit' | 'escape';
// Returns which shortcut the event fired, or null. Element-type agnostic.
function matchComposerKey(e: React.KeyboardEvent): ComposerShortcut | null;
//   Cmd/Ctrl+Shift+P → 'toggle-preview'
//   Cmd/Ctrl+Enter   → 'submit'
//   Escape           → 'escape'
```

Each composer keeps its own thin `handleKeyDown` that calls `matchComposerKey(e)`, `preventDefault`s
on a match, and dispatches to its *local* behavior — preserving the recovery-guard (diff) and the
`postDisabled` gate (`PrRootReplyComposer`) without the matcher knowing about either. This removes
the abstraction layer while still deduplicating the three identical matching expressions, and it
sidesteps the event-type mismatch (each composer binds the handler to its own element).

#### `useDraftComposer.ts`

Owns everything the two diff composers share. The Cmd+Enter `submit` path — `await flush()`, then
**skip `onClose()` if the 404-recovery modal opened mid-flush** — lives **inside** the hook, which
owns `recoveryModalOpenRef`; the hook builds the `handleKeyDown` it returns (calling
`matchComposerKey` internally). Glue components never see the ref.

Params:

```ts
interface UseDraftComposerParams {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;              // (4) explicit, no longer hardcoded
  onClose: () => void;
  readOnly?: boolean;

  // anchor-specific
  anchor: ComposerAnchor;                   // from useComposerAutoSave; inline-comment | reply variant
  deletePatchKind: 'deleteDraftComment' | 'deleteDraftReply';

  // post-now (#302) — optional, defaults preserve existing call-sites
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;

  // inline-only (#299) — optional
  onSaved?: () => void;
  flushRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
}
```

Returns **three grouped slices** (matching the two presentational components + the editor),
rather than a flat ~25-field bag, so each consumer takes one slice:

```ts
interface UseDraftComposerResult {
  editor: {
    body: string;
    setBody: (v: string) => void;
    previewMode: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    readOnly: boolean;
  };
  actions: {
    previewMode: boolean;
    onTogglePreview: () => void;
    badge: ComposerSaveBadge;
    saveDisabled: boolean;
    saveTooltip: string | undefined;
    addLabel: string;
    closedBanner: boolean;
    prState: 'open' | 'closed' | 'merged';
    postNowDisabled: boolean;
    postNowTooltip: string | undefined;
    posting: boolean;
    postError: string | null;
    readOnly: boolean;
    onDiscardClick: () => void;
    onSaveClick: () => void;
    onPostNow: () => void;
  };
  modals: {
    discardModalOpen: boolean;
    onDiscardCancel: () => void;           // setDiscardModalOpen(false)
    onDiscardConfirm: () => void;
    recoveryModalOpen: boolean;
    onRecoveryCancel: () => void;          // setRecoveryModalOpen(false)
    onRecoveryRecreate: () => void;
    onRecoveryDiscard: () => void;
  };
}
```

Internals are a 1:1 lift of the *current* `InlineCommentComposer` body, with these changes:
- `sendPatch({ kind: deletePatchKind, ... })` instead of the hardcoded `'deleteDraftComment'`.
- `registerOpenComposer(draftId, ownerKey)` using the param instead of the literal `'files-tab'`.
- The discard handler **drops the try/catch** (matches `ReplyComposer`'s current shape and the
  no-throw contract): `const result = await sendPatch(...); if (!result.ok) return; ...`.
- `handleKeyDown` built via `matchComposerKey` (see above), preserving the recovery-guard.

The `flushRef` publish effect and `onSaved` pass-through are gated on the optional params being
present, so the reply composer (which passes neither) gets `onSaved: undefined` into
`useComposerAutoSave` exactly as today. **Effect order is preserved** from the canonical
`InlineCommentComposer`: flushRef-publish → register-open-composer → focus-on-mount, with the
focus effect declared **last** so nothing steals focus after mount.

#### `ComposerActionsBar.tsx`

Pure presentational; props are the `actions` slice above. Renders the exact current JSX in the
exact current order: preview-toggle button, badge span, `<AiComposerAssistant />` (rendered
internally — it takes no props today), discard button, the conditional save button (hidden when
`closedBanner`), the post-now button, the merged-note span (when `closedBanner`), and the error
`<div role="alert">`.

#### `ComposerModals.tsx`

Pure presentational; props are the `modals` slice plus the copy that differs per surface:
`discardBody` (inline: "…on this line." / reply: "…reply draft on this thread."), and the recovery
modal `title` + `body`. Renders the two `<Modal>`s with identical structure/roles/`data-modal-role`.

### Rewritten composers (the ~60-line glue)

```tsx
export function InlineCommentComposer(props) {
  const { editor, actions, modals } = useDraftComposer({
    /* mapped props */,
    anchor: { kind: 'inline-comment', filePath, lineNumber, side, anchoredSha, anchoredLineContent },
    deletePatchKind: 'deleteDraftComment',
    ownerKey: props.ownerKey ?? 'files-tab',
  });
  return (
    <div role="form" aria-label={composerAriaLabel(anchor)} data-composer="true"
         data-testid="inline-comment-composer"
         className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}>
      {editor.previewMode
        ? <ComposerMarkdownPreview body={editor.body} />
        : <textarea ref={editor.textareaRef} className="composer-textarea" value={editor.body}
            onChange={(e) => editor.setBody(e.target.value)} onKeyDown={editor.handleKeyDown}
            aria-label="Comment body" rows={4}
            readOnly={editor.readOnly} aria-readonly={editor.readOnly || undefined} />}
      <ComposerActionsBar {...actions} />
      <ComposerModals {...modals}
        discardBody="This will remove the saved draft on this line."
        recoveryTitle="Draft deleted elsewhere"
        recoveryBody="This draft was deleted from another window or by reload. Re-create it with the current text, or discard?" />
    </div>
  );
}
```

`ReplyComposer` is identical except: anchor `{ kind:'reply', parentThreadId }`, `deletePatchKind:
'deleteDraftReply'`, root `reply-composer` class + `data-testid`, `aria-label={replyAriaLabel(...)}`,
textarea `aria-label="Reply body"` + `rows={3}`, and the reply modal copy. It passes no
`onSaved`/`flushRef`. Both gain an optional `ownerKey?: ComposerOwnerKey` prop (default `'files-tab'`).

`PrRootReplyComposer` keeps its structure; only its hand-rolled key matching in `handleKeyDown` is
replaced with `matchComposerKey(e)`, dispatching to its local `onTogglePreview` / gated `handlePost`
/ `handleDiscardClick` — preserving the `postDisabled` gate. Its outer-`div` `onKeyDown` binding is
unchanged (it owns no textarea), so button-focused shortcuts still fire.

## Data flow (unchanged)

`useComposerAutoSave` (badge + flush), `sendPatch` (draft delete), `postComment` (post-now),
`registerOpenComposer` (cross-tab registry), `onPosted` (optimistic placeholder, #302) all keep
their current contracts. The refactor relocates *where* the calls are made (into the hook), not
*what* they do.

## Error handling (unchanged behavior)

- **Discard:** `const result = await sendPatch(...); if (!result.ok) return;` (network →
  `{ok:false, kind:'network'}` → stay in modal). No try/catch — `sendPatch` never throws.
- **Post-now:** unchanged `try/finally` with `setPosting(false)` + `endPosting()` (idempotent).
- **Save / Cmd+Enter flush:** `void`-floated as today; `flush()` cannot reject (it only awaits the
  non-throwing `sendPatch`), and `applyErrorBadge` already drives the badge to `'unsaved'`/`'rejected'`.

## Testing

This is a zero-behavior-change refactor, so the proof is **existing suites green unchanged** plus
new tests for the extracted units — **not** a red-on-main bug test.

- **Existing suites must pass unchanged** (behavioral guard): `InlineCommentComposer.test`,
  `InlineCommentComposer.postNow.test`, `ReplyComposer.test`, `ReplyComposer.postNow.test`,
  `PrRootReplyComposer.test`, `PrRootConversation.test`, `ExistingCommentWidget*.test`, and the
  `FilesTab` composer tests. These select by role/label/testid and mock at the API boundary, so
  they survive the JSX relocation — but, being structure-agnostic, **they do not guard DOM
  structure or visual output.**
- **Structural guard (the real pixel-identity guard):**
  - A new assertion on the `composer-actions` **button** order in an open-PR render —
    `[preview-toggle, discard, save, post-now]` — so a reordering inside `ComposerActionsBar` is
    caught in unit tests. Note the realistic DOM: the badge is a `<span>` (not a button);
    `AiComposerAssistant` renders **`null` unless the AI gate is on** (off by default, so no node);
    and the save button only renders for `prState === 'open'`. Assert against the buttons actually
    present (filter to `role="button"` children in an open-PR render), or force the `composerAssist`
    gate on to materialize the AI node before asserting the full sequence — do **not** assert a
    fixed six-node order, which fails in the default config.
  - The **B1 visual assert** (human) at green-and-ready, side-by-side vs `main`.
  - The composer-touching **e2e specs** must pass unchanged: `pr-detail-single-comment.spec.ts`,
    `recently-closed-readonly.spec.ts`, and any with composer screenshot baselines (enumerate at
    implementation time; do not regenerate baselines unless a deliberate, owner-approved change).
- **New unit tests:**
  - `useDraftComposer`: discard success / `{ok:false}` / network-`{ok:false}` (all stay in modal),
    post-now success / error, recovery re-create / discard, save-disabled + post-now-disabled
    derivation, `ownerKey` / `deletePatchKind` pass-through, the Cmd+Enter recovery-guard skip-close.
  - `matchComposerKey`: each of the three shortcuts, plus non-matching keys → `null`.

## Acceptance criteria

- [ ] One implementation of `handlePostNow`, recovery modal, keyboard matching, discard flow, actions bar.
- [ ] Zero behavior change: existing composer suites green **unchanged**; output pixel-identical (B1 sign-off).
- [ ] Shared discard handler carries no unreachable try/catch (`InlineComposer`'s dead catch removed).
- [ ] `ownerKey` is an (optional, default `'files-tab'`) prop on both diff composers; call sites unchanged.
- [ ] `PrRootReplyComposer` uses `matchComposerKey` (no third copy of the matching expression).
- [ ] `composer-actions` child-order assertion added; named e2e specs pass unchanged.
- [ ] Follow-up issue filed for `useDraftBackedDisclosure`, cross-linked from the PR.

## Rejected alternatives

- **Hook only** — leaves the byte-identical actions-bar + modals JSX duplicated; half-solves it.
- **Single `<DraftComposer>` component** — maximal dedup but the anchor/label/delete-kind/modal-copy
  differences collapse into a config-prop blob that reads worse than two thin glue components, and
  it tightly couples the two surfaces.
- **`useComposerKeyboard` hook** (returning a bound `handleKeyDown`) — rejected for a pure
  `matchComposerKey` utility: the three composers share *matching*, not *behavior*, and a hook
  would absorb their genuinely different submit semantics via callbacks and hit a
  textarea-vs-div event-type mismatch.
- **Fold `PrRootReplyComposer` into the hook** — its atomic-root-post model differs enough that
  sharing the hook means conditional branches and risk to the pixel/behavior-identical bar.
- **Carry/propagate the discard try/catch** — it is dead under the `sendPatch` no-throw contract;
  keeping it would contradict the documented contract and add no behavior.
```
