import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { FirstRunDisclosure } from '../../src/components/Setup/FirstRunDisclosure';

describe('FirstRunDisclosure', () => {
  // navigator.platform is what `detectPlatform()` consumes (spec § 14 OQ 1
  // resolution: single-source). jsdom defines `platform` on Navigator.prototype,
  // not on the instance, so there is no own-property descriptor to save and
  // restore — `getOwnPropertyDescriptor(navigator, 'platform')` is `undefined`.
  // Each test installs an own-property override; afterEach deletes it so
  // subsequent reads fall through to the prototype again. Vitest's per-file
  // jsdom isolation contains anything that escapes.
  afterEach(() => {
    delete (navigator as { platform?: string }).platform;
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

  it('renders both blocks on a non-empty unrecognized platform (e.g., Linux)', () => {
    // Pins the "anything that is not Windows or macOS falls through to BOTH"
    // contract — protects against a future refactor that accidentally adds a
    // Linux-specific branch that hides both Windows + macOS copy.
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
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
