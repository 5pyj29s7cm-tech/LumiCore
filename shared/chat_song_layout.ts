import { visibleChatSongLines, type ChatSongLine, type ChatSongProject } from './chat_song';

/** One geometry and animation clock for editing previews and exported frames. */
export const CHAT_SONG_TEMPLATE = {
  version: 7, width: 1080, height: 1440, stripWidth: 1080, fps: 25,
  fontSize: 46, lineHeight: 64, textWidth: 656, avatarSize: 100,
  gap: 36, top: 270, reactionWidth: 500, reactionHeight: 420,
  screenshotPadding: 16, screenshotFill: '#f7f7f7', background: '#11161c',
  incomingBubble: '#ededed', outgoingBubble: '#95ec69', nameColor: '#8c8c8c', backgroundOpacity: 0.8, backgroundBlur: 4,
  messageEnterSeconds: 0.32, reactionEnterSeconds: 0.2, exitSeconds: 0.12,
} as const;

export function chatSongMessageIsRight(line: Pick<ChatSongLine, 'role'>) { return line.role === 'A'; }

export function chatSongStripLayout(line: ChatSongLine, displayName = '') {
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
  const height = Math.max(180, rows.length * style.lineHeight + 100);
  const bubbleWidth = Math.max(120, Math.ceil(widest) + 48);
  const bubbleX = chatSongMessageIsRight(line) ? 926 - bubbleWidth : 154;
  const avatarX = chatSongMessageIsRight(line) ? 952 : 28;
  const nameWidth = Array.from(displayName).reduce((sum, char) => sum + (/^[\x20-\x7e]$/.test(char) && !/[MW@%]/.test(char) ? 28 * 0.65 : 28), 0);
  const nameLeft = chatSongMessageIsRight(line) ? 926 - nameWidth : 154;
  const left = Math.floor(Math.max(0, Math.min(avatarX, bubbleX - 12, nameLeft) - style.screenshotPadding));
  const right = Math.ceil(Math.min(style.width, Math.max(avatarX + style.avatarSize, bubbleX + bubbleWidth + 12, nameLeft + nameWidth) + style.screenshotPadding));
  return { rows, height, bubbleWidth, bubbleX, textX: bubbleX + 24,
    textTop: 52,
    avatarX, avatarY: 40, screenshot: { left, width: right - left } };
}

type Names = Partial<Record<'A' | 'B', string>>;
type Box = { left: number; top: number; width: number; height: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const variant = (line: ChatSongLine) => Array.from(line.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;

export function chatSongGroupLayout(group: ChatSongLine[], hasReaction: boolean, single = false, names: Names = {}) {
  const s = CHAT_SONG_TEMPLATE;
  const source = group.map(line => ({ line, strip: chatSongStripLayout(line, names[line.role]) }));
  const height = source.reduce((sum, row) => sum + row.strip.height, 0) + Math.max(0, group.length - 1) * s.gap;
  const reserve = hasReaction ? s.reactionHeight + 56 : 0;
  const scale = Math.min(1.1, 948 / Math.max(1, ...source.map(row => row.strip.screenshot.width)), (s.height - 160 - reserve) / Math.max(1, height));
  const maxTop = s.height - 72 - reserve - height * scale;
  let top = single && group[0] ? clamp(300 + variant(group[0]) * 38, 80, Math.max(80, maxTop)) : Math.min(s.top, maxTop);
  const strips = source.map(({ line, strip }) => {
    const width = Math.round(strip.screenshot.width * scale), h = Math.round(strip.height * scale);
    const left = Math.round(clamp((s.width - width) / 2 + (chatSongMessageIsRight(line) ? 40 : -40), 56, s.width - width - 56));
    const placement = { lineId: line.id, left, top: Math.round(top), width, height: h, crop: { left: strip.screenshot.left, top: 0, width: strip.screenshot.width, height: strip.height } };
    top += h + Math.round(s.gap * scale);
    return placement;
  });
  return { scale, strips, reaction: { left: Math.round((s.width - s.reactionWidth) / 2 + (single && group[0] ? (chatSongMessageIsRight(group[0]) ? -96 : 96) : 0)),
    top: Math.round(Math.min(s.height - s.reactionHeight - 72, top + 24)), width: s.reactionWidth, height: s.reactionHeight } };
}

export function chatSongReactionDelay(duration: number) { return Math.min(0.38, Math.max(0.12, duration * 0.16)); }

/** These short windows keep a long video sparse while retaining every animated frame. */
export function chatSongAnimationWindows(project: ChatSongProject) {
  const s = CHAT_SONG_TEMPLATE;
  return project.timings.flatMap((timing, index) => {
    const next = project.timings[index + 1]?.start ?? project.song?.duration ?? timing.end;
    const windows = [{ start: timing.start, end: Math.min(next, timing.start + s.messageEnterSeconds) }];
    if (project.assets.some(asset => asset.kind === 'reaction' && asset.lineId === timing.lineId)) {
      const start = timing.start + chatSongReactionDelay(timing.end - timing.start);
      windows.push({ start, end: Math.min(next, start + s.reactionEnterSeconds) });
    }
    if (project.brief.messageLayout !== 'conversation' && index + 1 < project.timings.length && next - timing.end >= s.exitSeconds) windows.push({ start: next - s.exitSeconds, end: next });
    return windows.filter(window => window.end > window.start);
  });
}

export type ChatSongPose = { centerX: number; centerY: number; width: number; height: number; angle: number; opacity: number };
function pose(box: Box, line: ChatSongLine, age: number, exit: number, sticker = false): ChatSongPose {
  const s = CHAT_SONG_TEMPLATE, kind = variant(line);
  const progress = clamp(age / (sticker ? s.reactionEnterSeconds : s.messageEnterSeconds), 0, 1);
  const entry = 1 - Math.pow(1 - progress, 3);
  const zoom = sticker ? 0.76 + 0.24 * entry + 0.07 * Math.sin(Math.PI * entry) : 0.88 + 0.12 * entry;
  const width = Math.round(box.width * zoom), height = Math.round(box.height * zoom);
  const rest = (kind % 2 ? 1 : -1) * (sticker ? 2.2 : 0.65);
  const angle = rest + (kind % 2 ? -1 : 1) * (sticker ? 5 : 3.5) * (1 - entry);
  const dx = [88, -88, 20, -20][kind] * (1 - entry), dy = [16, -16, 72, -72][kind] * (1 - entry) + 18 * exit;
  const rad = angle * Math.PI / 180;
  const rotatedWidth = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
  const rotatedHeight = Math.abs(height * Math.cos(rad)) + Math.abs(width * Math.sin(rad));
  return { centerX: clamp(box.left + box.width / 2 + dx, rotatedWidth / 2 + 24, s.width - rotatedWidth / 2 - 24),
    centerY: clamp(box.top + box.height / 2 + dy, rotatedHeight / 2 + 24, s.height - rotatedHeight / 2 - 24),
    width, height, angle, opacity: entry * (1 - exit) };
}

/** Timed playback has one visibility and pose calculation; untimed editing shows a settled frame. */
export function chatSongScene(project: ChatSongProject, lines: ChatSongLine[], seconds?: number) {
  const visible = seconds === undefined ? lines : visibleChatSongLines(project, seconds);
  const single = project.brief.messageLayout !== 'conversation';
  const group = single ? visible : project.lines.filter(line => line.group === visible[0]?.group);
  const names = { A: project.brief.displayNameA || project.brief.roleA, B: project.brief.displayNameB || project.brief.roleB };
  const layout = chatSongGroupLayout(group, group.some(line => project.assets.some(asset => asset.kind === 'reaction' && asset.lineId === line.id)), single, names);
  const timingState = (line: ChatSongLine) => {
    const index = project.timings.findIndex(row => row.lineId === line.id), timing = project.timings[index], next = project.timings[index + 1];
    const age = seconds === undefined ? Infinity : seconds - (timing?.start ?? 0);
    const exit = seconds !== undefined && next && timing && next.start - timing.end >= CHAT_SONG_TEMPLATE.exitSeconds
      ? clamp((seconds - next.start + CHAT_SONG_TEMPLATE.exitSeconds) / CHAT_SONG_TEMPLATE.exitSeconds, 0, 1) : 0;
    return { age, exit, delay: chatSongReactionDelay((timing?.end ?? 2) - (timing?.start ?? 0)) };
  };
  const messages = visible.map(line => {
    const placement = layout.strips.find(row => row.lineId === line.id)!, timing = timingState(line);
    return { line, name: names[line.role], crop: placement.crop, pose: pose(placement, line, timing.age, single ? timing.exit : 0) };
  });
  const reactingLine = [...visible].reverse().find(line => project.assets.some(asset => asset.kind === 'reaction' && asset.lineId === line.id));
  const reactionTiming = reactingLine && timingState(reactingLine);
  const reaction = reactingLine && reactionTiming ? { lineId: reactingLine.id, pose: pose(layout.reaction, reactingLine, reactionTiming.age - reactionTiming.delay, single ? reactionTiming.exit : 0, true) } : null;
  return { scale: layout.scale, messages, reaction };
}
