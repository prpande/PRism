# Draft PR marker — inbox + PR-detail (#501) — design

**Status:** design / awaiting human review
**Issue:** [#501 — Draft PRs are indistinguishable from ready PRs](https://github.com/prpande/PRism/issues/501)
**Branch base:** `V2`
**Classification:** UI-visual → **gated** (retains human spec/plan review gates)

---

## 1. Summary

A GitHub draft PR (`state = open, draft = true`) currently renders **identically to a normal
open PR** on the PR-detail header, and is only weakly distinguished in the inbox. This slice
makes a draft unmistakable on both surfaces, sourced from GitHub's `draft` flag end-to-end, and
adds a live draft fixture + verification so we can confirm authored drafts actually reach the
inbox.

The chosen visual treatment is **info-blue** (reuses the existing `--info` semantic token): a
distinct dotted draft glyph in the status column + a `Draft` chip/pill, in both light and dark.

**Explicitly out of scope** (note as follow-up issue, not built here):
- A **draft facet in the inbox filter bar** (`applyInboxFilters` / `FilterBar`).
- Any change to *which* sections drafts appear in, or to GitHub's review-requested semantics
  (see §7 — drafts surface under `authored-by-me`, by design).

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
- All four inbox sections enabled by default; **no draft-exclusion filter** anywhere (the
  `!i.IsDraft` predicate gates *enrichment only*, not display).

**Added by this slice:**
1. **Backend PR-detail path:** parse the draft flag in the PR-detail fetch and carry `IsDraft`
   on the PR-detail DTO (§3).
2. **Frontend types:** `isDraft: boolean` on `PrDetailPr` (§4).
3. **Inbox completion:** recolour the `Draft` chip to info; add a draft-specific **status glyph**;
   fix the **aria-label** to say `· draft` (§5).
4. **PR-detail header:** a `Draft` marker pill + draft glyph, marker-only (no behaviour change) (§6).
5. **Sandbox draft fixture** + a verification step that an authored draft appears under
   `authored-by-me` (§7).
6. **Tests + regenerated visual baselines** (§8).

## 3. Backend — parse draft on the PR-detail path

The inbox path already parses `draft`; the PR-detail path does not.

- **Parse:** in the PR-detail fetch (`GitHubReviewService` → `GitHubPrParser`), read the draft
  flag from both transports: REST `draft` (bool) and GraphQL `isDraft` (bool). Default `false`
  when absent/null (mirror `GitHubSectionQueryRunner`'s null-safe read).
- **DTO:** add `IsDraft` (bool, default `false`) to the PR-detail DTO record alongside
  `IsMerged` / `IsClosed`. `FakePrReader` / fakes gain the field so tests can emit drafts.
- **Wire shape:** additive boolean; no existing field changes. (`PrDetailPr.state` stays the
  GitHub state string; draft is an orthogonal sub-flag of the open state.)

## 4. Frontend — data

- `frontend/src/api/types.ts`: add `isDraft: boolean` to `PrDetailPr` (the inbox item type
  already carries it). No other DTO touched.

## 5. Inbox treatment (consolidate + complete a11y)

The `Draft` chip stays where it is and stays GitHub-derived. Three changes:

1. **Recolour the chip** (`.draftChip` in `InboxRow.module.css`): from neutral
   `--surface-3` / `--text-2` to info `--info-soft` / `--info-fg`, with a hover-pill variant
   (mirror the existing `.row:hover .draftChip` per-theme handling). No spark; not AI-gated.
2. **Status glyph:** introduce a `'draft'` display state. When `state = open && isDraft` (i.e.
   not done — merged/closed take precedence), the status column renders the **dotted
   git-pull-request-draft octicon**, tinted `--info-fg`. Implemented as a derived
   `glyphState = isDraft && !isDone ? 'draft' : prState`, extending `PR_GLYPH_PATH` /
   `PR_GLYPH_CLASS` with a `draft` entry. The `PrState` *type* is unchanged; draft is a glyph
   concern only.
3. **a11y:** the open-row aria-label suffix becomes `· draft` instead of `· open` when the row
   is a draft (replaces the state word; CI / unread / iteration suffixes unchanged).

Precedence: merged/closed (`isDone`) always win — a merged-or-closed draft renders as
merged/closed, never draft (matches the existing chip guard `!isDone`).

## 6. PR-detail header

- `PrHeader`: accept `isDraft` (derived from `data.pr.isDraft`, threaded like `prState` is from
  `isMerged`/`isClosed`). When `prState === 'open' && isDraft`, render a **`Draft` pill** (info
  colours) next to the title and use the dotted draft glyph for the header state icon.
- **No behaviour change:** submit affordances, composer copy, and all enable-rules are
  untouched — this is a marker only. A non-draft open PR is visually unchanged.

## 7. Inbox visibility — verify, don't "fix"

Code analysis (this slice's pre-work) shows drafts are **not** filtered out: `authored-by-me`
(`author:@me`) returns the viewer's own drafts and nothing downstream removes them. Drafts do
**not** appear under `review-requested` — that is GitHub's own semantics (you are not asked to
review a draft), which we keep (decision **(i)**).

- **No code change** to section queries or visibility.
- **Verification (manual / real-flow):** with the sandbox draft fixture present, confirm the
  authored draft appears under **`authored-by-me`** with the new marker. Record the result in
  the PR's `## Proof`.
- **Conditional fix:** only if that verification shows an authored draft is genuinely missing
  despite the code do we open a follow-up to fix it — with the exact repro in hand. Not assumed
  here.

### Sandbox draft fixture

Extend the real-flow fixture provisioning (`frontend` `setup-real-e2e-fixtures` /
`e2e/real/helpers/gh-sandbox.ts`) to create one long-lived **draft** PR on
`prpande/prism-sandbox`: branch `e2e-real-draft-fixture-<login>`, opened as a draft (the GraphQL
`createPullRequest` `draft: true`, or REST `draft: true`). Idempotent like the existing four
fixtures (re-run = no-op; repair by delete + re-run). This is **local-dev / pre-release only**,
not wired into CI.

## 8. Testing & baselines

- **Unit (frontend):**
  - `InboxRow` — draft row renders the draft glyph (`data-pr-state`/glyph class = draft),
    the info-coloured chip, and aria-label suffix `· draft`; merged/closed draft still renders
    done-state (precedence); non-draft open row unchanged.
  - `PrHeader` — `Draft` pill present when `open && isDraft`, absent for non-draft open / merged
    / closed; no change to submit affordances.
- **Unit (backend):**
  - PR-detail parser reads `draft` from REST and `isDraft` from GraphQL (true / false / absent).
  - PR-detail DTO carries `IsDraft`.
- **Visual baseline (fake e2e):** add a draft PR to the deterministic `FakePrReader` fixture so
  a draft row (inbox) and draft header (PR-detail) appear in a baseline; regenerate the affected
  screenshots on **both** platforms (linux from the CI artifact, win32 locally), exactly per the
  established baseline-regeneration process.

## 9. Risks / notes

- **Baseline churn:** adding a draft to the fake fixture rebaselines the inbox + pr-detail
  shots that include it. Keep the draft fixture isolated so unrelated baselines don't move.
- **Token reuse, no new token:** info colours come from the existing `--info*` set — both themes
  already define them; no `tokens.css` addition.
- **Glyph precedence:** the `!isDone` guard is the single source of "draft only modifies open";
  reused identically in `InboxRow` (chip + glyph) and `PrHeader`.

## 10. Acceptance

- A draft PR in the inbox shows the dotted draft glyph + info `Draft` chip + `· draft` in the
  accessible name, distinct from a normal open PR; merged/closed still win.
- The PR-detail header shows an info `Draft` marker for a draft PR; non-draft open unchanged.
- `draft` is parsed on the PR-detail path and present on `PrDetailPr` (inbox item already has it).
- Both markers render correctly in light and dark.
- The sandbox draft fixture exists and the authored draft is verified to appear under
  `authored-by-me`.
