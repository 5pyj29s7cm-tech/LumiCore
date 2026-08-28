import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyLumiScenePatch,
  createLumiSceneSnapshot,
  diffLumiSceneSnapshots,
  validateLumiSceneSnapshot,
} from '../shared/lumi_scene';
import { resetRuntimeSceneStoreForTests, syncRuntimeScene } from '../server/scene/runtime_scene';

function scene(revision: number, value: string) {
  return createLumiSceneSnapshot({
    sceneId: 'runtime-status',
    revision,
    generatedAt: `2026-08-10T00:0${revision}:00.000Z`,
    nodes: [{ id: 'runtime.overall', kind: 'status', title: 'runtime.overall', value, tone: 'info' }],
  });
}

function actionTask(status: string, domain = 'personal', orgId = '') {
  return {
    id: `task-${domain}-${orgId || 'personal'}`,
    conversationId: 'conv-1', userId: 'user-1', domain, orgId,
    parentTaskId: '', rootUserMessageId: '', intentKind: 'desktop_operation', operation: 'mutate',
    goal: 'Prepare report', target: 'report.pdf', status, blocker: '', activeRequestId: status === 'executing' ? 'req-1' : '',
    completionSource: status === 'completed' ? 'tool_receipt' : '', context: '{}', revision: 1,
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:01:00.000Z', completedAt: '',
  };
}

describe('Lumi Scene protocol', () => {
  beforeEach(() => resetRuntimeSceneStoreForTests());

  it('applies a sequential semantic patch and preserves its digest', () => {
    const previous = scene(1, 'working');
    const next = scene(2, 'ready');
    const patch = diffLumiSceneSnapshots(previous, next);
    const applied = applyLumiScenePatch(previous, patch);
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') expect(applied.snapshot).toEqual(next);
  });

  it('requests a full resync for revision gaps or digest mismatches', () => {
    const previous = scene(1, 'working');
    const next = scene(2, 'ready');
    const patch = diffLumiSceneSnapshots(previous, next);
    expect(applyLumiScenePatch({ ...previous, revision: 4 }, patch)).toMatchObject({
      status: 'resync_required', reason: 'scene_revision_gap',
    });
    expect(applyLumiScenePatch(previous, { ...patch, digest: 'wrong' })).toMatchObject({
      status: 'resync_required', reason: 'scene_patch_digest_mismatch',
    });
  });

  it('rejects arbitrary code, markup fields, and unsupported patch operations', () => {
    expect(() => createLumiSceneSnapshot({
      sceneId: 'runtime-status', revision: 1,
      nodes: [{ id: 'unsafe', kind: 'text', title: 'Unsafe', html: '<script>run()</script>' }],
    })).toThrow('scene_node_contains_unsupported_field');
    const current = scene(1, 'working');
    expect(applyLumiScenePatch(current, {
      protocol: 'lumi-scene/1', schemaVersion: 1, sceneId: 'runtime-status', baseRevision: 1, revision: 2,
      digest: current.digest, generatedAt: new Date().toISOString(), operations: [{ op: 'execute', code: 'run()' }],
    })).toMatchObject({ status: 'rejected', reason: 'scene_operation_unsupported' });
  });

  it('validates full snapshots before a renderer can accept them', () => {
    const snapshot = scene(1, 'working');
    expect(validateLumiSceneSnapshot(snapshot)).toEqual(snapshot);
    expect(() => validateLumiSceneSnapshot({ ...snapshot, digest: 'tampered' })).toThrow('scene_snapshot_digest_mismatch');
  });

  it('serves snapshots, patches and noops with exact scope isolation', () => {
    const db: any = {
      conversationActionTasks: [
        actionTask('executing'),
        actionTask('blocked', 'work', 'org-a'),
      ],
      conversationActionReceipts: [], autonomousTasks: [],
    };
    const first = syncRuntimeScene(db, { userId: 'user-1', domain: 'personal' });
    expect(first.kind).toBe('snapshot');
    if (first.kind !== 'snapshot') throw new Error('expected snapshot');

    const noop = syncRuntimeScene(db, {
      userId: 'user-1', domain: 'personal', currentRevision: first.snapshot.revision, currentDigest: first.snapshot.digest,
    });
    expect(noop.kind).toBe('noop');

    db.conversationActionTasks[0].status = 'completed';
    db.conversationActionTasks[0].activeRequestId = '';
    db.conversationActionTasks[0].completionSource = 'tool_receipt';
    const update = syncRuntimeScene(db, {
      userId: 'user-1', domain: 'personal', currentRevision: first.snapshot.revision, currentDigest: first.snapshot.digest,
    });
    expect(update.kind).toBe('patch');
    if (update.kind === 'patch') expect(applyLumiScenePatch(first.snapshot, update.patch).status).toBe('applied');

    const work = syncRuntimeScene(db, { userId: 'user-1', domain: 'work', orgId: 'org-a' });
    expect(work.kind).toBe('snapshot');
    if (work.kind === 'snapshot') expect(JSON.stringify(work.snapshot)).toContain('blocked');
  });

  it('mounts authenticated scene sync and makes the client resync on gaps', () => {
    const runtime = readFileSync(path.join(process.cwd(), 'server/runtime/socket.ts'), 'utf8');
    const handler = readFileSync(path.join(process.cwd(), 'server/socket/scene.ts'), 'utf8');
    const hook = readFileSync(path.join(process.cwd(), 'src/hooks/useLumiScene.ts'), 'utf8');
    const renderer = readFileSync(path.join(process.cwd(), 'src/components/LumiScenePanel.tsx'), 'utf8');
    expect(runtime).toContain('registerSceneHandlers(socket, getUserId, io)');
    expect(handler).toContain("socket.on('scene:sync'");
    expect(handler).toContain('resolveSocketScope(socket, userId)');
    expect(handler).not.toContain('data.userId');
    expect(hook).toContain("request(true)");
    expect(renderer).not.toContain('dangerouslySetInnerHTML');
  });
});
