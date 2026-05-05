import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import '../src/styles/tokens.css';

describe('tokens', () => {
  it('exposes accent CSS variables on :root for indigo by default', () => {
    render(<div data-testid="probe" />);
    const styles = getComputedStyle(document.documentElement);
    expect(styles.getPropertyValue('--accent-h').trim()).toBeTruthy();
    expect(styles.getPropertyValue('--accent-c').trim()).toBeTruthy();
  });
});
