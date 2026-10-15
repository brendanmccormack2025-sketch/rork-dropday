/**
 * Temporary switches to find the camera / editor crash (the build's own version works; an update since does not).
 * false = that always-running part is switched off in this test update. Remove once the cause is found.
 */
export const DIAG_PUSH_ON = false;         // push permission, token registration and handlers at launch
export const DIAG_UNREAD_LIVE_ON = true;   // the feed's live unread-messages count (Realtime + 90 s poll)
export const DIAG_SEND_SHEET_ON = true;    // the always-mounted "Send to friend" sheet on the feed
