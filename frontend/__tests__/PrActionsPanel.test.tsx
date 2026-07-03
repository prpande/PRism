// frontend/__tests__/PrActionsPanel.test.tsx
import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrActionsPanel } from '../src/components/PrDetail/OverviewTab/PrActionsPanel';
import { renderWithPrDetailContext } from '../src/components/PrDetail/testUtils';
import { makePrDetailContextValue } from '../src/components/PrDetail/testUtils';
import {
  PrDetailContextProvider,
  type PrDetailContextValue,
} from '../src/components/PrDetail/prDetailContext';
import { makePr, makePrDetailDto } from './helpers/prDetail';
import type { MergeReadiness } from '../src/components/shared/mergeReadiness';

const invoke = vi.fn();
let pending: string | null = null;
let mergePhase: string = 'idle';
vi.mock('../src/hooks/usePrAction', () => ({
  usePrAction: () => ({ pending, mergePhase, invoke }),
}));

// #566 B-fix: the in-panel Refresh forces a cache-bypassing backend re-read (POST /…/refresh),
// not the cache-first reload(). Mock the api module so the click doesn't hit the network.
import { refreshPrDetail } from '../src/api/prDetail';
vi.mock('../src/api/prDetail', () => ({
  refreshPrDetail: vi.fn(() => Promise.resolve()),
  getPrDetail: vi.fn(),
}));

// Local harness (plan ce-doc-review round 2 — coherence C1/C2): renderWithPrDetailContext returns a
// plain RTL result whose `.rerender` CANNOT swap the provider value, so the click-outside,
// external-state, and focus-on-swap tests use this harness — it holds the context overrides in
// state (a test calls `ctl.current!.set({...})` to swap them at runtime) and mounts an outside
// button beside the panel. Confirm the provider export name against prDetailContext.tsx
// (`PrDetailContextProvider` per the file's own provider) and makePrDetailContextValue's arg shape.
type Ctl = { set: (o: Partial<PrDetailContextValue>) => void };
function Harness({
  initial,
  ctl,
}: {
  initial: Partial<PrDetailContextValue>;
  ctl: { current: Ctl | null };
}) {
  const [overrides, setOverrides] = useState<Partial<PrDetailContextValue>>(initial);
  ctl.current = { set: (o) => setOverrides((p) => ({ ...p, ...o })) };
  return (
    <PrDetailContextProvider value={makePrDetailContextValue(overrides)}>
      <button>outside</button>
      <PrActionsPanel />
    </PrDetailContextProvider>
  );
}

describe('PrActionsPanel', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(refreshPrDetail).mockClear();
    pending = null;
    mergePhase = 'idle';
  });

  function renderPanel(prOverrides: Partial<ReturnType<typeof makePr>>, ctxOverrides = {}) {
    const prDetail = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isDraft: false,
        isClosed: false,
        isMerged: false,
        // Slice-2 merge defaults: a generic mergeable PR. Each merge test overrides
        // exactly the readiness / allowed-methods / headSha it asserts on.
        mergeReadiness: 'ready',
        allowedMergeMethods: { merge: true, squash: true, rebase: true },
        headSha: 'headsha',
        ...prOverrides,
      }),
    });
    return renderWithPrDetailContext(<PrActionsPanel />, { prDetail, ...ctxOverrides });
  }

  it('renders Convert-to-draft + Close for an open non-draft PR', () => {
    renderPanel({});
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('renders Mark-ready + Close for an open draft PR', () => {
    renderPanel({ isDraft: true });
    expect(screen.getByRole('button', { name: /ready for review/i })).toBeInTheDocument();
  });

  it('renders only Reopen for a closed PR', () => {
    renderPanel({ state: 'closed', isClosed: true });
    expect(screen.getByRole('button', { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('disables every action while the PR detail is loading/updating', () => {
    // #566 — a mid-update click must not fire a second action against a state that hasn't
    // reconciled yet. isLoading (usePrDetail re-fetch in flight) disables the whole action set.
    renderPanel({}, { isLoading: true });
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeDisabled();
  });

  it('disables Reopen on a closed PR while loading/updating', () => {
    renderPanel({ state: 'closed', isClosed: true }, { isLoading: true });
    expect(screen.getByRole('button', { name: /reopen/i })).toBeDisabled();
  });

  it('renders nothing for a merged PR', () => {
    const { container } = renderPanel({ state: 'merged', isMerged: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when readOnly', () => {
    const { container } = renderPanel({}, { readOnly: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('Close uses a two-step inline confirm: first click morphs, Confirm invokes', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    // morph: prompt + Cancel + Confirm close; siblings disabled
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /confirm close/i }));
    // onInvoke now forwards an optional merge payload; for non-merge kinds it's undefined.
    expect(invoke).toHaveBeenCalledWith('close', undefined);
  });

  it('Escape cancels the Close confirm', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('non-Close actions invoke immediately (no confirm)', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /convert to draft/i }));
    expect(invoke).toHaveBeenCalledWith('convert-to-draft', undefined);
  });

  it('an external state change to closed clears an open Close confirm', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const open = makePrDetailDto({
      pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }),
    });
    render(<Harness initial={{ prDetail: open }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    // peer closes the PR → context prDetail flips to closed
    const closed = makePrDetailDto({
      pr: makePr({ state: 'closed', isClosed: true, isDraft: false, isMerged: false }),
    });
    act(() => ctl.current!.set({ prDetail: closed }));
    await waitFor(() => expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument());
  });

  it('renders nothing during cold load (no prDetail)', () => {
    // Plan ce-doc-review round 2 (feasibility): PrDetailContextValue.prDetail is typed non-null
    // (PrDetailDto), so `{ prDetail: null }` is a TS2322 under `tsc -b`. The Partial override makes
    // it `PrDetailDto | undefined`; use undefined. (The panel's `prDetail?.pr` guard is defensive —
    // the real provider always supplies prDetail since OverviewTab mounts only under loaded data.)
    const { container } = renderWithPrDetailContext(<PrActionsPanel />, { prDetail: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it('Close confirm moves focus to Cancel and exposes a status live-region', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
    // live region, NOT a dialog role (inline morph, no focus trap):
    expect(screen.getByRole('status')).toHaveTextContent(/close this pr\?/i);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a click outside the panel dismisses the Close confirm', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const open = makePrDetailDto({
      pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }),
    });
    render(<Harness initial={{ prDetail: open }} ctl={ctl} />); // Harness mounts an "outside" button beside the panel
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /outside/i }));
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
  });

  it('Escape cancels the Close confirm with focus anywhere and refocuses Close (#705)', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const open = makePrDetailDto({
      pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }),
    });
    render(<Harness initial={{ prDetail: open }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    // Park focus OUTSIDE the panel without a pointerdown (which would dismiss).
    act(() => screen.getByRole('button', { name: /outside/i }).focus());
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
    // The hook's deferred focus return lands on the (remounted) Close trigger.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^close$/i })).toHaveFocus(),
    );
  });

  it('the plain Close button shows the pending label while a close is in flight', () => {
    pending = 'close';
    renderPanel({});
    expect(screen.getByRole('button', { name: /closing…/i })).toBeInTheDocument();
  });

  it('a failed close clears the confirm back to the plain Close button', async () => {
    const user = userEvent.setup();
    // invoke('close') is mocked; the panel pre-clears confirm on Confirm-click, so after a
    // failure the confirm is already gone and the plain Close button is present.
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.click(screen.getByRole('button', { name: /confirm close/i }));
    expect(invoke).toHaveBeenCalledWith('close', undefined);
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('keeps focus inside the panel when the action set swaps after an action (no fall to body)', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const openNonDraft = makePrDetailDto({
      pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }),
    });
    render(<Harness initial={{ prDetail: openNonDraft }} ctl={ctl} />);
    // Click Convert-to-draft → onInvoke parks focus on the panel container (invoke is mocked, no POST).
    await user.click(screen.getByRole('button', { name: /convert to draft/i }));
    // The action's reconcile reload swaps the PR to draft → the set changes (Convert → Mark-ready),
    // removing the button that was clicked. Round-2 findings A2/D2: focus must NOT fall to <body>.
    const openDraft = makePrDetailDto({
      pr: makePr({ state: 'open', isClosed: false, isDraft: true, isMerged: false }),
    });
    act(() => ctl.current!.set({ prDetail: openDraft }));
    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole('group', { name: /pr actions/i })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  // ── Slice 2: Merge affordance ───────────────────────────────────────────────────────────────

  it('shows Merge enabled when ready (Step 1)', () => {
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeEnabled();
  });

  it('disables Merge with a reason on conflicts (Step 1)', () => {
    renderPanel({ mergeReadiness: 'conflicts' });
    const btn = screen.getByRole('button', { name: /^merge$/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/conflict/i);
  });

  it('shows the calculating reason + Refresh link in the none state', () => {
    renderPanel({ mergeReadiness: 'none' });
    const btn = screen.getByRole('button', { name: /^merge$/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/still being calculated/i);
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  // C-fix (#566 live-validation): a disabled badge readiness surfaces its reason through a
  // hover/focus ReadinessBadge popover (the same component as the PR-detail header) instead of an
  // inline sentence that pushed the Merge button out of the action row. The button keeps its
  // accessible description via an sr-only #merge-reason span (so the conflicts test above still
  // holds), and the visible reason is the badge popover, not displacing text.
  it('renders a hover readiness badge (not displacing inline text) for a disabled badge state', () => {
    renderPanel({ mergeReadiness: 'conflicts' });
    // The readiness badge trigger is present beside the Merge button (its hover popover is the reason).
    expect(screen.getByRole('button', { name: /merge readiness: conflicts/i })).toBeInTheDocument();
    // The describedby sentence is kept for AT but is visually hidden (no layout displacement).
    expect(document.querySelector('[id^="merge-reason"]')).toHaveClass('sr-only');
  });

  // B-fix (#566 live-validation): the in-panel Refresh must force a cache-bypassing backend re-read
  // (POST /…/refresh → PrDetailLoader.RefreshAsync), not the cache-first reload() — otherwise a
  // snapshot cached as `None` during GitHub's lazy-mergeability window can never change (#655).
  it('Refresh forces a cache-bypassing backend re-read (refreshPrDetail), not just reload', async () => {
    const user = userEvent.setup();
    renderPanel({ mergeReadiness: 'none' });
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    expect(refreshPrDetail).toHaveBeenCalledTimes(1);
  });

  it('arming reveals the picker and a method-named Confirm; confirm calls invoke(merge) (Step 4)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      headSha: 'abc',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /confirm merge commit/i }));
    expect(invoke).toHaveBeenCalledWith('merge', { method: 'merge', headSha: 'abc' });
  });

  it('the Confirm click does NOT collapse the morph (in-flight labels can paint)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await user.click(screen.getByRole('button', { name: /confirm merge commit/i }));
    // invoke is mocked (no state change) → the armed morph stays mounted: the picker + a Confirm
    // button are still present. If the click had set confirmingMerge=false the morph would unmount.
    expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm merge commit/i })).toBeInTheDocument();
  });

  it('Confirm shows Merging…/Checking… from pending/mergePhase while the morph stays armed', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const ready = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'ready',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
        headSha: 'abc',
      }),
    });
    render(<Harness initial={{ prDetail: ready }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await user.click(screen.getByRole('button', { name: /confirm merge commit/i }));
    // The hook enters the in-flight state; the morph is still armed so the Confirm button swaps to
    // the live label. Force a re-render (the mock reads module-level pending/mergePhase per render).
    pending = 'merge';
    mergePhase = 'merging';
    act(() => ctl.current!.set({}));
    expect(screen.getByRole('button', { name: /merging…/i })).toBeInTheDocument();
    // checking phase (post-422 re-check) wins over the merging label.
    mergePhase = 'checking';
    act(() => ctl.current!.set({}));
    expect(screen.getByRole('button', { name: /checking…/i })).toBeInTheDocument();
  });

  it('Escape cancels the merge confirm morph', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('radiogroup', { name: /merge method/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
  });

  it('arming a multi-method merge moves focus to the default-selected radio (§4a transition 1)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.getByRole('radio', { name: /merge commit/i })).toHaveFocus();
  });

  it('arming a single-method merge moves focus to the Confirm button (§4a transition 1)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: false, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    // single method → picker renders null, no radiogroup
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm merge commit/i })).toHaveFocus();
  });

  it('links the unstable note to the Confirm button via aria-describedby', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'unstable',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(
      screen.getByRole('button', { name: /confirm merge commit/i }),
    ).toHaveAccessibleDescription(/non-required checks/i);
  });

  it('Refresh focuses the now-enabled Merge button only after a Refresh-triggered readiness change (§4a transition 3)', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const calculating = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'none',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    render(<Harness initial={{ prDetail: calculating }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    // reload() resolves → readiness moves off 'none'. The reason block unmounts; focus lands on
    // the now-enabled Merge button.
    const ready = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'ready',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    act(() => ctl.current!.set({ prDetail: ready }));
    expect(screen.getByRole('button', { name: /^merge$/i })).toHaveFocus();
  });

  it('does NOT steal focus on an unrelated (non-Refresh) readiness change', () => {
    const ctl: { current: Ctl | null } = { current: null };
    const calculating = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'none',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    render(<Harness initial={{ prDetail: calculating }} ctl={ctl} />);
    // No Refresh click — an SSE-driven readiness change must not move focus.
    const ready = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'ready',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    act(() => ctl.current!.set({ prDetail: ready }));
    expect(screen.getByRole('button', { name: /^merge$/i })).not.toHaveFocus();
  });

  it('arming merge HIDES the sibling actions — the merge flow is a focused sub-mode (E1)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.queryByRole('button', { name: /convert to draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('the merge flow has a Back control that exits without merging (E2)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await user.click(screen.getByRole('button', { name: /back/i }));
    // Morph collapses; the normal action set returns; no merge fired.
    expect(screen.queryByRole('radiogroup', { name: /merge method/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('the Confirm-merge button uses the merge hue, not danger red (E4)', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: false, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.getByRole('button', { name: /confirm merge commit/i })).not.toHaveClass(
      'btn-danger',
    );
  });

  it('does not render Merge for a draft PR', () => {
    renderPanel({ isDraft: true, mergeReadiness: 'ready' });
    expect(screen.queryByRole('button', { name: /^merge$/i })).not.toBeInTheDocument();
  });

  // ── Task 6 (#655 C1): panel consumes live readiness feed ───────────────────────────────────────

  it('uses live readiness over the snapshot seed', () => {
    // Snapshot says 'none' (still calculating) but the SSE feed resolved to 'ready'.
    // The panel must prefer the live value → Merge button must be enabled.
    renderPanel({ mergeReadiness: 'none' }, { liveMergeReadiness: 'ready' });
    expect(screen.getByRole('button', { name: /^merge$/i })).toBeEnabled();
  });

  it('falls back to the snapshot when no live value yet', () => {
    // No SSE update has arrived yet (liveMergeReadiness === undefined). Panel must
    // fall back to the snapshot value ('none') and show the calculating message.
    renderPanel({ mergeReadiness: 'none' }, { liveMergeReadiness: undefined });
    expect(screen.getByText(/still being calculated/i)).toBeInTheDocument();
  });

  // FIX 1: Refresh → disabled readiness must not drop focus to <body>
  it('Refresh resolves to a disabled readiness → focus lands on reason span, not body (§4a transition 3 disabled)', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const calculating = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'none',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    render(<Harness initial={{ prDetail: calculating }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    // reload() resolves → readiness moves to 'conflicts' (a disabled state). Focus must NOT fall to
    // <body> — it should land on the #merge-reason span which explains why merge is unavailable.
    const conflicts = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'conflicts',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
      }),
    });
    act(() => ctl.current!.set({ prDetail: conflicts }));
    expect(document.body).not.toHaveFocus();
    // The panel container must hold the active element (focus-stays-in-panel invariant).
    expect(screen.getByRole('group', { name: /pr actions/i })).toContainElement(
      document.activeElement as HTMLElement,
    );
    // Specifically the #merge-reason span, not the disabled Merge button.
    expect(document.querySelector('[id^="merge-reason"]')).toHaveFocus();
  });

  // FIX 2: sr-only merge-confirm prompt
  it('arming the merge morph announces a prompt in the sr-only live region', async () => {
    const user = userEvent.setup();
    renderPanel({
      mergeReadiness: 'ready',
      allowedMergeMethods: { merge: true, squash: true, rebase: false },
    });
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    expect(screen.getByRole('status')).toHaveTextContent(/confirm merge\?/i);
  });

  // FIX 3 (round-2 finding D3 regression): once pending='merge', PENDING_ANNOUNCE['merge'] must
  // win over the confirmingMerge branch in the live region. Before this fix, confirmingMerge was
  // always true during the write (morph stays mounted), so the progress announce was unreachable.
  it('once merge is in flight (pending=merge), the sr-only live region announces progress, not the confirm prompt', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const ready = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isClosed: false,
        isDraft: false,
        isMerged: false,
        mergeReadiness: 'ready',
        allowedMergeMethods: { merge: true, squash: true, rebase: false },
        headSha: 'abc',
      }),
    });
    render(<Harness initial={{ prDetail: ready }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    // Armed but not confirmed: confirm prompt should be live.
    expect(screen.getByRole('status')).toHaveTextContent(/confirm merge\?/i);
    await user.click(screen.getByRole('button', { name: /confirm merge commit/i }));
    // Simulate the hook entering the in-flight state (morph stays mounted, confirmingMerge=true).
    pending = 'merge';
    act(() => ctl.current!.set({}));
    // In-flight: progress announce must take precedence over the confirm prompt.
    expect(screen.getByRole('status')).toHaveTextContent(/merging pull request/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/confirm merge\?/i);
  });
});

// ── Task 7 (#655 C1): announce auto-resolve + Refresh-focus preservation ───────────────────────

describe('PrActionsPanel — auto-resolve announce + Refresh focus (Task 7)', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(refreshPrDetail).mockClear();
    pending = null;
    mergePhase = 'idle';
  });

  // Local helpers that support snapshotReadiness + liveMergeReadiness independently.
  function panel({
    snapshotReadiness,
    liveMergeReadiness,
  }: {
    snapshotReadiness: MergeReadiness;
    liveMergeReadiness: MergeReadiness | undefined;
  }) {
    const prDetail = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isDraft: false,
        isClosed: false,
        isMerged: false,
        mergeReadiness: snapshotReadiness,
        allowedMergeMethods: { merge: true, squash: true, rebase: true },
        headSha: 'headsha',
      }),
    });
    return (
      <PrDetailContextProvider value={makePrDetailContextValue({ prDetail, liveMergeReadiness })}>
        <PrActionsPanel />
      </PrDetailContextProvider>
    );
  }

  function renderPanel(opts: {
    snapshotReadiness: MergeReadiness;
    liveMergeReadiness: MergeReadiness | undefined;
  }) {
    return render(panel(opts));
  }

  it('announces ready-to-merge on auto-resolve none -> ready', async () => {
    const { rerender } = renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: undefined });
    rerender(panel({ snapshotReadiness: 'none', liveMergeReadiness: 'ready' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/ready to merge/i);
  });

  it('does NOT re-announce when navigating back to an already-ready PR', () => {
    // effective readiness starts at 'ready' (snapshot seed), then a re-emit sets live 'ready'
    const { rerender } = renderPanel({ snapshotReadiness: 'ready', liveMergeReadiness: undefined });
    rerender(panel({ snapshotReadiness: 'ready', liveMergeReadiness: 'ready' }));
    expect(screen.getByRole('status')).toHaveTextContent(''); // no announcement
  });

  it('moves focus off the Refresh button when readiness auto-resolves', async () => {
    const { rerender } = renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: undefined });
    screen.getByRole('button', { name: /refresh/i }).focus();
    rerender(panel({ snapshotReadiness: 'none', liveMergeReadiness: 'ready' }));
    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole('button', { name: /merge/i })).toHaveFocus();
  });
});
