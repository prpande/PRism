import type { Accent, Theme } from '../api/types';

const ACCENT_HUES: Record<Accent, { h: number; c: number }> = {
  indigo: { h: 245, c: 0.085 },
  amber: { h: 75, c: 0.1 },
  teal: { h: 195, c: 0.075 },
};

// HeaderControls and the Settings page each render a theme/accent picker, and
// each calls usePreferences() (independent useState instance). When one writes,
// the other's local state doesn't update until window-focus triggers refetch.
// So whichever picker the user touches must apply the chosen theme/accent to
// documentElement directly — otherwise the chosen value persists server-side
// but the visible UI doesn't change until the next focus. Centralizing the
// effect here keeps both call sites in sync.
export function applyThemeToDocument(theme: Theme, accent: Accent): void {
  if (typeof document === 'undefined') return;
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.dataset.theme = resolved;
  const hue = ACCENT_HUES[accent];
  document.documentElement.style.setProperty('--accent-h', String(hue.h));
  document.documentElement.style.setProperty('--accent-c', String(hue.c));
}
