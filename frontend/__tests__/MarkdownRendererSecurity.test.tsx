import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MarkdownRenderer } from '../src/components/Markdown/MarkdownRenderer';
import { ComposerMarkdownPreview } from '../src/components/PrDetail/Composer/ComposerMarkdownPreview';
import { AiSummaryCard } from '../src/components/PrDetail/OverviewTab/AiSummaryCard';

vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: 'preview' } } }),
}));

// Spec § 5.6: every render site for `bodyMarkdown` (composer preview,
// DraftListItem body preview, StaleDraftRow body display, DiscardAllStale
// confirm modal preview) MUST route through the shared MarkdownRenderer.
// This test parameterizes the security contract over each consumer wrapper
// so a future "raw textarea body" or "innerHTML hot-fix" regression is
// caught against EVERY consumer, not just the renderer itself.
//
// The fixture grows as PR4-PR6 land their consumers:
//   PR4 Task 38: MarkdownRenderer (baseline).
//   PR4 Task 39 (this commit): + ComposerMarkdownPreview.
//   PR6 Tasks 43 + 44: + DraftListItem.preview, StaleDraftRow.body,
//                       DiscardAllStaleButton.modalPreview.
const CONSUMERS: { name: string; render: (md: string) => ReactElement }[] = [
  { name: 'MarkdownRenderer', render: (md) => <MarkdownRenderer source={md} /> },
  { name: 'ComposerMarkdownPreview', render: (md) => <ComposerMarkdownPreview body={md} /> },
  {
    name: 'AiSummaryCard',
    render: (md: string) => (
      <AiSummaryCard summary={{ body: md, category: 'fix' }} loading={false} error={false} />
    ),
  },
];

describe.each(CONSUMERS)('$name — security contract (spec § 5.6)', ({ render: renderConsumer }) => {
  it('JavascriptUrl_RendersAsEscapedText_NotHref', () => {
    render(renderConsumer('[click](javascript:alert(1))'));
    const offending = document.querySelector('a[href*="javascript:"]');
    expect(offending).toBeNull();
  });

  it('RawHtmlScriptTag_StrippedFromOutput', () => {
    render(renderConsumer('<script>alert(1)</script>'));
    expect(document.querySelector('script')).toBeNull();
  });

  it('RawHtmlIframe_StrippedFromOutput', () => {
    render(renderConsumer('<iframe src="https://evil.com"></iframe>'));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('JavascriptUrlObfuscated_StillStripped', () => {
    render(renderConsumer('[click](&#106;avascript:alert(1))'));
    const links = document.querySelectorAll('a');
    links.forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      expect(href).not.toMatch(/javascript/i);
    });
  });

  it('DataUri_NotPermittedAsLinkHref', () => {
    render(renderConsumer('[click](data:text/html,<script>alert(1)</script>)'));
    expect(document.querySelector('a[href^="data:"]')).toBeNull();
  });

  it('FencedCodePayload_RendersAsInertText_NotElement', async () => {
    const { getHighlighterAsync } = await import('../src/components/Markdown/shikiInstance');
    await getHighlighterAsync();
    const { container } = render(
      renderConsumer('```ts\nconst x = "<img src=x onerror=alert(1)>";\n```'),
    );
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('onerror=alert(1)');
  });

  it('FencedScriptPayload_DoesNotInjectMarkup', async () => {
    const { getHighlighterAsync } = await import('../src/components/Markdown/shikiInstance');
    await getHighlighterAsync();
    const { container } = render(renderConsumer('```js\n</script><script>alert(1)\n```'));
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    expect(document.querySelector('script')).toBeNull();
  });

  it('MermaidFencePayload_RoutesToMermaidBlock_NotRenderedAsRawText', async () => {
    const { container } = render(renderConsumer('```mermaid\n<script>alert(1)</script>\n```'));
    // mocked render → inert <svg>; the loading fallback clears once the lazy
    // chunk + mocked render settle. The fence text is never live markup.
    await waitFor(() => expect(container.querySelector('.mermaid-loading')).toBeNull());
    expect(container.querySelector('.mermaid-diagram')).not.toBeNull(); // routed to MermaidBlock
    expect(document.querySelector('script')).toBeNull();
  });
});
