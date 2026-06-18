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

describe('AiHunkAnnotation ai marker', () => {
  it('renders the AiMarker and no raw sparkle emoji', () => {
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
    expect(screen.getByTestId('ai-hunk').textContent).not.toContain('✨');
    expect(screen.getByText('AI')).toBeInTheDocument();
  });
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

describe('AiHunkAnnotation markdown body', () => {
  it('renders a bulleted body as a real list with the popover treatment', () => {
    render(
      <AiHunkAnnotation
        annotation={{ ...annotation, body: '- note one\n- note two' }}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(document.querySelector('.markdown-body.ai-markdown.ai-markdown--popover')).not.toBeNull();
  });

  it('does not render a raw <script> body as a live element (XSS)', () => {
    render(<AiHunkAnnotation annotation={{ ...annotation, body: '<script>alert(1)</script>' }} />);
    // raw HTML is dropped by react-markdown (no rehype-raw) — assert no live element.
    expect(document.querySelector('script')).toBeNull();
  });
});
