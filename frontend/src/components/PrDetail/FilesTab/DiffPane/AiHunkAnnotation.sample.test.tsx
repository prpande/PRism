import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HunkAnnotation } from '../../../../api/types';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { AiHunkAnnotation } from './AiHunkAnnotation';

const annotation: HunkAnnotation = {
  path: 'src/index.ts',
  hunkIndex: 0,
  body: 'Consider extracting this',
  tone: 'calm',
};

beforeEach(() => {
  mock.aiMode = 'preview';
});

describe('AiHunkAnnotation sample badge', () => {
  it('renders the badge in preview', () => {
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
  });
  it('omits the badge in off', () => {
    mock.aiMode = 'off';
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
  it('omits the badge in live', () => {
    // #414: real annotations render in Live with NO sample marker — guards the "Sample marker only in
    // Preview" contract against a future SampleBadge/useIsSampleMode refactor.
    mock.aiMode = 'live';
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
});
