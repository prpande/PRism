import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';
import { applyFormatting } from './applyFormatting';
import { ICONS } from './formattingIcons';
import { useFormattingShortcuts } from './useFormattingShortcuts';

interface ButtonDef {
  action: FormatAction;
  label: string;
  shortcut?: string;
  group: number; // 0 = wrap, 1 = code/link, 2 = line-prefix
}

// Display order (grouped wrap · code/link · line-prefix).
export const TOOLBAR_BUTTONS: ButtonDef[] = [
  { action: 'bold', label: 'Bold', shortcut: 'B', group: 0 },
  { action: 'italic', label: 'Italic', shortcut: 'I', group: 0 },
  { action: 'strikethrough', label: 'Strikethrough', group: 0 },
  { action: 'code', label: 'Code', shortcut: 'E', group: 1 },
  { action: 'link', label: 'Link', shortcut: 'K', group: 1 },
  { action: 'heading', label: 'Heading', group: 2 },
  { action: 'quote', label: 'Quote', group: 2 },
  { action: 'bulleted', label: 'Bulleted list', group: 2 },
  { action: 'numbered', label: 'Numbered list', group: 2 },
  { action: 'task', label: 'Task list', group: 2 },
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

export function buttonTitle(def: ButtonDef): string {
  return def.shortcut ? `${def.label} (${MOD}+${def.shortcut})` : def.label;
}

export function FormattingToolbar({ handle }: { handle: FormattingHandle }) {
  const { textareaRef, previewMode, onTogglePreview, disabled } = handle;

  // Shared apply path: engine edit -> DOM -> onChange -> caret, then re-assert
  // the caret after React commits via a layout effect keyed on this token.
  // Note: on the real Chromium/Electron execCommand path the native input event
  // ALSO fires the controlled textarea's onChange, so setBody runs twice with the
  // same value (idempotent). React then re-renders the controlled value over the
  // selection; the useLayoutEffect below restores the caret before paint.
  const pendingCaret = useRef<{ start: number; end: number } | null>(null);
  const [caretToken, setCaretToken] = useState(0);

  const runAction = useCallback(
    (action: FormatAction) => {
      const ta = textareaRef.current;
      if (!ta || disabled) return;
      const sel = applyFormatting(ta, action, handle.onChange);
      pendingCaret.current = { start: sel.selectionStart, end: sel.selectionEnd };
      setCaretToken((t) => t + 1);
    },
    [textareaRef, disabled, handle],
  );

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta && pendingCaret.current) {
      ta.setSelectionRange(pendingCaret.current.start, pendingCaret.current.end);
      ta.focus();
      pendingCaret.current = null;
    }
  }, [caretToken, textareaRef]);

  // Roving tabindex across the two view-switch buttons so the Write | Preview
  // control is a SINGLE tab stop (spec §Accessibility). Arrow/Home/End move focus
  // between the two; activation (click/Enter/Space) switches the view.
  const viewBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [viewFocusIndex, setViewFocusIndex] = useState(previewMode ? 1 : 0);

  const onViewSwitchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'End') {
      e.preventDefault();
      setViewFocusIndex(1);
      viewBtnRefs.current[1]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'Home') {
      e.preventDefault();
      setViewFocusIndex(0);
      viewBtnRefs.current[0]?.focus();
    }
  };

  // Focus flow across the view switch: entering Preview parks focus on the
  // Preview button (the textarea is about to unmount); returning to Write parks
  // focus back on the textarea so the user resumes typing. Also realign the
  // roving stop to the active view so Tab lands on the button that reflects it.
  const prevPreview = useRef(previewMode);
  useEffect(() => {
    if (prevPreview.current !== previewMode) {
      setViewFocusIndex(previewMode ? 1 : 0);
      if (previewMode) viewBtnRefs.current[1]?.focus();
      else textareaRef.current?.focus();
      prevPreview.current = previewMode;
    }
  }, [previewMode, textareaRef]);

  // Roving tabindex across the format buttons.
  const [activeIndex, setActiveIndex] = useState(0);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = TOOLBAR_BUTTONS.length;

  const focusIndex = (i: number) => {
    const clamped = Math.max(0, Math.min(count - 1, i));
    setActiveIndex(clamped);
    btnRefs.current[clamped]?.focus();
  };

  const onToolbarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusIndex(activeIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusIndex(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusIndex(count - 1);
    }
  };

  // Always called (rules of hooks): the toolbar strip is always mounted even in
  // preview, so shortcuts stay active in edit mode; the hook no-ops when the
  // textarea ref is null and rebinds on the preview round-trip.
  useFormattingShortcuts(handle, runAction);

  return (
    <div className="formatting-strip">
      <div
        className="composer-view-switch"
        role="group"
        aria-label="Editor view"
        onKeyDown={onViewSwitchKeyDown}
      >
        <button
          ref={(el) => {
            viewBtnRefs.current[0] = el;
          }}
          type="button"
          className="composer-view-switch-btn"
          aria-pressed={!previewMode}
          tabIndex={viewFocusIndex === 0 ? 0 : -1}
          onFocus={() => setViewFocusIndex(0)}
          onClick={() => {
            if (previewMode) onTogglePreview();
          }}
        >
          Write
        </button>
        <button
          ref={(el) => {
            viewBtnRefs.current[1] = el;
          }}
          type="button"
          className="composer-view-switch-btn"
          aria-pressed={previewMode}
          tabIndex={viewFocusIndex === 1 ? 0 : -1}
          onFocus={() => setViewFocusIndex(1)}
          onClick={() => {
            if (!previewMode) onTogglePreview();
          }}
        >
          Preview
        </button>
      </div>

      {!previewMode && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="formatting-toolbar"
          onKeyDown={onToolbarKeyDown}
        >
          {TOOLBAR_BUTTONS.map((def, i) => {
            const Icon = ICONS[def.action];
            const prevGroup = i > 0 ? TOOLBAR_BUTTONS[i - 1].group : def.group;
            return (
              <span key={def.action} style={{ display: 'contents' }}>
                {def.group !== prevGroup && (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    className="formatting-toolbar-sep"
                  />
                )}
                <button
                  ref={(el) => {
                    btnRefs.current[i] = el;
                  }}
                  type="button"
                  className="formatting-toolbar-btn"
                  aria-label={buttonTitle(def)}
                  title={buttonTitle(def)}
                  tabIndex={i === activeIndex ? 0 : -1}
                  disabled={disabled}
                  aria-disabled={disabled || undefined}
                  onFocus={() => setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAction(def.action)}
                >
                  <Icon />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
