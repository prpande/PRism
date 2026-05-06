import { PasteUrlInput } from './PasteUrlInput';
import styles from './InboxToolbar.module.css';

export function InboxToolbar() {
  return (
    <div className={styles.toolbar}>
      <PasteUrlInput />
    </div>
  );
}
