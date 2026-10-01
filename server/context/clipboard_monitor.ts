/**
 * Clipboard Monitor — records observed clipboard changes.
 *
 * Compares observations from the desktop client against the last known value.
 * When content changes, pushes clipboard_changed events to activity stream.
 */

import { pushActivityEvent } from './activity_stream';

const lastClipboard = new Map<string, string>();

export function detectClipboardChange(
  userId: string,
  currentText: string,
): { changed: boolean; prevText?: string } {
  const prevText = lastClipboard.get(userId);
  if (prevText !== currentText) {
    lastClipboard.set(userId, currentText);
    if (currentText.trim()) {
      pushActivityEvent(userId, {
        type: 'clipboard_changed',
        timestamp: new Date().toISOString(),
        data: { text: currentText.slice(0, 500), prevText: prevText?.slice(0, 500) },
      });
    }
    return { changed: true, prevText };
  }
  return { changed: false };
}
