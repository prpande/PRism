# Deferrals — error-box treatment (#182)

Tracks work intentionally left out of the #182 slice so it isn't silently lost.

## D1 — Converge working `.error` duplicators onto `<ErrorBox>`

**What:** Migrate the surfaces that already render a correct danger box via their own module `.error` rule onto the shared `<ErrorBox>` component, eliminating the copy-pasted CSS.

**Candidates:** `SetupForm.tsx:87` (`styles.error`), `PasteUrlInput.tsx:71` (`styles.error`), and any other structurally-compatible inline danger boxes surfaced during execution.

**Why deferred:** These surfaces are not broken — they render correctly today. Converging them risks changing the look of working UI (PasteUrlInput is an inline `<span>`; SetupForm carries a bespoke `margin-top`), which is scope creep against #182's framing ("errors surface correctly, they just aren't styled"). The shared component shipped by #182 makes this convergence mechanical and low-risk later.

**Trigger:** A follow-up tech-debt issue, or fold into the next theming pass touching those components.

## D2 — Parity-baseline re-capture (conditional)

**What:** If migrating any of the six bare sites visibly shifts a `parity-baselines.spec.ts` zone, re-capture that zone's baseline.

**Why conditional:** The migrated sites are error paths largely outside the happy-path baseline zones; re-capture is only needed if a zone actually moves. Determined during execution, not pre-committed.
