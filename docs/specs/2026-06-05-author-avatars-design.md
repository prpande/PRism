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
| PR header | `frontend/src/components/PrDetail/PrHeader.tsx:345` | GraphQL PR author | `lg` (32px) |
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
  **`InboxRefreshOrchestrator.ToInboxItem` (~line 287)**. Edit that mapper, not
  the enricher.

### 4.4 Frontend types (`frontend/src/api/types.ts`)

Add `avatarUrl?: string` to the 4 mirrored interfaces: `PrInboxItem` (line 94),
`PrDetailPr` (line 146), `IssueCommentDto` (line 181), `ReviewCommentDto`
(line 188).

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

**Render rules:**

1. `src` truthy and not previously errored → render `<img>` at the requested
   size. The `<img>` carries:
   - `width:100%; height:100%; object-fit:cover; border-radius:50%; display:block`
     so the image fills and clips to the circle. (The `.avatar` token has
     `border-radius:50%` but no `overflow:hidden`, so the **`<img>` itself** must
     round/cover — otherwise a non-square or pre-CSS image flashes as a square.
     Equivalently, add `overflow:hidden` to the `.avatar` rule; pick one and
     state it. This spec chooses styling the `<img>`.)
   - `referrerPolicy="no-referrer"` — strips the `Referer` header on the cross-
     origin load to `avatars.githubusercontent.com` (see §8). Costs nothing.
   - `loading="lazy"` for the `sm` (inbox-list) size; `loading="eager"` (default)
     for `md`/`lg` single-PR views (see §6).
   - `alt=""` (decorative — see a11y below).
2. `src` absent **or** the `<img>` fired `onError` → initials fallback: the first
   character of `login` (letter **or** digit — GitHub logins may start with a
   digit, e.g. `42user` → `4`), uppercased. A leading `[bot]`-style suffix is
   stripped before taking the initial, so `dependabot[bot]` → `D`. An empty
   `login` yields no initial (empty colored circle) rather than throwing.
3. The `onError` → initials transition is a one-way boolean in local component
   state. Once `errored` is set, the render switches to the initials branch and
   the `<img>` is **removed from the tree entirely** (not kept with a fallback
   `src`). This guarantees no re-attach / re-fire loop: a 200 that returns
   non-image bytes fires `onError` (decode failure) and degrades to initials; a
   slow/hanging request shows the colored circle until it resolves or errors. No
   defensive timeout is needed.

**Shape:** circle for every avatar in v1 (see §2 deferral). The container's
`background: var(--text-3)` is always present behind the `<img>`, so the brief
fetch window shows a colored circle, not a transparent gap (no layout shift —
the fixed-size container reserves its space before the image loads).

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

At each of the 4 sites, insert `<Avatar src={x.avatarUrl} login={x.author} size=…>`
immediately before the existing name span. The name span is unchanged (avatars
are additive; the text remains the accessible label). Per-site size is from the
§2 table. Each site's layout already uses a flex row, so the avatar slots in as
a leading flex child; `.avatar`'s `flex: none` prevents it from shrinking.

**InboxRow needs care.** The author span lives inside `.meta` — a
`flex-wrap: wrap` row of small (`xs`/10px) chips separated by dot-separators
(repo · author · iter · age). Dropping a bare 20px circle into that row risks
(a) the dot-separators orphaning the avatar across a wrap, and (b) vertical
misalignment between the circle and the 10px text. Wrap the avatar **and** its
author span together in a single inline-flex child with `align-items: center`
and a small gap, so the pair stays atomic and the separators sit outside it.
The other three sites (PR header, root comment, review comment) are single rows
where a leading flex child with `align-items: center` is sufficient.

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
- **Required prerequisite:** add `avatarUrl` to `FixtureStripAllowlist.AllowedFieldNames`.
  The frozen-PR fixture harness strips *every* field not in that allowlist to
  null, and `avatarUrl` is currently excluded (the allowlist comment even names
  it as stripped). Without this, the new mapper assertions would silently see
  `AvatarUrl == null` and pass vacuously, proving nothing. This must be a task in
  the plan, not discovered at debug time.

**Frontend (vitest):** `Avatar.test.tsx` —

- renders `<img>` with the given `src` when `src` is set;
- renders the uppercased initial when `src` is absent;
- swaps to the initials fallback when the `<img>` fires `onError`;
- strips a `[bot]` suffix before deriving the initial (`dependabot[bot]` → `D`);
- empty `login` renders an empty circle without throwing.

Plus one render-site assertion (e.g. `InboxRow`) that an avatar element renders
next to the author name.

**Parity baseline:** re-capture the affected parity zones (inbox row, PR header,
root-comment card, review-comment widget) since the avatars change the rendered
output. Pre-existing unrelated baseline drift is not in scope.

**B1 visual proof (gate):** real-app screenshots against a repo with both human
and bot authors (BFF repo `mindbody/Mindbody.BizApp.Bff`, which has real merged
PRs and bot activity) showing avatars resolve at all 4 sites, hosted on a
`review-assets/pr-N` branch and embedded in the PR per the visual-verification
convention.

## 8. Risk & process

- **Tier:** T2/T3 (full-stack: 4 DTOs + 2 mappers + 2 API surfaces + 1 new
  component + 4 render sites + tests).
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
  for a PoC). No XSS vector: React HTML-escapes the `src` attribute and the URL
  is never interpolated into CSS/markup; a non-`https` or `data:` `src` is inert
  in an `<img>` (images don't execute), so explicit scheme validation is omitted.
- **Logging:** `avatarUrl` is a public CDN URL with no secret material, so it is
  intentionally **not** added to `SensitiveFieldScrubber.BlockedFieldNames`
  (where `login`, `token`, `pat`, etc. live). Recorded here so a reviewer
  auditing new DTO string fields against the scrub list sees the decision.

## 9. Open questions

None blocking. Deferred items (ActivityRail real-data wiring, bot rounded-square
shape) are documented in §2 and are intentionally out of scope for #127.
