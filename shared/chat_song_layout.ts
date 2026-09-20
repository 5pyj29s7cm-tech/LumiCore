import type { ChatSongLine } from './chat_song';

/** One geometry for exported strips, the timeline preview and local video. */
export const CHAT_SONG_TEMPLATE = {
  version: 2, width: 1080, height: 1440, stripWidth: 1080,
  fontSize: 56, lineHeight: 78, textWidth: 656, avatarSize: 120,
  gap: 12, top: 220, reactionWidth: 500, reactionHeight: 360,
} as const;

export function chatSongStripLayout(line: ChatSongLine) {
  const style = CHAT_SONG_TEMPLATE;
  const rows: string[] = [];
  let row = '', width = 0, widest = 0;
  for (const char of Array.from(line.text)) {
    // Conservative widths prevent CJK, Latin and escaped markup from clipping.
    const advance = /^[\x20-\x7e]$/.test(char) && !/[MW@%]/.test(char) ? style.fontSize * 0.65 : style.fontSize;
    if (char === '\n' || (row && width + advance > style.textWidth)) {
      rows.push(row); widest = Math.max(widest, width); row = ''; width = 0;
    }
    if (char !== '\n') { row += char; width += advance; }
  }
  if (row || !rows.length) { rows.push(row); widest = Math.max(widest, width); }
  const height = Math.max(184, rows.length * style.lineHeight + 64);
  const bubbleWidth = Math.max(120, Math.ceil(widest) + 48);
  const bubbleX = line.role === 'B' ? 896 - bubbleWidth : 184;
  return { rows, height, bubbleWidth, bubbleX, textX: bubbleX + 24,
    textTop: (height - rows.length * style.lineHeight) / 2,
    avatarX: line.role === 'B' ? 926 : 30, avatarY: 32 };
}

export function chatSongGroupLayout(group: ChatSongLine[], hasReaction: boolean) {
  const s = CHAT_SONG_TEMPLATE;
  const height = group.reduce((sum, line) => sum + chatSongStripLayout(line).height, 0) + Math.max(0, group.length - 1) * s.gap;
  const available = s.height - s.top - 100 - (hasReaction ? s.reactionHeight + 64 : 0);
  const scale = Math.min(1000 / s.stripWidth, available / Math.max(1, height));
  let top: number = s.top;
  const strips = group.map(line => {
    const h = Math.round(chatSongStripLayout(line).height * scale), width = Math.round(s.stripWidth * scale);
    const placement = { lineId: line.id, left: Math.round((s.width - width) / 2), top, width, height: h };
    top += h + Math.round(s.gap * scale);
    return placement;
  });
  return { scale, strips, reaction: { left: (s.width - s.reactionWidth) / 2,
    top: Math.min(s.height - s.reactionHeight - 100, Math.max(850, top + 52)), width: s.reactionWidth, height: s.reactionHeight } };
}

/** Repair only fresh model drafts, never regroup an owner's saved dialogue. */
export function groupChatSongDraft(lines: ChatSongLine[]): ChatSongLine[] {
  const singletonOnly = lines.length > 2 && lines.every((line, index) => index === 0 || line.group !== lines[index - 1].group);
  let group = 0, count = 0, previous = -1;
  return lines.map((line, index) => {
    if (singletonOnly) return { ...line, group: Math.floor(index / 2) + 1 };
    if (line.group !== previous || count >= 3) { group++; count = 0; }
    previous = line.group; count++;
    return { ...line, group };
  });
}
