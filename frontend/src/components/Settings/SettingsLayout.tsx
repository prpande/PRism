import { Outlet } from 'react-router-dom';
import { SettingsNav } from './SettingsNav';
import styles from './SettingsModal.module.css';

export function SettingsLayout() {
  return (
    <div className={styles.layout}>
      <SettingsNav />
      <div className={styles.pane}>
        <Outlet />
      </div>
    </div>
  );
}
