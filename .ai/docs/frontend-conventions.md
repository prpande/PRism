# Frontend conventions

Production UI lives under `frontend/` (React + Vite + TypeScript). **Visual and token rules** are authoritative in [`design-handoff.md`](./design-handoff.md) and `design/handoff/README.md` — especially oklch tokens, spacing scale, breakpoints, and layout non-negotiables.

## Implementation norms

- Prefer matching existing component patterns and file layout under `frontend/src/` over introducing parallel conventions.
- Keep API types aligned with backend wire formats (kebab-case JSON enums per architectural invariants).
- When adding UI that mirrors the handoff prototype, reimplement in the production stack; do not paste handoff JSX verbatim.
- Run frontend lint, build, and tests per [`development-process.md`](./development-process.md) / [`README.md`](../../README.md) before push.

For route-level or PR-detail structure decisions that conflict with an older plan file, **design handoff wins** on visual/interaction conflicts (see project specs and `CLAUDE.md` / team precedent).

## Component & token gotchas

Non-obvious facts about shared components and the token system, each of which has caused a wrong fix or a wrong review call.

- **`Modal` dismissal contract.** The shared `Modal` (`frontend/src/components/Modal/Modal.tsx`) invokes `onClose` from exactly one place — the Escape keydown handler. It renders no close (X) button and no backdrop-click handler. A modal with `disableEscDismiss` therefore has no path to `onClose`; it must be exited via its own body buttons. Don't wire an `onClose` the modal can never reach.
- **Diff code text size hooks `.diff-line`, not `.diffTable`.** In the diff renderer the `<tr class="diff-line">` pins `font-size` and is a nearer ancestor than `<table class="diffTable">`, so it shadows any font-size set on the table for code/gutter cells. To restyle diff code text, target `.diff-line`. (`.diff-line--hunk-header` re-pins its own size, so `@@…@@` markers stay fixed.)
- **Surface scales are asymmetric between themes.** The `--surface-1/2/3` scales are not symmetric: light descends (raised bands darker than cards), dark ascends and is ~4× compressed (bands lighter). A single derived hover/raised color (e.g. one `color-mix`) often reads fine in one theme and is imperceptible in the other. For any row-hover / raised-chip "one step off a surface" color, define a `:root` value and a `[data-theme="dark"]` override, and verify ΔL ≥ ~0.03 live in both themes.
- **Measuring contrast on oklch tokens.** PRism's color tokens are authored in `oklch()`, and Chromium's `getComputedStyle(el).color` returns that authored space, not `rgb()` — parsing the three numbers as r,g,b yields wrong WCAG ratios. To get true sRGB (and to composite translucent tints), draw each color onto a 1px `<canvas>` and read back `getImageData` before computing the ratio.
