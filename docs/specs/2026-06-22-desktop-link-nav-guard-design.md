# Desktop link navigation guard — design

**Issue:** [#583](https://github.com/prpande/PRism/issues/583) — *Desktop: links in PR
Overview/comments navigate the app window away (chromeless trap on macOS)*
**Tier:** T2 · **Risk:** gated B2 (external-URL egress / security surface; `area:desktop`)
**Date:** 2026-06-22

## Problem

A markdown link in the PR Overview body or in a comment renders through
`MarkdownRenderer` (`frontend/src/components/Markdown/MarkdownRenderer.tsx`). That
renderer's `components` map overrides only `code`; it sets no `target` on links, so a
markdown link is a plain in-window `<a href="https://…">`.

Clicking it is a **top-frame navigation**, not a `window.open`. The Electron shell's
external-link safety net is `setWindowOpenHandler` (`desktop/src/main.ts:232`), which
fires only for `window.open` / `target="_blank"`. A plain anchor click bypasses it
entirely — the `BrowserWindow` navigates away from the SPA to the external page. There
is **no `will-navigate` guard** in `desktop/` to catch it.

**Why macOS is catastrophic:** the window is `titleBarStyle: "hidden"` on both
platforms, and macOS additionally calls `setWindowButtonVisibility(false)`
(`main.ts:247`) to hide the native traffic lights (the SPA draws its own). Once the
external page replaces the SPA, *both* the SPA controls and the native traffic lights
are gone → a fully chromeless window, typically in a full-screen Space, with no escape.
The same navigation happens on Windows but is non-fatal (still unreported).

Out of scope / already correct: `OpenInGitHubButton` and the existing
`target="_blank"` "Open on GitHub" links already route through `shell.openExternal`.

## Acceptance criteria

- [ ] Clicking a link in an Overview body / comment on the **desktop** build opens it in
  the user's **default OS browser** and never navigates the app window away.
- [ ] On macOS the link opens in the user's **configured default browser** (Chrome /
  Firefox / Arc / Safari — whatever is set), not a hardcoded Safari. This is inherent to
  `shell.openExternal`, which delegates to LaunchServices/`NSWorkspace`.
- [ ] The PRism window is never left showing a chromeless external page on macOS — it stays
  on the SPA, intact and usable. (Keyboard focus naturally shifts to the OS browser that
  `shell.openExternal` raises; "intact" is about window state, not retaining focus.)
- [ ] In the **browser-tab** build, the same link opens in a new tab, leaving the SPA tab
  in place.
- [ ] A `will-navigate` guard on the main window's `webContents` denies cross-origin
  top-frame navigation and routes https to `shell.openExternal`.
- [ ] Unit coverage for the navigation-decision predicate (mirroring the `urls.ts` /
  `windowOpenDecision` approach) and for the markdown `a`-element rendering
  (`target` / `rel`).

## Approach — two complementary layers

### Layer 1 — `will-navigate` guard (defense-in-depth, the architectural net)

Add a pure, Electron-free predicate to `desktop/src/urls.ts` so the decision is
unit-testable under `node --test` without booting Electron, mirroring the existing
`windowOpenDecision`:

```ts
// Decision for the main window's `will-navigate`. The SPA is served from the
// sidecar origin (http://127.0.0.1:<port>); client-side React Router uses the
// history API, which does NOT fire will-navigate, so a will-navigate event is
// always either (a) the initial same-origin load or (b) a real escaping
// navigation (a plain anchor click). Same-origin top-frame nav is allowed;
// anything else is prevented, and routed to the OS browser iff it is https
// (reusing the isOpenableUrl egress invariant).
export function navigationDecision(
  targetUrl: string,
  appOrigin: string,
): { prevent: boolean; open: boolean } {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { prevent: true, open: false }; // unparseable → block, never open
  }
  if (target.origin === appOrigin) return { prevent: false, open: false };
  return { prevent: true, open: isOpenableUrl(targetUrl) };
}
```

Wire it in `main.ts` right after `setWindowOpenHandler`, capturing the origin **once** at
registration time (the sidecar is guaranteed non-null there) and closing over it — never
deriving it lazily inside the handler:

```ts
// sidecar is non-null here (bootstrap assigned it before creating the window).
const appOrigin = new URL(sidecar.baseUrl).origin;
mainWindow.webContents.on("will-navigate", (event, url) => {
  const { prevent, open } = navigationDecision(url, appOrigin);
  if (prevent) event.preventDefault();
  if (open) void shell.openExternal(url);
});
```

Capturing `appOrigin` as a const (vs. a lazy `new URL(sidecar!.baseUrl).origin` inside the
handler) avoids a `TypeError` if a `will-navigate` ever fires during the shutdown window
after `before-quit` nulls `sidecar` — a non-null assertion is compile-time only and would
throw before `preventDefault()`, silently defeating the guard. `appOrigin` is the live
`http://127.0.0.1:<port>`, so the guard is robust to the dynamic port. This guard stops
escaping **top-frame anchor navigations** (`will-navigate`) — including any future plain
anchor someone forgets to mark `target="_blank"` — extending the existing "route external
opens through `shell.openExternal` and never spawn an in-app window" intent documented at
`main.ts:225` to cover plain navigations too.

### Layer 2 — markdown link hygiene (correct rendering for both shells)

Add an `a` component to `MarkdownRenderer`'s `components` map:

```tsx
a({ children, ...props }) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
},
```

Markdown links then hit the existing `setWindowOpenHandler` on desktop (→
`shell.openExternal`, default browser) and open a new tab in the browser-tab build,
leaving the SPA in place. `urlTransform` already constrains hrefs to `https?:`/`mailto:`,
so this only decorates an already-sanitized href — no new XSS surface.

**Why both, not one:** Layer 2 is the correct rendering behavior for both shells; Layer 1
is the architectural guarantee that the app window can never be navigated away regardless
of what HTML slips through. They are complementary, not redundant.

## Egress invariant & edge cases

- **https-only egress is preserved.** Both layers gate the OS hand-off on
  `isOpenableUrl` (https only). `file:` / `javascript:` / `data:` never reach
  `shell.openExternal`. Layer 1's predicate keeps this consistent with `urls.ts`.
- **Non-https schemes `urlTransform` admits (`mailto:`, plain `http:`) become a no-op on
  desktop — DECISION REQUIRED (see Open decision below).** `urlTransform` admits `https?:`
  and `mailto:`, but `isOpenableUrl` is https-only, so after this change a `mailto:` or
  `http:` markdown link is denied by both layers and does nothing on desktop. **This is a
  regression for `mailto:`**: *today*, with no `will-navigate` guard, a plain `mailto:`
  anchor is a top-frame navigation Electron hands to the OS, opening the default mail
  client; Layer 2 (`target="_blank"`) routes it into the existing https-only window-open
  path and Layer 1 would block it too. (An earlier "consistent with today's behavior"
  framing was wrong and is removed.) Plain `http:` links are an analogous, lower-stakes
  no-op (no established prior behavior to regress).
- **Same-origin full navigations** (should the SPA ever trigger one) are allowed, so the
  guard never traps legitimate in-app navigation. React Router's history-API navigation
  does not fire `will-navigate` at all, so normal SPA routing is unaffected.
- **Initial `loadURL`** does not emit `will-navigate`, so the guard does not interfere
  with startup.
- **Redirect hops (`will-redirect`) are out of scope.** The guard catches the initially
  requested navigation (`will-navigate`); a navigation that lands via an HTTP 3xx fires
  `will-redirect`, which this design does not hook. That path is reachable only via an
  open-redirect on the loopback sidecar (none exists), so the markdown-link threat model is
  fully covered — noted so the "catch-all" framing isn't over-read and a future sidecar
  redirect endpoint doesn't silently reopen the trap. Tracked as #587 so the gap is
  closed before any such endpoint lands.

## Open decision (B2 gate) — `mailto:` egress — **RESOLVED: Option A** (owner sign-off 2026-06-22)

Egress stays strictly https-only; the `mailto:`/`http:` no-op is accepted for this P1.
Follow-up #584 tracks widening egress to `mailto:` (and a possible `http:`→`https:` upgrade).

- **Option A (recommended, in-scope):** accept the `mailto:`/`http:` no-op to preserve the
  issue's explicit https-only egress invariant. File a follow-up to consider widening egress
  to `mailto:` (and/or auto-upgrading `http:`→`https:`). Keeps this P1 tightly scoped and
  leaves the security predicate's behavior unchanged.
- **Option B:** widen the egress predicate so a prevented `mailto:` routes to
  `shell.openExternal` (the OS resolves it to the mail client), restoring today's behavior.
  This changes the B2 security surface (`isOpenableUrl` / `windowOpenDecision`) and broadens
  egress beyond https, so it needs explicit sign-off.

## Testing

- `desktop/test/urls.unit.test.ts` — add cases for `navigationDecision`:
  same-origin → `{prevent:false, open:false}`; cross-origin https → `{prevent:true,
  open:true}`; cross-origin http/file/javascript/mailto → `{prevent:true, open:false}`;
  unparseable → `{prevent:true, open:false}`.
- `frontend/src/components/Markdown/MarkdownRenderer.links.test.tsx` (co-located with
  the component) — assert a rendered markdown link carries `target="_blank"` and
  `rel="noopener noreferrer"` and preserves its `href`.
- The `will-navigate` wiring in `main.ts` is covered behaviorally by the existing
  `desktop/test/shell.e2e.ts` seam where feasible; the decision logic lives in the
  unit-tested predicate.

## Verification

- Build the desktop shell on Windows; click a markdown link in an Overview body and in a
  comment; confirm it opens in the default browser and the PRism window stays put.
- macOS: validate live if a Mac is available; otherwise confirm the guard + renderer
  behavior on Windows and note macOS as a manual-validation follow-up (per the issue).

## Rejected alternatives

- **Renderer-only (Layer 2 alone):** leaves the architectural hole — any future plain
  anchor (or HTML that bypasses the renderer) still escapes. Rejected: the macOS trap is
  too severe to depend on every author remembering `target="_blank"`.
- **Guard-only (Layer 1 alone):** fixes desktop but leaves the browser-tab papercut
  (a plain markdown link navigates the whole tab away from the SPA). Rejected.
- **Intercepting clicks in the renderer with a JS handler:** duplicates what
  `target="_blank"` + the existing window-open handler already do, and is fragile across
  nested markdown. Rejected in favor of declarative `target`/`rel`.
