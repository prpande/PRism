// Pure mapping from the SPA's resolved theme + density to Windows
// Window-Controls-Overlay options. Kept free of any electron import so the
// launch/recolor contract is unit-testable without a running app.

/** Comfortable-density header height (tokens.css `--header-h`). */
export const DEFAULT_TITLEBAR_HEIGHT = 56;
/** Compact-density header height (tokens.css `[data-density="compact"]`). */
export const COMPACT_TITLEBAR_HEIGHT = 48;

export interface TitleBarOverlayOptions {
  /** Background of the caption-button strip. Matches the navbar's --surface-1 so
   *  the frameless title bar reads as one continuous surface with the navbar. */
  color: string;
  /** The min/max/close glyph color; must contrast `color`. */
  symbolColor: string;
  /** Overlay height — kept equal to the live header height so the clickable
   *  caption strip never extends past the visible navbar. */
  height: number;
}

/**
 * Map the SPA's resolved theme (`light`/`dark`; `system` is resolved to one of
 * those by applyThemeToDocument before it ever reaches `data-theme`) and density
 * to the native overlay. titleBarOverlay accepts only concrete color strings —
 * not `oklch()` or CSS vars — so these are sRGB approximations of tokens.css:
 * `--surface-1` for `color`, `--text-1` for `symbolColor`.
 */
export function titleBarOverlayOptions(
  theme: string,
  density: string,
): TitleBarOverlayOptions {
  const dark = theme === "dark";
  return {
    color: dark ? "#2a2d31" : "#ffffff",
    symbolColor: dark ? "#e6e7e9" : "#1a1c1e",
    height: density === "compact" ? COMPACT_TITLEBAR_HEIGHT : DEFAULT_TITLEBAR_HEIGHT,
  };
}
