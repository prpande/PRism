import type React from 'react';

// The single surface-agnostic interface every composer satisfies. The toolbar
// depends only on this — never on useDraftComposer — which is what lets the
// bespoke PrRootReplyComposer reuse the identical component.
export interface FormattingHandle {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  previewMode: boolean;
  onTogglePreview: () => void;
  // Format-action gate: readOnly || posting (NOT previewMode). Gates the format
  // buttons AND the keyboard-shortcut path; does NOT gate Write | Preview.
  disabled: boolean;
}
