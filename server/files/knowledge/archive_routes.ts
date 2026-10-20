import type { Router, Request, Response } from "express";
import fs from "fs";
import { readKnowledgeFileState } from "../knowledge_state";
import { reconcileGeneratedArchive } from "../generated_archive";
import { requireAuth, getFileScope, assertKnowledgeWriteAccess, sendRouteError, readRequestArchiveProjection, metaMatchesScope, archiveFileMeta } from './ownership';
import { buildSourceBacklinkMap, groupExistingFileMemories } from './memory_references';
import type { KnowledgeEntry, KnowledgeFileSource } from './contracts';
import { buildEntry } from './metadata';

export function registerKnowledgeArchiveRoutes(router: Router): void {


router.post('/files/archive-generated', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req); assertKnowledgeWriteAccess(scope);
    const result = await reconcileGeneratedArchive(scope);
    res.json({ ok: true, ...result });
  } catch (error: any) { sendRouteError(res, error); }
});


router.get('/files/list', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const { entries: archived, withheldNames } = await readRequestArchiveProjection(req, scope);
    const db = readKnowledgeFileState();
    const fileMeta: Record<string, any> = {};
    if (db.knowledgeFiles) {
      for (const m of db.knowledgeFiles) {
        if (!metaMatchesScope(m, scope)) continue;
        fileMeta[m.filename] = m;
      }
    }

    const entries = fs.readdirSync(scope.dir);
    for (const entry of archived) {
      fileMeta[entry.filename] = { ...fileMeta[entry.filename], ...archiveFileMeta(entry) };
    }
    const visibleNames = entries.filter(name => !name.startsWith('.') && !name.startsWith('_') && !withheldNames.has(name));
    const backlinkMap = buildSourceBacklinkMap(fileMeta, visibleNames);
    const memoryGroups = groupExistingFileMemories(db, visibleNames, scope, scope.domain === 'personal' ? { userId: scope.userId } : {});
    const files: KnowledgeEntry[] = [];
    for (const name of visibleNames) {
      const inferredMemories = memoryGroups.get(name) || [];
      const inferredAgentIds = [...new Set(inferredMemories.map((m: any) => String(m.agentId || '').trim()).filter(Boolean))];
      const meta = {
        ...(fileMeta[name] || { source: 'upload' as const, agentIds: [] as string[] }),
        agentIds: [...new Set([...(fileMeta[name]?.agentIds || []), ...inferredAgentIds])],
        sourceBacklinks: backlinkMap.get(name) || [],
      };
      if (inferredMemories.length > 0 && (!meta.status || meta.status === 'ready' || meta.status === 'failed')) {
        meta.status = 'indexed';
      }
      const source = (meta.source as KnowledgeFileSource) || 'upload';
      files.push(buildEntry(name, source, meta.agentIds, scope, meta.status, meta));
    }

    files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json({ files });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});
}
