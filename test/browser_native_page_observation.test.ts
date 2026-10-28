import './helpers';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerBrowserTaskTools } from '../server/tools/definitions/browser_task_tools';
import { hasObservedBrowserPage, browserPageUrlMatches } from '../server/desktop/browser_page';

const target='https://example.org/reference?q=one#section';
function page(url=target, extra: Record<string, unknown>={}) {
 return { source:'windows-uia', observedAt:'2026-10-28T12:00:00.000Z', url,
  title:'Reference page', documentPresent:true, textSample:'Actual reference page content.',
  loadingState:'unknown', processId:123, nativeWindowHandle:456, processName:'msedge', windowTitle:'Reference page - Browser', ...extra };
}
function setup(observations: unknown[], launch='Opened: '+target) {
 const registry=new ToolRegistry(); registerDesktopTools(registry); registerBrowserTaskTools(registry);
 const relay=vi.fn(async (name: string) => {
  if(name==='desktop_open') return launch;
  if(name==='desktop_ui_snapshot') return JSON.stringify({ status:'ok',pageObservation:observations.length>1?observations.shift():observations[0] });
  // The application may restore Lumi's foreground after launch. Its title is not page evidence.
  if(name==='desktop_active_window') return JSON.stringify({pid:999,process_name:'lumi-core.exe',title:'LumiCore'});
  throw new Error('Unexpected mutation or browser session: '+name);
 });
 return {registry,relay};
}
describe('native browser launch and actual displayed page share one owner',()=>{
 it.each(['desktop_open','browser_open_task'])('%s observes the exact document in its native window after one launch',async name=>{
  const {registry,relay}=setup([page()]);
  const result=JSON.parse(await registry.execute(name,name==='desktop_open'?{target}:{url:target,open:true},{desktopRelay:relay} as any));
  expect(hasObservedBrowserPage(result,target)).toBe(true);
  expect(result).toMatchObject({status:'verified',navigationVerified:true,pageLoadVerified:true,pageLoadState:'document_observed',actualUrl:target,actualTarget:{processId:123,nativeWindowHandle:456}});
  expect(relay.mock.calls.map(call=>call[0])).toEqual(['desktop_open','desktop_ui_snapshot']);
  expect((relay.mock.calls[1] as any)[1]).toMatchObject({root:'desktop',browserPage:{targetUrl:target}});
 });
 it('the shared tool engine verifies the observed page and refuses launch-only completion',async()=>{
  for (const observed of [page(),null]) {
   const {registry,relay}=setup([observed]);
   const record=await executeToolCall({registry,name:'browser_open_task',arguments:{url:target,open:true},context:{userId:'browser-observation-owner',authRole:'admin',domain:'personal',localExecution:true,userConfirmed:true,desktopRelay:relay} as any});
   expect(record.envelope?.status).toBe(observed?'verified_success':'target_mismatch');
   expect(record.terminalVerification?.status).toBe(observed?'verified':'failed');
  }
 },10000);
 it('a launch echo alone does not certify navigation or content',async()=>{
  const {registry,relay}=setup([null]);
  const result=JSON.parse(await registry.execute('browser_open_task',{url:target,open:true},{desktopRelay:relay} as any));
  expect(result.opened).toBe(true); expect(result.navigationVerified).toBe(false); expect(result.pageLoadVerified).toBe(false);
  expect(result.status).toBe('unverified'); expect(hasObservedBrowserPage(result,target)).toBe(false);
  expect(relay.mock.calls.filter(call=>call[0]==='desktop_open')).toHaveLength(1);
 },10000);
 it.each([['other URL',page('https://example.org/other')],['empty document',page(target,{textSample:''})],['loading document',page(target,{loadingState:'loading'})]])('does not claim a displayed target from %s',async(_label,observation)=>{
  const {registry,relay}=setup([observation]);
  const result=JSON.parse(await registry.execute('desktop_open',{target},{desktopRelay:relay} as any));
  expect(result.pageLoadVerified).toBe(false); expect(hasObservedBrowserPage(result,target)).toBe(false);
  expect(result.actualUrl).toBe((observation as any).url);
  expect(relay.mock.calls.filter(call=>call[0]==='desktop_open')).toHaveLength(1);
 },10000);
 it('retries only observation while a page changes from loading to displayed',async()=>{
  const {registry,relay}=setup([page(target,{loadingState:'loading',textSample:''}),page()]);
  const result=JSON.parse(await registry.execute('desktop_open',{target},{desktopRelay:relay} as any));
  expect(hasObservedBrowserPage(result,target)).toBe(true);
  expect(relay.mock.calls.map(call=>call[0])).toEqual(['desktop_open','desktop_ui_snapshot','desktop_ui_snapshot']);
 });
 it('does not use a same-named file acknowledgement as URL launch',async()=>{
  const {registry,relay}=setup([page()],'Opened: C:/Desktop/reference.txt');
  const result=JSON.parse(await registry.execute('browser_open_task',{url:target,open:true},{desktopRelay:relay} as any));
  expect(result.opened).toBe(false); expect(hasObservedBrowserPage(result,target)).toBe(false);
  expect(relay.mock.calls.map(call=>call[0])).toEqual(['desktop_open']);
 });
 it('stops observation after cancellation without repeating the launch',async()=>{
  const {registry,relay}=setup([page()]);
  let cancelled=false; relay.mockImplementationOnce(async()=>{cancelled=true;return 'Opened: '+target;});
  const result=JSON.parse(await registry.execute('desktop_open',{target},{desktopRelay:relay,isCancelled:()=>cancelled} as any));
  expect(result.status).toBe('cancelled'); expect(result.pageLoadVerified).toBe(false);
  expect(relay).toHaveBeenCalledTimes(1);
 });
 it('requires the source target and native window to agree, not only arguments or title',()=>{
  const observation=page(); const result={target,opened:true,status:'verified',navigationVerified:true,pageLoadVerified:true,pageLoadState:'document_observed',actualUrl:target,pageObservation:observation,actualTarget:{processId:123,nativeWindowHandle:456,processName:'msedge'}};
  expect(hasObservedBrowserPage(result,target)).toBe(true);
  expect(hasObservedBrowserPage({...result,target:'https://other.example/'},target)).toBe(false);
  expect(hasObservedBrowserPage({...result,actualTarget:{...result.actualTarget,nativeWindowHandle:888}},target)).toBe(false);
  expect(browserPageUrlMatches('https://EXAMPLE.org:443/reference?q=one#section',target)).toBe(true);
  expect(browserPageUrlMatches('https://example.org/reference?q=two#section',target)).toBe(false);
 });
});
