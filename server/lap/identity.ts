import { generateKeyPairSync, randomUUID } from 'crypto';
import fs from 'fs';
import { getDataPath } from '../config/data_path';
import type { LAPAgentIdentity } from './types';

type PersistedLAPIdentity = {
  version: 1;
  agentId: string;
  userId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
};

function identityPath(): string {
  return getDataPath('lap/identity.json');
}

function validIdentity(value: unknown): value is PersistedLAPIdentity {
  const identity = value as PersistedLAPIdentity;
  return identity?.version === 1
    && /^agent_[a-zA-Z0-9-]{8,}$/.test(identity.agentId)
    && /^instance_[a-zA-Z0-9-]{8,}$/.test(identity.userId)
    && identity.publicKey.includes('BEGIN PUBLIC KEY')
    && identity.privateKey.includes('BEGIN PRIVATE KEY');
}

function generateIdentity(): PersistedLAPIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    version: 1,
    agentId: `agent_${randomUUID()}`,
    userId: `instance_${randomUUID()}`,
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    createdAt: new Date().toISOString(),
  };
}

export function loadOrCreateLAPIdentity(): LAPAgentIdentity {
  const file = identityPath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validIdentity(parsed)) return publicIdentity(parsed);
    }
  } catch {
    // Replace unreadable legacy identity material with a fresh local identity.
  }

  const created = generateIdentity();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(created, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return publicIdentity(created);
}

function publicIdentity(identity: PersistedLAPIdentity): LAPAgentIdentity {
  return {
    agentId: identity.agentId,
    userId: identity.userId,
    name: 'Lumi',
    capabilities: ['chat', 'code', 'search', 'memory', 'file_ops', 'web_search', 'desktop', 'lap_collaboration', 'task_delegation'],
    publicKey: identity.publicKey,
    publicProfile: {
      displayName: 'Lumi',
      description: 'Local-first desktop Lumi instance with scoped LAP collaboration.',
      trustTags: ['local-first', 'user-owned', 'permissioned'],
    },
  };
}
