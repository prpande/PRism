# Author & Bot Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each GitHub author's (and bot's) avatar next to their name at the four real-data render sites, sourced from the GitHub API and rendered through one reusable `<Avatar>` component with an initials fallback.

**Architecture:** Plumb a nullable `avatarUrl` from the two API paths (PR-detail GraphQL `Actor.avatarUrl`; inbox REST `user.avatar_url`) through the author-bearing DTOs and the frontend type mirror, then render via a layered `<Avatar>` (always-present initials base + an image overlay keyed to `src`). No new network calls, no client-side login parsing. ActivityRail is deferred (mock data, non-resolvable logins).

**Tech Stack:** .NET 10 (`PRism.Core.Contracts` records, `PRism.GitHub` adapter, `System.Text.Json`), xUnit + FluentAssertions; React + Vite + TypeScript, CSS Modules over oklch design tokens, vitest + @testing-library/react, Playwright parity baselines.

**Source spec:** `docs/specs/2026-06-05-author-avatars-design.md` (read §3 decision, §5 component model, §6 per-site integration, §7 testing).

**Worktree:** `D:/src/PRism-127-avatars` (branch `fix/127-avatars`). All `npm`/`npx` commands run from `frontend/`. All `dotnet` commands run from the repo root.

**Risk:** T2/T3, **B1 — UI-visual, gated.** Drive to green-and-ready; do **not** merge. The human merges after a visual assert.

---

## File Structure

**Backend (modify):**
- `PRism.Core.Contracts/Pr.cs` — append `string? AvatarUrl = null`
- `PRism.Core.Contracts/IssueCommentDto.cs` — append `string? AvatarUrl = null`
- `PRism.Core.Contracts/ReviewThreadDto.cs` — append `string? AvatarUrl = null` to `ReviewCommentDto`
- `PRism.Core.Contracts/PrInboxItem.cs` — append `string? AvatarUrl = null`
- `PRism.Core/Inbox/RawPrInboxItem.cs` — append `string? AvatarUrl = null`
- `PRism.GitHub/GitHubReviewService.cs` — GraphQL query (3 `author{login}` selections) + 3 mappers (`ParsePr`, `ParseRootComments`, `ParseReviewThreads`)
- `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs` — read `user.avatar_url`, pass to `RawPrInboxItem`
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — `MaterializePrInboxItem` appends `r.AvatarUrl`

**Backend (test):**
- `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs` — inline-JSON value assertions (author/comment/bot/null)
- `tests/PRism.GitHub.Tests/GitHubReviewServiceInboxSectionTests.cs` (or the existing inbox section-query test) — REST `avatar_url` assertion
- `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs` + `Fixtures/pr19-graphql-response.json` — **integration-gated** (see Task 9; not on the normal CI path)

**Frontend (create):**
- `frontend/src/components/Avatar/Avatar.tsx`
- `frontend/src/components/Avatar/Avatar.module.css`
- `frontend/src/components/Avatar/Avatar.test.tsx`

**Frontend (modify):**
- `frontend/src/api/types.ts` — 4 interfaces gain `avatarUrl: string | null`
- `frontend/src/components/Inbox/InboxRow.tsx` (+ `InboxRow.module.css`, `InboxRow.test.tsx`)
- `frontend/src/components/PrDetail/PrHeader.tsx` + `frontend/src/components/PrDetail/PrDetailView.tsx`
- `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx` (+ `.module.css`, new `.test.tsx`)
- `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (+ `.module.css`, new `.test.tsx`)
- `frontend/e2e/parity-baselines.spec.ts` — avatar-load determinism

---

## Task 1: Append `AvatarUrl` to the five records

**Files:**
- Modify: `PRism.Core.Contracts/Pr.cs:19`
- Modify: `PRism.Core.Contracts/IssueCommentDto.cs:7`
- Modify: `PRism.Core.Contracts/ReviewThreadDto.cs:16`
- Modify: `PRism.Core.Contracts/PrInboxItem.cs:19`
- Modify: `PRism.Core/Inbox/RawPrInboxItem.cs:18`

Why `= null` on every record: `Pr`, `PrInboxItem`, `RawPrInboxItem` already end in optional params (`ClosedAt = null`), so a non-defaulted append is CS1737. `IssueCommentDto`/`ReviewCommentDto` are constructed positionally in the mappers and elsewhere; a defaulted append keeps every site that doesn't pass it compiling. The field is appended **last** (after `ClosedAt`) for positional compatibility.

- [ ] **Step 1: Append the field to each record**

`Pr.cs` — change the last line:
```csharp
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
```

`IssueCommentDto.cs`:
```csharp
public sealed record IssueCommentDto(
    long Id,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    string? AvatarUrl = null);
```

`ReviewThreadDto.cs` — the `ReviewCommentDto` record only:
```csharp
public sealed record ReviewCommentDto(
    string CommentId,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    DateTimeOffset? EditedAt,
    string? AvatarUrl = null);
```

`PrInboxItem.cs`:
```csharp
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
```

`RawPrInboxItem.cs`:
```csharp
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
```

- [ ] **Step 2: Build to confirm no call site breaks**

Run: `dotnet build PRism.Core.Contracts/PRism.Core.Contracts.csproj --configuration Release`
Expected: 0 errors, 0 warnings. (Existing call sites use named args or omit the trailing optionals, so the defaulted append compiles cleanly.)

- [ ] **Step 3: Commit**

```bash
git add PRism.Core.Contracts/Pr.cs PRism.Core.Contracts/IssueCommentDto.cs PRism.Core.Contracts/ReviewThreadDto.cs PRism.Core.Contracts/PrInboxItem.cs PRism.Core/Inbox/RawPrInboxItem.cs
git commit -m "feat(#127): add nullable AvatarUrl to author-bearing records"
```

---

## Task 2: GraphQL query + PR-detail mappers carry `avatarUrl`

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs:40,41,43` (query) and `:1009-1013,1034-1050` (`ParsePr`), `:1061-1069` (`ParseRootComments`), `:1093-1104` (`ParseReviewThreads`)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs`

`avatarUrl` is a field on GitHub's `Actor` interface, so it resolves for both `User` and `Bot` authors with no extra token scope (see the scope comment at `GitHubReviewService.cs:21`). The timeline query (`:44-49`) has no author render site and is **not** changed.

- [ ] **Step 1: Write the failing tests (inline-JSON value assertions)**

The PR-detail unit tests use inline JSON (`PrDetailGraphQLBody`), not the frozen fixture, so they are the primary value-coverage surface. Add `avatarUrl` to the author nodes in the existing `PrDetailGraphQLBody` const and add a new test. In `GitHubReviewServicePrDetailTests.cs`, edit the three author nodes inside `PrDetailGraphQLBody`:

```json
            "author": { "login": "alice", "avatarUrl": "https://avatars.githubusercontent.com/u/1?v=4" },
```
(the PR author, `:34`), the root-comment node (`:42`):
```json
                { "databaseId": 1001, "author": { "login": "bob", "avatarUrl": "https://avatars.githubusercontent.com/u/2?v=4" }, "createdAt": "2026-01-02T00:00:00Z", "body": "looks good" }
```
and the review-thread comment node (`:55`):
```json
                      { "id": "PRC_c1", "author": { "login": "bob", "avatarUrl": "https://avatars.githubusercontent.com/u/2?v=4" }, "createdAt": "2026-01-02T00:01:00Z", "body": "nit", "lastEditedAt": null }
```

Then add this test method to the class:

```csharp
    [Fact]
    public async Task GetPrDetailAsync_carries_avatar_urls_for_author_and_comments()
    {
        var handler = new StubHandler(PrDetailGraphQLBody);
        var svc = NewService(handler);

        var detail = await svc.GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        detail.Pr.AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/1?v=4");
        detail.RootComments.Single().AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/2?v=4");
        detail.ReviewThreads.Single().Comments.Single().AvatarUrl
            .Should().Be("https://avatars.githubusercontent.com/u/2?v=4");
    }

    [Fact]
    public async Task GetPrDetailAsync_carries_bot_avatar_and_tolerates_missing_avatar()
    {
        // Bot author keeps its avatarUrl (the case client-side github.com/{login}.png would 404);
        // a missing avatarUrl maps to null, not an exception.
        const string body = """
        {
          "data": { "repository": { "pullRequest": {
            "title": "t", "body": "", "url": "u", "state": "OPEN", "isDraft": false,
            "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "headRefName": "h", "baseRefName": "main", "headRefOid": "h", "baseRefOid": "b",
            "author": { "login": "dependabot[bot]", "avatarUrl": "https://avatars.githubusercontent.com/in/29110?v=4" },
            "createdAt": "2026-01-01T00:00:00Z", "closedAt": null, "mergedAt": null, "changedFiles": 0,
            "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [
              { "databaseId": 1, "author": { "login": "ghost" }, "createdAt": "2026-01-02T00:00:00Z", "body": "x" }
            ] },
            "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
          } } }
        }
        """;
        var svc = NewService(new StubHandler(body));

        var detail = await svc.GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        detail.Pr.AvatarUrl.Should().Be("https://avatars.githubusercontent.com/in/29110?v=4");
        detail.RootComments.Single().AvatarUrl.Should().BeNull();
    }
```

> Note: if the existing tests use a different stub-handler helper than `StubHandler`/`detail.RootComments`/`detail.ReviewThreads`, match the names already in this file (read the top of the file and an existing `GetPrDetailAsync_*` test). The two assertions that matter are `.AvatarUrl` on `Pr`, on a root `IssueCommentDto`, and on a `ReviewCommentDto`.

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubReviewServicePrDetailTests" --configuration Release`
Expected: the two new tests FAIL — `AvatarUrl` is currently always `null` (the query doesn't request it and the mappers don't read it). Pre-existing tests still pass.

- [ ] **Step 3: Add `avatarUrl` to the three GraphQL author selections**

In `PrDetailGraphQLQuery` (`GitHubReviewService.cs:40,41,43`), change each `author{login}` to `author{login avatarUrl}`:
```csharp
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id author{login avatarUrl} createdAt body lastEditedAt}}}}" +
```

- [ ] **Step 4: Read `avatarUrl` in the three mappers**

`ParsePr` — add an `AvatarUrl()` local helper beside `Author()` (`:1009-1013`) and pass it (`:1034-1050`):
```csharp
        string? AvatarUrl()
        {
            if (!pull.TryGetProperty("author", out var a) || a.ValueKind != JsonValueKind.Object) return null;
            return a.TryGetProperty("avatarUrl", out var av) && av.ValueKind == JsonValueKind.String ? av.GetString() : null;
        }
```
and append to the `new Pr(...)` after `ClosedAt: closedAt`:
```csharp
            ClosedAt: closedAt,
            AvatarUrl: AvatarUrl());
```

`ParseRootComments` (`:1061-1069`) — `a` is already in scope from the login read; add the avatar read and pass it:
```csharp
            var avatar = a.ValueKind == JsonValueKind.Object && a.TryGetProperty("avatarUrl", out var av) && av.ValueKind == JsonValueKind.String
                ? av.GetString() : null;
            var ts = node.TryGetProperty("createdAt", out var ca) ? ca.GetDateTimeOffset() : default;
            var body = node.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
            result.Add(new IssueCommentDto(id, author, ts, body, avatar));
```

`ParseReviewThreads` (`:1096-1104`) — `ca` is in scope from the login read; add the avatar read and pass it:
```csharp
                    var cavatar = ca.ValueKind == JsonValueKind.Object && ca.TryGetProperty("avatarUrl", out var cav) && cav.ValueKind == JsonValueKind.String
                        ? cav.GetString() : null;
                    var cts = cn.TryGetProperty("createdAt", out var cca) ? cca.GetDateTimeOffset() : default;
                    var cbody = cn.TryGetProperty("body", out var cb) ? cb.GetString() ?? "" : "";
                    DateTimeOffset? edited = null;
                    if (cn.TryGetProperty("lastEditedAt", out var le) && le.ValueKind != JsonValueKind.Null)
                        edited = le.GetDateTimeOffset();
                    comments.Add(new ReviewCommentDto(cid, cauthor, cts, cbody, edited, cavatar));
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubReviewServicePrDetailTests" --configuration Release`
Expected: all PASS, including the two new tests.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs
git commit -m "feat(#127): request + map avatarUrl on PR author and comments (GraphQL)"
```

---

## Task 3: Inbox REST path carries `avatar_url`

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs:143-156`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:287-293`
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceInboxSectionTests.cs` (locate the existing inbox section-query test by grepping for `SearchAsync`/`search/issues` in `tests/PRism.GitHub.Tests`; if none exists, create this file)

GitHub's `search/issues` item `user` object is a simple-user that already includes `avatar_url` on the same node the code reads `login` from.

- [ ] **Step 1: Write the failing test**

Add (or create) a test that drives a `search/issues` response with a `user.avatar_url` through the section query and asserts the resulting `RawPrInboxItem.AvatarUrl`. Minimal shape (match the file's existing handler/helper if one exists):

```csharp
    [Fact]
    public async Task SearchAsync_carries_user_avatar_url_to_raw_item()
    {
        const string body = """
        {
          "items": [
            {
              "title": "Add pagination",
              "updated_at": "2026-01-01T00:00:00Z",
              "comments": 2,
              "user": { "login": "alice", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4" },
              "pull_request": { "html_url": "https://github.com/acme/api/pull/7" }
            }
          ]
        }
        """;
        var runner = NewRunner(new StubHandler(body));   // match the file's existing factory helper

        var items = await runner.QueryAllAsync(/* sections */, token: "ghp_test", CancellationToken.None);

        items.Single().AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/1?v=4");
    }
```

> If no inbox-runner unit test exists, prefer adding the assertion to the closest existing inbox test instead of standing up a new harness. The single load-bearing assertion is `RawPrInboxItem.AvatarUrl` (and, end-to-end, `PrInboxItem.AvatarUrl`) equals the `avatar_url` string.

- [ ] **Step 2: Run to confirm it fails**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~InboxSection" --configuration Release`
Expected: FAIL — `AvatarUrl` is null (not yet read).

- [ ] **Step 3: Read `avatar_url` and pass it to `RawPrInboxItem`**

In `GitHubSectionQueryRunner.SearchAsync`, after the `login` read (`:143`):
```csharp
            var login = item.GetProperty("user").GetProperty("login").GetString() ?? "";
            var avatarUrl = item.TryGetProperty("user", out var u)
                && u.TryGetProperty("avatar_url", out var av) && av.ValueKind == JsonValueKind.String
                ? av.GetString() : null;
```
and change the `new RawPrInboxItem(...)` (`:148-155`) to pass it (named, since `AvatarUrl` is the trailing optional after `MergedAt`/`ClosedAt`):
```csharp
            result.Add(new RawPrInboxItem(
                new PrReference(path[0], path[1], n),
                title, login, repo,
                updated, updated,
                comments,
                0, 0,
                "",
                1,
                AvatarUrl: avatarUrl));
```

- [ ] **Step 4: Thread it through `MaterializePrInboxItem`**

In `InboxRefreshOrchestrator.MaterializePrInboxItem` (`:287-293`), append `r.AvatarUrl` to the `new PrInboxItem(...)` after `r.ClosedAt`:
```csharp
        return new PrInboxItem(
            r.Reference, r.Title, r.Author, r.Repo,
            r.UpdatedAt, r.PushedAt,
            r.IterationNumberApprox, r.CommentCount,
            r.Additions, r.Deletions, r.HeadSha, ci,
            lastViewedHeadSha, lastSeenCommentId,
            r.MergedAt, r.ClosedAt,
            r.AvatarUrl);
```

- [ ] **Step 5: Run to confirm it passes**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~InboxSection" --configuration Release`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.GitHub.Tests/GitHubReviewServiceInboxSectionTests.cs
git commit -m "feat(#127): carry user.avatar_url from inbox search through to PrInboxItem"
```

---

## Task 4: Full backend suite green

**Files:** none (verification task).

- [ ] **Step 1: Run the full backend build + test**

Run: `dotnet build --configuration Release` then `dotnet test --configuration Release`
Expected: build 0 errors / 0 warnings; all unit tests pass. (The `Category=Integration` frozen-PR tests are handled in Task 9 and are not part of this run — they are gated by a live PAT.)

- [ ] **Step 2: Commit (only if any incidental fix was needed)**

```bash
git commit -am "test(#127): backend suite green with AvatarUrl plumbed" --allow-empty
```

---

## Task 5: Mirror `avatarUrl` in the frontend types

**Files:**
- Modify: `frontend/src/api/types.ts:91-98,143-149,179-184,186-192`

- [ ] **Step 1: Add the field to the four interfaces**

`PrInboxItem` (after `author`, `:94`): add `avatarUrl: string | null;`
`PrDetailPr` (after `author`, `:146`): add `avatarUrl: string | null;`
`IssueCommentDto` (after `author`, `:181`): add `avatarUrl: string | null;`
`ReviewCommentDto` (after `author`, `:188`): add `avatarUrl: string | null;`

Use `string | null` (the backend always emits the camelCase `avatarUrl`, null when absent), matching the existing nullable-field convention (`editedAt: string | null`).

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors. (Existing test fixtures that build these objects literally will now error if they're strict — fix any by adding `avatarUrl: null` to those literals. The `InboxRow.test.tsx` `PR` literal at `:9-26` is updated in Task 7; PR-detail fixtures, if strict, get `avatarUrl: null` here.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(#127): mirror avatarUrl on the 4 frontend DTO types"
```

---

## Task 6: The `<Avatar>` component (layered model)

**Files:**
- Create: `frontend/src/components/Avatar/Avatar.tsx`
- Create: `frontend/src/components/Avatar/Avatar.module.css`
- Create: `frontend/src/components/Avatar/Avatar.test.tsx`

The component reuses the global `.avatar` / `.avatar-sm` / `.avatar-lg` token classes (`frontend/src/styles/tokens.css:587-603`) for the circle, color, and size, and adds a module for the initials-base + image-overlay layering. Initials are the always-present base; the `<img>` overlays and is keyed to `src` so a new `src` re-attempts after a prior error (required because `<Avatar>` instances are reused across inbox refresh ticks).

- [ ] **Step 1: Write the failing tests**

`Avatar.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from './Avatar';

const HTTPS = 'https://avatars.githubusercontent.com/u/1?v=4';

describe('Avatar', () => {
  it('always renders the initial as the base layer, uppercased', () => {
    render(<Avatar login="alice" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders an <img> over the initials when src is an https URL', () => {
    render(<Avatar src={HTTPS} login="alice" />);
    const img = screen.getByRole('presentation', { hidden: true });
    expect(img).toHaveAttribute('src', HTTPS);
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('drops the <img> and shows initials when the image errors', () => {
    render(<Avatar src={HTTPS} login="alice" />);
    fireEvent.error(screen.getByRole('presentation', { hidden: true }));
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('recovers on a new src after a prior error (instance reused)', () => {
    const { rerender } = render(<Avatar src={HTTPS} login="alice" />);
    fireEvent.error(screen.getByRole('presentation', { hidden: true }));
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    rerender(<Avatar src="https://avatars.githubusercontent.com/u/2?v=4" login="alice" />);
    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute(
      'src',
      'https://avatars.githubusercontent.com/u/2?v=4',
    );
  });

  it('strips a [bot] suffix before deriving the initial', () => {
    render(<Avatar login="dependabot[bot]" />);
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('uses a digit initial for digit-leading logins and tolerates empty login', () => {
    const { rerender } = render(<Avatar login="42user" />);
    expect(screen.getByText('4')).toBeInTheDocument();
    rerender(<Avatar login="" />);
    // empty login: no throw, no initial character
    expect(screen.getByTestId('avatar')).toBeInTheDocument();
  });

  it('does not render an <img> for a non-https src (falls back to initials)', () => {
    render(<Avatar src={'data:image/svg+xml,<svg/>' as string} login="alice" />);
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
```

> `alt=""` makes the `<img>` an ARIA presentation/decorative element, so `getByRole('presentation', { hidden: true })` selects it. If that selector proves brittle in this jsdom version, fall back to `container.querySelector('img')`.

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && npx vitest run src/components/Avatar/Avatar.test.tsx`
Expected: FAIL — module not found / `Avatar` undefined.

- [ ] **Step 3: Implement the component**

`Avatar.tsx`:
```tsx
import { useState } from 'react';
import styles from './Avatar.module.css';

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'avatar-sm',
  md: '',
  lg: 'avatar-lg',
};

export interface AvatarProps {
  src?: string | null;
  login: string;
  size?: 'sm' | 'md' | 'lg';
}

function initial(login: string): string {
  // Strip a trailing [bot] suffix so bot logins initial on their name, not the bracket.
  const base = login.replace(/\[bot\]$/i, '');
  return base.charAt(0).toUpperCase();
}

export function Avatar({ src, login, size = 'md' }: AvatarProps) {
  // Error state is scoped to the CURRENT src, not the component lifetime: instances
  // are reused across inbox refresh ticks, so a lifetime-wide flag would pin a row to
  // initials forever after one transient blip. A new src re-attempts the load.
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const sizeClass = SIZE_CLASS[size];
  const showImg = !!src && src.startsWith('https://') && erroredSrc !== src;

  return (
    <span
      className={`avatar ${sizeClass} ${styles.avatar}`.trim()}
      aria-hidden="true"
      title={login || undefined}
      data-testid="avatar"
    >
      <span className={styles.initial}>{initial(login)}</span>
      {showImg && (
        <img
          key={src}
          className={styles.img}
          src={src}
          alt=""
          loading={size === 'sm' ? 'lazy' : 'eager'}
          referrerPolicy="no-referrer"
          onError={() => setErroredSrc(src)}
        />
      )}
    </span>
  );
}
```

`Avatar.module.css`:
```css
/* Layered avatar: the global .avatar token supplies the circle/size/color/initial-font.
   The initials sit as the always-present base; the <img> overlays and clips to the circle. */
.avatar {
  position: relative;
  overflow: hidden;
}

.initial {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  display: block;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd frontend && npx vitest run src/components/Avatar/Avatar.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/Avatar/Avatar.tsx src/components/Avatar/Avatar.module.css src/components/Avatar/Avatar.test.tsx
cd .. && git add frontend/src/components/Avatar
git commit -m "feat(#127): reusable Avatar component (initials base + src-keyed image overlay)"
```

---

## Task 7: InboxRow — atomic avatar+author group

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx:57-65`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css` (add an atomic-pair class)
- Modify: `frontend/src/components/Inbox/InboxRow.test.tsx:9-26` (fixture) + add an assertion

The author sits in `.meta`, a `flex-wrap: wrap` row of `xs` chips separated by `·`. Wrap the avatar **and** the author span in one `inline-flex; align-items:center` child so a wrap can't orphan the avatar from the name and the 20px circle aligns with the 10px text.

- [ ] **Step 1: Update the fixture + add the failing assertion**

In `InboxRow.test.tsx`, add `avatarUrl` to the `PR` fixture (`:24`, alongside the other fields):
```ts
  mergedAt: null,
  closedAt: null,
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
};
```
Add a test (the `render` boilerplate matches the existing file):
```tsx
  it('renders the author avatar next to the author name', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxRow pr={PR} enrichment={undefined} showCategoryChip={false} maxDiff={100} />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    const author = screen.getByText('alice');
    const group = author.closest('[data-testid="inbox-author"]');
    expect(group).not.toBeNull();
    expect(group!.querySelector('[data-testid="avatar"]')).not.toBeNull();
  });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — no `inbox-author` group / no avatar.

- [ ] **Step 3: Wrap avatar + author atomically**

In `InboxRow.tsx`, import the component and replace the bare author span (`:60`):
```tsx
          <span className={styles.author} data-testid="inbox-author">
            <Avatar src={pr.avatarUrl} login={pr.author} size="sm" />
            <span>{pr.author}</span>
          </span>
```
Add the import at the top: `import { Avatar } from '../Avatar/Avatar';`

In `InboxRow.module.css`, add:
```css
.author {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (both the existing click test and the new avatar test).

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/Inbox/InboxRow.tsx src/components/Inbox/InboxRow.module.css src/components/Inbox/InboxRow.test.tsx
cd .. && git add frontend/src/components/Inbox
git commit -m "feat(#127): avatar in inbox rows (atomic avatar+author group)"
```

---

## Task 8: PrHeader — thread avatarUrl + lg avatar

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:57-95` (props), `:344-345` (render)
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx:253-256` (call site)

`PrHeader` takes a flat `author: string` prop — there is no per-item object — so `avatarUrl` must be threaded as a new explicit prop.

- [ ] **Step 1: Add the prop**

In `PrHeaderProps` (`:60`, after `author: string;`):
```ts
  author: string;
  avatarUrl?: string | null;
```
Add `avatarUrl` to the destructured params (`:100`, after `author,`):
```ts
  author,
  avatarUrl,
```

- [ ] **Step 2: Pass it at the call site**

In `PrDetailView.tsx` (`:256`, after `author={data?.pr.author ?? ''}`):
```tsx
        author={data?.pr.author ?? ''}
        avatarUrl={data?.pr.avatarUrl}
```

- [ ] **Step 3: Render the lg avatar atomically**

In `PrHeader.tsx`, import `Avatar` (`import { Avatar } from '../Avatar/Avatar';`) and replace the author span (`:345`):
```tsx
            <span className="pr-subtitle-author" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Avatar src={avatarUrl} login={author} size="lg" />
              {author}
            </span>
```
(The inline style keeps the avatar+name atomic inside the `row gap-3` wrapping subtitle so they don't orphan across a wrap. If the project prefers a module class, add `.subtitleAuthor` to `PrHeader.module.css` instead — but the existing span uses the global `pr-subtitle-author` class, so an inline style here avoids touching the global stylesheet.)

- [ ] **Step 4: Typecheck + the existing PR-detail tests**

Run: `cd frontend && npx tsc -b && npx vitest run src/components/PrDetail/PrDetailView.test.tsx`
Expected: 0 type errors; existing PrDetailView tests still pass (the avatar is additive; the `author` text remains).

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/PrHeader.tsx src/components/PrDetail/PrDetailView.tsx
cd .. && git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrDetailView.tsx
git commit -m "feat(#127): lg avatar in the PR header (threaded avatarUrl prop)"
```

---

## Task 9: PrRootConversation — md avatar in the band + rail re-tune

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx:45-50`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css:45-49`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx`

The `.band` is already `align-items: center`, so a 24px avatar drops in cleanly — but it raises the band's optical center, so `--rail-node-y` (calibrated to "band padding-top + ~half the text-xs line-box") must be re-tuned to the avatar's half-height, or the continuous-rail node points above the band.

- [ ] **Step 1: Write the failing test**

`PrRootConversation.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrRootConversation } from './PrRootConversation';
import type { IssueCommentDto } from '../../../api/types';

const comments: IssueCommentDto[] = [
  {
    id: 1,
    author: 'alice',
    createdAt: '2026-01-02T00:00:00Z',
    body: 'looks good',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  },
];

describe('PrRootConversation', () => {
  it('renders an avatar in the comment band next to the author', () => {
    render(<PrRootConversation comments={comments} replyContext={undefined} />);
    const card = screen.getByTestId('pr-root-comment');
    expect(card.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(card.textContent).toContain('alice');
  });
});
```
> If `PrRootConversation` requires a non-optional `replyContext` shape, pass the minimal object the type demands (read the props type at the top of the component); the load-bearing assertion is the avatar inside `pr-root-comment`.

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx`
Expected: FAIL — no avatar.

- [ ] **Step 3: Insert the avatar + re-tune the rail node**

In `PrRootConversation.tsx`, import `Avatar` (`import { Avatar } from '../../Avatar/Avatar';`) and insert before the author span (`:46`):
```tsx
                <header className={styles.band}>
                  <Avatar src={comment.avatarUrl} login={comment.author} size="md" />
                  <span className={styles.author}>{comment.author}</span>
```
In `PrRootConversation.module.css`, re-tune `--rail-node-y` (`:48`) from half the text-xs line-box to half the 24px avatar (the band now centers on the avatar):
```css
  /* band padding-top (var(--s-2)) + half the 24px md avatar that now sets the band
     height; re-tuned for #127 (was var(--s-2) + 8px for the text-only band). Verified
     at the B1 visual gate. */
  --rail-node-y: calc(var(--s-2) + 12px);
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/OverviewTab/PrRootConversation.tsx src/components/PrDetail/OverviewTab/PrRootConversation.module.css src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx
cd .. && git add frontend/src/components/PrDetail/OverviewTab
git commit -m "feat(#127): md avatar in root-comment band + rail-node re-tune"
```

---

## Task 10: ExistingCommentWidget — sm avatar + baseline fix

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx:84-85`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css:31-36`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`

`.commentMeta` is `align-items: baseline`. An `<img>` (replaced element) baselines at its margin-box bottom, so a 20px avatar under `baseline` sits low. Switch to `center` (the same fix PrRootConversation's band already documents).

- [ ] **Step 1: Write the failing test**

`ExistingCommentWidget.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import type { ReviewThreadDto } from '../../../../api/types';

const thread: ReviewThreadDto = {
  threadId: 'PRRT_1',
  filePath: 'src/Widget.cs',
  lineNumber: 42,
  anchorSha: 'sha',
  isResolved: false,
  comments: [
    {
      commentId: 'PRC_1',
      author: 'bob',
      createdAt: '2026-01-02T00:01:00Z',
      body: 'nit',
      editedAt: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
    },
  ],
};

describe('ExistingCommentWidget', () => {
  it('renders an avatar next to the review-comment author', () => {
    render(<ExistingCommentWidget thread={thread} />);
    const author = screen.getByText('bob');
    const meta = author.closest('.comment-meta');
    expect(meta?.querySelector('[data-testid="avatar"]')).not.toBeNull();
  });
});
```
> Match `ExistingCommentWidget`'s real required props (read its props type — it may need more than `thread`, e.g. reply callbacks). Pass the minimal shape; the assertion is the avatar inside `.comment-meta`.

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: FAIL — no avatar.

- [ ] **Step 3: Insert the avatar + fix alignment**

In `ExistingCommentWidget.tsx`, import `Avatar` (`import { Avatar } from '../../../Avatar/Avatar';` — verify the relative depth) and insert before the author span (`:85`):
```tsx
          <div className={`comment-meta ${styles.commentMeta}`}>
            <Avatar src={comment.avatarUrl} login={comment.author} size="sm" />
            <span className={`comment-author ${styles.commentAuthor}`}>{comment.author}</span>
```
In `ExistingCommentWidget.module.css`, change `.commentMeta` (`:34`):
```css
.commentMeta {
  display: flex;
  gap: var(--s-2);
  align-items: center;
  font-size: var(--text-xs);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx
cd .. && git add frontend/src/components/PrDetail/FilesTab/DiffPane
git commit -m "feat(#127): sm avatar in review-comment meta + baseline→center"
```

---

## Task 11: Frontend suite + lint + build green

**Files:** none (verification).

- [ ] **Step 1: Full frontend gate**

Run: `cd frontend && npx vitest run && npm run lint && npm run build`
Expected: all vitest pass; lint clean (prettier `--check` included); `tsc -b && vite build` 0 errors. Fix any fixture-literal type errors by adding `avatarUrl: null` to PR-detail/inbox object literals that the compiler flags.

- [ ] **Step 2: Commit (only if fixes were needed)**

```bash
git commit -am "test(#127): frontend suite + lint + build green" --allow-empty
```

---

## Task 12: Parity-baseline determinism + re-capture

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts` (the PR-Detail and Inbox describe blocks)
- Re-capture: affected `__screenshots__` baselines

Avatars change the rendered output of the inbox row, PR header, root-comment card, and review-comment widget zones, so their baselines must be re-captured. Crucially, the capture must **not** depend on a live avatar fetch: route-intercept `avatars.githubusercontent.com` so the screenshot is deterministic (mirrors the existing `fonts.gstatic.com` abort at `:224-225`).

- [ ] **Step 1: Intercept avatar requests in the affected specs**

In each affected `test`/`beforeEach` that renders avatars (the Inbox block at `:85` and the PR-Detail block at `:175`), add alongside the existing font aborts:
```ts
    await page.route('**/avatars.githubusercontent.com/**', (route) => route.abort());
```
Aborting forces the deterministic initials-fallback circle, so the baseline never depends on network/CDN timing. (Fixtures in fake mode generally carry no real avatar URL, so most zones already render initials; the abort makes this guaranteed and robust if a fixture ever gains a URL.)

- [ ] **Step 2: Re-capture the affected baselines**

Run (Linux baselines are authoritative for CI; capture on the Playwright container per the repo's e2e convention, or via the CI `workflow_dispatch` baseline job):
`cd frontend && npx playwright test parity-baselines.spec.ts --update-snapshots`
Expected: the inbox, pr-detail-header, pr-detail-overview, and pr-detail-files-diff snapshots update; unaffected zones unchanged. Review the diff to confirm only the avatar'd zones moved.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__
git commit -m "test(#127): deterministic avatar parity baselines (abort CDN) + re-capture"
```

---

## Task 13 (integration-gated): frozen GraphQL shape fixture + allowlist

**Files:**
- Modify: `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs:33-52`
- Re-capture/update: `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json`

**Plan deviation note (visible per standing rule):** The spec (§7, SEC-003) framed adding `avatarUrl` to the strip-allowlist as required so "the new mapper assertions would not pass vacuously." In this codebase the mapper **value** assertions use inline JSON (Task 2), **not** the frozen fixture — so the allowlist is not load-bearing for value coverage. What *is* required: adding `avatarUrl` to the GraphQL query (Task 2) changes the frozen response **shape**, so the `Frozen_pr_graphql_shape_unchanged` (test 7g) fixture must gain the `avatarUrl` key or 7g flags `+ …/author/avatarUrl`. These integration tests are `Category=Integration`, gated by a live `PRISM_INTEGRATION_PAT`, and are **not** on the normal CI path — so this task does not block the green-and-ready gate, but it is included for correctness and must be run before the integration suite is next dispatched.

- [ ] **Step 1: Add `avatarUrl` to the allowlist**

In `FixtureStripAllowlist.cs`, add `"avatarUrl"` to `AllowedFieldNames` (it is a public CDN URL containing only a numeric user id — no name/email/secret), e.g. on the timestamp/structural line group:
```csharp
        // Avatar CDN URL — public, structural display data (#127). Kept so a re-captured
        // fixture carries the real URL rather than null.
        "avatarUrl",
```

- [ ] **Step 2: Update the frozen fixture shape**

Re-capture via capture mode (requires the live PAT):
`$env:PRISM_FROZEN_PR_CAPTURE_FIXTURE='1'; dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"; Remove-Item env:PRISM_FROZEN_PR_CAPTURE_FIXTURE`
This rewrites `Fixtures/pr19-graphql-response.json` with the new shape (`avatarUrl` present on each `author`). If a live capture is not available, hand-add `"avatarUrl": "https://avatars.githubusercontent.com/u/<id>?v=4"` to each `author` object in the committed fixture so the structural shape matches.

- [ ] **Step 3: Run the frozen-shape test (integration)**

Run: `dotnet test tests/PRism.GitHub.Tests.Integration --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`
Expected: PASS (the response shape now matches the fixture).

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json
git commit -m "test(#127): allowlist avatarUrl + refresh frozen PR-detail GraphQL shape fixture"
```

---

## Task 14: B1 visual proof + pre-push checklist

**Files:** none (verification + gate prep).

- [ ] **Step 1: Pre-push checklist** (per `.ai/docs/development-process.md`, all from repo root unless noted)

- `cd frontend && npx vitest run` — green
- `cd frontend && npm run lint` — clean
- `cd frontend && npm run build` — clean
- `dotnet build --configuration Release` — 0 errors / 0 warnings
- `dotnet test --configuration Release` — green (unit; integration is Task 13)

- [ ] **Step 2: Real-app visual capture (B1)**

Launch the app via `run.ps1 -Reset None --no-browser` (→ `localhost:5180`, Development + real PAT). Open a real PR with both human and bot authors (BFF repo `mindbody/Mindbody.BizApp.Bff`, e.g. a recent merged PR with `dependabot[bot]` activity, and the inbox). Capture screenshots showing avatars resolve at all four sites:
- inbox row (human + bot rows)
- PR header (lg avatar)
- root comment (md avatar in band; rail node aligned)
- review comment (sm avatar in `.comment-meta`)

Host the PNGs on a throwaway `review-assets/pr-N` branch and embed via raw URLs in a PR comment (per the visual-verification convention). Confirm a bot avatar (`dependabot[bot]`) resolves to its real image — the case client-side derivation would have 404'd — and that a missing/blocked avatar degrades to the initials circle.

- [ ] **Step 3: Stop at green-and-ready**

Do **not** merge. Hand off to the human for the visual assert and merge. (Use `pr-autopilot` to open the PR and drive review-comment resolution to green-and-ready.)

---

## Self-Review

**Spec coverage:**
- §2 4 render sites → Tasks 7 (InboxRow), 8 (PrHeader), 9 (PrRootConversation), 10 (ExistingCommentWidget). ActivityRail deferred (no task). ✓
- §3 plumb decision → Tasks 1-3 (records, GraphQL, REST). ✓
- §4.1 `= null` on all 5 records → Task 1. ✓
- §4.2 GraphQL + 3 mappers → Task 2. ✓
- §4.3 REST + `MaterializePrInboxItem` (correct method name) → Task 3. ✓
- §4.4 types.ts mirror → Task 5. ✓
- §5 layered Avatar model (initials base, src-keyed img, https guard, referrerPolicy, lazy/eager, digit/empty, object-fit) → Task 6. ✓
- §6 per-site layout (InboxRow atomic group, PrHeader prop-thread, band rail-node, commentMeta baseline→center, title tooltip) → Tasks 7-10 + Avatar `title` (Task 6). ✓
- §7 unit value tests (bot + null), per-site DOM assertions, src-recovery test, FixtureStripAllowlist, parity determinism → Tasks 2, 6, 7, 9, 10, 12, 13. ✓
- §8 referrerPolicy + https guard + no scrub entry (avatarUrl not added to `SensitiveFieldScrubber` — no task needed, it's a deliberate non-change) → Task 6. ✓
- B1 visual proof → Task 14. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. The two "match the existing helper" notes (Task 2 stub handler, Task 3 inbox runner) point at concrete in-file patterns the implementer reads, not invented APIs.

**Type consistency:** `AvatarUrl` (C# record, appended last) ↔ `avatarUrl` (camelCase JSON) ↔ `avatarUrl: string | null` (types.ts) ↔ `src?: string | null` (Avatar) used consistently across Tasks 1, 2, 3, 5, 6. `size` values `'sm'|'md'|'lg'` map to `''`/`avatar-sm`/`avatar-lg` consistently (Task 6) and are applied per the §2 table at each site (Tasks 7-10).
