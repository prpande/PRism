# Setup PAT-guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the "Connect to GitHub" setup screen so it recommends a **classic** PAT (primary) with **fine-grained** as a warned secondary option, with accurate, token-type-aware guidance and error copy — and harden the CI detector so a fine-grained token degrades gracefully instead of breaking inbox refresh.

**Architecture:** Frontend-led. A token-type selector (the existing `SegmentedControl`, new `variant="nav"`) drives a two-panel body inside `SetupForm`. Error copy moves to a shared helper used by both connect and replace flows. One small backend reliability fix makes `GitHubCiFailingDetector` swallow non-success Checks-API responses (return `CiStatus.None`) so a fine-grained token can't abort `InboxRefreshOrchestrator.RefreshAsync` (which has no catch).

**Tech Stack:** React + Vite + TypeScript (vitest + @testing-library/react), CSS modules with oklch design tokens; .NET 10 / C# (xUnit + FluentAssertions) for the backend detector.

**Spec:** `docs/specs/2026-06-06-setup-pat-guidance-design.md`

**Commands:** frontend tests `npm test` (vitest run) from `frontend/`; single file `npx vitest run src/path/file.test.tsx`. Backend `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`. Pre-push gate: `npm run lint` + `npm run build` from `frontend/` (run prettier directly per repo convention, not via rtk).

---

## Task 1: Backend — graceful CI degradation on non-success Checks responses

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` (`FetchChecksAsync` ~lines 87-92, `FetchCombinedStatusAsync` ~lines 157-163)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Write the failing tests**

Add these to `GitHubCiFailingDetectorTests` (the `Respond`, `BuildSut`, `RouterHandler`, `Raw` helpers already exist in the file):

```csharp
[Fact]
public async Task Forbidden_check_runs_degrades_to_none_not_throw()
{
    // Fine-grained PATs cannot call the Checks API; GitHub returns a non-2xx.
    var handler = new FakeHttpMessageHandler(req =>
        req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
            ? Respond(HttpStatusCode.Forbidden, "{}")
            : Respond(HttpStatusCode.OK, AllPassingStatus));
    var sut = BuildSut(handler);

    var result = await sut.DetectAsync([Raw(1)], default);

    result.Should().HaveCount(1);
    result[0].Ci.Should().Be(CiStatus.None);
}

[Fact]
public async Task Forbidden_combined_status_degrades_to_none_not_throw()
{
    var handler = new FakeHttpMessageHandler(req =>
        req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
            ? Respond(HttpStatusCode.OK, AllPassingCheckRuns)
            : Respond(HttpStatusCode.Forbidden, "{}"));
    var sut = BuildSut(handler);

    var result = await sut.DetectAsync([Raw(1)], default);

    result.Should().HaveCount(1);
    result[0].Ci.Should().Be(CiStatus.None);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: the two new tests FAIL — `DetectAsync` throws `HttpRequestException` (via `EnsureSuccessStatusCode`) instead of returning `None`.

- [ ] **Step 3: Replace the throwing guard with graceful degradation**

In `FetchChecksAsync`, replace the line `resp.EnsureSuccessStatusCode();` (after the 404 and 429 checks, ~line 92) with:

```csharp
            // Fine-grained PATs can't call the Checks API (GitHub returns 403/other
            // non-2xx). Degrade to "no CI signal" rather than throwing — a throw
            // propagates through DetectAsync into InboxRefreshOrchestrator.RefreshAsync,
            // which has no catch, aborting the WHOLE inbox refresh. (#213)
            if (!resp.IsSuccessStatusCode) return CiStatus.None;
```

In `FetchCombinedStatusAsync`, replace its `resp.EnsureSuccessStatusCode();` (after the 404 and 429 checks, ~line 163) with the same guard:

```csharp
            if (!resp.IsSuccessStatusCode) return CiStatus.None;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: all tests PASS (including the existing 429 → `RateLimitExceededException` test, which is untouched by this change).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubCiFailingDetector.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "fix(#213): degrade CI detection on non-2xx instead of aborting inbox refresh"
```

---

## Task 2: SegmentedControl — add `variant="nav"`

**Files:**
- Modify: `frontend/src/components/controls/SegmentedControl.tsx`
- Modify: `frontend/src/components/controls/SegmentedControl.module.css`
- Test: `frontend/src/components/controls/SegmentedControl.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `SegmentedControl.test.tsx`:

```tsx
it('renders the nav variant as an accessible radiogroup and toggles', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <SegmentedControl
      variant="nav"
      label="Choose a token type"
      options={[
        { value: 'classic', label: 'Classic' },
        { value: 'fine-grained', label: 'Fine-grained' },
      ]}
      value="classic"
      onChange={onChange}
    />,
  );
  const group = screen.getByRole('radiogroup', { name: 'Choose a token type' });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('radio', { name: 'Fine-grained' }));
  expect(onChange).toHaveBeenCalledWith('fine-grained');
});
```

(Match the existing import block in that test file — it already imports `render`, `screen`, `userEvent`, `vi`, `it`, `expect`, and `SegmentedControl`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: FAIL — TypeScript/prop error: `variant` does not exist on `SegmentedControlProps`.

- [ ] **Step 3: Add the variant prop**

In `SegmentedControl.tsx`, extend the props and select class names by variant. Change the interface:

```tsx
export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  variant?: 'segmented' | 'nav';
}
```

Destructure `variant = 'segmented'` in the function signature, then compute classes before the `return`:

```tsx
  const groupCls = variant === 'nav' ? styles.groupNav : styles.group;
  const segCls = variant === 'nav' ? styles.segNav : styles.seg;
  const segOnCls = variant === 'nav' ? styles.segNavOn : styles.segOn;
```

Use them: change the wrapper to `className={groupCls}` and the button to `className={`${segCls}${selected ? ` ${segOnCls}` : ''}`}`.

- [ ] **Step 4: Add the nav-variant styles**

Append to `SegmentedControl.module.css`:

```css
/* nav variant (#213): mirrors Header.module.css .tab/.tabActive — no track,
   accent-glow hover, accent-tint selected. */
.groupNav {
  display: inline-flex;
  gap: var(--s-3);
  align-items: center;
}
.segNav {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: var(--text-sm);
  padding: 6px 12px;
  border-radius: var(--radius-2);
  cursor: pointer;
  transition:
    color var(--t-fast) var(--ease-out),
    background var(--t-fast) var(--ease-out),
    box-shadow var(--t-fast) var(--ease-out);
}
.segNav:hover:not(:disabled):not(.segNavOn) {
  color: var(--accent-hover);
  background: color-mix(in oklch, var(--accent) 10%, transparent);
  box-shadow: 0 0 12px -2px var(--accent-ring);
}
.segNav:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
.segNavOn {
  background: color-mix(in oklch, var(--accent) 14%, transparent);
  color: var(--text-1);
  font-weight: 500;
}
@media (prefers-reduced-motion: reduce) {
  .segNav {
    transition: none;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: PASS (existing SegmentedControl tests + the new nav-variant test).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/controls/SegmentedControl.tsx frontend/src/components/controls/SegmentedControl.module.css frontend/src/components/controls/SegmentedControl.test.tsx
git commit -m "feat(#213): add nav variant to SegmentedControl"
```

---

## Task 3: Shared token error-copy helper

**Files:**
- Create: `frontend/src/components/Setup/tokenErrorCopy.ts`
- Create: `frontend/src/components/Setup/tokenErrorCopy.test.ts`
- Modify (Task 6): `frontend/src/pages/SetupPage.tsx` (import these, delete local `replaceErrorMessage`)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Setup/tokenErrorCopy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { connectErrorMessage, replaceErrorMessage } from './tokenErrorCopy';

describe('connectErrorMessage', () => {
  it('maps insufficientscopes to the classic repo/read:org message', () => {
    expect(connectErrorMessage('insufficientscopes')).toBe(
      'This token is missing required scopes. A classic token needs repo and read:org.',
    );
  });
  it('invalid token copy mentions neither scope nor permission', () => {
    const msg = connectErrorMessage('invalidtoken');
    expect(msg).toContain('GitHub rejected this token');
    expect(msg.toLowerCase()).not.toContain('scope');
    expect(msg.toLowerCase()).not.toContain('permission');
  });
  it('maps network/dns codes to a connection message', () => {
    expect(connectErrorMessage('networkerror')).toContain('connection');
    expect(connectErrorMessage('dnserror')).toContain('connection');
  });
  it('unknown code falls back to a static message that never echoes the code', () => {
    expect(connectErrorMessage('weird-new-code-xyz')).toBe(
      'Validation failed. Check your token and try again.',
    );
    expect(connectErrorMessage(undefined)).toBe(
      'Validation failed. Check your token and try again.',
    );
  });
});

describe('replaceErrorMessage', () => {
  it('keeps replace-only codes', () => {
    expect(replaceErrorMessage('submit-in-flight')).toContain('submit started');
    expect(replaceErrorMessage('pat-required')).toContain('Paste your new token');
  });
  it('shares the classic scopes message and static fallback', () => {
    expect(replaceErrorMessage('insufficientscopes')).toBe(
      'This token is missing required scopes. A classic token needs repo and read:org.',
    );
    expect(replaceErrorMessage('weird')).toBe('Validation failed. Check your token and try again.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Setup/tokenErrorCopy.test.ts`
Expected: FAIL — module `./tokenErrorCopy` does not exist.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/components/Setup/tokenErrorCopy.ts`:

```ts
// Maps backend AuthValidationError codes (lowercased enum names) to user-facing
// copy. Shared by the connect flow (inline pill, SetupForm) and the replace flow
// (toast, SetupPage). `insufficientscopes` is classic-only by construction —
// GitHubReviewService only emits it for ghp_ tokens — so it names the classic
// scopes; there is no fine-grained variant. The fallback is STATIC: it never
// echoes the raw `code` into the UI. (#213)
const REJECTED = 'GitHub rejected this token. Check that you copied the whole token, then try again.';
const CLASSIC_SCOPES = 'This token is missing required scopes. A classic token needs repo and read:org.';
const NETWORK = 'Couldn’t reach GitHub. Check your connection, then try again.';
const SERVER = 'GitHub returned a server error. Try again in a moment.';
const GENERIC = 'Validation failed. Check your token and try again.';

export function connectErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalidtoken':
    case 'validation-failed':
      return REJECTED;
    case 'insufficientscopes':
      return CLASSIC_SCOPES;
    case 'networkerror':
    case 'dnserror':
      return NETWORK;
    case 'servererror':
      return SERVER;
    default:
      return GENERIC;
  }
}

export function replaceErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'submit-in-flight':
      return 'A submit started during your token paste. Try Replace again in a moment.';
    case 'pat-required':
      return 'Paste your new token before continuing.';
    case 'invalid-json':
      return 'Internal error while parsing the token. Please refresh and try again.';
    default:
      return connectErrorMessage(code);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Setup/tokenErrorCopy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Setup/tokenErrorCopy.ts frontend/src/components/Setup/tokenErrorCopy.test.ts
git commit -m "feat(#213): shared token error-copy helper (classic-only scopes, static fallback)"
```

---

## Task 4: MaskedInput — `hasError` prop + danger ring

**Files:**
- Modify: `frontend/src/components/Setup/MaskedInput.tsx`
- Modify: `frontend/src/components/Setup/MaskedInput.module.css`
- Test: `frontend/src/components/Setup/MaskedInput.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Setup/MaskedInput.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MaskedInput } from './MaskedInput';

describe('MaskedInput', () => {
  it('marks the input invalid when hasError is set', () => {
    render(
      <MaskedInput id="pat" value="" onChange={vi.fn()} ariaLabel="Personal access token" hasError />,
    );
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('aria-invalid', 'true');
  });
  it('has no aria-invalid when hasError is absent', () => {
    render(<MaskedInput id="pat" value="" onChange={vi.fn()} ariaLabel="Personal access token" />);
    expect(screen.getByLabelText('Personal access token')).not.toHaveAttribute('aria-invalid');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Setup/MaskedInput.test.tsx`
Expected: FAIL — `hasError` is not a valid prop; `aria-invalid` is absent.

- [ ] **Step 3: Add the prop and attribute**

In `MaskedInput.tsx`, add `hasError?: boolean;` to `Props`, destructure it, and set the attribute on the `<input>`:

```tsx
interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  hasError?: boolean;
}

export function MaskedInput({ id, value, onChange, placeholder, ariaLabel, hasError }: Props) {
```

On the `<input>` element add: `aria-invalid={hasError || undefined}` (so the attribute is omitted, not `"false"`, when there is no error).

- [ ] **Step 4: Add the danger-ring style**

Append to `MaskedInput.module.css`:

```css
/* #213 — error state ring, tied to the field via aria-invalid. */
.input[aria-invalid='true'] {
  border-color: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--danger) 18%, transparent);
}
.input[aria-invalid='true']:focus {
  outline-color: var(--danger);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Setup/MaskedInput.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Setup/MaskedInput.tsx frontend/src/components/Setup/MaskedInput.module.css frontend/src/components/Setup/MaskedInput.test.tsx
git commit -m "feat(#213): MaskedInput hasError prop with danger ring"
```

---

## Task 5: SetupForm — token-type selector + panels

**Files:**
- Modify: `frontend/src/components/Setup/SetupForm.tsx`
- Modify: `frontend/src/components/Setup/SetupForm.module.css`
- Test: `frontend/src/components/Setup/SetupForm.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Setup/SetupForm.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from './SetupForm';

const host = 'https://github.com';

describe('SetupForm', () => {
  it('defaults to Classic: scopes, classic link, SSO callout, ghp_ placeholder', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('link', { name: /generate a classic token/i })).toHaveAttribute(
      'href',
      'https://github.com/settings/tokens/new',
    );
    expect(screen.getByText('repo')).toBeInTheDocument();
    expect(screen.getByText('read:org')).toBeInTheDocument();
    expect(screen.getByText(/Configure SSO/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('placeholder', 'ghp_…');
  });

  it('switching to Fine-grained shows permissions, warning, fg link, github_pat_ placeholder', async () => {
    const user = userEvent.setup();
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: 'Fine-grained' }));
    expect(screen.getByRole('link', { name: /generate a fine-grained token/i })).toHaveAttribute(
      'href',
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.getByText('Commit statuses')).toBeInTheDocument();
    expect(screen.getByText(/Actions CI status won/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute(
      'placeholder',
      'github_pat_…',
    );
  });

  it('never mentions "Checks" and drops the local-first tagline', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} />);
    expect(screen.queryByText('Checks')).not.toBeInTheDocument();
    expect(screen.queryByText(/local-first/i)).not.toBeInTheDocument();
  });

  it('shows the error pill and marks the input invalid when error is set', () => {
    render(<SetupForm host={host} onSubmit={vi.fn()} error="GitHub rejected this token." />);
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub rejected this token.');
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('aria-invalid', 'true');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Setup/SetupForm.test.tsx`
Expected: FAIL — no radios (still the single "Generate a token" link), "Checks" present, tagline present.

- [ ] **Step 3: Rewrite SetupForm's body**

In `SetupForm.tsx`: add the import `import { SegmentedControl } from '../controls/SegmentedControl';`, replace the `PERMISSIONS` constant and the brand+section-1 markup. Full new file body (keep the existing `Props` interface incl. `showBackToWelcome`, and the replace-mode Cancel block unchanged):

```tsx
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FirstRunDisclosure } from './FirstRunDisclosure';
import { MaskedInput } from './MaskedInput';
import { SegmentedControl } from '../controls/SegmentedControl';
import { GitHubMark } from '../icons/GitHubMark';
import styles from './SetupForm.module.css';

type TokenType = 'classic' | 'fine-grained';

const FG_PERMISSIONS: ReadonlyArray<{ name: string; level: string }> = [
  { name: 'Pull requests', level: 'Read and write' },
  { name: 'Contents', level: 'Read' },
  { name: 'Commit statuses', level: 'Read' },
];

const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M9.5 2.75A.75.75 0 0110.25 2h3.5a.25.25 0 01.25.25v3.5a.75.75 0 01-1.5 0V4.56L8.78 8.28a.75.75 0 01-1.06-1.06l3.72-3.72H10.25a.75.75 0 01-.75-.75z" />
    <path d="M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5z" />
  </svg>
);
const OrgIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M1.75 16A1.75 1.75 0 010 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 00.25-.25V8.285a.25.25 0 00-.111-.208l-1.055-.703a.75.75 0 11.832-1.248l1.055.703c.487.325.779.871.779 1.456v5.965A1.75 1.75 0 0114.25 16h-3.5a.766.766 0 01-.197-.026c-.099.017-.2.026-.303.026h-3a.75.75 0 01-.75-.75V14h-1v1.25a.75.75 0 01-.75.75zM1.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25H4v-1.25a.75.75 0 01.75-.75h2.5a.75.75 0 01.75.75v1.25h2.25a.25.25 0 00.25-.25V1.75a.25.25 0 00-.25-.25zM3.75 6h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5zM3 3.75A.75.75 0 013.75 3h.5a.75.75 0 010 1.5h-.5A.75.75 0 013 3.75zm4 3A.75.75 0 017.75 6h.5a.75.75 0 010 1.5h-.5A.75.75 0 017 6.75zM7.75 3h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5zM3 9.75A.75.75 0 013.75 9h.5a.75.75 0 010 1.5h-.5A.75.75 0 013 9.75zM7.75 9h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5z" />
  </svg>
);
const WarnIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575zM8 5a.75.75 0 00-.75.75v2.5a.75.75 0 001.5 0v-2.5A.75.75 0 008 5zm1 6a1 1 0 10-2 0 1 1 0 002 0z" />
  </svg>
);
const ErrorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 7.5a1 1 0 100-2 1 1 0 000 2z" />
  </svg>
);

export function SetupForm({
  host,
  onSubmit,
  error,
  busy,
  isReplaceMode,
  showBackToWelcome,
}: Props) {
  const [pat, setPat] = useState('');
  const [tokenType, setTokenType] = useState<TokenType>('classic');
  const base = host.replace(/\/$/, '');
  const classicUrl = `${base}/settings/tokens/new`;
  const fineGrainedUrl = `${base}/settings/personal-access-tokens/new`;
  const placeholder = tokenType === 'classic' ? 'ghp_…' : 'github_pat_…';

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pat.trim().length === 0) return;
    void onSubmit(pat);
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      {showBackToWelcome && (
        <Link to="/welcome" className={styles.back}>
          <span aria-hidden="true">← </span>Back
        </Link>
      )}
      <div className={styles.brand}>
        <h1 className={styles.title}>
          <GitHubMark size={22} />
          Connect to GitHub
        </h1>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>1</span>
          Choose a token type
        </h2>
        <SegmentedControl<TokenType>
          variant="nav"
          label="Choose a token type"
          options={[
            { value: 'classic', label: 'Classic' },
            { value: 'fine-grained', label: 'Fine-grained' },
          ]}
          value={tokenType}
          onChange={setTokenType}
        />

        {tokenType === 'classic' ? (
          <div className={styles.panel}>
            <a href={classicUrl} target="_blank" rel="noreferrer" className={styles.link}>
              Generate a classic token <ExternalIcon />
            </a>
            <p className={styles.lbl}>Required scopes</p>
            <div className={styles.scopes}>
              <code className={styles.chip}>repo</code>
              <code className={styles.chip}>read:org</code>
            </div>
            <div className={styles.callout}>
              <span className={styles.calloutIco}>
                <OrgIcon />
              </span>
              <span>
                Using <strong>SAML SSO</strong>? After creating the token, click{' '}
                <strong>Configure SSO → Authorize</strong> for your organization.
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.panel}>
            <a href={fineGrainedUrl} target="_blank" rel="noreferrer" className={styles.link}>
              Generate a fine-grained token <ExternalIcon />
            </a>
            <p className={styles.lbl}>Fine-grained permissions</p>
            <dl className={styles.permissions}>
              {FG_PERMISSIONS.map((p) => (
                <div key={p.name} className={styles.permissionRow}>
                  <dt>{p.name}</dt>
                  <dd>{p.level}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.permissionsNote}>
              Metadata: Read is auto-included by GitHub. For Repository access, choose
              <em> All repositories</em> or <em>Select repositories</em>.
            </p>
            <div className={styles.warn}>
              <span className={styles.warnIco}>
                <WarnIcon />
              </span>
              <span>
                Can&rsquo;t read <strong>GitHub Actions</strong> check results — Actions CI status
                won&rsquo;t show in PRism. Other CI providers still work.
              </span>
            </div>
          </div>
        )}
      </section>

      <FirstRunDisclosure />

      <section className={`${styles.section} ${styles.sectionLast}`}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>2</span>
          Paste it below
        </h2>
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder={placeholder}
          ariaLabel="Personal access token"
          hasError={!!error}
        />
      </section>

      {error && (
        <div role="alert" className={styles.error}>
          <ErrorIcon />
          {error}
        </div>
      )}

      <button
        type="submit"
        className={`${styles.continue} btn btn-primary btn-lg`}
        disabled={pat.trim().length === 0 || busy}
      >
        {busy ? 'Validating…' : 'Continue'}
      </button>
      {isReplaceMode &&
        (busy ? (
          <span
            role="link"
            aria-disabled="true"
            className={`${styles.cancel} ${styles.cancelDisabled}`}
          >
            Cancel
          </span>
        ) : (
          <Link to="/settings" className={styles.cancel}>
            Cancel
          </Link>
        ))}
    </form>
  );
}
```

(The `Props` interface and its comments above the function are unchanged — keep them as-is in the file.)

- [ ] **Step 4: Update SetupForm CSS**

In `SetupForm.module.css`: **remove** the `.sub` and `.footnote` (and `.footnote code`) rules. Add:

```css
.sectionLast {
  padding-bottom: 0;
}
.lbl {
  margin: var(--s-3) 0 var(--s-2);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--text-3);
}
.scopes {
  display: flex;
  gap: var(--s-2);
}
.chip {
  font-family: ui-monospace, monospace;
  font-size: var(--text-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  color: var(--accent);
  padding: 2px 9px;
  border-radius: var(--radius-2);
}
.callout,
.warn {
  display: flex;
  gap: var(--s-2);
  align-items: flex-start;
  margin-top: var(--s-4);
  padding: 11px var(--s-3);
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.callout {
  background: var(--accent-soft);
  border: 1px solid color-mix(in oklch, var(--accent) 22%, transparent);
  color: var(--text-1);
}
.calloutIco {
  display: flex;
  margin-top: 1px;
  flex: 0 0 auto;
  color: var(--accent);
}
.warn {
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  color: var(--warning-fg);
}
.warnIco {
  display: flex;
  margin-top: 1px;
  flex: 0 0 auto;
  color: var(--warning);
}
```

Also change the existing `.section` rule's `padding: var(--s-4) 0;` to `padding: var(--s-3) 0;` (tightened rhythm), and confirm `.error` keeps `display:flex; align-items:center; gap:6px;` so the new leading `ErrorIcon` aligns (it already does).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/Setup/SetupForm.test.tsx`
Expected: PASS (all four tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css frontend/src/components/Setup/SetupForm.test.tsx
git commit -m "feat(#213): classic-primary token-type selector + panels in SetupForm"
```

---

## Task 6: SetupPage — wire shared error copy + remove local mapper

**Files:**
- Modify: `frontend/src/pages/SetupPage.tsx`

- [ ] **Step 1: Replace the local `replaceErrorMessage` with the shared import**

Delete the entire local `function replaceErrorMessage(...) { … }` block (lines ~21-42) and add to the imports:

```ts
import { connectErrorMessage, replaceErrorMessage } from '../components/Setup/tokenErrorCopy';
```

- [ ] **Step 2: Route connect-flow errors through `connectErrorMessage`**

In `onConnect`, change the `!result.ok` branch from `setError(result.detail ?? result.error ?? 'Validation failed.')` to:

```ts
        setError(connectErrorMessage(result.error));
```

And change the `catch` branch from `setError((e as Error).message)` to:

```ts
      setError(connectErrorMessage(undefined));
```

(The replace flow already calls `replaceErrorMessage(...)` — it now resolves to the shared import; no other change there.)

- [ ] **Step 3: Verify build + existing tests**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: type-checks clean; full suite green (no test asserted the old connect raw-passthrough copy).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SetupPage.tsx
git commit -m "feat(#213): route connect errors through shared token-error copy"
```

---

## Task 7: Reconcile the product spec's PAT posture

**Files:**
- Modify: `docs/spec/03-poc-features.md`

- [ ] **Step 1: Update the posture paragraph**

Find the line: `Classic PATs (broader scope) work without these caveats but are deprecated by GitHub for new use cases. PoC documents fine-grained PAT support; classic-PAT compatibility is not actively prevented but not guaranteed.`

Replace with:

```markdown
Because fine-grained PATs are per-org scoped (above) and cannot call the Checks API
(so GitHub Actions CI is invisible to them), the setup screen now **recommends a
classic PAT** (`repo` + `read:org`) as the primary token type, with fine-grained
offered as a warned secondary option (see #213 /
`docs/specs/2026-06-06-setup-pat-guidance-design.md`). Classic reads both Actions
check-runs and commit statuses across all the user's orgs. GitHub discourages
classic for new use cases, and an org can block it — a trade-off accepted because
fine-grained is functionally insufficient for PRism's inbox + CI features.
```

- [ ] **Step 2: Commit**

```bash
git add docs/spec/03-poc-features.md
git commit -m "docs(#213): reconcile 03-poc-features PAT posture to classic-primary"
```

---

## Task 8: Playwright e2e parity + full local gate

**Files:**
- Modify: any e2e spec/snapshot asserting the old setup copy (search first)

- [ ] **Step 1: Find setup-screen e2e references**

Run: `cd frontend && grep -rniE "generate a token|local-first|ghp_… or github_pat_|Checks|read:org" e2e tests 2>/dev/null`
For each hit asserting old copy (e.g. "Generate a token", the combined placeholder, the "Checks" row, or the old footnote), update the expectation to the new copy: "Generate a classic token" / "Generate a fine-grained token", token-type radios, and the per-tab placeholder.

- [ ] **Step 2: Re-baseline any setup-screen visual snapshot (if present)**

If a Playwright screenshot baseline covers `/setup`, regenerate it per the repo's baseline process (CI artifact → verify diff is the intended redesign → commit). Note in the PR that the snapshot change is the #213 redesign.

- [ ] **Step 3: Run the full local pre-push gate**

```bash
cd frontend && npm run lint
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run build
npm test
```
Then backend: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`
Expected: all green. (Run prettier directly, not via rtk — see repo memory.)

- [ ] **Step 4: Commit any e2e/snapshot updates**

```bash
git add frontend/e2e
git commit -m "test(#213): update setup-screen e2e to classic-primary copy"
```

---

## Self-Review

- **Spec coverage:** classic-primary selector (T5), fine-grained warning (T5), no "Checks" (T5), per-tab placeholder (T5), SSO callout (T5), classic-only error copy (T3/T6), MaskedInput danger ring (T4), graceful CI degradation / Decision 1A (T1), SegmentedControl reuse + nav variant (T2), 03-poc-features reconcile (T7), tagline removal (T5), e2e parity (T8). All spec sections map to a task.
- **Type consistency:** `TokenType = 'classic' | 'fine-grained'` used in SetupForm + SegmentedControl generic; `connectErrorMessage`/`replaceErrorMessage` signatures match across T3/T6; `hasError` prop matches across T4/T5.
- **No placeholders:** every code step has complete content.
- **Visual B1 gate:** the look matches the approved mockup (`classic-primary-v5` / `error-states`); a human visual-assert + dark-theme `--warning` contrast check happen at the B1 gate before merge.
