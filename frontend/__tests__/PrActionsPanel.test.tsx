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

const invoke = vi.fn();
let pending: string | null = null;
vi.mock('../src/hooks/usePrAction', () => ({
  usePrAction: () => ({ pending, invoke }),
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
    pending = null;
  });

  function renderPanel(prOverrides: Partial<ReturnType<typeof makePr>>, ctxOverrides = {}) {
    const prDetail = makePrDetailDto({
      pr: makePr({
        state: 'open',
        isDraft: false,
        isClosed: false,
        isMerged: false,
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
    expect(invoke).toHaveBeenCalledWith('close');
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
    expect(invoke).toHaveBeenCalledWith('convert-to-draft');
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
    expect(invoke).toHaveBeenCalledWith('close');
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
});
