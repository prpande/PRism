// #143: `usePreferences` used to be a self-contained hook here; each consumer
// got its own state + mount fetch + window-`focus` listener, producing N
// parallel GET /api/preferences per focus. It now reads a single shared store
// from PreferencesProvider (mounted once at the app root). This module is kept
// as a thin re-export so every existing `from '../hooks/usePreferences'` import
// — and every `vi.mock('.../hooks/usePreferences')` in the test suite — keeps
// working unchanged.
export { usePreferences, type PreferenceKey } from '../contexts/PreferencesContext';
