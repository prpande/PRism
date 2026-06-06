import type { Accent, Density, Theme } from '../api/types';

const ACCENT_HUES: Record<Accent, { h: number; c: number }> = {
  indigo: { h: 245, c: 0.085 },
  amber: { h: 75, c: 0.1 },
  teal: { h: 195, c: 0.075 },
};

// theme/accent state is shared via PreferencesContext (#143): the headless
// AppearanceSync applies it to <html> on every change, and the Settings picker
// applies it directly on click for instant feedback. Centralizing the actual
// DOM write here keeps both apply sites (boot-time sync + interactive picker)
// in agreement on exactly how a theme/accent maps to documentElement.
export function applyThemeToDocument(theme: Theme, accent: Accent): void {
  if (typeof document === 'undefined') return;
  // matchMedia exists in every modern browser, but defensively guard for
  // SSR/test envs that load document without it. When unavailable the
  // 'system' theme resolves to 'light' (the OS-default we'd assume in a
  // headless context).
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  const hue = ACCENT_HUES[accent];
  document.documentElement.style.setProperty('--accent-h', String(hue.h));
  document.documentElement.style.setProperty('--accent-c', String(hue.c));
}

// AppearanceSection's density picker and HeaderControls' mount-effect each
// call this so the visible `data-density` attribute on <html> updates without
// waiting for a focus refetch. Mirrors applyThemeToDocument's
// independent-effect pattern: each ui.* key has a key-scoped DOM applier so
// rollbacks on one key don't have to thread the full appearance tuple.
//
// Defensive on any non-`compact` string. The wire shape (UiPreferencesDto.Density)
// is `string`, validated by ConfigStore for type only, not enum membership
// (plan Deviation 6) — an out-of-band config.json edit could yield an arbitrary
// string. Treating non-`compact` as comfortable keeps the visible state correct.
export function applyDensityToDocument(density: Density): void {
  if (typeof document === 'undefined') return;
  if (density === 'compact') {
    document.documentElement.setAttribute('data-density', 'compact');
  } else {
    document.documentElement.removeAttribute('data-density');
  }
}
