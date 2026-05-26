import { AppearanceSection } from '../components/Settings/AppearanceSection';
import { InboxSectionsSection } from '../components/Settings/InboxSectionsSection';
import { ConnectionSection } from '../components/Settings/ConnectionSection';
import { AuthSection } from '../components/Settings/AuthSection';
import styles from './SettingsPage.module.css';

export function SettingsPage() {
  return (
    <main className={styles.page}>
      <h1>Settings</h1>
      <AppearanceSection />
      <InboxSectionsSection />
      <ConnectionSection />
      <AuthSection />
    </main>
  );
}
