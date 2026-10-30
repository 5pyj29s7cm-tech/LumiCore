// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EcommerceDraftRecovery } from '../src/components/EcommerceDraftRecovery';
const reply=(body:unknown,status=200)=>({ok:status<400,status,json:async()=>body});
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn(),warning:vi.fn()}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('saves real imported rows and restores them into the real workbench after remount',async()=>{
  let record:any=null;const requests:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{requests.push({url,init});if(init.method==='PUT'){record={draft:JSON.parse(String(init.body)).draft};return reply({persisted:true,record});}return reply({record});}));
  const view=render(<EcommerceDraftRecovery lang="en" initialReportKind="orders"/>);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'order_id,sku,paid_amount,product_cost\nO-1,SKU-1,100,40'}});fireEvent.click(screen.getByRole('button',{name:'Analyze pasted data'}));
  fireEvent.click(screen.getByRole('button',{name:'Save draft to this account'}));await screen.findByText('Draft saved');expect(record.draft.sources.orders.table.rows).toHaveLength(1);
  view.unmount();render(<EcommerceDraftRecovery lang="en" initialReportKind="orders"/>);fireEvent.click(screen.getByRole('button',{name:'Restore saved draft'}));await screen.findByText('Pasted data');
  expect(requests).toHaveLength(2);expect(requests.every(item=>item.url.includes('/api/business/drafts/ecommerce/_unbound'))).toBe(true);
});
it('restores archived source rows, mappings and assumptions without repeating verification',async()=>{
  const task={id:'archive-fixture',title:'Saved diagnosis',status:'delivered',metadata:{industryWorkflow:{entryId:'store-data',originalReports:{orders:{headers:['order_id','sku','paid_amount'],rows:[{order_id:'O-1',sku:'A',paid_amount:100}]}},originalColumnMappings:{orders:{sku:'sku'}},normalizedInputSummary:{platform:'generic',sources:[{kind:'orders',sourceName:'original.csv'}],assumptions:{grossMarginPercent:42,targetStockDays:20}}}}};
  const calls:RequestInit[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{calls.push(init);return reply(url.includes('?entryId')?{tasks:[task],nextCursor:null}:{task});}));
  render(<EcommerceDraftRecovery lang="en" initialReportKind="orders"/>);fireEvent.click(screen.getByRole('button',{name:'Load archived diagnoses'}));fireEvent.click(await screen.findByRole('button',{name:'Restore archive input: Saved diagnosis'}));
  await screen.findByText('original.csv');expect(screen.getAllByRole('spinbutton',{hidden:true})[0]).toHaveProperty('value','42');expect(calls.every(init=>!init.method)).toBe(true);
});
