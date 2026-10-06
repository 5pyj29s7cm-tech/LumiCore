import type { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { requireAdmin as requireUnifiedAdmin, requireLocalRequest as requireUnifiedLocalRequest } from "../../middleware/auth";
import { requireAuth, assertLocalHostRequest, getUserId, getFileScope, sendRouteError, assertKnowledgeWriteAccess } from './ownership';
import { readObsidianVaults, scanObsidianVault, upsertObsidianVault, writeObsidianVaults, syncObsidianVault } from './obsidian';
import { OBSIDIAN_DEFAULT_MAX_FILES } from './formats';

export function registerObsidianRoutes(router: Router): void {


// ── Obsidian vault connection and sync ──
router.get('/files/obsidian/status', requireAuth, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    const db = readKnowledgeFileState();
    const vaults = readObsidianVaults(db, userId, scope).map(vault => {
      const exists = fs.existsSync(vault.path);
      const isDirectory = exists && fs.statSync(vault.path).isDirectory();
      const isObsidianVault = isDirectory && fs.existsSync(path.join(vault.path, '.obsidian'));
      let noteCount = vault.lastNoteCount || 0;
      if (isDirectory && req.query.scan === '1') {
        try {
          noteCount = scanObsidianVault(vault.path, Number(req.query.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES).notes.length;
        } catch {}
      }
      return {
        ...vault,
        exists,
        isDirectory,
        isObsidianVault,
        noteCount,
      };
    });
    res.json({ success: true, vaults });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});


router.post('/files/obsidian/connect', requireAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const { vaultPath, name } = req.body || {};
    if (!vaultPath) return res.status(400).json({ error: 'vaultPath is required' });
    const db = readKnowledgeFileState();
    const vault = upsertObsidianVault(db, userId, scope, { vaultPath, name });
    const scan = scanObsidianVault(vault.path, Number(req.body?.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES);
    vault.lastScanAt = new Date().toISOString();
    vault.lastNoteCount = scan.notes.length;
    writeObsidianVaults(db, userId, scope, readObsidianVaults(db, userId, scope).map(v => v.id === vault.id ? vault : v));
    commitKnowledgeFileState(db);
    res.json({
      success: true,
      vault,
      noteCount: scan.notes.length,
      skipped: scan.skipped,
      truncated: scan.truncated,
      warning: vault.isObsidianVault ? undefined : 'This folder has no .obsidian directory; Lumi will treat it as a Markdown notes folder.',
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


router.post('/files/obsidian/sync', requireAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readKnowledgeFileState();
    const vaultId = String(req.body?.vaultId || req.query.vaultId || '').trim();
    const vaults = readObsidianVaults(db, userId, scope);
    const targets = vaultId
      ? vaults.filter(v => v.id === vaultId)
      : vaults.filter(v => v.enabled !== false);
    if (targets.length === 0) {
      return res.status(404).json({ error: vaultId ? 'Obsidian vault not found' : 'No enabled Obsidian vault is connected' });
    }

    const results = [];
    const updatedVaults = [...vaults];
    for (const vault of targets) {
      const sync = await syncObsidianVault(vault, userId, scope, db, {
        maxFiles: Number(req.body?.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES,
      });
      const idx = updatedVaults.findIndex(v => v.id === vault.id);
      if (idx >= 0) updatedVaults[idx] = sync.vault;
      results.push(sync);
    }
    writeObsidianVaults(db, userId, scope, updatedVaults);
    commitKnowledgeFileState(db);

    res.json({
      success: true,
      results,
      synced: results.reduce((sum, item) => sum + item.synced, 0),
      skipped: results.reduce((sum, item) => sum + item.skipped, 0),
      failed: results.reduce((sum, item) => sum + item.failed, 0),
      files: results.flatMap(item => item.files),
      errors: results.flatMap(item => item.errors),
    });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});


router.delete('/files/obsidian/:id', requireAuth, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readKnowledgeFileState();
    const vaults = readObsidianVaults(db, userId, scope);
    const next = vaults.filter(v => v.id !== req.params.id);
    if (next.length === vaults.length) return res.status(404).json({ error: 'Obsidian vault not found' });
    writeObsidianVaults(db, userId, scope, next);
    commitKnowledgeFileState(db);
    res.json({ success: true });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});
}
