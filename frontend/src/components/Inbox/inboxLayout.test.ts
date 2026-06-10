import { it, expect } from 'vitest';
import { INBOX_RAIL_MIN_WIDTH } from './inboxLayout';

// Pins the magic number so a future tweak forces a conscious update of BOTH the
// JS useMediaQuery arg and the InboxPage.module.css @media rule (1179px = 1180-1).
it('rail breakpoint is 1180px', () => {
  expect(INBOX_RAIL_MIN_WIDTH).toBe(1180);
});
