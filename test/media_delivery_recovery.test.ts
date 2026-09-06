import './helpers';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import JSZip from 'jszip';
import { makeApp, JWT_SECRET } from './helpers';
import { closeDatabase, initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { addMember, createOrg, removeMember } from '../server/org/db';
import { buildSocketToolSecurityContext } from '../server/socket/scope';
import { registerOfficeTools } from '../server/tools/definitions/office_tools';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
import { readImageGenerationTask } from '../server/tools/media_generation_journal';
import { inspectExternalCommitAttempt } from '../server/tools/external_commit_journal';
import { extractMediaGenerationArtifacts } from '../src/lib/mediaGenerationArtifacts';
import { buildMediaArtifactReceipt } from '../server/socket/media_artifact_receipt';
import { VALID_MP4 } from './fixtures/synthetic_video';

const uid = 'synthetic-media-admin';
const nativeFetch = globalThis.fetch;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let url: string;
let cleanup: () => void;
let serial = 0;
const authHeaders = { Authorization: `Bearer ${jwt.sign({ uid, username: uid, role: 'admin' }, JWT_SECRET)}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function context(orgId = '') {
  const requestId = `synthetic-media-request-${++serial}`;
  const scope = { domain: orgId ? 'work' as const : 'personal' as const, orgId, orgRole: orgId ? 'owner' : undefined };
  return {
    ...buildSocketToolSecurityContext({ data: { authenticatedUserId: uid, authenticatedRole: 'admin', trustedLocalExecution: true } } as any, scope),
    ...scope, userId: uid, source: 'chat', requestId, turnId: requestId, taskId: requestId, idempotencyKey: requestId,
    currentTurnExecutionRequested: true, actionIntent: 'Create the requested synthetic file.', requestConfirmation: async () => true,
  };
}

beforeAll(async () => {
  const fixture = await makeApp(); url = fixture.url; cleanup = fixture.cleanup;
  const { default: fileRoutes } = await import('../routes/files'); fixture.apiRouter.use('/', fileRoutes);
  fs.mkdirSync(getGeneratedOutputDir(), { recursive: true });
});
beforeEach(() => {
  resetExternalCommitRuntimeCacheForTests();
  for (const name of ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'SILICONFLOW_API_KEY', 'RELAY_API_KEY', 'RELAY_BASE_URL',
    'RELAY_VIDEO_MODEL', 'RELAY_VIDEO_PATH', 'RELAY_VIDEO_STATUS_PATH', 'RELAY_VIDEO_CONTENT_PATH', 'RELAY_VIDEO_REQUEST_FORMAT']) vi.stubEnv(name, '');
  saveKeys({ OPENAI_API_KEY: '', DASHSCOPE_API_KEY: '', QWEN_API_KEY: '', SILICONFLOW_API_KEY: '', RELAY_API_KEY: '', RELAY_BASE_URL: '' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => cleanup());

it('preserves same-title PPT versions and their old authenticated links across organizations', async () => {
  const orgA = createOrg('Synthetic media A', 'synthetic-media-a', uid); addMember(orgA.id, uid, 'owner');
  const orgB = createOrg('Synthetic media B', 'synthetic-media-b', uid); addMember(orgB.id, uid, 'owner');
  const registry = new ToolRegistry(); registerOfficeTools(registry);
  const create = async (marker: string, orgId: string) => JSON.parse(await registry.execute('create_ppt', {
    title: 'Synthetic quarterly report', slides: [{ title: marker, bullets: [marker] }],
  }, context(orgId)));
  const first = await create('SYNTHETIC_ORG_A_ONLY', orgA.id);
  const second = await create('SYNTHETIC_ORG_B_ONLY', orgB.id);
  expect(second.outputPath).not.toBe(first.outputPath);
  for (const [result, marker] of [[first, 'SYNTHETIC_ORG_A_ONLY'], [second, 'SYNTHETIC_ORG_B_ONLY']]) {
    const response = await nativeFetch(`${url}/api/files/generated?path=${encodeURIComponent(result.outputPath)}`, { headers: authHeaders });
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain(marker);
  }
  const before = fs.readFileSync(first.outputPath);
  await expect(registry.execute('create_ppt', { title: 'Explicit file', filename: first.outputPath, slides: [{ title: 'Do not replace' }] }, context(orgA.id)))
    .rejects.toThrow(/already exists/);
  expect(fs.readFileSync(first.outputPath)).toEqual(before);
});

function imageProvider() {
  saveKeys({ DASHSCOPE_API_KEY: 'synthetic-qwen-key', SILICONFLOW_API_KEY: 'synthetic-sf-key' });
  upsertUserPreferredGenerationModels(uid, { image: { provider: 'auto' } });
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
  let mode: 'error' | 'success' | 'pending' | 'hang' = 'error';
  const calls: string[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(input); calls.push(`${init?.method || 'GET'} ${target}`);
    if (target.includes('/text2image/image-synthesis')) return json({ output: { task_id: 'synthetic-known-task' } });
    if (target.endsWith('/tasks/synthetic-known-task/cancel')) return json({ cancelled: true });
    if (target.endsWith('/tasks/synthetic-known-task')) {
      if (mode === 'error') throw new TypeError('Synthetic network failure after remote admission');
      if (mode === 'hang') return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(init?.signal?.reason || new Error('Cancelled'));
        if (init?.signal?.aborted) rejectAbort(); else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
      if (mode === 'pending') return json({ output: { task_status: 'RUNNING' } });
      return json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://media.invalid/synthetic.png' }] } });
    }
    if (target === 'https://media.invalid/synthetic.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected synthetic media call: ${target}`);
  });
  vi.stubGlobal('fetch', mock);
  const registry = new ToolRegistry(); registerImageTools(registry);
  return { registry, calls, mock, setMode: (value: typeof mode) => { mode = value; } };
}
const imageArgs = { prompt: 'Generate one synthetic blue square', n: 1 };

it('keeps a lost status query unknown, then reopens the journal and reconciles the original task without another POST', async () => {
  const provider = imageProvider(); const original = context();
  const receipt = JSON.parse(await provider.registry.execute('generate_image', imageArgs, original));
  expect(receipt).toMatchObject({ status: 'unknown', verified: false, taskId: 'synthetic-known-task', recoveryTool: 'get_image_generation_status' });
  expect((await inspectExternalCommitAttempt(original.idempotencyKey)).entry?.state).toBe('unknown');
  expect(readImageGenerationTask(receipt.recoveryId, original)?.providerTaskId).toBe('synthetic-known-task');
  await expect(provider.registry.execute('generate_image', imageArgs, original)).rejects.toThrow(/automatic resend was stopped/);
  await closeDatabase(); await initDatabase(); resetExternalCommitRuntimeCacheForTests();
  provider.setMode('success');
  const recovered = JSON.parse(await provider.registry.execute('generate_image', imageArgs, original));
  expect(recovered).toMatchObject({ provider: 'qwen', verified: true, taskId: 'synthetic-known-task', recoveryId: receipt.recoveryId });
  expect(fs.readFileSync(recovered.images[0])).toEqual(PNG);
  expect((await inspectExternalCommitAttempt(original.idempotencyKey)).entry?.state).toBe('verified');
  expect(provider.calls.filter(call => call.startsWith('POST '))).toHaveLength(1);
  expect(provider.calls.some(call => call.includes('siliconflow'))).toBe(false);
});

it('coalesces repeated authenticated status queries and persists the recovered artifact for later queries', async () => {
  const provider = imageProvider(); const original = context();
  const pending = JSON.parse(await provider.registry.execute('generate_image', imageArgs, original));
  provider.setMode('success');
  const query = () => provider.registry.execute('get_image_generation_status', { recoveryId: pending.recoveryId }, context());
  const [first, second] = await Promise.all([query(), query()]);
  expect(JSON.parse(first).images).toEqual(JSON.parse(second).images);
  expect(provider.calls.filter(call => call === 'GET https://media.invalid/synthetic.png')).toHaveLength(1);
  const receipt = buildMediaArtifactReceipt('get_image_generation_status', { recoveryId: pending.recoveryId, size: 'forged-query-size', n: 4 }, first);
  expect(receipt).toMatchObject({ toolName: 'generate_image', verified: true, settings: { count: 1, hasReference: false } });
  expect(receipt?.settings.size).not.toBe('forged-query-size');
  const [artifact] = extractMediaGenerationArtifacts(receipt);
  const download = await nativeFetch(`${url}${artifact.url}`, { headers: authHeaders });
  expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);
  const requests = provider.calls.length;
  await closeDatabase(); await initDatabase(); resetExternalCommitRuntimeCacheForTests();
  const later = JSON.parse(await query());
  expect(later.images).toEqual(JSON.parse(first).images); expect(provider.calls).toHaveLength(requests);
  expect(provider.calls.filter(call => call.startsWith('POST '))).toHaveLength(1);
});

it('keeps the safe auto fallback when the original provider definitively rejects submission before admission', async () => {
  imageProvider();
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input); calls.push(`${init?.method || 'GET'} ${target}`);
    if (target.includes('/text2image/')) return json({ code: 'InvalidApiKey', message: 'Synthetic rejection' }, 401);
    if (target.includes('siliconflow.cn')) return json({ data: [{ url: 'https://media.invalid/synthetic.png' }] });
    if (target === 'https://media.invalid/synthetic.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    throw new Error('Unexpected synthetic provider request');
  }));
  const registry = new ToolRegistry(); registerImageTools(registry);
  const result = JSON.parse(await registry.execute('generate_image', imageArgs, context()));
  expect(result).toMatchObject({ provider: 'siliconflow', verified: true });
  expect(calls.filter(call => call.startsWith('POST '))).toHaveLength(2);
  expect(calls.some(call => call.includes('/tasks/'))).toBe(false);
});

it('stops before cloud submission when the private preparation journal cannot be persisted', async () => {
  const provider = imageProvider();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('media-generation-tasks')) throw new Error('Synthetic preparation disk failure');
    return rename(from, to);
  });
  await expect(provider.registry.execute('generate_image', imageArgs, context())).rejects.toThrow(/preparation disk failure/);
  expect(provider.calls).toHaveLength(0);
});

it('denies another owner, another organization, and removed-and-rejoined membership before querying the provider', async () => {
  const provider = imageProvider();
  const org = createOrg('Synthetic media task owner', `synthetic-media-owner-${serial}`, uid); addMember(org.id, uid, 'owner');
  const original = context(org.id);
  const receipt = JSON.parse(await provider.registry.execute('generate_image', imageArgs, original));
  provider.setMode('pending');
  const repeatedQuery = context(org.id);
  expect(JSON.parse(await provider.registry.execute('get_image_generation_status', { recoveryId: receipt.recoveryId }, repeatedQuery)).status).toBe('pending');
  const before = provider.calls.length;
  for (const wrong of [{ ...context(org.id), userId: 'another-user' }, context('another-org'), context()]) {
    await expect(provider.registry.execute('get_image_generation_status', { recoveryId: receipt.recoveryId }, wrong)).rejects.toThrow(/owner scope/);
  }
  removeMember(org.id, uid); addMember(org.id, uid, 'owner');
  await expect(provider.registry.execute('get_image_generation_status', { recoveryId: receipt.recoveryId }, repeatedQuery)).rejects.toThrow(/owner scope/);
  expect(provider.calls).toHaveLength(before);
});

it('does not query or resubmit when strict acceptance persistence fails after the provider returned its task ID', async () => {
  const provider = imageProvider(); const original = context();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('.json') && String(to).includes('media-generation-tasks')) {
      const payload = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (payload.state === 'accepted') throw new Error('Synthetic acceptance disk failure');
    }
    return rename(from, to);
  });
  await expect(provider.registry.execute('generate_image', imageArgs, original)).rejects.toThrow(/accepted.*recovery identity could not be saved/);
  expect(provider.calls).toHaveLength(1); expect(provider.calls[0]).toContain('POST ');
  expect((await inspectExternalCommitAttempt(original.idempotencyKey)).entry?.state).toBe('unknown');
});

it('returns an unknown receipt when a recovery query times out and never submits another image', async () => {
  const provider = imageProvider();
  const pending = JSON.parse(await provider.registry.execute('generate_image', imageArgs, context()));
  provider.setMode('hang'); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const before = provider.calls.length;
  const query = provider.registry.execute('get_image_generation_status', { recoveryId: pending.recoveryId }, context());
  await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(before));
  await vi.advanceTimersByTimeAsync(15_001);
  const result = JSON.parse(await query);
  expect(result).toMatchObject({ status: 'unknown', verified: false, taskId: 'synthetic-known-task' });
  expect(provider.calls.filter(call => call.startsWith('POST '))).toHaveLength(1);
});

it('cancels a submitted image task and does not recover it by silently starting new provider work', async () => {
  const provider = imageProvider(); const original = context(); const caller = new AbortController();
  provider.setMode('hang');
  const task = provider.registry.execute('generate_image', imageArgs, { ...original, executionSignal: caller.signal });
  const settled = task.catch(error => error);
  await vi.waitFor(() => expect(provider.calls.some(call => call.startsWith('POST '))).toBe(true));
  caller.abort(new Error('Synthetic user cancellation'));
  expect((await settled).message).toMatch(/Synthetic user cancellation/);
  expect(provider.calls.filter(call => call.includes('/text2image/'))).toHaveLength(1);
  expect(provider.calls.some(call => call.endsWith('/cancel'))).toBe(true);
  expect(provider.calls.some(call => call.includes('siliconflow'))).toBe(false);
});

it('publishes a valid video but rejects a 16-byte header without publishing a verified receipt or repeating its paid generation', async () => {
  saveKeys({ RELAY_API_KEY: 'synthetic-relay-key', RELAY_BASE_URL: 'https://relay.invalid/v1' });
  upsertUserPreferredGenerationModels(uid, { video: { provider: 'relay', model: 'huawei_maas/Wan2.2-T2V-A14B' } });
  let providerBytes = VALID_MP4;
  const mock = vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== 'https://relay.invalid/v1/videos/generations') throw new Error('Unexpected provider request');
    return json({ video_base64: `data:video/mp4;base64,${providerBytes.toString('base64')}` });
  }); vi.stubGlobal('fetch', mock);
  const registry = new ToolRegistry(); registerVideoTools(registry);
  const valid = JSON.parse(await registry.execute('generate_video', { prompt: 'Synthetic valid control' }, context()));
  expect(valid).toMatchObject({ verified: true, verification: { strategy: 'container_and_video_samples', decoded: false } });
  expect(buildMediaArtifactReceipt('generate_video', {}, valid)?.verified).toBe(true);
  const [artifact] = extractMediaGenerationArtifacts(JSON.stringify(valid), 'video');
  const response = await nativeFetch(`${url}${artifact.url}`, { headers: authHeaders });
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(VALID_MP4);
  providerBytes = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const before = fs.readdirSync(getGeneratedOutputDir()).sort(); const original = context(); const args = { prompt: 'Synthetic broken provider result' };
  await expect(registry.execute('generate_video', args, original)).rejects.toThrow(/container validation failed/);
  expect(fs.readdirSync(getGeneratedOutputDir()).sort()).toEqual(before);
  await expect(registry.execute('generate_video', args, original)).rejects.toThrow(/automatic resend was stopped/);
  expect(mock).toHaveBeenCalledTimes(2);
});
