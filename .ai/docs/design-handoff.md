# Design handoff usage

`design/handoff/` is a high-fidelity interactive prototype using inline-Babel React. **Recreate the UI in the production stack (React + Vite + TS per spec); don't lift the JSX verbatim.** Key non-negotiables called out in `design/handoff/README.md`:

- Port `tokens.css` oklch values **as-is** — don't approximate to hex. The accent-rotation system depends on the parameterized hue.
- The spacing scale jumps `--s-6` (24) → `--s-8` (32). There is no `--s-7`.
- Don't add a hero panel to the inbox. It was tried and removed.
- Don't render the right activity rail below the 1180px breakpoint.
- Light-mode `--surface-1` is `oklch(0.985 0.003 250)`, not `#fff`. The slate tint matters.
- Only PR `#1842` is deeply mocked in the prototype; other tabs render stubs. In production, every tab gets the full PR Detail view.

## Parity PR checklist

Every PR in the design-parity-recovery roadmap (see [`docs/specs/2026-05-29-design-parity-recovery-design.md`](../../docs/specs/2026-05-29-design-parity-recovery-design.md)) that ports a handoff-defined surface MUST include side-by-side screenshots in its description: handoff prototype on the left (load `design/handoff/PRism.html` locally), implementation on the right, captured at the same viewport. Use the `compound-engineering:ce-demo-reel` skill for capture if available; otherwise capture via browser DevTools Device Mode at the documented viewport width (1440×900 for the canonical zones) and attach the image to the PR description.

The reviewer's pass on the side-by-side is the **parity gate**. The viewport baseline regression in [`frontend/e2e/parity-baselines.spec.ts`](../../frontend/e2e/parity-baselines.spec.ts) is the **regression gate** — it catches future drift on already-restored zones, not initial fidelity. The fixture content differs between the handoff prototype (PR `#1842` "Refactor LeaseRenewalProcessor") and the implementation side (`acme/api/123` "Calc utilities") per PR1 deferral D1; reviewers compare structure and visual treatment, not content.
