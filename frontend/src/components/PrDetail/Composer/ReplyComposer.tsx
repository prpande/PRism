import { useDraftComposer, type ThreadResolveControl } from './useDraftComposer';
import { ComposerActionsBar } from './ComposerActionsBar';
import { ComposerModals } from './ComposerModals';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';
import styles from './ReplyComposer.module.css';
import type { PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

export interface ReplyComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  parentThreadId: string;
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey?: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
  resolveControl?: ThreadResolveControl;
}

function replyAriaLabel(parentThreadId: string): string {
  return `Reply to thread ${parentThreadId}`;
}

export function ReplyComposer({
  prRef,
  prState,
  parentThreadId,
  initialBody = '',
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  ownerKey = 'files-tab',
  onClose,
  readOnly = false,
  anyOtherDraftsStaged = false,
  beginPosting,
  endPosting,
  onPosted,
  resolveControl,
}: ReplyComposerProps) {
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
    anyOtherDraftsStaged,
    beginPosting,
    endPosting,
    onPosted,
    anchor: { kind: 'reply', parentThreadId },
    deletePatchKind: 'deleteDraftReply',
    resolveControl,
  });

  const handle: FormattingHandle = {
    textareaRef: editor.textareaRef,
    value: editor.body,
    onChange: editor.setBody,
    previewMode: editor.previewMode,
    onTogglePreview: editor.onTogglePreview,
    disabled: editor.readOnly || actions.posting,
  };

  return (
    <div
      role="form"
      aria-label={replyAriaLabel(parentThreadId)}
      data-composer="true"
      data-testid="reply-composer"
      className={`reply-composer composer-frame ${styles.replyComposer}`}
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
          aria-label="Reply body"
          rows={3}
          // #644: lock input during a post (DOM attribute only — `posting` stays
          // off the autosave hook's `disabled` so #601 Fix A's 404 path is live).
          readOnly={editor.readOnly || actions.posting}
          aria-readonly={editor.readOnly || actions.posting || undefined}
        />
      )}
      <ComposerActionsBar {...actions} />
      <ComposerModals
        {...modals}
        discardBody="This will remove the saved reply draft on this thread."
        recoveryTitle="Draft reply deleted elsewhere"
        recoveryBody="This reply draft was deleted from another window or by reload. Re-create it with the current text, or discard?"
      />
    </div>
  );
}
