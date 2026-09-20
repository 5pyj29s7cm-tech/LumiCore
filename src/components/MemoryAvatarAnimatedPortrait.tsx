import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { MemoryAvatarAnimation } from '../../shared/memory_avatar';
import { loadMemoryAvatarMediaResource } from '../services/memoryAvatarMediaService';
import { portraitAnimationFrame } from '../lib/memoryAvatarAnimation';
import { avatarAnimationCopy } from '../i18n/locales/avatarAnimation';

export function MemoryAvatarAnimatedPortrait({avatarId, animation, outputLevelRef, name, locale}: {avatarId:string;animation:MemoryAvatarAnimation;outputLevelRef:MutableRefObject<number>;name:string;locale:'zh'|'en'}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const copy=avatarAnimationCopy(locale);
  useEffect(()=>{
    const controller=new AbortController();let frame=0;const releases:Array<()=>void>=[];
    setStatus('loading');
    const load=async(id:string|undefined)=>{
      if(!id)return null;
      const resource=await loadMemoryAvatarMediaResource(avatarId,id,'original',controller.signal);
      if(controller.signal.aborted){resource.release();throw new DOMException('Cancelled','AbortError');}
      releases.push(resource.release);
      const image=new Image();image.src=resource.url;await image.decode();controller.signal.throwIfAborted();return image;
    };
    void Promise.all([load(animation.idleMediaId),load(animation.blinkMediaId),load(animation.speakMediaId)]).then(([idle,blink,speech])=>{
      const element=canvas.current,ctx=element?.getContext('2d');if(!idle||!element||!ctx||controller.signal.aborted)return;
      const start=performance.now();let previous=start,smoothed=0;
      const motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
      const draw=(now:number)=>{
        if(controller.signal.aborted)return;
        const width=Math.max(1,Math.round(element.clientWidth*Math.min(devicePixelRatio||1,2))),height=Math.max(1,Math.round(element.clientHeight*Math.min(devicePixelRatio||1,2)));
        if(element.width!==width||element.height!==height){element.width=width;element.height=height;}
        const dt=Math.min((now-previous)/1000,.1);previous=now;
        const target=Math.max(0,Number(outputLevelRef.current)||0);smoothed+=(target-smoothed)*(1-Math.exp(-18*dt));if(target===0&&smoothed<.00001)smoothed=0;
        const t=(now-start)/1000,state=portraitAnimationFrame(t,smoothed,animation,Boolean(motion?.matches));
        ctx.fillStyle='#11191c';ctx.fillRect(0,0,width,height);
        const scale=Math.min(width/idle.width,height/idle.height)*(1+state.breath*.003);
        const w=idle.width*scale,h=idle.height*scale,x=(width-w)/2,y=(height-h)/2+state.breath*height*.0015;
        ctx.globalAlpha=1;ctx.drawImage(idle,x,y,w,h);
        if(speech&&state.speech>0){ctx.globalAlpha=state.speech;ctx.drawImage(speech,x,y,w,h);}
        if(blink&&state.blink>.001){ctx.globalAlpha=state.blink;ctx.drawImage(blink,x,y,w,h);}
        ctx.globalAlpha=1;
        if(state.ambience){
          // Ambient particles are separate from the image; they never simulate mouth motion.
          ctx.fillStyle='rgba(231,228,203,.25)';
          for(let i=0;i<16;i++){const px=((i*.618+t*.002)%1)*width,py=((i*.381-t*.003+100)%1)*height;ctx.beginPath();ctx.arc(px,py,Math.max(.5,width*.0008),0,Math.PI*2);ctx.fill();}
        }
        frame=requestAnimationFrame(draw);
      };
      setStatus('ready');frame=requestAnimationFrame(draw);
    }).catch(()=>{if(!controller.signal.aborted)setStatus('error');});
    return()=>{controller.abort();cancelAnimationFrame(frame);releases.forEach(release=>release());};
  },[avatarId,animation,outputLevelRef]);
  return <div role="figure" aria-label={name} data-avatar-animation="localportrait" style={{position:'relative',width:'100%',height:'100%',minHeight:320}}>
    <canvas ref={canvas} aria-label={name} style={{width:'100%',height:'100%',display:'block'}} />
    {status!=='ready'&&<p role="status" className="absolute inset-0 grid place-content-center p-8 text-center text-sm text-white/70">{status==='error'?copy.loadError:copy.loading}</p>}
  </div>;
}
