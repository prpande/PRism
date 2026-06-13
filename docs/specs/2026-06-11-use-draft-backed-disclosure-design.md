# `useDraftBackedDisclosure` extraction — design

**Issue:** #363 (carved out of #326). **Tier:** T2. **Risk:** hands-off (behavior-preserving refactor).
**Base:** rebased onto `origin/main` `422553a8` (post-#331, post-#352/#354).

## Problem

The draft-backed disclosure block — `useState(!!existingDraft)` for `composerOpen`, a sibling
`useState` for the draft id, and a resync `useEffect` that re-opens the composer when a cross-tab
refetch later populates the draft — is duplicated verbatim in two places:

- `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (`ThreadView`)
- `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx` (`PrRootConversationActions`)

The two copies differ only in the draft DTO type (`DraftReplyDto` vs `DraftCommentDto`) and the
local state name (`draftReplyId` in `ThreadView`, `draftId` in `PrRootConversationActions`). The
state machine — and the `react-hooks/exhaustive-deps` suppression both effects carry since #331 —
is identical.

## The duplicated logic (current)

`ThreadView` names the draft-id state `draftReplyId`; `PrRootConversationActions` names it
`draftId`. Otherwise byte-identical:

```tsx
const [composerOpen, setComposerOpen] = useState<boolean>(!!existingDraft);
const [draftReplyId, setDraftReplyId] = useState<string | null>(existingDraft?.id ?? null);

useEffect(() => {
  if (!existingDraft) return;
  setDraftReplyId(existingDraft.id);
  setComposerOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on existingDraft?.id; re-syncs only when the draft id changes, not on every object identity change (#331)
}, [existingDraft?.id]);

const handleReplyClick = () => setComposerOpen(true);
// close: setComposerOpen(false) + a site-specific onClose side effect
```

Why the `useEffect` exists: `useState(initialValue)` is frozen at first render. When a cross-tab
refetch later populates `existingDraft` (another tab created a draft, `useStateChangedSubscriber`
refetched the session, and `OverviewTab`/`FilesTab` re-pass the hydrated draft), the initializer
never re-runs. The effect re-syncs so the composer auto-opens with the persisted body. Without it,
a freshly-arrived draft is silently dropped. **This path is live on both tabs today** —
`OverviewTab.tsx` hydrates `existingPrRootDraft` from the shared draft session via `useMemo`, so
the Overview auto-open is not future work (an in-code comment claiming "PR6 will wire that path" is
stale and retires with this extraction).

## Solution

Extract a hook in `frontend/src/hooks/`:

```ts
export interface DraftBackedDisclosure {
  composerOpen: boolean;
  draftId: string | null;
  setDraftId: Dispatch<SetStateAction<string | null>>;
  open: () => void;   // setComposerOpen(true)
  close: () => void;  // setComposerOpen(false) — does NOT clear draftId
}

export function useDraftBackedDisclosure(
  existingDraft: { id: string } | null | undefined,
): DraftBackedDisclosure {
  const [composerOpen, setComposerOpen] = useState<boolean>(!!existingDraft);
  const [draftId, setDraftId] = useState<string | null>(existingDraft?.id ?? null);

  useEffect(() => {
    if (!existingDraft) return;
    setDraftId(existingDraft.id);
    setComposerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on existingDraft?.id; re-syncs only when the draft id changes, not on every object identity change (#331)
  }, [existingDraft?.id]);

  const open = useCallback(() => setComposerOpen(true), []);
  const close = useCallback(() => setComposerOpen(false), []);

  return { composerOpen, draftId, setDraftId, open, close };
}
```

Design notes:

- **Param is structural** (`{ id: string } | null | undefined`) so it accepts both `DraftReplyDto`
  and `DraftCommentDto` without a generic or a shared interface. The hook only ever reads `.id`.
  `null` and `undefined` are treated identically (both mean "no draft"). A generic
  `<T extends { id: string }>` was rejected: `T` never flows to the return type, so it would add a
  type parameter with no callee benefit while reading as accidental narrowing rather than the
  deliberate id-only contract the structural type states plainly.
- **The effect keeps its #331 suppression.** It reads `existingDraft.id` but depends only on
  `existingDraft?.id`; without the `eslint-disable-next-line react-hooks/exhaustive-deps` comment
  CI lint fails at error. This is the same suppression both call sites carry today.
- **`setDraftId` is returned** because both call sites pass it to their composer's `onDraftIdChange`
  — when the composer first persists a draft it reports the new id back up, and that must land in
  the same state the disclosure reads. Exposing the raw setter is required for behavior
  preservation (the composer contract dictates the surface), not an encapsulation leak to design
  away.
- **`close` resets only `composerOpen`** and intentionally leaves `draftId` intact, so a
  close→reopen cycle restores the same draft — matching today's handlers, which never null the id.
  The site-specific side effect on close (`onReplyComposerClose` vs `onComposerClose`) is **not**
  duplicated logic and stays wrapped at each call site:
  `const handleClose = () => { close(); onReplyComposerClose(); }`. Keeping the parent callback out
  of the hook keeps the hook pure and decoupled.

## Adoption

Each call site replaces the `useState/useState/useEffect/handleReplyClick` block with:

```tsx
const { composerOpen, draftId, setDraftId, open, close } = useDraftBackedDisclosure(existingDraft);
const handleClose = () => { close(); /* site-specific onClose */ };
```

`open` wires to `CollapsedComposerAffordance.onOpen`; `draftId`/`setDraftId` to the composer's
`draftId`/`onDraftIdChange`. No JSX changes — the same values feed the same props. The block
comment explaining the cross-tab resync moves onto the hook; each call site keeps a one-line
pointer.

## Tests

Hook unit tests (`renderHook` + `rerender` from `@testing-library/react`, the idiom already used in
`useStreamHealth.test.tsx`), since neither component currently tests this behavior:

- **init-open:** an `existingDraft` at mount → `composerOpen === true`, `draftId === draft.id`.
- **init-closed:** `null` *and* `undefined` draft → `composerOpen === false`, `draftId === null`.
- **resync-open:** mount with no draft, then `rerender` with a draft (new `.id`) → composer opens,
  `draftId` adopts the new id (the cross-tab / Overview-tab arrival case).
- **open / close:** `open()` opens; `close()` closes; `close()` leaves `draftId` unchanged.
- **no-resync-on-close:** when the draft is absent the effect is a no-op (does not force-open).

Existing `ExistingCommentWidget` / `PrRootConversation` component tests must stay green
(behavior-preservation guard).

## Non-goals

- No visual change, no composer-posting-model change. Pure disclosure-state extraction.
- Not folding the site-specific `onClose` side effects into the hook (not duplicated).
