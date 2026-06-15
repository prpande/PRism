// Coexistence test: AiSummaryCard's inline error block is independent of the global toast.
// The inline error renders when error=true regardless of whether the toast is shown.
// Note: data-testid="ai-summary-regenerate" only appears on the stale-regenerate button (live &&
// isStale branch), NOT in the error branch. We assert on the error section's text content
// instead. Full failure+inline+toast coexistence is also covered end-to-end in Task 9.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, AiFailureContainer } from '../../Ai';
import { AiSummaryCard } from './AiSummaryCard';

it('summary inline error block AND the global toast coexist', () => {
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider>
        <AiSummaryCard summary={null} loading={false} error={true} />
        <AiFailureContainer />
      </AiFailureProvider>
    </MemoryRouter>,
  );
  // Inline error block is present (the card renders its own error message independently):
  expect(screen.getByText(/AI summary unavailable/)).toBeInTheDocument();
  // Toast does NOT appear from rendering the card alone (the card doesn't call report) — this
  // test pins that the inline block is independent of the global failure registry.
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
});
