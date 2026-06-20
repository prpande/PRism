import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { useAiGate } from '../../hooks/useAiGate';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';
import { AiMarker } from '../Ai/AiMarker';
import styles from './AskAiPullTab.module.css';

export function AskAiPullTab() {
  const aiEnabled = useAiGate('composerAssist');
  const { isOpen, toggle } = useAskAiDrawer();
  const { pathname } = useEffectiveLocation();
  const onPrDetail = parsePrRefFromPathname(pathname) !== null;

  if (!aiEnabled || !onPrDetail) return null;

  const label = isOpen ? 'Close' : 'Ask AI';
  return (
    <button
      type="button"
      className={`${styles.tab} ${isOpen ? styles.open : ''}`}
      aria-label={label}
      aria-expanded={isOpen}
      data-testid="ask-ai-pull-tab"
      onClick={toggle}
    >
      <span className={styles.label}>{label}</span>
      <AiMarker variant="inline" decorative className="ai-icon" />
    </button>
  );
}
