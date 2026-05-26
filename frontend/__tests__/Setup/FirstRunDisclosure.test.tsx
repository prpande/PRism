import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { FirstRunDisclosure } from '../../src/components/Setup/FirstRunDisclosure';

describe('FirstRunDisclosure', () => {
  // navigator.platform is what `detectPlatform()` consumes (spec § 14 OQ 1
  // resolution: single-source). Save the original descriptor so each test can
  // poke a different value without leaking across tests in the suite.
  const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
  afterEach(() => {
    if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform);
  });

  it('renders the Windows block on Win32', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/SmartScreen/i)).toBeInTheDocument();
    expect(screen.queryByText(/Gatekeeper/i)).not.toBeInTheDocument();
  });

  it('renders the macOS block on MacIntel', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/Gatekeeper/i)).toBeInTheDocument();
    expect(screen.queryByText(/SmartScreen/i)).not.toBeInTheDocument();
  });

  it('renders both blocks on unknown platform (graceful degradation)', () => {
    // Spec § 14 OQ 1: when navigator.platform is empty or unrecognized, render
    // both blocks rather than silently hiding the trust copy. A missing
    // userAgentData probe degrades to "show both", not to omission.
    Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/SmartScreen/i)).toBeInTheDocument();
    expect(screen.getByText(/Gatekeeper/i)).toBeInTheDocument();
  });

  it('defaults to closed (the <details> summary is the visible affordance)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const { container } = render(<FirstRunDisclosure />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText(/first run on this machine/i)).toBeInTheDocument();
  });
});
