# Design handoff usage

`design/handoff/` is a high-fidelity interactive prototype using inline-Babel React. **Recreate the UI in the production stack (React + Vite + TS per spec); don't lift the JSX verbatim.** Key non-negotiables called out in `design/handoff/README.md`:

- Port `tokens.css` oklch values **as-is** — don't approximate to hex. The accent-rotation system depends on the parameterized hue.
- The spacing scale jumps `--s-6` (24) → `--s-8` (32). There is no `--s-7`.
- Don't add a hero panel to the inbox. It was tried and removed.
- Don't render the right activity rail below the 1180px breakpoint.
- Light-mode `--surface-1` is `oklch(0.985 0.003 250)`, not `#fff`. The slate tint matters.
- Only PR `#1842` is deeply mocked in the prototype; other tabs render stubs. In production, every tab gets the full PR Detail view.
