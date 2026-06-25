import type { ReactNode } from 'react';
import { AiMarker } from '../Ai/AiMarker';
import { ChecksTabGlyph } from './ChecksTabGlyph';
import type { ChecksLeadGlyph } from './checksGlyphState';
import styles from './PrSubTabStrip.module.css';

export type PrTabId = 'overview' | 'files' | 'hotspots' | 'drafts' | 'checks';

interface PrSubTabStripProps {
  activeTab: PrTabId;
  onTabChange: (tab: PrTabId) => void;
  fileCount?: number;
  // High+Medium count; undefined while loading/error/zero/Preview → no badge.
  hotspotsCount?: number;
  draftsCount?: number;
  // Spec §8 — the Hotspots tab is rendered ONLY when the fileFocus capability is
  // on (Preview or Live). When AI is Off it is removed from the DOM entirely (not
  // display:none / aria-hidden), so the tablist carries no inert tab. Defaults to
  // false: a consumer that doesn't thread capability state never shows the tab.
  showHotspots?: boolean;
  // Drives the Hotspots tab-label marker; replaces the former boolean `aiMarker`.
  // 'working' = AI in flight (non-decorative, sr-only "AI is working…" enters the
  // tab's accessible name); 'idle' = AI resolved (decorative provenance glyph);
  // null / omitted = no marker (AI off or error/no-changes/not-subscribed).
  aiMarkerState?: 'idle' | 'working' | null;
  // Checks tab primitive props (Task 8). PrSubTabStrip builds <ChecksTabGlyph>
  // at the leaf; passing primitives (not a node) keeps PrHeader memo-stable.
  checksLead?: ChecksLeadGlyph; // 'in-progress' | 'all-green' | 'none'
  checksFailingCount?: number; // failing-tier count; undefined/0 → no badge
  checksAriaLabel?: string; // health summary, e.g. "Checks — 2 failing"
}

export function PrSubTabStrip({
  activeTab,
  onTabChange,
  fileCount,
  hotspotsCount,
  draftsCount,
  showHotspots = false,
  aiMarkerState = null,
  checksLead,
  checksFailingCount,
  checksAriaLabel,
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
      {showHotspots && (
        <Tab
          id="hotspots"
          label="Hotspots"
          active={activeTab === 'hotspots'}
          onSelect={onTabChange}
          count={hotspotsCount}
          leadingGlyph={
            aiMarkerState ? (
              <AiMarker
                variant="lead"
                state={aiMarkerState}
                decorative={aiMarkerState === 'idle'}
              />
            ) : undefined
          }
          // Spec § 6.1 — the hotspots badge announces "N files need attention"
          // rather than the generic "N items". Built at the call site (single
          // consumer) so the generic Tab keeps its default wording.
          srCountSuffix={
            hotspotsCount
              ? `, ${hotspotsCount} ${hotspotsCount === 1 ? 'file needs' : 'files need'} attention`
              : undefined
          }
        />
      )}
      <Tab
        id="drafts"
        label="Drafts"
        active={activeTab === 'drafts'}
        onSelect={onTabChange}
        count={draftsCount}
        warn
      />
      <Tab
        id="checks"
        label="Checks"
        active={activeTab === 'checks'}
        onSelect={onTabChange}
        count={checksFailingCount}
        // gate `danger` on a positive count so the class precedence matches badge visibility
        // (the count badge only renders when count > 0; an unconditional `danger` is harmless
        // but misleading at zero — coherence R2)
        danger={(checksFailingCount ?? 0) > 0}
        leadingGlyph={
          checksLead && checksLead !== 'none' ? <ChecksTabGlyph lead={checksLead} /> : undefined
        }
        ariaLabel={checksAriaLabel}
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
  // Generic leading glyph slot (Hotspots passes an <AiMarker/>, Checks passes <ChecksTabGlyph/>).
  leadingGlyph?: ReactNode;
  // When set, overrides the tab's accessible name (Checks carries a health summary).
  ariaLabel?: string;
  warn?: boolean; // amber count badge (Drafts pending)
  danger?: boolean; // red count badge (Checks failing) — NEW prTabCountDanger class
}

function Tab({
  id,
  label,
  active,
  onSelect,
  disabled,
  count,
  srCountSuffix,
  leadingGlyph,
  ariaLabel,
  warn,
  danger,
}: TabProps) {
  // D11/D103 — the handoff (design/handoff/pr-detail.jsx:124 + :134) applies
  // `.pr-tab-count-warn` drafts-only, never on files. The base `.pr-tab-count`
  // class is shared. Conditional-render of the span (count > 0) already covers
  // both tabs; this gates ONLY the warn/danger class.
  const countClass = danger ? styles.prTabCountDanger : warn ? styles.prTabCountWarn : undefined;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      className={[styles.prTab, active && styles.isActive, disabled && styles.isDisabled]
        .filter(Boolean)
        .join(' ')}
      data-testid={`pr-tab-${id}`}
      onClick={() => {
        if (!disabled) onSelect(id);
      }}
    >
      {leadingGlyph}
      {label}
      {count !== undefined && count > 0 && (
        <>
          <span
            className={[styles.prTabCount, countClass].filter(Boolean).join(' ')}
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
