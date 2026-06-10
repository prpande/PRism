# Inbox manual Refresh button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Refresh now" control to the inbox toolbar that forces an immediate GitHub re-poll, awaits it, and visibly confirms completion.

**Architecture:** A new `POST /api/inbox/refresh` calls the existing `IInboxRefreshOrchestrator.RefreshAsync` directly and awaits the committed snapshot (semantic C). The frontend `useInboxRefresh` hook POSTs (with a ~30 s abort timeout + min-interval-on-success guard), then `reload()`s and renders a transient confirmation; a `RefreshButton` lives in the FilterBar controls row after Sort.

**Tech Stack:** ASP.NET Core minimal API + xUnit/FluentAssertions (backend); React + TypeScript + Vite + Vitest/Testing-Library + Playwright (frontend).

**Spec:** `docs/specs/2026-06-10-inbox-manual-refresh-design.md`

---

## File Structure

**Backend**
- `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs` (modify) — add a `RefreshOverride` hook so tests can make `RefreshAsync` throw and/or advance `Current`.
- `PRism.Web/Endpoints/InboxEndpoints.cs` (modify) — add `POST /api/inbox/refresh`.
- `PRism.Web/Program.cs` (modify) — one-line documenting comment in the body-size-cap predicate (no-body exclusion).
- `tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs` (create) — endpoint tests.

**Frontend**
- `frontend/src/api/inbox.ts` (modify) — add `refresh(signal?)`.
- `frontend/src/hooks/useInboxRefresh.ts` (create) + `frontend/__tests__/useInboxRefresh.test.tsx` (create).
- `frontend/src/components/Inbox/RefreshButton.tsx` (create) + `RefreshButton.module.css` (create) + `RefreshButton.test.tsx` (create).
- `frontend/src/components/Inbox/InboxToolbar.tsx` (modify) — passthrough props.
- `frontend/src/components/Inbox/filters/FilterBar.tsx` (modify) — render the Sort+Refresh group.
- `frontend/src/components/Inbox/filters/filters.module.css` (modify) — `.sortRefreshGroup`.
- `frontend/src/pages/InboxPage.tsx` (modify) — instantiate the hook, drive the loading bar, mount the announcer + Toast wiring.
- `frontend/e2e/inbox.spec.ts` (modify) — refresh click → loading-bar → settle.

---

## Task 1: Test helper — `FakeInboxRefreshOrchestrator.RefreshOverride`

**Files:**
- Modify: `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs`

This is test-infrastructure only (no production behavior), so it has no standalone test; it is exercised by Task 2's endpoint tests. Make the change, then confirm the test project still compiles.

- [ ] **Step 1: Add the override hook (TWO surgical edits — do NOT rewrite the whole class)**

This file already declares `Current`, `WaitOverride`, `RefreshCalls`, `_coldStartKicked`, and `TryColdStartRefresh`. Make exactly two changes; leave everything else (especially `TryColdStartRefresh`) intact.

(a) Add the new property immediately after the existing `WaitOverride` line (line 9):

```csharp
    /// <summary>
    /// Lets a test drive RefreshAsync: throw (to simulate a failed/rate-limited pull)
    /// and/or mutate <see cref="Current"/> (to simulate a committed snapshot) before
    /// returning/throwing. Null → the default no-op success.
    /// </summary>
    public Func<CancellationToken, Task>? RefreshOverride { get; set; }
```

(b) Replace ONLY the existing one-line `RefreshAsync` body (line 17, `public Task RefreshAsync(CancellationToken ct) { RefreshCalls++; return Task.CompletedTask; }`) with:

```csharp
    public Task RefreshAsync(CancellationToken ct)
    {
        RefreshCalls++;
        return RefreshOverride?.Invoke(ct) ?? Task.CompletedTask;
    }
```

Do **not** re-declare `RefreshCalls`/`_coldStartKicked` and do **not** remove `TryColdStartRefresh` (doing so trips CS0102 duplicate-member / CS0535 interface-not-implemented).

- [ ] **Step 2: Verify the test project compiles**

Run: `dotnet build tests/PRism.Web.Tests/PRism.Web.Tests.csproj`
Expected: Build succeeded (0 errors). Existing tests that set only `Current`/`WaitOverride` are unaffected (new property defaults to null).

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs
git commit -m "test(#311): add RefreshOverride hook to FakeInboxRefreshOrchestrator"
```

---

## Task 2: Backend — `POST /api/inbox/refresh`

**Files:**
- Create: `tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs`
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs`:

```csharp
using System.Net;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class InboxRefreshEndpointTests
{
    private static InboxSnapshot MakeSnapshot(bool ciProbeComplete = true) =>
        new(
            new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
            new Dictionary<string, InboxItemEnrichment>(),
            DateTimeOffset.UtcNow,
            ciProbeComplete);

    // OriginCheckMiddleware rejects a POST without an Origin header; mirror ParseUrlEndpointTests.
    private static async Task<HttpResponseMessage> PostRefresh(HttpClient client)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/inbox/refresh", UriKind.Relative));
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Post_refresh_invokes_RefreshAsync_and_returns_200()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        fakeOrch.RefreshCalls.Should().Be(1);
    }

    [Fact]
    public async Task Post_refresh_returns_503_on_generic_failure()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(),
            // Throw WITHOUT advancing Current → snapshot not committed.
            RefreshOverride = _ => throw new InvalidOperationException("boom"),
        };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/inbox/refresh-failed");
    }

    [Fact]
    public async Task Post_refresh_rate_limited_but_snapshot_advanced_returns_200()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        // Simulate the CI-probe-429 path: orchestrator commits a NEW snapshot, THEN re-throws.
        fakeOrch.RefreshOverride = _ =>
        {
            fakeOrch.Current = MakeSnapshot(ciProbeComplete: false); // advance Current (new reference)
            throw new RateLimitExceededException("ci probe 429", TimeSpan.FromSeconds(30));
        };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Post_refresh_rate_limited_without_commit_returns_503()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        // Section-level 429 path: throw WITHOUT advancing Current.
        fakeOrch.RefreshOverride = _ =>
            throw new RateLimitExceededException("section 429", TimeSpan.FromSeconds(30));
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/inbox/refresh-rate-limited");
    }
}
```

> Note: `PRismWebApplicationFactory` uses object-initializer `FakeOrchestrator` assignment here; if the factory exposes it as a settable property (it does — see existing tests assign `factory.FakeOrchestrator = …`), the initializer form compiles identically. If the analyzer rejects the initializer for any reason, fall back to `var factory = new PRismWebApplicationFactory(); factory.FakeOrchestrator = fakeOrch;`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~InboxRefreshEndpointTests"`
Expected: FAIL — all 4 return 404 (route not mapped yet).

- [ ] **Step 3: Implement the endpoint**

In `PRism.Web/Endpoints/InboxEndpoints.cs`, add this route inside `MapInbox`, immediately after the `MapGet("/api/inbox", …)` block (before `MapPost("/api/inbox/parse-pr-url", …)`):

```csharp
        // #311 — manual "Refresh now". Calls the orchestrator directly and AWAITS the pull
        // (semantic C) so the client gets a real completion. RefreshAsync is _writerLock-
        // serialized, so this is safe against the concurrent poller tick.
        app.MapPost("/api/inbox/refresh", async (
            IInboxRefreshOrchestrator orch,
            CancellationToken ct) =>
        {
            var before = orch.Current;   // reference identity of the committed snapshot
            try
            {
                await orch.RefreshAsync(ct).ConfigureAwait(false);
                return Results.Ok();      // pull settled; new snapshot committed
            }
            catch (RateLimitExceededException)
            {
                // The orchestrator only commits-then-re-throws for a CI-probe 429 (it stashes
                // the rate-limit, finishes the snapshot, Volatile.Writes _current, THEN re-throws).
                // A primary section/enrichment 429 propagates BEFORE any commit. We can't cheaply
                // prove "*this* call committed", so the success test is "did the committed view
                // ADVANCE past where it was when the request arrived?" — true if this call (or a
                // concurrent poller tick) advanced it → the view is fresh → 200. If it did not
                // advance, the manual pull was rate-limited and nothing got fresher → 503.
                return ReferenceEquals(orch.Current, before)
                    ? Results.Problem(title: "Inbox refresh rate-limited", statusCode: 503, type: "/inbox/refresh-rate-limited")
                    : Results.Ok();
            }
            catch (OperationCanceledException)
            {
                // Client navigated away mid-refresh. Rethrow per house convention — ASP.NET Core
                // maps an aborted-request OCE to a no-op without error-level log noise.
                throw;
            }
            catch (Exception) // snapshot NOT committed (threw before Volatile.Write)
            {
                return Results.Problem(title: "Inbox refresh failed", statusCode: 503, type: "/inbox/refresh-failed");
            }
        });
```

`RateLimitExceededException` is already imported (`using PRism.Core.Inbox;` at the top of the file).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~InboxRefreshEndpointTests"`
Expected: PASS (4/4).

- [ ] **Step 5: Document the body-size-cap exclusion**

In `PRism.Web/Program.cs`, inside the `app.UseWhen(static ctx => { … })` predicate (around line 258, after the `/api/feedback` block), add a documenting comment — no behavior change, the endpoint has no body:

```csharp
        // #311 — POST /api/inbox/refresh has NO request body, so it is intentionally absent
        // from this allow-list (nothing to amplify / cap). Listed here so the omission is a
        // recorded decision, not an oversight.
```

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/InboxEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs
git commit -m "feat(#311): POST /api/inbox/refresh — trigger-and-await immediate inbox re-poll"
```

---

## Task 3: Frontend API — `inboxApi.refresh`

**Files:**
- Modify: `frontend/src/api/inbox.ts`

(Verified by Task 5's hook tests, which mock `inboxApi.refresh`; the change itself is a one-liner consuming the already-existing `client.ts` signal plumbing.)

- [ ] **Step 1: Add the method**

Replace `frontend/src/api/inbox.ts` body:

```ts
import { apiClient } from './client';
import type { InboxResponse, ParsePrUrlResponse } from './types';

export const inboxApi = {
  get: () => apiClient.get<InboxResponse>('/api/inbox'),
  parsePrUrl: (url: string) =>
    apiClient.post<ParsePrUrlResponse>('/api/inbox/parse-pr-url', { url }),
  // #311 — force an immediate backend GitHub re-poll. Empty 200 on success (client.ts
  // resolves empty bodies to undefined); throws ApiError on 503. The signal lets the
  // caller bound the held request with a timeout.
  refresh: (signal?: AbortSignal) =>
    apiClient.post<void>('/api/inbox/refresh', undefined, { signal }),
};
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/inbox.ts
git commit -m "feat(#311): inboxApi.refresh() POST helper"
```

---

## Task 4: Frontend hook — `useInboxRefresh`

**Files:**
- Create: `frontend/src/hooks/useInboxRefresh.ts`
- Test: `frontend/__tests__/useInboxRefresh.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/useInboxRefresh.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInboxRefresh } from '../src/hooks/useInboxRefresh';
import { inboxApi } from '../src/api/inbox';

vi.mock('../src/api/inbox', () => ({ inboxApi: { refresh: vi.fn() } }));

const refreshMock = vi.mocked(inboxApi.refresh);

function setup() {
  const reload = vi.fn().mockResolvedValue(undefined);
  const dismiss = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useInboxRefresh({ reload, dismiss, onError }));
  return { hook, reload, dismiss, onError };
}

beforeEach(() => {
  refreshMock.mockReset();
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

describe('useInboxRefresh', () => {
  it('on success: posts, reloads, dismisses, announces, and shows the confirmation', async () => {
    refreshMock.mockResolvedValue(undefined);
    const { hook, reload, dismiss } = setup();

    await act(async () => {
      await hook.result.current.refresh();
    });

    expect(refreshMock).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(hook.result.current.announce).toBe('Inbox refreshed');
    expect(hook.result.current.justRefreshed).toBe(true);
    expect(hook.result.current.isRefreshing).toBe(false);
  });

  it('on failure: calls onError, does not reload, leaves no confirmation', async () => {
    refreshMock.mockRejectedValue(new Error('503'));
    const { hook, reload, onError } = setup();

    await act(async () => {
      await hook.result.current.refresh();
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(hook.result.current.justRefreshed).toBe(false);
    expect(hook.result.current.isRefreshing).toBe(false);
  });

  it('ignores a re-entrant call while one is in flight', async () => {
    let resolve!: () => void;
    refreshMock.mockReturnValue(new Promise<void>((r) => { resolve = () => r(); }));
    const { hook } = setup();

    let first!: Promise<void>;
    act(() => { first = hook.result.current.refresh(); });
    // Second call while the first is pending must be dropped.
    await act(async () => { await hook.result.current.refresh(); });
    expect(refreshMock).toHaveBeenCalledOnce();

    await act(async () => { resolve(); await first; });
  });

  it('blocks a re-click within the min-interval of a SUCCESS but allows retry after a FAILURE', async () => {
    // success stamps the min-interval
    refreshMock.mockResolvedValueOnce(undefined);
    const { hook } = setup();
    await act(async () => { await hook.result.current.refresh(); });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // immediate re-click is swallowed (within ~3s of the success)
    await act(async () => { await hook.result.current.refresh(); });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // a failure does NOT stamp the interval → immediate retry allowed
    refreshMock.mockRejectedValueOnce(new Error('x'));
    // jump past the min-interval so the first (success) stamp no longer blocks
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    await act(async () => { await hook.result.current.refresh(); }); // fails, no stamp
    await act(async () => { await hook.result.current.refresh(); }); // allowed immediately
    expect(refreshMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run __tests__/useInboxRefresh.test.tsx`
Expected: FAIL — module `../src/hooks/useInboxRefresh` not found.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useInboxRefresh.ts`:

```ts
import { useCallback, useRef, useState } from 'react';
import { inboxApi } from '../api/inbox';

const TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 3_000;
const CONFIRM_MS = 3_000; // ≥ MIN_INTERVAL_MS so the lockout window is never feedback-free

interface Options {
  /** Re-fetch the inbox after the backend pull settles. */
  reload: () => Promise<void>;
  /** Clear any pending "N new updates" banner — a manual pull moots it. */
  dismiss: () => void;
  /** Surface a soft, dismissible error (the page keeps its current view). */
  onError: (message: string) => void;
}

export interface InboxRefreshState {
  isRefreshing: boolean;
  justRefreshed: boolean;
  announce: string;
  refresh: () => Promise<void>;
}

export function useInboxRefresh({ reload, dismiss, onError }: Options): InboxRefreshState {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const inFlight = useRef(false);
  const lastSuccessAt = useRef(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    // Re-entrancy guard (synchronous — state updates are async) + min-interval-after-SUCCESS.
    if (inFlight.current) return;
    if (Date.now() - lastSuccessAt.current < MIN_INTERVAL_MS) return;

    inFlight.current = true;
    setIsRefreshing(true);
    setAnnounce('Refreshing inbox…');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await inboxApi.refresh(controller.signal);
      await reload();
      dismiss();
      lastSuccessAt.current = Date.now(); // stamp ONLY on success
      setAnnounce('Inbox refreshed');
      setJustRefreshed(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setJustRefreshed(false), CONFIRM_MS);
    } catch {
      // Includes the AbortError from a timeout. No min-interval stamp → immediate retry allowed.
      setAnnounce('');
      onError("Couldn't refresh the inbox. Try again.");
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setIsRefreshing(false);
    }
  }, [reload, dismiss, onError]);

  return { isRefreshing, justRefreshed, announce, refresh };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run __tests__/useInboxRefresh.test.tsx`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useInboxRefresh.ts frontend/__tests__/useInboxRefresh.test.tsx
git commit -m "feat(#311): useInboxRefresh hook (timeout, min-interval-on-success, confirmation)"
```

---

## Task 5: Frontend component — `RefreshButton`

**Files:**
- Create: `frontend/src/components/Inbox/RefreshButton.tsx`
- Create: `frontend/src/components/Inbox/RefreshButton.module.css`
- Test: `frontend/src/components/Inbox/RefreshButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Inbox/RefreshButton.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefreshButton } from './RefreshButton';

describe('RefreshButton', () => {
  it('renders an accessible idle button and fires onRefresh on click', async () => {
    const onRefresh = vi.fn();
    render(<RefreshButton isRefreshing={false} justRefreshed={false} onRefresh={onRefresh} />);

    const btn = screen.getByRole('button', { name: 'Refresh inbox' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('is disabled and renamed while refreshing', () => {
    render(<RefreshButton isRefreshing justRefreshed={false} onRefresh={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Refreshing inbox…' });
    expect(btn).toBeDisabled();
  });

  it('shows the transient confirmation when justRefreshed', () => {
    render(<RefreshButton isRefreshing={false} justRefreshed onRefresh={vi.fn()} />);
    expect(screen.getByTestId('inbox-refresh-confirm')).toHaveTextContent('Refreshed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/RefreshButton.test.tsx`
Expected: FAIL — module `./RefreshButton` not found.

- [ ] **Step 3: Implement the component + CSS**

Create `frontend/src/components/Inbox/RefreshButton.tsx`:

```tsx
import { Spinner } from '../Spinner/Spinner';
import styles from './RefreshButton.module.css';

interface Props {
  isRefreshing: boolean;
  justRefreshed: boolean;
  onRefresh: () => void;
}

// Manual inbox refresh. `btn btn-icon` (both classes — .btn supplies the inline-flex
// centering .btn-icon lacks, so the swapped-in spinner is centered). The visible
// confirmation is aria-hidden; AT gets completion from the InboxPage role=status region.
export function RefreshButton({ isRefreshing, justRefreshed, onRefresh }: Props) {
  return (
    <span className={styles.group}>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={isRefreshing ? 'Refreshing inbox…' : 'Refresh inbox'}
        title="Refresh inbox"
        disabled={isRefreshing}
        onClick={onRefresh}
        data-testid="inbox-refresh-button"
      >
        {isRefreshing ? (
          <Spinner decorative size="sm" />
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        )}
      </button>
      {justRefreshed && (
        <span className={styles.confirm} aria-hidden="true" data-testid="inbox-refresh-confirm">
          Refreshed
        </span>
      )}
    </span>
  );
}
```

Create `frontend/src/components/Inbox/RefreshButton.module.css`:

```css
/* Anchor the transient confirmation without shifting the toolbar row. */
.group {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* "Refreshed" pill, pinned to the LEFT of the button so it never pushes the row.
   Fades in then is unmounted by the component after ~3s (≥ the click min-interval). */
.confirm {
  position: absolute;
  right: calc(100% + var(--s-2));
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-3); /* muted text token (tokens.css; --muted-fg does NOT exist) */
  pointer-events: none;
  animation: refresh-confirm-in 120ms ease-out;
}

@keyframes refresh-confirm-in {
  from {
    opacity: 0;
    transform: translateX(4px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .confirm {
    animation: none;
  }
}
```

> Token names verified against `tokens.css`: `--text-3` (muted text), `--text-xs`, `--s-2` all exist. Do not invent new tokens.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/RefreshButton.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/RefreshButton.tsx frontend/src/components/Inbox/RefreshButton.module.css frontend/src/components/Inbox/RefreshButton.test.tsx
git commit -m "feat(#311): RefreshButton component (icon/spinner, a11y, transient confirmation)"
```

---

## Task 6: Wire the button into the toolbar (FilterBar + InboxToolbar)

**Files:**
- Modify: `frontend/src/components/Inbox/filters/FilterBar.tsx`
- Modify: `frontend/src/components/Inbox/filters/filters.module.css`
- Modify: `frontend/src/components/Inbox/InboxToolbar.tsx`

- [ ] **Step 1: Add the Sort+Refresh group CSS**

Append to `frontend/src/components/Inbox/filters/filters.module.css`:

```css
/* #311 — keep Sort + Refresh together as ONE flex item so they wrap as a unit
   when .barRow wraps at narrow container widths (flex-wrap wraps items, not
   loose sibling groups). */
.sortRefreshGroup {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
}
```

- [ ] **Step 2: Render the button in FilterBar**

In `frontend/src/components/Inbox/filters/FilterBar.tsx`:

(a) Add the import at the top:

```tsx
import { RefreshButton } from '../RefreshButton';
```

(b) Extend `Props`:

```tsx
interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
  // #311 — manual refresh, threaded from InboxPage via InboxToolbar.
  refresh: () => void;
  isRefreshing: boolean;
  justRefreshed: boolean;
}
```

(c) Update the signature:

```tsx
export function FilterBar({
  sections,
  initialSort,
  ciProbeComplete,
  onState,
  refresh,
  isRefreshing,
  justRefreshed,
}: Props) {
```

(d) Replace the Sort `<label>` block (currently the `<span className={styles.spring} />` followed by `<label className={styles.sort}>…</label>`) with the spring + a grouped Sort+Refresh wrapper:

```tsx
        <span className={styles.spring} />
        <div className={styles.sortRefreshGroup}>
          <label className={styles.sort}>
            Sort:{' '}
            <select value={f.sort} onChange={(e) => f.setSort(e.target.value as SortKey)}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <RefreshButton
            isRefreshing={isRefreshing}
            justRefreshed={justRefreshed}
            onRefresh={refresh}
          />
        </div>
```

- [ ] **Step 2b: Update the existing `FilterBar.test.tsx` for the new required props**

`frontend/src/components/Inbox/filters/FilterBar.test.tsx:40` renders `<FilterBar … />` with only the four original props and will now fail to compile. Add the three new props to that render call (the file already imports `vi`):

```tsx
    render(
      <FilterBar
        sections={secs}
        initialSort="updated"
        ciProbeComplete
        onState={onState}
        refresh={vi.fn()}
        isRefreshing={false}
        justRefreshed={false}
      />,
    );
```

**Edit in place** — the real render wraps `<FilterBar>` in `<MemoryRouter><OpenTabsProvider>…</OpenTabsProvider></MemoryRouter>`; keep those wrappers, just add the three new prop lines to the existing `<FilterBar>` element. (The file's variable names happen to be `secs`/`onState` as shown, and it already imports `vi`. There is exactly one `<FilterBar>` render site.)

- [ ] **Step 3: Thread the props through InboxToolbar**

Replace `frontend/src/components/Inbox/InboxToolbar.tsx`:

```tsx
import { FilterBar, type FilterBarState } from './filters/FilterBar';
import type { InboxSection } from '../../api/types';
import type { SortKey } from './filters/applyInboxFilters';
import styles from './InboxToolbar.module.css';

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
  refresh: () => void;
  isRefreshing: boolean;
  justRefreshed: boolean;
}

// One merged input (filter + paste-to-open) lives inside FilterBar; the toolbar wraps it
// (padding / background / bottom border) and forwards the manual-refresh props (#311).
export function InboxToolbar({
  sections,
  initialSort,
  ciProbeComplete,
  onState,
  refresh,
  isRefreshing,
  justRefreshed,
}: Props) {
  return (
    <div className={styles.toolbar}>
      <FilterBar
        sections={sections}
        initialSort={initialSort}
        ciProbeComplete={ciProbeComplete}
        onState={onState}
        refresh={refresh}
        isRefreshing={isRefreshing}
        justRefreshed={justRefreshed}
      />
    </div>
  );
}
```

- [ ] **Step 4: Typecheck (InboxPage will be a transient error until Task 7)**

Run: `cd frontend && npx tsc -b`
Expected: the ONLY remaining error is `InboxPage.tsx` missing the new `InboxToolbar` props (fixed in Task 7) — assuming Step 2b updated `FilterBar.test.tsx`. FilterBar/InboxToolbar themselves typecheck. If any OTHER file errors, fix it before continuing.

> **Executor note (esp. subagent-driven):** Task 6 deliberately leaves the tree non-building (the InboxPage prop gap above). Do **not** gate the Task 6 commit on a full `npm run build` / full `tsc -b` success and do **not** report this as a failure — it is expected and closes at Task 7 Step 6. The first green full-build gate spanning this boundary is Task 7.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/filters/FilterBar.tsx frontend/src/components/Inbox/filters/FilterBar.test.tsx frontend/src/components/Inbox/filters/filters.module.css frontend/src/components/Inbox/InboxToolbar.tsx
git commit -m "feat(#311): render RefreshButton after Sort; thread props through toolbar"
```

---

## Task 7: Wire `InboxPage` — hook, loading bar, announcer, Toast

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx`

- [ ] **Step 1: Add imports**

Add to the import block of `frontend/src/pages/InboxPage.tsx`:

```tsx
import { useInboxRefresh } from '../hooks/useInboxRefresh';
import { useToast } from '../components/Toast/useToast';
```

- [ ] **Step 2: Instantiate the hook**

Immediately after the existing `const updates = useInboxUpdates();` line, add:

```tsx
  const toast = useToast();
  const { isRefreshing, justRefreshed, announce, refresh } = useInboxRefresh({
    reload,
    dismiss: updates.dismiss,
    onError: (message) => toast.show({ kind: 'error', message }),
  });
```

- [ ] **Step 3: Drive the warm-path loading bar with isRefreshing**

In the main `return` (not the cold-load early return), change the warm-path bar from:

```tsx
      <LoadingBar active={isLoading} data-testid="inbox-loading-bar" />
```

to:

```tsx
      <LoadingBar active={isLoading || isRefreshing} data-testid="inbox-loading-bar" />
```

- [ ] **Step 4: Mount the announcer and pass props to the toolbar**

Inside `<main … data-testid="inbox-page">`, add the always-rendered announcer as the first child (a separate `role=status` from `InboxBanner`'s):

```tsx
        <div className="sr-only" role="status" aria-live="polite" data-testid="inbox-refresh-status">
          {announce}
        </div>
```

Then extend the `<InboxToolbar … />` element with the three new props:

```tsx
        <InboxToolbar
          sections={sections}
          initialSort={initialSort}
          ciProbeComplete={data.ciProbeComplete}
          onState={setFilterState}
          refresh={refresh}
          isRefreshing={isRefreshing}
          justRefreshed={justRefreshed}
        />
```

- [ ] **Step 4b: Scope two existing e2e assertions that will now multi-match `role=status`**

The new always-on announcer adds a second `role=status` node to the inbox (alongside `FilterSummary`'s). Two e2e assertions use a bare, un-scoped `page.getByRole('status')` and will throw Playwright strict-mode "resolved to N elements". Scope them by text in `frontend/e2e/inbox-filter.spec.ts`:

- Line ~292: `await expect(page.getByRole('status')).toContainText(/showing 1 of 5 PRs/i);`
  → `await expect(page.getByRole('status').filter({ hasText: /showing/i })).toContainText(/showing 1 of 5 PRs/i);`
- Line ~391: `await expect(page.getByRole('status')).toContainText(/CI status may be incomplete/i);`
  → `await expect(page.getByRole('status').filter({ hasText: /CI status/i })).toContainText(/CI status may be incomplete/i);`

(`a11y-audit.spec.ts:468` already uses `.first()` and is safe. Grep the e2e dir for any other bare `getByRole('status')` on the inbox and scope those too.) Include `frontend/e2e/inbox-filter.spec.ts` in this task's commit.

- [ ] **Step 5: Typecheck + run the inbox vitest suite**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

Run: `cd frontend && npx vitest run src/pages/InboxPage src/components/Inbox`
Expected: PASS (existing InboxPage/Inbox tests still green; the new toolbar prop is additive). If an existing InboxPage test renders `InboxToolbar` and now fails to compile on missing props, it renders the real `InboxPage` (which supplies them) so it should be unaffected; if any test constructs `InboxToolbar` directly, add the three props there.

- [ ] **Step 6: Build (catches type errors vitest's esbuild misses)**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/e2e/inbox-filter.spec.ts
git commit -m "feat(#311): wire manual refresh into InboxPage (hook, loading bar, announcer, toast)"
```

---

## Task 8: E2E — refresh click drives the loading bar

**Files:**
- Modify: `frontend/e2e/inbox.spec.ts`

- [ ] **Step 1: Add the test**

Append a test to `frontend/e2e/inbox.spec.ts` (follow the file's existing setup — its `test.describe`, fixtures, and the route/auth mocks already used by the other inbox specs; reuse the same `page` bootstrap that lands on a populated inbox). Add:

```ts
test('manual Refresh re-pulls and confirms', async ({ page }) => {
  // (bootstrap to a loaded inbox exactly as the other tests in this file do)
  const refreshBtn = page.getByTestId('inbox-refresh-button');
  await expect(refreshBtn).toBeEnabled();

  await refreshBtn.click();

  // The loading bar activates during the awaited pull...
  await expect(page.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true');
  // ...then settles and the button re-enables.
  await expect(refreshBtn).toBeEnabled();
});
```

> If the test harness's fake backend does not yet route `POST /api/inbox/refresh`, add a route handler/stub mirroring how the suite stubs `GET /api/inbox` (resolve 200 empty, optionally after a short delay so the loading-bar assertion is observable). Keep the assertion tolerant of timing — assert the button returns to enabled rather than racing the bar's exact on/off frames.

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && npx playwright test inbox.spec.ts`
Expected: PASS (new test green; existing inbox e2e unaffected). If the runner needs the app built/served per the repo's e2e setup, follow `.ai/docs/parallel-agent-testing.md`.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/inbox.spec.ts
git commit -m "test(#311): e2e — manual refresh drives loading bar and re-enables"
```

---

## Final verification (before PR)

- [ ] **Backend full suite:** `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj` and `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj` — all green (the `RefreshOverride` addition + new endpoint don't regress existing inbox/poller tests).
- [ ] **Frontend:** `cd frontend && npx vitest run` (full), `npm run build`, and `npx prettier --check` via `rtk proxy npx prettier --check "src/**/*.{ts,tsx}" "__tests__/**/*.{ts,tsx}"` (CI runs raw prettier — rtk masks its exit code locally, so verify through `rtk proxy`).
- [ ] **Lint:** `cd frontend && npm run lint` (eslint).
- [ ] **B1 visual gate (gated issue):** capture before/after of the inbox toolbar in light + dark themes (idle button, in-flight spinner, transient confirmation) and post for owner sign-off before merge. Do NOT merge without it.
- [ ] **Regenerate the `inbox.png` Playwright visual baseline.** `frontend/e2e/parity-baselines.spec.ts:125` screenshots `<main>` (which contains the toolbar) as `inbox.png` — the new Refresh button changes it, so the committed Linux + win32 baselines will MISMATCH and CI parity goes red (a mismatched-not-absent baseline is not auto-written). After the B1 look is approved, regenerate: Linux baseline from the CI `e2e-results` artifact (download `actual.png`, verify the diff is only the new button, `cp` over the Linux baseline) per `reference_regen_linux_parity_baseline_via_ci_artifact`; win32 baseline locally. Confirm `inbox-activity-rail.png` (a separate locator, not `<main>`) is unaffected. Capture the idle-button state for the baseline (the in-flight spinner / transient confirmation are transient and must not be in the screenshot).

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `POST /api/inbox/refresh` awaits `RefreshAsync`, 200 on commit | Task 2 |
| 200-vs-503 honesty (reference-compare; rate-limit subcases) | Task 2 (tests + impl) |
| OCE rethrow per convention | Task 2 |
| Body-size-cap no-body exclusion noted | Task 2 Step 5 |
| `inboxApi.refresh(signal)` | Task 3 |
| ~30s timeout, min-interval-on-success, isRefreshing, announce, confirmation | Task 4 |
| Button: `btn btn-icon`, aria-label, title, decorative spinner, transient confirm | Task 5 |
| Render after Sort; shared flex wrapper; prop chain | Task 6 |
| Warm-path loading bar driven by isRefreshing; role=status announcer; Toast error | Task 7 |
| E2E click→loading-bar→settle | Task 8 |
| B1 visual sign-off | Final verification |
