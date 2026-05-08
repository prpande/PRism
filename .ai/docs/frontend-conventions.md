# Frontend conventions

Production UI lives under `frontend/` (React + Vite + TypeScript). **Visual and token rules** are authoritative in [`design-handoff.md`](./design-handoff.md) and `design/handoff/README.md` — especially oklch tokens, spacing scale, breakpoints, and layout non-negotiables.

## Implementation norms

- Prefer matching existing component patterns and file layout under `frontend/src/` over introducing parallel conventions.
- Keep API types aligned with backend wire formats (kebab-case JSON enums per architectural invariants).
- When adding UI that mirrors the handoff prototype, reimplement in the production stack; do not paste handoff JSX verbatim.
- Run frontend lint, build, and tests per [`development-process.md`](./development-process.md) / [`README.md`](../../README.md) before push.

For route-level or PR-detail structure decisions that conflict with an older plan file, **design handoff wins** on visual/interaction conflicts (see project specs and `CLAUDE.md` / team precedent).
