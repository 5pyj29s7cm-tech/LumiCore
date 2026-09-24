import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

export async function prepareWebViewLoader(root, platform = process.platform) {
  if (platform !== 'win32') return;
  const releaseDir = path.join(root, 'src-tauri', 'target', 'release');
  const dllSrc = path.join(releaseDir, 'WebView2Loader.dll');
  const dllResourceDest = path.join(root, 'desktop-resources', 'WebView2Loader.dll');
  if (existsSync(dllSrc)) {
    await fs.mkdir(path.dirname(dllResourceDest), { recursive: true });
    await fs.copyFile(dllSrc, dllResourceDest);
    console.log(`Copied WebView2Loader.dll to desktop-resources/`);
  } else {
    // A previous build's optional DLL must not leak into this installer.
    await fs.rm(dllResourceDest, { force: true });
    console.warn(`WebView2Loader.dll not found at ${dllSrc}, skipping`);
  }

  // Step 3: Patch the generated NSIS script to also delete the DLL on uninstall.
  const nsiPath = path.join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi');
  if (existsSync(nsiPath)) {
    let nsi = await fs.readFile(nsiPath, 'utf-8');
    const delMarker = '  ; Delete external binaries';
    const delLine = `  Delete "$$INSTDIR\\WebView2Loader.dll"`;
    if (nsi.includes(delMarker) && !nsi.includes(delLine)) {
      nsi = nsi.replace(delMarker, `${delLine}\r\n${delMarker}`);
      await fs.writeFile(nsiPath, nsi, 'utf-8');
      console.log('Patched NSIS uninstaller to delete WebView2Loader.dll');
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await prepareWebViewLoader(root);
}
