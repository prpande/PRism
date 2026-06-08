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
- The disambiguation must be predictable and never destroy the user's filter view by
  accident.
- A URL in the box must **not** filter the inbox to empty (no spurious zero-state).
- Preserve the existing paste-to-open behaviour and its error handling and test coverage.

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

**Disambiguation — `looksLikePrUrl(s)` (pure helper).** A value is treated as a PR URL when,
trimmed, it matches `^https?://` **and** contains a `/pull/` or `/pulls/` segment:

```ts
export function looksLikePrUrl(s: string): boolean {
  const t = s.trim();
  return /^https?:\/\//i.test(t) && /\/pulls?\//i.test(t);
}
```

This is deliberately strict so a normal filter term (e.g. `retry`, `acme/api`) never trips
it. It only gates *whether to attempt an open*; the authoritative validity check remains the
server `parsePrUrl` call (which still rejects wrong-host / non-PR URLs with the existing
errors).

**State model — raw query vs effective filter.** `useInboxFilters` holds the **raw** input
string `query` and derives the **effective** text filter:

```
filters.text = looksLikePrUrl(query) ? '' : query
```

So when the box holds a URL, the effective filter is empty: the inbox is **not** filtered
(no zero-state flash), and `active` / `filterCount` correctly report no text filter. The
input is controlled by `query`; `clear()` resets `query` (and the facets). This keeps a
**single source of truth** for the box text and avoids the input/filter divergence that a
local-state approach would create.

**Interactions:**
- **Type** → updates `query` → live filter (unless URL-shaped, per above).
- **Paste** a URL-shaped value → auto-attempts the open (no Enter needed), matching the old
  `PasteUrlInput` paste affordance. A pasted non-URL just fills the box (becomes filter text).
- **Enter** → if the current value is URL-shaped, attempt the open; otherwise no-op (it is
  already filtering live).
- **Escape** → clears the box.

**Open action** (ported verbatim from `PasteUrlInput`): `parsePrUrl(query.trim())` → on
`{ok, ref}` `addTab` + `navigate` + clear; otherwise set the inline error from the response
(`host-mismatch` → "This PR is on {urlHost}, but PRism is configured for {configuredHost}.";
`not-a-pr-url` → "That doesn't look like a PR link."; default / network → "Couldn't parse
that URL.").

**Adaptive affordance (the "B" half).**
- Placeholder: **"Filter inbox, or paste a PR URL to open…"**.
- When the value is URL-shaped, show a small **"↵ Open PR"** hint (accent, right-aligned)
  so the mode — *Enter will navigate* — is visible. The hint is non-interactive
  (`pointer-events: none`).
- The ✕ clear button shows whenever the value is non-empty.
- **Errors render only for URL-shaped input** — a short filter term never errors. The error
  pill wraps to the line below the input (the `.search` row is `flex-wrap`).

### Wiring + removals

- `FilterBar` renders `<InboxQueryInput value={f.query} onChange={f.setQuery} />` in place of
  `FilterSearchInput`; the CI failing-count trigger, facets, sort, and summary are unchanged.
- `InboxToolbar` drops `<PasteUrlInput />`; it now wraps only `<FilterBar />` (one input row +
  the facet/sort row).
- `PasteUrlInput.tsx` / `.module.css` and `FilterSearchInput.tsx` are deleted; the `.error`
  pill styling moves into `filters.module.css`.

## Component breakdown

- **New:** `frontend/src/components/Inbox/filters/InboxQueryInput.tsx` — the merged input
  (filter binding + open action + affordance + error). `looksLikePrUrl` exported from
  `applyInboxFilters.ts`.
- **Changed:** `useInboxFilters.ts` (raw `query` + derived `filters.text` + `setQuery`,
  replacing `setText`); `FilterBar.tsx` (render `InboxQueryInput`); `InboxToolbar.tsx` (drop
  `PasteUrlInput`); `filters.module.css` (`.openHint`, `.error`, `flex-wrap` on `.search`).
- **Deleted:** `FilterSearchInput.tsx`, `PasteUrlInput.tsx`, `PasteUrlInput.module.css`, and
  the two `PasteUrlInput` test files (cases ported).

## Testing strategy

- **`looksLikePrUrl`** (pure): URLs with `/pull/` and `/pulls/` → true; bare terms, repo
  slugs, and `http` URLs without a pull segment → false.
- **`useInboxFilters`**: a plain term sets `filters.text`; a URL-shaped `query` yields
  `filters.text === ''` (inbox unfiltered) and `active === false` for the text axis; `clear`
  resets `query`.
- **`InboxQueryInput`** (ported + new): Enter on a valid URL → `addTab` + navigate; paste of a
  valid URL → opens **without** Enter; host-mismatch / not-a-pr-url / network → the matching
  error pill; typing a plain term never calls `parsePrUrl`; the "↵ Open PR" hint shows only
  for URL-shaped input; Esc and ✕ clear.
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

## Open questions / known rough edges

- **`↵ Open PR` hint overlaps a long URL.** The hint is absolutely positioned over the
  input's right padding; for a very long pasted URL the text can scroll under it. Acceptable
  for a transient affordance, but flagged for the B1 eyeball — could be mitigated with a
  right-padding reservation when the hint is shown.
- **Heuristic breadth.** `looksLikePrUrl` requires a `/pull(s)/` segment. A user who pastes a
  GitHub URL that is *not* a PR (e.g. an issue) gets no open affordance and it becomes filter
  text — correct, but worth confirming the owner doesn't expect a "that's not a PR" nudge for
  github.com non-PR URLs (today a pasted non-`/pull/` github URL silently filters).
- **B1 screenshots** were not captured in the implementing pass; to be produced for the
  owner's sign-off.
