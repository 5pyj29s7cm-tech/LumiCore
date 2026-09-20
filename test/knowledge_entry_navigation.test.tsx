// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const gate=vi.hoisted(()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};});
vi.mock('../src/components/KnowledgeBase',async()=>{await gate.promise;return{KnowledgeBase:({isOpen,onClose}:any)=>isOpen?<button onClick={onClose}>Loaded knowledge close</button>:null};});
import { KnowledgeBaseEntry } from '../src/components/KnowledgeBaseEntry';
afterEach(cleanup);

it('owns an opaque knowledge page during a cold chunk load and closing prevents a late reopen',async()=>{
  const close=vi.fn(),props={isOpen:true,onClose:close,t:{knowledgeBase:'Knowledge',loading:'Loading',close:'Close'}};
  const view=render(<KnowledgeBaseEntry {...props}/>);
  const surface=screen.getByRole('region',{name:'Knowledge'});
  expect(getComputedStyle(surface).display).toBe('block');
  expect(getComputedStyle(surface).backgroundColor).toBe('rgb(8, 8, 18)');
  expect(surface.style.opacity).not.toBe('0');expect(surface.style.clipPath).toBe('');
  expect(screen.getByRole('status').textContent).toContain('Knowledge');
  fireEvent.click(screen.getByRole('button',{name:'Close'}));expect(close).toHaveBeenCalledOnce();
  view.rerender(<KnowledgeBaseEntry {...props} isOpen={false}/>);
  await act(async()=>{gate.resolve();await gate.promise;});
  expect(getComputedStyle(surface).display).toBe('none');
  expect(screen.queryByRole('button',{name:'Loaded knowledge close'})).toBeNull();
  view.rerender(<KnowledgeBaseEntry {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Loaded knowledge close'}));expect(close).toHaveBeenCalledTimes(2);
  expect(getComputedStyle(surface).display).toBe('block');
});
