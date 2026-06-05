# Deferrals — error-box treatment (#182)

Tracks work intentionally left out of the #182 slice so it isn't silently lost.

## D1 — Converge working `.error` duplicators onto the shared error treatment

**What:** Migrate the surfaces that already render a correct danger box via their own module `.error` rule onto the shared error treatment shipped by #182 (the `ErrorModal`/`DangerGlyph` family), eliminating the copy-pasted CSS. (Where a surface is an inline message rather than a modal, extract a small shared inline-error presentation alongside `DangerGlyph` rather than forcing a modal.)

**Candidates:** `SetupForm.tsx:87` (`styles.error`), `PasteUrlInput.tsx:71` (`styles.error`), `DraftsTabError.tsx:9` (shares InboxPage's message+button shape, already styled), and any other structurally-compatible danger surfaces surfaced during execution.

**Why deferred:** These surfaces are not broken — they render correctly today. Converging them risks changing the look of working UI (PasteUrlInput is an inline `<span>`; SetupForm carries a bespoke `margin-top`; DraftsTabError is a centered min-height empty-state), which is scope creep against #182's framing ("errors surface correctly, they just aren't styled"). The shared component shipped by #182 makes this convergence mechanical and low-risk later.

**Trigger:** File a follow-up tech-debt issue immediately after #182 merges, linking this D1 entry as its scope, so the convergence doesn't dissolve into untracked general tech-debt. (DraftsTabError's missing danger color, D3, folds into the same follow-up.)

## D3 — DraftsTabError has no danger color

**What:** `DraftsTabError.tsx:9` carries `role="alert"` but renders neutral (`color: var(--text-2)` on a neutral background) — a user who hits a drafts-load failure gets no visual danger signal.

**Why deferred:** Out of scope for #182, whose framing is "errors render as *unstyled* text." DraftsTabError *is* styled (centered empty-state); it just isn't danger-colored. Giving it a danger signal is a distinct error-signal-consistency decision, and its empty-state layout differs from the shared error treatment. Fold into the convergence pass (D1) or a dedicated theming issue.

## D2 — Parity-baseline re-capture (conditional)

**What:** If migrating any of the six bare sites visibly shifts a `parity-baselines.spec.ts` zone, re-capture that zone's baseline.

**Why conditional:** The migrated sites are error paths largely outside the happy-path baseline zones; re-capture is only needed if a zone actually moves. Determined during execution, not pre-committed.
