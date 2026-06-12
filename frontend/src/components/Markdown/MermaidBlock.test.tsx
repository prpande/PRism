import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Override the global success mock (__tests__/setup-mermaid.ts) for THIS file:
// simulate the dynamic `import('mermaid')` chunk failing to load (offline / CSP).
// Pre-#330 that rejection was unhandled — no `.catch` — so the block hung on
// "Loading diagram…" forever and leaked an unhandled promise rejection.
vi.mock('mermaid', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { MermaidBlock } from './MermaidBlock';

describe('MermaidBlock chunk-load failure (#330)', () => {
  it('renders the error fallback instead of hanging on "Loading diagram…"', async () => {
    render(<MermaidBlock code={'graph TD; A-->B'} />);
    await waitFor(() => expect(screen.getByText('Mermaid render failed')).toBeInTheDocument());
    // The perpetual loading placeholder is gone...
    expect(screen.queryByText(/Loading diagram/)).not.toBeInTheDocument();
    // ...and the source is preserved in the fallback for the user to read.
    expect(screen.getByText(/graph TD/)).toBeInTheDocument();
  });
});
