import { useEffect, useRef, useState } from 'react';
import type { MemoryAvatar, MemoryAvatarAnimation, MemoryAvatarMedia } from '../../shared/memory_avatar';
import { memoryAvatarService } from '../services/memoryAvatarService';
import { memoryAvatarMediaService } from '../services/memoryAvatarMediaService';
import { avatarAnimationCopy } from '../i18n/locales/avatarAnimation';

export function MemoryAvatarAnimationEditor({avatar,locale,disabled,onUpdated,onBeforeMutation,onBusyChange}:{avatar:MemoryAvatar;locale:'zh'|'en';disabled:boolean;onUpdated:(avatar:MemoryAvatar)=>void;onBeforeMutation?:()=>void|Promise<void>;onBusyChange:(busy:boolean)=>void}){
  const copy=avatarAnimationCopy(locale),current=avatar.presentation?.animation;
  const [media,setMedia]=useState<MemoryAvatarMedia[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [config,setConfig]=useState<MemoryAvatarAnimation>(current||{idleMediaId:'',blinkInterval:5,breathing:.4,backgroundMotion:true});
  const mutation=useRef<AbortController|null>(null),mounted=useRef(false),notifyBusy=useRef(onBusyChange);notifyBusy.current=onBusyChange;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;mutation.current?.abort();notifyBusy.current(false);};},[]);
  useEffect(()=>{const controller=new AbortController();setConfig(current||{idleMediaId:'',blinkInterval:5,breathing:.4,backgroundMotion:true});
    void memoryAvatarMediaService.list(avatar.id,controller.signal).then(result=>{if(!controller.signal.aborted)setMedia(result.media.filter(m=>m.kind==='image'&&m.hasThumbnail));}).catch(()=>{if(!controller.signal.aborted)setNotice(copy.loadError);});
    return()=>controller.abort();
  },[avatar.id,avatar.revision,current,copy.loadError]);
  const save=async()=>{if(disabled||mutation.current||!config.idleMediaId)return;const controller=new AbortController();mutation.current=controller;setBusy(true);onBusyChange(true);setNotice('');
    try{await onBeforeMutation?.();controller.signal.throwIfAborted();const result=await memoryAvatarService.update(avatar.id,{revision:avatar.revision,presentation:{mode:'localportrait',mediaId:config.idleMediaId,animation:config}},controller.signal);if(mounted.current&&!controller.signal.aborted){onUpdated(result);setNotice(copy.saved);}}
    catch{if(mounted.current&&!controller.signal.aborted)setNotice(copy.error);}finally{mutation.current=null;if(mounted.current){setBusy(false);onBusyChange(false);}}
  };
  return <section className="space-y-3 rounded-xl border border-white/10 p-4" aria-label={copy.title}><h4 className="text-sm text-white/85">{copy.title}</h4><p className="text-xs leading-5 text-white/55">{copy.hint}</p>
    <fieldset disabled={disabled||busy} className="space-y-3">
      {(['idleMediaId','blinkMediaId','speakMediaId'] as const).map((key,index)=><label className="block text-xs text-white/65" key={key}>{[copy.idle,copy.blink,copy.speech][index]}<select className="mt-1 block w-full rounded-lg bg-[#192224] p-2" value={config[key]||''} onChange={event=>setConfig(c=>({...c,[key]:event.target.value||undefined}))}><option value="">{copy.none}</option>{media.map(m=><option key={m.id} value={m.id}>{m.title}</option>)}</select></label>)}
      <label className="block text-xs text-white/65">{copy.interval}<input type="number" min={2} max={12} step={.5} value={config.blinkInterval} onChange={e=>setConfig(c=>({...c,blinkInterval:Number(e.target.value)}))} className="ml-3 w-16 rounded bg-[#192224] p-1" /></label>
      <label className="block text-xs text-white/65">{copy.breathing}<input className="ml-3" type="range" min={0} max={1} step={.05} value={config.breathing} onChange={e=>setConfig(c=>({...c,breathing:Number(e.target.value)}))}/></label>
      <label className="flex gap-2 text-xs text-white/65"><input type="checkbox" checked={config.backgroundMotion} onChange={e=>setConfig(c=>({...c,backgroundMotion:e.target.checked}))}/>{copy.background}</label>
      <button type="button" disabled={!config.idleMediaId} onClick={()=>void save()} className="rounded-lg bg-[#c5baa2]/20 px-3 py-2 text-xs text-[#ddd4bf] disabled:opacity-40">{copy.save}</button>
    </fieldset><p className="text-xs leading-5 text-white/40">{copy.missing}</p>{notice&&<p role={notice===copy.saved?'status':'alert'} className="text-xs text-[#ddd4bf]">{notice}</p>}
  </section>;
}
