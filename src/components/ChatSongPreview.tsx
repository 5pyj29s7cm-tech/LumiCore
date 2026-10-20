import React, { useEffect, useId, useState } from 'react';
import { useFileResource } from '@/hooks/useFileResource';
import type { ChatSongLine, ChatSongProject } from '../../shared/chat_song';
import { CHAT_SONG_TEMPLATE as style, chatSongMessageIsRight, chatSongScene, chatSongStripLayout } from '../../shared/chat_song_layout';

function PreviewImage({ fileId, hash, ...props }: { fileId: string; hash: string } & React.SVGProps<SVGImageElement>) {
  const resource = useFileResource(`/api/files/download/${encodeURIComponent(fileId)}?domain=personal&inline=1&v=${encodeURIComponent(hash)}`);
  return resource.url ? <image {...props} href={resource.url} /> : null;
}

/** Sample the existing player, without advancing a separate animation clock. */
function useAudioTime(seconds: number | undefined, audioRef: React.RefObject<HTMLAudioElement | null> | undefined, projectId: string) {
  const [sample, setSample] = useState(seconds);
  const timed = seconds !== undefined;
  useEffect(() => { if (!audioRef?.current || audioRef.current.paused) setSample(seconds); }, [seconds, audioRef, projectId]);
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio || !timed) return;
    let frame = 0, last = -Infinity;
    const update = () => setSample(audio.currentTime);
    const stop = () => { cancelAnimationFrame(frame); frame = 0; update(); };
    const draw = (now: number) => {
      if (now - last >= 1000 / style.fps) { update(); last = now; }
      if (!audio.paused && !audio.ended) frame = requestAnimationFrame(draw);
    };
    const play = () => { cancelAnimationFrame(frame); last = -Infinity; frame = requestAnimationFrame(draw); };
    audio.addEventListener('play', play); audio.addEventListener('pause', stop); audio.addEventListener('ended', stop);
    audio.addEventListener('seeking', update); audio.addEventListener('seeked', update);
    if (!audio.paused && !audio.ended) play();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener('play', play); audio.removeEventListener('pause', stop); audio.removeEventListener('ended', stop);
      audio.removeEventListener('seeking', update); audio.removeEventListener('seeked', update);
    };
  }, [audioRef, timed, projectId]);
  return audioRef && timed ? sample ?? seconds : seconds;
}

/** Pixel geometry and poses are shared with the PNG and MP4 renderers. */
export function ChatSongPreview({ project, lines, seconds, audioRef }: { project: ChatSongProject; lines: ChatSongLine[]; seconds?: number; audioRef?: React.RefObject<HTMLAudioElement | null> }) {
  const blurId = useId().replace(/:/g, '');
  const time = useAudioTime(seconds, audioRef, project.id);
  const scene = chatSongScene(project, lines, time);
  const background = project.assets.find(asset => asset.kind === 'background');
  const reaction = scene.reaction && project.assets.find(asset => asset.kind === 'reaction' && asset.lineId === scene.reaction!.lineId);
  return <svg viewBox={`0 0 ${style.width} ${style.height}`} className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id={blurId}><feGaussianBlur stdDeviation={style.backgroundBlur} /></filter></defs>
    <rect width={style.width} height={style.height} fill={style.background} />
    {background && <PreviewImage fileId={background.fileId} hash={background.sha256} width={style.width} height={style.height} preserveAspectRatio="xMidYMid slice" opacity={style.backgroundOpacity} filter={`url(#${blurId})`} />}
    {scene.messages.map(({ line, name, crop, pose }) => {
      const avatar = project.assets.find(asset => asset.kind === `avatar${line.role}`);
      const strip = chatSongStripLayout(line, name);
      const right = chatSongMessageIsRight(line);
      const fill = right ? style.outgoingBubble : style.incomingBubble;
      const tailX = right ? strip.bubbleX + strip.bubbleWidth : strip.bubbleX;
      const avatarClip = blurId + '-' + line.id;
      return <g key={line.id} opacity={pose.opacity} transform={`translate(${pose.centerX} ${pose.centerY}) rotate(${pose.angle}) scale(${pose.width / crop.width} ${pose.height / crop.height}) translate(${-crop.left - crop.width / 2} ${-crop.height / 2})`}>
        <rect x={strip.screenshot.left} y={0} width={strip.screenshot.width} height={strip.height} fill={style.screenshotFill} />
        <text x={right ? strip.bubbleX + strip.bubbleWidth : strip.bubbleX} y={30} textAnchor={right ? 'end' : 'start'} fontFamily="Microsoft YaHei, Noto Sans CJK SC, sans-serif" fontSize={28} fill={style.nameColor}>{name}</text>
        <rect x={strip.bubbleX} y={44} width={strip.bubbleWidth} height={strip.height - 58} rx={18} fill={fill} />
        <polygon points={tailX + ",72 " + (tailX + (right ? 12 : -12)) + ",84 " + tailX + ",96"} fill={fill} />
        <rect x={strip.avatarX} y={strip.avatarY} width={style.avatarSize} height={style.avatarSize} rx={16} fill="#46515d" />
        <text x={strip.avatarX + 50} y={strip.avatarY + 68} textAnchor="middle" fontFamily="sans-serif" fontSize={46} fill="white">{line.role}</text>
        {avatar && <><defs><clipPath id={avatarClip}><rect x={strip.avatarX} y={strip.avatarY} width={style.avatarSize} height={style.avatarSize} rx={16} /></clipPath></defs><PreviewImage fileId={avatar.fileId} hash={avatar.sha256} x={strip.avatarX} y={strip.avatarY} width={style.avatarSize} height={style.avatarSize} preserveAspectRatio="xMidYMid slice" clipPath={"url(#" + avatarClip + ")"} /></>}
        {strip.rows.map((row, index) => <text key={index} x={strip.textX} y={strip.textTop + style.fontSize + index * style.lineHeight} fontFamily="Microsoft YaHei, Noto Sans CJK SC, sans-serif" fontSize={style.fontSize} fill="#111111" xmlSpace="preserve">{row}</text>)}
      </g>;
    })}
    {reaction && scene.reaction && <g opacity={scene.reaction.pose.opacity} transform={`translate(${scene.reaction.pose.centerX} ${scene.reaction.pose.centerY}) rotate(${scene.reaction.pose.angle})`}><PreviewImage fileId={reaction.fileId} hash={reaction.sha256} x={-scene.reaction.pose.width / 2} y={-scene.reaction.pose.height / 2} width={scene.reaction.pose.width} height={scene.reaction.pose.height} preserveAspectRatio="xMidYMid meet" /></g>}
  </svg>;
}
