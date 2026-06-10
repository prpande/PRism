// Single source of truth for the inbox activity-rail breakpoint.
// The rail is shown only at >= this width (see InboxPage's useMediaQuery gate).
// KEEP IN SYNC with InboxPage.module.css `@media (max-width: 1179px)` (= 1180 - 1).
export const INBOX_RAIL_MIN_WIDTH = 1180;
