import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRIVATE_MODEL_HANDOFF_MAX_BATCH,
  PRIVATE_MODEL_HANDOFF_MAX_CHARS,
  PRIVATE_MODEL_HANDOFF_MAX_RECORDS,
  PrivateModelHandoffStore,
  type PrivateModelHandoffInput,
} from '../server/conversation/private_model_handoff_store';

const roots: string[] = [];

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-private-handoff-test-'));
  roots.push(root);
  return root;
}

function windowsProtector() {
  return {
    protectKey: (key: Buffer) => Buffer.from(`wrapped:${key.toString('base64')}`, 'utf8').toString('base64'),
    unprotectKey: (value: string) => {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (!decoded.startsWith('wrapped:')) return Buffer.alloc(0);
      return Buffer.from(decoded.slice('wrapped:'.length), 'base64');
    },
  };
}

function input(overrides: Partial<PrivateModelHandoffInput> = {}): PrivateModelHandoffInput {
  return {
    userId: 'user-private-a',
    conversationId: 'conversation-private-a',
    taskId: 'task-private-a',
    graphId: 'graph-private-a',
    nodeId: 'node-private-a',
    outputDigest: digest('raw worker result a'),
    outputSummary: 'private handoff payload alpha',
    evidenceKind: 'tool_terminal_verification',
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root && root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('private model handoff store', () => {
  it('encrypts both verified receipt kinds and requires the exact durable scope', () => {
    const root = makeRoot();
    const storePath = path.join(root, 'handoffs.json');
    const keyPath = path.join(root, 'handoffs.key');
    const protector = windowsProtector();
    const toolHandoff = input();
    const modelHandoff = input({
      nodeId: 'node-private-b',
      outputDigest: digest('validated model output b'),
      outputSummary: 'private handoff payload beta',
      evidenceKind: 'validated_model_output',
    });
    const store = new PrivateModelHandoffStore({
      storePath,
      keyPath,
      platform: 'win32',
      keyProtectionAdapter: protector,
    });

    expect(store.persistBatch([toolHandoff, modelHandoff])).toBe(true);
    expect(store.load({ ...toolHandoff, evidenceKind: 'tool_terminal_verification' })).toBe(toolHandoff.outputSummary);
    expect(store.load({ ...modelHandoff, evidenceKind: 'validated_model_output' })).toBe(modelHandoff.outputSummary);

    const disk = fs.readFileSync(storePath, 'utf8');
    const protectedKey = fs.readFileSync(keyPath, 'utf8');
    expect(protectedKey.startsWith('dpapi:')).toBe(true);
    for (const forbidden of [
      toolHandoff.outputSummary,
      modelHandoff.outputSummary,
      toolHandoff.userId,
      toolHandoff.conversationId,
      toolHandoff.taskId,
      toolHandoff.graphId,
      toolHandoff.nodeId,
    ]) expect(disk).not.toContain(forbidden);

    const restarted = new PrivateModelHandoffStore({
      storePath,
      keyPath,
      platform: 'win32',
      keyProtectionAdapter: protector,
    });
    expect(restarted.load(toolHandoff)).toBe(toolHandoff.outputSummary);
    expect(restarted.load({ ...toolHandoff, userId: 'user-private-b' })).toBeNull();
    expect(restarted.load({ ...toolHandoff, conversationId: 'conversation-private-b' })).toBeNull();
    expect(restarted.load({ ...toolHandoff, taskId: 'task-private-b' })).toBeNull();
    expect(restarted.load({ ...toolHandoff, graphId: 'graph-private-b' })).toBeNull();
    expect(restarted.load({ ...toolHandoff, nodeId: 'node-private-b' })).toBeNull();
    expect(restarted.load({ ...toolHandoff, outputDigest: digest('different output') })).toBeNull();
    expect(restarted.load({ ...toolHandoff, evidenceKind: 'validated_model_output' })).toBeNull();
  });

  it('fails closed when encrypted content is changed', () => {
    const root = makeRoot();
    const storePath = path.join(root, 'handoffs.json');
    const keyPath = path.join(root, 'handoffs.key');
    const protector = windowsProtector();
    const handoff = input();
    const store = new PrivateModelHandoffStore({
      storePath,
      keyPath,
      platform: 'win32',
      keyProtectionAdapter: protector,
    });
    expect(store.persistBatch([handoff])).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      records: Array<{ ciphertext: string }>;
    };
    persisted.records[0].ciphertext = `${persisted.records[0].ciphertext[0] === 'A' ? 'B' : 'A'}${persisted.records[0].ciphertext.slice(1)}`;
    fs.writeFileSync(storePath, JSON.stringify(persisted), 'utf8');

    expect(store.load(handoff)).toBeNull();
  });

  it('uses a permission-restricted fallback key and enforces payload and record bounds', () => {
    const root = makeRoot();
    const storePath = path.join(root, 'handoffs.json');
    const keyPath = path.join(root, 'handoffs.key');
    let now = Date.parse('2026-08-26T00:00:00.000Z');
    const store = new PrivateModelHandoffStore({
      storePath,
      keyPath,
      platform: 'linux',
      now: () => new Date(now),
    });
    expect(store.persistBatch(Array.from({ length: PRIVATE_MODEL_HANDOFF_MAX_BATCH + 1 }, (_, index) => input({
      nodeId: `over-limit-${index}`,
      outputDigest: digest(`over-limit-${index}`),
    })))).toBe(false);

    const long = input({ outputSummary: 'x'.repeat(PRIVATE_MODEL_HANDOFF_MAX_CHARS + 500) });
    expect(store.persistBatch([long])).toBe(true);
    expect(store.load(long)).toHaveLength(PRIVATE_MODEL_HANDOFF_MAX_CHARS);
    expect(fs.readFileSync(keyPath, 'utf8').startsWith('plain:')).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }

    for (let batch = 0; batch < 5; batch += 1) {
      now += 1_000;
      expect(store.persistBatch(Array.from({ length: PRIVATE_MODEL_HANDOFF_MAX_BATCH }, (_, index) => {
        const id = `bounded-${batch}-${index}`;
        return input({ nodeId: id, outputDigest: digest(id), outputSummary: id });
      }))).toBe(true);
    }
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { records: unknown[] };
    expect(persisted.records).toHaveLength(PRIVATE_MODEL_HANDOFF_MAX_RECORDS);
  });
});
