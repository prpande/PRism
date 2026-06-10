import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenInGitHubButton } from './OpenInGitHubButton';

describe('OpenInGitHubButton', () => {
  it('renders icon-only with an accessible name and no visible text', () => {
    render(<OpenInGitHubButton href="https://github.com/o/r/pull/1" />);
    const link = screen.getByRole('link', { name: 'Open in GitHub' });
    expect(link).toHaveAttribute('aria-label', 'Open in GitHub');
    expect(link).not.toHaveTextContent('Open in GitHub');
  });
  it('renders nothing without href', () => {
    const { container } = render(<OpenInGitHubButton href={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
