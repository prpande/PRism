import { it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PrRootReplyComposer } from './PrRootReplyComposer';

// PrRootBodyEditor's autosave hook hits the network on mount; stub the editor
// to a thin shell that still renders a badge IF showBadge is not suppressed,
// so this test asserts the composer's own footer badge is the only one.
vi.mock('./PrRootBodyEditor', () => ({
  PrRootBodyEditor: (props: { showBadge?: boolean }) => (
    <div data-testid="editor-stub">
      {props.showBadge !== false && (
        <span className="composer-badge composer-badge--saved" data-testid="composer-badge">
          Saved
        </span>
      )}
    </div>
  ),
}));
// AiComposerAssistant renders in the actions row and pulls AI context; stub it
// so the composer renders standalone in jsdom.
vi.mock('../../Ai/AiComposerAssistant', () => ({
  AiComposerAssistant: () => null,
}));

const prRef = { owner: 'acme', repo: 'api', number: 123 };

it('renders exactly one composer-badge (footer only) on the Overview composer', () => {
  render(
    <PrRootReplyComposer
      prRef={prRef}
      prState="open"
      draftId={null}
      onDraftIdChange={() => {}}
      registerOpenComposer={() => () => {}}
      onClose={() => {}}
    />,
  );
  expect(screen.getAllByTestId('composer-badge')).toHaveLength(1);
});

it('shows a read-only indicator in the footer when the tab is taken over (#630)', () => {
  // readOnly suppresses the editor-stub badge (showBadge={false} is passed by the
  // composer), so the footer badge is the only one — and it must show the neutral
  // read-only indicator, not a save-state label.
  render(
    <PrRootReplyComposer
      prRef={prRef}
      prState="open"
      draftId={null}
      onDraftIdChange={() => {}}
      registerOpenComposer={() => () => {}}
      onClose={() => {}}
      readOnly
    />,
  );
  const badge = screen.getByTestId('composer-badge');
  expect(badge).toHaveTextContent('Read-only');
  expect(badge).toHaveClass('composer-badge--readonly');
});

it('wraps the composer in the shared composer-frame', () => {
  const { container } = render(
    <PrRootReplyComposer
      prRef={prRef}
      prState="open"
      draftId={null}
      onDraftIdChange={() => {}}
      registerOpenComposer={() => () => {}}
      onClose={() => {}}
    />,
  );
  expect(container.querySelector('.composer-frame')).not.toBeNull();
});

it('groups the Overview footer with a spacer in canonical order', () => {
  const { container } = render(
    <PrRootReplyComposer
      prRef={prRef}
      prState="open"
      draftId={null}
      onDraftIdChange={() => {}}
      registerOpenComposer={() => () => {}}
      onClose={() => {}}
    />,
  );
  const bar = container.querySelector('.composer-actions') as HTMLElement;
  expect(bar.querySelector('.composer-actions-spacer')).not.toBeNull();
  // AiComposerAssistant is mocked to null and the badge/spacer are spans, so the
  // button sequence in DOM (= visual) order is Preview -> Discard -> Post.
  const buttons = within(bar)
    .getAllByRole('button')
    .map((b) => b.textContent);
  expect(buttons).toEqual(['Preview', 'Discard', 'Post']);
});
