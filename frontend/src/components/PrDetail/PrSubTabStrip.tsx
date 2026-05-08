export type PrTabId = 'overview' | 'files' | 'drafts';

interface PrSubTabStripProps {
  activeTab: PrTabId;
  onTabChange: (tab: PrTabId) => void;
  fileCount?: number;
}

const DRAFTS_TOOLTIP = 'Drafts arrive in S4 — comment composer ships in the next slice';

export function PrSubTabStrip({ activeTab, onTabChange, fileCount }: PrSubTabStripProps) {
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
        disabled
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
      title={disabled ? DRAFTS_TOOLTIP : undefined}
      className={`pr-tab ${active ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}
      onClick={() => {
        if (!disabled) onSelect(id);
      }}
    >
      {label}
      {count !== undefined && <span className="pr-tab-count">{count}</span>}
    </button>
  );
}
