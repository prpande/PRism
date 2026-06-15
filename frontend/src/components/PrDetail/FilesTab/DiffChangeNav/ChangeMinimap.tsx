import { useRef, useState } from 'react';
import styles from './ChangeMinimap.module.css';
import type { ChangeTick } from './diffChanges';

export interface ChangeMinimapProps {
  ticks: ChangeTick[];
  viewport: { topPct: number; heightPct: number };
  onGoToChange: (i: number) => void;
  onScrollToRatio: (r: number) => void;
}

export function ChangeMinimap({
  ticks,
  viewport,
  onGoToChange,
  onScrollToRatio,
}: ChangeMinimapProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const onRailClick = (e: React.MouseEvent) => {
    // Only when the empty rail (not a tick) is clicked.
    if ((e.target as HTMLElement).dataset.tick !== undefined) return;
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    onScrollToRatio((e.clientY - rect.top) / rect.height);
  };

  return (
    <div ref={railRef} className={styles.rail} aria-hidden="true" onClick={onRailClick}>
      <div
        className={styles.viewport}
        style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }}
      />
      {ticks.map((t, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          data-tick=""
          data-testid="change-tick"
          data-kind={t.kind}
          className={styles.tick}
          style={{ top: `${t.topPct}%`, height: `max(3px, ${t.heightPct}%)` }}
          onClick={() => onGoToChange(i)}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
        >
          <span className={styles.lineNum}>{t.startLineNum}</span>
        </button>
      ))}
      {hovered !== null && (
        <div className={styles.tooltip} style={{ top: `${ticks[hovered].topPct}%` }}>
          change {hovered + 1} of {ticks.length} · L{ticks[hovered].startLineNum} · +
          {ticks[hovered].addCount} −{ticks[hovered].delCount}
        </div>
      )}
    </div>
  );
}
