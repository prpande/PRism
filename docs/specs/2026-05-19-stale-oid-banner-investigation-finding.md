---
status: Final
spec: docs/specs/2026-05-19-stale-oid-banner-investigation-design.md
investigation_date: 2026-05-21
---

# Stale-OID SSE/Reload-banner investigation — finding

## Header

- **Investigation date:** 2026-05-21
- **Spec:** [`docs/specs/2026-05-19-stale-oid-banner-investigation-design.md`](2026-05-19-stale-oid-banner-investigation-design.md)
- **Captures:** three instrumented runs (A/B/C) of `s5-real-stale-commit-oid.spec.ts` (un-skipped locally, uncommitted) against `prpande/prism-sandbox` PR #6, plus one Phase-3 falsification run (D).
- **Log capture path:** on-disk `FileLoggerProvider` file `<DataDir>/logs/prism-2026-05-21.log` per run (`PRISM_FILE_LOGGER_FORCE=1`). DataDirs: A `PRism-e2e-real-1779382446181`, B `…731093`, C `…861569`, D (falsification) `…3473019`.
- **Playwright trace zip:** `frontend/test-results/<testdir>/trace.zip` per run. **Note:** the trace records the `/api/events` request but NOT the streamed SSE `data:` frames (Out-of-band #4); boundary 6 was established by code inspection and then confirmed empirically by the Phase-3 falsification run.
- **`gh api` snapshot log (timestamp, head.sha only — PII-stripped):** A — branch-ref flip `5686b718`→`7b4bc0e2` at 16:54:14–16:54:25Z, `pulls/6.head.sha` caught up by 16:54:25–16:54:36Z (lag ≤ 22 s). B — branch-ref + `pulls/6` both `ccdf92c1` by 16:59:22Z (lag < 11 s). C — both `876cc148` by 17:01:32Z (lag < 11 s).

## 1. Executive verdict

The Reload banner never surfaces because **every `pr-updated` SSE event is dropped by the frontend page handler on a `prRef` type mismatch** — the backend serializes `prRef` as an object `{owner,repo,number}`; `useActivePrUpdates.ts:30` compares it as a string `"owner/repo/number"`, so `object !== string` is always true and the handler returns before updating state. This is a static wire-contract mismatch, not a timing or propagation effect. The decision tree terminates at its step-4 frontend-handler quadrant, but the mechanism is **none of the four enumerated hypotheses**: H1/H2/H3 are empirically refuted by the captured logs, and H4's specific mechanism (a React mount-race) does not match. The wire mismatch was then **confirmed by a Phase-3 falsification test** (§ 3.2): projecting `prRef` to a string made the banner surface.

## 2. Boundary-table observations

Consistent across all three captures A/B/C (and falsification run D):

| # | Boundary | Observed |
|---|----------|----------|
| 1 | GitHub PR record (REST `pulls/{n}`) | `head.sha` reached SHA-B within ≤ 22 s (A) / < 11 s (B, C) — **well within the 30 s budget**. |
| 2 | `PollActivePrAsync` → `TickAsync` `HeadSha` | `snapshot.HeadSha` flipped SHA-A→SHA-B; `headChanged=True`, `firstPoll=False` on the head-change tick. |
| 3 | `state.LastHeadSha` (`PrevHeadSha`) | `prevHead` non-null = SHA-A (`5686b718`), `≠` snapshot — correct delta detection. |
| 4 | `_bus.Publish(ActivePrUpdated)` | Published with `HeadShaChanged=true` (EventId-4 fan-out line confirms). |
| 5a | `SseChannel.OnActivePrUpdated` fan-out | `subscribers=1 headShaChanged=True`. |
| 5b | Per-subscriber `WriteAsync` outcome | `success=True`. |
| 6 | Frontend `useActivePrUpdates` handler | Banner never renders. **Evidence is code inspection** (the trace cannot show SSE frames — Out-of-band #4) **plus the Phase-3 falsification run**, which proves the frame reaches the live tab. |

Per-run head-change ticks: A `16:54:28.528Z` `head=7b4bc0e2`; B `16:59:16.505Z` `head=ccdf92c1`; C `17:01:30.621Z` `head=876cc148` — each `prevHead=5686b718 firstPoll=False headChanged=True`, each followed at the same millisecond by `subscribers=1 headShaChanged=True` and delivery `success=True`. The three captures establish the **backend signature is stable** — it rules out an intermittent subscriber-count race (an H3 variant) — but the root cause is deterministic and is proven by § 3.1–3.2, not by triplication.

## 3. Decision-tree walk (spec § 4.4)

- **Step 1** — Does boundary 2 ever show `head=SHA-B`? **YES** (all 3 runs). → step 2.
- **Step 2** — `firstPoll=true` at that line? **NO** (`firstPoll=False`). → not H2. → step 3.
- **Step 3** — `SubscriberCount=0`, or `Success=false`, or no `data:` frame? `5a=1` and `5b=True` refute the first two disjuncts. The third disjunct ("trace shows no `data:` event") is **unevaluable** — the Playwright trace cannot record SSE frames at all (Out-of-band #4). It was resolved instead by the Phase-3 falsification (§ 3.2), which proves the frame *does* reach the live tab. → step 3 = **NO**. → step 4.
- **Step 4** — Backend boundaries 2/4/5 consistent, frame reaches the handler, banner missing → the tree's frontend-handler quadrant. The spec labels this quadrant "H4" and enumerated one mechanism for it — a React mount-race in `useActivePrUpdates.ts:26-29`. That mechanism does **not** match: no remount occurs at the head-change tick and the `pr-updated` listener is attached. The actual mechanism in this quadrant is a wire-contract mismatch the spec's four hypotheses did not enumerate.

### 3.1 Root cause

`SseChannel.OnActivePrUpdated` (`SseChannel.cs:252-258`) serializes the **raw** `ActivePrUpdated` record: `JsonSerializer.Serialize(evt)`. `ActivePrUpdated.PrRef` is a `PrReference` record `(string Owner, string Repo, int Number)`, so the wire payload carries `prRef` as a nested **object** `{"owner":…,"repo":…,"number":…}`. Every *other* SSE event routes through `SseEventProjection.Project`, which emits `prRef` as `PrReference.ToString()` → the **string** `"owner/repo/number"`. `SseEventProjection.cs:7-9` documents the split: "pr-updated / inbox-updated continue to serialize the event record directly."

The frontend never agreed to the object contract. `events.ts:25-30` types `PrUpdatedEvent.prRef` as `string`; `events.ts:151-154` `JSON.parse`s the frame with no transform; `useActivePrUpdates.ts:30` runs `if (event.prRef !== refStr) return;`. Object `!==` string → the handler returns and `setState` never fires. Empirically, **every head-change `pr-updated` event in all three captures was dropped**; by the static contract the same guard rejects *every* `pr-updated` event regardless of class, though only the head-change class was exercised. The mismatch survived undetected because `pr-updated` head-change delivery has never been exercised end-to-end — this very spec, the only test that would, was `test.skip`-ed.

### 3.2 Phase-3 falsification test (spec § 4.6)

Because step 3's trace disjunct was unevaluable, a single-variable Phase-3 test was run (run D): `OnActivePrUpdated` was changed locally to emit `prRef` as `evt.PrRef.ToString()` (string), nothing else. The spec then **progressed past the line-110 banner assertion** — it reached the *second* `submit review` click (only reachable after the banner appears, is clicked, and mark-viewed completes). This confirms: (a) the `pr-updated` frame *does* reach the live tab's handler; (b) the lone fan-out subscriber *is* the live tab, not an orphan — an orphan delivery would not have surfaced the banner; (c) the `prRef` mismatch is the **sole** cause of the banner non-surfacing. H3 is definitively ruled out. The experimental change was reverted; the production fix ships via writing-plans.

## 4. Pre-investigation prediction vs. outcome

The spec § 4.2 desk-analysis priors, recorded before any log reading: **H1 ~70%** (GitHub PR-record propagation lag exceeding budget — "most likely"); **H2 ~10%** (first-poll-after-subscribe loses the delta — "unlikely"); **H3 ~20%** (SSE delivery during a subscriberId rebind — "unlikely"); H4 carried no prior.

**Outcome: every prior was wrong.** H1 is the most decisively refuted — boundary-1 propagation was ≤ 22 s in all runs, far inside the 30 s budget. The actual cause was a static wire-contract mismatch none of the four hypotheses named. What the desk analysis missed: it took `SseEventProjection.cs`'s comment that `pr-updated` keeps its "wire contract unchanged" at face value, without checking whether the frontend's `PrUpdatedEvent` contract ever *agreed* with that object shape — it never did. The analysis also concentrated on runtime mechanics (propagation, polling, SSE delivery, mount-race) and never inspected the serialized payload shape, because no end-to-end test ever exercised it.

## 5. Handoff to writing-plans

**None of the spec's sketches (§ 6.1 H1 / 6.2 H2 / 6.3 H3 / 6.4 H4) apply.** Per spec § 12 A7, a bounded sketch-amendment:

> **Sketch amendment — H5: project `pr-updated` to the string-`prRef` wire shape.** Add an `ActivePrUpdated` arm to `SseEventProjection.Project` (or an equivalent `ActivePrUpdatedWire` record) emitting `prRef` as `e.PrRef.ToString()`, and route `OnActivePrUpdated` through the projected payload exactly as `FanoutProjected` does. Reconcile the second field mismatch in the same change: the frontend `PrUpdatedEvent` expects `commentCountDelta: number`, the backend record carries `CommentCountChanged: bool` + `NewCommentCount: int?`. The delta *is* derivable — `ActivePrPoller` already holds `state.LastCommentCount` (prev) and `snapshot.CommentCount` (new) at the publish site — so the poller can carry a delta, or the frontend can switch to count + changed. `writing-plans` owns that representation choice. Coverage: a wire-contract test asserting the `pr-updated` payload shape (the gap that hid this bug), plus the un-skipped real-flow spec.

The 60 s budget bump (§ 6.5) still ships; it is harmless and orthogonal.

## 6. Out-of-band findings

1. **Fresh-worktree `wwwroot` race.** Playwright's `webServer` starts the backend (`dotnet run`) concurrently with `globalSetup`'s `npm run build`; on a fresh worktree `PRism.Web/wwwroot` does not pre-exist, so the backend initialises static-file serving with no web root → `/` returns no `text/html` → the `prism-session` cookie is never stamped → `/api/auth/connect` returns 401 from `SessionTokenMiddleware`. Workaround: build the frontend once before the first run. Deserves a harness fix (build before launching `webServer`, or fail fast).
2. **Stale-OID fixture drift.** The `e2e-real-stale-oid-fixture-prpande` branch had drifted — `Calc.cs` was a prior run's 2-line `advanceHead` output, not the 6-line seed, so `anchorLine 3` did not exist and the spec failed at the "add comment on line 3" click. `setup-real-e2e-fixtures` had blessed the drifted tip *as* `baseOid`, and `resetSandboxFixture` force-resets to that. Repaired by deleting + recreating the branch (now PR #6). `advanceHead` has no post-run cleanup; any interrupted run drifts the fixture permanently.
3. **Spec has no `test.setTimeout()`.** The committed spec's internal waits sum to ~150 s+, but `playwright.real.config.ts` sets no per-test `timeout`, so Playwright's 30 s default kills the test before line 110. The spec's un-skip plan (§ 8.1) bumps only the line-110 *assertion* timeout — it must also raise the *test-level* timeout, or the un-skip is dead on arrival.
4. **Playwright trace does not capture SSE `data:` frames.** Spec § 4.3 names "Playwright trace network frames (EventSource `data:` events)" as the boundary-6 evidence source. Empirically the trace records the `/api/events` request but not the streamed frames. Boundary 6 needs code inspection, a Phase-3 falsification, or browser-side instrumentation.
5. **DataDir is not surfaced by the harness.** Spec § 4.1 step 2 says the runbook "captures this path from the Playwright stdout banner" — no such banner exists. An investigation-local `console.log` in `playwright.real.config.ts` was added to locate the log file.
6. **Secondary `pr-updated` field mismatch.** Beyond `prRef`, the frontend expects `commentCountDelta` while the backend sends `commentCountChanged`/`newCommentCount`; comment-count `pr-updated` events are independently broken (`undefined` → `NaN` in the reducer). Folded into the § 5 fix.
7. **Second-submit "stale drafts" gate (downstream, separate bug).** In the Phase-3 run, after the banner appeared and was clicked, the spec's second `submit review` button was `disabled` with title "Resolve or override the stale drafts in the Drafts tab first." The spec (lines 117-129) expects the second submit to proceed straight into the stale-OID recreate flow. This is a distinct defect in the post-head-change drafts/submit interaction, outside the banner investigation's scope — it needs its own follow-up.
