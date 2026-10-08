import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function targetSnapshot(contact: string) {
  return JSON.stringify({ root: { name: '微信', bounds: { x: 0, y: 0, width: 1000, height: 800 }, children: [
    { name: contact, controlType: 'Text' }, { name: '消息输入', controlType: 'Edit', bounds: { y: 650, width: 700 } },
  ] } });
}
function relay(snapshot: string) {
  return vi.fn(async (name: string, _args: any) => {
    if (name === 'desktop_active_window') return JSON.stringify({ title: '微信', processName: 'Weixin.exe', bounds: { x: 0, y: 0, width: 1000, height: 800 } });
    if (name === 'desktop_ui_snapshot') return snapshot;
    return JSON.stringify({ ok: true });
  });
}
it.each([
  ['wechat_send_message', true], ['wechat_send_message', false],
  ['wechat_send_file', true], ['wechat_send_file', false],
] as const)('%s rejects an unverified recipient before entering the payload (search=%s)', async (tool, useSearch) => {
  const registry = new ToolRegistry(); registerExternalAppTools(registry);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_recipient_boundary_'));
  const filePath = path.join(dir, 'synthetic.txt'); fs.writeFileSync(filePath, 'Synthetic file');
  const desktopRelay = relay(targetSnapshot('Wrong recipient'));
  try {
    const pending = registry.get(tool)!.handler({ contact: 'Requested recipient', useSearch, message: 'Synthetic message', filePath },
      { desktopRelay } as any);
    const settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.runAllTimersAsync();
    expect((await settled).error?.message).toMatch(/conversation was not verified/);
    expect(desktopRelay.mock.calls.some(([name, args]) => name === 'desktop_clipboard_write' && args.text === 'Synthetic message')).toBe(false);
    expect(desktopRelay.mock.calls.some(([name]) => name === 'desktop_clipboard_write_files')).toBe(false);
    expect(desktopRelay.mock.calls.some(([name]) => name === 'desktop_mouse_click_at')).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it.each(['wechat_send_message', 'wechat_send_file'])('%s rejects an unresolved recipient without opening or searching', async tool => {
  const registry = new ToolRegistry(); registerExternalAppTools(registry);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_pronoun_boundary_'));
  const filePath = path.join(dir, 'synthetic.txt'); fs.writeFileSync(filePath, 'Synthetic file');
  const desktopRelay = relay(targetSnapshot('Any recipient'));
  try {
    const settled = Promise.resolve(registry.get(tool)!.handler({ contact: '他', message: 'Synthetic message', filePath }, { desktopRelay } as any))
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.runAllTimersAsync();
    expect((await settled).error?.message).toMatch(/Recipient pronoun/);
    expect(desktopRelay).not.toHaveBeenCalled();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it('shares CAD geometry parameters without aliasing mutable objects or mixing output contracts', () => {
  const registry = new ToolRegistry(); registerExternalAppTools(registry);
  const operations = registry.get('cad_prepare_autocad_operations')!.parameters.properties;
  const dxf = registry.get('cad_generate_dxf')!.parameters.properties;
  expect(operations.width).toEqual(dxf.width);
  expect(operations.walls).toEqual(dxf.walls);
  expect(operations.walls).not.toBe(dxf.walls);
  expect(operations.walls.items).not.toBe(dxf.walls.items);
  expect(operations.geometryReceiptPath).toEqual(dxf.geometryReceiptPath);
  expect(operations.cornerRadius).toEqual(dxf.cornerRadius);
  expect(registry.get('cad_prepare_autocad_operations')!.description).toContain('does not launch AutoCAD');
  expect(registry.get('cad_generate_dxf')!.description).toContain('explicitly requested DXF');
});
