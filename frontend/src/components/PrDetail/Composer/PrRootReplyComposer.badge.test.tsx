import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
