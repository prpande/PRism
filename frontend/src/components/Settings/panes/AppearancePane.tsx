import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../../../hooks/usePreferences';
import {
  applyThemeToDocument,
  applyDensityToDocument,
  applyContentScaleToDocument,
} from '../../../utils/applyTheme';
import type { Accent, AiMode, ContentScale, Density, Theme } from '../../../api/types';
import { FontSizeSlider, SCALE_ORDER } from '../../controls/FontSizeSlider';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { AccentSwatches } from '../../controls/AccentSwatches';
import { getEgressDisclosure } from '../../../api/aiConsent';
import { EgressConsentModal } from '../EgressConsentModal';
import pane from './Pane.module.css';

const AI_MODES = [
  { value: 'off' as AiMode, label: 'Off' },
  { value: 'preview' as AiMode, label: 'Preview' },
  { value: 'live' as AiMode, label: 'Live' },
];
const AI_MODE_LABELS: Record<AiMode, string> = { off: 'Off', preview: 'Preview', live: 'Live' };

const THEMES = [
  { value: 'system' as Theme, label: 'System' },
  { value: 'dark' as Theme, label: 'Dark' },
  { value: 'light' as Theme, label: 'Light' },
];
const DENSITIES = [
  { value: 'comfortable' as Density, label: 'Comfortable' },
  { value: 'compact' as Density, label: 'Compact' },
];

export function AppearancePane() {
  const { preferences, set } = usePreferences();
  // The AI-mode group's wrapper, so focus queries scope to its radios only
  // (the page has several SegmentedControls, all rendering `role="radio"`).
  const aiGroupRef = useRef<HTMLDivElement | null>(null);
  // The segment to focus once the consent modal closes. Set on Accept/Decline,
  // consumed by the effect below AFTER the Modal restores its own focus.
  const focusTargetRef = useRef<AiMode | null>(null);
  // In-flight egress-disclosure fetch for a pending Live flip; aborted if the
  // user picks Off/Preview before it resolves.
  const abortRef = useRef<AbortController | null>(null);
  const [pendingLive, setPendingLive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Move focus to the intended segment once the modal has closed. Keyed on
  // `modalOpen`: when it flips to false the Modal (a child) runs its focus-
  // restoration cleanup first, then this parent effect runs and wins — so the
  // segment, not the modal's previously-focused trigger, ends up focused.
  useEffect(() => {
    if (modalOpen) return;
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    const label = AI_MODE_LABELS[target];
    const radios = aiGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.forEach((r) => {
      if (r.textContent === label) r.focus();
    });
  }, [modalOpen]);

  // Abort any in-flight Live disclosure fetch on unmount so a resolved fetch
  // can't commit the mode (alreadyConsented path) or open a modal after the
  // pane is gone.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!preferences) return null;

  const onTheme = (value: Theme) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(value, priorAccent);
    void set('theme', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  const onAccent = (value: Accent) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(priorTheme, value);
    void set('accent', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  const density: Density = DENSITIES.some((d) => d.value === preferences.ui.density)
    ? preferences.ui.density
    : 'comfortable';
  const onDensity = (value: Density) => {
    applyDensityToDocument(value);
    void set('density', value).catch(() => applyDensityToDocument(density));
  };
  const contentScale: ContentScale = (SCALE_ORDER as readonly ContentScale[]).includes(
    preferences.ui.contentScale,
  )
    ? preferences.ui.contentScale
    : 'm';
  const onContentScale = (value: ContentScale) => {
    const prior = contentScale; // captured before the optimistic DOM write
    applyContentScaleToDocument(value);
    void set('contentScale', value).catch(() => applyContentScaleToDocument(prior));
  };
  // The committed AI mode drives both the selector and the AI gates (the gates
  // derive from this shared preference via useCapabilities, so selecting a mode
  // propagates reactively). usePreferences.set reverts its own state on a failed
  // POST (+ error toast); no DOM side-effect to roll back here.
  const resolvedMode: AiMode = preferences.ui.aiMode;

  const onAiMode = (next: AiMode) => {
    // SegmentedControl fires onChange even when the already-selected segment is
    // clicked. Guard the no-op — but only when there's no Live flip in flight,
    // so a second click on the already-committed mode while a pending Live fetch
    // is running still cancels that pending flip below.
    if (next === resolvedMode && !pendingLive) return;
    if (next !== 'live') {
      // Off/Preview commit immediately and cancel any in-flight Live intercept.
      // Also dismiss the consent modal if it was already open — a downgrade
      // supersedes a pending Live consent, so no orphaned dialog is left behind.
      abortRef.current?.abort();
      setPendingLive(false);
      setModalOpen(false);
      void set('ui.ai.mode', next).catch(() => {});
      return;
    }
    // next === 'live' → intercept before committing. Do NOT POST and do NOT let
    // the control advance to Live: fetch the disclosure, and either short-circuit
    // (already consented) or open the consent modal.
    setPendingLive(true);
    const ac = new AbortController();
    abortRef.current = ac;
    getEgressDisclosure(ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        if (d.alreadyConsented) {
          setPendingLive(false);
          void set('ui.ai.mode', 'live').catch(() => {});
        } else {
          setModalOpen(true);
        }
      })
      .catch(() => {
        // Fail closed: an unreachable disclosure leaves the mode unchanged.
        if (!ac.signal.aborted) setPendingLive(false);
      });
  };

  const onModalAccept = () => {
    setModalOpen(false);
    setPendingLive(false);
    focusTargetRef.current = 'live'; // focus the Live segment once the modal closes
    void set('ui.ai.mode', 'live').catch(() => {});
  };
  const onModalDecline = () => {
    setModalOpen(false);
    setPendingLive(false);
    // Return focus to the segment that was selected when Live was intercepted.
    focusTargetRef.current = resolvedMode;
  };

  return (
    <section aria-labelledby="appearance-heading">
      <div className={pane.head}>
        <div>
          <h2 id="appearance-heading" className={pane.title}>
            Appearance
          </h2>
          <p className={pane.sub}>Theme, accent color, density, content size, and AI mode</p>
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Theme</div>
          <div className={pane.help}>Match your system or pick a mode</div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="Theme"
            options={THEMES}
            value={preferences.ui.theme}
            onChange={onTheme}
          />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Accent</div>
          <div className={pane.help}>Highlight color across the app</div>
        </div>
        <div className={pane.spring}>
          <AccentSwatches value={preferences.ui.accent} onChange={onAccent} />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Density</div>
          <div className={pane.help}>Row height in lists and tables</div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="Density"
            options={DENSITIES}
            value={density}
            onChange={onDensity}
          />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Content size</div>
          <div className={pane.help}>Font size for PR content — comments, description, diffs</div>
        </div>
        <div className={pane.spring}>
          <FontSizeSlider value={contentScale} onChange={onContentScale} />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>AI mode</div>
          <div className={pane.help} id="ai-mode-help">
            Off · no AI. Preview · sample output, clearly labeled. Live · real AI, sends PR content
            to the provider.
          </div>
        </div>
        <div className={pane.spring} ref={aiGroupRef}>
          <SegmentedControl
            label="AI mode"
            describedById="ai-mode-help"
            options={AI_MODES}
            // Always the committed mode — NEVER `pendingLive`. The control must
            // not visually advance to Live until consent commits the preference.
            value={resolvedMode}
            onChange={onAiMode}
          />
        </div>
      </div>
      <EgressConsentModal open={modalOpen} onAccept={onModalAccept} onDecline={onModalDecline} />
    </section>
  );
}
