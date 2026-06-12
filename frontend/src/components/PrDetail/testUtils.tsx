import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { PrDetailContextProvider } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';
import type { PrReference } from '../../api/types';

const DEFAULT_PR_REF: PrReference = { owner: 'acme', repo: 'api', number: 123 };

// Builds a complete PrDetailContextValue for tests that mount a sub-tab in
// isolation. Only the fields a given component reads need to be realistic;
// the rest are typed stubs. Pass overrides to set onSelectSubTab to a spy or
// supply a specific prRef / prDetail / draftSession / readOnly.
export function makePrDetailContextValue(
  overrides: Partial<PrDetailContextValue> = {},
): PrDetailContextValue {
  return {
    prRef: DEFAULT_PR_REF,
    prDetail: {} as PrDetailContextValue['prDetail'],
    draftSession: {} as PrDetailContextValue['draftSession'],
    readOnly: false,
    subscribed: false,
    baseShaChanged: false,
    onSelectSubTab: vi.fn(),
    ...overrides,
  };
}

// Renders `ui` inside a PrDetailContextProvider so sub-tab components that
// call usePrDetailContext() (OverviewTab, FilesTab, DraftsTab) work without
// the full router + Outlet harness. (StaleDraftRow no longer reads the
// context — it takes onSelectSubTab as a prop, since it's pre-load chrome.)
// Returns the testing-library result plus the resolved context value (so
// callers can assert on the onSelectSubTab spy).
export function renderWithPrDetailContext(
  ui: ReactElement,
  overrides: Partial<PrDetailContextValue> = {},
) {
  const value = makePrDetailContextValue(overrides);
  const result = render(<PrDetailContextProvider value={value}>{ui}</PrDetailContextProvider>);
  return { ...result, value };
}
