# Wire `eslint-plugin-react-hooks` — design

**Issue:** #331 (epic #317, Theme D, p1) · **Tier:** T2 · **Risk:** hands-off

## Problem

`frontend/eslint.config.js` wires only `@eslint/js` + `@typescript-eslint`. No
`eslint-plugin-react-hooks`, so neither `rules-of-hooks` nor `exhaustive-deps`
runs. Dep-array correctness across a heavily hooks-driven codebase is maintained
purely by hand-written discipline — and six source comments document the gap
("the react-hooks plugin is not wired into this project's flat eslint config").
The whole stale-closure bug class those comments mitigate is exactly what the
plugin automates.

## Goal

Wire the plugin, drive `npm run lint` to green with **zero unexplained
findings**, and update the now-stale "plugin not wired" prose — converting prose
justifications into auditable, machine-checked suppressions.

## Key decisions

### D1 — Enable two rules, NOT the v7 `recommended-latest` preset

The current plugin is v7 (only version supporting ESLint 10). Its
`recommended-latest` preset enables ~17 rules, including the React-Compiler-era
set (`immutability`, `purity`, `set-state-in-effect`,
`preserve-manual-memoization`, `static-components`, …). This issue is about
**dep-array correctness**; its AC names exactly two rules. Adopting the
Compiler rules is a separate, larger decision (a future issue). So we register
the plugin and enable **only**:

- `react-hooks/rules-of-hooks: 'error'`
- `react-hooks/exhaustive-deps: 'error'`

### D2 — Severity = error (not warn)

`eslint .` exits non-zero only on errors, not warnings. The AC wants "zero
unexplained warnings" and CI enforcement. Because the triage drives findings to
zero (suppress intentional + fix the two real instabilities + test override),
we can set both rules to `error` — a true guardrail that fails CI on any *new*
violation. This is the issue's "error once the triage is done" target.

### D3 — Test files: relax `exhaustive-deps` only; keep `rules-of-hooks` enforcing

Two findings live in test files: a one-shot `useEffect(..., [])` mount probe
(`DrawerEffects.test.tsx:19`, `exhaustive-deps`) and a `rules-of-hooks` false
positive (`useCantEditRootBodyReason.test.tsx:16` calls a **pure function that is
misnamed `use*`** directly via a `call()` helper, per its own comment).

The two rules are not equal-value in tests. `exhaustive-deps` is genuinely
low-signal in test code — probes and `renderHook` wrappers legitimately violate
dep-exhaustiveness — so we **disable only `exhaustive-deps`** for test globs
(`**/*.test.{ts,tsx}`, `**/__tests__/**`). `rules-of-hooks`, by contrast, catches
a real bug class even in tests (a conditional/looped hook call inside a custom
test hook or `renderHook` wrapper), so it **stays at `error`** in test files. The
single `rules-of-hooks` false positive gets a targeted per-line
`// eslint-disable-next-line react-hooks/rules-of-hooks` on the `call()` helper.

**Flat-config ordering:** the test-override block must be the **last** entry in
the `eslint.config.js` array. ESLint flat config applies later blocks over
earlier ones for matching files; placed before the main `**/*.{ts,tsx}` block it
would be silently overridden for test files.

### D4 — Fix vs. suppress

A finding is **fixed** only when the rule has correctly identified a real (if
minor) instability and the fix is non-behavioral. Two qualify — an unstable
`data?.x ?? []` array feeding a downstream `useMemo`; the rule explicitly
recommends wrapping it in `useMemo`. The wrap is correct regardless of upstream
behavior and produces identical output; it stabilizes the downstream memo
whenever `data?.items`/`data?.sections` is referentially stable across renders
(and is a harmless no-op when the upstream returns a fresh array each poll).
Preferred over a suppression because the rule's own recommended fix is cheap and
honest. Everything else is a pattern the rule cannot
statically express (deliberate primitive-spread, memo-bust keys, array-spread,
one-shot mount, stable-member dep) → **targeted suppression with rationale**.

### D5 — No behavioral changes; bugs would be filed separately

The AC requires triage bugs to be filed/fixed separately. After reading every
site: **zero actual latent bugs**. Every omission is intentional and currently
correct. This validates the codebase's manual rigor; the plugin now freezes it.

## Triage table (35 messages: 34 `exhaustive-deps` + 1 `rules-of-hooks`)

Count note: 35 is **eslint messages**, not unique lines. 33 distinct lines, but
`useWholeFileContent.ts:102` emits **two** `exhaustive-deps` messages on one line
(a missing-`file` dep + a "complex expression in the dependency array") and
`useCantEditRootBodyReason.test.tsx:16` is the lone `rules-of-hooks` — 33 + 1
double + 1 rules-of-hooks = 35. A single disable directive on line 102 covers
both messages there.

**Fix — `useMemo`-wrap unstable derived array (2):**

| Site | Rationale |
|------|-----------|
| `ActivityRail.tsx:166` | `all = data?.items ?? []` → new ref each render, feeds `visible` memo. Wrap. |
| `pages/InboxPage.tsx:44` | `sections = data?.sections ?? []` → feeds `maxDiff` memo. Wrap. |

**Test handling (2):** `DrawerEffects.test.tsx:19` (`exhaustive-deps` one-shot
probe) → covered by the D3 test-glob override; `__tests__/useCantEditRootBodyReason.test.tsx:16`
(`rules-of-hooks` on a pure `use*`-named fn) → per-line directive on `call()`.

**Suppress — `prRef.owner/repo/number` primitive-spread (15 lines):** the
effect/memo depends on the three stable primitive fields, not the `prRef` object
(a fresh literal each render that would re-fire on unrelated parent re-renders).
Sites: `useAiDraftSuggestions:27`, `useAiFileFocus:28`, `useAiHunkAnnotations:27`,
`useAiSummary:28`, `useCrossTabPrPresence:126`, `useCrossTabPrPresence:160`,
`useDraftSession:123`, `useDraftSession:153`, `useFileDiff:44`,
`useFirstActivePrPollComplete:30`, `usePrDetail:88`,
`useRootCommentPostedSubscriber:27`, `useStateChangedSubscriber:41`,
`useUnionDiff:46`, `useWholeFileContent:195`.

**Suppress — `file`-object primitive-spread (1 line, 2 messages):**
`useWholeFileContent:102`. Same primitive-spread pattern but over the `file`
object (`[enabled, path, file === null, file?.status, file?.hunks.length]`), not
`prRef`. The line emits two `exhaustive-deps` messages (missing-`file` dep +
"complex expression `file === null`"); one directive covers both. The in-code
rationale references `file`, not `prRef`.

**Suppress — stable-member dep `draftSession.refetch` / narrowed members (4):**
`PrDetailView:78`, `FilesTab:389`, `FilesTab:498`, `FilesTab:535`. Depends on the
stable `useCallback` member, not the per-render `draftSession` object literal.

**Suppress — deliberate memo-bust key the rule calls "unnecessary" (2):**
`AskAiDrawerContext:181` (`threads` busts the value memo on Map mutation — the
consumer-visible re-render trigger; removing it would break re-renders),
`useSyntaxTokens:141` (`input.headSha`/`baseSha` bust the token memo on
force-push / PR-nav). Both removing-would-be-a-bug; suppress, do **not** remove.

**Suppress — caller-supplied `...deps` array-spread (2):** `useLockedPaneScroll:109`,
`useTreeHScroll:104`. The rule can't statically verify a spread.

**Suppress — id-keyed re-sync (2):** `ExistingCommentWidget:96`,
`PrRootConversation:87`. Effect keys on `existingDraft?.id` while reading the
object; re-syncs only when the draft *id* changes (documented).

**Suppress — one-shot first-mount `[]` (1):** `PrDetailView:111` (`clearUnread`
is a stable `useCallback([])`; `refKey` one-shot — host owns later clears).

**Suppress — parent-recreated function (1):** `PrHeader:218` (`onSessionRefetch`
is re-created each render by `PrDetailPage`; including it would re-run every
render. `submit.clearLastResume` is stable). The deeper fix — a `useCallback` in
the parent — belongs to decomposition issue **#327**; cross-link, don't fix here.

**Suppress — manual dep-list of a local function (1):** `FeedbackModal:215`
(focus-trap effect lists `requestClose`'s reactive deps `{onClose, dirty,
modalState.kind}` — verified to be exactly `requestClose`'s closure deps —
instead of the per-render function). Rationale names the contract.

## Prose-comment updates (6 occurrences, 5 files)

The "react-hooks plugin is not wired / not enabled" boilerplate becomes false the
moment this lands. Update each to reflect the rule is now active and (where the
site is now suppressed) point at the directive: `SettingsModal:43`,
`HelpModal:92`, `FeedbackModal:176`, `PrTabHost:42`, `PrDetailView:107`,
`PrDetailView:172`. (The issue said "four" — drift since the review snapshot
added `Feedback`/`Help` modals and a second `PrDetailView` mention.)

## Verification

- `npm run lint` green (eslint + prettier) locally; CI runs the same.
- `npm run build` (`tsc -b && vite build`) clean — suppressions/memos are
  type-neutral.
- `vitest run` green — no test behavior changed (test override only relaxes
  lint, not runtime).
- Pre-PR re-check: confirm the diff in draft/composer/submit-adjacent files is
  comment/directive-only (no logic edits) → stays hands-off.
- Lockfile: `@emnapi/core` + `@emnapi/runtime` optional/peer entries re-spliced
  after the Windows `npm install` dropped them; `rm -rf node_modules && npm ci`
  green (Linux-CI safe).

## Out of scope (named, not done)

- v7 React-Compiler rules (D1) → future issue.
- `useCantEditRootBodyReason` misnaming (`use*` on a pure fn) → minor; the test
  override neutralizes the false positive without renaming the public symbol.
- `PrHeader.onSessionRefetch` / `requestClose` deeper `useCallback` fixes →
  #327 / micro-cleanup; suppression with rationale is the in-scope answer.

## ce-doc-review dispositions (1× pass, T2)

- **Count "33/34 not 35" (coherence P1, scope #1) — Rejected claim / clarity
  applied.** Ground truth is 35: the feasibility reviewer ran `eslint .` and
  confirmed 35; the other two miscounted by treating `useWholeFileContent:102`'s
  two messages as one. Added the explicit count note + split that line into its
  own bucket.
- **`useWholeFileContent:102` mis-bucketed under `prRef` (scope #3) — Applied.**
  Now its own `file`-spread row; in-code rationale references `file`.
- **D3 test override too broad + flat-config ordering (adversarial P2, scope #2)
  — Applied.** Test override now disables only `exhaustive-deps`;
  `rules-of-hooks` stays `error` in tests with a per-line directive for the lone
  false positive; override block placed last.
- **Per-line disable can mask a future new dep (adversarial residual) — Noted,
  accepted.** Inherent to `eslint-disable-next-line`; mitigated by rationale
  comments that name the specific contract. Periodic re-audit when a suppressed
  body is edited.
- **PrHeader:218 precise rationale (adversarial residual) — Noted.** The existing
  in-code comment already states the accurate reason (including the dep would
  re-refetch every render while parked in `success`); preserved verbatim.
- **`useMemo`-wrap perf benefit depends on upstream ref stability (scope
  residual) — Applied.** Softened D4 to note the wrap is correct/harmless
  regardless and only stabilizes on a stable upstream ref.
