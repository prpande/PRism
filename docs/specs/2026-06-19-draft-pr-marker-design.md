# Draft PR marker — inbox + PR-detail (#501) — design

**Status:** design / awaiting human review
**Issue:** [#501 — Draft PRs are indistinguishable from ready PRs](https://github.com/prpande/PRism/issues/501)
**Branch base:** `V2`
**Classification:** UI-visual → **gated** (retains human spec/plan review gates)

---

## 1. Summary

A GitHub draft PR (`state = open, draft = true`) currently renders **identically to a normal
open PR** on the PR-detail header, and is only weakly distinguished in the inbox. This slice
makes a draft unmistakable on both surfaces, sourced from GitHub's `draft` flag end-to-end.

The chosen visual treatment is **info-blue** (reuses the existing `--info` semantic token): a
distinct dotted draft glyph + a `Draft` marker, in both light and dark.

**Where the payoff actually lands** (the issue's "reviewers waste attention on drafts" framing is
only half the story — see §7): GitHub never surfaces drafts under `review-requested`, so a
reviewer scanning their review queue won't see one there. The two real wins are:

- **Inbox (`authored-by-me`):** you can tell at a glance which of *your own* open PRs are still
  drafts vs. ready. Drafts can also appear under `awaiting-author` / `mentioned`; the marker is
  applied uniformly wherever `isDraft` is true.
- **PR-detail header:** anyone who lands directly on a draft (a deep link, a mention, a
  Slack/notification jump) gets an unambiguous marker before sinking review effort into an
  unfinished PR. This is the higher-leverage half.

**Explicitly out of scope** (note as follow-up issue, not built here):
- A **draft facet in the inbox filter bar** (`applyInboxFilters` / `FilterBar`).
- Any change to *which* sections drafts appear in, or to GitHub's review-requested semantics.
- **Live draft↔ready transition on the open PR-detail page** — see §6 / §9 (load-time only).

## 2. What already exists (V2) vs. what this slice adds

Most of the **inbox** plumbing landed with #410. This slice completes the inbox a11y/visual
gaps and builds the **PR-detail** side end-to-end.

**Already present on V2 — reused, not rebuilt:**
- Backend inbox path parses GitHub's `draft` field: `GitHubSectionQueryRunner` →
  `RawPrInboxItem.IsDraft` → `PrInboxItem.IsDraft`.
- Frontend inbox item type has `isDraft: boolean`.
- `InboxRow` renders a GitHub-derived `Draft` chip in the AI-category-chip slot, **mutually
  exclusive** with the AI chip (`pr.isDraft && !isDone ? <draftChip> : <categoryChip>`), with
  **no AI-mode gate** and **no AiMarker spark**. The chip is already AI-independent.
- `InboxRow` already owns `PR_GLYPH_PATH` / `PR_GLYPH_CLASS` (open/merged/closed octicons) and
  the `CI_GLYPH_LABEL` single-source-of-truth pattern for tooltip-and-aria.
- All four inbox sections enabled by default; **no draft-exclusion filter** anywhere (the
  `!i.IsDraft` predicate gates *enrichment only*, not display).

**Added by this slice:**
1. **Backend PR-detail path:** read the draft flag in `GitHubPrParser` and carry `IsDraft` on
   the `Pr` record (§3).
2. **Frontend types:** `isDraft: boolean` on `PrDetailPr` (§4).
3. **Shared glyph module:** extract `PR_GLYPH_PATH` / `PR_GLYPH_CLASS` / a new `PR_GLYPH_LABEL`
   (with a `draft` entry) out of `InboxRow` into a shared module consumed by both `InboxRow` and
   `PrHeader` (§5).
4. **Inbox completion:** recolour the `Draft` chip to info (incl. hover); use the draft glyph;
   fix the **aria-label** to say `· draft` (§5).
5. **PR-detail header:** introduce a **state glyph for all states** (open/merged/closed/draft)
   plus an info `Draft` marker, marker-only behaviour (§6).
6. **Sandbox draft fixture** + a verification step (§7).
7. **Tests** (incl. a backend regression test pinning draft visibility) + regenerated visual
   baselines (§8).

## 3. Backend — parse draft on the PR-detail path

The inbox path already parses `draft`; the PR-detail path does not.

- **Transport:** the PR-detail header is fed by the **GraphQL** path
  (`GitHubReviewService.GetPrDetailAsync` → `GitHubPrParser.ParsePr`). The GraphQL query
  **already selects `isDraft`** (`GitHubReviewService.cs` ~line 42) — **only the parser read is
  missing.** Do **not** touch the REST `pulls/{n}` path: it feeds `ActivePrPollSnapshot` (the
  live poll), a different DTO that never carries the PR object to the header, and is out of scope
  for the marker.
- **Parse:** read `isDraft` (bool, default `false` when absent/null) inside
  `GitHubPrParser.ParsePr`, mirroring `GitHubSectionQueryRunner`'s null-safe read.
- **DTO:** add `IsDraft` (bool, default `false`) to the **`Pr` record** (`Pr.cs`) — alongside
  `IsMerged` / `IsClosed`, which live there (not on `PrDetailDto`). `PrDetailDto` ships `Pr` as
  its `pr` field unchanged. `FakePrReader` / fakes gain the field so tests can emit drafts.
- **Wire shape:** additive boolean; no existing field changes.

## 4. Frontend — data

- `frontend/src/api/types.ts`: add `isDraft: boolean` to `PrDetailPr` (the inbox item type
  already carries it). No other DTO touched.

## 5. Inbox treatment (consolidate + complete a11y)

The `Draft` chip stays where it is and stays GitHub-derived. Changes:

1. **Shared glyph module.** Extract `PR_GLYPH_PATH`, `PR_GLYPH_CLASS`, and a new
   `PR_GLYPH_LABEL` from `InboxRow.tsx` into a shared module (e.g.
   `frontend/src/components/shared/prStateGlyph.ts`). Add a `draft` entry to all three:
   - path = the dotted git-pull-request-draft octicon,
   - class = `prDraft` (colour `--info-fg`),
   - label = `'Draft PR'` (`PR_GLYPH_LABEL` is the single source for both the SVG `<title>`
     tooltip and the aria state word, mirroring the existing `CI_GLYPH_LABEL` pattern; other
     entries: `'PR open' | 'PR merged' | 'PR closed'`).
2. **Recolour the chip** (`.draftChip` in `InboxRow.module.css`): from neutral
   `--surface-3` / `--text-2` to info `--info-soft` / `--info-fg`. Because `--info-soft` is a
   tinted (blue) surface — unlike `--surface-3`, which abutted `--row-hover` in dark — the
   chip no longer vanishes on hover, so the **neutral `--row-hover-pill` override is dropped for
   the draft chip** and replaced with an explicit info-tinted hover (e.g.
   `.row:hover .draftChip { background: color-mix(in oklch, var(--info-soft) 88%, var(--info-fg)); }`)
   so the chip still reads as raised on a hovered row in both themes.
3. **Status glyph:** for `state = open && isDraft` (i.e. not done), the status column renders the
   `draft` glyph via a derived `glyphState = isDraft && !isDone ? 'draft' : prState`. The
   `PrState` *type* is unchanged; `glyphState` is a separate display discriminant.
4. **a11y — full aria-label.** For a draft open row the label is:
   `` `${pr.title} · ${pr.repo} · draft · iteration ${pr.iterationNumber}${unread}${ciSuffix}` ``
   i.e. `draft` occupies the same slot the state word `open` did; `unread` / CI suffixes are
   unchanged; the AI-provenance suffix never applies to drafts (not enriched).
5. **Narrow width.** Below the existing 560px container breakpoint `.chipWrap` is hidden (all
   chips, existing behaviour), so the **draft glyph alone** distinguishes the row at that width —
   accepted, not a regression.

Precedence: merged/closed (`isDone`) always win — a merged-or-closed draft (e.g. a closed
draft) renders as merged/closed, never draft (the existing `!isDone` guard covers chip and glyph).

## 6. PR-detail header

The header currently shows no state icon — open/merged/closed are conveyed by text/pills only.
Per owner decision (2026-06-19), this slice introduces a **full header state-glyph set** rather
than a draft-only glyph (which would be visually inconsistent).

- **State glyph (all states):** render a leading state glyph in `PrHeader` for
  open/merged/closed/draft, consuming the shared `prStateGlyph` module from §5 (same paths,
  classes, `<title>` labels). Colours match the existing semantics: open `--success-fg`, merged
  `--merged-fg`, closed `--danger-fg`, draft `--info-fg`. Derivation reuses the same
  `glyphState` rule (`isDraft && prState === 'open' ? 'draft' : prState`); `isDraft` is threaded
  from `data.pr.isDraft` exactly as `prState` is derived from `isMerged`/`isClosed`.
- **Draft marker:** when `prState === 'open' && isDraft`, also render an info `Draft` marker as a
  `chip chip-info` in the **subtitle chip row**, alongside the existing `ciSummary` /
  `mergeability` / `iterationLabel` chips (so the existing loading-skeleton chip slots cover it
  with no extra skeleton). "Marker" is the term used throughout (not "pill"/"badge").
- **No behaviour change:** submit affordances, composer copy, and all enable-rules are
  untouched. A non-draft open PR is visually unchanged **except** for gaining the new open-state
  glyph (intended, per the full-set decision).
- **Load-time only:** the marker reflects the state of the loaded DTO. A draft↔ready toggle made
  on GitHub *while the detail page is open* does **not** live-update, because `ActivePrUpdated`
  carries only `IsMerged`/`IsClosed`, not draft. This matches the pre-existing merged/closed
  live behaviour. Threading `isDraft` onto `ActivePrUpdated` is a **follow-up** (§9), not this
  slice.

## 7. Inbox visibility — verify, don't "fix"

Code analysis (this slice's pre-work, corroborated by an adversarial review that could not
falsify it) shows drafts are **not** filtered out: `authored-by-me` (`author:@me`) returns the
viewer's own drafts; the Search-API draft flag is parsed null-safely; enrichment preserves
`IsDraft` and populates `HeadSha` so drafts survive the non-empty-`HeadSha` materialization
filter; `InboxDeduplicator` only collapses review-requested/mentioned; and the `!IsDraft`
predicate gates AI enrichment only. Drafts do **not** appear under `review-requested` — that is
GitHub's own semantics (you are not asked to review a draft), which this slice keeps.

- **No code change** to section queries or visibility.
- **Verification (manual / real-flow):** with the sandbox draft fixture present, confirm the
  authored draft appears under **`authored-by-me`** with the new marker. Record in PR `## Proof`.
- **Regression guard (automated):** because the manual check is a one-shot, add the backend test
  in §8 so a future edit to the section queries / materialization filter / deduplicator can't
  silently start dropping authored drafts.
- **Conditional fix:** only if verification shows an authored draft is genuinely missing despite
  the code do we open a follow-up — with the exact repro in hand. Not assumed here.

### Sandbox draft fixture

Extend the real-flow fixture provisioning to create one long-lived **draft** PR on
`prpande/prism-sandbox`: branch `e2e-real-draft-fixture-<login>`, opened as a draft (REST POST
`/pulls` with `draft: true`, or GraphQL `createPullRequest(draft: true)`). Concretely:

- Extend the `SandboxFixture.name` union in `frontend/e2e/real/helpers/sandbox-fixture.ts`
  (currently `'happy' | 'foreign' | 'lost-response' | 'stale-oid'`) to add `'draft'`, and add
  `'draft'` to the `FIXTURE_NAMES` `as const` array in the setup script.
- Add the `draft` case to `setup-real-e2e-fixtures.ts` (create branch + draft PR) and to the
  reset/repair helper, idempotent like the existing four (re-run = no-op).

**Local-dev / pre-release only**, not wired into CI. Guard creation so an inadvertent CI run of
the helper cannot create a live PR on the sandbox (mirror the existing real-flow gating).

## 8. Testing & baselines

- **Unit (frontend):**
  - `InboxRow` — draft row renders the draft glyph (class/`data-pr-state` = draft), the
    info-coloured chip, and aria-label suffix `· draft`; merged/closed draft still renders
    done-state (precedence); non-draft open row unchanged.
  - `PrHeader` — open/merged/closed/draft each render the correct state glyph; the `Draft`
    marker is present when `open && isDraft`, absent otherwise; no change to submit affordances.
- **Unit (backend):**
  - `GitHubPrParser.ParsePr` reads `isDraft` from the GraphQL payload (true / false / absent).
  - `Pr` record carries `IsDraft`; `FakePrReader` can emit a draft.
  - **Visibility regression guard:** a draft in the `authored-by-me` Search result survives
    enrichment + dedup + materialization and lands in the `authored-by-me` section with
    `IsDraft = true` (orchestrator / section-runner level).
- **Visual baseline (fake e2e):** add a draft PR to the deterministic `FakePrReader` fixture so a
  draft row (inbox) and draft header (PR-detail) appear in a baseline. Note the full-header-glyph
  decision rebaselines **all PR-detail header** screenshots (open/merged/closed gain a glyph),
  not only the draft shot. Regenerate affected screenshots on **both** platforms (linux from the
  CI artifact, win32 locally), exactly per the established baseline-regeneration process.

## 9. Follow-ups (not this slice)

- **Live draft↔ready update** on the open PR-detail page: thread `isDraft` onto `ActivePrUpdated`
  alongside `IsMerged`/`IsClosed` so the marker/glyph updates without a reload.
- **Inbox draft filter facet** (`FilterBar` / `applyInboxFilters`).

## 10. Decisions & deviations (from ce-doc-review, 2026-06-19)

- **Header treatment:** owner chose a **full header state-glyph set** (open/merged/closed/draft)
  over a draft-pill-only or draft-only-glyph approach. Consequence: PR-detail header baselines
  rebaseline broadly (§8). The earlier mockup showed a header glyph; this decision generalises it.
- **Colour:** info-blue (`--info`), chosen over neutral-grey (GitHub-faithful but blends in) and
  warning-amber (reads as caution). Both `--info*` tokens exist in light and dark; no new token.
- **Glyph constants shared**, not duplicated, between `InboxRow` and `PrHeader` (§5).

## 11. Acceptance

- A draft PR in the inbox shows the dotted draft glyph + info `Draft` chip + `· draft` in the
  accessible name, distinct from a normal open PR; merged/closed still win; the chip stays
  info-tinted on hover; at <560px the glyph alone distinguishes the row.
- The PR-detail header shows the correct state glyph for every state and an info `Draft` marker
  for a draft PR; a non-draft open PR is unchanged apart from the new open glyph.
- `draft` is parsed on the GraphQL PR-detail path and present on `PrDetailPr` (inbox item already
  has it).
- All markers/glyphs render correctly in light and dark.
- The sandbox draft fixture exists; the authored draft is verified to appear under
  `authored-by-me`; the backend regression guard pins that path.
