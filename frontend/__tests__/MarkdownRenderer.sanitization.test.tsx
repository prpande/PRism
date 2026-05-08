import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';

describe('MarkdownRenderer sanitization', () => {
  it('renders <script> as escaped text', () => {
    render(<MarkdownRenderer source={'<script>alert(1)</script>'} />);
    expect(document.querySelector('script')).toBeNull();
  });

  it('strips javascript: autolink', () => {
    render(<MarkdownRenderer source={'[click](javascript:alert(1))'} />);
    const a = screen.queryByRole('link');
    expect(a).toBeNull();
  });

  it('strips reference-style javascript: link', () => {
    render(<MarkdownRenderer source={'[click][evil]\n\n[evil]: javascript:alert(1)'} />);
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  it('strips HTML-entity-obfuscated javascript: autolink', () => {
    render(<MarkdownRenderer source={'[click](&#106;avascript:alert(1))'} />);
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
    const links = document.querySelectorAll('a');
    links.forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      expect(href).not.toMatch(/javascript/i);
    });
  });

  it('strips data: URI in img src', () => {
    render(
      <MarkdownRenderer source={'![x](data:text/html,<script>alert(1)</script>)'} />,
    );
    const img = document.querySelector('img');
    if (img) {
      const src = img.getAttribute('src') ?? '';
      expect(src).not.toMatch(/^data:/);
    }
  });

  it('strips vbscript: link', () => {
    render(<MarkdownRenderer source={'[click](vbscript:MsgBox("xss"))'} />);
    expect(document.querySelector('a[href*="vbscript:"]')).toBeNull();
  });

  it('does not render <iframe> element', () => {
    render(
      <MarkdownRenderer source={'<iframe src="https://evil.com"></iframe>'} />,
    );
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('does not render <object> element', () => {
    render(
      <MarkdownRenderer source={'<object data="https://evil.com"></object>'} />,
    );
    expect(document.querySelector('object')).toBeNull();
  });

  it('does not render inline SVG with dangerous elements', () => {
    const svg = `<svg><use href="javascript:alert(1)"/><foreignObject><div>XSS</div></foreignObject><animate attributeName="href" values="javascript:alert(1)"/></svg>`;
    render(<MarkdownRenderer source={svg} />);
    expect(document.querySelector('svg')).toBeNull();
    expect(document.querySelector('foreignObject')).toBeNull();
    expect(document.querySelector('animate')).toBeNull();
    expect(document.querySelector('use')).toBeNull();
  });

  it('does not render <style> block or style attributes', () => {
    render(
      <MarkdownRenderer
        source={'<style>body{background:red}</style>\n\n<div style="color:red">Hi</div>'}
      />,
    );
    expect(document.querySelector('style')).toBeNull();
    const styled = document.querySelector('[style]');
    expect(styled).toBeNull();
  });

  it('strips MathML with href', () => {
    render(
      <MarkdownRenderer
        source={'<math><maction actiontype="statusline" href="javascript:alert(1)"><mtext>XSS</mtext></maction></math>'}
      />,
    );
    expect(document.querySelector('math')).toBeNull();
    expect(document.querySelector('maction')).toBeNull();
    expect(document.querySelector('[href*="javascript:"]')).toBeNull();
  });

  it('strips <base href> tag', () => {
    render(<MarkdownRenderer source={'<base href="https://evil.com/">'} />);
    expect(document.querySelector('base')).toBeNull();
  });

  it('strips <form action> tag', () => {
    render(
      <MarkdownRenderer
        source={'<form action="https://evil.com/"><input type="submit" value="Submit"></form>'}
      />,
    );
    expect(document.querySelector('form')).toBeNull();
  });

  it('does not render any raw HTML (rehype-raw not enabled)', () => {
    render(
      <MarkdownRenderer source={'<div class="custom"><span>raw</span></div>'} />,
    );
    expect(document.querySelector('div.custom')).toBeNull();
    expect(document.querySelector('span')).toBeNull();
  });
});
