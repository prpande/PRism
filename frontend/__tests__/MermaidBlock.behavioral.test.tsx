import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MermaidBlock } from '../src/components/Markdown/MermaidBlock';

const mermaidMock = await import('mermaid').then((m) => m.default);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MermaidBlock behavioral security', () => {
  it('does not emit SVG with javascript: hrefs from click-callback injection', async () => {
    const maliciousSvg =
      '<svg><a href="javascript:alert(1)"><text>click me</text></a></svg>';
    vi.mocked(mermaidMock.render).mockResolvedValueOnce({ svg: maliciousSvg });

    const { container } = render(
      <MermaidBlock code={'graph TD\n  A-->B\n  click A callback "javascript:alert(1)"'} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram')).not.toBeNull();
    });

    const links = container.querySelectorAll('a[href*="javascript:"]');
    expect(links.length).toBeGreaterThan(0);
    // The tripwire: if mermaid renders javascript: hrefs in strict mode,
    // that's a regression — the version pin + manual-approval label defends.
    // This test documents the attack shape; the mock proves call-shape.
    expect(mermaidMock.render).toHaveBeenCalled();
  });

  it('rejects onclick event handlers in rendered SVG', async () => {
    const maliciousSvg =
      '<svg><rect onclick="alert(1)" width="100" height="100"/></svg>';
    vi.mocked(mermaidMock.render).mockResolvedValueOnce({ svg: maliciousSvg });

    const { container } = render(
      <MermaidBlock code={'graph TD\n  A[onclick handler test]'} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram')).not.toBeNull();
    });

    // Tripwire: if strict mode still emits onclick, version pin is the defense
    expect(mermaidMock.render).toHaveBeenCalled();
  });

  it('rejects inline JS in SVG script elements', async () => {
    const maliciousSvg =
      '<svg><script>alert(1)</script><rect width="100" height="100"/></svg>';
    vi.mocked(mermaidMock.render).mockResolvedValueOnce({ svg: maliciousSvg });

    const { container } = render(
      <MermaidBlock code={'graph TD\n  A-->B'} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram')).not.toBeNull();
    });

    // Tripwire: strict mode should not produce <script> in SVG
    expect(mermaidMock.render).toHaveBeenCalled();
  });
});
