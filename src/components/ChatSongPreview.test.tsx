// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSongPreview } from './ChatSongPreview';
import { CHAT_SONG_DEFAULT_BRIEF, type ChatSongProject } from '../../shared/chat_song';
import { chatSongScene } from '../../shared/chat_song_layout';
vi.mock('@/hooks/useFileResource', () => ({ useFileResource: (url: string) => ({ url: 'blob:' + url }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const project: ChatSongProject = { id:'11111111-1111-4111-8111-111111111111',revision:2,scriptRevision:1,title:'Synthetic preview',brief:{...CHAT_SONG_DEFAULT_BRIEF,displayNameA:'林律师',displayNameB:'陈女士'},lines:[{id:'01',role:'A',text:'模拟核对',group:1,reaction:'惊讶'},{id:'02',role:'B',text:'模拟补充',group:1,reaction:''}],assets:[{id:'meme',kind:'reaction',lineId:'01',fileId:'meme.png',name:'Synthetic',sha256:'sha'}],scriptLocked:true,song:{fileId:'song.wav',name:'Synthetic',sha256:'song',duration:6,scriptRevision:1,confirmed:false},timings:[{lineId:'01',start:1,end:2.5},{lineId:'02',start:4,end:5.5}],updatedAt:'2026-10-18T00:00:00Z'};
it('uses the same timed pose as export and never exposes the next message early',()=>{
  const {container,rerender}=render(<ChatSongPreview project={project} lines={project.lines} seconds={0.9}/>);
  expect(screen.queryByText('模拟核对')).toBeNull();expect(container.querySelector('rect[fill="#f7f7f7"]')).toBeNull();
  rerender(<ChatSongPreview project={project} lines={project.lines} seconds={1.1}/>);
  const scene=chatSongScene(project,[],1.1),message=scene.messages[0];
  const group=screen.getByText('林律师').parentElement!;
  expect(group.getAttribute('opacity')).toBe(String(message.pose.opacity));
  expect(group.getAttribute('transform')).toContain(`translate(${message.pose.centerX} ${message.pose.centerY}) rotate(${message.pose.angle})`);
  expect(container.querySelector('image')!.parentElement!.getAttribute('opacity')).toBe('0');
  expect(screen.queryByText('模拟补充')).toBeNull();expect(container.querySelector('animate')).toBeNull();
  rerender(<ChatSongPreview project={project} lines={project.lines} seconds={1.8}/>);
  const sticker=chatSongScene(project,[],1.8).reaction!.pose;
  expect(container.querySelector('image')!.getAttribute('width')).toBe(String(sticker.width));
  expect(container.querySelector('image')!.parentElement!.getAttribute('opacity')).toBe('1');
  rerender(<ChatSongPreview project={project} lines={project.lines} seconds={4.04}/>);
  expect(screen.queryByText('模拟核对')).toBeNull();expect(screen.getByText('模拟补充')).toBeTruthy();
});
it('keeps untimed editing settled without creating another animation clock',()=>{
  const {container}=render(<ChatSongPreview project={project} lines={[project.lines[0]]}/>);
  expect(screen.getByText('林律师').parentElement!.getAttribute('opacity')).toBe('1');
  expect(container.querySelector('animate')).toBeNull();
  expect(container.querySelector('rect[fill="#11161c"]')).toBeTruthy();
});
it('samples the existing audio player at frame cadence without rerendering the workbench clock',()=>{
  const audio=document.createElement('audio');let paused=true,id=0;
  Object.defineProperty(audio,'paused',{get:()=>paused});
  const pending=new Map<number,FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{pending.set(++id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(frame:number)=>pending.delete(frame));
  audio.currentTime=1.1;
  const {unmount}=render(<ChatSongPreview project={project} lines={[]} seconds={1.1} audioRef={{current:audio}}/>);
  act(()=>{paused=false;audio.dispatchEvent(new Event('play'));});
  act(()=>{audio.currentTime=1.18;const [frame,callback]=pending.entries().next().value!;pending.delete(frame);callback(100);});
  const pose=chatSongScene(project,[],1.18).messages[0].pose;
  expect(screen.getByText('林律师').parentElement!.getAttribute('opacity')).toBe(String(pose.opacity));
  expect(pending.size).toBe(1);
  act(()=>{paused=true;audio.dispatchEvent(new Event('pause'));});
  expect(pending.size).toBe(0);
  unmount();expect(pending.size).toBe(0);
});
it('updates a paused seek from the same audio element and removes listeners on unmount',()=>{
  const audio=document.createElement('audio'),remove=vi.spyOn(audio,'removeEventListener');
  vi.stubGlobal('requestAnimationFrame',vi.fn());vi.stubGlobal('cancelAnimationFrame',vi.fn());
  const {unmount}=render(<ChatSongPreview project={project} lines={[]} seconds={1.1} audioRef={{current:audio}}/>);
  act(()=>{audio.currentTime=4.04;audio.dispatchEvent(new Event('seeked'));});
  expect(screen.getByText('模拟补充')).toBeTruthy();expect(screen.queryByText('模拟核对')).toBeNull();
  unmount();expect(remove.mock.calls.map(([name])=>name)).toEqual(['play','pause','ended','seeking','seeked']);
});
