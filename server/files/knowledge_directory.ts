import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDB } from '../../db_layer';
import { getDataPath } from '../config/data_path';

export function getPersonalKnowledgeDirectory(userId: string): { dir: string; legacyPersonalOwner: boolean } {
  const primaryAdmin = (readDB().users || []).find((user: any) => user?.role === 'admin');
  const legacyPersonalOwner = Boolean(primaryAdmin?.uid && primaryAdmin.uid === userId);
  const root = getDataPath('knowledge');
  const dir = legacyPersonalOwner ? root : path.join(root, '_users', createHash('sha256').update(userId).digest('hex').slice(0, 24));
  fs.mkdirSync(dir, { recursive: true });
  return { dir, legacyPersonalOwner };
}

export function generatedKnowledgeDirectory(scope: { userId: string; domain: 'personal' | 'work'; orgId?: string }): string {
  if (scope.domain === 'personal') return getPersonalKnowledgeDirectory(scope.userId).dir;
  if (!scope.orgId || !/^[\w-]+$/.test(scope.orgId)) throw new Error('Invalid organization knowledge scope.');
  const dir = getDataPath(path.join('org', scope.orgId, 'knowledge'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
