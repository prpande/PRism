# Frontend npm-audit remediation + recurring 0-vuln CI gate (#614)

**Date:** 2026-06-24
**Issue:** [#614](https://github.com/prpande/PRism/issues/614)
**Tier:** T2 (light) · **Risk:** hands-off (within-range security patches + CI config; XSS-render path live-verified)

## Problem

`npm audit` reported 7 advisories in the `frontend/` workspace (2 high, 2 moderate,
3 low), including XSS-class advisories in the markdown/diagram sanitization path
(`dompurify`, `mermaid`) that PRism reaches when rendering untrusted PR content.
There is no recurring audit gate, so the tree can rot back to vulnerable.

## Scope pivot vs. the issue as filed

The issue was filed assuming `npm audit fix` (non-`--force`) "clears none" and that
the real fixes need direct-dep bumps — with `vite` possibly needing a major bump.
**That premise is now stale.** Patched versions have since been published *inside the
current semver ranges*, so a plain `npm audit fix` resolves **all 7** advisories with
**no `package.json` change** (lockfile-only) and **no major bumps**:

| Package | Range (unchanged) | Resolved | Severity | Shipped? |
|---|---|---|---|---|
| dompurify | transitive | 3.4.11 | moderate | yes (mermaid sanitization) |
| mermaid | ^11.14.0 | 11.15.0 | moderate | yes |
| react-router(-dom) | ^7.15.0 | 7.18.0 | low | yes |
| vite | ^8.0.10 | 8.1.0 | high | dev only |
| undici | transitive | 7.28.0 | high | dev only |
| esbuild | transitive | 0.28.1 | low | dev only |

Result: `found 0 vulnerabilities`. Net 13 packages removed, 17 changed. Nothing
remains to document as an "accepted" advisory.

## Decisions

### 1. Dependency fix: `npm audit fix` (lockfile-only)
No manual `package.json` edits — every fix is within the existing `^` range, so the
bump is carried entirely by `package-lock.json`. This keeps the declared dependency
contract stable and the diff auditable.

**Durability.** The declared minima in `package.json` (`^11.14.0` mermaid, `^8.0.10`
vite, `^7.15.0` react-router-dom) are left unchanged. A fresh lockfile regeneration
resolves each `^` range to its *highest* satisfying version — i.e. the patched one, not
the floor — so a regen does not reintroduce the advisory. Belt-and-suspenders, the CI
audit gate (Decision 2) catches any future sub-floor regression on every PR. We do
**not** bump the minima here (keeps the change purely lockfile, and the gate is the
durable defense). Out-of-scope follow-up candidate, not done here: an `npm` Dependabot
ecosystem entry (current `dependabot.yml` covers `github-actions` only) so these deps
advance proactively rather than relying on a frozen lockfile.

### 2. CI gate: hard zero, whole tree (owner directive)
Add one step to the `build-and-test` frontend job in `ci.yml`:

```yaml
- name: Frontend audit (fail on any vulnerability)
  working-directory: frontend
  run: npm audit --audit-level=low
```

- **Whole tree, not `--omit=dev`.** The owner's target is a hard zero across shipped
  *and* dev-tooling deps — a dev-only advisory is surfaced as loudly as a shipped one.
- **No `audit-ci` / allowlist.** Zero new dependencies and no allowlist file to curate
  or rot. `--audit-level=low` makes any low-or-above advisory red the build.
- **Step runs last in the job.** A job halts at the first failing step, so the audit
  runs after lint/build/test — a vulnerability alert (or a transient registry blip)
  never masks compile/test results for an otherwise-valid PR.

**Accepted tradeoffs (owner-directed; surfaced for the merge decision):**

- **Tree-wide freeze on an unfixable upstream advisory.** Because the gate fails the
  whole tree, the day a new dev-only transitive advisory is published with no in-range
  fix, it reds CI on *every* PR until addressed — not a scoped alert. This is the cost
  of "hard zero, whole tree," and the owner chose it knowingly. The escape hatch is the
  **relaxation PR edits this very audit step, so it self-clears its own red gate** (no
  deadlock); relaxing the gate is a deliberate, reviewed act, not a silent weakening.
- **Registry/temporal coupling.** `npm audit` queries the live npm advisory DB at run
  time, so pass/fail depends on registry availability and the current advisory set, not
  only on committed code: a registry outage can red the job with no code change, and a
  newly-published advisory against an already-pinned version flips green→red overnight.
  Accepted as inherent to the `npm audit` approach (the alternative — a pinned allowlist
  tool — was rejected for curation burden). A registry-availability red clears on re-run.

Rejected: `--omit=dev` scoping (owner wants dev churn surfaced, not hidden);
`audit-ci` with allowlist (extra dependency + curation burden for no gain at zero).
If the tree-freeze tradeoff proves too disruptive in practice, the owner-authorized
path is a **separate CI-design follow-up issue**, not an in-place weakening here.

## Verification

- `npm audit --audit-level=low` → `found 0 vulnerabilities`, exit 0 (the gate passes).
- `npm run lint`, `npm run build`, `npm test` (2365 tests) all green on the bump.
- **XSS-render path (security-relevant):** unit tests *mock* mermaid (global success
  stub + a failure-path override), so the suite does not exercise real mermaid 11.15.0
  / dompurify 3.4.11 rendering. Therefore live-verify in the running app:
  - **Happy path:** render a real mermaid diagram + assorted markdown (heading, bold,
    link, syntax-highlighted code) via the composer preview and confirm an actual
    `<svg>` diagram renders (not the loading placeholder, not the error fallback).
  - **Adversarial path (proves the fix, not just the render):** render a mermaid diagram
    and markdown carrying XSS payloads (`<img src=x onerror=…>`, `<script>`,
    `javascript:` link) and confirm **no dialog/script executes**, the payload appears as
    inert label text inside the SVG, and the `javascript:` href is neutralized. A
    happy-path render alone would not prove the sanitizer closed the advisory.
  - Both screenshots captured for Proof.
- **Sanitization boundary is deliberate (single layer).** `MermaidBlock` injects the
  rendered SVG via `dangerouslySetInnerHTML` and relies entirely on Mermaid's
  `securityLevel: 'strict'` (which sanitizes via its bundled DOMPurify) — there is no
  app-level `DOMPurify.sanitize()` fallback, and we are not adding one (out of scope for
  advisory remediation, and over-sanitizing valid Mermaid SVG is a real regression risk).
  This delegation is now called out in a load-bearing-security comment at the
  `mermaid.initialize` call so a future edit can't silently drop `securityLevel: 'strict'`.
- **Deprecation sweep (issue item 5):** clean `npm ci` of the fixed lockfile emits
  **zero** deprecation warnings — nothing to fix or document.

## Out of scope

Desktop/Electron advisories — tracked separately in #615 (require Electron 33→42 +
electron-builder 25→26 major upgrades).
