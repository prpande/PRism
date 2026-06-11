import { Modal } from '../../Modal/Modal';

export interface ComposerModalsProps {
  discardModalOpen: boolean;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  recoveryModalOpen: boolean;
  onRecoveryCancel: () => void;
  onRecoveryRecreate: () => void;
  onRecoveryDiscard: () => void;
  discardBody: string;
  recoveryTitle: string;
  recoveryBody: string;
}

export function ComposerModals({
  discardModalOpen,
  onDiscardCancel,
  onDiscardConfirm,
  recoveryModalOpen,
  onRecoveryCancel,
  onRecoveryRecreate,
  onRecoveryDiscard,
  discardBody,
  recoveryTitle,
  recoveryBody,
}: ComposerModalsProps) {
  return (
    <>
      <Modal open={discardModalOpen} title="Discard saved draft?" defaultFocus="cancel" onClose={onDiscardCancel}>
        <p>{discardBody}</p>
        <button type="button" data-modal-role="cancel" onClick={onDiscardCancel}>
          Cancel
        </button>
        <button type="button" data-modal-role="primary" onClick={onDiscardConfirm}>
          Discard
        </button>
      </Modal>

      <Modal
        open={recoveryModalOpen}
        title={recoveryTitle}
        defaultFocus="primary"
        disableEscDismiss
        onClose={onRecoveryCancel}
      >
        <p>{recoveryBody}</p>
        <button type="button" data-modal-role="cancel" onClick={onRecoveryDiscard}>
          Discard
        </button>
        <button type="button" data-modal-role="primary" onClick={onRecoveryRecreate}>
          Re-create
        </button>
      </Modal>
    </>
  );
}
