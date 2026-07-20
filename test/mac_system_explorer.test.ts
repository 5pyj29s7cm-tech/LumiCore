import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectMacApplicationBundles } from '../server/autonomy/system_explorer';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('macOS system exploration', () => {
  it('discovers application bundles without descending into their internal helpers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-mac-apps-'));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, 'WeChat.app', 'Contents', 'Helpers', 'Updater.app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Utilities', 'AutoCAD.app'), { recursive: true });

    const apps = collectMacApplicationBundles([root], 20);
    expect(apps).toHaveLength(2);
    expect(apps).toEqual(expect.arrayContaining(['WeChat', 'AutoCAD']));
  });
});
