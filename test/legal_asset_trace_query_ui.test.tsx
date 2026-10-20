// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { setLocale } from '../src/i18n/runtime';
vi.mock('../src/contexts/AppContext',()=>({useApp:()=>({workDomain:'personal',orgConnection:null,user:{uid:'synthetic-main-quick-owner'}})}));
beforeEach(()=>{localStorage.clear();sessionStorage.clear();setLocale('en');vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected external request'));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const name='Synthetic quick scan company',text='- 名称: '+name+'\n- 状态: Active\n- 注册资本: 10万元\n- 成立日期: 2020-01-02\nQCC registration raw tail: SYNTHETIC-REGISTRATION-TAIL\nEnforcement source requires authorization.';
const caseFile={id:'synthetic-quick-case',title:'Synthetic local case',stage:'consultation',materials:[]} as any;
async function start(ok:boolean){vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({text,receipt:{ok,status:ok?'observed':'partial'},verification:{status:ok?'verified':'failed'},caseUpdates:[]}),{status:200,headers:{'Content-Type':'application/json'}}));const writer=vi.fn(async()=>true);render(<LegalAssetTrace caseFile={caseFile} onAddMaterial={writer}/>);const input=document.querySelector('input')!;fireEvent.change(input,{target:{value:name}});fireEvent.keyDown(input,{key:'Enter'});await screen.findByText(name);await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));return writer;}
describe('Main quick scan uses the existing one-call page API',()=>{
 it('requests only quick trace without implicit equity traversal or automatic case persistence',async()=>{await start(true);const [url,init]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toContain('/api/legal/tool/legal_trace_assets');expect(JSON.parse(String(init?.body)).args).toMatchObject({name,persistCase:false,caseId:caseFile.id});expect(screen.getByRole('button',{name:/archive to case/i})).toBeTruthy();});
 it('only starts equity tracing after the user explicitly chooses it',async()=>{await start(true);expect(fetch).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:/·.*Equity/i}));await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain('/api/legal/tool/legal_equity_penetration');});
 it('retains actual registration fields while a missing risk source cannot become a successful case archive',async()=>{const writer=await start(false);expect(screen.getByText('Active')).toBeTruthy();expect(screen.getByText('10万元')).toBeTruthy();expect(screen.queryByRole('button',{name:/archive to case/i})).toBeNull();expect(writer).not.toHaveBeenCalled();expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes('legal_equity_penetration'))).toBe(false);});
});
