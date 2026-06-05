import { Modal } from '../Modal/Modal';
import { DangerGlyph } from './DangerGlyph';
import styles from './ErrorModal.module.css';

interface ErrorModalProps {
  open: boolean;
  /** Short headline; becomes the dialog's aria-labelledby h2. */
  title: string;
  /** Detail line (e.g. the server message). */
  message?: React.ReactNode;
  /** 1–2 buttons — the recovery action(s), rendered as the card's action row. */
  actions: React.ReactNode;
  /** Invoked by Esc when dismissible, and is the close/back action. */
  onClose: () => void;
  /**
   * Default false → Esc is suppressed (fatal error, nothing usable underneath).
   * true → Esc calls onClose (e.g. "Back to inbox").
   */
  dismissible?: boolean;
}

/**
 * Danger-styled error dialog: an `alertdialog` centered over the dimmed
 * backdrop, presenting the message and recovery action(s) as one unit. A thin
 * wrapper over the shared <Modal> — backdrop, centering, focus trap, Escape
 * handling, initial focus and focus restore all come from Modal. See #182.
 */
export function ErrorModal({
  open,
  title,
  message,
  actions,
  onClose,
  dismissible = false,
}: ErrorModalProps) {
  return (
    <Modal
      open={open}
      role="alertdialog"
      align="center"
      title={title}
      onClose={onClose}
      disableEscDismiss={!dismissible}
    >
      <div className={styles.body}>
        <DangerGlyph className={styles.glyph} />
        {message != null && <div className={styles.message}>{message}</div>}
      </div>
      <div className={styles.actions}>{actions}</div>
    </Modal>
  );
}
