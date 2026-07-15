import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readDB } from '../../../db_layer';
import { getDataPath } from '../../config/data_path';
import { ToolRegistry } from '../registry';

function scopeDirectory(userId: string, domain: string, orgId: string): string {
  if (domain === 'work' && orgId) return getDataPath(path.join('org', orgId, 'knowledge'));
  const db = readDB();
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  if (primaryAdmin?.uid === userId) return getDataPath('knowledge');
  const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return getDataPath(path.join('knowledge', '_users', directoryId));
}

function metaMatchesScope(meta: any, userId: string, domain: string, orgId: string, primaryOwner: boolean): boolean {
  const metaDomain = String(meta?.domain || (meta?.orgId ? 'work' : 'personal')).toLowerCase();
  if (metaDomain !== domain) return false;
  if (domain === 'work') return String(meta?.orgId || '') === orgId;
  if (meta?.orgId) return false;
  if (meta?.userId) return String(meta.userId) === userId;
  return primaryOwner;
}

function memoryMatchesFile(memory: any, name: string, userId: string, domain: string, orgId: string): boolean {
  if (memory?.type !== 'knowledge' || String(memory?.userId || '') !== userId) return false;
  if (String(memory?.domain || 'personal') !== domain || String(memory?.orgId || '') !== orgId) return false;
  const target = name.normalize('NFC').toLowerCase();
  const source = String(memory?.sourceInteractionId || '');
  if (source && path.basename(source).normalize('NFC').toLowerCase() === target) return true;
  const keywords = Array.isArray(memory?.keywords) ? memory.keywords : [];
  if (keywords.some((keyword: unknown) => String(keyword || '').normalize('NFC').toLowerCase() === `source:${target}`)) return true;
  return String(memory?.content || '').normalize('NFC').startsWith(`[${name} #`);
}

export function registerKnowledgeTools(registry: ToolRegistry): void {
  registry.register({
    name: 'knowledge_file_stats',
    description: 'Return the exact current-workspace Lumi knowledge-file count, indexing status, and visible filenames. Use this for questions about how many files are currently in the knowledge base; do not substitute client_get_state.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      const userId = String(context?.userId || 'anonymous');
      const domain = context?.domain === 'work' ? 'work' : 'personal';
      const orgId = domain === 'work' ? String(context?.orgId || '') : '';
      if (domain === 'work' && !orgId) throw new Error('Organization context is required for work knowledge statistics.');

      const db = readDB();
      const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
      const primaryOwner = Boolean(primaryAdmin?.uid && primaryAdmin.uid === userId);
      const dir = scopeDirectory(userId, domain, orgId);
      fs.mkdirSync(dir, { recursive: true });
      const names = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const metas = (db.knowledgeFiles || []).filter((meta: any) => metaMatchesScope(meta, userId, domain, orgId, primaryOwner));
      const metaByName = new Map(metas.map((meta: any) => [String(meta.filename || ''), meta]));
      const files = names.map(name => {
        const meta: any = metaByName.get(name) || {};
        const inferredMemories = (db.memories || []).filter((memory: any) => memoryMatchesFile(memory, name, userId, domain, orgId));
        const storedStatus = String(meta.extractionStatus || meta.status || 'ready');
        const status = inferredMemories.length > 0 && ['ready', 'failed'].includes(storedStatus)
          ? 'indexed'
          : storedStatus;
        return {
          name,
          status,
          contentChars: Number(meta.contentChars || inferredMemories.reduce((sum: number, memory: any) => sum + String(memory?.content || '').length, 0)),
        };
      });
      return JSON.stringify({
        domain,
        orgId: orgId || undefined,
        totalFiles: files.length,
        indexedFiles: files.filter(file => file.status === 'indexed').length,
        partialFiles: files.filter(file => file.status === 'partial').length,
        failedFiles: files.filter(file => ['failed', 'unsupported'].includes(file.status)).length,
        files,
      });
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
