# Merged inbox query input — one box for "filter" and "open PR" (#262 B1 follow-on)

> **Status / provenance.** This design was approved conversationally during the
> #262 B1 visual pass and **already implemented** (branch
> `feature/262-inbox-taxonomy`, commit `6d123cf6`). This spec is written
> **retrospectively at the owner's request** to (a) document the deviation from
> #262's "retain `PasteUrlInput` alongside the filter bar" decision and (b) put the
> design through `ce-doc-review`. Findings may drive changes to **both** this doc
> and the committed code.

## Problem

The #262 filter/sort bar added a free-text **filter** input to the inbox toolbar,
sitting alongside the pre-existing PR-URL **paste** input (`PasteUrlInput`). During
the B1 visual pass the owner found two stacked full-width text boxes — one to paste a
URL, one to filter — visually cluttered and semantically odd: they look identical but
do unrelated things. Two text inputs stacked vertically, both "type here," is poor IA.

The two inputs are also **never used at the same time** and a PR URL is essentially
always **pasted**, never hand-typed (it is long). That makes them a candidate to merge
into a single input whose behaviour is disambiguated by *what the user enters*.

## Verified facts (against the branch at `6d123cf6`)

- **`PasteUrlInput`** (now deleted): a controlled `<input>` that, on paste (auto) or
  Enter, called `inboxApi.parsePrUrl(raw)` (server: `POST /api/inbox/parse-pr-url`); on
  `{ok, ref}` it `addTab`'d and `navigate`'d to `/pr/{owner}/{repo}/{number}` and cleared;
  otherwise it showed an inline error pill (`host-mismatch` / `not-a-pr-url` / parse /
  network). Its only consumer was `InboxToolbar`. It had two test files (7 + 1 cases).
- **`FilterSearchInput`** (now deleted): a controlled `<input>` bound to the
  `useInboxFilters` text state; every keystroke updated the live client-side filter.
- **`useInboxFilters`**: held `filters = {text, ci[], repos[], authors[]}`; `applyInboxFilters`
  filters the snapshot by `filters.text` (case-insensitive substring on title **or** repo)
  plus the facets. `clear()` resets everything.
- **`InboxToolbar`**: a vertical stack (full-width paste input row, then the
  filter/facet/sort row) — from the immediately-prior B1 relayout.

## Goals

- **One** toolbar input that does both jobs: **type → filter** the inbox live; **paste a
  PR URL → open** that PR.
- The disambiguation must be predictable. **Honest tradeoff:** paste-to-open is an
  *intentional, non-confirmable* navigation — pasting a PR URL discards the current (transient)
  filter view and opens the PR. That is accepted collateral, not a bug; the tight
  `looksLikePrUrl` gate keeps it from firing on anything but an actual PR URL, so it is not
  *accidental*. What it must never do is the *silent* failure — strip the filter and attempt
  an open the server then rejects (fixed by aligning the heuristic to the server parser).
- **No URL** (PR or otherwise) may filter the inbox to empty (no spurious zero-state).
- Preserve the existing paste-to-open behaviour, its error handling, and its test coverage.

## Non-goals

- No change to the filter/sort/facet behaviour, the section model, or the backend.
- No new URL-parsing capability — the authoritative parse stays the existing server
  endpoint. The client only adds a cheap *heuristic* to decide whether to attempt an open.
- No multi-step "command palette". This is a single input with a paste/Enter action.

## Design

### One merged input (`InboxQueryInput`)

A single controlled `<input>` replaces both `FilterSearchInput` and `PasteUrlInput`. It is
the first row of the filter bar (`FilterBar`), with the accent magnifier icon on the left;
`InboxToolbar` no longer renders a separate paste box.

**Disambiguation — two pure helpers (case-insensitive).** Two distinct predicates, because
"is this a URL" (don't filter by it) and "is this an openable PR URL" (offer/do the open) are
different questions — collapsing them caused the spurious-zero-state and false-open bugs the
`ce-doc-review` adversarial pass found:

```ts
// Any http(s) URL — used to strip the effective filter so a URL never filters the inbox.
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

// A PR URL we can actually open — mirrors the server parser's owner/repo/pull/{number}
// shape: anchored, singular `pull`, numeric id. Used to gate the open action + affordance.
export function looksLikePrUrl(s: string): boolean {
  return /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.test(s.trim());
}
```

`looksLikePrUrl` is deliberately tight so it **agrees with the authoritative server parser**
(`GitHubReviewService`: segment-2 == `pull`, numeric id). It rejects the plural `…/pulls/42`,
a branch path like `…/tree/feat/pull/x`, and non-numeric ids — all values the server would
reject, so the client never strips the filter and fires an open that is guaranteed to fail.
It accepts `…/pull/42` and deep links (`…/pull/42/files`). The server `parsePrUrl` call
remains the final validity check (host-mismatch, etc.).

**State model — raw query vs effective filter.** `useInboxFilters` holds the **raw** input
string `query` and derives the **effective** text filter by stripping **any** URL (not just PR
URLs):

```
filters.text = looksLikeUrl(query) ? '' : query
```

So when the box holds *any* URL, the effective filter is empty: the inbox is **not** filtered
(no spurious zero-state — including for a pasted non-PR GitHub URL like an issue/commit/repo
link), and `active` / `filterCount` correctly report no text filter. The input is controlled
by `query`; `clear()` resets `query` (and the facets). This keeps a **single source of truth**
for the box text and avoids the input/filter divergence a local-state approach would create.

**Interactions:**
- **Type** → updates `query` → live filter (any URL-shaped value is stripped, so it doesn't
  filter; a `looksLikePrUrl` value also surfaces the open affordance).
- **Paste** a `looksLikePrUrl` value → auto-attempts the open (no Enter needed), matching the
  old `PasteUrlInput` paste affordance. A pasted non-URL fills the box as filter text; a
  pasted non-PR URL fills the box but does not filter (see affordance below).
- **Enter** → if the current value is `looksLikePrUrl`, attempt the open; otherwise no-op
  (it is already filtering live).
- **Escape** → clears the box.

**Open action.** `parsePrUrl(query.trim())` → on `{ok, ref}` `addTab` + `navigate` + clear;
otherwise set the inline error from the response (`host-mismatch` → "This PR is on {urlHost},
but PRism is configured for {configuredHost}."; `not-a-pr-url` → "That doesn't look like a PR
link."; default → "Couldn't parse that URL."; network/unreachable → "Couldn't reach the
server. Try again."). **Guarded** (added per `ce-doc-review`, because the merged box makes
"keep typing after paste" a first-class flow the old paste-only box never had):
- **In-flight guard:** while one `open()` is awaiting `parsePrUrl`, a second trigger
  (fast double-Enter, Enter-during-paste) is ignored — so a single URL opens exactly once.
- **Staleness guard:** the value is captured at submit; if by the time the parse resolves the
  box has been cleared or edited into a non-PR-URL, the resolved success/error is **dropped**
  (no navigate-away from a now-different intent). The check is "still a PR URL", not byte-exact
  equality, to tolerate paste settling the controlled value across two events.

**Adaptive affordance (the "B" half).**
- Placeholder: **"Filter inbox, or paste a PR URL to open…"**.
- When the value is `looksLikePrUrl`: a small accent **"↵ Open PR"** hint (right-aligned,
  `pointer-events: none`) signals *Enter will navigate*. It is decorative (`aria-hidden`), so
  an **sr-only** "Press Enter to open this PR" cue is rendered for assistive tech.
- When the value is a URL but **not** a PR URL (`looksLikeUrl && !looksLikePrUrl`): a muted
  **"Not a PR link"** hint, so a pasted issue/commit/repo URL gives feedback instead of
  silently doing nothing (the inbox stays unfiltered, not a fake empty state).
- The ✕ clear button shows whenever the value is non-empty. The native `type="search"` clear
  control is suppressed (CSS) so it doesn't double up with the custom ✕.
- **Errors render only for URL-shaped input** — a short filter term never errors; the error
  clears on the next edit. The pill (`role="alert"`, with an `id` referenced by the input's
  `aria-describedby` + `aria-invalid`) wraps to the line below the input (`.search` is
  `flex-wrap`).

### Wiring + removals

- `FilterBar` renders `<InboxQueryInput value={f.query} onChange={f.setQuery} />` in place of
  `FilterSearchInput`; the CI failing-count trigger, facets, sort, and summary are unchanged.
- `InboxToolbar` drops `<PasteUrlInput />`; it now wraps only `<FilterBar />` (one input row +
  the facet/sort row).
- `PasteUrlInput.tsx` / `.module.css` and `FilterSearchInput.tsx` are deleted; the `.error`
  pill styling moves into `filters.module.css`.

## Component breakdown

- **New:** `frontend/src/components/Inbox/filters/InboxQueryInput.tsx` — the merged input
  (filter binding + guarded open action + affordance + error + a11y). `looksLikeUrl` and
  `looksLikePrUrl` exported from `applyInboxFilters.ts`.
- **Changed:** `useInboxFilters.ts` (raw `query` + derived `filters.text = looksLikeUrl(query)
  ? '' : query` + `setQuery`, replacing `setText`); `FilterBar.tsx` (render `InboxQueryInput`);
  `InboxToolbar.tsx` (drop `PasteUrlInput`); `filters.module.css` (`.openHint`,
  `.openHintMuted`, `.error`, `flex-wrap` on `.search`, native search-clear suppression). The
  sr-only cue reuses the global `.sr-only` utility (`tokens.css`).
- **Deleted:** `FilterSearchInput.tsx`, `PasteUrlInput.tsx`, `PasteUrlInput.module.css`, and
  the two `PasteUrlInput` test files (cases ported).

## Testing strategy

- **`looksLikePrUrl`** (pure, case-insensitive): `…/pull/42` and deep links (`…/pull/42/files`)
  → true; plural `…/pulls/42`, branch path `…/tree/x/pull/y`, non-numeric `…/pull/x`, bare
  terms → false.
- **`looksLikeUrl`** (pure): any `http(s)://…` → true; bare terms / repo slugs → false.
- **`useInboxFilters`**: a plain term sets `filters.text`; a URL-shaped `query` (PR **or**
  non-PR, e.g. `…/issues/9`) yields `filters.text === ''` (inbox unfiltered) and
  `active === false` for the text axis; `clear` resets `query`.
- **`InboxQueryInput`** (ported + new): Enter on a valid URL → `addTab` + navigate; paste of a
  valid URL → opens **without** Enter; host-mismatch / not-a-pr-url / network → the matching
  error pill (associated via `aria-describedby`); typing a plain term never calls `parsePrUrl`;
  **double-Enter on a valid URL → exactly one** navigate (in-flight guard); a non-PR URL shows
  the muted "Not a PR link" hint; a PR URL shows "↵ Open PR"; Esc and ✕ clear; error clears on
  edit.
- **e2e** (`inbox-filter.spec.ts`, `inbox.spec.ts`): exactly one toolbar input; filtering
  still narrows live; pasting a PR URL still navigates / shows host-mismatch through the
  merged input; light + dark.

## Risk classification

- **Tier:** T2 (single-component UI change + a small hook refactor; no backend).
- **Risk:** **B1 — UI-gated.** The merged input changes the inbox's most-used affordance;
  needs the owner's visual sign-off (placeholder, the "↵ Open PR" hint, the error pill
  position). No auth / token / data-shape / migration surface; the trust boundary is
  unchanged (same `parsePrUrl` endpoint, same client-supplied URL it already accepted).

## Rejected alternatives

- **Keep two stacked boxes (status quo).** The owner's explicit B1 rejection — two identical
  full-width inputs doing unrelated things is poor IA.
- **Approach B alone (live per-keystroke URL detection that flips the box into "open
  mode").** Adds per-keystroke heuristic state and a filter-then-flip flicker on paste; the
  chosen design uses paste/Enter as the action trigger and reserves the heuristic for the
  *affordance + filter-stripping* only, which is simpler.
- **Approach C (visually unify two inputs into one bordered control, no behaviour change).**
  Doesn't deliver the single box the owner wanted; still two inputs.
- **Local input state in the component, conditionally synced to the filter.** Creates
  input/filter divergence and a fiddly clear-sync; deriving `filters.text` from a single raw
  `query` in the hook is cleaner.
- **Filtering by the URL text (no stripping).** A URL matches no titles, so the inbox would
  show "No PRs match your filters" while a URL sits in the box — reads as broken. Hence the
  effective-text stripping.

## Resolved by ce-doc-review (2026-06-08)

- **Heuristic vs server mismatch (adversarial P1) — fixed.** `looksLikePrUrl` was loosened to
  `pulls?` + unanchored, accepting shapes the server rejects. Tightened to the server's
  `owner/repo/pull/{number}` shape; the client and server now agree.
- **Non-PR URL spurious zero-state (adversarial P2 / design) — fixed.** Effective-filter
  stripping now keys off `looksLikeUrl` (any URL), so an issue/commit/repo URL no longer
  filters the inbox to a fake empty state; it shows the muted "Not a PR link" hint.
- **Async open race (adversarial / design) — fixed.** In-flight + staleness guards added.
- **A11y (design P1) — fixed.** Error associated via `aria-describedby`/`aria-invalid`; sr-only
  "Press Enter to open this PR" cue for the decorative hint.

## Open questions / known rough edges

- **`↵ Open PR` hint overlaps a long URL.** Absolutely positioned over the input's right
  padding; for a very long pasted URL the text can scroll under it. Acceptable for a transient
  affordance; flagged for the B1 eyeball (could reserve right-padding when shown).
- **Magnifier icon in URL mode (design DL-04).** The left icon stays a magnifier even when the
  box is acting as a "paste URL / open" control; the placeholder + "↵ Open PR" hint carry the
  mode. Accepted as-is unless the owner wants the icon to swap in URL mode — **owner call at B1.**
- **Single-user discoverability (product P3).** Paste-to-open is now discoverable only via the
  placeholder + the URL-shaped hint. Moot for the sole owner-user who designed it; noted so the
  trade is on record if the user base ever grows.
- **B1 screenshots** to be produced for the owner's sign-off.
