import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureNativeUiSnapshot } from '../server/external_control/native_ui';
import { buildWindowsBrowserPageScript } from '../server/external_control/windows_uia';

describe.skipIf(process.platform !== 'win32')('native browser page reader interop',()=>{
 it('parses the actual generated PowerShell and compiles its COM adapter without inspecting the desktop',()=>{
  const script=buildWindowsBrowserPageScript({browserPage:{targetUrl:"https://example.org/reference?quote='value'",processNames:['msedge','chrome.exe']}});
  const cs=script.match(/Add-Type @"\n([\s\S]*?)\n"@/)?.[1];
  expect(cs).toBeTruthy();
  const check=["$ErrorActionPreference='Stop'",'$tokens=$null;$errors=$null',
   '[void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('+JSON.stringify(Buffer.from(script).toString('base64'))+')), [ref]$tokens,[ref]$errors)',
   'if($errors.Count){throw ($errors | Out-String)}', 'Add-Type @"',cs,'"@',
   '[ordered]@{parsed=$true; compiled=[LumiBrowserUia.DocumentProperties].FullName} | ConvertTo-Json -Compress'].join('\n');
  const folder=mkdtempSync(join(tmpdir(),'lumi-uia-browser-parser-'));
  try {
   const file=join(folder,'compile-only.ps1'); writeFileSync(file,check,'utf8');
   const output=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',file],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']});
   expect(JSON.parse(output)).toEqual({parsed:true,compiled:'LumiBrowserUia.DocumentProperties'});
  } finally { rmSync(folder,{recursive:true,force:true}); }

 });
});

describe('browser observation platform capability',()=>{
 it('reports unsupported on macOS instead of substituting an unrelated desktop snapshot',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  try {
   Object.defineProperty(process,'platform',{value:'darwin'});
   await expect(captureNativeUiSnapshot({browserPage:{targetUrl:'https://example.org/',processNames:['safari']}})).resolves.toMatchObject({status:'not_supported',platform:'darwin'});
  } finally {Object.defineProperty(process,'platform',descriptor);}
 });
});
