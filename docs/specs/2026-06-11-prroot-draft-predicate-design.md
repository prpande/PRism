# #324 — Unify the "PR-root draft" predicate (one definition per language)

**Issue:** #324 (epic #317, Theme C). **Tier:** T2. **Risk:** gated B2 (submit pipeline + state migration).
**Status:** spec — **owner-gated 2026-06-11: Variant B + full consolidation approved.** Proceeding to TDD.

## Problem

A `DraftComment` (`PRism.Core/State/AppState.cs:62`) carries `FilePath`, `LineNumber`, and
`Side` as independently-nullable fields. "Is this the PR-root draft (the review summary, not a
line comment)?" is spelled independently in ~15 places across backend and frontend, in **two
semantic variants that genuinely disagree on schema-legal input**:

- **Variant A — both-null:** `FilePath is null && LineNumber is null`
- **Variant B — FilePath-only:** `FilePath is null`

They differ exactly on the **half-null** shape `(FilePath: null, LineNumber: 5)`.

### The latent correctness bug (verified against current `origin/main`)

For `(FilePath: null, LineNumber: 5)`:

| Site | Predicate | Verdict on `(null, 5)` |
|------|-----------|------------------------|
| `SubmitPipeline.cs:233` thread-attach filter | `FilePath is not null && LineNumber is not null` | **excluded** (no file) |
| `SubmitPipeline.cs:643` `ExtractPrRootBody` | `FilePath is null && LineNumber is null` | **excluded** (line ≠ null) |
| `DraftReconciliationPipeline.cs:71` | `FilePath is null` | **PR-root passthrough — never Stale** |

The submit filter and the body-extract are **complementary but not exhaustive**: the half-null
draft is shipped as **neither a thread nor the review body — it silently vanishes from the
submitted review**. Reconciliation, meanwhile, waves it through as a *healthy* PR-root that can
never go Stale, so it persists in the session as a ghost the user believes is queued.

No current writer produces `(null, 5)` — so this is **latent**, not a live data-loss bug. But
nothing pins the invariant, and the predicate drift (two variants already in the tree) is exactly
the path by which a future writer or migration introduces it.

> The fix is **test-first regardless**: even if we choose to keep the bug impossible by
> construction, the red-on-main test that demonstrates the silent drop is the artifact that proves
> the invariant is now pinned (per the issue's third acceptance criterion).

## Current sites (authoritative — citations re-verified, the issue's had drifted ~60 commits)

**Backend (8):**
1. `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:643` — both-null — picks PR-root **body**.
2. `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:233` — `FilePath is not null && LineNumber is not null` — thread-attach **guard** (the complement-ish; also a null-deref safety guard for `.LineNumber!.Value` at :312).
3. `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:307` — comment asserting `FilePath is null || LineNumber is null`.
4. `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs:71` — **FilePath-only** (Variant B). Its own comment at `:87` states the intended invariant: *"FilePath is the only field that distinguishes them."*
5. `PRism.Core/State/Migrations/AppStateMigrations.cs:253-254` — `side == "pr" && file-path == null` on **raw JSON pre-deserialization** (V7 synthesis); ignores line-number entirely.
6. `PRism.Web/Endpoints/PrRootCommentEndpoints.cs:104` — both-null.
7. `PRism.Web/Endpoints/PrDraftEndpoints.cs:265` — both-null.
8. `PRism.Web/Endpoints/PrCommentEndpoints.cs:72` — `FilePath is null || LineNumber is null` (negative: "reject root/headless as a line comment").

**Frontend (7):**
1. `frontend/src/hooks/useDraftSession.ts:104` — both-null.
2. `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx:46` — **filePath-only** (Variant B, divergent).
3. `frontend/src/components/PrDetail/PrHeader.tsx:87` — both-null.
4. `frontend/src/components/PrDetail/PrHeader.tsx:596` — `!(both-null)` (complement).
5–7. `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx:123, 302, 450` — both-null (`:450` complement).

## The design decision (this is what the gate is for)

What should `(FilePath: null, LineNumber: 5)` *do*? Two coherent designs:

### Recommended — Variant B: **`FilePath is null` is canonical; LineNumber is vestigial when FilePath is null**

PR-root ⟺ no file. A draft with no file path **cannot** be a line comment (nothing to anchor
to), so `LineNumber` is meaningless when `FilePath is null`. Consequences:

- `ExtractPrRootBody` → `FilePath is null` → `(null, 5)` is shipped **as the review body**. No silent drop.
- Reconciliation (`:71`) already uses this — it becomes the shared definition, not a divergent one.
- Thread-attach guard (`:233`) stays `FilePath is not null && LineNumber is not null` — but **reframed**: it is the *attachability* guard ("can this be posted as a line thread"), not the PR-root predicate. It still needs `LineNumber is not null` to protect the `.Value` deref at :312. A `(FilePath: "x", LineNumber: null)` malformed line comment is caught Stale by reconciliation (`:94`) and excluded from submit by `Status != Stale` (`:232`).

**Why I recommend it over the issue's own suggestion:**
- It matches the **documented** invariant (`DraftReconciliationPipeline.cs:87`). The both-null
  variant is the over-specified, accidental one.
- **Safety property (qualified): no user-authored text is silently dropped, *given the
  at-most-one-PR-root invariant*.** Every draft is either a line comment (FilePath set) or PR-root
  (FilePath null → shipped as body). The only text removed from a submit is a Stale draft, which is
  *surfaced to the user as a stale row* — never silent.
  - **Caveat (adversarial review):** the single-root invariant is enforced by the PR-root composer
    upsert at `PrDraftEndpoints.cs:265`, which uses the **both-null** lookup. A half-null ghost is
    invisible to that lookup, so a user typing in the summary composer could create a *second*
    filePath-null draft; once `ExtractPrRootBody` is `FilePath`-only and uses `FirstOrDefault`, one
    of the two bodies would be dropped. **This is why the upsert site (#7) must adopt the shared
    `FilePath`-only predicate in the *same* change** — the upsert then finds and overwrites the
    ghost instead of siblings it. A unit test must construct two filePath-null drafts and assert no
    body is silently dropped. Even unqualified, Variant B is strictly better than `main` here.
- Smaller blast radius on a B2 surface: no new validation/repair machinery, no new reject path in
  the migration or write endpoints. We change predicates to agree on the discriminator that's
  already documented; we don't add a gate that can itself reject legitimate data.

### Alternative — Variant A + reject/repair (the issue's suggested fix)

Make `FilePath is null && LineNumber is null` canonical and treat the half-null shape as **invalid
input to repair (null the LineNumber) or reject** at a chosen boundary (write endpoint, load, or
migration). Stricter — pins "a PR-root draft has no line number at all" — but:

- Contradicts the documented "FilePath is the only discriminator" invariant.
- Adds a validation/repair surface and forces a *where* decision (write path? `PrDraftEndpoints`?
  migration? deserialization?), each of which touches a risk surface and can drop or mutate data.
- A rejected half-null draft is a *worse* outcome than Variant B's: the user's text is discarded
  rather than preserved as the body.

### The tension Variant B has to answer (product-lens review): "Truthful by default"

Variant B does not just preserve the text — it **silently normalizes a malformed draft**, discarding
the `LineNumber` the (hypothetical) writer attached without surfacing that anything was off. PRism
has two named architectural invariants that pull against this:

- **"Truthful by default"** — show every draft as authored, don't filter or reshape.
- **"Banner, not mutation"** — surface abnormal/remote state to the user; never silently auto-apply.

A malformed `(null, 5)` draft quietly absorbed into the review body is exactly the kind of state
those invariants say should *surface*, not be normalized in place. So the honest framing of the
A-vs-B choice is **not** "safe B vs. lossy A." It is:

| | Variant B (FilePath-only) | Variant A (both-null + surface) |
|---|---|---|
| Half-null `(null,5)` | shipped as review body; line number silently dropped | surfaced to the user as a malformed/stale draft (Banner, not mutation) |
| "Truthful by default" | in tension (silent normalization) | aligned (surfaces the anomaly) |
| "text is sacred" | aligned (body preserved) | aligned only if the surfaced row keeps the text |
| Blast radius | predicate-only, no new machinery | adds a surfacing/validation path on a B2 surface |
| Matches `:87` documented invariant | yes | no |

**My net recommendation is still Variant B**, but with *lower confidence than I'd stake on a
non-latent bug*, for one reason that dominates: **the shape is unreachable by construction today**
(adversarial review confirmed `NewDraftCommentPayload` types `FilePath`/`LineNumber` as
non-nullable, and every other writer hardcodes both-null). So neither behavior is ever exercised by
real data — the decision is about *which invariant to pin with a test*, not about live UX. Given
that, B is the lower-machinery pin and aligns with the `:87` discriminator the code already
documents. But if you weight "Truthful by default" as the governing principle even for
unreachable-today shapes, **A is the defensible choice and I'll take it** — this is the call I want
you to make at the gate.

> **Open question feeding the choice:** is `LineNumber` on a PR-root draft ever *intended* to carry
> meaning (e.g. a future "summary anchored near line N" feature)? If yes, Variant B's "ignore it" is
> wrong. I believe the answer is no — the summary has no anchor — but it's the one assumption under
> the recommendation I can't fully verify from the code.

## Plan of change (Variant B + full consolidation — owner-approved 2026-06-11)

1. **Backend predicate (Core):** add a **`public` computed property** `DraftComment.IsPrRoot =>
   FilePath is null` on the `DraftComment` record in `PRism.Core/State/AppState.cs`. It must be
   public so `PRism.Web/Endpoints` can consume it (an `internal` extension would be invisible
   across the assembly boundary). Consume it in:
   - `SubmitPipeline.ExtractPrRootBody` (`:643`) — replace `FilePath is null && LineNumber is null` with `d.IsPrRoot`.
   - `DraftReconciliationPipeline` (`:71`) — **replace** the bare `FilePath is null` check with a
     call to `draft.IsPrRoot` (behavior identical; this makes it a *consumer*, satisfying AC#1's
     "all sites consume it", not merely a documented equivalent).
   - The PR-root composer **upsert** at `PrDraftEndpoints.cs:265` (#7) — replace its both-null lookup
     with `IsPrRoot` so the single-root invariant survives a half-null ghost (see the safety caveat
     above; this is load-bearing, not cosmetic).
   - `PrRootCommentEndpoints.cs:104` (#6) — replace both-null with `IsPrRoot`.
   - Leave the thread-attach guard (`:233`) as-is but **rename/comment** it as the attachability
     guard, not the PR-root predicate, so the two concerns stop looking like drifted copies.
   - **`PrCommentEndpoints.cs:72` (#8) is NOT consolidated.** It rejects `FilePath is null ||
     LineNumber is null` — an *attachability* guard (a reply/inline target must be fully anchored),
     which is **not** `!IsPrRoot` (= `FilePath is not null`): the latter would wrongly accept a
     `(FilePath: "x", LineNumber: null)` headless comment. Leave it as an explicit attachability
     guard (same family as `:233`), with a comment noting why it is *not* the PR-root predicate.
     This is the one site where "consolidate everything" would introduce a real behavior change.
2. **Migration (`AppStateMigrations.cs:253-254`):** operates on raw `JsonObject` pre-deserialization,
   so it can't call the typed predicate. Keep `side == "pr" && file-path == null` and add a comment
   cross-referencing the canonical predicate. **Note the relationship precisely:** the migration
   predicate is *line-number-agnostic* (so it does not exhibit the both-null over-specification) but
   it adds a `side == "pr"` gate — it is a **superset-restriction**, not identical to the typed
   `IsPrRoot`. The two agree on historical data only because every persisted PR-root row carries
   `side == "pr"`; the comment should say so rather than claim plain equivalence. Verify the
   synthesized row (`:298`) leaves `line-number` null.
3. **Frontend predicate:** export `isPrRootDraft(d: DraftCommentDto): boolean` from the existing
   `components/PrDetail/draftKinds.ts` (whose stated purpose is "prevents structural drift"), plus a
   `prRootDraft(session)` selector for the `.find` cases. Replace all 7 sites; the divergent
   `OverviewTab.tsx:46` collapses onto the shared definition. **This is part of the fix, not a no-op
   cleanup:** the FE is internally split today — for a half-null draft, `OverviewTab:46`
   (`filePath===null`) *would* hydrate the composer from the ghost, while `PrHeader:87` /
   `SubmitDialog:123` (both-null) treat it as absent, so the composer shows text the summary-count
   and discard logic ignore. Collapsing onto `FilePath`-only makes the FE internally consistent
   (and consistent with the consolidated backend).
4. **Pin it:** the red-on-main Core test below.

## Test plan (red-on-main)

- **Core unit test** constructing a session whose only PR-root-ish draft is
  `(FilePath: null, LineNumber: 5, BodyMarkdown: "ghost")`, exercised through the submit path so the
  **review body** is observable.
  - **On `origin/main`:** body is `""` (both-null required) → the ghost text is absent from the
    submitted review → **RED** (demonstrates the silent drop).
  - **On head (Variant B):** body is `"ghost"` → **GREEN**.
  - Seam (confirmed by feasibility review): `ExtractPrRootBody(session)` is the body argument to
    `BeginPendingReviewAsync` (`SubmitPipeline.cs:192`), captured by `InMemoryReviewSubmitter` as
    `InMemoryPendingReview.SummaryBody` (read via `GetPending(ref)`). Assert `SummaryBody == "ghost"`
    on head / `""` on main. Target the **Begin** step's summary body, not a finalize body; mirror
    `StaleCommitOidRetryTests`.
- **Reconciliation test:** the same `(null, 5)` draft passes through reconciliation as PR-root
  (unchanged) — documents that reconciliation and submit now *agree*.
- **Two-root test (single-root invariant, from adversarial review):** a session with **two**
  filePath-null drafts (e.g. one `(null, null, "real")` plus one `(null, 5, "ghost")`) must not
  silently drop either body. Asserts the upsert-at-`:265` consolidation maintains at-most-one-root
  and that `ExtractPrRootBody`'s `FirstOrDefault` does not strand the other's text. This is the test
  that backs the qualified safety property.
- **Frontend:** a unit test on `isPrRootDraft` pins the shared helper. No FE *behavior-change* test
  is needed for real data (the half-null shape is unreachable from the typed DTO), but the helper
  test prevents the internal FE split from re-emerging.

## Acceptance criteria

- [ ] One PR-root predicate per language — backend `DraftComment.IsPrRoot` (public computed
      property), frontend `isPrRootDraft` — and every *PR-root-identity* site calls it. The two
      *attachability* guards (`SubmitPipeline:233`, `PrCommentEndpoints:72`) are explicitly carved
      out and commented as a different concern, not consolidated.
- [ ] The half-null `(FilePath: null, LineNumber: 5)` shape has the owner-decided behavior (Variant
      A or B — see "The design decision"), with a red-on-main test demonstrating today's silent drop
      and green-on-head.
- [ ] The at-most-one-PR-root invariant survives a half-null ghost: the upsert at
      `PrDraftEndpoints:265` consumes the shared predicate, and a two-filePath-null-draft test
      asserts no body is silently dropped.
- [ ] Reconciliation, migration, `OverviewTab`, and submit agree on what "PR-root" means.
- [ ] `PrCommentEndpoints.cs:72` headless-line-comment rejection semantics verified preserved (see Risks).

## Risks / things to verify during TDD

- **`PrCommentEndpoints.cs:72` is not simply `!IsPrRoot`.** It rejects `FilePath is null || LineNumber is null` — i.e. it also rejects a `(FilePath: "x", LineNumber: null)` headless line comment, which `!IsPrRoot` (= `FilePath is not null`) would *accept*. This is a deliberate "a reply/inline target must be fully anchored" guard, not a PR-root check. **Do not blindly replace it with `!IsPrRoot`** — leave it as an explicit attachability guard (same family as `SubmitPipeline:233`) and only factor the shared *attachability* helper if it reads cleanly. Flag for the gate: this is the one site where "consolidate everything" would introduce a real behavior change.
- **B2 surfaces:** the change edits the atomic-submit body path and references the migration. No change to the GraphQL submit ordering, thread IDs, or marker protocol; no change to persisted schema (predicate-only). Reconciliation behavior is unchanged for every shape except the documentation of intent.
- **Secrets scan:** none expected (pure predicate refactor); run over the diff regardless.

## Out of scope

- Adding a `Side`-based discriminator or reworking `DraftComment` nullability (would be a schema
  change — separate issue if desired).
- The broader Web/Endpoints shared-seam extraction (#319, in progress) — this issue only touches
  the PR-root predicate, not error mapping / authz / validators.
