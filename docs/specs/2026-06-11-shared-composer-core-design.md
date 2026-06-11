# Shared composer core — extract `useDraftComposer` + presentational pair (#326)

- **Issue:** [#326](https://github.com/prpande/PRism/issues/326) — "InlineCommentComposer and ReplyComposer are ~90% byte-identical (775 lines) and have already drifted — extract a shared composer core"
- **Epic:** #317 (2026-06 code-quality review), milestone *Code Quality — 2026-06 Review*
- **Tier / Risk:** T3 (cross-cutting, real design choices) / B1 gated (rendered output must be pixel-identical; the human visual assert is the gate, fired at green-and-ready)
- **Date:** 2026-06-11

## Problem

`InlineCommentComposer.tsx` (417 lines) and `ReplyComposer.tsx` (358 lines) duplicate the
entire state block, every handler, and the actions-bar + modals JSX nearly verbatim. The
clone has already **drifted**: `InlineCommentComposer.handleDiscardConfirm` wraps `sendPatch`
in try/catch (network error → warn-and-stay-in-modal), but `ReplyComposer.handleDiscardConfirm`
does **not** — a network failure inside that async click handler becomes an unhandled rejection
and the modal closes as if the discard succeeded. Behavioral fixes (#299 flush semantics,
#302 post-now gating) have had to be applied twice; one copy already missed the try/catch.

A third composer, `PrRootReplyComposer.tsx`, is **not** part of the clone pair — it wraps
`PrRootBodyEditor` (which owns the textarea + autosave), posts via `postRootComment` (atomic,
no `draftId`), and carries its own `PostRootCommentError` model. It shares with the other two
only the **keyboard-shortcut block** (`handleKeyDown`), which is therefore the one true
third copy.

## Goals

1. **One implementation** of: the composer state block, `handlePostNow`, the discard flow
   (with a single try/catch), the recovery modal, the keyboard wiring, and the actions bar.
2. **Fix the drift**: `ReplyComposer`'s discard catches network errors identically to inline —
   this is the **one intended behavior change**.
3. **No floated `flush()` promises**: `handleSaveClick` and the Cmd+Enter path get `.catch` + log.
4. **`ownerKey` becomes a prop** on the diff composers (matching `PrRootBodyEditor`), so a reply
   composer mounted from a non-Files surface (e.g. the Drafts tab, cf. #354) does not lie to the
   cross-tab open-composer registry.
5. **Zero visual change and zero behavior change** other than (2): existing composer test suites
   stay green unchanged; rendered output is pixel-identical.

## Non-goals / explicitly deferred

- **`useDraftBackedDisclosure`** — the `useState(!!existingDraft)` + resync-`useEffect` block
  duplicated in `ExistingCommentWidget.tsx:89-96` and `PrRootConversation.tsx:80-87` is a real
  dup but is **disclosure** state, not composer state. It touches two files outside the composer
  set (one on the Overview tab, widening the B1 surface) and is orthogonal to the shared-shell
  goal. **Deferred to a follow-up tech-debt issue**, cross-linked from this PR.
- **Folding `PrRootReplyComposer` into the shared hook.** Its posting model genuinely differs
  (atomic root post, no `draftId`, distinct error type). Forcing it into `useDraftComposer` would
  add conditional branches and risk the pixel/behavior-identical bar. It consumes only the shared
  `useComposerKeyboard`.
- `#327` (DiffPane/FilesTab/PrHeader decomposition) is a separate issue; not touched here.

## Approach

Chosen shape: **hook + presentational pair** (issue's suggested shape; alternatives "hook only"
and "single `<DraftComposer>` component" rejected — the first leaves the identical JSX duplicated,
the second trades readability for a config-prop blob and tight coupling).

### New modules (all under `frontend/src/components/PrDetail/Composer/`)

#### `useDraftComposer.ts`

Owns everything the two diff composers share. Signature:

```ts
interface UseDraftComposerParams {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;              // (4) now explicit, no longer hardcoded
  onClose: () => void;
  readOnly?: boolean;

  // anchor-specific: the object passed straight to useComposerAutoSave
  anchor: ComposerAnchor;                   // from useComposerAutoSave; { kind:'inline-comment', ...} | { kind:'reply', ...}
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

Returns the full surface the glue + presentational components need:

```ts
interface UseDraftComposerResult {
  // editor
  body: string;
  setBody: (v: string) => void;
  previewMode: boolean;
  setPreviewMode: React.Dispatch<React.SetStateAction<boolean>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  readOnly: boolean;

  // actions bar
  badge: ComposerSaveBadge;
  saveDisabled: boolean;
  saveTooltip: string | undefined;
  addLabel: string;
  closedBanner: boolean;
  postNowDisabled: boolean;
  postNowTooltip: string | undefined;
  posting: boolean;
  postError: string | null;
  prState: 'open' | 'closed' | 'merged';
  onDiscardClick: () => void;
  onSaveClick: () => void;
  onPostNow: () => void;

  // modals
  discardModalOpen: boolean;
  setDiscardModalOpen: (v: boolean) => void;
  recoveryModalOpen: boolean;
  setRecoveryModalOpen: (v: boolean) => void;
  onDiscardConfirm: () => void;
  onRecoveryRecreate: () => void;
  onRecoveryDiscard: () => void;
}
```

Internals are a 1:1 lift of the *current* `InlineCommentComposer` body (the canonical, correct
copy), with three changes:
- `sendPatch({ kind: deletePatchKind, ... })` instead of the hardcoded `'deleteDraftComment'`.
- `registerOpenComposer(draftId, ownerKey)` using the param instead of the literal `'files-tab'`.
- `handleSaveClick` → `await flush().catch((err) => console.warn(...))`; the Cmd+Enter flush
  inside `useComposerKeyboard`'s `onSubmit` likewise wrapped (the badge already surfaces save state).

The `flushRef` publish effect and `onSaved` pass-through are gated on the optional params being
present, so the reply composer (which passes neither) behaves exactly as today.

#### `useComposerKeyboard.ts`

```ts
function useComposerKeyboard(opts: {
  onTogglePreview: () => void;            // Cmd/Ctrl+Shift+P
  onSubmit: () => void;                   // Cmd/Ctrl+Enter
  onEscape: () => void;                   // Esc
}): (e: React.KeyboardEvent) => void;
```

Returns a `handleKeyDown`. Diff composers wire `onSubmit` to the flush-then-close sequence
(preserving the `recoveryModalOpenRef` skip-close guard); `PrRootReplyComposer` wires `onSubmit`
to its `handlePost` and `onEscape` to its `handleDiscardClick`. The generic `e.key`/`metaKey`/
`ctrlKey`/`shiftKey` matching is identical to all three current copies. `useDraftComposer`
consumes this internally and exposes the resulting `handleKeyDown`.

#### `ComposerActionsBar.tsx`

Pure presentational. Props mirror the actions-bar slice of `UseDraftComposerResult` (preview
toggle state, badge, save disabled/tooltip + `addLabel`, `closedBanner`, post-now disabled/
tooltip + posting, `readOnly`, `postError`, `prState`, and the three click handlers). Renders the
exact current JSX: preview-toggle button, badge span, `<AiComposerAssistant />`, discard button,
the conditional save button (hidden when `closedBanner`), the post-now button, the merged-note
span (when `closedBanner`), and the error `<div role="alert">`.

#### `ComposerModals.tsx`

Pure presentational. Props: `discardModalOpen` + setter + `onDiscardConfirm`, `recoveryModalOpen`
+ setter + `onRecoveryRecreate`/`onRecoveryDiscard`, and the copy that differs per surface:
`discardBody` (inline: "…on this line." / reply: "…reply draft on this thread."), and the
recovery modal `title` + `body`. Renders the two `<Modal>`s with identical structure/roles.

### Rewritten composers (the ~60-line glue)

```tsx
export function InlineCommentComposer(props) {
  const c = useDraftComposer({
    /* mapped props */,
    anchor: { kind: 'inline-comment', filePath, lineNumber, side, anchoredSha, anchoredLineContent },
    deletePatchKind: 'deleteDraftComment',
    ownerKey: 'files-tab',
  });
  return (
    <div role="form" aria-label={composerAriaLabel(anchor)} data-composer="true"
         data-testid="inline-comment-composer"
         className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}>
      {c.previewMode
        ? <ComposerMarkdownPreview body={c.body} />
        : <textarea ref={c.textareaRef} className="composer-textarea" value={c.body}
            onChange={(e) => c.setBody(e.target.value)} onKeyDown={c.handleKeyDown}
            aria-label="Comment body" rows={4}
            readOnly={c.readOnly} aria-readonly={c.readOnly || undefined} />}
      <ComposerActionsBar {.../* actions slice of c */} />
      <ComposerModals {.../* modals slice of c */}
        discardBody="This will remove the saved draft on this line."
        recoveryTitle="Draft deleted elsewhere"
        recoveryBody="This draft was deleted from another window or by reload. Re-create it with the current text, or discard?" />
    </div>
  );
}
```

`ReplyComposer` is identical except: anchor `{ kind:'reply', parentThreadId }`, `deletePatchKind:
'deleteDraftReply'`, `ownerKey: 'files-tab'`, root `reply-composer` class + `data-testid`,
`aria-label={replyAriaLabel(parentThreadId)}`, textarea `aria-label="Reply body"` + `rows={3}`,
and the reply modal copy. It passes no `onSaved`/`flushRef`.

`PrRootReplyComposer` keeps its structure; only its hand-rolled `handleKeyDown` is replaced with
`useComposerKeyboard({ onTogglePreview, onSubmit: () => { if (!postDisabled) void handlePost(); },
onEscape: handleDiscardClick })`.

### `ownerKey` prop wiring at call sites

`InlineCommentComposer` and `ReplyComposer` gain an `ownerKey?: ComposerOwnerKey` prop defaulting
to `'files-tab'`, so every existing call site (in `FilesTab` / thread renderers) compiles and
behaves unchanged. The hook receives the resolved value.

## Data flow (unchanged)

`useComposerAutoSave` (badge + flush), `sendPatch` (draft delete), `postComment` (post-now),
`registerOpenComposer` (cross-tab registry), `onPosted` (optimistic placeholder, #302) all keep
their current contracts. The refactor only relocates *where* the calls are made (into the hook),
not *what* they do.

## Error handling

- **Discard:** one try/catch in `useDraftComposer.onDiscardConfirm`. Network/non-ApiError →
  return (stay in modal). `!result.ok` → return (stay in modal). Success → clear id, close.
  This is the drift fix: `ReplyComposer` inherits it for free.
- **Post-now:** unchanged `try/finally` with `setPosting(false)` + `endPosting()` (idempotent).
- **Save / Cmd+Enter flush:** `.catch` + `console.warn`; the badge surfaces the failure state.

## Testing

- **Drift fix (red-on-main, TDD):** new test mounts `ReplyComposer` with a saved `draftId`, mocks
  `sendPatch` to **reject** (network error), clicks Discard → Confirm, and asserts (a) no unhandled
  rejection and (b) the discard modal stays open / `onClose` not called. Confirm **RED** against a
  clean `origin/main` checkout (today's `ReplyComposer` throws), **GREEN** on the head.
- **Pixel/behavior identical:** the existing suites must pass **unchanged** —
  `InlineCommentComposer.test`, `ReplyComposer.test`, `PrRootConversation.test`,
  `ExistingCommentWidget*.test`, and any `FilesTab` composer tests. No snapshot churn.
- **New unit tests:** `useDraftComposer` (discard success/failure/network, post-now success/error,
  recovery re-create/discard, save-disabled derivation, `ownerKey`/`deletePatchKind` pass-through)
  and `useComposerKeyboard` (the three shortcuts + non-matching keys).
- **B1 visual assert (gate):** in the running app, side-by-side an inline comment composer, a
  thread reply composer, and the Overview composer, in both themes, in edit + Preview + post-now +
  closed-PR states, confirming no visual delta vs `main`.

## Acceptance criteria

- [ ] One implementation of `handlePostNow`, recovery modal, keyboard wiring, discard flow, actions bar.
- [ ] `ReplyComposer` discard catches network errors identically to inline (red-on-main test passes).
- [ ] No floated `flush()` promises (save + Cmd+Enter paths `.catch`+log).
- [ ] `ownerKey` is a prop on both diff composers; call sites unchanged in behavior.
- [ ] `PrRootReplyComposer` consumes `useComposerKeyboard` (no third keyboard copy).
- [ ] Existing composer test suites green unchanged; rendered output pixel-identical (B1 sign-off).
- [ ] Follow-up issue filed for `useDraftBackedDisclosure`, cross-linked from the PR.

## Rejected alternatives

- **Hook only** — leaves the byte-identical actions-bar + modals JSX duplicated; half-solves it.
- **Single `<DraftComposer>` component** — maximal dedup but the anchor/label/delete-kind/modal-copy
  differences collapse into a config-prop blob that reads worse than two thin glue components, and
  it tightly couples the two surfaces.
- **Fold `PrRootReplyComposer` in** — its atomic-root-post model differs enough that sharing the
  hook means conditional branches and risk to the pixel/behavior-identical bar.
</content>
</invoke>
