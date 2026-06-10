import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenInGitHubButton } from '../src/components/PrDetail/OpenInGitHubButton';

const HREF = 'https://github.example.com/acme/api/pull/123';

afterEach(() => {
  delete (window as unknown as { prism?: unknown }).prism;
  vi.restoreAllMocks();
});

describe('OpenInGitHubButton', () => {
  it('renders nothing when href is absent', () => {
    const { container } = render(<OpenInGitHubButton href={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an anchor with the host-correct href in the browser case', () => {
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    expect(link).toHaveAttribute('href', HREF);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveAttribute('aria-label', 'Open in GitHub');
  });

  it('intercepts the click and calls openExternal on desktop', () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { isDesktop: true, openExternal };
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(evt);
    });
    expect(openExternal).toHaveBeenCalledWith(HREF);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('does NOT intercept when isDesktop but openExternal is missing (partial build)', () => {
    (window as unknown as { prism: unknown }).prism = { isDesktop: true };
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    // Must not throw, and must NOT suppress native navigation.
    expect(() =>
      act(() => {
        link.dispatchEvent(evt);
      }),
    ).not.toThrow();
    expect(evt.defaultPrevented).toBe(false);
  });
});
