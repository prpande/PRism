import styles from './PrSubTabStrip.module.css';

export type PrTabId = 'overview' | 'files' | 'hotspots' | 'drafts';

interface PrSubTabStripProps {
  activeTab: PrTabId;
  onTabChange: (tab: PrTabId) => void;
  fileCount?: number;
  // High+Medium count; undefined while loading/error/zero/Preview → no badge.
  hotspotsCount?: number;
  draftsCount?: number;
}

export function PrSubTabStrip({
  activeTab,
  onTabChange,
  fileCount,
  hotspotsCount,
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
        id="hotspots"
        label="Hotspots"
        active={activeTab === 'hotspots'}
        onSelect={onTabChange}
        count={hotspotsCount}
        // Spec § 6.1 — the hotspots badge announces "N files need attention"
        // rather than the generic "N items". Built at the call site (single
        // consumer) so the generic Tab keeps its default wording.
        srCountSuffix={
          hotspotsCount
            ? `, ${hotspotsCount} ${hotspotsCount === 1 ? 'file needs' : 'files need'} attention`
            : undefined
        }
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
  // When provided, replaces the default ", N items" sr-only companion (the
  // visible numeric badge is unchanged). Single consumer = Hotspots; not worth
  // a function-valued prop on the generic Tab.
  srCountSuffix?: string;
}

function Tab({ id, label, active, onSelect, disabled, count, srCountSuffix }: TabProps) {
  // D11/D103 — the handoff (design/handoff/pr-detail.jsx:124 + :134) applies
  // `.pr-tab-count-warn` drafts-only, never on files. The base `.pr-tab-count`
  // class is shared. Conditional-render of the span (count > 0) already covers
  // both tabs; this gates ONLY the warn class.
  const warn = id === 'drafts';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={[styles.prTab, active && styles.isActive, disabled && styles.isDisabled]
        .filter(Boolean)
        .join(' ')}
      data-testid={`pr-tab-${id}`}
      onClick={() => {
        if (!disabled) onSelect(id);
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <>
          <span
            className={[styles.prTabCount, warn && styles.prTabCountWarn].filter(Boolean).join(' ')}
            data-testid="pr-tab-count"
            aria-hidden="true"
          >
            {count}
          </span>
          {/* SR companion so the tab announces "Files, 3 items" rather than
              "Files 3". Spec § 6.1 Pass 2 ("badge labels in words"). The
              Hotspots tab overrides the wording via srCountSuffix. */}
          <span className="sr-only">
            {srCountSuffix ?? `, ${count} ${count === 1 ? 'item' : 'items'}`}
          </span>
        </>
      )}
    </button>
  );
}
