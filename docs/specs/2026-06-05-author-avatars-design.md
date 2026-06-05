# Author & Bot Avatars — Design Spec

> Issue #127 — Show GitHub avatars next to every username and bot name.
> Phase 3 design-parity work. Tier T2/T3, Risk **B1 (UI-visual, gated)**.

**Date:** 2026-06-05
**Status:** Approved (design); pending user spec review
**Worktree / branch:** `D:/src/PRism-127-avatars` / `fix/127-avatars`

---

## 1. Problem

Every place PRism renders a GitHub username or bot login today shows bare text.
The design language calls for a small circular avatar next to the name (the
unused `.avatar` token in `tokens.css` encodes the intended treatment: a 24px
circle with an initials fallback). This issue wires real GitHub avatars into the
author/commenter render sites.

The issue explicitly names **bot** authors (e.g. `dependabot[bot]`) as in-scope.
That constraint drives the core decision below.

## 2. Scope

**In scope — 4 real-data render sites:**

| Site | File | Author source | Avatar size |
|------|------|---------------|-------------|
| Inbox row | `frontend/src/components/Inbox/InboxRow.tsx:60` | REST `search/issues` | `sm` (20px) |
| PR header | `frontend/src/components/PrDetail/PrHeader.tsx:345` | GraphQL PR author | `sm` (20px) — revised from `lg`; see §6 |
| Root comment | `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx:46` | GraphQL root comments | `md` (24px) |
| Review comment | `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx:85` | GraphQL review threads | `sm` (20px) |

**Out of scope (deferred, documented):**

- **ActivityRail** (`frontend/src/components/ActivityRail/ActivityRail.tsx:15`).
  It is driven entirely by hardcoded mock data (`activityData.ts`) with
  non-resolvable fake logins (`amelia.cho`, `noah.s`, `ci-bot`). Rendering
  avatars against fake logins would only exercise the fallback path and bake an
  avatar dependency into a component slated to be rebuilt against real data.
  The `<Avatar>` component is built drop-in ready for the rail once it is wired
  to a real source.
- **Rounded-square shape for bots.** GitHub renders bot avatars as a rounded
  square to distinguish them from human circles. PRism v1 renders every avatar
  as a circle (matching the existing token). Distinguishing bots would require a
  login-string heuristic (`[bot]` suffix) in the component, which the chosen
  data strategy (§3) deliberately avoids. Tracked as a future enhancement.

## 3. Decision: plumb `avatarUrl` from the API (not client-side derivation)

Both data paths already expose an avatar URL at low, mechanical cost (no new
network calls, no login parsing — only DTO/mapper plumbing):

- **PR-detail (GraphQL):** `author` is an `Actor`; `avatarUrl` is directly
  selectable and resolves for **both** `User` and `Bot` actors. No extra token
  scope is required (commenter avatars are returned without `read:user`; see the
  scope comment at `GitHubReviewService.cs:21`).
- **Inbox (REST `search/issues`):** each item's `user` object is a GitHub
  simple-user that **includes `avatar_url`** on the same JSON node the code
  already reads `login` from (`GitHubSectionQueryRunner.cs:143`). No extra
  request.

**Rejected alternative — derive `https://github.com/{login}.png` client-side.**
This needs zero backend change but **breaks every bot**: `dependabot[bot]` is not
a valid path segment, so `https://github.com/dependabot[bot].png` 404s. Bots are
explicitly in scope, so the cheap path fails exactly where the issue points. It
also bakes a GitHub URL convention into the client.

**Rejected alternative — hybrid (derive for humans, special-case bots).** Adds
fragile `[bot]`-suffix heuristics in the client to reinvent a URL the API already
hands us for free on both paths.

Plumbing's only cost is mechanical DTO/mapper churn — **no new network calls, no
login parsing.** That is the chosen approach.

**URL volatility is a non-issue here.** GitHub avatar URLs carry a `?v=` cache
buster but the host (`avatars.githubusercontent.com/u/{id}`) is stable. More
importantly, the DTOs that carry `AvatarUrl` are **never persisted** — `Pr` /
comment DTOs are a per-fetch PR-detail snapshot (in-memory, keyed by head SHA)
and `PrInboxItem` is rebuilt every inbox refresh tick. The URL is fetched and
rendered within the same short-lived snapshot, so it cannot go stale on disk. A
future reader must not persist these DTOs expecting the avatar URL to stay valid.

## 4. Data flow

```
GraphQL Actor.avatarUrl ─┐
                         ├─→ Pr / IssueCommentDto / ReviewCommentDto ─→ JSON (camelCase) ─→ types.ts ─→ <Avatar>
REST   user.avatar_url ──┴─→ RawPrInboxItem ─→ PrInboxItem ──────────────────────────────┘
```

### 4.1 DTO changes (`PRism.Core.Contracts`)

Add `string? AvatarUrl` to each record that already carries an author:

- `Pr` (PR author)
- `IssueCommentDto` (root comments)
- `ReviewCommentDto` (review-thread comments)
- `PrInboxItem` (inbox rows)
- `RawPrInboxItem` (intermediate inbox record — not author-final, but the field
  must ride through it from the REST read to `PrInboxItem`; see §4.3)

Nullable: an Actor/user *may* lack an avatar URL; the component falls back to
initials when null.

**Append the new parameter with a default — `string? AvatarUrl = null` — on
every record.** This is load-bearing, not cosmetic:

- `Pr`, `PrInboxItem`, and `RawPrInboxItem` already end in optional params
  (`MergedAt = null, ClosedAt = null`). Appending a *non-defaulted* param after a
  defaulted one is a compile error (CS1737). The `= null` default is required.
- `IssueCommentDto` and `ReviewCommentDto` have no trailing default today and are
  constructed **positionally** in the mappers (`GitHubReviewService.cs:1069` and
  `:1104`) and in some tests. Appending a *required* param would break every
  positional construction site that doesn't pass it. `= null` keeps those sites
  compiling; the two mapper lines we edit pass the real value.

The mappers we touch pass the real `avatarUrl`; every other (test/seam) call site
inherits `null` unchanged.

### 4.2 GraphQL (`GitHubReviewService.cs`)

- Add `avatarUrl` to the three `author { login }` selections in the PR-detail
  query: PR author (~line 40), root comments (~line 41), review-thread comments
  (~line 43). (The timeline query at ~348–357 is not a §2 render site and is not
  changed.)
- Mappers read it next to `login`:
  - `ParsePr` — extend the local `Author()` helper area to also pull
    `avatarUrl`; pass to the `Pr` constructor.
  - `ParseRootComments` — read `avatarUrl`; pass to `IssueCommentDto`.
  - `ParseReviewThreads` — read `avatarUrl`; pass to `ReviewCommentDto`.

Missing/absent `avatarUrl` in the JSON maps to `null` (defensive read, same
pattern as other optional fields).

### 4.3 REST (`GitHubSectionQueryRunner.cs`)

- Read `item.GetProperty("user").GetProperty("avatar_url")` (defensive
  `TryGetProperty`) beside the existing `login` read at line 143; pass it to the
  `RawPrInboxItem` constructor (`GitHubSectionQueryRunner.cs:148`).
- Add `AvatarUrl` to `RawPrInboxItem`. The chain is `search/issues` JSON →
  `RawPrInboxItem` → enricher → **`PrInboxItem`**. `GitHubPrEnricher` only maps
  `RawPrInboxItem → RawPrInboxItem` (via `with { … }`); it does **not** build the
  final item. The `RawPrInboxItem → PrInboxItem` conversion — the one positional
  `PrInboxItem` construction site that must append `AvatarUrl` — is
  **`InboxRefreshOrchestrator.MaterializePrInboxItem` (method at line 265; the
  `new PrInboxItem(...)` is at line 287)**. Edit that mapper, not
  the enricher.

### 4.4 Frontend types (`frontend/src/api/types.ts`)

Add `avatarUrl?: string | null` to the 4 mirrored interfaces: `PrInboxItem`
(line 94), `PrDetailPr` (line 146), `IssueCommentDto` (line 181),
`ReviewCommentDto` (line 188). Optional **and** nullable: optional so existing
object literals compile without churn; `| null` because the backend emits an
explicit `null` (not an absent field) when an Actor has no avatar.

## 5. The `<Avatar>` component

`frontend/src/components/Avatar/Avatar.tsx` + `Avatar.module.css`.

Reuses the existing (currently unused) `.avatar` token family in `tokens.css`
(circle, `--text-inverse` on `--text-3`, sizes `.avatar-sm` 20px / `.avatar`
24px / `.avatar-lg` 32px). The component owns the JSX/state; the visual tokens
stay in `tokens.css`.

**Props:**

```ts
interface AvatarProps {
  src?: string;          // avatarUrl from the DTO; may be undefined/null
  login: string;         // author login — drives the initials fallback
  size?: 'sm' | 'md' | 'lg';  // default 'md' (24px)
}
```

**Render model — initials are the always-present base layer; the image overlays it.**
This single model handles loading, error, and `src`-change cleanly, and avoids
the two traps a naive `errored`-boolean version falls into (a nameless circle
during load, and a stale error pinning a row to initials forever):

1. The circle **always** renders the initials as its base content: the first
   character of `login` (letter **or** digit — GitHub logins may start with a
   digit, e.g. `42user` → `4`), uppercased. A leading `[bot]`-style suffix is
   stripped first, so `dependabot[bot]` → `D`. An empty `login` yields no initial
   (a plain colored circle), never a throw.
2. When `src` is truthy **and not errored for *this* `src`**, an `<img>` is
   rendered on top of the initials, filling the circle. The `<img>` carries:
   - `width:100%; height:100%; object-fit:cover; border-radius:50%; display:block`
     so it fills and clips to the circle. (The `.avatar` token has
     `border-radius:50%` but no `overflow:hidden`, so the **`<img>` itself** must
     round/cover — otherwise a non-square or pre-CSS image flashes as a square.)
   - `referrerPolicy="no-referrer"` — strips the `Referer` header on the cross-
     origin load to `avatars.githubusercontent.com` (see §8). Costs nothing.
   - `loading="lazy"` for the `sm` (inbox-list) size; `loading="eager"` (default)
     for `md`/`lg` single-PR views (see §6).
   - `alt=""` (decorative — see a11y below).
3. **Loading window:** because the initials base is always painted, the fetch
   window shows the *initials* (not a nameless disc); the image simply appears
   over them once it loads. No flash-of-nameless-circle even on a slow/lazy load.
4. **Error handling, keyed to `src` (critical):** the error state is **not** a
   lifetime-wide one-way boolean — it is scoped to the current `src`. Implement
   with `key={src}` on the `<img>` (a new `src` mounts a fresh element that
   re-attempts) **or** by deriving `errored = (erroredSrc === src)` and setting
   `erroredSrc = src` in `onError`. On error the `<img>` is dropped and the
   initials base shows through. This is required because `<Avatar>` instances are
   **reused across inbox refresh ticks** (rows are keyed on PR identity, not on
   `src`): a lifetime-wide boolean would let a transient blip (CDN hiccup, a
   momentary null→URL fixture window, a changed `?v=` cache-buster) permanently
   pin a row to initials even after a valid URL arrives. A 200 returning
   non-image bytes fires `onError` (decode failure) and degrades to initials
   correctly; a hanging request just leaves the initials showing. No defensive
   timeout is needed; a test must cover bad-`src` → rerender-with-good-`src` →
   image recovers (not stuck on initials).

**Shape:** circle for every avatar in v1 (see §2 deferral). The container's
`background: var(--text-3)` sits behind everything, so there is never a
transparent gap, and the fixed-size container reserves its space before the image
loads (no layout shift).

**Accessibility:**

- The author `login` text is **always** rendered as a sibling at every render
  site. The avatar image is therefore redundant decoration → `alt=""` and
  `aria-hidden="true"` so screen readers do not announce the name twice.
- The initials fallback is likewise `aria-hidden` (a visual stand-in for the
  adjacent name), so WCAG 1.4.3 text-contrast does not strictly gate it. It
  should still be legible: `--text-inverse` on `--text-3` computes to ≈4.5:1 in
  light mode at the `sm` 10px size — at the AA floor with no headroom. During
  implementation, verify the computed light/dark contrast (oklch→relative
  luminance, per the Phase-3 light-theme precedent); if it lands below ~4.5:1,
  bump the `sm` initials weight or darken the fallback background. Record the
  result rather than leaving it silent.
- No focusable element is added; avatars are non-interactive.

## 6. Render-site integration

The general move is: insert the avatar immediately before the existing name span,
keep the name span as the accessible label, size per the §2 table. `.avatar`'s
`flex: none` stops it shrinking. But each site has a real layout interaction that
the plan must spell out — these are not uniform, and the §2-table pattern
`<Avatar src={x.avatarUrl} login={x.author}>` does **not** apply verbatim
everywhere (PrHeader has no per-item `x`). Per-site:

- **InboxRow (`sm`).** The author span lives inside `.meta` — a `flex-wrap: wrap`
  row of `xs`/10px chips separated by dot-separators (repo · author · iter · age).
  A bare 20px circle there risks (a) a dot-separator orphaning the avatar across a
  wrap and (b) vertical misalignment with the 10px text. Wrap the avatar **and**
  its author span in a single `inline-flex; align-items: center` child with a
  small gap so the pair is atomic and the separators stay outside it.

- **PrHeader (`sm`).** **DECISION (2026-06-05, revised from `lg`):** the header avatar
  is `sm` (20px), **not** `lg` (32px). A 32px avatar in the small-text *subtitle*
  metadata row (`author · branch · status`) is taller than the ~20px text line, so it
  grew the header +12px and rippled a layout shift into every content zone below it
  (CI parity caught dimension changes in `files-tree`/`files-diff`, which have no
  avatar). `sm` matches the subtitle line height, keeps the header height unchanged,
  and is more proportionate for a metadata row. `PrHeader` receives a **flat
  `author: string` prop**, not a `pr` object — there is no `x.avatarUrl` in scope.
  The plan must: (a) add `avatarUrl?: string | null` to `PrHeaderProps`; (b) pass
  `avatarUrl={data?.pr.avatarUrl}` at the `PrDetailView.tsx:253` call site alongside
  the existing `author` prop;
  (c) render `<Avatar src={avatarUrl} login={author} size="sm">` at
  `PrHeader.tsx:345`. The author span sits in a `row gap-3` subtitle that
  `flex-wrap`s alongside other chips, so apply the same atomic-pair wrapper as
  InboxRow (avatar + name in one `inline-flex` child, a gap tighter than the
  inter-chip `gap-3`) to prevent the avatar orphaning from the name on a narrow
  window.

- **PrRootConversation (`md`).** The author sits in the card's `.band` header,
  which is `display:flex; align-items:center; padding: var(--s-2) var(--s-4)`.
  Decide and state: the 24px avatar goes **inside** the band as a leading
  `align-items:center` child. That raises the band's min-height to 24px and
  shifts its optical center — and `--rail-node-y` (the continuous-rail node Y) is
  calibrated in CSS to "band padding-top `var(--s-2)` + ~half the `--text-xs`
  line-box." The plan must **re-derive `--rail-node-y` for the avatar'd band**
  (or confirm an acceptable drift) so the rail node still points at the band, not
  above it. This is the one site where the avatar perturbs a calibrated value.

- **ExistingCommentWidget (`sm`).** `.commentMeta` is `display:flex;
  align-items:baseline`. A replaced element (`<img>`) computes its baseline as the
  bottom of its margin box, so a 20px avatar under `baseline` will sit low
  relative to the `xs` text — the same trap PrRootConversation's band already
  documents. Change `.commentMeta` to `align-items:center` when inserting the
  avatar (or set `vertical-align:middle` on the img and justify why baseline
  stays).

**Truncation tooltip.** Several name spans truncate (`text-overflow:ellipsis`,
e.g. root-comment `.author`). Give the avatar wrapper (or the name span) a
`title={login}` so the full login is discoverable on hover at every site —
specify it once here so it isn't decided ad hoc per site.

**Loading priority:** the inbox `sm` avatar uses `loading="lazy"` (a section can
hold many rows, each firing its own image request); the three single-PR detail
sites use the eager default.

## 7. Testing

**Backend (xUnit):**

- Extend the existing PR-detail mapper tests so the GraphQL fixtures carry
  `avatarUrl` on PR author, root comments, and review comments, and assert it
  reaches `Pr.AvatarUrl`, `IssueCommentDto.AvatarUrl`, `ReviewCommentDto.AvatarUrl`.
- Extend the inbox section-query test so the `search/issues` fixture carries
  `user.avatar_url` and assert it reaches `PrInboxItem.AvatarUrl`.
- One **bot** fixture (`dependabot[bot]` with a real bot `avatarUrl`) proving a
  bot avatar URL survives the mapper unchanged (the case client-side derivation
  would have broken).
- A null-`avatarUrl` fixture proving the mapper yields `null` (not an exception).
- **CORRECTION (verified at implementation — supersedes the "required prerequisite"
  originally drafted here).** Adding `avatarUrl` to `FixtureStripAllowlist.AllowedFieldNames`
  is **NOT required and would be inert**, and the mapper value assertions do **not**
  depend on the frozen fixture. Two facts, confirmed against the real code:
  (1) the mapper **value** coverage above runs against **inline JSON** in
  `GitHubReviewServicePrDetailTests`, so it can never "pass vacuously" regardless of the
  allowlist; (2) `FixtureStripAllowlist` nulls the **entire `author` object wholesale**
  (`author` is not an allowlisted container, so the stripper never recurses into it — the
  committed `pr19-graphql-response.json` confirms all 15 `author` occurrences are `null`
  with no nested `login`). Therefore adding `avatarUrl` *inside* `author` cannot change the
  stripped shape that `Frozen_pr_graphql_shape_unchanged` (7g) compares — **no fixture
  re-capture is needed and no allowlist entry is added**. See plan `docs/plans/2026-06-05-author-avatars.md`
  Task 13 (IMPLEMENTATION FINDING) for the full reasoning.

**Frontend (vitest):** `Avatar.test.tsx` —

- renders `<img>` over the initials when `src` is set;
- renders the uppercased initial as the base layer (always);
- drops the `<img>` and shows the initials when the `<img>` fires `onError`;
- **recovers on a new `src`:** render with a bad `src` → `onError` → initials,
  then rerender the *same instance* with a good `src` → asserts the `<img>`
  re-renders (the src-keyed error-reset; the regression guard for R2-01);
- strips a `[bot]` suffix before deriving the initial (`dependabot[bot]` → `D`);
- digit-leading login (`42user` → `4`); empty `login` renders a plain circle
  without throwing.

**Render-site assertions (one per layout-sensitive site, vitest DOM — cheap):**

- `InboxRow` — the avatar + author span form one atomic group (separators
  outside it);
- `PrRootConversation` — an avatar renders in the band next to the author;
- `ExistingCommentWidget` — an avatar renders in `.commentMeta` next to the
  author.

A single InboxRow presence assertion would not catch the band/rail and
baseline-alignment regressions at the other two sites.

**Parity baseline:** re-capture the affected parity zones (inbox row, PR header,
root-comment card, review-comment widget) since the avatars change the rendered
output. Pre-existing unrelated baseline drift is not in scope.

**Parity determinism (avoid a network-dependent baseline).** The parity specs run
against fake-mode fixtures. If a fixture carries a real-looking `avatarUrl`, the
captured screenshot would depend on a live fetch from `avatars.githubusercontent.com`
completing within the capture window — a 404/hang yields initials in one run and a
photo in another, busting `maxDiffPixelRatio`. Make it deterministic: either set
`avatarUrl = null` in the parity fixtures (so the zone captures the stable initials
circle) **or** `page.route`-intercept `avatars.githubusercontent.com` to a fixed
local image in the parity spec (mirroring the existing `fonts.gstatic.com` abort).
State which in the plan.

**B1 visual proof (gate):** real-app screenshots against a repo with both human
and bot authors (BFF repo `mindbody/Mindbody.BizApp.Bff`, which has real merged
PRs and bot activity) showing avatars resolve at all 4 sites, hosted on a
`review-assets/pr-N` branch and embedded in the PR per the visual-verification
convention.

## 8. Risk & process

- **Tier:** T2/T3 (full-stack: 5 records incl. `RawPrInboxItem` + 4 mapper
  methods (`ParsePr`, `ParseRootComments`, `ParseReviewThreads`,
  `MaterializePrInboxItem`) + 2 API surfaces + 1 new component + 4 render sites +
  tests).
- **Risk:** **B1 — UI-visual, gated.** Changes perceptible rendering. No B2
  surface (no auth/PAT, submit pipeline, migrations, cross-tab stamp, sidecar,
  host-header, or architectural invariant touched). The avatar URLs are
  read-only display data from the GitHub API.
- **Gate behavior:** drive to green-and-ready, then **pause** for the human
  visual assert. Do **not** merge; auto-merge / the human owns the merge.
- **Wire-shape caution:** adding fields to author-bearing DTOs is a wire-shape
  change. Per the standing lesson, the frontend `types.ts` mirror and a cold
  render of each consuming view are verified in the same PR — the fields are
  additive and optional, so existing consumers compile unchanged, but the
  Avatar render sites are exercised before the PR opens.
- **Third-party image privacy (deliberate posture):** avatars load directly from
  `avatars.githubusercontent.com`, so each render sends the viewer's IP (and,
  without mitigation, a `Referer`) to GitHub. This is acceptable for a local
  desktop tool whose PAT calls already identify the user to GitHub, and it is
  bounded by `referrerPolicy="no-referrer"` on the `<img>` (§5), which strips the
  `Referer` at zero cost. Backend avatar proxying is **not** done (disproportate
  for a PoC). No XSS vector: an `<img>` never executes script from its `src`,
  React HTML-escapes the attribute, and the URL is never interpolated into
  CSS/markup. The URL also originates **only** from GitHub's API responses (§3) —
  never user/persisted input — so it cannot be attacker-controlled without
  compromising the GitHub channel itself. (Note: a `data:` URL is *not* literally
  "inert" — `<img>` does render `data:` images — but it still cannot execute JS,
  and none reach here from the API.) As cheap defense-in-depth the component MAY
  guard `src?.startsWith('https://')` before rendering the `<img>` (falling back
  to initials otherwise), since the only legitimate values are https GitHub CDN
  URLs; full scheme validation beyond that is omitted.
- **Logging:** `avatarUrl` is a public CDN URL with no secret material, so it is
  intentionally **not** added to `SensitiveFieldScrubber.BlockedFieldNames`
  (where `login`, `token`, `pat`, etc. live). Recorded here so a reviewer
  auditing new DTO string fields against the scrub list sees the decision.

## 9. Open questions

None blocking. Deferred items (ActivityRail real-data wiring, bot rounded-square
shape) are documented in §2 and are intentionally out of scope for #127.
