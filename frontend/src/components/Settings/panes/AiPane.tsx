import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../../../hooks/usePreferences';
import type { AiMode } from '../../../api/types';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { NumberStepper } from '../../controls/NumberStepper';
import { Switch } from '../../controls/Switch';
import { InboxCaret } from '../../Inbox/InboxCaret';
import { getEgressDisclosure } from '../../../api/aiConsent';
import { EgressConsentModal } from '../EgressConsentModal';
import pane from './Pane.module.css';

const AI_MODES = [
  { value: 'off' as AiMode, label: 'Off' },
  { value: 'preview' as AiMode, label: 'Preview' },
  { value: 'live' as AiMode, label: 'Live' },
];
const AI_MODE_LABELS: Record<AiMode, string> = { off: 'Off', preview: 'Preview', live: 'Live' };

const FEATURE_ROWS = [
  {
    key: 'summary' as const,
    label: 'Summary',
    help: 'When off, the AI summary card is hidden on pull requests.',
  },
  {
    key: 'fileFocus' as const,
    label: 'File focus',
    help: 'When off, AI file hotspots are not shown in the Files tab.',
  },
  {
    key: 'hunkAnnotations' as const,
    label: 'Hunk annotations',
    help: 'When off, inline AI annotations are not added to diffs.',
  },
  {
    key: 'inboxEnrichment' as const,
    label: 'Inbox enrichment',
    help: 'When off, the AI kind-of-change chip is removed from inbox rows.',
  },
];

export function AiPane() {
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
  const [featuresOpen, setFeaturesOpen] = useState(false);

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
    <section aria-labelledby="ai-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ai-heading" className={pane.title}>
            AI
          </h2>
          <p className={pane.sub}>
            Choose how AI runs. Provider, summary, and per-feature settings appear in Live mode.
          </p>
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

      {/* The min/max literals below (and the "30–600" / "1–50" / "500–5000" help text) MIRROR the canonical
          bounds in PRism.Core/Config/AiConfigBounds.cs (MinTimeout=30/MaxTimeout=600, MinCap=1/MaxCap=50,
          MinSummaryChars=500/MaxSummaryChars=5000). The server re-clamps on write, so a stale literal here
          only mis-bounds the stepper UI — keep them in sync if AiConfigBounds changes. The `step` values
          (30, 1, 100) are UI-only and have no backend mirror. */}
      {resolvedMode === 'live' && (
        <>
          <div className={pane.row}>
            <div>
              <div className={pane.label} id="ai-timeout-label">
                Provider timeout
              </div>
              <div className={pane.help}>
                30–600 seconds. Applies to the next AI request — no restart.
              </div>
            </div>
            <div className={pane.spring}>
              <NumberStepper
                label="Provider timeout"
                labelledById="ai-timeout-label"
                value={preferences.ui.providerTimeoutSeconds}
                min={30}
                max={600}
                step={30}
                unit="seconds"
                onChange={(n) => void set('ui.ai.providerTimeoutSeconds', n).catch(() => {})}
              />
            </div>
          </div>

          <div className={pane.row}>
            <div>
              <div className={pane.label} id="ai-cap-label">
                Annotation cap
              </div>
              <div className={pane.help}>
                1–50 hunk annotations per PR. Higher values cost more and add latency.
              </div>
            </div>
            <div className={pane.spring}>
              <NumberStepper
                label="Annotation cap"
                labelledById="ai-cap-label"
                value={preferences.ui.hunkAnnotationCap}
                min={1}
                max={50}
                step={1}
                unit="annotations"
                onChange={(n) => void set('ui.ai.hunkAnnotationCap', n).catch(() => {})}
              />
            </div>
          </div>

          <div className={pane.row}>
            <div>
              <div className={pane.label} id="ai-summary-len-label">
                Summary length
              </div>
              <div className={pane.help}>
                500–5000 characters. Applies to newly generated summaries; use Regenerate to
                re-apply on an already-open PR.
              </div>
            </div>
            <div className={pane.spring}>
              <NumberStepper
                label="Summary length"
                labelledById="ai-summary-len-label"
                value={preferences.ui.summaryMaxChars}
                min={500}
                max={5000}
                step={100}
                unit="characters"
                onChange={(n) => void set('ui.ai.summaryMaxChars', n).catch(() => {})}
              />
            </div>
          </div>

          <div className={pane.row}>
            <button
              type="button"
              className={`${pane.label} ${pane.disclosureBtn}`}
              aria-expanded={featuresOpen}
              aria-controls={featuresOpen ? 'ai-features-region' : undefined}
              onClick={() => setFeaturesOpen((o) => !o)}
            >
              <InboxCaret open={featuresOpen} />
              AI features
            </button>
          </div>
          {featuresOpen && (
            <div
              id="ai-features-region"
              role="group"
              aria-label="AI features"
              className={pane.featuresRegion}
            >
              {FEATURE_ROWS.map(({ key, label, help }) => (
                <div key={key} className={pane.row}>
                  <div>
                    <label className={pane.label} htmlFor={`ai-feat-${key}`}>
                      {label}
                    </label>
                    <p id={`ai-feat-${key}-help`} className={pane.help}>
                      {help}
                    </p>
                  </div>
                  <div className={pane.spring} />
                  <Switch
                    id={`ai-feat-${key}`}
                    label={label}
                    describedById={`ai-feat-${key}-help`}
                    checked={preferences.ui.features?.[key] ?? true}
                    onChange={(next) => void set(`ui.ai.features.${key}`, next).catch(() => {})}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {resolvedMode === 'preview' && (
        <div className={pane.row}>
          <div>
            {/* Intentionally inert: a discoverability affordance only — the real toggles
                live in Live mode. No onClick (a no-op handler on type="button" is
                misleading), and it never calls set/setFeaturesOpen, so clicking does
                nothing; aria-disabled + dimmed opacity convey the disabled state. */}
            <button
              type="button"
              className={`${pane.label} ${pane.disclosureBtn}`}
              style={{ opacity: 0.5 }}
              aria-disabled="true"
              aria-describedby="ai-features-preview-hint"
            >
              AI features
            </button>
            <p id="ai-features-preview-hint" className={pane.help}>
              {FEATURE_ROWS.some(({ key }) => (preferences.ui.features?.[key] ?? true) === false)
                ? 'Some AI features are turned off. Switch to Live to change them.'
                : 'Switch to Live to turn individual features on or off.'}
            </p>
          </div>
        </div>
      )}

      <EgressConsentModal open={modalOpen} onAccept={onModalAccept} onDecline={onModalDecline} />
    </section>
  );
}
