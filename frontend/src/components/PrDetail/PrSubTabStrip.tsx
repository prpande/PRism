import styles from './PrSubTabStrip.module.css';

export type PrTabId = 'overview' | 'files' | 'drafts';

interface PrSubTabStripProps {
  activeTab: PrTabId;
  onTabChange: (tab: PrTabId) => void;
  fileCount?: number;
  draftsCount?: number;
}

export function PrSubTabStrip({
  activeTab,
  onTabChange,
  fileCount,
  draftsCount,
}: PrSubTabStripProps) {
  return (
    <div role="tablist" className={styles.prTabs}>
      <Tab
        id="overview"
        label="Overview"
        active={activeTab === 'overview'}
        onSelect={onTabChange}
      />
      <Tab
        id="files"
        label="Files"
        active={activeTab === 'files'}
        onSelect={onTabChange}
        count={fileCount}
      />
      <Tab
        id="drafts"
        label="Drafts"
        active={activeTab === 'drafts'}
        onSelect={onTabChange}
        count={draftsCount}
      />
    </div>
  );
}

interface TabProps {
  id: PrTabId;
  label: string;
  active: boolean;
  onSelect: (tab: PrTabId) => void;
  disabled?: boolean;
  count?: number;
}

function Tab({ id, label, active, onSelect, disabled, count }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={[styles.prTab, active && styles.isActive, disabled && styles.isDisabled].filter(Boolean).join(' ')}
      data-testid={`pr-tab-${id}`}
      onClick={() => {
        if (!disabled) onSelect(id);
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <>
          <span className={styles.prTabCount} data-testid="pr-tab-count" aria-hidden="true">
            {count}
          </span>
          {/* SR companion so the tab announces "Files, 3 items" rather than
              "Files 3". Spec § 6.1 Pass 2 ("badge labels in words"). */}
          <span className="sr-only">{`, ${count} ${count === 1 ? 'item' : 'items'}`}</span>
        </>
      )}
    </button>
  );
}
