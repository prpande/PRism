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
    <div role="tablist" className="pr-tabs">
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
      className={`pr-tab ${active ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}
      onClick={() => {
        if (!disabled) onSelect(id);
      }}
    >
      {label}
      {count !== undefined && count > 0 && <span className="pr-tab-count">{count}</span>}
    </button>
  );
}
