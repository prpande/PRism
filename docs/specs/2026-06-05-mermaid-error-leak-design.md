# Mermaid error/bomb graphic leaks into the DOM — design

**Issue:** [#191](https://github.com/prpande/PRism/issues/191) · **Tier:** T2 · **Risk:** hands-off
· **Area:** `area:pr-detail` (Markdown rendering)

## Problem

Invalid Mermaid diagrams leak Mermaid's built-in **"Syntax error in text" bomb
graphic** into the DOM. The orphaned error nodes are appended at the
`document.body` level, so they pile up at the **bottom of the page** and are
visible on scroll — including on routes that contain no diagrams at all (e.g. the
inbox). They read as the app being broken. Multiple failures accumulate.

## Root cause (confirmed)

`frontend/src/components/Markdown/MermaidBlock.tsx` wraps `mermaid.render()` in a
`try/catch` and renders a clean `.mermaid-error` fallback on the thrown error. But
on a parse failure Mermaid v11.14.0 has a **side effect**: before throwing, it
injects its error diagram (the bomb SVG) into a temporary render container at the
`document.body` level. Our `catch` swallows the throw; the injected DOM node is
never removed. Because it lives on `body`, it shows regardless of the mounted
route, and repeated failures accumulate.

A probe against the real Mermaid library (v11.14.0) under jsdom reproduced this
deterministically: rendering invalid syntax grew `document.body` by ~4 KB,
containing `.error-icon` paths and a `<text class="error-text">Syntax error in
text</text>` caption.

## Decision

Add **`suppressErrorRendering: true`** to the single `mermaid.initialize({...})`
call in `MermaidBlock.tsx`.

The same probe confirmed that with this flag set, `render()` **still throws** on
invalid syntax (so our existing `catch` + `.mermaid-error` fallback are fully
preserved) but Mermaid injects **nothing** into `document.body` (`body` growth was
0). This is the smallest correct fix: one config line, no behavior change for
valid diagrams, no change to our error UX, and it eliminates the leak at its
source rather than cleaning up after it.

The probe exercised the parse-failure path. Reading the real source
(`node_modules/mermaid/dist/mermaid.core.mjs`, v11.14.0) confirms the guarantee
holds for **every** render failure mode, not just parse: the temp render element
is appended to `body` via `appendDivSvgG(select("body"), …)`, and **both** catch
sites in `render()` honor the flag —

- the parse catch (`Diagram.fromText`): `if (config.suppressErrorRendering) { removeTempElements(); throw error; }`
- the draw catch (`diag.renderer.draw`, a mid-render throw *after* a successful parse): `if (config.suppressErrorRendering) { removeTempElements(); } … throw e;`

and the success path also calls `removeTempElements()` before returning. So under
the flag there is no failure mode — parse error or mid-render throw — that leaves
a node on `body`.

`securityLevel: 'strict'` and the other existing init options are unchanged. (The
flag is orthogonal to sanitization: the same source shows the returned SVG is run
through `DOMPurify.sanitize` for non-loose security levels regardless.)

## Rejected alternatives

- **Pre-parse validate** (`await mermaid.parse(code)` before `render()`, skip
  render on failure): equivalent user outcome but adds a second parse pass on
  every diagram (parse-then-render) for no benefit over suppression, which already
  prevents the injection in the single render call.
- **Defensive DOM cleanup** (after a failed render, remove any orphaned
  `#${id}` / `#d${id}` node Mermaid left behind): the issue suggested this as
  defense-in-depth *in addition* to the primary fix. Rejected here because the
  source read above shows Mermaid itself calls `removeTempElements()` on **both**
  failure paths (parse and mid-render draw) and on success when the flag is on —
  so there is genuinely **no orphan node for our cleanup to remove** on any path.
  The cleanup code would be unreachable and cannot be exercised by a test (it
  would be untestable dead code). The regression test below pins the
  user-observable invariant (no bomb in `document.body`); if a future Mermaid
  version regresses and re-introduces the leak despite the flag, that test goes
  red and we revisit cleanup then, against a real failure rather than a
  hypothetical one.

## Acceptance criteria

- [ ] Rendering an **invalid** Mermaid diagram leaves **zero** Mermaid error/bomb
  nodes in `document.body` — no `.error-icon` / `.error-text` element and no
  "Syntax error in text" caption.
- [ ] Rendering **several** invalid diagrams in sequence leaves `document.body`
  clean — the no-**accumulation** invariant, which is the issue's defining symptom
  ("multiple failures accumulate at the bottom of the page"). A single-render
  assertion alone could pass while accumulation silently regresses.
- [ ] A **failed** render still shows our quiet `.mermaid-error` fallback (the
  existing `catch` path is preserved — `render()` still throws).
- [ ] A **valid** diagram still renders unchanged (covered by the existing mocked
  `MermaidBlock` tests; no regression).

## Test plan

A regression test that **unmocks** Mermaid and renders the real `MermaidBlock`
with invalid syntax in jsdom, asserting the **user-observable outcome**:

1. our `.mermaid-error` fallback appears in the component container (catch fired);
2. `document.body` contains no `.error-icon`/`.error-text` node;
3. `document.body` text does not contain "Syntax error in text";
4. after rendering **two or more** invalid diagrams in sequence (distinct codes),
   `document.body` is *still* clean — pinning the no-accumulation invariant.

This test is **red on `main`** (the bomb leaks, assertions 2–4 fail) and green
after the fix. It asserts the outcome, not the config flag, so it stays honest if
the fix mechanism ever changes.

**Mechanism / isolation (decided here, not deferred):** the suite globally mocks
Mermaid via `__tests__/setup-mermaid.ts` (wired through `vitest.config.ts`
`setupFiles`), and `MermaidBlock.tsx` carries a module-level
`mermaidInitialized` singleton that freezes the init options at the first
`initialize()` call. So the regression test lives in its **own dedicated file**
(`frontend/__tests__/MermaidBlock.error-leak.test.tsx`) with a hoisted
`vi.unmock('mermaid')` at the top. The dedicated file gives a fresh module graph
per Vitest's per-file isolation — the `mermaidInitialized` guard starts `false`,
so the component's own `initialize({ … suppressErrorRendering: true })` actually
runs (it is not pre-set by a co-located test), and the component's bare
`import('mermaid')` resolves the real library rather than the global mock. This
file must contain **only invalid-syntax inputs**: real Mermaid cannot lay out a
valid SVG under jsdom (missing `getBBox` etc.), and the failure path is the one
under test — valid-diagram renders belong with the mocked tests.

> The probe (above) used the real library to establish red-on-main; the committed
> test reproduces it through the actual component. No Playwright fixture is needed
> — the leak reproduces deterministically in jsdom.

## Risk classification

**Hands-off.** No risk surface from `architectural-invariants.md` is touched: no
auth / PAT scopes, no reviewer-atomic submit pipeline, no data migration, no
cross-tab stamp, no desktop sidecar seam, no security surface
(`securityLevel: 'strict'` is unchanged). Not **B1 UI-visual**: the acceptance
outcome is mechanically DOM-assertable (absence of specific nodes), not an
eyeball judgment, and the issue is labeled `bug`, not `design`. A before/after
screenshot is still attached to the PR `## Proof` for the human's merge-time
glance.

## Scope

- **In:** the one-line `mermaid.initialize` change in `MermaidBlock.tsx` + the
  new regression test (`frontend/__tests__/MermaidBlock.error-leak.test.tsx`).
- **Out:** restyling the `.mermaid-error` fallback; any change to
  `securityLevel`; defensive DOM cleanup (rejected above); strengthening the
  pre-existing mocked XSS tripwire tests in `MermaidBlock.behavioral.test.tsx`
  (they assert call-shape only — a real gap, but pre-existing and not introduced
  by this fix; tracked separately rather than expanded here).
