import React, { useId } from 'react';
import { useFileResource } from '@/hooks/useFileResource';
import type { ChatSongLine, ChatSongProject } from '../../shared/chat_song';
import { CHAT_SONG_TEMPLATE as style, chatSongGroupLayout, chatSongStripLayout } from '../../shared/chat_song_layout';

function PreviewImage({ fileId, hash, ...props }: { fileId: string; hash: string } & React.SVGProps<SVGImageElement>) {
  const resource = useFileResource(`/api/files/download/${encodeURIComponent(fileId)}?domain=personal&inline=1&v=${encodeURIComponent(hash)}`);
  return resource.url ? <image {...props} href={resource.url} /> : null;
}

/** Pixel geometry is shared with the PNG and MP4 renderers. */
export function ChatSongPreview({ project, lines }: { project: ChatSongProject; lines: ChatSongLine[] }) {
  const blurId = useId().replace(/:/g, '');
  const group = project.lines.filter(line => line.group === lines[0]?.group);
  const layout = chatSongGroupLayout(group, group.some(line => project.assets.some(asset => asset.kind === 'reaction' && asset.lineId === line.id)));
  const background = project.assets.find(asset => asset.kind === 'background');
  const reaction = [...lines].reverse().map(line => project.assets.find(asset => asset.kind === 'reaction' && asset.lineId === line.id)).find(Boolean);
  return <svg viewBox={`0 0 ${style.width} ${style.height}`} className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id={blurId}><feGaussianBlur stdDeviation="12" /></filter></defs>
    <rect width={style.width} height={style.height} fill="#263338" />
    {background && <PreviewImage fileId={background.fileId} hash={background.sha256} width={style.width} height={style.height} preserveAspectRatio="xMidYMid slice" opacity={0.55} filter={`url(#${blurId})`} />}
    {lines.map(line => {
      const strip = chatSongStripLayout(line), position = layout.strips.find(row => row.lineId === line.id)!;
      const avatar = project.assets.find(asset => asset.kind === `avatar${line.role}`);
      return <g key={line.id} transform={`translate(${position.left} ${position.top}) scale(${position.width / style.stripWidth} ${position.height / strip.height})`}>
        <rect width={style.stripWidth} height={strip.height} fill="#ededed" />
        <rect x={strip.bubbleX} y={16} width={strip.bubbleWidth} height={strip.height - 32} rx={18} fill={line.role === 'B' ? '#9eea6a' : '#ffffff'} />
        <rect x={strip.avatarX} y={strip.avatarY} width={style.avatarSize} height={style.avatarSize} rx={12} fill="#46515d" />
        <text x={strip.avatarX + 60} y={strip.avatarY + 80} textAnchor="middle" fontFamily="sans-serif" fontSize={56} fill="white">{line.role}</text>
        {avatar && <PreviewImage fileId={avatar.fileId} hash={avatar.sha256} x={strip.avatarX} y={strip.avatarY} width={style.avatarSize} height={style.avatarSize} preserveAspectRatio="xMidYMid slice" />}
        {strip.rows.map((row, index) => <text key={index} x={strip.textX} y={strip.textTop + style.fontSize + index * style.lineHeight} fontFamily="Microsoft YaHei, Noto Sans CJK SC, sans-serif" fontSize={style.fontSize} fill="#111111" xmlSpace="preserve">{row}</text>)}
      </g>;
    })}
    {reaction && <PreviewImage fileId={reaction.fileId} hash={reaction.sha256} x={layout.reaction.left} y={layout.reaction.top} width={layout.reaction.width} height={layout.reaction.height} preserveAspectRatio="xMidYMid meet" />}
  </svg>;
}
