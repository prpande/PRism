// frontend/src/components/Ai/aiFailure.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, useAiFailure, type AiSeam } from './aiFailure';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };
const PR_B: PrReference = { owner: 'o', repo: 'r', number: 2 };
const retryNoop = () => {};

function Probe() {
  const { activeFailedSeams, retrying, dismissed } = useAiFailure();
  return (
    <div data-testid="active">{`${activeFailedSeams.join(',')}|retrying=${retrying}|dismissed=${dismissed}`}</div>
  );
}
function grab(path: string) {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() {
    api = useAiFailure();
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AiFailureProvider>
        <Grab />
        <Probe />
      </AiFailureProvider>
    </MemoryRouter>,
  );
  return () => api;
}

it('renders only the active PR failed set; coalesces multiple seams in stable order', () => {
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'hunk-annotations', { retry: retryNoop });
    api().report(PR_A, 'summary', { retry: retryNoop });
    api().report(PR_B, 'file-focus', { retry: retryNoop }); // backgrounded — recorded, not shown
  });
  expect(screen.getByTestId('active').textContent).toBe(
    'summary,hunk-annotations|retrying=false|dismissed=false',
  );
});

it('clear removes a seam; clearPr removes a whole PR', () => {
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
    api().report(PR_A, 'file-focus', { retry: retryNoop });
  });
  act(() => {
    api().clear(PR_A, 'summary');
  });
  expect(screen.getByTestId('active').textContent).toContain('file-focus|');
  act(() => {
    api().clearPr(PR_A);
  });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false|dismissed=false');
});

it('renders nothing on a non-PR route (activeKey null)', () => {
  const api = grab('/');
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false|dismissed=false');
});

it('retryAll calls every active-PR retry; retrying clears only after all settle', () => {
  const calls: AiSeam[] = [];
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'summary', { retry: () => calls.push('summary') });
    api().report(PR_A, 'file-focus', { retry: () => calls.push('file-focus') });
  });
  act(() => {
    api().retryAll();
  });
  expect(calls.sort()).toEqual(['file-focus', 'summary']);
  expect(screen.getByTestId('active').textContent).toContain('retrying=true');
  act(() => {
    api().clear(PR_A, 'summary');
  }); // one recovers
  expect(screen.getByTestId('active').textContent).toContain('retrying=true'); // file-focus still pending
  act(() => {
    api().report(PR_A, 'file-focus', { retry: () => {} });
  }); // other re-fails → settles
  expect(screen.getByTestId('active').textContent).toContain('retrying=false');
});

it('dismiss hides; re-shows on a NEW (different) failure set', () => {
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  });
  act(() => {
    api().dismiss();
  });
  expect(screen.getByTestId('active').textContent).toContain('dismissed=true');
  act(() => {
    api().report(PR_A, 'file-focus', { retry: retryNoop });
  });
  expect(screen.getByTestId('active').textContent).toContain('dismissed=false');
});

it('dismiss → recover → same-seam re-fail shows a fresh toast (fingerprint reset on empty)', () => {
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  });
  act(() => {
    api().dismiss();
  });
  act(() => {
    api().clear(PR_A, 'summary');
  }); // recover → set empties → fingerprint resets
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  }); // same seam fails again
  expect(screen.getByTestId('active').textContent).toBe('summary|retrying=false|dismissed=false');
});

it('useAiFailure outside a provider is a no-op (NOOP default)', () => {
  function Grab() {
    const a = useAiFailure();
    a.report(PR_A, 'summary', { retry: retryNoop });
    return <div>ok</div>;
  }
  expect(() =>
    render(
      <MemoryRouter>
        <Grab />
      </MemoryRouter>,
    ),
  ).not.toThrow();
});

it('stale-clear regression: clear captured before failures are added still empties the set', () => {
  // Reproduces the stale-closure bug: capture `clear` BEFORE any failure exists (so a stale
  // `clear` would have closed over an empty `failures` snapshot), then report, dismiss, call the
  // captured `clear` to recover, and verify a subsequent re-report shows the toast again.
  // With the failuresRef fix, `clear` is stable and always sees the live snapshot — this passes.
  // Without the fix (deps=[failures,settle]), the captured stale `clear` sees failures={} so
  // `willEmpty` is false, the dismissal fingerprint is NOT reset, and the re-report stays hidden.
  const api = grab('/pr/o/r/1');
  // Capture `clear` BEFORE any failures exist (simulates an effect that captured clear on mount).
  const staleClear = api().clear;
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  }); // failures change
  act(() => {
    api().dismiss();
  });
  expect(screen.getByTestId('active').textContent).toContain('dismissed=true');
  // Call the CAPTURED (potentially stale) clear — must still perform full recovery.
  act(() => {
    staleClear(PR_A, 'summary');
  });
  // Re-report the same seam; toast must re-show (fingerprint was reset by the clear).
  act(() => {
    api().report(PR_A, 'summary', { retry: retryNoop });
  });
  expect(screen.getByTestId('active').textContent).toBe('summary|retrying=false|dismissed=false');
});
