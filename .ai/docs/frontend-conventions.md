# Frontend conventions

Production UI lives under `frontend/` (React + Vite + TypeScript). **Visual and token rules** are authoritative in [`design-handoff.md`](./design-handoff.md) and `design/handoff/README.md` — especially oklch tokens, spacing scale, breakpoints, and layout non-negotiables.

## Implementation norms

- Prefer matching existing component patterns and file layout under `frontend/src/` over introducing parallel conventions.
- Keep API types aligned with backend wire formats (kebab-case JSON enums per architectural invariants).
- When adding UI that mirrors the handoff prototype, reimplement in the production stack; do not paste handoff JSX verbatim.
- Run frontend lint, build, and tests per [`development-process.md`](./development-process.md) / [`README.md`](../../README.md) before push.

For route-level or PR-detail structure decisions that conflict with an older plan file, **design handoff wins** on visual/interaction conflicts (see project specs and `CLAUDE.md` / team precedent).

## Test layout

- **Co-locate component tests with their source.** A component's unit test lives next
  to it as `frontend/src/.../<Component>.test.tsx`, not under `frontend/__tests__/`.
  This is the convention for **new** component tests; it keeps a component's test next
  to its source and is the direction the codebase settled on (see #334).
- **One test location per component.** Do not add a second test file for a component
  under `frontend/__tests__/` when a co-located one exists (or vice versa) — the
  dual-location split was consolidated in #334. Subject-specific siblings are fine and
  encouraged (`<Component>.<subject>.test.tsx`, e.g. `PrRootReplyComposer.badge.test.tsx`),
  but they live co-located alongside the main file, not in a second directory.
- `frontend/__tests__/` still holds historical component tests that predate this
  convention and have no co-located twin; they migrate opportunistically (tracked
  separately) and are not a license to add new ones there.

## Component & token gotchas

Non-obvious facts about shared components and the token system, each of which has caused a wrong fix or a wrong review call.

- **`Modal` dismissal contract.** The shared `Modal` (`frontend/src/components/Modal/Modal.tsx`) invokes `onClose` from exactly one place — the Escape keydown handler. It renders no close (X) button and no backdrop-click handler. A modal with `disableEscDismiss` therefore has no path to `onClose`; it must be exited via its own body buttons. Don't wire an `onClose` the modal can never reach.
- **Diff code text size hooks `.diff-line`, not `.diffTable`.** In the diff renderer the `<tr class="diff-line">` pins `font-size` and is a nearer ancestor than `<table class="diffTable">`, so it shadows any font-size set on the table for code/gutter cells. To restyle diff code text, target `.diff-line`. (`.diff-line--hunk-header` re-pins its own size, so `@@…@@` markers stay fixed.)
- **Surface scales are asymmetric between themes.** The `--surface-1/2/3` scales are not symmetric: light descends (raised bands darker than cards), dark ascends and is ~4× compressed (bands lighter). A single derived hover/raised color (e.g. one `color-mix`) often reads fine in one theme and is imperceptible in the other. For any row-hover / raised-chip "one step off a surface" color, define a `:root` value and a `[data-theme="dark"]` override, and verify ΔL ≥ ~0.03 live in both themes.
- **Measuring contrast on oklch tokens.** PRism's color tokens are authored in `oklch()`, and Chromium's `getComputedStyle(el).color` returns that authored space, not `rgb()` — parsing the three numbers as r,g,b yields wrong WCAG ratios. To get true sRGB (and to composite translucent tints), draw each color onto a 1px `<canvas>` and read back `getImageData` before computing the ratio.
