import type { Request } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import { isPathInsideRoot } from '../../../shared/file_identity';
import { readKnowledgeFileState } from "../knowledge_state";
import { getDataPath, getGeneratedOutputDir } from "../../config/data_path";
import { collectChatArtifacts, artifactContentSnapshot, publicArtifactSnapshotDelivery } from "../../conversation/chat_artifacts";
import { sameArtifactPath } from "../../tools/artifact_evidence";
import { GENERATED_FILE_EXTS } from './formats';
import { getFileScope } from './ownership';
import type { FileScope } from './contracts';

export const PERSONAL_KNOWLEDGE_DIR = getDataPath('knowledge');

fs.mkdirSync(PERSONAL_KNOWLEDGE_DIR, { recursive: true });

export const isInsideRoot = isPathInsideRoot;

export function resolveGeneratedDownloadPath(value: unknown, req?: Request): string {
  const rawInput = String(value || '').trim();
  const normalizedRawInput = rawInput.replace(/\\/g, '/');
  const raw = normalizedRawInput.startsWith('/lumi_output/')
    ? path.join(getGeneratedOutputDir(), normalizedRawInput.slice('/lumi_output/'.length))
    : rawInput;
  if (!raw) {
    const err: any = new Error('path is required');
    err.status = 400;
    throw err;
  }
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!GENERATED_FILE_EXTS.test(resolved)) {
    const err: any = new Error('Unsupported generated file type');
    err.status = 400;
    throw err;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const err: any = new Error('Generated file not found');
    err.status = 404;
    throw err;
  }
  const generatedRoot = fs.realpathSync.native(getGeneratedOutputDir());
  const realPath = fs.realpathSync.native(resolved);
  const disclosure = publicArtifactSnapshotDelivery(artifactContentSnapshot(realPath), realPath,
    { ...(req?.user?.orgId ? { domain: 'work', orgId: req.user.orgId } : { userId: req?.user?.uid, domain: 'personal' }),
      conversationId: String(req?.query.conversationId || '') || undefined });
  if (disclosure.deliveryBlocked) throw Object.assign(new Error('This generated file is not available for public delivery.'), { status: 403 });
  // Scope conversation links to actual server-owned output receipts, including
  // files saved outside the shared output directory. Prose grants no access.
  const conversationId = String(req?.query.conversationId || '').trim();
  // Reject redirected parents for any receipt-backed output.
  let redirected = false;
  for (let entry = resolved; path.dirname(entry) !== entry; entry = path.dirname(entry)) {
    if (fs.lstatSync(entry).isSymbolicLink()) { redirected = true; break; }
  }
  if (conversationId) {
    const db = readKnowledgeFileState();
    const conv = (db.conversations || []).find((item: any) => item.id === conversationId && item.userId === req?.user?.uid);
    const membershipMatches = conv && (!conv.orgId || conv.orgId === req?.user?.orgId);
    const ownedOutput = membershipMatches && (db.interactions || []).some((item: any) =>
      item.conversationId === conversationId && item.userId === req?.user?.uid
      && (item.role === 'assistant' || Boolean(item.response))
      && collectChatArtifacts(item.toolCalls, conversationId).some(artifact => sameArtifactPath(artifact.path, resolved)));
    if (!ownedOutput || redirected) {
      throw Object.assign(new Error('File is not a verified output of this conversation'), { status: 403 });
    }
    return realPath;
  }
  if (!isInsideRoot(realPath, generatedRoot)) {
    const err: any = new Error('Generated file path is outside the generated-output directory');
    err.status = 403;
    throw err;
  }
  return realPath;
}

export function resolveKnowledgeFilePath(req: Request | FileScope, idValue: unknown): string {
  const scope = 'dir' in req ? req : getFileScope(req);
  const safeName = path.basename(String(idValue || '').trim());
  if (!safeName) {
    const err: any = new Error('id is required');
    err.status = 400;
    throw err;
  }

  const filePath = path.resolve(path.join(scope.dir, safeName));
  const scopeDir = path.resolve(scope.dir);
  if (!isInsideRoot(filePath, scopeDir)) {
    const err: any = new Error('File path is outside allowed directories');
    err.status = 403;
    throw err;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const err: any = new Error('File not found');
    err.status = 404;
    throw err;
  }
  const realPath = fs.realpathSync.native(filePath);
  if (!isInsideRoot(realPath, fs.realpathSync.native(scopeDir))) {
    throw Object.assign(new Error('File path is outside allowed directories'), { status: 403 });
  }
  return realPath;
}

export function openPathWithDefaultApp(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
    const args = process.platform === 'win32'
      ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from('$ErrorActionPreference = "Stop"; $target = $env:LUMI_OPEN_TARGET; if (-not (Test-Path -LiteralPath $target)) { throw "Path not found: $target" }; Start-Process -FilePath $target', 'utf16le').toString('base64'),
      ]
      : [filePath];
    const proc = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LUMI_OPEN_TARGET: filePath },
    });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Open command timed out'));
    }, 8000);
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error((stderr || `Open command failed with exit code ${code}`).trim()));
      }
    });
  });
}

export function resolveLocalImportPath(value: unknown): string {
  let raw = String(value || '').trim();
  if (!raw) {
    const err: any = new Error('File path is required');
    err.status = 400;
    throw err;
  }
  if (/^file:\/\//i.test(raw)) {
    raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, ''));
  }
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    const err: any = new Error('File not found');
    err.status = 404;
    throw err;
  }
  return fs.realpathSync.native(resolved);
}
