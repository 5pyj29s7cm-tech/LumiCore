// Run after `npm run build`: node --import tsx scripts/verify-chat-song-workbench.mjs
// Isolated real routes/files/ffprobe + a headless browser rendering the real component.
// Does not contact model/music services or claim to operate the native client/Jianying.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = process.cwd();
const output = path.join(root, '.codex-run', 'chat-song', `qa-${Date.now()}`);
fs.mkdirSync(path.join(output, 'runtime', 'data'), { recursive: true });
fs.writeFileSync(path.join(output, 'runtime', 'data', '.migration_skip'), '');
process.env.LUMI_DATA_DIR = path.join(output, 'runtime');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const { initDatabase, closeDatabase } = await import('../db_layer.ts');
const { mountChatSongRoutes } = await import('../server/routes/chat_song_routes.ts');
const { default: fileRoutes } = await import('../routes/files.ts');
const { generatedKnowledgeDirectory } = await import('../server/files/knowledge_directory.ts');
const { registerGeneratedKnowledgeFile } = await import('../server/files/generated_archive.ts');
const { createChatSongProject, changeChatSongProject, editChatSongProject, lockChatSongScript, getChatSongProject } = await import('../server/creative/chat_song.ts');
await initDatabase();
const owner = 'isolated-chat-song-qa';
const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
const avatar = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#417078' } }).png().toBuffer();
fs.writeFileSync(path.join(dir, 'avatar.png'), avatar);
const sampleBackground = process.env.LUMI_CHAT_SONG_QA_BACKGROUND || '';
fs.writeFileSync(path.join(dir, 'background.png'), sampleBackground && fs.existsSync(sampleBackground) ? fs.readFileSync(sampleBackground) : avatar);
// A deliberately silent PCM test fixture, not a generated or accepted song.
const rate = 8000, frames = rate * 12, wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
fs.writeFileSync(path.join(dir, 'test-silence.wav'), wav);
for (const name of ['avatar.png', 'background.png', 'test-silence.wav']) await registerGeneratedKnowledgeFile({ userId: owner, domain: 'personal' }, name);
let project = await createChatSongProject(owner, { id: crypto.randomUUID(), title: '帮朋友问的 · 界面验收' });
project = await changeChatSongProject(owner, project.id, project.revision, p => {
  editChatSongProject(p, { title: p.title, brief: { ...p.brief, theme: '感情悬疑反转', relationship: '律师与当事人', roleA: '当事人', roleB: '律师', visualStyle: '模糊底图，横向聊天截图条' }, lines: [
    { role: 'A', text: '律师，帮朋友问个事。', group: 1, reaction: '' },
    { role: 'B', text: '你说。', group: 1, reaction: '' },
    { role: 'A', text: '他老婆把我赶出来了。', group: 2, reaction: '突然说漏嘴，尴尬又惊讶' },
    { role: 'B', text: '把谁？', group: 2, reaction: '' },
  ] }); lockChatSongScript(p);
});
const token = jwt.sign({ uid: owner, username: owner, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '30m' });
const css = fs.readdirSync(path.join(root, 'dist/desktop/assets')).find(name => /^desktop-.*\.css$/.test(name));
assert.ok(css, 'Build the desktop frontend first.');
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import Workbench from './src/components/ChatSongWorkbench'; import {apiJson} from './src/services/apiClient';
function App(){ const [files,setFiles]=React.useState([]); const refresh=()=>{void apiJson('/api/files/list?domain=personal').then(r=>setFiles(r.files||[]))};React.useEffect(refresh,[]);
return <Workbench locale="zh" files={files} busy={false} onRefreshLibrary={refresh} onClose={()=>{window.__closed=true}} onGenerate={r=>{window.__generation=r}} onTask={async p=>{window.__task=p;return undefined}}/>;}
createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: root }, outfile: path.join(output, 'preview.js'), bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
const app = express(), router = express.Router(); app.use(express.json()); app.use('/api', router);
mountChatSongRoutes(router, { getDeepSeek: () => null, getGemini: () => null });
app.use('/api', fileRoutes);
app.get('/', (_req, res) => res.send(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/${css}"><body style="margin:0"><div id="root"></div><script>localStorage.setItem('lumi_auth_token',${JSON.stringify(token)})</script><script type="module" src="/preview.js"></script></body></html>`));
app.get('/preview.js', (_req, res) => res.sendFile(path.join(output, 'preview.js')));
app.use('/assets', express.static(path.join(root, 'dist/desktop/assets')));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(url); await page.getByLabel('项目名称').waitFor();
  await page.screenshot({ path: path.join(output, '01-dialogue.png') });
  await page.getByRole('tab', { name: '画面素材' }).click();
  for (const [name, file] of [['背景', 'background.png'], ['角色 A 头像', 'avatar.png'], ['角色 B 头像', 'avatar.png']]) {
    const slot = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await slot.getByRole('combobox').selectOption(file); await slot.getByRole('button', { name: '采用素材' }).click();
    await slot.getByText(`已采用 · ${file}`).waitFor();
  }
  await page.locator('article img').evaluateAll(async images => { await Promise.all(images.map(image => image.decode())); });
  await page.screenshot({ path: path.join(output, '02-visuals.png') });
  await page.getByRole('tab', { name: '歌曲与卡点' }).click();
  await page.getByLabel('选定歌曲').selectOption('test-silence.wav'); await page.getByRole('button', { name: '选用歌曲' }).click();
  await page.getByText('test-silence.wav · 12.0s').waitFor();
  for (const label of ['没有漏词', '没有改词', '没有额外重复', '顺序完全一致']) await page.getByLabel(label, { exact: true }).check();
  await page.getByRole('button', { name: '确认这首歌' }).click();
  await page.getByRole('button', { name: '歌曲已确认' }).waitFor();
  const starts = page.getByRole('spinbutton', { name: '开始（秒）' }), ends = page.getByRole('spinbutton', { name: '结束（秒）' });
  for (let i = 0; i < 4; i++) { await starts.nth(i).fill(String(i * 2 + 1)); await ends.nth(i).fill(String(i * 2 + 2)); }
  await page.getByRole('button', { name: '保存卡点' }).click();
  await page.getByText('有未保存修改', { exact: true }).waitFor({ state: 'hidden' });
  await page.locator('audio').evaluate(el => { el.currentTime = 3.5; el.dispatchEvent(new Event('timeupdate', { bubbles: true })); });
  await page.getByRole('heading', { name: '3:4 画面预览' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, '03-timing-preview.png') });
  await page.getByRole('tab', { name: '剪映交接' }).click();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出素材包', exact: true }).click();
  const download = await downloaded; await download.saveAs(path.join(output, 'materials.zip'));
  await page.getByText('素材包已入库', { exact: true }).waitFor(); await page.screenshot({ path: path.join(output, '04-handoff.png') });
  const reloaded = getChatSongProject(owner, project.id);
  assert.equal(reloaded.timings.length, 4); assert.equal(reloaded.song.duration, 12); assert.equal(reloaded.assets.length, 3);
  await page.reload(); await page.getByLabel('项目名称').waitFor();
  await page.getByRole('tab', { name: '歌曲与卡点' }).click(); await page.getByRole('button', { name: '歌曲已确认' }).waitFor();
  await page.setViewportSize({ width: 820, height: 760 }); await page.screenshot({ path: path.join(output, '05-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  const zip = await (await import('jszip')).default.loadAsync(fs.readFileSync(path.join(output, 'materials.zip')));
  fs.writeFileSync(path.join(output, 'strip.png'), await zip.file('02_画面素材/聊天_01.png').async('nodebuffer'));
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ ok: true, projectId: project.id, measuredAudioSeconds: reloaded.song.duration, timings: reloaded.timings, assets: reloaded.assets.length, modelCalls: 0, externalAppActions: 0, note: 'Isolated UI/routes/file export smoke with silent fixture, not native client or music/Jianying acceptance.' }, null, 2));
  console.log(`CHAT_SONG_UI_SMOKE_PASS ${output}`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await closeDatabase();
}
