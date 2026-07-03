import { useEffect, useState } from 'react';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { useTabScrollMemory } from '../../hooks/useTabScrollMemory';
import { InboxPage } from '../../pages/InboxPage';

// Sentinel scroll-memory key for the Inbox. useTabScrollMemory keys on
// `${prRefKey}|${subTab}`; real PR keys are always `owner/repo/number`, so this
// `__inbox__` prefix can never collide with one. Sharing the hook's module-level
// store with the PR views is what lets the single [data-app-scroll] scroller hand
// its offset off cleanly between the Inbox and a PR (#563).
const INBOX_SCROLL_KEY = '__inbox__';

// Persistent keep-alive host for the Inbox — the Inbox counterpart of PrTabHost
// (#563). The `/` route element is null; this host (a sibling to <Routes>) renders
// one InboxPage and toggles it `hidden` when the effective path isn't `/`, instead
// of unmounting it on navigate-away. Because the page stays mounted, its scroll
// (restored via useTabScrollMemory), active filter/sort, expanded sections, and
// activity-rail state all survive a round-trip to a PR detail or a Settings modal.
export function InboxHost() {
  const { pathname } = useEffectiveLocation();
  const onInbox = pathname === '/';

  console.log(`[DBG-HOST] render pathname=${pathname} onInbox=${String(onInbox)}`);

  // Lazy mount: render InboxPage only once the Inbox has been visited, then keep
  // it alive forever (hidden toggled, never unmounted). `useState(onInbox)` mounts
  // eagerly when the first paint IS the Inbox (the default route), but a cold
  // deep-link straight to /pr/... starts with mounted=false so it does not fire the
  // Inbox + activity fetches until the user first lands on `/` — protecting the
  // cold-start budget hardened by #282/#507.
  const [mounted, setMounted] = useState(onInbox);
  useEffect(() => {
    if (onInbox) setMounted(true);
  }, [onInbox]);

  // Save/restore the Inbox's offset on the shared [data-app-scroll] scroller. The
  // hook is a no-op while inactive, so calling it before the lazy mount (onInbox
  // false) does not touch the scroller. Called unconditionally, above the early
  // return, per the Rules of Hooks.
  useTabScrollMemory({ prRefKey: INBOX_SCROLL_KEY, subTab: '', active: onInbox });

  if (!mounted) return null;

  // `active` gates InboxPage's Modal-based dialogs (onboarding, load-error) so a
  // hidden-but-mounted Inbox doesn't keep live document-level keydown handlers —
  // `display:none` alone wouldn't, because Modal registers Escape/Tab on document
  // keyed on `open`, not on CSS visibility. Mirrors PrDetailView's `active` gate.
  return (
    <div hidden={!onInbox} data-inbox-host>
      <InboxPage active={onInbox} />
    </div>
  );
}
