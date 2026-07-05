import { useDraftComposer } from './useDraftComposer';
import { ComposerActionsBar } from './ComposerActionsBar';
import { ComposerModals } from './ComposerModals';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';
import styles from './InlineCommentComposer.module.css';
import type { DraftSide, PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import type React from 'react';

export interface InlineAnchor {
  filePath: string;
  lineNumber: number;
  side: DraftSide;
  anchoredSha: string;
  anchoredLineContent: string;
}

export interface InlineCommentComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  anchor: InlineAnchor;
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey?: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  onSaved?: () => void;
  flushRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
}

function composerAriaLabel(anchor: InlineAnchor): string {
  return `Draft comment on ${anchor.filePath} line ${anchor.lineNumber}`;
}

export function InlineCommentComposer({
  prRef,
  prState,
  anchor,
  initialBody = '',
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  ownerKey = 'files-tab',
  onClose,
  readOnly = false,
  onSaved,
  flushRef,
  anyOtherDraftsStaged = false,
  beginPosting,
  endPosting,
  onPosted,
}: InlineCommentComposerProps) {
  const { editor, actions, modals } = useDraftComposer({
    prRef,
    prState,
    initialBody,
    draftId,
    onDraftIdChange,
    registerOpenComposer,
    ownerKey,
    onClose,
    readOnly,
    onSaved,
    flushRef,
    anyOtherDraftsStaged,
    beginPosting,
    endPosting,
    onPosted,
    anchor: {
      kind: 'inline-comment',
      filePath: anchor.filePath,
      lineNumber: anchor.lineNumber,
      side: anchor.side,
      anchoredSha: anchor.anchoredSha,
      anchoredLineContent: anchor.anchoredLineContent,
    },
    deletePatchKind: 'deleteDraftComment',
  });

  const handle: FormattingHandle = {
    textareaRef: editor.textareaRef,
    value: editor.body,
    onChange: editor.setBody,
    previewMode: editor.previewMode,
    onTogglePreview: actions.onTogglePreview,
    disabled: editor.readOnly || actions.posting,
  };

  return (
    <div
      role="form"
      aria-label={composerAriaLabel(anchor)}
      data-composer="true"
      data-testid="inline-comment-composer"
      className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}
    >
      <FormattingToolbar handle={handle} />
      {editor.previewMode ? (
        <ComposerMarkdownPreview body={editor.body} />
      ) : (
        <textarea
          ref={editor.textareaRef}
          className="composer-textarea"
          value={editor.body}
          onChange={(e) => editor.setBody(e.target.value)}
          onKeyDown={editor.handleKeyDown}
          aria-label="Comment body"
          rows={4}
          // #644: lock input during a post (DOM attribute only — `posting` stays
          // off the autosave hook's `disabled` so #601 Fix A's 404 path is live).
          readOnly={editor.readOnly || actions.posting}
          aria-readonly={editor.readOnly || actions.posting || undefined}
        />
      )}
      <ComposerActionsBar {...actions} />
      <ComposerModals
        {...modals}
        discardBody="This will remove the saved draft on this line."
        recoveryTitle="Draft deleted elsewhere"
        recoveryBody="This draft was deleted from another window or by reload. Re-create it with the current text, or discard?"
      />
    </div>
  );
}
