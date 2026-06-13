import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrDetailContextProvider, usePrDetailContext } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';

function Probe() {
  const ctx = usePrDetailContext();
  return (
    <div>
      {ctx.prRef.owner}/{ctx.prRef.repo}#{ctx.prRef.number}
    </div>
  );
}

test('provides prRef + session to children', () => {
  const value = {
    prRef: { owner: 'acme', repo: 'api', number: 7 },
    prDetail: {} as PrDetailContextValue['prDetail'],
    draftSession: {} as PrDetailContextValue['draftSession'],
    readOnly: false,
    subscribed: false,
    baseShaChanged: false,
    onSelectSubTab: vi.fn(),
  } satisfies PrDetailContextValue;
  render(
    <PrDetailContextProvider value={value}>
      <Probe />
    </PrDetailContextProvider>,
  );
  expect(screen.getByText('acme/api#7')).toBeInTheDocument();
});

test('throws when used outside the provider', () => {
  expect(() => render(<Probe />)).toThrow(/usePrDetailContext must be used inside/);
});
