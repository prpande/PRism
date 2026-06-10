import { useEffect } from 'react';
import { usePreferences } from '../hooks/usePreferences';
import {
  applyThemeToDocument,
  applyDensityToDocument,
  applyContentScaleToDocument,
} from '../utils/applyTheme';

// Headless: applies the saved theme/accent/density to <html> on load and on any
// preference change. This was previously HeaderControls' mount-effect; the
// navbar quick-toggles were removed (they live in Settings now), but the
// apply-on-load behavior is load-bearing — without it every page outside
// /settings would ignore the user's saved appearance and render light/default.
// Rendered in the same place HeaderControls used to be (App's main tree) so the
// application timing is unchanged.
export function AppearanceSync() {
  const { preferences } = usePreferences();

  useEffect(() => {
    if (preferences) {
      applyThemeToDocument(preferences.ui.theme, preferences.ui.accent);
      applyDensityToDocument(preferences.ui.density);
      applyContentScaleToDocument(preferences.ui.contentScale);
    }
  }, [preferences]);

  return null;
}
