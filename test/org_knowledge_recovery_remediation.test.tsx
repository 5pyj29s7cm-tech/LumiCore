// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgeBaseBrowser } from '../src/components/org/KnowledgeBaseBrowser';
vi.mock('../src/lib/useT',()=>({useT:()=>({langCode:'en'})}));
vi.mock('../src/hooks/useFileDrop',()=>({useFileDrop:()=>({props:{},dragging:false})}));
vi.mock('../src/i18n/uiMessages',()=>({uiMessage:(key:string)=>key,formatUiMessage:(key:string)=>key}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn()}}));
const reply=(data:unknown,status=200)=>({ok:status<400,status,json:async()=>data});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('rejects malformed successful article data and permits retry instead of displaying an empty success',async()=>{
  let malformed=true;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/articles')?reply(malformed?{articles:'invalid'}:[{id:'a',title:'Recovered source',content:'Exact body',category:'general',tags:[],status:'draft',authorId:'fixture',createdAt:'2026-10-30T00:00:00Z'}]):reply({},503)));
  render(<KnowledgeBaseBrowser/>);expect((await screen.findByRole('alert')).textContent).toContain('invalid article list');
  malformed=false;fireEvent.click(screen.getByTitle('knowledge-base-browser.refresh.cba212b169'));await screen.findAllByText('Recovered source');expect(screen.queryByRole('alert')).toBeNull();
});
it('turns a stalled list request into a retryable timeout without overwriting later source data',async()=>{
  const controller=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
  vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('Fixture deadline reached'))))));
  render(<KnowledgeBaseBrowser/>);act(()=>controller.abort(new Error('Fixture deadline reached')));expect((await screen.findByRole('alert')).textContent).toContain('Fixture deadline reached');expect(screen.getByTitle('knowledge-base-browser.refresh.cba212b169')).toHaveProperty('disabled',false);
});
