// Shape of the `window.prism` bridge exposed by the Electron desktop shell's
// preload (desktop/src/preload.ts). Absent in the browser build — every consumer
// MUST treat `window.prism` as optional, which is how the desktop-only UI
// (window controls) stays inert in a plain browser tab.
export {};

declare global {
  interface PrismWindowControls {
    /** Minimize the window. */
    minimize(): void;
    /** Maximize if restored, restore if maximized. */
    toggleMaximize(): void;
    /** Close the window (triggers the app's clean-shutdown path). */
    close(): void;
    /** Current maximized state, for the initial maximize/restore icon. */
    isMaximized(): Promise<boolean>;
    /** Subscribe to maximize/unmaximize; returns an unsubscribe fn. */
    onMaximizedChange(cb: (maximized: boolean) => void): () => void;
  }

  interface PrismApi {
    isDesktop: boolean;
    platform: string;
    /** Open an external https URL in the OS browser. Resolves false if the URL
     *  was rejected (non-https / malformed) or the OS open failed. */
    openExternal(url: string): Promise<boolean>;
    windowControls: PrismWindowControls;
  }

  interface Window {
    prism?: PrismApi;
  }
}
