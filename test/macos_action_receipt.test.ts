import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync('server/external_control/macos_accessibility.ts', 'utf8');
const jxa = source.split('const MACOS_ACCESSIBILITY_JXA = String.raw`')[1].split('\n`;')[0];
function fixture(input: any) {
  let presses = 0;
  const element = (name: string, role: string, id: string, children: any[] = []) => ({
    name: () => name, role: () => role, subrole: () => '', description: () => role, position: () => [1, 2], size: () => [10, 10], enabled: () => true, uiElements: () => children,
    attributes: { byName: (key: string) => ({ value: () => key === 'AXIdentifier' ? id : '' }) },
    actions: () => [{ name: () => 'AXPress', perform: () => { presses++; } }],
  });
  const button = element('Save', 'AXButton', 'save'); const window = element('Document', 'AXWindow', 'window', [button]);
  const process = { name: () => 'Editor', unixId: () => 42, frontmost: () => true, windows: () => [window] };
  const receipt = JSON.parse(vm.runInNewContext(jxa, {
    ObjC: { import() {}, unwrap: (value: any) => value }, $: { getenv: () => JSON.stringify(input) },
    Application: () => ({ applicationProcesses: () => [process] }), delay() {},
  }));
  return { presses, receipt };
}
describe('macOS action and observation selectors', () => {
  it.each([{ name: 'Save' }, { automationId: 'save' }])('locates a control and returns its post-action receipt (%j)', selector => {
    const result = fixture({ kind: 'action', action: 'invoke', root: 'active', processId: 42, ...selector });
    expect(result.presses).toBe(1); expect(result.receipt.status).toBe('ok');
    expect(result.receipt.selectedAfter).toMatchObject({ name: 'Save', processId: 42 });
  });
  it('retains window-name filtering for read-only snapshots', () => {
    expect(fixture({ kind: 'snapshot', name: 'Other document', processId: 42 }).receipt.status).toBe('not_found');
    expect(fixture({ kind: 'snapshot', name: 'Document', processId: 42 }).receipt.status).toBe('ok');
  });
});
